/**
 * Deterministic in-memory broker simulator (ARCHITECTURE.md §11.1). Holds order
 * and position snapshots and notifies subscribers — lets the trade layer be
 * tested and demoed with zero network. Phase 9 extends it with the place/modify/
 * cancel state machine; Phase 8 uses it read-only (seed snapshots + emit LTP).
 */
import type { Order, Position } from './types';

export class FakeBroker {
  private _orders: Order[] = [];
  private _positions: Position[] = [];
  private readonly _bookListeners: Array<(o: Order[], p: Position[]) => void> = [];
  private readonly _ltpListeners: Array<(symbol: string, ltp: number) => void> = [];

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

  public orders(): readonly Order[] { return this._orders; }
  public positions(): readonly Position[] { return this._positions; }
}
