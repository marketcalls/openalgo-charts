// OpenAlgo Charts — public API surface (base tier).
// Phase 0: foundation only. createChart and series factories arrive in Phases 1–2.

export { VERSION, version } from './version';

export { createChart, Chart } from './core/chart';
export type { ChartOptions, AddSeriesOptions, CrosshairMoveEvent } from './core/chart';
export { Pane } from './core/pane';
export { darkTheme, lightTheme, DEFAULT_THEME } from './theme';
export type { ChartTheme } from './theme';
export { verticalGradient } from './render/gradient';
export { InvalidationLevel } from './core/invalidate-mask';
export type { PaneInvalidation, TimeScaleOp } from './core/invalidate-mask';
export { bitmapSize, snapToDevicePixel } from './core/canvas';
export type { Size } from './core/canvas';

export { PriceScale, autoscaleRange, DEFAULT_PRICE_SCALE_OPTIONS } from './scale/price-scale';
export type { PriceRange, PriceScaleOptions, PriceScaleMode } from './scale/price-scale';
export { TimeScale, DEFAULT_TIME_SCALE_OPTIONS } from './scale/time-scale';
export type { LogicalRange, TimeScaleOptions } from './scale/time-scale';
export { niceTicks, precisionForStep } from './scale/ticks';

export { DEFAULT_CANDLE_STYLE, optimalBarWidth } from './render/candles';
export type { CandleStyle } from './render/candles';
export { DEFAULT_HISTOGRAM_STYLE } from './render/histogram';
export type { HistogramStyle } from './render/histogram';
export type { SeriesStyle } from './render/series-style';

export { registerChartType, getChartType, registeredChartTypes } from './model/chart-type-registry';
export type { SeriesType, RendererEntry, DrawItem, SeriesRenderContext } from './model/chart-type-registry';

export { CandleBuilder, DEFAULT_CANDLE_BUILDER_OPTIONS } from './feed/candle-builder';
export type { CandleBuilderOptions, Tick, CandleUpdate, VolumeMode, LateTickPolicy } from './feed/candle-builder';

export type { SeriesApi, PriceScaleId } from './model/series';

// primitives / plugin API
export { bestHit } from './primitives/primitive';
export type { IPrimitive, PrimitiveHit, PrimitiveHost, PrimitiveRenderContext, ZOrder } from './primitives/primitive';
export { PriceLine } from './primitives/price-line';
export type { PriceLineOptions } from './primitives/price-line';
export { SeriesMarkers, markerSizePx, effectiveMarkerPx, drawShape } from './primitives/markers';
export type { SeriesMarker, MarkerShape, MarkerPosition, MarkerSize } from './primitives/markers';
export { LogoWatermark, watermarkRect } from './primitives/watermark';
export type { LogoWatermarkOptions, WatermarkPosition } from './primitives/watermark';
export { EventMarkers } from './primitives/event-markers';
export type { ChartEvent } from './primitives/event-markers';

// indicators
export { ema, emaSeries } from './indicators/ema';
export { rsi, rsiSeries } from './indicators/rsi';
export { atr, trueRange } from './indicators/atr';
export { supertrend, supertrendSeries, type SupertrendPoint } from './indicators/supertrend';

// optional OHLC-preserving conflation / downsampling (§4.4)
export { conflationGroupSize, conflateBars, conflateItems, mergeBars } from './model/conflation';

// Family-B transforms live in the lazy 'openalgo-charts/transform' entry point
// (importing it also registers the 'point-figure' and 'kagi' renderers), so they
// are intentionally NOT re-exported from the base bundle.
export type { Bar, LinePoint, Whitespace, SeriesDataItem, UTCSeconds, OriginalTime } from './model/bar';
export { isWhitespace, toBar } from './model/bar';

export type { DataFeed, TradeFeed, BarsRequest, MarketDepth, DepthLevel, OrderSide, OrderType, PlaceOrder, UnsubscribeFn } from './feed/types';
export { OpenAlgoDataFeed, mapHistoryResponse, rowTimeToUtcSeconds } from './feed/openalgo-rest';
export type { OpenAlgoConfig } from './feed/openalgo-rest';
export { OpenAlgoWsFeed, parseMessage, formatSubscribe, formatUnsubscribe } from './feed/openalgo-ws';
export type { OpenAlgoWsConfig, SocketLike, SocketFactory, WsMode, LtpEvent, WsState, WsControlMessage } from './feed/openalgo-ws';
export { OpenAlgoTradeFeed, mapOrder, mapPosition } from './feed/openalgo-trade';
export type { OpenAlgoTradeConfig } from './feed/openalgo-trade';
export { OpenAlgoLiveDataFeed, intervalToSeconds } from './feed/openalgo-live';
export type { OpenAlgoLiveConfig } from './feed/openalgo-live';
export { FakeDataFeed, generateBars } from './feed/fake-feed';
export type { FeedScheduler } from './feed/fake-feed';
export { TickBarAggregator } from './feed/tick-aggregator';
export type { TickTimeframe, AggTick, BarUpdate } from './feed/tick-aggregator';
export {
  epochMsToUtcSeconds,
  istStringToUtcSeconds,
  utcSecondsToIstParts,
  utcSecondsToIstDateString,
  formatIstTime,
  formatIstTimeSeconds,
  formatIstDate,
  isNewIstDay,
  IST_OFFSET_SECONDS,
} from './feed/time';

export { clamp, lerp, roundToTick } from './helpers/math';

export { TradingController, TradeMarkersPrimitive, DEFAULT_TRADING_COLORS } from './core/trading-controller';
export type {
  TradingHost,
  TradingPosition,
  TradingOrder,
  TradingTrade,
  TradingSyncPayload,
  TradingColors,
  TradingSettings,
  PositionSide,
  TradingOrderSide,
  TradingOrderType,
  TradeMarkerVariant,
  TradingLineVariant,
  TradingLineStyle,
} from './core/trading-controller';

export {
  ShortcutManager,
  DEFAULT_KEYMAP,
  ALT_PRESET,
  BUILTIN_COMMANDS,
  parseCombo,
  normalizeCombo,
  formatCombo,
  isValidCombo,
  isReservedCombo,
  eventToCombo,
} from './input/shortcuts';
export type {
  ShortcutScope,
  ShortcutPreset,
  KeymapEntry,
  CustomShortcut,
  ShortcutManagerOptions,
  ShortcutTriggerEvent,
  ShortcutListItem,
} from './input/shortcuts';
