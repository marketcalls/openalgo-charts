/**
 * Trading visualization API (ARCHITECTURE.md §9). A data-driven layer on top of
 * the chart: your app pushes exchange state (positions, orders, trades) and the
 * chart renders labelled price-line "pills" with a cancel/close button and
 * drag-to-modify; user interaction is relayed back as `trading:*` events for the
 * app to send to the exchange. Original, framework-free API.
 *
 * This T1 layer covers positions + orders (as pills) and their close / cancel /
 * modify events. Brackets, trade-fill markers, and settings build on it.
 */
import type { IPrimitive } from '../primitives/primitive';
import { PriceLine, type PriceLineOptions } from '../primitives/price-line';

export type PositionSide = 'long' | 'short';
export type TradingOrderSide = 'buy' | 'sell';
export type TradingOrderType = 'limit' | 'stop' | 'stop_limit';
export type TradeMarkerVariant = 'chevron' | 'bubble' | 'count';
export type TradingLineVariant = 'standard' | 'line-only';
export type TradingLineStyle = 'solid' | 'dashed' | 'dotted';

export interface TradingPosition {
  id: string;
  side: PositionSide;
  entryPrice: number;
  size: number;
  pnlText?: string;
  pnlPercent?: string;
  color?: string;
  readOnly?: boolean;
  variant?: TradingLineVariant;
}

export interface TradingOrder {
  id: string;
  type: TradingOrderType;
  side: TradingOrderSide;
  price: number;
  size: number;
  parentId?: string;
  bracketRole?: 'tp' | 'sl';
  color?: string;
  lineStyle?: TradingLineStyle;
  lineWidth?: number;
  readOnly?: boolean;
  draggable?: boolean;
  variant?: TradingLineVariant;
}

export interface TradingTrade {
  id: string;
  side: TradingOrderSide;
  price: number;
  size: number;
  /** Execution time in milliseconds. */
  timestamp: number;
  variant?: TradeMarkerVariant;
  color?: string;
  label?: string;
}

export interface TradingSyncPayload {
  positions?: TradingPosition[];
  orders?: TradingOrder[];
  trades?: TradingTrade[];
}

/** What the controller needs from the chart (the Chart implements this). */
export interface TradingHost {
  addPrimitive(p: IPrimitive): void;
  removePrimitive(p: IPrimitive): void;
  subscribeClick(cb: (externalId: string) => void): void;
  subscribeDrag(onDrag: (externalId: string, price: number) => void, onDragEnd?: (externalId: string, price: number) => void): void;
}

export const DEFAULT_TRADING_COLORS = {
  long: '#2f6df6',
  short: '#ef5350',
  order: '#3b82f6',
  tp: '#26a69a',
  sl: '#ef5350',
};

interface Tracked<E> { entity: E; line: PriceLine; sig: string; }

const CLOSE_SUFFIX = '::close';

export class TradingController {
  private readonly _host: TradingHost;
  private readonly _positions = new Map<string, Tracked<TradingPosition>>();
  private readonly _orders = new Map<string, Tracked<TradingOrder>>();
  private readonly _trades = new Map<string, TradingTrade>();
  private readonly _listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly _dragPrev = new Map<string, number>();

  public constructor(host: TradingHost) {
    this._host = host;
    host.subscribeClick((externalId) => this._onClick(externalId));
    host.subscribeDrag(
      (externalId, price) => this._onDrag(externalId, price),
      (externalId, price) => this._onDragEnd(externalId, price),
    );
  }

  // ── events ────────────────────────────────────────────────────────────────
  public on(event: string, cb: (payload: unknown) => void): () => void {
    let set = this._listeners.get(event);
    if (set === undefined) { set = new Set(); this._listeners.set(event, set); }
    set.add(cb);
    return () => { this._listeners.get(event)?.delete(cb); };
  }

  public off(event: string, cb: (payload: unknown) => void): void {
    this._listeners.get(event)?.delete(cb);
  }

  private _emit(event: string, payload: unknown): void {
    const set = this._listeners.get(event);
    if (set !== undefined) for (const cb of set) cb(payload);
  }

  // ── data ──────────────────────────────────────────────────────────────────
  public setPositions(positions: readonly TradingPosition[]): void {
    this._sync(this._positions, positions, 'pos');
  }

  public setOrders(orders: readonly TradingOrder[]): void {
    this._sync(this._orders, orders, 'ord');
  }

  public setTrades(trades: readonly TradingTrade[]): void {
    this._trades.clear();
    for (const t of trades) this._trades.set(t.id, t);
  }

  public addTrade(trade: TradingTrade): void {
    this._trades.set(trade.id, trade);
  }

  public upsertOrder(order: TradingOrder): void {
    const next = this.getOrders().filter((o) => o.id !== order.id);
    next.push(order);
    this.setOrders(next);
  }

  public removeOrder(id: string): void {
    // remove the order and any bracket children pointing at it
    const next = this.getOrders().filter((o) => o.id !== id && o.parentId !== id);
    this.setOrders(next);
  }

  public syncState(payload: TradingSyncPayload): void {
    if (payload.positions !== undefined) this.setPositions(payload.positions);
    if (payload.orders !== undefined) this.setOrders(payload.orders);
    if (payload.trades !== undefined) this.setTrades(payload.trades);
  }

