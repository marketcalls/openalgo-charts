/**
 * OpenAlgo trade adapter (ARCHITECTURE.md §10.0, H8). Implements the order
 * engine's OrderFeed over OpenAlgo REST (`/api/v1/placeorder`, `/modifyorder`,
 * `/cancelorder`) plus orderbook/positionbook fetches for reconciliation. Fetch
 * is injectable so it is unit-testable offline; verify exact field names against
 * your OpenAlgo build before production.
 */
import type { OrderFeed, PlaceRequest, TradeMode } from '../trade/order-engine';
import type { Order, Position } from '../trade/types';

export interface OpenAlgoTradeConfig {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class OpenAlgoTradeFeed implements OrderFeed {
  private readonly _config: OpenAlgoTradeConfig;
  private readonly _fetch: typeof fetch;

  public constructor(config: OpenAlgoTradeConfig) {
    this._config = config;
    const f = config.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
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
    const json = (await this._post('/api/v1/placeorder', {
      strategy: 'openalgo-charts',
      symbol: req.symbol,
      exchange: req.exchange ?? 'NSE',
      action: req.side,
      pricetype: req.type,
      quantity: req.qty,
      price: req.price ?? 0,
      trigger_price: req.triggerPrice ?? 0,
    })) as { orderid?: string; order_id?: string };
    const orderId = json.orderid ?? json.order_id;
    if (orderId === undefined) throw new Error('openalgo-charts: placeorder returned no orderid');
    return { orderId };
  }

  public async modify(orderId: string, patch: { price?: number; triggerPrice?: number; qty?: number }): Promise<void> {
    await this._post('/api/v1/modifyorder', {
      orderid: orderId,
      price: patch.price,
      trigger_price: patch.triggerPrice,
      quantity: patch.qty,
    });
  }

  public async cancel(orderId: string): Promise<void> {
    await this._post('/api/v1/cancelorder', { orderid: orderId });
  }

  /** Fetch the order book for reconciliation (maps to broker-agnostic Order[]). */
  public async getOrders(): Promise<Order[]> {
    const json = (await this._post('/api/v1/orderbook', {})) as { data?: { orders?: RawOrder[] } | RawOrder[] };
    const rows = Array.isArray(json.data) ? json.data : (json.data?.orders ?? []);
    return rows.map(mapOrder);
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
  action?: string;
  pricetype?: string;
  quantity?: number;
  filled_quantity?: number;
  price?: number;
  trigger_price?: number;
  order_status?: string;
}

interface RawPosition {
  symbol?: string;
  quantity?: number;
  average_price?: number;
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
    qty: r.quantity ?? 0,
    filledQty: r.filled_quantity ?? 0,
    price: r.price ?? 0,
    triggerPrice: r.trigger_price,
    status: STATUS_MAP[(r.order_status ?? '').toLowerCase()] ?? 'working',
  };
}

export function mapPosition(r: RawPosition): Position {
  return { symbol: r.symbol ?? '', netQty: r.quantity ?? 0, avgPrice: r.average_price ?? 0 };
}
