/**
 * Order engine (ARCHITECTURE.md §9.5) — the chart-trading write path. Drives the
 * order state machine with: client-token idempotency, an arm/confirm gate,
 * pre-trade validation, rate-limited drag-modify, OCO linking, and analyzer
 * (sandbox) mode. Network-agnostic: it talks to an injected OrderFeed (the
 * FakeBroker simulates it in tests/demos).
 */
import { transition, isTerminal, type ClientOrderState } from './order-state-machine';
import { validateOrder, type OrderConstraints, type ValidationResult } from './validation';
import type { OrderSide, OrderType } from './types';

export interface PlaceRequest {
  symbol: string;
  exchange?: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  price?: number;
  triggerPrice?: number;
  /** Product: CNC (delivery), NRML (F&O carry), MIS (intraday). Required by OpenAlgo. */
  product?: 'CNC' | 'NRML' | 'MIS';
  /** Idempotency token; a retry with the same token is never double-sent. */
  clientToken?: string;
}

export interface OrderFeed {
  place(req: PlaceRequest & { mode: TradeMode }): Promise<{ orderId: string }>;
  modify(orderId: string, patch: { price?: number; triggerPrice?: number; qty?: number }): Promise<void>;
  cancel(orderId: string): Promise<void>;
}

export type TradeMode = 'live' | 'analyzer';
export type GateFn = (req: PlaceRequest) => boolean | Promise<boolean>;

export interface OrderEngineOptions {
  feed: OrderFeed;
  constraints: OrderConstraints;
  mode?: TradeMode;
  /** Armed = fire immediately; otherwise the gate must approve each order. */
  armed?: boolean;
  gate?: GateFn;
  minModifyIntervalMs?: number;
  now?: () => number;
  idGen?: () => string;
  /** Called when a drag-modify price fails validation (so the UI can snap back). */
  onValidationError?: (reason: string) => void;
}

export interface PlaceResult {
  ok: boolean;
  clientId?: string;
  state?: ClientOrderState;
  reason?: string;
}

interface Tracked {
  clientId: string;
  state: ClientOrderState;
  brokerId?: string;
  req: PlaceRequest;
  ocoPeer?: string;
}

export class OrderEngine {
  private readonly _feed: OrderFeed;
  private readonly _constraints: OrderConstraints;
  private readonly _mode: TradeMode;
  private readonly _armed: boolean;
  private readonly _gate?: GateFn;
  private readonly _minModifyMs: number;
  private readonly _now: () => number;
  private readonly _idGen: () => string;
  private readonly _onValidationError?: (reason: string) => void;

  private readonly _orders = new Map<string, Tracked>();
  private readonly _byBroker = new Map<string, string>();
  private readonly _sentTokens = new Set<string>();
  private readonly _lastModifyAt = new Map<string, number>();
  private readonly _pendingModify = new Map<string, { price?: number; triggerPrice?: number }>();
  private _counter = 0;

