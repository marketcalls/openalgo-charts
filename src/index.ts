// OpenAlgo Charts — public API surface (base tier).
// Phase 0: foundation only. createChart and series factories arrive in Phases 1–2.

export { VERSION, version } from './version';

export { createChart, Chart, compactVolume, PRICE_SCALE_MODES } from './core/chart';
export type {
  ChartOptions, AddSeriesOptions, CrosshairMoveEvent, ChartEventOptions,
  ContextMenuEvent, ContextMenuTarget, ContextMenuTargetKind, PriceAxisState,
  AxisChromeOptions, ZoomAnchor, DoubleClickAction, DoubleClickEvent, ExportSvgOptions,
  PointerModifiers, PointerKind, PointerSample, PointerInfo,
  ChartClickEvent, ChartDragEvent, ChartDragEndEvent, RendererFallbackEvent,
} from './core/chart';
// vector export: the serialising context behind `chart.exportSVG`, exported so
// a host can run its own primitives or a bare renderer into one.
export { SvgContext, SvgLinearGradient } from './render/svg-export';
export type { SvgContextOptions } from './render/svg-export';
export { Pane } from './core/pane';
export { darkTheme, lightTheme, DEFAULT_THEME } from './theme';
export type { ChartTheme } from './theme';
export { verticalGradient, withAlpha, fromGradient } from './render/gradient';
// eased wheel zoom (the counterpart to the kinetic pan a flick already gets)
export { ZoomGlide, DEFAULT_ZOOM_GLIDE_OPTIONS } from './input/zoom-glide';
export type { ZoomGlideOptions } from './input/zoom-glide';
export { InvalidationLevel } from './core/invalidate-mask';
export type { PaneInvalidation, TimeScaleOp } from './core/invalidate-mask';
export { bitmapSize, snapToDevicePixel } from './core/canvas';
export type { Size } from './core/canvas';

export { PriceScale, autoscaleRange, isRebasing, DEFAULT_PRICE_SCALE_OPTIONS } from './scale/price-scale';
export type { PriceRange, PriceScaleOptions, PriceScaleMode } from './scale/price-scale';
export { TimeScale, DEFAULT_TIME_SCALE_OPTIONS } from './scale/time-scale';
export type { LogicalRange, TimeScaleOptions } from './scale/time-scale';
export { niceTicks, precisionForStep } from './scale/ticks';
// `AxisStyle` is what `resolveScaleStyle` returns, so it belongs with it.
export type { TickMarkType, AxisStyle } from './render/axis';

// canvas option block (grid, crosshair, scales, margins). The resolvers are
// values because a host building its own settings dialog previews with them.
export { dashPattern, resolveGridStyle, resolveScaleStyle, resolvePlotMargins, SCALE_FONT_MIN, SCALE_FONT_MAX } from './render/grid';
export type {
  CanvasOptions, CanvasLineStyle, GridOptions, GridStyle, GridAxisStyle,
  ScaleCanvasOptions, PlotMarginOptions,
} from './render/grid';
export { resolveCrosshairStyle } from './render/crosshair';
export type { CrosshairOptions, CrosshairStyle } from './render/crosshair';

export { DEFAULT_CANDLE_STYLE, optimalBarWidth, candleTier, candleGeometry } from './render/candles';
export type { CandleStyle, CandleTier, CandleGeometry } from './render/candles';

// render backend port: the 2D backend ships here and registers itself; the
// GPU backend registers under 'webgl2' from its own lazy tier
// ('openalgo-charts/webgl') and `renderer: 'auto'` picks it up. Nothing under
// render/webgl is imported here: that is what keeps it out of the base bundle.
export {
  registerRenderBackend, unregisterRenderBackend, registeredRenderBackends,
  resolveRenderBackend, createRenderBackend, backendDegradation,
} from './render/backend';
export type {
  IRenderBackend, RenderBackendKind, RendererChoice, RenderBackendFactory, RenderDevice, RendererFallbackReason,
} from './render/backend';
export { Canvas2dBackend } from './render/canvas2d-backend';
export { DEFAULT_HISTOGRAM_STYLE } from './render/histogram';
export type { HistogramStyle } from './render/histogram';
export type { SeriesStyle } from './render/series-style';

export { registerChartType, getChartType, registeredChartTypes } from './model/chart-type-registry';
export type { SeriesType, RendererEntry, DrawItem, SeriesRenderContext } from './model/chart-type-registry';