  public updatePositionPnl(id: string, unrealizedPnl: number, pnlText?: string, pnlPercent?: string): void {
    const cur = this._positions.get(id);
    if (cur === undefined) return;
    if (pnlText !== undefined) cur.entity.pnlText = pnlText;
    if (pnlPercent !== undefined) cur.entity.pnlPercent = pnlPercent;
    void unrealizedPnl;
    cur.line.setLeftLabel(this._positionPill(cur.entity));
  }

  public getPositions(): TradingPosition[] { return [...this._positions.values()].map((t) => t.entity); }
  public getOrders(): TradingOrder[] { return [...this._orders.values()].map((t) => t.entity); }
  public getTrades(): TradingTrade[] { return [...this._trades.values()]; }

  public clear(): void {
    for (const t of this._positions.values()) this._host.removePrimitive(t.line);
    for (const t of this._orders.values()) this._host.removePrimitive(t.line);
    this._positions.clear();
    this._orders.clear();
    this._trades.clear();
  }

  // ── rendering ───────────────────────────────────────────────────────────────
  private _sync<E extends { id: string }>(map: Map<string, Tracked<E>>, list: readonly E[], kind: 'pos' | 'ord'): void {
    const seen = new Set<string>();
    for (const entity of list) {
      seen.add(entity.id);
      const opts = kind === 'pos'
        ? this._positionOpts(entity as unknown as TradingPosition)
        : this._orderOpts(entity as unknown as TradingOrder);
      const sig = this._sig(opts);
      const cur = map.get(entity.id);
      if (cur !== undefined && cur.sig === sig) {
        cur.entity = entity;
        cur.line.setPrice(opts.price);
        if (opts.leftLabel !== undefined) cur.line.setLeftLabel(opts.leftLabel);
      } else {
        if (cur !== undefined) this._host.removePrimitive(cur.line);
        const line = new PriceLine(opts);
        this._host.addPrimitive(line);
        map.set(entity.id, { entity, line, sig });
      }
    }
    for (const [id, cur] of map) {
      if (!seen.has(id)) { this._host.removePrimitive(cur.line); map.delete(id); }
    }
  }

  private _sig(o: PriceLineOptions): string {
    return `${o.color}|${o.dashed}|${o.closeButton === true}|${o.cursor ?? ''}|${o.leftLabel !== undefined}`;
  }

  private _positionPill(p: TradingPosition): string {
    return `${p.side.toUpperCase()} ${p.size}${p.pnlText !== undefined ? '  ' + p.pnlText : ''}`;
  }

  private _orderPill(o: TradingOrder): string {
    return `${o.side.toUpperCase()} ${o.size} ${o.type.replace('_', ' ').toUpperCase()}`;
  }

  private _positionOpts(p: TradingPosition): PriceLineOptions {
    const lineOnly = p.variant === 'line-only';
    return {
      price: p.entryPrice,
      color: p.color ?? (p.side === 'long' ? DEFAULT_TRADING_COLORS.long : DEFAULT_TRADING_COLORS.short),
      lineWidth: 2,
      dashed: false,
      id: `pos:${p.id}`,
      leftLabel: lineOnly ? undefined : this._positionPill(p),
      closeButton: !lineOnly && p.readOnly !== true,
      extentFromRight: 0.3,
    };
  }

  private _orderOpts(o: TradingOrder): PriceLineOptions {
    const lineOnly = o.variant === 'line-only';
    const draggable = !lineOnly && (o.draggable ?? o.readOnly !== true);
    const color = o.color ?? (o.bracketRole === 'tp' ? DEFAULT_TRADING_COLORS.tp
      : o.bracketRole === 'sl' ? DEFAULT_TRADING_COLORS.sl
        : DEFAULT_TRADING_COLORS.order);
    return {
      price: o.price,
      color,
      lineWidth: o.lineWidth ?? 1,
      dashed: (o.lineStyle ?? 'solid') !== 'solid',
      id: `ord:${o.id}`,
      leftLabel: lineOnly ? undefined : this._orderPill(o),
      closeButton: !lineOnly && o.readOnly !== true,
      extentFromRight: 0.3,
      cursor: draggable ? 'ns-resize' : undefined,
    };
  }

  // ── interaction ─────────────────────────────────────────────────────────────
  private _onClick(externalId: string): void {
    if (!externalId.endsWith(CLOSE_SUFFIX)) return;
    const base = externalId.slice(0, -CLOSE_SUFFIX.length);
    if (base.startsWith('ord:')) {
      const id = base.slice(4);
      if (this._orders.has(id)) this._emit('trading:order_cancel', { orderId: id });
    } else if (base.startsWith('pos:')) {
      const id = base.slice(4);
      if (this._positions.has(id)) this._emit('trading:position_close', { positionId: id });
    }
  }

  private _onDrag(externalId: string, price: number): void {
    if (!externalId.startsWith('ord:')) return;
    const id = externalId.slice(4);
    const cur = this._orders.get(id);
    if (cur === undefined) return;
    if (!this._dragPrev.has(id)) this._dragPrev.set(id, cur.entity.price);
    cur.line.setPrice(price);
  }

  private _onDragEnd(externalId: string, price: number): void {
    if (!externalId.startsWith('ord:')) return;
    const id = externalId.slice(4);
    const cur = this._orders.get(id);
    if (cur === undefined) return;
    const previousPrice = this._dragPrev.get(id) ?? cur.entity.price;
    this._dragPrev.delete(id);
    cur.entity.price = price;
    cur.line.setPrice(price);
    this._emit('trading:order_modify', { orderId: id, newPrice: price, previousPrice });
  }
}
