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
  /** Fetch authoritative history instead of a cached snapshot, when supported. */
  noCache?: boolean;
  /** Cancel this consumer's request. Existing feeds may ignore cancellation. */
  signal?: AbortSignal;
  /** Deadline in milliseconds, including response-body reading. */
  timeoutMs?: number;
  /** Preferred number of bars; a date-range feed may return a different count. */
  countBack?: number;
}

/** An optional provider page before an exclusive UTC-second anchor. */
export interface BarsPageRequest extends BarsRequest {
  before: UTCSeconds;
  countBack: number;
}

/** Providers can distinguish an empty date window from exhausted history. */
export interface BarsPage {
  bars: Bar[];
  hasMore?: boolean;
  /** Exclusive anchor for the next page, including pages without observations. */
  nextBefore?: UTCSeconds;
}

/** Optional context for continuing history and recovering an interrupted stream. */
export interface BarSubscriptionOptions {
  /** Last historical time-bucketed bar, used as the live builder's starting point. */
  seedFrom?: Bar;
  /** Cumulative day volume at the seed snapshot, if the host knows it. */
  cumDayVolumeSoFar?: number;
  /**
   * The stream reconnected and may have missed data. Refresh authoritative
   * history, then resubscribe with its last bar as the seed. Older bars must
   * not be delivered through onBar, whose consumers commonly accept only tails.
   */
  onResync?: () => void;
}

/** What a live push knows about the bar beyond its values. */
export interface LiveBarMeta {
  /**
   * The bar's open, high, low and volume cover only the ticks its builder saw:
   * it opened the bucket from a tick without having streamed the bar before
   * it. See `CandleUpdate.provisional`. A consumer holding history for the
   * same bucket keeps that open and widens the extremes rather than replacing
   * them.
   */
  provisional?: boolean;
}

/**
 * Broker-agnostic market-data source. The chart depends only on this.
 * `subscribeBars` is optional: a history-only feed (e.g. `OpenAlgoDataFeed`) omits
 * it, while a live feed (`OpenAlgoLiveDataFeed`, or your own) implements it.
 */
export interface DataFeed {
  getBars(req: BarsRequest): Promise<Bar[]>;
  getBarsPage?(req: BarsPageRequest): Promise<BarsPage>;
  /** Read a closed-bar snapshot without initiating a network request. */
  getCachedBars?(req: BarsRequest): Promise<Bar[] | undefined>;
  subscribeBars?(req: BarsRequest, onBar: (bar: Bar, meta?: LiveBarMeta) => void, opts?: BarSubscriptionOptions): UnsubscribeFn;
  /**
   * `opts.depthLevel` requests a book depth (broker-dependent: 5/20/30/50).
   * Named on the interface so a caller holding a `DataFeed` can ask for one;
   * an implementation is free to ignore it and send the broker's default.
   */
  subscribeDepth?(req: BarsRequest, onDepth: (depth: MarketDepth) => void, opts?: { depthLevel?: number }): UnsubscribeFn;
}

export interface DepthLevel {
  price: number;
  qty: number;
  orders?: number;
}

/** Variable-depth book; `bids`/`asks` length = whatever the broker streams (5..200). */
export interface MarketDepth {
  /** Exchange event timestamp in UTC seconds, when supplied by the feed. */
  timeSec?: UTCSeconds;
  bids: DepthLevel[];
  asks: DepthLevel[];
  ltp: number;
  ltq?: number;
}

/**
 * An instrument as the host's feed names it. Both parts are opaque: they are
 * compared exactly and never case-folded or parsed, so one symbol on two
 * venues is two instruments.
 */
export interface InstrumentKey {
  symbol: string;
  exchange: string;
}

/**
 * A quote as its provider reports it. It is the provider's own observation,
 * never a bar's close relabelled: a host without a quote source shows no
 * price rather than the last candle. Absent fields are unknown, never zero.
 */
export interface QuoteSnapshot extends InstrumentKey {
  /** Last traded price. */
  last: number;
  /** Reference close for the change figures, usually the previous session's. */
  previousClose?: number;
  bid?: number;
  ask?: number;
  /** Session volume. */
  volume?: number;
  /** Exchange time of the last trade, UTC seconds. */
  time?: UTCSeconds;
  /** The provider knows this quote is delayed rather than real time. */
  delayed?: boolean;
}

export interface QuoteRequest {
  instruments: readonly InstrumentKey[];
  /** Cancels this snapshot when the rows asking for it leave the screen. */
  signal?: AbortSignal;
}

/**
 * A quote stream as its provider reports it. Quotes held while the stream is
 * not `live` may have missed updates, so a consumer shows them as stale.
 */
export type QuoteStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'disconnected';

export interface QuoteStreamHandlers {
  onQuote(quote: QuoteSnapshot): void;
  onStatus?(status: QuoteStreamStatus, error?: Error): void;
}

/**
 * Optional quote source for watchlist rows. Separate from `DataFeed`, which
 * serves bars: a quote comes only from here.
 */
export interface QuoteFeed {
  /** A snapshot per instrument. An instrument missing from the answer is unknown. */
  getQuotes(request: QuoteRequest): Promise<QuoteSnapshot[]>;
  /**
   * Push quotes for these instruments until the returned function is called.
   * Omit it for a snapshot-only source. A consumer may call this once per
   * instrument so it can release exactly the rows that scroll away; a
   * provider multiplexes them over its own connection.
   */
  subscribeQuotes?(instruments: readonly InstrumentKey[], handlers: QuoteStreamHandlers): UnsubscribeFn;
}

/** One page of an instrument's news, newest first. */
export interface NewsRequest extends InstrumentKey {
  /** The provider's opaque cursor from the previous page; absent for the newest page. */
  cursor?: string;
  /** Preferred page size. A provider may return fewer. */
  limit: number;
  signal?: AbortSignal;
}

/** Every text field is plain text: a consumer never interprets it as markup. */
export interface NewsItem {
  /** Stable provider identity, used to drop an item repeated across pages. */
  id: string;
  headline: string;
  /** The publisher's name. */
  source?: string;
  /** Publication time, UTC seconds. */
  time: UTCSeconds;
  summary?: string;
  /** The full article. A consumer opens only http and https links. */
  url?: string;
}

export interface NewsPage {
  items: NewsItem[];
  /** Cursor for the next older page; absent or null when there is none. */
  nextCursor?: string | null;
}

/** Optional symbol news source. Coverage and rights remain the provider's. */
export interface NewsFeed {
  getNews(request: NewsRequest): Promise<NewsPage>;
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