// indicator registry (built-in descriptors ship in 'openalgo-charts/indicators')
export {
  registerIndicator,
  getIndicator,
  hasIndicator,
  registeredIndicators,
  indicatorDefaults,
  indicatorStyleInputs,
  plotStyleKeys,
  INDICATOR_LINE_STYLES,
  INDICATOR_PLOT_STYLES,
  sourceValue,
  sourceValues,
  INDICATOR_SOURCES,
} from './model/indicator-registry';
export type {
  IndicatorDescriptor,
  IndicatorInput,
  IndicatorPlot,
  IndicatorFillSpec,
  IndicatorLevel,
  IndicatorLevelContext,
  IndicatorLineStyle,
  IndicatorSettings,
  IndicatorSource,
  IndicatorStore,
  IndicatorValues,
  IndicatorAttachContext,
  IndicatorCalcContext,
  IndicatorAlertSpec,
  IndicatorAlertContext,
  IndicatorAlertPayload,
  IndicatorDrawing,
  DrawAnchor,
} from './model/indicator-registry';
export type { IndicatorApi, IndicatorHost } from './model/indicator-instance';

// serialisable chart state (saved layouts / templates / drawings passthrough)
export { CHART_STATE_VERSION } from './model/chart-state';
export type {
  ChartState,
  PaneState,
  PriceScaleState,
  SeriesState,
  IndicatorState,
  RestoreReport,
} from './model/chart-state';

// settings dialog: a declarative schema in the same control vocabulary the
// indicator form already uses, plus its round-trip pair
export { chartSettingsSchema, readChartSettings, applyChartSettings } from './model/chart-settings';
export type {
  ChartSettingsTab, ChartSettingsTabId, ChartSettingsValue, ChartSettingsValues, ChartSettingsState,
  // `ChartSettingsTab.inputs` is typed as these, so a host building its own
  // settings dialog cannot annotate the value it is handed without the name.
  ChartSettingsInput, ChartSettingsColorPairInput,
} from './model/chart-settings';

// headless market replay (host renders its own transport bar)
export { ReplayController } from './replay/controller';
export type {
  ReplayOptions, ReplayState, ReplayScheduler, ReplayChartHost, ReplayViewport,
} from './replay/controller';

// headless multi-symbol comparison (host renders its own symbol chips)
export { addComparison, comparisonController, ComparisonController } from './compare/controller';
export type {
  ComparisonOptions, ComparisonHandle, ComparisonMode,
  ComparisonControllerOptions, ComparisonChartHost, ComparisonPane,
} from './compare/controller';
export { alignToPrimary } from './compare/align';
export type { ComparisonAlignment } from './compare/align';

// chart linking (headless: the host draws its own link badge and colour chips).
// Everything crosses a chart boundary as a time, never as a logical index, so a
// daily chart and an hourly one stay on the same instant.
export { LinkGroup, createLinkGroup, followerIndex, followerRange, LinkCrosshair, LINK_CROSSHAIR_ALPHA } from './link/index';
export type {
  LinkChart, LinkOptions, LinkMemberOptions, ResolvedLinkOptions,
  LinkDataLayer, LinkMissingPolicy,
} from './link/index';

export { CandleBuilder, DEFAULT_CANDLE_BUILDER_OPTIONS } from './feed/candle-builder';
export type { CandleBuilderOptions, Tick, CandleUpdate, VolumeMode, LateTickPolicy } from './feed/candle-builder';

export type { SeriesApi, PriceScaleId } from './model/series';

