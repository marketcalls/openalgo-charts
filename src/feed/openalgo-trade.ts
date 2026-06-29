/**
 * OpenAlgo trade adapter (ARCHITECTURE.md §10.0). Implements the order engine's
 * OrderFeed over OpenAlgo REST (`/api/v1/placeorder`, `/modifyorder`,
 * `/cancelorder`) plus orderbook/positionbook fetches for reconciliation.
 *
 * Payloads match the local OpenAlgo docs: `placeorder` requires
 * strategy/symbol/action/exchange/pricetype/product/quantity; `modifyorder`
 * additionally requires the full order context, so we cache each order's context
 * (from place + the order book) and merge the patch on modify. Book responses
 * return string quantities/prices, which are coerced to numbers. Fetch is
 * injectable for offline tests; verify field names against your OpenAlgo build.
 */
import type { OrderFeed, PlaceRequest, TradeMode } from '../trade/order-engine';
import type { Order, Position } from '../trade/types';

export interface OpenAlgoTradeConfig {
  baseUrl: string;
  apiKey: string;
  /** Strategy label sent with orders (OpenAlgo groups by strategy). */
  strategy?: string;
  /** Default product when a request doesn't specify one. */
  defaultProduct?: 'CNC' | 'NRML' | 'MIS';
  fetchImpl?: typeof fetch;
}

/** Context needed to build a documented modifyorder payload. */
interface OrderContext {
  symbol: string;
  exchange: string;
  action: string;
  pricetype: string;
  product: string;
  quantity: number;
}

export class OpenAlgoTradeFeed implements OrderFeed {
  private readonly _config: OpenAlgoTradeConfig;
  private readonly _fetch: typeof fetch;
  private readonly _strategy: string;
  private readonly _defaultProduct: string;
  private readonly _ctx = new Map<string, OrderContext>();

  public constructor(config: OpenAlgoTradeConfig) {
    this._config = config;
    this._strategy = config.strategy ?? 'openalgo-charts';
    this._defaultProduct = config.defaultProduct ?? 'MIS';
    // Bind to the global object — a stored `this._fetch(...)` of window.fetch
    // throws "Illegal invocation" in browsers.
    const f = config.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
    if (f === undefined) throw new Error('openalgo-charts: no fetch available; pass config.fetchImpl');
    this._fetch = f;
  }

  private async _post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await this._fetch(`${this._config.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: this._config.apiKey, ...body }),
    });
    if (!res.ok) throw new Error(`openalgo-charts: ${path} failed (${res.status})`);
    return res.json();
  }

  public async place(req: PlaceRequest & { mode: TradeMode }): Promise<{ orderId: string }> {
    const ctx: OrderContext = {
      symbol: req.symbol,
      exchange: req.exchange ?? 'NSE',
      action: req.side,
      pricetype: req.type,
      product: req.product ?? this._defaultProduct,
      quantity: req.qty,
    };
    const json = (await this._post('/api/v1/placeorder', {
      strategy: this._strategy,
      symbol: ctx.symbol,
      action: ctx.action,
      exchange: ctx.exchange,
      pricetype: ctx.pricetype,
      product: ctx.product,
      quantity: req.qty,
      price: req.price ?? 0,
      trigger_price: req.triggerPrice ?? 0,
      disclosed_quantity: 0,
    })) as { orderid?: string; order_id?: string };
    const orderId = json.orderid ?? json.order_id;
    if (orderId === undefined) throw new Error('openalgo-charts: placeorder returned no orderid');
    this._ctx.set(orderId, ctx);
    return { orderId };
  }

  public async modify(orderId: string, patch: { price?: number; triggerPrice?: number; qty?: number }): Promise<void> {
    const ctx = this._ctx.get(orderId);
    if (ctx === undefined) {
      throw new Error(`openalgo-charts: cannot modify ${orderId} — unknown order context (place it or load the order book first)`);
    }
    if (patch.qty !== undefined) ctx.quantity = patch.qty; // keep cache in sync
    // OpenAlgo modifyorder requires the full order context, not just the delta.
    await this._post('/api/v1/modifyorder', {
      orderid: orderId,
      strategy: this._strategy,
      symbol: ctx.symbol,
      action: ctx.action,
      exchange: ctx.exchange,
      pricetype: ctx.pricetype,
      product: ctx.product,
      quantity: ctx.quantity,
      price: patch.price ?? 0,
      trigger_price: patch.triggerPrice ?? 0,
      disclosed_quantity: 0, // required by the modifyorder API
    });
  }

  public async cancel(orderId: string): Promise<void> {
    await this._post('/api/v1/cancelorder', { orderid: orderId, strategy: this._strategy });
  }

  /** Fetch the order book for reconciliation (maps to broker-agnostic Order[]). */
  public async getOrders(): Promise<Order[]> {
    const json = (await this._post('/api/v1/orderbook', {})) as { data?: { orders?: RawOrder[] } | RawOrder[] };
    const rows = Array.isArray(json.data) ? json.data : (json.data?.orders ?? []);
    const orders = rows.map(mapOrder);
    // Cache context so a later modify() of a book-loaded order can build its payload.
    for (const r of rows) {
      if (r.orderid) {
        this._ctx.set(r.orderid, {
          symbol: r.symbol ?? '', exchange: r.exchange ?? 'NSE', action: r.action ?? 'BUY',
          pricetype: r.pricetype ?? 'LIMIT', product: r.product ?? this._defaultProduct, quantity: num(r.quantity),
        });
      }
    }
    return orders;
  }

  /** Fetch the position book for reconciliation. */
  public async getPositions(): Promise<Position[]> {
    const json = (await this._post('/api/v1/positionbook', {})) as { data?: RawPosition[] };
    return (json.data ?? []).map(mapPosition);
  }
}

interface RawOrder {
  orderid?: string;
  symbol?: string;
  exchange?: string;
  action?: string;
  pricetype?: string;
  product?: string;
  quantity?: number | string;
  filled_quantity?: number | string;
  price?: number | string;
  trigger_price?: number | string;
  order_status?: string;
}

interface RawPosition {
  symbol?: string;
  quantity?: number | string;
  average_price?: number | string;
}

/** Coerce OpenAlgo's string-or-number numeric fields to a number. */
function num(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isNaN(n) ? 0 : n; }
  return 0;
}

const STATUS_MAP: Record<string, Order['status']> = {
  open: 'working', pending: 'pending', trigger_pending: 'working',
  complete: 'filled', cancelled: 'cancelled', rejected: 'rejected',
};

export function mapOrder(r: RawOrder): Order {
  return {
    id: r.orderid ?? '',
    symbol: r.symbol ?? '',
    side: r.action === 'SELL' ? 'SELL' : 'BUY',
    type: (r.pricetype as Order['type']) ?? 'LIMIT',
    qty: num(r.quantity),
    filledQty: num(r.filled_quantity),
    price: num(r.price),
    // trigger_price 0 means "no trigger" (a plain LIMIT/MARKET) — keep it undefined
    // so `triggerPrice ?? price` doesn't render the line at 0 (?? ignores undefined, not 0).
    triggerPrice: r.trigger_price !== undefined && num(r.trigger_price) > 0 ? num(r.trigger_price) : undefined,
    status: STATUS_MAP[(r.order_status ?? '').toLowerCase()] ?? 'working',
  };
}

export function mapPosition(r: RawPosition): Position {
  return { symbol: r.symbol ?? '', netQty: num(r.quantity), avgPrice: num(r.average_price) };
}
