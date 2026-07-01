/**
 * Trading visualization API (ARCHITECTURE.md §9). A data-driven layer on top of
 * the chart: your app pushes exchange state (positions, orders, trades) and the
 * chart renders labelled price-line "pills" (with a cancel/close button and
 * drag-to-modify) plus trade-fill markers; user interaction is relayed back as
 * `trading:*` events for the app to send to the exchange. Original,
 * framework-free API.
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, ZOrder } from '../primitives/primitive';
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

export interface TradingColors {
  long: string;
  short: string;
  order: string;
  tp: string;
  sl: string;
  buy: string;
  sell: string;
}

export interface TradingSettings {
  longColor?: string;
  shortColor?: string;
  orderColor?: string;
  tpColor?: string;
  slColor?: string;
  buyColor?: string;
  sellColor?: string;
}

/** What the controller needs from the chart (the Chart implements this). */
export interface TradingHost {
  addPrimitive(p: IPrimitive): void;
  removePrimitive(p: IPrimitive): void;
  subscribeClick(cb: (externalId: string) => void): void;
  subscribeDrag(onDrag: (externalId: string, price: number) => void, onDragEnd?: (externalId: string, price: number) => void): void;
}

export const DEFAULT_TRADING_COLORS: TradingColors = {
  long: '#2f6df6',
  short: '#ef5350',
  order: '#3b82f6',
  tp: '#26a69a',
  sl: '#ef5350',
  buy: '#26a69a',
  sell: '#ef5350',
};

const CLOSE_SUFFIX = '::close';

/** Nearest bar index to a UTC-seconds time (binary search over the sorted times). */
function snapToIndex(dl: { length: number; indexToTime(i: number): number | undefined }, timeSec: number): number | undefined {
  const n = dl.length;
  if (n === 0) return undefined;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const tm = dl.indexToTime(mid);
    if (tm !== undefined && tm <= timeSec) lo = mid; else hi = mid - 1;
  }
  const t0 = dl.indexToTime(lo);
  if (t0 === undefined) return undefined;
  if (lo + 1 < n) {
    const t1 = dl.indexToTime(lo + 1);
    if (t1 !== undefined && Math.abs(t1 - timeSec) < Math.abs(t0 - timeSec)) return lo + 1;
  }
  return lo;
}

function drawChevron(ctx: CanvasRenderingContext2D, x: number, y: number, side: TradingOrderSide, color: string, dpr: number): void {
  const s = 5 * dpr;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (side === 'buy') { ctx.moveTo(x, y - s * 1.5); ctx.lineTo(x - s, y); ctx.lineTo(x + s, y); }
  else { ctx.moveTo(x, y + s * 1.5); ctx.lineTo(x - s, y); ctx.lineTo(x + s, y); }
  ctx.closePath();
  ctx.fill();
}

function drawBubble(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, text: string, dpr: number): void {
  const r = 9 * dpr;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  if (text !== '') {
    ctx.fillStyle = '#fff';
    ctx.font = `${9 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5 * dpr);
  }
}

function drawCount(ctx: CanvasRenderingContext2D, x: number, y: number, count: number, color: string, dpr: number): void {
  const text = String(count);
  ctx.font = `${9 * dpr}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 10 * dpr;
  const h = 15 * dpr;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x - w / 2), Math.round(y - h / 2), Math.round(w), Math.round(h));
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5 * dpr);
}

/** Self-contained trade-fill markers (chevron / bubble / count) over the plot. */
export class TradeMarkersPrimitive implements IPrimitive {
  private _trades: TradingTrade[] = [];
  private _colors: TradingColors;
  private _host: PrimitiveHost | null = null;

  public constructor(colors: TradingColors) { this._colors = colors; }
  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'top'; }
  public autoscaleInfo(): null { return null; }

  public setTrades(trades: TradingTrade[]): void { this._trades = trades; this._host?.requestUpdate(); }
  public setColors(colors: TradingColors): void { this._colors = colors; this._host?.requestUpdate(); }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    if (this._trades.length === 0) return;
    const dpr = rc.dpr;
    const groups = new Map<string, { index: number; sumPS: number; sumS: number; n: number; color: string }>();
    ctx.save();
    for (const t of this._trades) {
      const idx = snapToIndex(rc.dataLayer, Math.floor(t.timestamp / 1000));
      if (idx === undefined) continue;
      const x = Math.round(rc.timeScale.indexToX(idx) * dpr);
      const color = t.color ?? (t.side === 'buy' ? this._colors.buy : this._colors.sell);
      const variant = t.variant ?? 'chevron';
      if (variant === 'count') {
        const key = `${idx}:${t.side}`;
        let g = groups.get(key);
        if (g === undefined) { g = { index: idx, sumPS: 0, sumS: 0, n: 0, color }; groups.set(key, g); }
        g.sumPS += t.price * t.size; g.sumS += t.size; g.n += 1;
        continue;
      }
      const y = Math.round(rc.priceScale.priceToY(t.price) * dpr);
      if (variant === 'bubble') drawBubble(ctx, x, y, color, t.label ?? (t.side === 'buy' ? 'B' : 'S'), dpr);
      else drawChevron(ctx, x, y, t.side, color, dpr);
    }
    for (const g of groups.values()) {
      const vwap = g.sumS > 0 ? g.sumPS / g.sumS : 0;
      const x = Math.round(rc.timeScale.indexToX(g.index) * dpr);
      const y = Math.round(rc.priceScale.priceToY(vwap) * dpr);
      drawCount(ctx, x, y, g.n, g.color, dpr);
    }
    ctx.restore();
  }
}

