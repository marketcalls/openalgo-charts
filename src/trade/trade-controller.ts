/**
 * Trade controller (ARCHITECTURE.md §9.3), read-only by design: the order
 * engine owns the write path. The single
 * source of truth: it reconciles order/position book snapshots into on-chart
 * primitives (add/update/remove) and pushes LTP into them for live P&L. On a
 * reconnect, a fresh snapshot is diffed against current primitives, so vanished
 * orders are removed (STALE handling) with no special code path.
 */
import type { IPrimitive, InstrumentKey } from 'openalgo-charts';
import type { Order, Position } from './types';
import { isWorking } from './types';
import { WorkingOrderLine } from './order-line';
import { PositionMarker } from './position';
import { BracketGroup, type BracketState } from './bracket';

/** Where the controller attaches/detaches its primitives (the chart implements this). */
export interface TradeHost {
  addPrimitive(p: IPrimitive): void;
  removePrimitive(p: IPrimitive): void;
}

type BookRow = Pick<Position, 'symbol' | 'exchange' | 'product'>;

/**
 * A book holds one row per symbol, exchange and product. Keyed by the symbol
 * alone, the last row won: INFY CNC +100 and INFY MIS -50 drew one marker, -50.
 */
function rowKey(r: BookRow): string {
  return JSON.stringify([r.symbol, r.exchange ?? null, r.product ?? null]);
}

/**
 * Whether a row belongs to the chart's instrument. A row that names no
 * exchange matches on its symbol: the provider did not say, which is the rule
 * the order engine's close lock applies too, and the OpenAlgo adapter refuses
 * to modify such an order rather than guess its venue.
 */
function onInstrument(r: BookRow, instrument: InstrumentKey): boolean {
  return r.symbol === instrument.symbol && (r.exchange === undefined || r.exchange === instrument.exchange);
}

/**
 * What each open row's hit ids name. A symbol drawn with one row keeps the
 * symbol, the form hosts parse; rows that share a symbol carry their key, so a
 * click on a close segment or a bracket line names one exchange and product.
 */
function hitKeys(open: ReadonlyMap<string, Position>): Map<string, string> {
  const rows = new Map<string, number>();
  for (const p of open.values()) rows.set(p.symbol, (rows.get(p.symbol) ?? 0) + 1);
  return new Map([...open].map(([key, p]) => [key, rows.get(p.symbol)! > 1 ? key : p.symbol]));
}

export class TradeController {
  private readonly _host: TradeHost;
  private readonly _orderLines = new Map<string, WorkingOrderLine>();
  private readonly _markers = new Map<string, PositionMarker>();
  private readonly _brackets = new Map<string, BracketGroup>();
  private readonly _ltp = new Map<string, number>();

  public constructor(host: TradeHost) {
    this._host = host;
  }

  /**
   * Reconcile a full book snapshot. Idempotent: safe to call on every update or reconnect.
   *
   * Pass the chart's `instrument` to draw only its rows. A book covers the whole
   * account, and without it every working order is drawn on this chart and
   * joins its autoscale: a futures order at 52000 stretches an equity chart to
   * 52000, and an order on another exchange sits at a plausible price where a
   * drag would modify it. Rows of other instruments drawn before are removed.
   */
  public reconcile(orders: readonly Order[], positions: readonly Position[], instrument?: InstrumentKey): void {
    if (instrument !== undefined) {
      this.reconcile(orders.filter((o) => onInstrument(o, instrument)), positions.filter((p) => onInstrument(p, instrument)));
      return;
    }
    // The rows the markers draw: one per key, the last of a key winning, flat ones dropped.
    const open = new Map<string, Position>();
    for (const p of positions) if (p.netQty !== 0) open.set(rowKey(p), p);
    const keys = hitKeys(open);
    // Brackets are planned before anything is drawn, because the order lines need
    // to know which stops and targets a bracket is going to draw for them. The
    // attach order is unchanged (lines, markers, then brackets) so relative
    // z-order within a band stays what it was.
    const plan = this._planBrackets(orders, open);
    this._reconcileOrderLines(orders, plan.covered);
    this._reconcilePositions(open, keys);
    this._applyBrackets(plan.states, keys);
  }

  private _reconcileOrderLines(orders: readonly Order[], bracketed: ReadonlySet<string>): void {
    const seen = new Set<string>();
    for (const o of orders) {
      // A stop or target is hidden only when a bracket really is drawing it.
      // Everything else gets its own line: a resting stop with no bracket used to
      // draw nothing at all, and a stop a trader cannot see reads as no stop.
      if (!isWorking(o) || bracketed.has(o.id)) continue;
      seen.add(o.id);
      const existing = this._orderLines.get(o.id);
      if (existing) {
        existing.update(o);
      } else {
        const line = new WorkingOrderLine(o);
        const ltp = this._ltpOf(o);
        if (ltp !== undefined) line.setLtp(ltp);
        this._orderLines.set(o.id, line);
        this._host.addPrimitive(line);
      }
    }
    for (const [id, line] of this._orderLines) {
      if (!seen.has(id)) {
        this._host.removePrimitive(line);
        this._orderLines.delete(id);
      }
    }
  }

