// OpenAlgo Charts — public API surface (base tier).
// Phase 0: foundation only. createChart and series factories arrive in Phases 1–2.

export { VERSION, version } from './version';

export { createChart, Chart } from './core/chart';
export type { ChartOptions } from './core/chart';
export { Pane, DEFAULT_PANE_THEME } from './core/pane';
export type { PaneTheme } from './core/pane';
export { InvalidationLevel } from './core/invalidate-mask';
export type { PaneInvalidation, TimeScaleOp } from './core/invalidate-mask';
export { bitmapSize, snapToDevicePixel } from './core/canvas';
export type { Size } from './core/canvas';

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
