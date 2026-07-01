import type { Bar, UTCSeconds } from '../model/bar';

/** Cancels a subscription. */
export type UnsubscribeFn = () => void;

export interface BarsRequest {
  symbol: string;
  exchange: string;
  /** Interval token, e.g. "1m", "5m", "1h", "D". */
  interval: string;
  from?: UTCSeconds;
  to?: UTCSeconds;
}

/**
 * Broker-agnostic market-data source. The chart depends only on this.
 * `subscribeBars` is optional: a history-only feed (e.g. `OpenAlgoDataFeed`) omits
 * it, while a live feed (`OpenAlgoLiveDataFeed`, or your own) implements it.
 */
export interface DataFeed {
  getBars(req: BarsRequest): Promise<Bar[]>;
  subscribeBars?(req: BarsRequest, onBar: (bar: Bar) => void): UnsubscribeFn;
  subscribeDepth?(req: BarsRequest, onDepth: (depth: MarketDepth) => void): UnsubscribeFn;
}

export interface DepthLevel {
  price: number;
  qty: number;
  orders?: number;
}

/** Variable-depth book; `bids`/`asks` length = whatever the broker streams (5..200). */
export interface MarketDepth {
  bids: DepthLevel[];
  asks: DepthLevel[];
  ltp: number;
  ltq?: number;
}

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';

export interface PlaceOrder {
  symbol: string;
  exchange: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  price?: number;
  triggerPrice?: number;
  /** Idempotency token so a retried place never double-fills. */
  clientToken?: string;
}

/**
 * High-level broker trading source: place / modify / cancel plus subscriptions
 * to orders and positions. NOTE: the trade tier's `OrderEngine` uses the smaller
 * `OrderFeed` (`place` / `modify` / `cancel`, from `openalgo-charts/trade`), which
 * is what `OpenAlgoTradeFeed` implements. Implement `OrderFeed` for the engine's
 * write path; use `TradeFeed` for a higher-level broker abstraction.
 */
export interface TradeFeed {
  placeOrder(o: PlaceOrder): Promise<{ orderId: string }>;
  modifyOrder(orderId: string, patch: Partial<PlaceOrder>): Promise<void>;
  cancelOrder(orderId: string): Promise<void>;
  subscribeOrders(cb: (orders: unknown[]) => void): UnsubscribeFn;
  subscribePositions(cb: (positions: unknown[]) => void): UnsubscribeFn;
}