// primitives / plugin API
export { bestHit } from './primitives/primitive';
export type { IPrimitive, PrimitiveHit, PrimitiveHost, PrimitiveRenderContext, PrimitiveAnchor, PrimitivePlacement, ZOrder } from './primitives/primitive';
export { IndicatorFill } from './primitives/indicator-fill';
export type { IndicatorFillOptions, FillPoint, FillGradient } from './primitives/indicator-fill';
export { IndicatorDrawings } from './primitives/indicator-draws';
export { IndicatorBackground } from './primitives/indicator-background';
// `chart.dataLayer` is public, so its type has to be nameable by a consumer —
// and a tier that takes one in its own public API needs to name *this* one.
export type { DataLayer, IndexedBar, SeriesId } from './model/data-layer';
export { PriceLine } from './primitives/price-line';
export type { PriceLineOptions } from './primitives/price-line';
// price-level family: previous close, session high/low, extended-hours opens
// and closes, bid/ask: each a line and an axis tag that toggle together.
export {
  PriceLevels, PRICE_LEVEL_KINDS, computePriceLevels,
  lastPriceLevelFromSeriesStyle, seriesStyleForLastPriceLevel,
} from './primitives/price-levels';
export type {
  PriceLevelKind, PriceLevelStyle, PriceLevelsOptions, PriceLevelValues,
  PriceLevelInput, PriceLevelQuote, MarketPhase, MarketPhaseFn,
} from './primitives/price-levels';
export { SeriesMarkers, markerSizePx, effectiveMarkerPx, drawShape, drawLabel } from './primitives/markers';
export type { SeriesMarker, MarkerShape, MarkerPosition, MarkerSize } from './primitives/markers';
export { LogoWatermark, watermarkRect } from './primitives/watermark';
export type { LogoWatermarkOptions, WatermarkPosition } from './primitives/watermark';
export { TextWatermark } from './primitives/text-watermark';
export type { TextWatermarkOptions } from './primitives/text-watermark';
export { ReplayShade } from './primitives/replay-shade';
export type { ReplayShadeOptions } from './primitives/replay-shade';
export { BuySellButtons } from './primitives/buy-sell-buttons';
export type { BuySellButtonsOptions } from './primitives/buy-sell-buttons';
export { ChartTable, tableOrigin, DEFAULT_CHART_TABLE_OPTIONS } from './primitives/table';
export type { TableCell, TablePosition, ChartTableOptions } from './primitives/table';
export { PaneLegend } from './primitives/pane-legend';
export type {
  PaneLegendOptions, PaneLegendAction, LegendValue, LegendField, LegendTitleMode,
  LegendStatusData, LegendStatusSource, LegendStatusLineOptions,
} from './primitives/pane-legend';
export { TimeNavigator, DEFAULT_TIME_NAVIGATOR_OPTIONS } from './primitives/time-navigator';
export type { TimeNavigatorOptions, TimeNavigatorAction } from './primitives/time-navigator';
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
export { OpenAlgoWsFeed, parseMessage, formatSubscribe, formatUnsubscribe, parseTopic, classifyAuthAck, readSequence, backoffDelayMs } from './feed/openalgo-ws';
export type { OpenAlgoWsConfig, SocketLike, SocketFactory, WsMode, LtpEvent, WsState, WsControlMessage, WsClientWarning, OrderUpdateEvent } from './feed/openalgo-ws';
export { OpenAlgoTradeFeed, mapOrder, mapPosition, decodeOrder, mapOrderStatus } from './feed/openalgo-trade';
export type { OpenAlgoTradeConfig, ModeCheck, RawOrder, DecodedOrder, OrderBookSnapshot, QuarantinedRow, OrderDecodeIssue, OrderDecodeCode, OrderDecodeResult } from './feed/openalgo-trade';
export { OpenAlgoLiveDataFeed, intervalToSeconds } from './feed/openalgo-live';
export type { OpenAlgoLiveConfig } from './feed/openalgo-live';
export { FakeDataFeed, generateBars } from './feed/fake-feed';
export type { FeedScheduler } from './feed/fake-feed';
export { TickBarAggregator } from './feed/tick-aggregator';
// `TickTimeframe` now lives in ./feed/intervals and is re-exported by the
// aggregator; it is deliberately exported from one place only, or the barrel
// would carry the same name twice.
export type { TickTimeframe, AggTick, BarUpdate, TickBarOptions } from './feed/tick-aggregator';

// warm-load bar caching: a DataFeed -> DataFeed wrapper, so any custom feed
// gets it, not just OpenAlgoDataFeed.
export { withBarCache, BarCache, barCacheKey, barCloseSec } from './feed/cache';
export type {
  BarCacheOptions, BarCacheStore, BarCacheStats, CachedBars, CachedBarsRequest, MaybePromise,
} from './feed/cache';

// interval registry: an interval code resolves to a bucketing rule, which is
// not always a duration (a month and a 500-tick bar both have no fixed length).
export {
  registerInterval, unregisterInterval, registeredIntervals,
  resolveInterval, tryResolveInterval, isKnownInterval,
  bucketStartOf, nextBucketStart, isTimeBucketed, UnknownIntervalError,
  intervalParts, isIntradayInterval, isDailyInterval, isSecondsInterval, isTickInterval,
} from './feed/intervals';
export type {
  IntervalDescriptor, Bucketing, IntervalBucketing, CalendarBucketing,
  TickCountBucketing, VolumeBucketing, CalendarUnit, IntervalParts,
} from './feed/intervals';
export {
  epochMsToUtcSeconds,
  istStringToUtcSeconds,
  utcSecondsToIstParts,
  utcSecondsToIstDateString,
  formatIstTime,
  formatIstTimeSeconds,
  formatIstDate,
  formatIstCrosshairLabel,
  isNewIstDay,
  sessionStartIndices,
  sessionStartFlags,
  calendarPeriodFlags,
  IST_OFFSET_SECONDS,
  // zone-aware forms: the general case the IST helpers above are one instance of
  DEFAULT_TIMEZONE,
  isValidTimezone,
  utcSecondsToZonedParts,
  utcSecondsToZonedDateString,
  zonedStringToUtcSeconds,
  zonedWallClockToUtcSeconds,
  zoneOffsetSeconds,
  zonedDayIndex,
  zonedWeekIndex,
  startOfZonedDay,
  startOfZonedWeek,
  startOfZonedMonth,
  isNewZonedDay,
  isNewZonedWeek,
  isNewZonedMonth,
  isNewZonedQuarter,
  isNewZonedYear,
  isNewZonedPeriod,
  formatZonedTime,
  formatZonedTimeSeconds,
  formatZonedDate,
  formatZonedCrosshairLabel,
  parseSessionSpec,
  inSessionAt,
  sessionFlags,
} from './feed/time';
export type { IstParts, ZonedParts, ZonedPeriod, SessionSpec } from './feed/time';

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

export { beginPick } from './input/pick';
export type { PickKind, PickHost } from './input/pick';