  private _reconcilePositions(open: ReadonlyMap<string, Position>, keys: ReadonlyMap<string, string>): void {
    for (const [key, p] of open) {
      const hitKey = keys.get(key)!;
      const existing = this._markers.get(key);
      if (existing?.hitKey === hitKey) {
        existing.update(p);
        continue;
      }
      // New, or its ids change because another row of its symbol came or went.
      if (existing !== undefined) this._host.removePrimitive(existing);
      const marker = new PositionMarker(p, { hitKey });
      const ltp = this._ltpOf(p);
      if (ltp !== undefined) marker.setLtp(ltp);
      this._markers.set(key, marker);
      this._host.addPrimitive(marker);
    }
    for (const [key, marker] of this._markers) {
      if (!open.has(key)) {
        this._host.removePrimitive(marker);
        this._markers.delete(key);
      }
    }
  }

  /**
   * Decide which brackets to draw, without touching the host. `covered` names the
   * exact orders those brackets account for; every other working order still
   * needs a line of its own.
   */
  private _planBrackets(
    orders: readonly Order[],
    open: ReadonlyMap<string, Position>,
  ): { states: Map<string, BracketState>; covered: Set<string> } {
    // Keyed like the markers, so a bracket pairs with the position of its own
    // exchange and product, not whichever row of its symbol came last.
    const sl = new Map<string, Order>();
    const tp = new Map<string, Order>();
    for (const o of orders) {
      if (!isWorking(o)) continue;
      if (o.role === 'sl') sl.set(rowKey(o), o);
      else if (o.role === 'tp') tp.set(rowKey(o), o);
    }
    const states = new Map<string, BracketState>();
    const covered = new Set<string>();
    for (const key of new Set([...sl.keys(), ...tp.keys()])) {
      const stop = sl.get(key);
      const target = tp.get(key);
      // BracketGroup always paints both legs, so it may only stand in for a pair
      // that both exist. A one-sided bracket used to fall back to the position
      // average and drew a take-profit at a price where no order rested; the
      // surviving leg now falls through to its own order line instead. (v2's
      // PositionBrackets makes each leg optional. Until BracketGroup can render
      // one leg, "draw only what exists" means drawing no group here.)
      if (stop === undefined || target === undefined) continue;
      const pos = open.get(key);
      if (pos === undefined) continue;
      states.set(key, {
        symbol: pos.symbol,
        exchange: pos.exchange,
        product: pos.product,
        side: pos.netQty > 0 ? 'BUY' : 'SELL',
        entry: pos.avgPrice,
        stop: stop.triggerPrice ?? stop.price,
        target: target.price,
      });
      // Only the two orders the group actually draws. A second stop on the same
      // symbol is not one of them and keeps its own line.
      covered.add(stop.id);
      covered.add(target.id);
    }
    return { states, covered };
  }

  private _applyBrackets(states: ReadonlyMap<string, BracketState>, keys: ReadonlyMap<string, string>): void {
    for (const [key, state] of states) {
      const hitKey = keys.get(key)!;
      const existing = this._brackets.get(key);
      if (existing?.hitKey === hitKey) {
        existing.update(state);
        continue;
      }
      if (existing !== undefined) this._host.removePrimitive(existing);
      const bg = new BracketGroup(state, { hitKey });
      this._brackets.set(key, bg);
      this._host.addPrimitive(bg);
    }
    for (const [key, bg] of this._brackets) {
      if (!states.has(key)) {
        this._host.removePrimitive(bg);
        this._brackets.delete(key);
      }
    }
  }

  /**
   * Push a last price; updates the live P&L / distance on bound primitives.
   * Without `exchange` it reaches every row of the symbol, as it always has.
   * Name it when the book spans exchanges, or an NSE tick moves a BSE row's
   * P&L. A row that names no exchange takes it either way, as `reconcile`
   * matches such a row to an instrument.
   */
  public onLtp(symbol: string, ltp: number, exchange?: string): void {
    const venue = exchange === undefined ? undefined : { symbol, exchange };
    const on = (r: BookRow): boolean => (venue === undefined ? r.symbol === symbol : onInstrument(r, venue));
    this._ltp.set(venue === undefined ? symbol : rowKey(venue), ltp);
    for (const line of this._orderLines.values()) if (on(line.order)) line.setLtp(ltp);
    for (const marker of this._markers.values()) if (on(marker.position)) marker.setLtp(ltp);
  }

  /** The last price pushed for a row's own exchange, else for its symbol. */
  private _ltpOf(r: BookRow): number | undefined {
    const venue = r.exchange === undefined ? undefined : this._ltp.get(rowKey({ symbol: r.symbol, exchange: r.exchange }));
    return venue ?? this._ltp.get(r.symbol);
  }

  /**
   * The position a `position:`, `bracket-sl:` or `bracket-tp:` hit id names,
   * `::close` included, with its exchange and product: the row a close or a
   * stop edit is for. Undefined for any other id, or one nothing drawn
   * carries any more.
   */
  public positionOf(externalId: string): Position | undefined {
    const id = externalId.endsWith('::close') ? externalId.slice(0, -'::close'.length) : externalId;
    for (const [key, marker] of this._markers) {
      const k = marker.hitKey;
      if (id === `position:${k}` || (this._brackets.has(key) && (id === `bracket-sl:${k}` || id === `bracket-tp:${k}`))) {
        return marker.position;
      }
    }
    return undefined;
  }

  /** Test/introspection helpers. */
  public orderLineCount(): number { return this._orderLines.size; }
  public positionCount(): number { return this._markers.size; }
  public bracketCount(): number { return this._brackets.size; }
}
