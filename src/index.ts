// OpenAlgo Charts — public API surface (base tier).
// Phase 0: foundation only. createChart and series factories arrive in Phases 1–2.

export { VERSION, version } from './version';

export type { Bar, LinePoint, Whitespace, UTCSeconds, OriginalTime } from './model/bar';
export { isWhitespace } from './model/bar';

export type {
  DataFeed,
  TradeFeed,
  BarsRequest,
  MarketDepth,
  DepthLevel,
  OrderSide,
  OrderType,
  PlaceOrder,
  UnsubscribeFn,
} from './feed/types';

export { clamp, lerp, roundToTick } from './helpers/math';