  public constructor(opts: OrderEngineOptions) {
    this._feed = opts.feed;
    this._constraints = opts.constraints;
    this._mode = opts.mode ?? 'live';
    this._armed = opts.armed ?? false;
    this._gate = opts.gate;
    this._minModifyMs = opts.minModifyIntervalMs ?? 150;
    this._now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : 0));
    this._idGen = opts.idGen ?? (() => `c${++this._counter}`);
    this._onValidationError = opts.onValidationError;
  }

  public get mode(): TradeMode { return this._mode; }
  public state(clientId: string): ClientOrderState | undefined { return this._orders.get(clientId)?.state; }

  public async placeOrder(req: PlaceRequest): Promise<PlaceResult> {
    // Validate (price-band only when a price is given — market orders have none).
    let snappedPrice = req.price;
    if (req.price !== undefined) {
      const v: ValidationResult = validateOrder(req.price, req.qty, this._constraints);
      if (!v.ok) return { ok: false, reason: v.reason };
      snappedPrice = v.price;
    } else if (req.qty <= 0) {
      return { ok: false, reason: 'quantity must be positive' };
    }

    const token = req.clientToken ?? this._idGen();
    if (this._sentTokens.has(token)) {
      return { ok: false, reason: 'duplicate clientToken (idempotent skip)', clientId: token, state: this._orders.get(token)?.state };
    }

    if (!this._armed) {
      const approved = await (this._gate ? this._gate(req) : Promise.resolve(false));
      if (!approved) return { ok: false, reason: 'not confirmed' };
    }

    const finalReq: PlaceRequest = { ...req, price: snappedPrice, clientToken: token };
    this._sentTokens.add(token);
    const tracked: Tracked = { clientId: token, state: 'pending_place', req: finalReq };
    this._orders.set(token, tracked);

    try {
      const { orderId } = await this._feed.place({ ...finalReq, mode: this._mode });
      tracked.brokerId = orderId;
      this._byBroker.set(orderId, token);
      tracked.state = transition(tracked.state, 'ack');
      return { ok: true, clientId: token, state: tracked.state };
    } catch (err) {
      tracked.state = transition(tracked.state, 'reject');
      // The broker never accepted it — release the token so the caller can retry
      // the same idempotent request after a transient transport failure.
      this._sentTokens.delete(token);
      return { ok: false, clientId: token, state: tracked.state, reason: String((err as Error).message ?? err) };
    }
  }

  /** One-click market order. */
  public placeMarket(symbol: string, side: OrderSide, qty: number): Promise<PlaceResult> {
    return this.placeOrder({ symbol, side, type: 'MARKET', qty });
  }

  /** Link two orders as OCO: when one fills/cancels, the other is cancelled. */
  public linkOco(clientIdA: string, clientIdB: string): void {
    const a = this._orders.get(clientIdA);
    const b = this._orders.get(clientIdB);
    if (a && b) { a.ocoPeer = clientIdB; b.ocoPeer = clientIdA; }
  }

  /**
   * Rate-limited modify (drag): coalesces to the latest, sends at most every
   * minModifyMs. An invalid price (tick/band/freeze) is NOT enqueued or sent —
   * it surfaces via `onValidationError` so the UI can snap the line back.
   */
  public requestModify(clientId: string, price: number): void {
    const o = this._orders.get(clientId);
    if (o === undefined || isTerminal(o.state)) return;
    const v = validateOrder(price, o.req.qty, this._constraints);
    if (!v.ok) {
      this._onValidationError?.(v.reason ?? 'invalid modify price');
      return; // do NOT send an out-of-band modify to the broker
    }
    this._pendingModify.set(clientId, { price: v.price ?? price });
    const last = this._lastModifyAt.get(clientId) ?? -Infinity;
    if (this._now() - last >= this._minModifyMs) void this._flushModify(clientId);
  }

  /** Force-send any pending modify (e.g. on drag end). */
  public commitModify(clientId: string): Promise<void> {
    return this._flushModify(clientId);
  }

  private async _flushModify(clientId: string): Promise<void> {
    const patch = this._pendingModify.get(clientId);
    const o = this._orders.get(clientId);
    if (patch === undefined || o === undefined || o.brokerId === undefined) return;
    this._pendingModify.delete(clientId);
    this._lastModifyAt.set(clientId, this._now());
    o.state = transition(o.state, 'submitModify');
    try {
      await this._feed.modify(o.brokerId, patch);
      o.state = transition(o.state, 'ack');
    } catch {
      o.state = transition(o.state, 'reject');
    }
  }

  public async cancelOrder(clientId: string): Promise<void> {
    const o = this._orders.get(clientId);
    if (o === undefined || o.brokerId === undefined || isTerminal(o.state)) return;
    o.state = transition(o.state, 'submitCancel');
    try {
      await this._feed.cancel(o.brokerId);
      o.state = transition(o.state, 'cancelled');
      this._cancelOcoPeer(o);
    } catch {
      o.state = transition(o.state, 'reject');
    }
  }

  /** Broker fill event (by broker id). Advances state and triggers OCO. */
  public onFill(brokerId: string, full: boolean): void {
    const clientId = this._byBroker.get(brokerId);
    if (clientId === undefined) return;
    const o = this._orders.get(clientId);
    if (o === undefined) return;
    o.state = transition(o.state, full ? 'fill' : 'partialFill');
    if (full) this._cancelOcoPeer(o);
  }

  private _cancelOcoPeer(o: Tracked): void {
    if (o.ocoPeer === undefined) return;
    const peer = this._orders.get(o.ocoPeer);
    if (peer && !isTerminal(peer.state)) void this.cancelOrder(peer.clientId);
  }

  /** On reconnect, mark any non-terminal order absent from the fresh book as STALE. */
  public onReconnect(presentBrokerIds: ReadonlySet<string>): void {
    for (const o of this._orders.values()) {
      if (isTerminal(o.state)) continue;
      if (o.brokerId === undefined || !presentBrokerIds.has(o.brokerId)) {
        o.state = transition(o.state, 'reconnectAbsent');
      }
    }
  }
}
