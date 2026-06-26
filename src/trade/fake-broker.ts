/**
 * Deterministic in-memory broker simulator (ARCHITECTURE.md §11.1). Holds order
 * and position snapshots and notifies subscribers — lets the trade layer be
 * tested and demoed with zero network. Phase 9 extends it with the place/modify/
 * cancel state machine; Phase 8 uses it read-only (seed snapshots + emit LTP).
 */
import type { Order, Position } from './types';
import type { MarketDepth } from '../feed/types';
import type { OrderFeed, PlaceRequest, TradeMode } from './order-engine';

export class FakeBroker implements OrderFeed {
  private _orders: Order[] = [];
  private _positions: Position[] = [];
  private readonly _bookListeners: Array<(o: Order[], p: Position[]) => void> = [];
  private readonly _ltpListeners: Array<(symbol: string, ltp: number) => void> = [];
  private readonly _depthListeners: Array<(symbol: string, depth: MarketDepth) => void> = [];
  private _idCounter = 0;
  /** Set to a reason to make the next place() reject (test hook). */
  public rejectNextPlace: string | null = null;

  public onBook(cb: (orders: Order[], positions: Position[]) => void): void {
    this._bookListeners.push(cb);
  }

  public onLtp(cb: (symbol: string, ltp: number) => void): void {
    this._ltpListeners.push(cb);
  }

  /** Replace the current book snapshot and notify (simulates a poll / WS update / reconnect). */
  public setBook(orders: Order[], positions: Position[]): void {
    this._orders = orders.map((o) => ({ ...o }));
    this._positions = positions.map((p) => ({ ...p }));
    for (const cb of this._bookListeners) cb(this._orders, this._positions);
  }

  public emitLtp(symbol: string, ltp: number): void {
    for (const cb of this._ltpListeners) cb(symbol, ltp);
  }

  public onDepth(cb: (symbol: string, depth: MarketDepth) => void): void {
    this._depthListeners.push(cb);
  }

  public emitDepth(symbol: string, depth: MarketDepth): void {
    for (const cb of this._depthListeners) cb(symbol, depth);
  }

  /** Build a deterministic N-level synthetic book around `ltp` (demo/test helper). */
  public static makeDepth(ltp: number, levels: number, tickSize = 0.05): MarketDepth {
    const bids = [];
    const asks = [];
    for (let i = 1; i <= levels; i++) {
      bids.push({ price: ltp - i * tickSize, qty: 100 + ((i * 37) % 900) });
      asks.push({ price: ltp + i * tickSize, qty: 100 + ((i * 53) % 900) });
    }
    return { bids, asks, ltp };
  }

  public orders(): readonly Order[] { return this._orders; }
  public positions(): readonly Position[] { return this._positions; }

  // ── OrderFeed (write path simulation) ──────────────────────────────────

  public async place(req: PlaceRequest & { mode: TradeMode }): Promise<{ orderId: string }> {
    if (this.rejectNextPlace !== null) {
      const reason = this.rejectNextPlace;
      this.rejectNextPlace = null;
      throw new Error(reason);
    }
    const orderId = `B${++this._idCounter}`;
    this._orders.push({
      id: orderId,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      qty: req.qty,
      filledQty: 0,
      price: req.price ?? 0,
      triggerPrice: req.triggerPrice,
      status: req.type === 'MARKET' ? 'filled' : 'working',
      role: undefined,
    });
    this._notify();
    return { orderId };
  }

  public async modify(orderId: string, patch: { price?: number; triggerPrice?: number; qty?: number }): Promise<void> {
    const o = this._orders.find((x) => x.id === orderId);
    if (o === undefined) throw new Error('unknown order');
    if (patch.price !== undefined) o.price = patch.price;
    if (patch.triggerPrice !== undefined) o.triggerPrice = patch.triggerPrice;
    if (patch.qty !== undefined) o.qty = patch.qty;
    this._notify();
  }

  public async cancel(orderId: string): Promise<void> {
    this._orders = this._orders.filter((x) => x.id !== orderId);
    this._notify();
  }

  /** Simulate a fill for an order (test hook). */
  public fill(orderId: string): void {
    const o = this._orders.find((x) => x.id === orderId);
    if (o === undefined) return;
    o.filledQty = o.qty;
    o.status = 'filled';
    this._orders = this._orders.filter((x) => x.id !== orderId);
    this._notify();
  }

  private _notify(): void {
    for (const cb of this._bookListeners) cb(this._orders, this._positions);
  }
}