interface Tracked<E> { entity: E; line: PriceLine; sig: string; }

export class TradingController {
  private readonly _host: TradingHost;
  private readonly _positions = new Map<string, Tracked<TradingPosition>>();
  private readonly _orders = new Map<string, Tracked<TradingOrder>>();
  private readonly _trades = new Map<string, TradingTrade>();
  private readonly _listeners = new Map<string, Set<(payload: unknown) => void>>();
  private readonly _dragPrev = new Map<string, number>();
  private _colors: TradingColors = { ...DEFAULT_TRADING_COLORS };
  private _markers: TradeMarkersPrimitive | null = null;

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

  // ── settings ────────────────────────────────────────────────────────────────
  public setSettings(settings: TradingSettings): void {
    if (settings.longColor !== undefined) this._colors.long = settings.longColor;
    if (settings.shortColor !== undefined) this._colors.short = settings.shortColor;
    if (settings.orderColor !== undefined) this._colors.order = settings.orderColor;
    if (settings.tpColor !== undefined) this._colors.tp = settings.tpColor;
    if (settings.slColor !== undefined) this._colors.sl = settings.slColor;
    if (settings.buyColor !== undefined) this._colors.buy = settings.buyColor;
    if (settings.sellColor !== undefined) this._colors.sell = settings.sellColor;
    // re-render existing entities with the new colors
    this.setPositions(this.getPositions());
    this.setOrders(this.getOrders());
    this._markers?.setColors(this._colors);
  }

  public getSettings(): TradingColors { return { ...this._colors }; }

  // ── data ──────────────────────────────────────────────────────────────────
  public setPositions(positions: readonly TradingPosition[]): void { this._sync(this._positions, positions, 'pos'); }
  public setOrders(orders: readonly TradingOrder[]): void { this._sync(this._orders, orders, 'ord'); }

  public setTrades(trades: readonly TradingTrade[]): void {
    this._trades.clear();
    for (const t of trades) this._trades.set(t.id, t);
    this._renderTrades();
  }

  public addTrade(trade: TradingTrade): void {
    this._trades.set(trade.id, trade);
    this._renderTrades();
  }

  public upsertOrder(order: TradingOrder): void {
    const next = this.getOrders().filter((o) => o.id !== order.id);
    next.push(order);
    this.setOrders(next);
  }

  public removeOrder(id: string): void {
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
    if (this._markers !== null) { this._host.removePrimitive(this._markers); this._markers = null; }
  }

  // ── rendering ───────────────────────────────────────────────────────────────
  private _renderTrades(): void {
    if (this._markers === null) {
      this._markers = new TradeMarkersPrimitive(this._colors);
      this._host.addPrimitive(this._markers);
    }
    this._markers.setTrades(this.getTrades());
  }

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
    if (o.bracketRole !== undefined) return `${o.bracketRole.toUpperCase()} ${o.size}`;
    return `${o.side.toUpperCase()} ${o.size} ${o.type.replace('_', ' ').toUpperCase()}`;
  }

  private _positionOpts(p: TradingPosition): PriceLineOptions {
    const lineOnly = p.variant === 'line-only';
    return {
      price: p.entryPrice,
      color: p.color ?? (p.side === 'long' ? this._colors.long : this._colors.short),
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
    const color = o.color ?? (o.bracketRole === 'tp' ? this._colors.tp
      : o.bracketRole === 'sl' ? this._colors.sl
        : this._colors.order);
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
    if (externalId.endsWith(CLOSE_SUFFIX)) {
      const base = externalId.slice(0, -CLOSE_SUFFIX.length);
      if (base.startsWith('ord:')) {
        const id = base.slice(4);
        if (this._orders.has(id)) this._emit('trading:order_cancel', { orderId: id });
      } else if (base.startsWith('pos:')) {
        const id = base.slice(4);
        if (this._positions.has(id)) this._emit('trading:position_close', { positionId: id });
      }
      return;
    }
    // pill-body click
    if (externalId.startsWith('ord:')) {
      const cur = this._orders.get(externalId.slice(4));
      if (cur !== undefined) this._emit('trading:order_click', { order: cur.entity });
    } else if (externalId.startsWith('pos:')) {
      const cur = this._positions.get(externalId.slice(4));
      if (cur !== undefined) this._emit('trading:position_click', { position: cur.entity });
    }
  }

  private _onDrag(externalId: string, price: number): void {
    if (!externalId.startsWith('ord:')) return;
    const cur = this._orders.get(externalId.slice(4));
    if (cur === undefined) return;
    const id = externalId.slice(4);
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
    if (cur.entity.bracketRole !== undefined) {
      this._emit('trading:bracket_modify', { parentId: cur.entity.parentId, bracketRole: cur.entity.bracketRole, newPrice: price });
    } else {
      this._emit('trading:order_modify', { orderId: id, newPrice: price, previousPrice });
    }
  }
}
