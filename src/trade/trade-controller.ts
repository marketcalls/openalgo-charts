/**
 * Trade controller (ARCHITECTURE.md §9.3) — read-only in Phase 8. The single
 * source of truth: it reconciles order/position book snapshots into on-chart
 * primitives (add/update/remove) and pushes LTP into them for live P&L. On a
 * reconnect, a fresh snapshot is diffed against current primitives, so vanished
 * orders are removed (STALE handling) with no special code path.
 */
import type { IPrimitive } from '../primitives/primitive';
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

export class TradeController {
  private readonly _host: TradeHost;
  private readonly _orderLines = new Map<string, WorkingOrderLine>();
  private readonly _markers = new Map<string, PositionMarker>();
  private readonly _brackets = new Map<string, BracketGroup>();
  private readonly _ltp = new Map<string, number>();

  public constructor(host: TradeHost) {
    this._host = host;
  }

  /** Reconcile a full book snapshot. Idempotent — safe to call on every update or reconnect. */
  public reconcile(orders: readonly Order[], positions: readonly Position[]): void {
    this._reconcileOrderLines(orders);
    this._reconcilePositions(positions);
    this._reconcileBrackets(orders, positions);
  }

  private _reconcileOrderLines(orders: readonly Order[]): void {
    const seen = new Set<string>();
    for (const o of orders) {
      // SL/TP children are shown via the bracket, not as standalone lines.
      if (!isWorking(o) || o.role === 'sl' || o.role === 'tp') continue;
      seen.add(o.id);
      const existing = this._orderLines.get(o.id);
      if (existing) {
        existing.update(o);
      } else {
        const line = new WorkingOrderLine(o);
        const ltp = this._ltp.get(o.symbol);
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

  private _reconcilePositions(positions: readonly Position[]): void {
    const seen = new Set<string>();
    for (const p of positions) {
      if (p.netQty === 0) continue;
      seen.add(p.symbol);
      const existing = this._markers.get(p.symbol);
      if (existing) {
        existing.update(p);
      } else {
        const marker = new PositionMarker(p);
        const ltp = this._ltp.get(p.symbol);
        if (ltp !== undefined) marker.setLtp(ltp);
        this._markers.set(p.symbol, marker);
        this._host.addPrimitive(marker);
      }
    }
    for (const [symbol, marker] of this._markers) {
      if (!seen.has(symbol)) {
        this._host.removePrimitive(marker);
        this._markers.delete(symbol);
      }
    }
  }

  private _reconcileBrackets(orders: readonly Order[], positions: readonly Position[]): void {
    const sl = new Map<string, number>();
    const tp = new Map<string, number>();
    for (const o of orders) {
      if (!isWorking(o)) continue;
      if (o.role === 'sl') sl.set(o.symbol, o.triggerPrice ?? o.price);
      else if (o.role === 'tp') tp.set(o.symbol, o.price);
    }
    const posBySymbol = new Map(positions.map((p) => [p.symbol, p]));
    const seen = new Set<string>();
    for (const symbol of new Set([...sl.keys(), ...tp.keys()])) {
      const pos = posBySymbol.get(symbol);
      if (pos === undefined || pos.netQty === 0) continue;
      const state: BracketState = {
        symbol,
        side: pos.netQty > 0 ? 'BUY' : 'SELL',
        entry: pos.avgPrice,
        stop: sl.get(symbol) ?? pos.avgPrice,
        target: tp.get(symbol) ?? pos.avgPrice,
      };
      seen.add(symbol);
      const existing = this._brackets.get(symbol);
      if (existing) existing.update(state);
      else {
        const bg = new BracketGroup(state);
        this._brackets.set(symbol, bg);
        this._host.addPrimitive(bg);
      }
    }
    for (const [symbol, bg] of this._brackets) {
      if (!seen.has(symbol)) {
        this._host.removePrimitive(bg);
        this._brackets.delete(symbol);
      }
    }
  }

  /** Push a last price; updates the live P&L / distance on bound primitives. */
  public onLtp(symbol: string, ltp: number): void {
    this._ltp.set(symbol, ltp);
    for (const line of this._orderLines.values()) if (line.order.symbol === symbol) line.setLtp(ltp);
    const marker = this._markers.get(symbol);
    if (marker) marker.setLtp(ltp);
  }

  /** Test/introspection helpers. */
  public orderLineCount(): number { return this._orderLines.size; }
  public positionCount(): number { return this._markers.size; }
  public bracketCount(): number { return this._brackets.size; }
}
