/**
 * Top-level chart orchestrator (ARCHITECTURE.md §3.3). Owns the shared
 * DataLayer + time scale, the panes, the invalidate mask, and the render loop.
 * Phase 2 renders static candlesticks with price/time axes; pan/zoom (Phase 3)
 * and live data (Phase 4) build on this.
 */
import { InvalidateMask, InvalidationLevel } from './invalidate-mask';
import { RenderLoop, type RafScheduler, type RafCanceller } from './render-loop';
import { Pane, type PaneRenderContext } from './pane';
import { alignToDevicePixels, hairlineHeight, type CanvasLayer } from './canvas';
import type { PriceAxisPlacement, PriceAxisSide, PriceAxisSlot } from '../model/price-axis-layout';
import { type ChartTheme, DEFAULT_THEME } from '../theme';
import { TimeScale, type TimeScaleOptions } from '../scale/time-scale';
import type { LogicalRange } from '../scale/time-scale';
import type { PriceScaleOptions, PriceScaleMode, PriceScale } from '../scale/price-scale';
import { medianBarInterval, type TickMarkType, type SessionClockOptions, type BarCountdownOptions } from '../render/axis';
import { resolvePlotMargins, type CanvasOptions, type GridOptions } from '../render/grid';
import { SvgContext } from '../render/svg-export';
import {
  resolveRenderBackend, type IRenderBackend, type RenderBackendFactory, type RenderBackendKind, type RendererChoice,
  type RendererFallbackReason,
} from '../render/backend';
import { DataLayer, type SessionCalendarSource } from '../model/data-layer';
import { createSeriesRecord, type SeriesApi, type SeriesRecord, type PriceScaleId, type PriceFormat, type BarConfirmationOptions, type SeriesUpdateOptions } from '../model/series';
import { bindSeriesProvenance, SeriesProvenance, validateSeriesOptions } from '../model/series-provenance';
import { replayWindow, observeReplayWindow } from '../model/replay-window';
import { runAbortable } from '../model/abortable-request';
import { cloneIndicatorSettings, planIndicatorDependencies } from '../model/indicator-dependencies';
import { getChartType, type SeriesType } from '../model/chart-type-registry';
import {
  getIndicator, hasIndicator, plotStyleKeys,
  type IndicatorBarsProvider, type IndicatorBarsProviderAccess, type IndicatorDescriptor, type IndicatorSettings,
} from '../model/indicator-registry';

/**
 * Colours the 2nd and later instances of the same indicator rotate through.
 * Chosen to stay apart on both dark and light panes and to read as distinct at
 * a 1px stroke, which rules out near-neighbour hues.
 */
/** PaneLegend's own defaults, restated so a pane can be reset to them. */
const DEFAULT_LEGEND_TOP = 6;
const DEFAULT_LEGEND_LEFT = 8;
/** The controls the first study row of a lower pane carries for the pane itself. */
const PANE_ACTIONS: readonly PaneLegendAction[] = ['up', 'down', 'collapse', 'maximize'];

/** A study row's own actions, with the pane's controls before close when the row leads its pane. */
function leadActions(actions: readonly PaneLegendAction[] = [], lead: boolean): PaneLegendAction[] {
  const own = actions.filter(action => !PANE_ACTIONS.includes(action));
  if (lead) own.splice(own.includes('close') ? own.indexOf('close') : own.length, 0, ...PANE_ACTIONS);
  return own;
}

interface PreparedIndicatorRestore {
  specs: IndicatorState[];
  order: readonly string[];
  descriptors: ReadonlyMap<string, IndicatorDescriptor>;
}
type PreservedScaleFormats = ReadonlyMap<Pane, ReadonlySet<PriceScaleId>>;

/**
 * How fast a drag's remembered velocity fades while the pointer is still down,
 * in ms. Short enough that a deliberate pause before releasing kills the fling,
 * long enough that the ordinary jitter between two move events does not.
 */
const KINETIC_VELOCITY_HALFLIFE_MS = 50;

/** Hard ceiling on glide frames, about ten seconds at 60fps. See `_startKinetic`. */
const KINETIC_MAX_FRAMES = 600;
/** Same ceiling, same reason, for the zoom glide (see `_startKinetic`). */
const ZOOM_GLIDE_MAX_FRAMES = 600;

/** What a wheel zoom holds still. */
export type ZoomAnchor = 'cursor' | 'right';
/** What a double-click on a pane does. See {@link ChartOptions.doubleClick}. */
export type DoubleClickAction = 'reset' | 'maximize' | 'none';
/**
 * The `dblclick` event. `paneIndex` is the pane under the pointer. A listener
 * that acts on the double-click itself (opening a text editor for the selected
 * drawing, say) sets `handled` to true, and the chart's own action is skipped
 * for that press.
 */
export interface DoubleClickEvent {
  paneIndex: number;
  x: number;
  y: number;
  handled: boolean;
}

const INSTANCE_PALETTE: readonly string[] = [
  '#f5a623', '#26a69a', '#ab47bc', '#ef5350',
  '#26c6da', '#8bc34a', '#ff7043', '#5c6bc0',
];
import { IndicatorInstance, parseIndicatorPlotPriceScales, validateIndicatorScaleAssignment, type IndicatorApi, type IndicatorHost } from '../model/indicator-instance';
import { parseIndicatorPolicy, type IndicatorEditOptions, type IndicatorPolicy } from '../model/indicator-policy';
import type { AlertsDocument } from '../alerts/types';
import { copyAlert, parseAlertsDocument, validateAlert } from '../alerts/document';
import type { ChartDataContext } from '../model/indicator-registry';
import {
  CHART_STATE_VERSION,
  parsePaneState,
  type ChartState,
  type PaneState,
  type PriceScaleState,
  type SeriesState,
  type RestoreReport,
  type ChartRestoreOptions,
  type IndicatorState,
} from '../model/chart-state';
import type { SeriesStyle } from '../render/series-style';
import type { Bar, SeriesDataItem } from '../model/bar';
import { toBar } from '../model/bar';
import { KineticAnimation } from '../input/kinetic';
import { ZoomGlide } from '../input/zoom-glide';
import { wheelPixels, wheelLogFactor } from '../input/wheel';
import { magnetSnapPrice, type CrosshairMode } from '../input/crosshair';
import { ShortcutManager } from '../input/shortcuts';
import type { ShortcutManagerOptions } from '../input/shortcuts';
import { TradingController, DEFAULT_TRADING_COLORS, type TradingColors, type TradingSettings } from './trading-controller';
import { pinchState, pinchDelta, type PinchState } from '../input/touch';
import { beginPickResolved, cancelPick, type PickKind, type PickOptions, type PickHandle, type PickPoint } from '../input/pick';
import type { IPrimitive, PrimitiveHost, PrimitiveHit, PrimitiveAnchor, PrimitivePlacement } from '../primitives/primitive';
import { PriceLine, type PriceLineOptions } from '../primitives/price-line';
import { SeriesMarkers } from '../primitives/markers';
import { EventMarkers, type ChartEvent, type EventGroup, type EventMarkersOptions, type EventMarkerDetails } from '../primitives/event-markers';
import { PaneLegend, paneLegendRowHeight, type PaneLegendAction, type LegendStatusLineOptions } from '../primitives/pane-legend';
import { IndicatorLegendToggle, INDICATOR_LEGEND_TOGGLE } from '../primitives/indicator-legend-toggle';
import { validateIndicatorInputs } from '../model/indicator-inputs';
import { ChartTable } from '../primitives/table';
import { TimeNavigator, type TimeNavigatorOptions } from '../primitives/time-navigator';
import type { ChartSettingsState } from '../model/chart-settings';
import { LogoWatermark, type LogoWatermarkOptions } from '../primitives/watermark';
import { TextWatermark, type TextWatermarkOptions } from '../primitives/text-watermark';
import type { TickSchedule } from '../feed/tick-schedule';

/** Optional background text. Blank text follows the chart's symbol and interval. */
export interface ChartWatermarkOptions extends Partial<TextWatermarkOptions> {
  visible?: boolean;
}

/** A pane's plot area in container media px, from `Chart.plotRect`. */
export interface PlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Defensive branding snapshot emitted synchronously after setBranding as `branding:changed`. */
export type BrandingChangedEvent = false | LogoWatermarkOptions;
import { DEFAULT_TIMEZONE, isValidTimezone } from '../feed/time';
import { clamp, roundToTick } from '../helpers/math';

/** A zone name the runtime recognises, or a readable failure at the call site. */
function checkedTimezone(zone: string): string {
  if (!isValidTimezone(zone)) {
    throw new Error(`openalgo-charts: unknown IANA time zone "${zone}"`);
  }
  return zone;
}

/**
 * Which corporate-action / news markers the chart draws. Every type defaults to
 * on; an unlisted type is always drawn. Only filters the strip the chart owns
 * (`setEvents`), not an `EventMarkers` a host drives itself.
 */
export interface ChartEventOptions {
  earnings?: boolean;
  dividend?: boolean;
  split?: boolean;
  news?: boolean;
}

/**
 * Chrome that lives on the axis strips rather than in the plot: a live clock in
 * the corner where the two axes meet, and a countdown to the current bar's close
 * inside the last-price tag.
 *
 * Both default to off. Neither is a thing a chart should start showing because
 * it upgraded, and a chart that sets none of this draws the axes it always drew.
 */
export interface AxisChromeOptions {
  /**
   * Live clock in the corner between the price and time axes. `true` takes the
   * defaults; the object form is there for the one thing worth choosing, the
   * second row carrying the zone's offset from UTC.
   */
  sessionClock?: boolean | { showOffset?: boolean };
  /** Second row in the last-price tag counting down to the bar's close. */
  barCountdown?: boolean;
  /**
   * Wall-clock UTC seconds. Both readings are times of day, so neither can use
   * `now`, which is a monotonic animation clock and not a calendar. Defaults to
   * the system clock; pass the feed's clock to keep a delayed or replayed chart
   * honest about what time its data thinks it is.
   */
  clock?: () => number;
}

/** Options for `Chart.exportSVG`. */
export interface ExportSvgOptions {
  /**
   * Document width in media px. Absent means the live chart width. A different
   * size lays the chart out afresh for the export (the same bar spacing over a
   * wider or narrower plot, every scale re-measured for its new height) and
   * puts the live layout back before returning.
   */
  width?: number;
  /** Document height in media px. Absent means the live chart height. */
  height?: number;
  /**
   * Paint the theme background under the chart. Default true. Off, the
   * document has no ground of its own and takes the colour of whatever page
   * it is placed on, which is what an embedded figure usually wants.
   */
  background?: boolean;
  /**
   * The pixel ratio the paint runs at. Only 1 is accepted: SVG has no device
   * pixels, and a renderer asked for 2 would snap its hairlines to half-media-
   * pixel edges that scale as a blur. Named so the option reads the same as
   * the PNG path and a future scaled export has a place to land.
   */
  dpr?: 1;
}

/** Preferences for pointer panning and the view restored by reset. */
export interface ChartNavigationOptions {
  /** Allow user plot translation, including touch, wheel and keys. Default: true. */
  panEnabled?: boolean;
  /** Allow user zoom and reset/fit actions. Programmatic setters remain available. Default: true. */
  zoomEnabled?: boolean;
  /** Mouse and pen plot drags. Touch gestures retain two-axis panning. Default: both. */
  mousePan: 'horizontal' | 'both';
  /** Latest bars to show initially and on reset. 0 fits all loaded bars (default). */
  defaultVisibleBars: number;
  /** Initial/reset spacing in CSS pixels. Positive values override the bar count; 0 disables it. */
  defaultBarSpacing?: number;
}

export interface ChartOptions {
  document?: Document;
  pixelRatio?: () => number;
  raf?: { schedule: RafScheduler; cancel?: RafCanceller };
  /** Full palette; pass `lightTheme` (the default), `darkTheme`, or a custom ChartTheme. */
  theme?: ChartTheme;
  priceAxisWidth?: number;
  timeAxisHeight?: number;
  /** Initial horizontal scale configuration, including spacing limits for wide profiles. */
  timeScale?: Partial<TimeScaleOptions>;
  /** Saved navigation preferences, also exposed in the Axes settings tab. */
  navigation?: Partial<ChartNavigationOptions>;
  /**
   * Where indicator legend rows start inside **one** pane, in media px. A host
   * that draws its own overlay in a pane's top-left corner — an OHLC readout, a
   * symbol line, a trade panel — needs to push these clear of it, or the rows
   * land underneath and their settings / close buttons become invisible and
   * unclickable.
   *
   * It follows the primary price pane, which is at the top until something
   * moves it below its studies: a readout of the price belongs to the price
   * pane, wherever it sits. Maximizing a study pane hides the price pane, so
   * the maximized pane, now in the same corner, inherits the offset. Every
   * other pane keeps the default corner, because a short study pane would
   * have its legend pushed off it entirely.
   *
   * Defaults to `{ top: 6, left: 8 }`.
   */
  legendOffset?: { top?: number; left?: number };
  /**
   * Crosshair behaviour. 'normal' (default) — the cross follows the pointer
   * exactly. 'magnet' — the horizontal line snaps to the nearest O/H/L/C of the
   * bar under the cursor (price pane only).
   */
  crosshairMode?: CrosshairMode;
  /** Snap the vertical crosshair to the nearest primary bar's center. Default false; independent of the price magnet. */
  crosshairSnapToBar?: boolean;
  /** Fit the primary series' scale to that series only. Does not enable auto-fit. Default false. */
  priceOnlyAutoScale?: boolean;
  /** Collapse study legend rows into a count without hiding their plots or stopping calculations. Default false. */
  indicatorLegendCollapsed?: boolean;
  /**
   * Optional chrome on the axis strips: the corner clock and the bar-close
   * countdown. Both are off unless asked for, so a chart that omits this block
   * draws the axes it always drew.
   */
  axisChrome?: AxisChromeOptions;
  /** Time source for kinetic animation (defaults to performance.now). */
  now?: () => number;
  /**
   * Ease a wheel zoom over a few frames instead of landing the whole step on
   * one. Default true, matching the inertial pan a flick already gets: a chart
   * that glides when panned and jumps when zoomed reads as two different
   * instruments. Off restores the single-frame step.
   */
  animZoom?: boolean;
  /** Ease automatic price ranges during navigation. Defaults to animZoom (true). */
  animAutoscale?: boolean;
  /**
   * What a wheel zoom holds still: the bar under the cursor, or the right edge
   * (the latest bar). Default `'cursor'`, which is what the chart has always
   * done. `'right'` keeps the most recent bar pinned while history stretches
   * away from it, which is what a live chart usually wants.
   */
  zoomAnchor?: ZoomAnchor;
  /**
   * What a double-click on a pane does. `'reset'` (the default, and what the
   * chart has always done) fits every loaded bar on screen and autoscales,
   * which also lands the viewport on the oldest bar and so wakes a history
   * loader. `'maximize'` gives the pane the whole stack, and a second
   * double-click puts the stack back, which is what a multi-pane terminal
   * usually wants from the gesture. `'none'` only emits the event. While a
   * tool is being placed a double-click finishes the shape whatever this says.
   */
  doubleClick?: DoubleClickAction;
  /** Enable OHLC-preserving conflation when zoomed out (§4.4). Default false. */
  conflate?: boolean;
  /** Conflation aggressiveness (default 1). */
  conflationFactor?: number;
  /**
   * Which backend paints the series. `'canvas2d'` (the default) is the 2D
   * path every chart has always drawn with. `'webgl2'` asks for the GPU
   * backend: it throws when the tier that registers it has not been imported
   * (a missing import is a mistake in the code), and on a device where that
   * tier finds no WebGL2 it falls back to `canvas2d` with one console warning
   * (a property of the machine the host should still hear about). `'auto'`
   * takes `webgl2` when it is registered and available on this device and
   * `canvas2d` otherwise, silently. Decided once, at construction; read what
   * was actually chosen from `rendererKind`. A GPU backend that loses its
   * context later moves the chart to `canvas2d` for the rest of the session
   * and emits 'renderer:fallback'.
   */
  renderer?: RendererChoice;
  /**
   * Build the backend directly, one call per pane, bypassing `renderer` and
   * the registry. For a host bringing its own backend, and for tests that
   * want to see what the pane asks a backend to paint. A factory that returns
   * null gets the 2D backend for that pane.
   */
  renderBackend?: RenderBackendFactory;
  /**
   * Grid lines: visibility (both default to true) plus per-axis colour, dash,
   * width and spacing. Unset colours/dashes fall through to the theme.
   */
  grid?: Partial<GridOptions>;
  /**
   * The settings dialog's Canvas block: grid, crosshair, scale text/lines and
   * plot margins. Every field is an override of the theme, so a later
   * `setTheme` still restyles anything the dialog did not touch.
   */
  canvas?: CanvasOptions;
  /** Per-field status-line switches applied to every pane legend on the chart. */
  statusLine?: LegendStatusLineOptions;
  /**
   * Square side of a legend action button in media px. Default 16, held to
   * 12..28. Applied to every pane legend, because the rows stack against it.
   */
  legendIconSize?: number;
  /** Accessible label for the chart container (screen readers). */
  ariaLabel?: string;
  /**
   * Keyboard shortcuts. Pass a configured `ShortcutManager`, options to build
   * one, or `false` to disable keyboard control. Defaults to the built-in keymap.
   */
  shortcuts?: ShortcutManager | Partial<ShortcutManagerOptions> | false;
  /**
   * Custom price formatter for every pane's axis tick labels, the last-price
   * tag, and price-line labels. e.g. `(p) => '$' + p.toFixed(2)`. When omitted,
   * a tick-size-aware `toFixed` is used. Change it later via `setPriceFormatter`.
   */
  priceFormatter?: (price: number) => string;
  /**
   * Default price-scale options applied to every pane (tick size `minMove`,
   * `mode: 'linear' | 'logarithmic' | 'percentage' | 'indexed-to-100'`,
   * `inverted`, and top/bottom margins). `minMove` is the instrument's, so it
   * lands only on panes that quote it, see `setPriceScaleOptions`.
   * Tune a single pane later via `chart.panes()[n].priceScale.setOptions(...)`.
   */
  priceScale?: Partial<PriceScaleOptions>;
  /**
   * Where an indicator gets another instrument's bars. The engine is handed
   * one symbol's history and owns no transport, so a study that compares
   * against a benchmark asks through this and the host answers from wherever
   * it keeps candles. Change it later with `setBarsProvider`. Without one an
   * indicator's `requestBars` rejects, and the study reports itself
   * unsupported rather than drawing something invented.
   */
  barsProvider?: IndicatorBarsProvider | IndicatorBarsProviderAccess;
  /**
   * Custom time-axis and crosshair label formatter (receives UTC seconds). When
   * omitted, labels use IST (Indian market default). e.g. for UTC:
   * `(s) => new Date(s * 1000).toISOString().slice(11, 16)`.
   */
  timeFormatter?: (utcSeconds: number, tickMark?: TickMarkType) => string;
  /**
   * IANA zone the time axis and crosshair label in, e.g. 'America/New_York' or
   * 'Europe/London'. Defaults to 'Asia/Kolkata': a caller who passes nothing
   * gets exactly the labels the chart produced before this option existed.
   *
   * An IANA name and not a fixed offset, because a zone that observes DST is a
   * different offset in July than in January and a fixed one is silently wrong
   * for half the year. Change it at runtime with `setTimezone` when the terminal
   * moves between an NSE symbol and a US one. An explicit `timeFormatter`
   * outranks this: a host that formats its own labels has settled the question.
   *
   * Throws if the runtime does not recognise the name.
   */
  timezone?: string;
  /**
   * Hover-revealed zoom / step controls above the time axis, as terminals show.
   * `true` by default — they stay invisible until the pointer nears the bottom
   * of the chart. Pass `false` to drop them, or an options object to restyle.
   */
  timeNavigator?: boolean | Partial<TimeNavigatorOptions>;
  /** OpenAlgo corner mark by default. Pass false to hide it or options for custom branding. */
  branding?: boolean | LogoWatermarkOptions;
  /** Background text, off by default. Blank text follows setDataContext. */
  watermark?: boolean | ChartWatermarkOptions;
  /**
   * Let the primary price pane leave the top of the stack: below its studies
   * through `movePane`, `setPrimaryPaneIndex`, a study pane's own up and down
   * controls, or a restored layout that saved it lower down. Default false,
   * which keeps the price pane pinned at slot 0 exactly as every earlier
   * release did: `movePane` refuses to move or displace it,
   * `setPrimaryPaneIndex` returns false, and `restoreState` refuses a layout
   * that puts it anywhere else, so an explicit pane 0 always means the price.
   *
   * Opt-in because a host that passes 0 to mean the price pane (a price or
   * order line, `coordinateToPrice(y, 0)` pricing a right-click order, a price
   * alert check, `panes()[0]`) would read a study's units the moment a user
   * moved a study above the candles. Before turning it on, drop those explicit
   * zeros or ask `primaryPaneIndex()`, and follow `paneMoved`. Decided once,
   * at construction; read it back with `movablePrimaryPane()`. `createWidget`
   * and `createChartGrid` hand it to their charts as given, off by default too.
   */
  movablePrimaryPane?: boolean;
}

export interface AddSeriesOptions {
  /**
   * Target pane index. Omitted means the primary price pane wherever it sits
   * (slot 0 until something moves it, see `Chart.primaryPaneIndex`). Higher
   * panes are created on demand.
   */
  paneIndex?: number;
  /** Style overrides merged onto the chart type's defaults. */
  style?: SeriesStyle;
  /**
   * Which price axis this series maps to. 'right' (default) and 'left' each draw
   * an axis and autoscale independently; '' is a hidden overlay scale (no axis)
   * for a volume histogram inside the price pane.
   */
  priceScaleId?: PriceScaleId;
  /**
   * Value formatting applied to this series' price scale (axis + crosshair tag):
   * `price` (tick-size precision), `volume` (compact 1.2K / 3.4M / 5.6B),
   * `percent` (a `%` suffix at a fixed precision), or a `custom` formatter.
   *
   * `percent` suffixes the value as it stands and does **not** scale it: a study
   * that already returns 0..100 reads `62.24%`, and one that returns a 0..1
   * fraction reads `0.62%`. Multiplying here would put the axis and the plotted
   * value into disagreement, which is the one thing a formatter must never do.
   */
  priceFormat?: PriceFormat;
}

/** Compact volume/number formatter (1.2K / 3.4M / 5.6B). */
export function compactVolume(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return String(Math.round(v));
}

/**
 * Emitted on every crosshair move (and `null` fields on pointer-leave) so a host
 * can render an OHLC legend / tooltip. `bar` is the hovered bar of the primary
 * price series; `point` is container-relative media px for positioning a
 * floating tooltip. See `subscribeCrosshairMove`.
 */
export interface CrosshairMoveEvent {
  /** Linked readouts have no physical pointer position and are not pointer gestures. */
  source?: 'linked';
  /** UTC seconds of the hovered bar, or null when off the data / pointer left. */
  time: number | null;
  /** Logical index under the cursor, or null. */
  index: number | null;
  /** Price under the cursor on the hovered pane, or null. */
  price: number | null;
  /** Hovered bar of the primary (first) price series, or null. */
  bar: Bar | null;
  /** Cursor position in container media px, or null on leave. */
  point: { x: number; y: number } | null;
  /** Pane under the cursor, or null on leave. */
  paneIndex?: number | null;
  /**
   * True while a pointer is held. Placement mode swallows the pan path, so
   * this is the only way to tell a hover from a drag while it is still
   * happening. Absent on the all-null leave payload.
   */
  pressed?: boolean;
  /** Modifier keys held during the move. Absent on the leave payload. */
  modifiers?: PointerModifiers;
  /** Device behind the move. Absent on the leave payload. */
  pointerType?: PointerKind;
  /** Pressure as reported for the move (see `PointerSample`). Absent on the leave payload. */
  pressure?: number;
  /**
   * Every position the pointer passed through since the last move, in the
   * drag payload's space (container x, pane-local y), present only while
   * `pressed`. Placement mode never arms a drag, so a freehand stroke reads
   * its coalesced samples here.
   */
  samples?: PointerSample[];
}

/** Modifier keys held during a pointer gesture. */
export interface PointerModifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

/** Device behind a pointer gesture. Anything the browser does not name reports as a mouse. */
export type PointerKind = 'mouse' | 'touch' | 'pen';

/**
 * One position a pointer passed through during a drag, in the same media px
 * space as the payload's `point` (container x, pane-local y). `pressure` is
 * the pointer events convention: 0..1 from hardware that measures it, 0.5
 * while a button that cannot is held, 0 when nothing is known.
 */
export interface PointerSample {
  x: number;
  y: number;
  pressure: number;
}

/**
 * What the engine reports about the physical pointer behind a gesture.
 * `crosshair:move`, `click`, `drag:start`, `drag` and `drag:end` all carry these keys.
 */
export interface PointerInfo {
  modifiers: PointerModifiers;
  pointerType: PointerKind;
  pressure: number;
}

/**
 * Payload of the `click` event (`chart.on('click', ...)`). Its `pressure` is
 * the pressure at the press, not the release, which always reads 0.
 */
export interface ChartClickEvent extends PointerInfo {
  /** `externalId` of the hit primitive, or null on empty plot. */
  id: string | null;
  /** Price under the press on that pane, or null off the plot. */
  price: number | null;
  /** UTC seconds under the press, interpolated between bars and past the right edge. */
  time: number;
  paneIndex: number;
  /** Press position: container media x, pane-local media y. */
  point: { x: number; y: number };
  /** Set on the release half of a press-drag-release while a host is placing a shape. */
  viaDrag?: boolean;
  /**
   * Shift at the click: the same state as `modifiers.shift`, in the flat form
   * the first click payloads carried.
   *
   * @deprecated Removed in 3.0.0. Read `modifiers.shift` (since 2.0.0), which carries the same state.
   */
  shiftKey: boolean;
  /** @deprecated Removed in 3.0.0. Read `modifiers.ctrl` (since 2.0.0), which carries the same state. */
  ctrlKey: boolean;
  /** @deprecated Removed in 3.0.0. Read `modifiers.meta` (since 2.0.0), which carries the same state. */
  metaKey: boolean;
}

/** An event-strip click, including every member of a clustered marker. */
export interface ChartEventClick extends EventMarkerDetails {
  /** Chart-container CSS pixels, including the vertical offset of an event pane. */
  point: { x: number; y: number };
  paneIndex: number;
}

/** Payload of the `drag` event: a draggable primitive being moved. */
export interface ChartDragEvent extends PointerInfo {
  id: string;
  price: number;
  time: number;
  paneIndex: number;
  /** Where the gesture was grabbed, so a delta starts at the press rather than the first move. */
  fromPrice: number;
  fromTime: number;
  /** Current pointer position: container media x, pane-local media y. */
  point: { x: number; y: number };
  /**
   * Every position the pointer passed through since the previous `drag`,
   * oldest first, the last one at `point`. Browsers deliver moves at frame
   * rate and fold the positions between frames into the event; a freehand
   * stroke drawn from `point` alone is a polyline of frame-rate corners.
   */
  samples: PointerSample[];
}

/** Payload of `drag:start` (press) and `drag:end` (release) for a primitive drag. */
export interface ChartDragEndEvent extends PointerInfo {
  id: string;
  price: number;
  time: number;
  paneIndex: number;
  /** Release position: container media x, pane-local media y. */
  point: { x: number; y: number };
}

/**
 * The slice of a pointer event the payload builders read. Structural so the
 * same builders serve a coalesced sample, and so a field a browser omits
 * degrades to the spec fallback instead of an `undefined` in a host's hands.
 */
type PointerLike = Partial<Pick<PointerEvent,
  'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'pointerType' | 'pressure' | 'buttons'>>;

/** The three pointer facts every gesture payload carries. */
function pointerInfo(e: PointerLike): PointerInfo {
  const kind = e.pointerType;
  return {
    modifiers: { shift: e.shiftKey === true, alt: e.altKey === true, ctrl: e.ctrlKey === true, meta: e.metaKey === true },
    pointerType: kind === 'touch' || kind === 'pen' ? kind : 'mouse',
    pressure: pointerPressure(e),
  };
}

/**
 * Pressure as the pointer events spec defines it: what the hardware measured,
 * else 0.5 while a button is held and 0 otherwise. Browsers already report
 * that stand-in for a mouse; the fallback covers an event that omits the
 * field, so a host never reads `undefined` or a value outside 0..1.
 */
function pointerPressure(e: PointerLike): number {
  const p = e.pressure;
  if (typeof p === 'number' && Number.isFinite(p)) return Math.min(1, Math.max(0, p));
  return (e.buttons ?? 0) !== 0 ? 0.5 : 0;
}

/**
 * What the pointer was over when the context menu was raised. The chart cannot
 * know which menu items an app wants, but it does know what was hit, which is
 * the part an app cannot work out for itself: a canvas gives it a pixel, not an
 * object. `primitive` is anything hit-testable that is not one of the named
 * kinds (a price line, an order pill, a marker).
 */
export type ContextMenuTargetKind =
  | 'drawing' | 'indicator' | 'legend' | 'primitive' | 'series' | 'price-scale' | 'time-scale' | 'empty';

export interface ContextMenuTarget {
  kind: ContextMenuTargetKind;
  /** Hit-test id of the thing under the pointer, when there was one. */
  id: string | null;
  /** Indicator instance id, when `kind` is 'indicator'. */
  instanceId?: string;
  /** Exact plot key when a study's plotted series was hit rather than its legend. */
  plotKey?: string;
  /** Series type, when `kind` is 'series'. */
  seriesType?: SeriesType;
  /** Which axis strip was hit, when `kind` is 'price-scale'. */
  side?: 'right' | 'left';
  /**
   * Which of the pane's scales that strip acts on, when `kind` is
   * 'price-scale': the side's own scale, or the hidden overlay scale ('') when
   * the side carries no series of its own and the pane's values are all on the
   * overlay. It is the argument the `priceAxis*` calls take.
   */
  scaleId?: PriceScaleId;
}

/** The four price-scale modes, in the order a menu lists them. */
export const PRICE_SCALE_MODES: readonly PriceScaleMode[] =
  ['linear', 'logarithmic', 'percentage', 'indexed-to-100'];

/**
 * What a host needs to render a menu over one price axis: which items are on,
 * and which of them mean anything on this axis. See `Chart.priceAxisState`.
 */
export interface PriceAxisState {
  paneIndex: number;
  scaleId: PriceScaleId;
  /** Current visible side; hidden scales report 'right'. Read priceAxisPlacement for hidden state. */
  side: 'right' | 'left';
  /** Some series on the pane maps to this scale. */
  active: boolean;
  /** Auto-fit: the range tracks the data rather than staying where it was put. */
  autoFit: boolean;
  inverted: boolean;
  mode: PriceScaleMode;
  /** False while the scale still sits on its 0..1 placeholder (nothing measured). */
  scaled: boolean;
  lockRatio: boolean;
  /**
   * Whether `movePriceAxis` would do anything: something to move, and a free side.
   *
   * @deprecated Removed in 3.0.0, with {@link Chart.movePriceAxis}, the only operation it describes. Placement
   * through {@link Chart.setPriceAxisPlacement} (since 2.5.4) needs no such check.
   */
  movable: boolean;
}

/**
 * The setters that change what `getState` saves without an event of their
 * own, and so announce it with `layout:change`.
 */
export type LayoutSetter =
  | 'setPaneWeight' | 'setPriceAxisOptions' | 'setPriceAxisAutoFit' | 'setPriceAxisLockRatio'
  | 'setPriceScaleOptions' | 'setAutoScale' | 'setGridOptions' | 'setCanvasOptions' | 'setStatusLineOptions'
  | 'setWatermarkOptions' | 'setTradingSettings' | 'setAxisChromeOptions' | 'setEventOptions' | 'applyOptions';

/**
 * Payload of the `layout:change` event (`chart.on('layout:change', ...)`):
 * a setter in {@link LayoutSetter} has run and the saved layout may differ.
 * It fires once per outermost call, after the change is applied: the canvas
 * block setting the grid on its way is one event, named `setCanvasOptions`.
 * A call that names no pane or scale the chart has changes nothing and fires
 * nothing, and neither does a restore, which announces itself with
 * `state:restore:start` and `state:restore:end`. Compare what you read back
 * if a no-op matters: setting a value to what it already was still fires.
 */
export interface LayoutChangeEvent {
  setter: LayoutSetter;
}

/** Payload of the `contextmenu` event (`chart.on('contextmenu', ...)`). */
export interface ContextMenuEvent {
  paneIndex: number;
  /** Cursor position in container media px, for placing the menu. */
  point: { x: number; y: number };
  /** Price under the pointer on that pane, or null off the plot. */
  price: number | null;
  /** UTC seconds under the pointer, or null when there is no data. */
  time: number | null;
  /** Logical bar index under the pointer, or null off the plot. */
  index: number | null;
  target: ContextMenuTarget;
  /** Suppress the browser's own menu. Call it to show your own. */
  preventDefault(): void;
}

/**
 * Payload of the 'renderer:fallback' event: the chart has moved every pane
 * from a GPU backend to `canvas2d` for the rest of the session, because the
 * device's context was lost or turned out unusable. The frame that noticed
 * was already painted through 2D by the backend itself, so nothing went
 * blank; this is the host's cue to update anything that shows the renderer.
 */
export interface RendererFallbackEvent {
  from: RenderBackendKind;
  to: 'canvas2d';
  reason: RendererFallbackReason;
}

function defaultPixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

/**
 * The frame scheduler for the chart's own one-shot callbacks, resolved the same
 * way `RenderLoop` resolves its painting one. It has to be the injected
 * scheduler wherever a host supplies one: a test that drives frames by hand
 * would otherwise be waiting on a browser rAF that never comes.
 */
function resolveRaf(
  opts?: { schedule: RafScheduler; cancel?: RafCanceller },
): { schedule: RafScheduler; cancel: RafCanceller } {
  if (opts) return { schedule: opts.schedule, cancel: opts.cancel ?? ((): void => {}) };
  if (typeof requestAnimationFrame === 'function') {
    return { schedule: (cb) => requestAnimationFrame(cb), cancel: (h) => cancelAnimationFrame(h) };
  }
  return { schedule: (cb) => setTimeout(cb, 16) as unknown as number, cancel: (h) => clearTimeout(h) };
}

/**
 * Decimals a pane that does not quote the instrument prints at least.
 *
 * Two, the same floor the percent-rebase branch of `PriceScale.precision`
 * settles on, and for the same reason: a reading a trader compares against a
 * level has to survive the comparison. It applies to every study on a pane of
 * its own, a host's own registered descriptor included, because it is keyed on
 * the pane rather than on anything the descriptor declares.
 */
const NON_INSTRUMENT_PRECISION = 2;

export class Chart {
  private readonly _container: HTMLElement;
  private readonly _doc: Document;
  private readonly _pixelRatio: () => number;
  private _theme: ChartTheme;
  private readonly _panes: Pane[] = [];
  /**
   * The primary price pane, held by identity. It is the pane the chart is
   * built with, and it can sit in any slot: `_panes` is the visual order, so
   * "the price pane" is wherever this is, never simply slot 0. See
   * `primaryPaneIndex`.
   */
  private _primaryPane!: Pane;
  private readonly _loop: RenderLoop;
  /** The frame scheduler, kept for the one-shot re-measure after construction. */
  private readonly _raf: { schedule: RafScheduler; cancel: RafCanceller };
  private _remeasureHandle: number | null = null;
  private readonly _dataLayer = new DataLayer();
  private readonly _timeScale: TimeScale;
  private _timeScaleMutationDepth = 0;
  private readonly _priceAxisWidth: number;
  private readonly _timeAxisHeight: number;
  private _pending: InvalidateMask | null = null;
  private _scaleMutationDepth = 0;
  private _resizeObserver: ResizeObserver | null = null;
  /** Watches the canvases' device-pixel boxes, where the browser reports them. */
  private _deviceObserver: ResizeObserver | null = null;
  /** Matches the device pixel ratio the canvases were last sized at; made again on every change. */
  private _ratioQuery: MediaQueryList | null = null;
  /** The window whose `resize` also re-checks the ratio. */
  private _ratioView: Window | null = null;
  /** The device pixel ratio the canvases were last sized at. */
  private _layoutRatio = 0;
  private _width = 0;
  private _height = 0;
  private _hasFitContent = false;
  /** Layout setters running inside another one, or inside a restore: only the outermost announces. */
  private _layoutDepth = 0;

  // interaction state
  private _crosshairMode: CrosshairMode;
  private _crosshairSnapToBar: boolean;
  private _priceOnlyAutoScale: boolean;
  private _indicatorLegendCollapsed: boolean;
  private _shortcuts: ShortcutManager | null = null;
  private _trading: TradingController | null = null;
  private _tickSchedule: TickSchedule | null = null;
  private _pointerInside = false;
  private _keyTarget: HTMLElement | Document | null = null;
  private readonly _now: () => number;
  private readonly _conflate: boolean;
  private readonly _conflationFactor: number;
  /**
   * One backend per pane; see `ChartOptions.renderer` and `renderBackend`.
   * Replaced by the 2D factory after a session fallback, so a pane added
   * later matches the ones already on screen.
   */
  private _backendFactory: RenderBackendFactory;
  /**
   * The kind the first pane got. A factory may decline per pane, so this is
   * what the chart actually paints with rather than what was asked for.
   */
  private _rendererKind: RenderBackendKind | null = null;
  /** What the `renderer` option asked for, so a decline can be reported once. */
  private readonly _requestedRenderer: RendererChoice | null;
  private _gridVert = true;
  private _gridHorz = true;
  /** The Canvas option block: overrides of the theme, never a copy of it. */
  private readonly _canvas: CanvasOptions = {};
  /** Status-line switches pushed onto every pane legend, host-added ones included. */
  private readonly _statusLine: LegendStatusLineOptions = {};
  /** Legend action-button side in media px; undefined leaves the primitive's default. */
  private _legendIconSize: number | undefined;
  /** Axis-strip chrome switches. Empty is the shipped chart: neither drawn. */
  // Both switches explicitly off rather than absent: "off" is the shipped
  // default and a state capture should say so, so that turning one on and off
  // again lands back on the state that was saved before it was ever touched.
  private readonly _axisChrome: AxisChromeOptions = { sessionClock: false, barCountdown: false };
  /**
   * The corner clock's object form, kept across an off/on toggle. A switch that
   * turns the clock off must not also throw away the `showOffset` a host chose
   * for it: switching it back on would silently be a different clock, and
   * nothing on the switch could put the choice back.
   */
  private _sessionClockForm: { showOffset?: boolean } | null = null;
  /** Wall-clock UTC seconds for the two axis readings, injectable for tests. */
  private _wallClock: () => number = () => Date.now() / 1000;
  /**
   * Trade-layer colours held here rather than on the controller, so reading or
   * setting them never has to instantiate one. `chart.trading` hands them over
   * when the controller is finally created.
   */
  private readonly _tradingSettings: TradingSettings = {};
  /** Chart-owned event strip (see `setEvents`), plus which types it draws. */
  private _events: readonly ChartEvent[] = [];
  private _eventMarkers: EventMarkers | null = null;
  private _eventPane = 0;
  private readonly _eventVisible: ChartEventOptions = {};
  private _cursorPane: number | null = null;
  private _cursor: { x: number; y: number } | null = null;
  private _dragging = false;
  private readonly _navigation: ChartNavigationOptions = { mousePan: 'both', defaultVisibleBars: 0, panEnabled: true, zoomEnabled: true };
  /** A cancelled navigation sequence stays consumed until every held pointer ends. */
  private _navigationCancelled = false;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _lastDragY = 0;
  // multi-touch: active pointers + current pinch gesture
  /** Pointers whose gesture the missed-release recovery already ended. */
  private readonly _endedPointers = new Set<number>();
  private readonly _pointers = new Map<number, { x: number; y: number; pane: number }>();
  private _pinch: PinchState | null = null;
  private _pinchPane = 0;
  private _liveRegion: HTMLElement | null = null;
  private _dragStartOffset = 0;
  private _lastDragX = 0;
  private _lastDragT = 0;
  private _dragVelocity = 0;
  private _kineticHandle: number | null = null;
  private _kineticEpoch = 0;
  private _zoomHandle: number | null = null;
  /** The glide in flight, so a second wheel tick folds into it (see ZoomGlide.add). */
  private _zoomGlide: ZoomGlide | null = null;
  private _zoomGlideStart = 0;
  private _zoomGlideApplied = 0;
  private readonly _animZoom: boolean;
  private readonly _animAutoscale: boolean;
  private _autoscaleTime: number | null = null;
  private _autoscaleFrames = 0;
  private _navigationEpoch = 0;
  private readonly _zoomAnchor: ZoomAnchor;
  private readonly _doubleClick: DoubleClickAction;
  /** `movablePrimaryPane`: without it the price pane stays pinned at slot 0. */
  private readonly _movablePrimaryPane: boolean;
  private readonly _firstDataId: { value: number | null } = { value: null };
  /** Handle + record of the primary price series (see `primarySeries`). */
  private _primary: { api: SeriesApi; record: SeriesRecord } | null = null;
  private readonly _seriesRecords = new WeakMap<SeriesApi, SeriesRecord>();
  private readonly _seriesProvenance = new Map<number, SeriesProvenance>();
  private readonly _indicators: IndicatorInstance[] = [];
  /**
   * Where the price source sits among the studies of its pane: undefined until
   * something places it (the source then stays where it was added, as it
   * always did), null at the back of the series band, or the instance id of
   * the study it paints directly above.
   */
  private _sourceAbove: string | null | undefined = undefined;
  /**
   * Each study legend row's own buttons, before its study's policy withholds
   * any, and the list the chart last gave the row. A row showing any other
   * list was set by the host since, and that list becomes its own.
   */
  private readonly _legendActions = new WeakMap<PaneLegend, [own: readonly PaneLegendAction[], shown: readonly PaneLegendAction[] | undefined]>();
  private _restoreGeneration = 0;
  private readonly _indicatorRanges = new Map<string, {
    pane: Pane; scaleId: PriceScaleId; range: { min: number; max: number };
    series: readonly SeriesApi[]; token: object;
  }>();
  private readonly _ownedScaleRanges = new Map<PriceScale, object>();
  private readonly _seriesOwners = new WeakMap<SeriesApi, {
    pane: Pane; priceFormat?: AddSeriesOptions['priceFormat']; inheritedStyle: Partial<SeriesStyle>; indicatorOwned: boolean;
  }>();
  private _dataContext: Readonly<ChartDataContext> | undefined;
  private _barsProvider: IndicatorBarsProvider | IndicatorBarsProviderAccess | null = null;
  private _barsRequests = new AbortController();
  private _barsProviderRevision = 0;
  private _requestedDataRevision = 0;
  /** Guards indicator recompute against re-entry via its own `series.setData`. */
  private _recomputing = false;
  private _indicatorsDirty = false;
  private readonly _indicatorRefreshes = new Map<string, boolean>();
  private _indicatorWork: Map<string, boolean> | null = null;
  private _indicatorProcessed: Set<string> | null = null;
  private readonly _indicatorReservedIds = new Set<string>();
  /** Instance id of the indicator whose colours are on the price bars, if any. */
  private _barColorOwner: string | null = null;
  private _barColors: readonly (string | null)[] | null = null;
  /**
   * Each price bar's own colour, indexed like the series. The overlay overwrites
   * `Bar.color`, so a bar's own value is only readable the first time we touch
   * it, and removing the indicator has to put something back.
   */
  private readonly _barColorBase: (string | undefined)[] = [];
  /** Time of bar 0 when the snapshot was taken, to catch a replaced history. */
  private _barColorAnchor = 0;
  /** Opaque drawing-tier payload, round-tripped through get/restoreState. */
  private _drawingState: unknown = undefined;
  private _alertState: AlertsDocument | undefined;
  /** Pane currently maximized, and the weights to restore when it un-maximizes. */
  private _maximizedPane: number | null = null;
  /**
   * Panes folded to a header strip. Held by pane identity, like `_pricePanes`,
   * so the fold follows its pane through a move or a removal above it without
   * any index to patch.
   */
  private readonly _collapsed = new WeakSet<Pane>();
  /** Legend rows per pane, so new ones stack below existing ones. */
  private readonly _legends: { legend: PaneLegend; paneIndex: number }[] = [];
  private readonly _studyLegends = new Set<PaneLegend>();
  private _indicatorLegendToggle: IndicatorLegendToggle | null = null;
  private _indicatorLegendRow = 0;
  private _indicatorTogglePress: { pointerId: number; moved: boolean } | null = null;
  /** Native double clicks can join a consumed count press to a newly empty plot row. */
  private _lastPressOnIndicatorToggle = false;
  private _previousPressOnIndicatorToggle = false;
  /**
   * Pane holding the primary price series (only this pane gets magnet
   * snapping). By identity, for the reason `_primaryPane` is: a move changes
   * its slot and nothing else about it.
   */
  private _firstPane: Pane | null = null;
  private _historyLoader: (() => void) | null = null;
  private _loadingHistory = false;
  private _clickCb: ((externalId: string) => void) | null = null;
  private _crosshairCb: ((e: CrosshairMoveEvent) => void) | null = null;
  private _readoutTime: number | null = null;
  private _pointerMoved = false;
  /** While true, pointer gestures place anchors instead of panning. */
  private _placementMode = false;
  /** Where indicator legend rows start inside a pane (see `legendOffset`). */
  private readonly _legendOffset: { top: number; left: number } = { top: 6, left: 8 };
  private _downPane = 0;
  private _downX = 0;
  private _downLocalY = 0;
  /** Pressure at the press; a click reports this, since its release always reads 0. */
  private _downPressure = 0;
  private _dragId: string | null = null; // externalId of the primitive being dragged
  private _dragPriceScale: PriceScale | null = null;
  private _dragCancelOnEscape = false;
  private _hoverId: string | null = null; // externalId of the primitive under the pointer
  private _hoverKey: string | null = null;
  /** Whether that primitive draws below the overlay, so leaving it must repaint the base. */
  private _hoverOnBase = false;
  private _overlayFrozen = false; // native context menu open: keep the save-image snapshot
  private _dragCb: ((externalId: string, price: number, time: number) => void) | null = null;
  private _dragEndCb: ((externalId: string, price: number, time: number) => void) | null = null;
  // axis-drag rescale (price axis = vertical, time axis = horizontal)
  private _axisDrag: 'price' | 'time' | 'empty' | null = null;
  /** The scale a price-axis drag is rescaling: either side's, whichever strip was grabbed. */
  private _axisDragScale: PriceScale | null = null;
  /** Active pane-divider drag: which boundary, and the weights/heights at grab time. */
  /** True once a primitive drag has actually moved — see the pointerup note. */
  private _dragMoved = false;
  /** Where the drag was grabbed, in data space, so deltas start at the press. */
  private _dragFrom: { time: number; price: number } = { time: 0, price: 0 };
  private _paneResize: {
    a: number; b: number; startY: number;
    aWeight: number; bWeight: number; aHeight: number; bHeight: number;
  } | null = null;
  private _axisStartCoord = 0;
  private _axisStartMin = 0;
  private _axisStartMax = 0;
  private _axisStartSpacing = 0;
  private _priceFormatter: ((price: number) => string) | null = null;
  private _priceScaleOptions: Partial<PriceScaleOptions> | null = null;
  /**
   * The panes whose numbers are the instrument's price, which is what decides
   * whether a chart-wide `minMove` reaches them (see `_scalePatchFor`).
   *
   * Held by pane identity rather than by index, for the reason spelled out in
   * `_createSeries`: `removePane` splices the array and `movePane` swaps two
   * entries, so a pane's slot number is not the pane. Weak because a removed
   * pane is destroyed and nothing else keeps it alive.
   */
  private readonly _pricePanes = new WeakSet<Pane>();
  private _timeFormatter: ((utcSeconds: number, tickMark?: TickMarkType) => string) | undefined = undefined;
  private _timezone: string = DEFAULT_TIMEZONE;
  private _leftAxisWidth = 0; // chart-wide reserved left-axis column (0 = none)
  private _rightAxisWidth = 0; // chart-wide reserved right-axis column (0 = none)
  private _axisColumnWidth = 0;
  private _emptyPriceAxis = true;
  private _timeNav: TimeNavigator | null = null;
  private _timeNavButtons: TimeNavigatorOptions['buttons'] = [];
  private _schedulingTimeNav = false;
  /** Pane the navigator is currently attached to, so it can follow the bottom. */
  private _timeNavPane = -1;
  private _branding: LogoWatermark | null = null;
  private _brandingOptions: false | LogoWatermarkOptions = false;
  private _brandingPress: { pointerId: number; mark: LogoWatermark; moved: boolean } | null = null;
  private _watermark: TextWatermark | null = null;
  private _watermarkOptions: ChartWatermarkOptions = {
    visible: false, text: '', color: '#9aa4b2', opacity: 0.08, fontSize: 64,
  };

  public constructor(container: HTMLElement, options: ChartOptions = {}) {
    this._timeScale = new TimeScale(options.timeScale);
    this._container = container;
    this._doc = options.document ?? container.ownerDocument;
    this._pixelRatio = options.pixelRatio ?? defaultPixelRatio;
    this._theme = options.theme ?? DEFAULT_THEME;
    this._priceAxisWidth = options.priceAxisWidth ?? 56;
    this._rightAxisWidth = this._priceAxisWidth; // the right axis is the default one

    if (options.legendOffset?.top !== undefined) this._legendOffset.top = options.legendOffset.top;
    if (options.legendOffset?.left !== undefined) this._legendOffset.left = options.legendOffset.left;
    this._timeAxisHeight = options.timeAxisHeight ?? 22;
    this._crosshairMode = options.crosshairMode ?? 'normal';
    this._crosshairSnapToBar = options.crosshairSnapToBar === true;
    this._priceOnlyAutoScale = options.priceOnlyAutoScale === true;
    this._indicatorLegendCollapsed = options.indicatorLegendCollapsed === true;
    // Assigned rather than pushed through `setAxisChromeOptions`: the setter
    // asks for a repaint, and the render loop does not exist yet.
    Object.assign(this._axisChrome, options.axisChrome);
    if (typeof options.axisChrome?.sessionClock === 'object') {
      this._sessionClockForm = { ...options.axisChrome.sessionClock };
    }
    if (options.axisChrome?.clock !== undefined) this._wallClock = options.axisChrome.clock;
    const sc = options.shortcuts;
    this._shortcuts = sc === false ? null : (sc instanceof ShortcutManager ? sc : new ShortcutManager(sc ?? {}));
    this._now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : 0));
    this._animZoom = options.animZoom ?? true;
    this._barsProvider = options.barsProvider ?? null;
    this._animAutoscale = options.animAutoscale ?? this._animZoom;
    this._zoomAnchor = options.zoomAnchor ?? 'cursor';
    this._doubleClick = options.doubleClick ?? 'reset';
    this._movablePrimaryPane = options.movablePrimaryPane === true;
    this._conflate = options.conflate ?? false;
    this._conflationFactor = options.conflationFactor ?? 1;
    // Resolved here, before the first pane, so an unregistered explicit choice
    // fails at construction rather than on the first frame.
    this._backendFactory = options.renderBackend ?? resolveRenderBackend(options.renderer ?? 'canvas2d');
    this._requestedRenderer = options.renderBackend === undefined ? (options.renderer ?? 'canvas2d') : null;
    this._priceFormatter = options.priceFormatter ?? null;
    this._priceScaleOptions = options.priceScale ?? null;
    this._timeFormatter = options.timeFormatter;
    // Assigned rather than routed through `setTimezone`: the render loop does
    // not exist yet, and there is nothing painted to invalidate.
    if (options.timezone !== undefined) this._timezone = checkedTimezone(options.timezone);
    this._gridVert = options.grid?.vertLines ?? true;
    this._gridHorz = options.grid?.horzLines ?? true;
    Object.assign(this._canvas, options.canvas);
    if (options.grid) this._canvas.grid = { ...this._canvas.grid, ...options.grid };
    Object.assign(this._statusLine, options.statusLine);
    if (typeof options.legendIconSize === 'number' && Number.isFinite(options.legendIconSize)) this._legendIconSize = options.legendIconSize;
    // Margins are the price scale's own state in fraction units; the canvas
    // block only carries the dialog's percentages. Fold them in before the
    // first pane exists, so `_addPane` applies both together.
    const margins = resolvePlotMargins(this._canvas.margins);
    if (margins.marginTop !== undefined || margins.marginBottom !== undefined) {
      this._priceScaleOptions = { ...this._priceScaleOptions, ...margins };
    }
    this._patchNavigation(options.navigation ?? {});
    const nav = options.timeNavigator ?? true;
    if (nav !== false) {
      this._timeNav = new TimeNavigator(
        { ...(nav === true ? {} : nav), hints: this._navHints(nav === true ? undefined : nav) },
        this._now,
      );
      this._timeNavButtons = [...this._timeNav.options().buttons];
      this._syncNavigatorPolicy();
    }

    // Respect a position set via CSS (absolute/relative/fixed); only force
    // 'relative' when the container is statically positioned. Reading
    // container.style.position alone misses stylesheet rules and would wrongly
    // override an `position: absolute` set in CSS, collapsing the container.
    const computedPos = typeof getComputedStyle === 'function'
      ? getComputedStyle(container).position
      : container.style.position;
    if (!computedPos || computedPos === 'static') container.style.position = 'relative';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.background = this._theme.background;
    // Touch: let the chart own pan/pinch gestures instead of the browser scrolling/zooming.
    container.style.touchAction = 'none';

    // Accessibility: a focusable, labelled region with a polite live summary so the
    // canvas (which screen readers can't introspect) is at least navigable + announced.
    if (!container.getAttribute('role')) container.setAttribute('role', 'application');
    container.setAttribute('aria-label', options.ariaLabel ?? 'Interactive financial chart');
    if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
    const live = this._doc.createElement('div');
    live.setAttribute('aria-live', 'polite');
    const s = live.style;
    s.position = 'absolute'; s.width = '1px'; s.height = '1px'; s.overflow = 'hidden';
    s.clip = 'rect(0 0 0 0)'; s.whiteSpace = 'nowrap'; s.border = '0'; s.padding = '0'; s.margin = '-1px';
    container.appendChild(live);
    this._liveRegion = live;

    this._raf = resolveRaf(options.raf);
    this._loop = new RenderLoop(() => this._onFrame(), this._raf.schedule, this._raf.cancel);

    this._addPane();
    this.setBranding(options.branding ?? true);
    this.setWatermarkOptions(options.watermark ?? false);
    this._observeSize();
    this._watchPixelRatio();
    this._attachInput();
    // Direct navigation shares the chart's events; internal gestures and data
    // updates already own their repaint, animation and notification boundaries.
    this._timeScale.setChangeHandler((before) => {
      if (this._timeScaleMutationDepth > 0 || this._destroyed) return;
      this._stopNavigationMotion();
      const after = this._timeScale.visibleRange();
      if (after.from === before.from && after.to === before.to) return;
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      this._emitViewportIfMoved(before);
    });
    this.applySize(container.clientWidth, container.clientHeight);
    this._remeasureHandle = this._raf.schedule(() => {
      this._remeasureHandle = null;
      this._remeasure();
    });
    // 'ready' fires on a microtask so `createChart(el).on('ready', ...)` — a
    // subscription registered on the very next line — still receives it.
    if (typeof queueMicrotask === 'function') queueMicrotask(() => this.emit('ready', {}));
  }

  /** Register a callback fired when the user pans near the left (oldest) edge. */
  public setHistoryLoader(loader: () => void): void {
    this._historyLoader = loader;
  }

  /** Call after a history-paging load resolves to re-enable the trigger. */
  public historyLoadComplete(): void {
    this._loadingHistory = false;
  }

  public get dataLayer(): DataLayer {
    return this._dataLayer;
  }

  /**
   * Lay the time axis past the last bar out in these trading hours, or drop
   * them with null, and repaint every pane, so a drawing already placed past
   * the last bar moves to the time it now means.
   *
   * This is the call for a host setting hours on its own: a `SessionCalendar`
   * or an `Instrument` it holds, or any object with `sessionFrom`.
   * `Instrument.applyTo` and `SessionCalendar.applyTo` come here too.
   * `chart.dataLayer.setSessionCalendar` sets the same hours and asks for no
   * frame, for a host about to load bars or move the view anyway, either of
   * which repaints.
   */
  public setSessionCalendar(calendar: SessionCalendarSource | null): void {
    if (this._destroyed) return;
    this._dataLayer.setSessionCalendar(calendar);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /** Readonly source bars, without allocating a history copy on each live update. */
  public primaryBars(): readonly Bar[] {
    const id = this._firstDataId.value;
    return id === null ? [] : this._dataLayer.seriesBars(id);
  }

  public get timeScale(): TimeScale {
    return this._timeScale;
  }

  /** Restore a saved logical range (e.g. preserve the user's zoom across a data reload). */
  public setVisibleLogicalRange(range: LogicalRange): void {
    this._stopNavigationMotion();
    this._timeScale.setVisibleLogicalRange(range);
  }

  /** The current visible logical range. */
  public getVisibleLogicalRange(): LogicalRange {
    return this._timeScale.visibleRange();
  }

  /** Fit all bars into view (no-arg convenience; bar count from the data). */
  public fitContent(): void {
    this._stopNavigationMotion();
    if (this._dataLayer.length <= 0) return;
    this._timeScale.fitContent(this._dataLayer.length);
  }

  /** Current navigation preferences, safe to save as JSON. */
  public navigationOptions(): Readonly<ChartNavigationOptions> {
    return { ...this._navigation };
  }

  /** A new default count or spacing immediately restores that view without dropping history. */
  public setNavigationOptions(patch: Partial<ChartNavigationOptions>): void {
    const before = this._navigation.defaultVisibleBars;
    const spacing = this._navigation.defaultBarSpacing;
    const pan = this._navigation.panEnabled, zoom = this._navigation.zoomEnabled;
    this._patchNavigation(patch);
    if (before !== this._navigation.defaultVisibleBars || spacing !== this._navigation.defaultBarSpacing) this.resetScale();
    if (pan !== this._navigation.panEnabled || zoom !== this._navigation.zoomEnabled) this.emit('objects:change', undefined);
  }

  private _patchNavigation(patch: Partial<ChartNavigationOptions>): void {
    const wasPan = this._navigation.panEnabled, wasZoom = this._navigation.zoomEnabled;
    for (const key of ['panEnabled', 'zoomEnabled'] as const) {
      const field = Object.getOwnPropertyDescriptor(patch, key);
      if (field && 'value' in field && typeof field.value === 'boolean') this._navigation[key] = field.value;
    }
    const stopPan = wasPan !== false && this._navigation.panEnabled === false;
    const stopZoom = wasZoom !== false && this._navigation.zoomEnabled === false;
    if (stopPan || stopZoom) {
      if (stopZoom) this._navigationEpoch++;
      if (stopPan) this._stopKinetic();
      if (stopZoom) this._stopZoomGlide();
      this._autoscaleTime = null;
      if (this._pinch !== null || (stopPan && this._dragging)
        || (stopZoom && (this._axisDrag === 'price' || this._axisDrag === 'time'))) {
        this._navigationCancelled = true;
        this._dragging = false;
        this._axisDrag = null;
        this._axisDragScale = null;
        this._pinch = null;
        this._pointerMoved = true;
        this._dragVelocity = 0;
        this._setHover(null);
      }
    }
    if (wasPan !== this._navigation.panEnabled || wasZoom !== this._navigation.zoomEnabled) this._syncNavigatorPolicy();
    if (patch.mousePan === 'horizontal' || patch.mousePan === 'both') this._navigation.mousePan = patch.mousePan;
    const count = patch.defaultVisibleBars;
    // Saved layouts are untrusted input. Invalid values must not poison spacing.
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      this._navigation.defaultVisibleBars = Math.min(100000, Math.floor(count));
      // An explicit count edit selects count mode. A complete saved preference
      // can carry both fields, in which case its spacing still takes precedence.
      if (patch.defaultBarSpacing === undefined) delete this._navigation.defaultBarSpacing;
    }
    const spacing = patch.defaultBarSpacing;
    if (typeof spacing === 'number' && Number.isFinite(spacing) && spacing >= 0) {
      if (spacing === 0) delete this._navigation.defaultBarSpacing;
      else this._navigation.defaultBarSpacing = spacing;
    }
  }

  private _navigationAllowed(command: string): boolean {
    switch (command) {
      case 'panLeftBar': case 'panRightBar': case 'panLeft': case 'panRight':
      case 'panLeftFast': case 'panRightFast': case 'panUp': case 'panDown':
        return this._navigation.panEnabled !== false;
      case 'zoomIn': case 'zoomOut': case 'resetScale': case 'fitContent':
        return this._navigation.zoomEnabled !== false;
      default: return true;
    }
  }

  private _syncNavigatorPolicy(): void {
    if (this._timeNav === null) return;
    if (this._timeNavButtons.every(action => action === null || this._navigationAllowed(action))) {
      this._timeNav.setOptions({ buttons: [...this._timeNavButtons] });
      return;
    }
    const buttons: (TimeNavigatorOptions['buttons'][number])[] = [];
    let gap = false;
    for (const action of this._timeNavButtons) {
      if (action === null) { gap = true; continue; }
      if (!this._navigationAllowed(action)) continue;
      if (gap && buttons.length > 0) buttons.push(null);
      buttons.push(action);
      gap = false;
    }
    this._timeNav.setOptions({ buttons });
  }

  private _fitDefaultView(): boolean {
    const total = this._dataLayer.length;
    if (total <= 0 || !(this._timeScale.width > 0)) return false;
    // Fit the real dataset first: baseIndex must still identify its newest bar,
    // not the last bar of the smaller requested window.
    this._mutateTimeScale(() => {
      this._timeScale.fitContent(total);
      if (this._navigation.defaultBarSpacing !== undefined) {
        this._timeScale.setBarSpacing(this._navigation.defaultBarSpacing);
      } else if (this._navigation.defaultVisibleBars > 0) {
        const count = Math.min(total, this._navigation.defaultVisibleBars);
        this._timeScale.setBarSpacing(this._timeScale.width / (count + this._timeScale.rightOffset));
      }
    });
    return true;
  }

  /** The keyboard shortcut manager (null when shortcuts are disabled). */
  public get shortcuts(): ShortcutManager | null {
    return this._shortcuts;
  }

  /**
   * The data-driven trading layer: push positions/orders/trades and the chart
   * renders pills + markers, emitting `trading:*` events on interaction. Created
   * on first access.
   */
  public get trading(): TradingController {
    if (this._trading === null) {
      this._trading = new TradingController(this);
      this._trading.setSettings(this._tradingSettings);
    }
    return this._trading;
  }

  /**
   * Whether the trade layer exists yet. Reading `chart.trading` creates one,
   * and creating one claims the click/drag subscriptions, so anything that
   * merely inspects the chart (a settings dialog) asks this first.
   */
  public hasTrading(): boolean {
    return this._trading !== null;
  }

  /**
   * Trade-layer colours, whether or not the controller has been created. Once
   * it exists it is the single answer (a host may set colours on it directly);
   * before that, the held patch is folded onto the defaults. The fold is needed
   * because the two shapes name a colour differently: the patch says
   * `longColor`, the resolved palette says `long`.
   */
  public tradingSettings(): TradingColors {
    if (this._trading !== null) return this._trading.getSettings();
    const out = { ...DEFAULT_TRADING_COLORS };
    for (const [key, value] of Object.entries(this._tradingSettings)) {
      if (typeof value === 'string') out[key.slice(0, -'Color'.length) as keyof TradingColors] = value;
    }
    return out;
  }

  /**
   * Recolour the trade layer. Safe before it exists: the patch is held and
   * handed over the moment `chart.trading` builds the controller.
   */
  public setTradingSettings(patch: TradingSettings): void {
    Object.assign(this._tradingSettings, patch);
    this._trading?.setSettings(patch);
    this._layoutChanged('setTradingSettings');
  }

  /**
   * Announce that a setter changed the saved layout, unless it ran inside
   * another one or inside a restore: the outer call is the one announced.
   */
  private _layoutChanged(setter: LayoutSetter): void {
    if (this._layoutDepth > 0 || this._destroyed) return;
    this.emit('layout:change', { setter } satisfies LayoutChangeEvent);
  }

  /** Run `fn` with the layout setters it calls counted as part of the caller's change. */
  private _withinLayoutChange<T>(fn: () => T): T {
    this._layoutDepth++;
    try { return fn(); } finally { this._layoutDepth--; }
  }

  /** Add a series and return its data handle. */
  public addSeries(type: SeriesType, options: AddSeriesOptions = {}): SeriesApi {
    return this._createSeries(type, options, true);
  }

  /** Live renderer type, or null for a foreign, removed or destroyed series handle. */
  public seriesType(series: SeriesApi): SeriesType | null {
    const record = this._seriesRecords.get(series), owner = this._seriesOwners.get(series);
    return !this._destroyed && record && owner && this._panes.includes(owner.pane) && owner.pane.series().includes(record)
      ? record.type : null;
  }

  /** Frozen style snapshot, including renderer defaults, or null for an unavailable handle. */
  public seriesStyle(series: SeriesApi): Readonly<SeriesStyle> | null {
    return this.seriesType(series) === null ? null : Object.freeze({ ...this._seriesRecords.get(series)!.style });
  }

  /**
   * Assign a host-owned series to a scale on its current pane without replacing it.
   * Both scales retain their configuration. Explicit series formatting applies to
   * the target as it does when adding a series, including a shared target scale.
   * Returns false for invalid IDs, unchanged assignments, unavailable handles or
   * indicator-owned plots, whose pane-bound visuals must move with the whole study.
   */
  public setSeriesPriceScale(series: SeriesApi, scaleId: PriceScaleId): boolean {
    if (typeof scaleId !== 'string' || (scaleId !== 'right' && scaleId !== 'left' && scaleId !== '' && !scaleId.startsWith('overlay:'))
      || this.seriesType(series) === null) return false;
    const record = this._seriesRecords.get(series)!, owner = this._seriesOwners.get(series)!;
    if (owner.indicatorOwned || record.scaleId === scaleId) return false;
    const target = owner.pane.scaleFor(scaleId);
    record.scaleId = scaleId;
    this._reconcileIndicatorRanges();
    this._applySeriesPriceFormat(target, owner.priceFormat);
    if (record.style.precision !== undefined) this._applyPrecision(target, record.style.precision);
    this._recomputeAxisColumns();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('objects:change', {});
    return true;
  }

  /**
   * Change a live series' renderer without replacing its handle, data or attachments.
   * Explicit styles survive; inherited renderer defaults give way to the new type.
   * Transform renderers expect host-prepared bars and never transform data here.
   * Returns false for an unchanged type or a foreign, removed or destroyed handle.
   * An unregistered type throws before any state changes.
   */
  public setSeriesType(series: SeriesApi, type: SeriesType): boolean {
    return this._setSeriesType(series, type, true);
  }

  private _setSeriesType(series: SeriesApi, type: SeriesType, notify: boolean): boolean {
    if (this.seriesType(series) === null) return false;
    const record = this._seriesRecords.get(series)!, owner = this._seriesOwners.get(series)!;
    const entry = getChartType(type);
    if (record.type === type) return false;
    const precision = record.style.precision;
    const style = { ...record.style };
    for (const key of Object.keys(owner.inheritedStyle) as (keyof SeriesStyle)[]) {
      if (style[key] === owner.inheritedStyle[key]) delete style[key];
    }
    const defaults: Partial<SeriesStyle> = {};
    for (const key of Object.keys(entry.defaultStyle) as (keyof SeriesStyle)[]) {
      if (!Object.prototype.hasOwnProperty.call(style, key)) Object.assign(defaults, { [key]: entry.defaultStyle[key] });
    }
    for (const key of Object.keys(record.style) as (keyof SeriesStyle)[]) delete record.style[key];
    Object.assign(record.style, defaults, style);
    owner.inheritedStyle = defaults;
    record.type = type;
    if (record.style.precision !== precision) {
      const scale = owner.pane.scaleOf(record);
      this._applyPrecision(scale, record.style.precision);
      if (record.style.precision === undefined) this._applySeriesPriceFormat(scale, owner.priceFormat);
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    if (notify) this.emit('objects:change', {});
    return true;
  }

  /**
   * `claimPrimary` is false for series the chart creates on a caller's behalf
   * (indicator plots), so an indicator's line never becomes the price series
   * that drives the magnet crosshair and the OHLC legend.
   */
  private _createSeries(type: SeriesType, options: AddSeriesOptions, claimPrimary: boolean,
    preservedFormats?: PreservedScaleFormats): SeriesApi {
    const dataId = this._dataLayer.createSeries();
    const provenance = new SeriesProvenance(dataId);
    this._seriesProvenance.set(dataId, provenance);
    const paneIndex = options.paneIndex ?? this._primaryIndex();
    this._ensurePane(paneIndex);
    const record = createSeriesRecord(dataId, type, options.style, options.priceScaleId ?? 'right');
    // A pane starts quoting the instrument the moment the host plots a price on
    // it, which is how a second symbol on a pane of its own keeps a tick-sized
    // axis. Indicator plots come through here with `claimPrimary` false, so an
    // oscillator can never promote the pane it draws in.
    if (claimPrimary && getChartType(type).isPriceSeries) this._claimPricePane(this._panes[paneIndex]);
    // The first price-type series drives the magnet crosshair + OHLC legend.
    const isPrimary = claimPrimary && this._firstDataId.value === null && getChartType(type).isPriceSeries;
    if (isPrimary) {
      this._firstDataId.value = dataId;
      this._firstPane = this._panes[paneIndex];
    }
    this._panes[paneIndex].addSeries(record);
    this._recomputeAxisColumns(); // reserve/free the axis columns
    /**
     * The pane this series lives on, held BY IDENTITY rather than by the index
     * it happened to be created at.
     *
     * `paneIndex` is a slot number, and slots are not stable. `removePane`
     * splices the array and everything below shifts up one; `movePane` swaps two
     * entries outright. A closure that captured the number therefore starts
     * pointing at a different pane, or at no pane at all, the moment either
     * happens -- and both are ordinary things to do with indicator panes.
     *
     * That was a real crash, not a theoretical one. Three sub-plot indicators on
     * panes 1, 2 and 3; remove the first and the survivors shift to 1 and 2
     * while their series still name 2 and 3; remove the last and
     * `this._panes[3]` is undefined, so `removeSeries` throws on undefined and
     * the teardown aborts half-done -- legend gone, plot still on the chart. The
     * quieter version is worse: when the stale index still lands on a pane that
     * exists, the series is removed from the WRONG pane and nothing reports it.
     *
     * Panes move around their series, so the object stays correct through both
     * operations and the index never has to be patched.
     */
    const inheritedStyle = { ...getChartType(type).defaultStyle };
    for (const key of Object.keys(options.style ?? {}) as (keyof SeriesStyle)[]) delete inheritedStyle[key];
    const owner = { pane: this._panes[paneIndex], priceFormat: options.priceFormat, inheritedStyle, indicatorOwned: !claimPrimary };
    const scale = owner.pane.scaleOf(record);
    const preserveFormat = preservedFormats?.get(owner.pane)?.has(record.scaleId) === true;
    this._applySeriesPriceFormat(scale, options.priceFormat, preserveFormat);
    if (!preserveFormat && record.style.precision !== undefined) this._applyPrecision(scale, record.style.precision);

    const api: SeriesApi = {
      setData: (bars: readonly SeriesDataItem[], metadata?: BarConfirmationOptions): void => this._setData(dataId, bars.map(toBar), metadata),
      prependData: (bars: readonly SeriesDataItem[]): void => this._prependData(dataId, bars.map(toBar)),
      update: (bar: SeriesDataItem, metadata?: SeriesUpdateOptions): void => this._updateBar(dataId, toBar(bar), metadata),
      getData: (): Bar[] => this._dataLayer.indexedBars(dataId).map((ib) => ib.bar),
      applyOptions: (patch: Partial<SeriesStyle>): void => {
        for (const key of Object.keys(patch) as (keyof SeriesStyle)[]) delete owner.inheritedStyle[key];
        Object.assign(record.style, patch);
        // Precision is a label override on the scale, not a style the renderer
        // reads, so it needs pushing across when it changes (including back to
        // "Default", which is the key present and undefined).
        if ('precision' in patch) this._applyPrecision(owner.pane.scaleOf(record), patch.precision);
        this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
        if (this._primary?.record === record) this.emit('objects:change', {});
      },
      remove: (): void => {
        const primary = this._primary?.record === record;
        owner.pane.removeSeries(record);
        this._dataLayer.removeSeries(dataId);
        this._seriesProvenance.delete(dataId);
        if (this._firstDataId.value === dataId) this._firstDataId.value = null;
        if (this._primary?.record === record) { this._primary = null; owner.pane.setSourceSeries(null); }
        if (!owner.indicatorOwned) this._reconcileIndicatorRanges();
        this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
        this._recomputeAxisColumns();
        this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
        if (primary) {
          this.emit('data:update', { kind: 'reset' });
          this.emit('objects:change', {});
        }
      },
      priceScale: (): PriceScale => owner.pane.scaleOf(record),
      createMarkers: (fallbackBars?: () => readonly Bar[]): SeriesMarkers => {
        const m = new SeriesMarkers(dataId, fallbackBars, () => owner.pane.scaleOf(record));
        // Resolved now, not at creation: primitives are addressed by slot, and
        // this series' slot may have shifted since.
        this._addPrimitive(this._panes.indexOf(owner.pane), m);
        return m;
      },
    };
    this._seriesRecords.set(api, record);
    bindSeriesProvenance(api, provenance);
    this._seriesOwners.set(api, owner);
    if (!owner.indicatorOwned) this._reconcileIndicatorRanges();
    if (isPrimary) {
      this._primary = { api, record };
      this._panes[paneIndex].setSourceSeries(record);
      // A source added after a layout placed it goes where the layout says.
      if (this._sourceAbove !== undefined) this._placeSource();
      this.emit('objects:change', {});
    }
    return api;
  }

  private _applySeriesPriceFormat(scale: PriceScale, pf: AddSeriesOptions['priceFormat'], preserveFormat = false): void {
    if (pf) {
      if (pf.type === 'custom') { if (!preserveFormat) scale.setPriceFormatter(pf.formatter); }
      else if (pf.type === 'volume') { if (!preserveFormat) scale.setPriceFormatter(compactVolume); }
      else if (pf.type === 'percent') {
        const digits = pf.precision ?? 2;
        if (!preserveFormat) scale.setPriceFormatter((v) => `${v.toFixed(digits)}%`);
      } else {
        if (!preserveFormat) scale.setPriceFormatter(this._priceFormatter);
        const minMove = pf.minMove ?? (pf.precision !== undefined ? Math.pow(10, -pf.precision) : undefined);
        if (minMove !== undefined) scale.setOptions({ minMove });
      }
    }
  }

  /**
   * The primary price series: the first one added, and the one the magnet
   * crosshair, the OHLC legend, the market-replay controller and a settings
   * dialog's Symbol tab all describe. Null until a price series exists.
   */
  public primarySeries(): SeriesApi | null {
    return this._primary?.api ?? null;
  }

  /**
   * Type and live style of the primary series, for a settings dialog: the type
   * decides which controls apply (a candle has borders, a line has a dash), and
   * the style is the object `applyOptions` patches.
   */
  public primarySeriesInfo(): { type: SeriesType; style: Readonly<SeriesStyle> } | null {
    const p = this._primary;
    return p === null ? null : { type: p.record.type, style: p.record.style };
  }

  /**
   * Push a series' `precision` override onto the price scale it maps to.
   *
   * It rides the scale's *formatter* rather than `minMove` because minMove also
   * drives `snapToTick`: precision 0 would start snapping every price to whole
   * numbers. Going through the formatter covers the axis ticks, the last-value
   * tag, the crosshair label and the drawing-tool labels at once, since they all
   * call `priceScale.format`. Clearing it restores the chart-wide formatter.
   */
  private _applyPrecision(scale: PriceScale, precision: number | undefined): void {
    if (precision === undefined || !isFinite(precision)) {
      scale.setPriceFormatter(this._priceFormatter);
      return;
    }
    const digits = clamp(Math.round(precision), 0, 8);
    scale.setPriceFormatter((v) => v.toFixed(digits));
  }

  /**
   * Add a horizontal price line (order/SL/TP/alert/level) to a pane. Omitting
   * the pane means the primary price pane, wherever it sits.
   */
  public addPriceLine(opts: PriceLineOptions, paneIndex?: number): PriceLine {
    const line = new PriceLine(opts);
    this._addPrimitive(paneIndex ?? this._primaryIndex(), line);
    return line;
  }

  /** Add an earnings/dividend/split event-marker strip to a pane, the primary price pane by default. */
  public addEventMarkers(paneIndex?: number, options: Partial<EventMarkersOptions> = {}): EventMarkers {
    const em = new EventMarkers(options);
    this._addPrimitive(paneIndex ?? this._primaryIndex(), em);
    return em;
  }

  /**
   * Hand the chart the corporate-action / news calendar and let it own the
   * strip. The difference from `addEventMarkers` is who filters: holding the
   * full list here is what lets `setEventOptions` (the settings dialog's Events
   * switches) turn a type off and back on without the host re-supplying data.
   */
  public setEvents(events: readonly ChartEvent[], paneIndex?: number): void {
    const markers = this._ensureEventMarkers();
    markers.setEvents(events);
    this._events = markers.events();
    const target = paneIndex ?? this._primaryIndex();
    if (target !== this._eventPane) {
      this.removePrimitive(markers);
      this._addPrimitive(target, markers);
    }
    this._eventPane = target;
    this._syncEvents();
  }

  /** The chart-owned strip, or null before events or strip options are supplied. */
  public eventMarkers(): EventMarkers | null { return this._eventMarkers; }

  /** Configure clustering without replacing event data or group visibility. */
  public setEventMarkerOptions(options: Partial<EventMarkersOptions>): void {
    this._ensureEventMarkers().setOptions(options);
  }

  public setEventGroups(groups: readonly EventGroup[]): void {
    this._ensureEventMarkers().setGroups(groups);
    this.emit('events:change', undefined);
  }

  public setEventGroupVisible(id: string, visible: boolean): void {
    this._ensureEventMarkers().setGroupVisible(id, visible);
    this.emit('events:change', undefined);
  }

  /** Turn event types on/off. Unlisted types stay visible. */
  public setEventOptions(patch: ChartEventOptions): void {
    Object.assign(this._eventVisible, patch);
    this._syncEvents();
    this._layoutChanged('setEventOptions');
  }

  public eventOptions(): ChartEventOptions {
    return { ...this._eventVisible };
  }

  private _ensureEventMarkers(): EventMarkers {
    if (this._eventMarkers === null) {
      this._eventMarkers = new EventMarkers();
      // A strip is born on the price pane wherever that sits; the slot a
      // previous strip was moved to means nothing once there is no strip.
      this._eventPane = this._primaryIndex();
      this._addPrimitive(this._eventPane, this._eventMarkers);
      this.on('click', payload => {
        const click = payload as ChartClickEvent;
        if (!click.id || click.viaDrag || click.paneIndex !== this._eventPane) return;
        const details = this._eventMarkers?.detailsForHit(click.id);
        if (details) this.emit('event:click', { ...details,
          point: { x: click.point.x, y: click.point.y + (this._paneLayout()[click.paneIndex]?.top ?? 0) },
          paneIndex: click.paneIndex } satisfies ChartEventClick);
      });
    }
    return this._eventMarkers;
  }

  private _syncEvents(): void {
    if (this._eventMarkers === null && this._events.length === 0) return;
    const visible = this._eventVisible as Record<string, boolean | undefined>;
    this._ensureEventMarkers().setEvents(this._events.filter((e) => visible[e.type] !== false));
    this.emit('events:change', undefined);
  }

  /**
   * Add a registered indicator. Built-in descriptors live in the lazy
   * `openalgo-charts/indicators` tier — import it (or register your own with
   * `registerIndicator`) before calling this.
   *
   * `'onchart'` indicators overlay the price pane; `'pane'` indicators get a new
   * pane of their own unless `paneIndex` says otherwise. The returned handle
   * recomputes automatically whenever the source data changes.
   *
   * ```ts
   * import 'openalgo-charts/indicators';
   * const macd = chart.addIndicator('macd', { fastPeriod: 8 });
   * macd.setSettings({ fastPeriod: 12 });
   * macd.remove();
   * ```
   *
   * `options.policy` restricts what the user may do with the study (see
   * `IndicatorPolicy`); the host keeps changing it with `{ force: true }`.
   *
   * `options.instanceId` gives the study that id instead of a new one, so a
   * host that brings a removed study back (an undo) brings back its identity:
   * the studies that read its output and the alerts that name it find it
   * again. An id a study on this chart holds now throws, since two studies
   * cannot answer to one id; the id of a removed study is free to take back.
   */
  public addIndicator(
    indicatorId: string,
    settings: Readonly<IndicatorSettings> = {},
    options: {
      paneIndex?: number; priceScaleId?: PriceScaleId; plotPriceScaleIds?: Readonly<Record<string, PriceScaleId>>;
      policy?: IndicatorPolicy; instanceId?: string;
    } = {},
  ): IndicatorApi {
    const instanceId = options.instanceId;
    if (instanceId !== undefined && (typeof instanceId !== 'string' || !instanceId.trim())) throw new TypeError('Invalid indicator instance id');
    if (instanceId !== undefined && this._indicators.some(item => item.id === instanceId)) throw new Error(`Indicator instance id already in use: ${instanceId}`);
    if (options.priceScaleId !== undefined && !this._validPriceScaleId(options.priceScaleId)) throw new TypeError('Invalid indicator price scale');
    const policy = options.policy === undefined ? undefined : parseIndicatorPolicy(options.policy);
    const descriptor = getIndicator(indicatorId);
    const validatedSettings = cloneIndicatorSettings(settings);
    validateIndicatorInputs(descriptor.inputs, validatedSettings);
    const plotPriceScaleIds = options.plotPriceScaleIds === undefined ? undefined : parseIndicatorPlotPriceScales(descriptor, options.plotPriceScaleIds);
    validateIndicatorScaleAssignment(descriptor, options.priceScaleId, plotPriceScaleIds,
      options.paneIndex ?? (descriptor.placement === 'onchart' ? this._primaryIndex() : this._panes.length), this._primaryIndex());
    this._flushIndicators();
    const reserved = new Set([...this._indicatorReservedIds, ...this._indicators.map(item => item.id)]);
    for (const edges of planIndicatorDependencies(this._indicators.map(item => item.dependencyNode())).dependencies.values()) {
      for (const edge of edges) reserved.add(edge.source.instanceId);
    }
    const instance = new IndicatorInstance(
      this._indicatorHost(),
      descriptor,
      this._distinctColors(descriptor, validatedSettings),
      options.paneIndex,
      instanceId,
      reserved,
      options.priceScaleId,
      plotPriceScaleIds,
      policy,
    );
    this._indicators.push(instance);
    this._restackLegends();
    this._indicatorReservedIds.add(instance.id);
    this._queueIndicatorDependents(instance.id, true);
    this.emit('objects:change', {});
    return instance;
  }

  /**
   * Give a repeated indicator its own colours. Three EMAs all in the
   * descriptor's default blue are indistinguishable on the chart *and* in the
   * legend, so the second and later instances rotate through a palette.
   *
   * Only fills colour keys the caller left unset, so an explicit colour always
   * wins, and the first instance is never touched — it keeps the colours the
   * descriptor chose.
   */
  private _distinctColors(
    descriptor: IndicatorDescriptor,
    settings: Readonly<IndicatorSettings>,
  ): Readonly<IndicatorSettings> {
    const nth = this._indicators.filter((i) => i.indicatorId === descriptor.id).length;
    if (nth === 0) return settings;
    const out: IndicatorSettings = { ...settings };
    const plots = descriptor.plots;
    for (let i = 0; i < plots.length; i++) {
      const key = plotStyleKeys(plots[i]).color;
      if (out[key] !== undefined) continue; // an explicit colour always wins
      // Stride by the plot count so a multi-plot indicator (MACD) shifts as a
      // block rather than landing on the previous instance's colours.
      out[key] = INSTANCE_PALETTE[(nth * plots.length + i) % INSTANCE_PALETTE.length];
    }
    return out;
  }

  /**
   * Every live indicator instance, in renderer stacking order.
   *
   * Flushes any pending recompute first. Indicator maths is deferred to the
   * frame, so a caller that updates a bar and reads a value back in the same
   * turn would otherwise see the previous tick's numbers.
   */
  public indicators(): readonly IndicatorApi[] {
    this._flushIndicators();
    return this._indicators;
  }

  /**
   * Move an existing study to an existing pane or a new pane at panes().length.
   * A study whose policy is not `movable` stays unless `options.force` is set.
   */
  public moveIndicator(instanceId: string, paneIndex: number, options: IndicatorEditOptions = {}): boolean {
    const instance = this._indicators.find(item => item.id === instanceId);
    if (this.isDestroyed || !instance || !this._policyAllows(instance, 'movable', options) || !Number.isInteger(paneIndex) || paneIndex < 0 || paneIndex > this._panes.length || instance.paneIndex === paneIndex || !instance.canRelocate(paneIndex)) return false;
    const previous = instance.paneIndex;
    const freshTarget = paneIndex === this._panes.length;
    this._ensurePane(paneIndex);
    const target = this._panes[paneIndex];
    const resources = instance.renderResources();
    for (const { api, overlay } of resources.series) {
      if (overlay) continue;
      const owner = this._seriesOwners.get(api);
      const record = this._seriesRecords.get(api);
      if (!owner || !record || owner.pane === target) continue;
      const scale = owner.pane.scaleOf(record);
      const options = scale.options;
      owner.pane.removeSeries(record);
      target.addSeries(record);
      owner.pane = target;
      if (freshTarget && target.series().filter(item => item.scaleId === record.scaleId).length === 1) target.scaleOf(record).setOptions(options);
      this._applySeriesPriceFormat(target.scaleOf(record), owner.priceFormat);
      if (record.style.precision !== undefined) this._applyPrecision(target.scaleOf(record), record.style.precision);
    }
    for (const { primitive, overlay } of resources.primitives) {
      if (overlay) continue;
      this._panes.find(pane => pane.hasPrimitive(primitive))?.transferPrimitive(primitive, target);
    }
    instance.relocate(paneIndex);
    // The source keeps its place when the study it sat on leaves its pane.
    this._reanchorSource();
    this._syncLegendPanes();
    // Alert visuals resolve the instance's new pane before we decide whether its old pane is empty.
    this.emit('objects:change', {});
    // Retain a pane holding drawings or host visuals even after its last plot moves.
    const source = this._panes[previous];
    if (source !== this._primaryPane && source.series().length === 0 && source.primitives().every(primitive => primitive === this._timeNav || this._anchored.some(entry => entry.primitive === primitive))) this.removePane(previous);
    this._reorderIndicatorResources();
    this._recomputeAxisColumns();
    this._relayout();
    this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('objects:change', {});
    return true;
  }

  /**
   * Change study stacking order among studies on the same pane. A study whose
   * policy is not `movable` stays unless `options.force` is set.
   */
  public reorderIndicator(instanceId: string, direction: -1 | 1, options: IndicatorEditOptions = {}): boolean {
    if (direction !== -1 && direction !== 1) return false;
    const index = this._indicators.findIndex(item => item.id === instanceId);
    if (this.isDestroyed || index < 0 || !this._policyAllows(this._indicators[index], 'movable', options)) return false;
    const paneIndex = this._indicators[index].paneIndex;
    let target = index + direction;
    while (target >= 0 && target < this._indicators.length && this._indicators[target].paneIndex !== paneIndex) target += direction;
    if (target < 0 || target >= this._indicators.length) return false;
    [this._indicators[index], this._indicators[target]] = [this._indicators[target], this._indicators[index]];
    this._reorderIndicatorResources();
    this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('objects:change', {});
    return true;
  }

  private _reorderIndicatorResources(): void {
    for (const instance of this._indicators) instance.refreshBarColors();
    const resources = this._indicators.map(instance => instance.renderResources());
    const records = resources.flatMap(resource => resource.series.flatMap(({ api }) => {
      const record = this._seriesRecords.get(api);
      return record ? [record] : [];
    }));
    const primitives = resources.flatMap(resource => resource.primitives.map(item => item.primitive));
    for (const pane of this._panes) { pane.reorderSeries(records); pane.reorderPrimitives(primitives); }
    const legends = this._indicators.flatMap(instance => instance.legend() ? [instance.legend()!] : []);
    const owned = new Set(legends);
    let index = 0;
    for (const entry of this._legends) if (owned.has(entry.legend)) entry.legend = legends[index++];
    this._placeSource();
    this._syncLegendPanes();
  }

  /** Whether a call may make a change a study's policy reserves for its host. */
  private _policyAllows(study: IndicatorApi, flag: keyof IndicatorPolicy, options: IndicatorEditOptions): boolean {
    return options.force === true || study.policy()[flag] !== false;
  }

  /**
   * The series band of a pane, back to front: `'source:primary'` where the
   * price source is on this pane, and `'indicator:<id>'` for each study that
   * lives on it and plots a series here, in the order they paint. The same
   * ids as the object inventory. Host series and a study's plots placed on
   * another pane paint in the band too, in their own slots, but are not
   * entries of it.
   */
  public seriesStack(paneIndex = this._primaryIndex()): string[] {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return [];
    const owners = this._stackOwners(pane, paneIndex);
    const out: string[] = [];
    for (const record of pane.series()) {
      const id = owners.get(record);
      if (id !== undefined && !out.includes(id)) out.push(id);
    }
    return out;
  }

  /**
   * Move a source or study directly above or below another entry of the same
   * pane's series band (see `seriesStack`). A study keeps its other bands'
   * layers in the new study order, so its fills, levels and markers follow.
   * The drawings placed above an entry travel with it. False, with nothing
   * changed, for an entry of another pane, a move that changes nothing, or a
   * study whose policy is not `movable` unless `options.force` is set.
   */
  public moveInSeriesStack(id: string, target: string, where: 'above' | 'below', options: IndicatorEditOptions = {}): boolean {
    if (this.isDestroyed || id === target || (where !== 'above' && where !== 'below')) return false;
    const study = id.startsWith('indicator:') ? this._indicators.find(item => 'indicator:' + item.id === id) : undefined;
    const source = id === 'source:primary' && this._primary !== null ? this._seriesOwners.get(this._primary.api)?.pane : undefined;
    const paneIndex = study ? study.paneIndex : source ? this._panes.indexOf(source) : -1;
    const order = paneIndex < 0 ? [] : this.seriesStack(paneIndex);
    if (!order.includes(id) || !order.includes(target) || (study && !this._policyAllows(study, 'movable', options))) return false;
    const next = order.filter(item => item !== id);
    next.splice(next.indexOf(target) + (where === 'above' ? 1 : 0), 0, id);
    if (next.every((item, i) => item === order[i])) return false;
    // The studies of this pane take their slots in the study list in the new
    // order, which every band of theirs follows; studies elsewhere keep theirs.
    const studies = next.flatMap(item => this._indicators.filter(entry => 'indicator:' + entry.id === item));
    const members = new Set(studies);
    let k = 0;
    for (let i = 0; i < this._indicators.length; i++) if (members.has(this._indicators[i])) this._indicators[i] = studies[k++];
    const at = next.indexOf('source:primary');
    if (at >= 0) this._sourceAbove = at === 0 ? null : next[at - 1].slice('indicator:'.length);
    this._reorderIndicatorResources();
    this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('objects:change', {});
    return true;
  }

  /**
   * Paint an attached primitive inside the series band of its pane, directly
   * above the source or study `above` names (an id from `seriesStack`), or
   * pass null to return it to its own z-order band. While that entry plots
   * no series on the primitive's pane it paints in its own band. A drawing
   * layer is the case this exists for. False for a primitive on no pane.
   */
  public setPrimitiveStackAbove(primitive: IPrimitive, above: string | null): boolean {
    const index = this._panes.findIndex(pane => pane.hasPrimitive(primitive));
    if (index < 0 || (above !== null && typeof above !== 'string')) return false;
    if (this._panes[index].primitiveStackAbove(primitive) === above) return true;
    this._panes[index].setPrimitiveStackAbove(primitive, above);
    this.invalidate(m => m.invalidatePane(index, { level: InvalidationLevel.Light, autoScale: false }));
    return true;
  }

  /** Each series of a pane that belongs to one of its series-band entries, with that entry's id. */
  private _stackOwners(pane: Pane, paneIndex: number): Map<SeriesRecord, string> {
    const owners = new Map<SeriesRecord, string>();
    if (this._primary !== null && this._seriesOwners.get(this._primary.api)?.pane === pane) owners.set(this._primary.record, 'source:primary');
    for (const study of this._indicators) {
      if (study.paneIndex !== paneIndex) continue;
      for (const { api } of study.renderResources().series) {
        const record = this._seriesRecords.get(api);
        if (record !== undefined && this._seriesOwners.get(api)?.pane === pane) owners.set(record, 'indicator:' + study.id);
      }
    }
    return owners;
  }

  /** The series an entry paints last on a pane: what a primitive placed above it paints after. */
  private _stackSlot(paneIndex: number, entry: string): SeriesRecord | undefined {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return undefined;
    const owners = this._stackOwners(pane, paneIndex);
    let last: SeriesRecord | undefined;
    for (const record of pane.series()) if (owners.get(record) === entry) last = record;
    return last;
  }

  /**
   * Put the price source where it was placed: directly above its study, or
   * behind every study of its pane. A source nobody placed stays where it was
   * added. Host series keep their slots, so only the source record moves, and
   * only when it is out of place.
   */
  private _placeSource(): void {
    const placed = this._sourceAbove;
    const owner = this._primary === null ? undefined : this._seriesOwners.get(this._primary.api);
    if (placed === undefined || owner === undefined) return;
    const pane = owner.pane, paneIndex = this._panes.indexOf(pane), source = this._primary!.record;
    const owners = this._stackOwners(pane, paneIndex);
    owners.delete(source);
    const records = pane.series(), at = records.indexOf(source);
    const after = placed === null ? undefined : this._stackSlot(paneIndex, 'indicator:' + placed);
    // A study that is gone leaves the source at the back, and says so when saved.
    if (after === undefined) this._sourceAbove = null;
    const from = after === undefined ? -1 : records.indexOf(after);
    const next = records.findIndex((record, i) => i > from && record !== source && owners.has(record));
    if (at > from && (next < 0 || at < next)) return;
    // The least that puts it in place: right after its study, or right before
    // the first study at the back, so a host series beside it keeps its side.
    pane.moveSeries(source, after === undefined ? records[next] : records[from + 1] ?? null);
  }

  /**
   * The study directly below the source, read from the band as it stands:
   * how the source keeps its place when the study it sat on leaves the pane.
   */
  private _reanchorSource(): void {
    const pane = this._primary === null ? undefined : this._seriesOwners.get(this._primary.api)?.pane;
    if (typeof this._sourceAbove !== 'string' || pane === undefined) return;
    const order = this.seriesStack(this._panes.indexOf(pane)), at = order.indexOf('source:primary');
    this._sourceAbove = at > 0 ? order[at - 1].slice('indicator:'.length) : null;
  }

  private _syncLegendPanes(): void {
    for (const entry of this._legends) entry.paneIndex = this._panes.findIndex(pane => pane.hasPrimitive(entry.legend));
    this._restackLegends();
  }

  /**
   * Remove one indicator instance by its handle id. Returns true if it existed
   * and went; a study whose policy is not `removable` stays unless
   * `options.force` is set.
   */
  public removeIndicator(instanceId: string, options: IndicatorEditOptions = {}): boolean {
    const instance = this._indicators.find(x => x.id === instanceId);
    return instance !== undefined && instance.remove(options);
  }

  private _forgetIndicator(instanceId: string, failedOwnedPane?: number): void {
    const i = this._indicators.findIndex((x) => x.id === instanceId);
    if (i < 0) {
      const pane = failedOwnedPane === undefined ? undefined : this._panes[failedOwnedPane];
      if (failedOwnedPane !== undefined && pane !== undefined && pane !== this._primaryPane && pane.series().length === 0 && pane.primitives().every(primitive => primitive === this._timeNav || this._anchored.some(entry => entry.primitive === primitive))) this.removePane(failedOwnedPane);
      return;
    }
    const { indicatorId, paneIndex } = this._indicators[i];
    this._indicators.splice(i, 1);
    this._reanchorSource();
    this._restackLegends();
    this._indicatorReservedIds.add(instanceId);
    this._indicatorRefreshes.delete(instanceId);
    this._queueIndicatorDependents(instanceId, true);
    this.emit('indicatorRemoved', { instanceId, indicatorId, paneIndex });
    // An indicator pane that just emptied has nothing left to show. This lived
    // in the legend's close handler, so only the on-chart × pruned the pane — a
    // host removing the same indicator from its own UI left it behind, and
    // `getState` then persisted the orphan, so every reload restored a blank
    // region. Doing it here means every caller behaves the same. The price
    // pane stays whatever emptied it, and it can sit in any slot.
    const pane = this._panes[paneIndex];
    if (pane !== undefined && pane !== this._primaryPane && pane.series().length === 0) this.removePane(paneIndex);
  }

  /** Optional instrument identity supplied by the host, never inferred from bars. */
  public getDataContext(): Readonly<ChartDataContext> | undefined {
    return this._dataContext;
  }

  /** Instrument capability from the host. A missing bar reading does not change it. */
  public get hasOpenInterest(): boolean | undefined {
    return this._dataContext?.hasOpenInterest;
  }

  /** Clear the previous source bars before changing context, then load the new source. */
  public setDataContext(context: ChartDataContext | undefined): void {
    if (this._dataContext?.symbol === context?.symbol && this._dataContext?.exchange === context?.exchange
      && this._dataContext?.hasOpenInterest === context?.hasOpenInterest
      && this._dataContext?.interval === context?.interval && !!this._dataContext === !!context) return;
    const instrumentChanged = this._dataContext?.symbol !== context?.symbol
      || this._dataContext?.exchange !== context?.exchange;
    const sourceChanged = instrumentChanged || this._dataContext?.interval !== context?.interval;
    this._dataContext = context ? Object.freeze({ ...context }) : undefined;
    if (sourceChanged) this._cancelBarsRequests();
    if (sourceChanged) for (const state of this._seriesProvenance.values()) state.contextChanged();
    if (this._indicators.length > 0) {
      this._indicatorsDirty = true;
      this._loop.requestFrame();
    }
    if (instrumentChanged && this._events.length) {
      this._events = [];
      this._syncEvents();
    }
    for (const entry of this._legends) entry.legend.setOptions({ hasOpenInterest: this.hasOpenInterest });
    this._syncWatermark();
    this.emit('data:context', this._dataContext);
  }

  /**
   * Register, replace or remove (`null`) the provider indicators reach through
   * `requestBars`. Read at request time, so an indicator added before the
   * provider was set is served once one exists.
   */
  public setBarsProvider(provider: IndicatorBarsProvider | IndicatorBarsProviderAccess | null): void {
    if (this._destroyed || this._destroying || provider === this._barsProvider) return;
    this._barsProvider = provider;
    this._barsProviderRevision++;
    this._cancelBarsRequests();
    this.emit('data:requests', {});
  }

  private _cancelBarsRequests(): void {
    if (this._destroying) return;
    const previous = this._barsRequests;
    this._barsRequests = new AbortController();
    previous.abort();
  }

  /** Announce changed requested data without replacing a provider or price bars. */
  public invalidateRequestedData(): void {
    if (this._destroyed || this._destroying) return;
    this._requestedDataRevision++;
    this.emit('data:requests', {});
  }

  /** Whether the configured provider supplies explicit availability snapshots. */
  public hasSnapshotProvider(): boolean {
    return typeof this._barsProvider === 'object' && this._barsProvider !== null
      && typeof this._barsProvider.requestSnapshot === 'function';
  }

  /** Whether a bars provider is registered, so a host can grey what needs one. */
  public hasBarsProvider(): boolean {
    return this._barsProvider !== null;
  }

  /** Replace chart-owned branding. Manually attached primitives are independent. */
  public setBranding(options: boolean | LogoWatermarkOptions): void {
    if (this._branding !== null) this.removePrimitive(this._branding);
    this._branding = null;
    this._brandingOptions = options === false ? false : {
      position: 'bottom-left', margin: 14, opacity: 1, padding: 8,
      label: 'Chart by OpenAlgo', href: 'https://openalgo.in', id: 'chart-branding',
      ...(options === true ? {} : options),
    };
    if (this._brandingOptions !== false) {
      if (typeof this._brandingOptions.padding === 'object') this._brandingOptions.padding = { ...this._brandingOptions.padding };
      this._branding = new LogoWatermark(this._brandingOptions);
      this.addPrimitive(this._branding, { anchor: 'chart-bottom' });
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
    this.emit('branding:changed', this.brandingOptions());
  }

  /** Host branding options, excluded from saved chart state. */
  public brandingOptions(): false | LogoWatermarkOptions {
    const o = this._brandingOptions;
    return o === false ? false : { ...o, ...(typeof o.padding === 'object' ? { padding: { ...o.padding } } : {}) };
  }

  /** Patch background text preferences. Boolean input changes visibility only. */
  public setWatermarkOptions(options: boolean | ChartWatermarkOptions): void {
    const patch = typeof options === 'boolean' ? { visible: options } : options;
    if (patch === null || typeof patch !== 'object') return;
    const o = this._watermarkOptions;
    if (typeof patch.visible === 'boolean') o.visible = patch.visible;
    for (const key of ['text', 'color', 'font', 'id'] as const) {
      if (typeof patch[key] === 'string') o[key] = patch[key];
    }
    if (typeof patch.opacity === 'number' && Number.isFinite(patch.opacity)) o.opacity = Math.max(0, Math.min(1, patch.opacity));
    if (typeof patch.fontSize === 'number' && Number.isFinite(patch.fontSize)) o.fontSize = Math.max(10, Math.min(200, patch.fontSize));
    if (patch.zOrder === 'bottom' || patch.zOrder === 'normal' || patch.zOrder === 'top') o.zOrder = patch.zOrder;
    this._syncWatermark();
    this._layoutChanged('setWatermarkOptions');
  }

  /** JSON-safe preferences. Automatic text remains blank in this snapshot. */
  public watermarkOptions(): Readonly<ChartWatermarkOptions> { return { ...this._watermarkOptions }; }

  private _syncWatermark(): void {
    const o = this._watermarkOptions;
    if (!o.visible) {
      if (this._watermark !== null) this.removePrimitive(this._watermark);
      this._watermark = null;
      return;
    }
    const text = o.text?.trim() ? o.text : [this._dataContext?.symbol, this._dataContext?.interval].filter(Boolean).join(' ');
    if (this._watermark === null) {
      this._watermark = new TextWatermark({ ...o, text });
      this.addPrimitive(this._watermark, { anchor: 'primary-pane' });
    } else this._watermark.setOptions({ ...o, text });
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
  }

  private _indicatorHost(preservedFormats?: PreservedScaleFormats): IndicatorHost {
    return {
      assignIndicatorScale: (id, series, primitives, commit) => this._assignIndicatorScale(id, series, primitives, commit),
      bindIndicatorPrimitiveScale: (primitive, scaleId) => {
        this._panes.find(pane => pane.hasPrimitive(primitive))?.bindPrimitiveScale(primitive, scaleId);
        this._recomputeAxisColumns();
        this.invalidate(mask => mask.invalidateGlobal(InvalidationLevel.Full));
      },
      setIndicatorRange: (id, paneIndex, scaleId, range, series) => {
        const previous = this._indicatorRanges.get(id);
        const pane = this._panes[paneIndex];
        if (range && pane) this._indicatorRanges.set(id, { pane, scaleId, range, series, token: previous?.token ?? {} });
        else this._indicatorRanges.delete(id);
        this._reconcileIndicatorRanges();
      },
      legendIndex: () => this._readoutIndex(),
      indicatorRemoved: (id, failedOwnedPane): void => this._forgetIndicator(id, failedOwnedPane),
      flushIndicators: (): void => this._flushIndicators(),
      validateIndicatorSettings: (id, descriptor, settings) => {
        const nodes = this._indicators.filter(item => item.id !== id).map(item => item.dependencyNode());
        nodes.push({ id, descriptor, settings });
        planIndicatorDependencies(nodes);
      },
      studyOutput: reference => this._indicators.find(item => item.id === reference.instanceId)?.studyOutput(reference.plotKey),
      indicatorOutputChanged: (id, refresh) => this._queueIndicatorDependents(id, refresh),
      indicatorRecompute: (id, refresh, fallback) => {
        if (!this._indicators.some(item => item.id === id)) { fallback(); return; }
        if (this._recomputing) {
          fallback();
          this._indicatorWork?.delete(id);
          this._indicatorProcessed?.add(id);
          return;
        }
        this._indicatorRefreshes.set(id, refresh || this._indicatorRefreshes.get(id) === true);
        this._queueIndicatorDependents(id, refresh);
        const sourcePending = this._indicatorsDirty;
        this._flushIndicators();
        // An explicit refresh cannot consume the source pass already queued by
        // a data write. That pass can recover a failed external calculation.
        if (sourcePending) { this._indicatorsDirty = true; this._loop.requestFrame(); }
      },
      resourcesChanged: (): void => this._reorderIndicatorResources(),
      // The scale that draws the ladder is the one that decides how a number on
      // that pane is written, floor, tick, custom formatter and all.
      formatPrice: (paneIndex: number, value: number, series?: SeriesApi): string | undefined =>
        (series?.priceScale() ?? this._panes[paneIndex]?.priceScale)?.format(value),
      policyChanged: (): void => {
        this._restackLegends();
        this.emit('objects:change', {});
      },
      addIndicatorLegend: (o): PaneLegend => {
        // A row starts with its own show / settings / delete. Stacking it gives
        // it the pane-level controls when it is the first study row of a lower
        // pane, so they follow whichever row leads rather than the row count
        // at creation, which a host row above it would throw off.
        const paneActions: PaneLegendAction[] = ['hide', 'settings', 'close'];
        // The source button sits next to the gear, because the two are the
        // same errand at different depths: what this study is set to, and what
        // it is. Only a descriptor that says it has source gets one.
        if (o.hasSource === true) paneActions.splice(paneActions.indexOf('settings') + 1, 0, 'source');
        // _syncLegendOffsets decides which pane wears the offset, and runs on
        // every relayout; this is just the initial placement.
        const legend = new PaneLegend({ ...o, actions: paneActions });
        this._legendActions.set(legend, [paneActions, legend.options().actions]);
        this._studyLegends.add(legend);
        this._addPrimitive(o.paneIndex, legend);
        return legend;
      },
      removeIndicatorLegend: (legend): void => {
        this._studyLegends.delete(legend);
        this.removePrimitive(legend);
        this._restackLegends();
      },
      legendRowsOn: (paneIndex): number => this._legends.filter((l) => l.paneIndex === paneIndex).length,
      primarySeries: (): SeriesApi | null => this.primarySeries(),
      setIndicatorSeriesType: (series, type) => this._setSeriesType(series, type as SeriesType, false),
      addIndicatorSeries: (type, paneIndex, style, priceScaleId, priceFormat): SeriesApi =>
        this._createSeries(
          type as SeriesType,
          {
            paneIndex,
            style: style as SeriesStyle | undefined,
            priceScaleId: priceScaleId as PriceScaleId | undefined,
            priceFormat,
          },
          false,
          preservedFormats,
        ),
      addIndicatorLevel: (l, paneIndex): PriceLine => {
        // The instance resolves `lineStyle` before calling the host, a
        // descriptor's `dashed` boolean included, so the line needs nothing
        // else to pick its dash.
        const opts: PriceLineOptions = {
          price: l.price, color: l.color, lineWidth: l.lineWidth,
          lineStyle: l.lineStyle, leftLabel: l.label, id: l.id,
        };
        return this.addPriceLine(opts, paneIndex);
      },
      removeIndicatorLevel: (line): void => this.removePrimitive(line),
      addIndicatorFill: (fill, paneIndex): void => this._addPrimitive(paneIndex, fill),
      removeIndicatorFill: (fill): void => this.removePrimitive(fill),
      removeIndicatorMarkers: (markers): void => this.removePrimitive(markers),
      addIndicatorPrimitive: (p, paneIndex): void => this._addPrimitive(paneIndex, p),
      removeIndicatorPrimitive: (p): void => this.removePrimitive(p),
      addIndicatorTable: (paneIndex): ChartTable => {
        const t = new ChartTable();
        this._addPrimitive(paneIndex, t);
        return t;
      },
      removeIndicatorTable: (table): void => this.removePrimitive(table),
      sourceBars: (): readonly Bar[] =>
        this._firstDataId.value === null ? [] : this._dataLayer.seriesBars(this._firstDataId.value),
      sourceState: () => {
        const state = this._seriesProvenance.get(this._firstDataId.value ?? -1)?.snapshot();
        const replay = replayWindow(this);
        return state && replay ? {
          ...state, provenance: 'replay', confirmation: replay.forming ? 'forming' : 'confirmed', confirmationSource: 'replay',
        } : state;
      },
      nextPaneIndex: (): number => this._panes.length,
      // Read at every call, never kept: a study resolves its price-pane plots,
      // bands, tables and marks against wherever the price pane sits now.
      primaryPaneIndex: (): number => this._primaryIndex(),
      // The calendar a session anchor resets on and the calendar the axis is
      // labelled in have to be the same one, or a VWAP restarts in the middle
      // of the afternoon the axis is showing.
      timezone: (): string => this._timezone,
      // The same clock the countdown row reads, so an indicator that decides
      // whether the last bar is still forming agrees with the axis about it.
      // Instrument identity exists only when a host explicitly supplies it.
      now: (): number => this._wallClock(),
      symbol: (): string | undefined => this._dataContext?.symbol,
      interval: (): string | undefined => this._dataContext?.interval,
      dataContext: () => this._dataContext,
      // Answered at call time rather than at host build time, so a provider
      // registered after the indicator was added still serves it.
      requestBars: (request) => {
        const provider = this._barsProvider;
        if (provider === null) {
          return Promise.reject(new Error('openalgo-charts: this chart has no bars provider; call chart.setBarsProvider(...) to serve other instruments'));
        }
        return runAbortable(signal => typeof provider === 'function'
          ? provider({ ...request, signal }) : provider.requestBars({ ...request, signal }),
        [request.signal, this._barsRequests.signal]);
      },
      requestSnapshot: request => {
        const provider = this._barsProvider;
        return runAbortable(signal => {
          if (typeof provider !== 'object' || provider?.requestSnapshot === undefined) throw new Error('Requested snapshots are unsupported by this provider');
          const replay = replayWindow(this);
          if (replay && replay.asOf === undefined) throw new Error('Requested snapshots require an availability clock during replay');
          if (request.asOf !== undefined && !Number.isFinite(request.asOf)) throw new RangeError('Requested availability time must be finite');
          const asOf = replay?.asOf === undefined ? request.asOf : Math.min(request.asOf ?? Infinity, replay.asOf);
          return provider.requestSnapshot({ ...request, ...(asOf === undefined ? {} : { asOf }), signal });
        }, [request.signal, this._barsRequests.signal]);
      },
      requestState: () => ({
        source: this._seriesProvenance.get(this._firstDataId.value ?? -1)?.snapshot(),
        providerRevision: this._barsProviderRevision, dataRevision: this._requestedDataRevision,
        supportsSnapshots: this.hasSnapshotProvider(),
        replay: replayWindow(this),
      }),
      subscribeRequestChanges: listener => {
        const subscriptions = ['data:context', 'data:range', 'data:requests'].map(event => this.on(event, listener));
        subscriptions.push(observeReplayWindow(this, listener));
        return () => { for (const unsubscribe of subscriptions) unsubscribe(); };
      },
      subscribeDataChanges: listener => {
        const context = this.on('data:context', () => listener('context'));
        const range = this.on('data:range', () => listener('range'));
        return () => { context(); range(); };
      },
      // The tick size the price scale is already formatting and snapping to.
      // Unlike symbol and interval, the chart genuinely knows this one, so an
      // indicator sizing a range in ticks does not have to be told twice.
      //
      // Answered per pane, so a pane that does not quote the instrument says
      // undefined (see `_scalePatchFor`). That is what the legend beside that
      // axis wants; an indicator's `calc` wants the instrument's own tick, and
      // asks the price pane for it.
      tickSize: (paneIndex: number): number | undefined => {
        const pane = this._panes[paneIndex] ?? this._primaryPane;
        const min = pane?.priceScale.options.minMove ?? 0;
        // 0 is the scale's "infer from the visible range" sentinel, not a tick.
        return min > 0 ? min : undefined;
      },
      setBarColors: (colors, owner): void => this._setBarColors(colors, owner),
      // Indicator alerts land on the same bus as every other chart event, so a
      // host wires one listener rather than a second subscription mechanism.
      emit: (event, payload): void => this.emit(event, payload),
      setPaneRange: (paneIndex, range): void => {
        const pane = this._panes[paneIndex];
        if (pane === undefined) return;
        // Declared, not measured: the scale remembers the band so a later
        // auto-fit request comes back to it instead of re-measuring an
        // oscillator against its own values (see `PriceScale.setFixedRange`).
        const shared = pane === this._primaryPane || this._indicators.filter(item => item.paneIndex === paneIndex).length > 1;
        pane.priceScale.setFixedRange(shared ? null : range);
        if (range === null) pane.priceScale.setAutoScale(true);
      },
    };
  }

  private _validPriceScaleId(value: unknown): value is PriceScaleId {
    return typeof value === 'string' && (value === 'right' || value === 'left' || value === '' || value.startsWith('overlay:'));
  }

  private _assignIndicatorScale(id: string,
    series: readonly { api: SeriesApi; scaleId: PriceScaleId }[],
    primitives: readonly { primitive: IPrimitive; scaleId: PriceScaleId }[], commit: () => void): boolean {
    if (this._destroyed || !this._indicators.some(instance => instance.id === id)) return false;
    for (const item of series) if (!this._validPriceScaleId(item.scaleId) || this.seriesType(item.api) === null) return false;
    for (const item of primitives) if (!this._validPriceScaleId(item.scaleId) || !this._panes.some(pane => pane.hasPrimitive(item.primitive))) return false;
    this._scaleMutationDepth++;
    try {
      for (const { api, scaleId } of series) {
        const record = this._seriesRecords.get(api)!, owner = this._seriesOwners.get(api)!;
        const target = owner.pane.scaleFor(scaleId);
        record.scaleId = scaleId;
        this._applySeriesPriceFormat(target, owner.priceFormat);
        if (record.style.precision !== undefined) this._applyPrecision(target, record.style.precision);
      }
      for (const { primitive, scaleId } of primitives) this._panes.find(pane => pane.hasPrimitive(primitive))!.bindPrimitiveScale(primitive, scaleId);
      commit();
      this._recomputeAxisColumns();
    } finally {
      this._scaleMutationDepth--;
      this.invalidate(mask => mask.invalidateGlobal(InvalidationLevel.Full));
    }
    this.emit('objects:change', {});
    return true;
  }

  private _reconcileIndicatorRanges(): void {
    const selected = new Map<PriceScale, { token: object; range: { min: number; max: number } }>();
    for (const claim of this._indicatorRanges.values()) {
      if (!this._panes.includes(claim.pane)) continue;
      const scale = claim.pane.scaleFor(claim.scaleId);
      if (selected.has(scale)) continue;
      const peers = [...this._indicatorRanges.values()].filter(peer => peer.pane === claim.pane && peer.scaleId === claim.scaleId
        && peer.range.min === claim.range.min && peer.range.max === claim.range.max);
      const records = new Set(peers.flatMap(peer => peer.series.flatMap(api => {
        const record = this._seriesRecords.get(api); return record ? [record] : [];
      })));
      if (claim.pane.series().some(record => record.scaleId === claim.scaleId && !records.has(record))) continue;
      selected.set(scale, claim);
    }
    for (const [scale, token] of this._ownedScaleRanges) {
      if (!selected.has(scale)) {
        scale.clearOwnedFixedRange(token);
        this._ownedScaleRanges.delete(scale);
      }
    }
    for (const [scale, claim] of selected) {
      const token = this._ownedScaleRanges.get(scale) ?? claim.token;
      if (scale.setOwnedFixedRange(token, claim.range)) this._ownedScaleRanges.set(scale, token);
      else if (!scale.ownsFixedRange(token)) this._ownedScaleRanges.delete(scale);
    }
  }

  /**
   * Take (or withdraw) the price bars' colour overlay on behalf of one
   * indicator instance.
   *
   * Only one overlay can be on the candles, so this is last writer wins. That is
   * deterministic rather than arbitrary: publishers run inside
   * `_flushIndicators`, in `addIndicator` order, so the same instance wins
   * every frame. Withdrawal is gated on ownership, or the first publisher's
   * teardown would wipe the second one's colours. If the *winner* is removed
   * while another publisher is still live, the bars go back to their own colours
   * until that publisher's next recompute.
   */
  private _setBarColors(colors: readonly (string | null)[] | null, owner: string): void {
    if (colors === null) {
      if (this._barColorOwner !== owner) return;
      this._barColorOwner = null;
    } else {
      this._barColorOwner = owner;
    }
    this._barColors = colors;
    this._applyBarColors();
  }

  /**
   * Republish the primary series with the overlay applied.
   *
   * The bars in the data layer are the **caller's own objects** (`setData` keeps
   * the references), so painting a colour onto them in place would reach back
   * into the host's array and outlive the indicator. Cloning the ones that
   * change is what keeps that from happening; unchanged bars are passed through,
   * and a pass where nothing changed writes nothing at all, which is the common
   * case on a live tick.
   */
  private _applyBarColors(): void {
    const dataId = this._firstDataId.value;
    if (dataId === null) return;
    const bars = this._dataLayer.seriesBars(dataId);
    const n = bars.length;
    const base = this._barColorBase;
    // Anything that replaces history (a symbol change, a page of older bars)
    // invalidates the snapshot, since index i is no longer the same bar.
    if (n < base.length || (base.length > 0 && bars[0].time !== this._barColorAnchor)) base.length = 0;
    if (base.length === 0) this._barColorAnchor = n > 0 ? bars[0].time : 0;
    for (let i = base.length; i < n; i++) base[i] = bars[i].color;
    const colors = this._barColors;
    const out = new Array<Bar>(n);
    let changed = false;
    for (let i = 0; i < n; i++) {
      const bar = bars[i];
      const color = colors?.[i] ?? base[i];
      if (color === bar.color) { out[i] = bar; continue; }
      out[i] = { ...bar, color };
      changed = true;
    }
    if (!changed) return;
    // Straight to the data layer, not through `_setData`: the time points are
    // untouched, so nothing about the axis or the base index moves, and routing
    // it through the data path would recompute every indicator mid-recompute.
    this._dataLayer.setSeriesData(dataId, out);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
  }

  /**
   * Mark every indicator stale after a source-data change, to be recomputed
   * once before the next paint.
   *
   * Recomputing straight from the data update instead costs a full pass over
   * every bar, for every indicator, for every tick. A busy symbol delivers ticks
   * in bursts far faster than the display refreshes, so most of those passes are
   * thrown away unseen: 50 ticks between two frames cost 50 recomputes per
   * indicator and blocked the main thread for over half a second on a ten
   * indicator chart. Deferring to the frame makes that one recompute, because
   * only the last one could ever have been shown.
   *
   * `flushIndicators` therefore has to run before anything that can observe a
   * value, which is the frame and the public `indicators()` accessor.
   */
  private _invalidateIndicators(): void {
    this.emit('data:range', {});
    if (this._indicators.length === 0) return;
    this._indicatorsDirty = true;
    this._loop.requestFrame();
  }

  /**
   * Recompute every stale indicator. Reentrant-guarded: an indicator writes its
   * plots with `series.setData`, which re-enters the same data-mutation path
   * that marked us dirty.
   */
  private _flushIndicators(): void {
    if (!this._indicatorsDirty && this._indicatorRefreshes.size === 0) return;
    if (this._recomputing) return;
    if (this._indicators.length === 0) {
      this._indicatorsDirty = false;
      this._indicatorRefreshes.clear();
      return;
    }
    const all = this._indicatorsDirty;
    const order = planIndicatorDependencies(this._indicators.map(item => item.dependencyNode())).order;
    const work = new Map(this._indicatorRefreshes);
    this._indicatorRefreshes.clear();
    if (all) for (const id of order) if (!work.has(id)) work.set(id, false);
    this._indicatorsDirty = false;
    this._recomputing = true;
    this._indicatorWork = work;
    this._indicatorProcessed = new Set();
    try {
      for (const id of order) {
        if (!work.has(id) || this._indicatorProcessed.has(id)) continue;
        const indicator = this._indicators.find(item => item.id === id);
        if (!indicator) continue;
        this._indicatorProcessed.add(id);
        indicator.recompute(work.get(id));
      }
      for (const indicator of this._indicators) indicator.republishBarColors();
    } finally {
      this._indicatorWork = null;
      this._indicatorProcessed = null;
      this._recomputing = false;
    }
  }

  private _queueIndicatorDependents(id: string, refresh: boolean): void {
    const plan = planIndicatorDependencies(this._indicators.map(item => item.dependencyNode()));
    const pending = [id];
    const visited = new Set(pending);
    for (let i = 0; i < pending.length; i++) {
      for (const [consumer, edges] of plan.dependencies) {
        if (visited.has(consumer) || !edges.some(edge => edge.source.instanceId === pending[i])) continue;
        visited.add(consumer);
        pending.push(consumer);
        this._indicators.find(item => item.id === consumer)?.invalidateStudyOutput();
        const target = this._indicatorWork && !this._indicatorProcessed?.has(consumer)
          ? this._indicatorWork : this._indicatorRefreshes;
        target.set(consumer, refresh || target.get(consumer) === true);
      }
    }
    if (this._indicatorRefreshes.size > 0) this._loop.requestFrame();
  }

  /** Subscribe to clicks on hit-testable primitives (markers, events, lines). */
  public subscribeClick(cb: (externalId: string) => void): void {
    this._clickCb = cb;
  }

  /**
   * Subscribe to crosshair movement for an OHLC legend / tooltip. The callback
   * fires with the hovered bar of the primary price series on every move, and
   * with all-null fields when the pointer leaves the plot. A linked crosshair
   * also updates the readout, with source 'linked' and no pointer coordinates.
   */
  public subscribeCrosshairMove(cb: (e: CrosshairMoveEvent) => void): void {
    this._crosshairCb = cb;
  }

  /**
   * Update the readout under a link group's separately drawn crosshair. The
   * physical pointer takes precedence. This never emits a pointer move event,
   * so hosts do not interpret it as drawing input or echo it to another group.
   */
  public setLinkedCrosshairIndex(index: number | null): void {
    if (this.isDestroyed || this._cursor !== null) return;
    const time = index === null ? null : this._dataLayer.indexToTime(index) ?? null;
    if (time === this._readoutTime) return;
    this._readoutTime = time;
    for (const indicator of this._indicators) indicator.updateLegendValues(index ?? undefined);
    const bar = index === null || this._firstDataId.value === null ? null
      : this._dataLayer.visibleBars(this._firstDataId.value, index, index)[0]?.bar ?? null;
    const readout: CrosshairMoveEvent = { source: 'linked', time, index,
      bar, price: null, point: null, paneIndex: null };
    this._crosshairCb?.(readout);
    this.emit('crosshair:readout', readout);
  }

  private _readoutIndex(): number | undefined {
    return this._readoutTime === null ? undefined : this._dataLayer.timeToIndex(this._readoutTime);
  }

  /**
   * Subscribe to drags of draggable primitives (order / SL / TP lines, drawing
   * handles). Fires per move and on release.
   *
   * `time` is the UTC seconds under the cursor, interpolated between bars and
   * extrapolated past the right edge — so a two-axis drag (a trendline endpoint,
   * a projection) has a usable time even where the gapless axis has no bar.
   * Price-only consumers can simply ignore it.
   */
  public subscribeDrag(
    onDrag: (externalId: string, price: number, time: number) => void,
    onDragEnd?: (externalId: string, price: number, time: number) => void,
  ): void {
    this._dragCb = onDrag;
    this._dragEndCb = onDragEnd ?? null;
  }

  /**
   * Guarantee a pane's price scale has a real range before converting y↔price.
   * Autoscaling normally happens during paint, so every coordinate API — and
   * the price carried by click/drag events — used to answer with the default
   * 0..1 (or ±Infinity) until the first frame had run. Callers cannot be asked
   * to wait for a paint, so scale on demand.
   */
  private _ensureScaled(paneIndex: number): void {
    const pane = this._panes[paneIndex];
    if (pane === undefined || pane.readoutScale().scaled) return;
    pane.autoscale(this._renderContext(paneIndex));
  }

  /** Container-relative x (media px) → UTC seconds on the (gapless) time axis. */
  private _xToTime(x: number): number {
    return this._dataLayer.indexToTimeFloat(this._timeScale.xToIndex(x - this._leftAxisWidth));
  }

  /** UTC seconds → container-relative x (media px). The inverse of `_xToTime`. */
  public timeToCoordinate(time: number): number {
    return this._timeScale.indexToX(this._dataLayer.timeToIndexFloat(time)) + this._leftAxisWidth;
  }

  /** Container-relative x (media px) → UTC seconds. */
  public coordinateToTime(x: number): number {
    return this._xToTime(x);
  }

  // ── unified event bus ─────────────────────────────────────────────────────
  // One `on(name, cb)` surface for every chart event, complementing the typed
  // `subscribe*` helpers. Names emitted by the core: 'ready', 'crosshair:move',
  // 'click', 'dblclick', 'hover', 'drag:start', 'drag', 'drag:end', 'drag:cancel', 'pan', 'zoom', 'resize',
  // 'lazy-load', 'paneAdded', 'paneRemoved', 'paneMoved', 'paneMaximized', 'paneCollapsed', 'paneResized',
  // 'priceAxisMoved', 'indicatorRemoved', 'indicatorSettings', 'indicatorSource',
  // 'renderer:fallback',
  // 'branding:changed', 'destroy'. The
  // trading layer routes its 'trading:*' events through here too, and the draw
  // tier emits 'draw:*' plus the 2.0 pair 'drawing:select' and 'drawing:change'
  // (the legacy names carry one id; the new ones carry the whole selection).
  //
  // 'symbol' is a name the *host* emits on this bus, not the core: the engine
  // has no instrument concept, and a link group listens for it to slave a grid
  // of charts to one symbol (payload `{ symbol: string }` or a bare string).
  //
  // Event names are the same string on both buses: `TradingController` keys its
  // own listener map on the full name, so it is `chart.trading.on(
  // 'trading:order_modify')`, never the bare 'order_modify'.
  private readonly _listeners = new Map<string, Set<(payload: unknown) => void>>();

  /** Subscribe to a named chart event. Returns an unsubscribe function. */
  public on(event: string, cb: (payload: unknown) => void): () => void {
    let set = this._listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(cb);
    return (): void => this.off(event, cb);
  }

  /** Subscribe to the next occurrence of an event, then auto-unsubscribe. */
  public once(event: string, cb: (payload: unknown) => void): () => void {
    const wrap = (payload: unknown): void => {
      this.off(event, wrap);
      cb(payload);
    };
    return this.on(event, wrap);
  }

  /** Remove one listener, or (when `cb` is omitted) every listener for an event. */
  public off(event: string, cb?: (payload: unknown) => void): void {
    if (cb === undefined) {
      this._listeners.delete(event);
      return;
    }
    this._listeners.get(event)?.delete(cb);
  }

  /** Dispatch a named event. Public so the lazy trade layer can route through it. */
  public emit(event: string, payload: unknown): void {
    const set = this._listeners.get(event);
    if (set === undefined) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch {
        /* one bad listener must not break the others or the render loop */
      }
    }
  }

  /** Keep internal intermediate ranges from repainting or interrupting a gesture. */
  private _mutateTimeScale<T>(apply: () => T): T {
    this._timeScaleMutationDepth++;
    try { return apply(); }
    finally { this._timeScaleMutationDepth--; }
  }

  /** Emit a viewport event ('pan' | 'zoom') carrying the visible time + logical range. */
  private _emitViewport(type: 'pan' | 'zoom'): void {
    if (this._listeners.get(type) === undefined) return;
    const r = this._timeScale.visibleRange();
    this.emit(type, {
      from: this._dataLayer.indexToTime(Math.round(r.from)) ?? null,
      to: this._dataLayer.indexToTime(Math.round(r.to)) ?? null,
      logicalFrom: r.from,
      logicalTo: r.to,
    });
  }

  /**
   * Emit a viewport event for a change whose kind is not known up front, and
   * only if the window actually moved.
   *
   * The gesture paths know exactly what happened (a wheel is a zoom, a drag is
   * a pan) and emit directly. The programmatic paths do not: restoring a saved
   * range, fitting content or pressing an arrow key can move the window, resize
   * it, or do nothing at all because the scale was already there or clamped.
   * The span is the discriminator a listener cares about, and the no-move check
   * matters because a linked grid would otherwise re-broadcast on every no-op.
   */
  private _emitViewportIfMoved(before: LogicalRange): void {
    const after = this._timeScale.visibleRange();
    if (after.from === before.from && after.to === before.to) return;
    const resized = Math.abs((after.to - after.from) - (before.to - before.from)) > 1e-9;
    this._emitViewport(resized ? 'zoom' : 'pan');
  }

  /**
   * Public: attach any primitive (indicators, profiles, custom overlays) to a
   * pane, the primary price pane when none is named, or to a chart anchor.
   */
  public addPrimitive(primitive: IPrimitive, where?: number | PrimitivePlacement): void {
    if (where === undefined || typeof where === 'number') { this._addPrimitive(where ?? this._primaryIndex(), primitive); return; }
    // Chart furniture: a brand mark, a corner clock. It belongs to the CHART,
    // not to whichever pane happens to be last, so the engine re-homes it as
    // panes come and go instead of every host writing its own placeWatermark().
    this._anchored.push({ primitive, anchor: where.anchor });
    this._addPrimitive(this._anchorTarget(where.anchor), primitive);
  }

  /** The pane a chart anchor currently resolves to. */
  private _anchorTarget(anchor: PrimitiveAnchor): number {
    if (anchor === 'chart-bottom') return this._bottomPaneIndex(true);
    return anchor === 'primary-pane' ? this._priceCornerIndex() : this._topPaneIndex();
  }

  /**
   * The pane that wears the price pane's furniture: the primary pane while it
   * is on screen, else the pane at the top, which is the one maximized over
   * it. A host's symbol line and OHLC readout describe the price, so they,
   * the study count, the background text and the legend offset belong with
   * the price pane wherever it sits, and the price pane is hidden only while
   * another pane fills the chart in its place.
   */
  private _priceCornerIndex(): number {
    const primary = this._primaryIndex();
    return this._layoutWeight(primary) > 0 ? primary : this._topPaneIndex();
  }

  /**
   * Move every chart-anchored primitive to the pane its anchor now names.
   *
   * Called after anything that changes which pane sits at an edge or holds the
   * price: a pane added, removed, moved, collapsed or maximized. Maximize matters
   * most and is the case a host cannot easily handle itself: it HIDES the other
   * panes, so a mark pinned to the price pane vanishes with it rather than
   * merely sitting in the wrong place.
   */
  private _rehomeAnchored(): void {
    if (this._anchored.length === 0) return;
    for (const entry of this._anchored) {
      const target = this._anchorTarget(entry.anchor);
      const current = this._panes.findIndex((pane) => pane.hasPrimitive(entry.primitive));
      if (current === target) continue;
      if (current >= 0) this._panes[current].removePrimitive(entry.primitive);
      // `_addPrimitive` appends a legend row to `_legends`, so re-homing an
      // anchored PaneLegend without dropping its old record would register it
      // once per move and stack it against itself.
      const li = this._legends.findIndex((l) => l.legend === entry.primitive);
      if (li >= 0) this._legends.splice(li, 1);
      this._addPrimitive(target, entry.primitive);
    }
  }

  /**
   * Map a price to a container-relative Y in media (CSS) px, for positioning DOM
   * overlays (order panels, tooltips) over a pane. Returns null if the pane
   * doesn't exist or is collapsed to its header strip, which plots no price.
   * The inverse is `coordinateToPrice`.
   */
  public priceToCoordinate(price: number, paneIndex = this._primaryIndex()): number | null {
    const pane = this._mappedPane(paneIndex);
    return pane && this._paneLayout()[paneIndex].top + pane.priceToY(price);
  }

  /**
   * Map a container-relative media-px Y back to a price on a pane (inverse of
   * priceToCoordinate). Null where that is, for the same panes. Both default
   * to the primary price pane wherever it sits.
   */
  public coordinateToPrice(y: number, paneIndex = this._primaryIndex()): number | null {
    const pane = this._mappedPane(paneIndex);
    return pane && pane.yToPrice(y - this._paneLayout()[paneIndex].top);
  }

  /**
   * A pane's plot in container px: `left` and `top` from the container's
   * top-left corner, inside the price axis columns and above the time axis,
   * and the size a primitive on that pane paints into. What a host lays an
   * overlay against, and what a drawing pinned to the screen is a fraction of.
   * Null for a pane with no plot on screen: one collapsed to its header
   * strip, one hidden behind a maximized pane, or no pane at that index.
   *
   * The pane is scaled first, the way a price conversion scales it: a caller
   * that places something on the plot reads the pane's prices next, and a
   * pane no frame has painted yet (just made, or just moved) still holds its
   * placeholder range.
   */
  public plotRect(paneIndex: number): PlotRect | null {
    const layout = this._destroyed || this._collapsedShown(paneIndex) ? undefined : this._paneLayout()[paneIndex];
    if (!layout || !Number.isSafeInteger(paneIndex)) return null;
    this._ensureScaled(paneIndex);
    const width = this._width - this._leftAxisWidth - this._rightAxisWidth;
    const height = layout.height - (paneIndex === this._bottomPaneIndex() ? this._timeAxisHeight : 0);
    return width > 0 && height > 0 ? { left: this._leftAxisWidth, top: layout.top, width, height } : null;
  }

  /**
   * A pane whose prices have a place on screen, scaled. A strip has none: the
   * pointer events report no price there, and a conversion that still did
   * would put an overlay or a nudged drawing inside a strip nobody can read.
   */
  private _mappedPane(paneIndex: number): Pane | null {
    this._ensureScaled(paneIndex);
    return this._collapsedShown(paneIndex) ? null : this._panes[paneIndex] ?? null;
  }

  /**
   * Grid lines at runtime: visibility of each axis, plus its colour, dash,
   * width and spacing. Omitted fields keep their current value. Repaints every
   * pane.
   */
  public setGridOptions(opts: Partial<GridOptions>): void {
    if (opts.vertLines !== undefined) this._gridVert = opts.vertLines;
    if (opts.horzLines !== undefined) this._gridHorz = opts.horzLines;
    this._canvas.grid = { ...this._canvas.grid, ...opts };
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._layoutChanged('setGridOptions');
  }

  /** Current grid options, visibility first (it is the one field always set). */
  public gridOptions(): { vertLines: boolean; horzLines: boolean } & Partial<GridOptions> {
    return { ...this._canvas.grid, vertLines: this._gridVert, horzLines: this._gridHorz };
  }

  /**
   * The Canvas option block (grid, crosshair, scale text/lines, plot margins).
   * Each sub-block merges field by field, so setting one grid colour leaves the
   * rest of the grid alone.
   */
  public setCanvasOptions(patch: CanvasOptions): void {
    this._withinLayoutChange(() => {
      if (patch.grid) this.setGridOptions(patch.grid); // keeps the visibility pair in step
      if (patch.crosshair) this._canvas.crosshair = { ...this._canvas.crosshair, ...patch.crosshair };
      if (patch.scales) this._canvas.scales = { ...this._canvas.scales, ...patch.scales };
      if (patch.margins) {
        this._canvas.margins = { ...this._canvas.margins, ...patch.margins };
        // No second margin state: the price scale already owns marginTop/Bottom
        // as fractions, and this only converts the dialog's percentages.
        this.setPriceScaleOptions(resolvePlotMargins(this._canvas.margins), 'axes');
      }
    });
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._layoutChanged('setCanvasOptions');
  }

  /** The Canvas option block as it stands (theme fallbacks are not folded in). */
  public canvasOptions(): CanvasOptions {
    return { ...this._canvas };
  }

  /**
   * Price-scale options for every pane (mode, inverted, tick size, margins),
   * and the default new panes inherit.
   *
   * `scope` says how far a chart-wide setting reaches:
   *  - `'primary'` (default): each pane's right scale only. A mode change
   *    wants this: rebasing a volume overlay quotes percent change in lots.
   *  - `'axes'`: every scale that draws a ladder, so the left axis moves with
   *    the right. Plot margins want this.
   *  - `'all'`: the hidden overlay scales too. Almost nothing should: an
   *    overlay's margins are its creator's placement, see `Pane.axisScales`.
   *
   * `minMove` is the one field no scope carries onto a pane that does not quote
   * the instrument, whichever scope is asked for: see `_scalePatchFor`. Every
   * other field is a property of the axis and reaches exactly as far as `scope`
   * says.
   */
  public setPriceScaleOptions(
    patch: Partial<PriceScaleOptions>,
    scope: 'primary' | 'axes' | 'all' = 'primary',
  ): void {
    this._priceScaleOptions = { ...this._priceScaleOptions, ...patch };
    for (const pane of this._panes) {
      const scales = scope === 'all' ? pane.scales() : scope === 'axes' ? pane.axisScales() : [pane.priceScale];
      const forPane = this._scalePatchFor(pane, patch);
      for (const scale of scales) scale.setOptions(forPane);
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._layoutChanged('setPriceScaleOptions');
  }

  /**
   * The chart-wide price-scale defaults: every field `setPriceScaleOptions`,
   * the `priceScale` construction option and the canvas margins have set, and
   * what a pane added later starts from. `priceScaleOptions()` reads the price
   * pane's own scale instead, which a change made to that one axis moves and
   * this does not, so the two together tell a chart-wide change from a
   * one-axis one. `minMove` here reaches only the panes that quote the
   * instrument. A detached copy; empty when nothing was ever set.
   */
  public priceScaleDefaults(): Partial<PriceScaleOptions> {
    return { ...this._priceScaleOptions };
  }

  /**
   * A chart-wide price-scale patch as one pane should receive it.
   *
   * Every field in it describes the axis, except `minMove`, which describes the
   * **instrument**: it is the step the symbol trades in, 0.05 on an NSE equity.
   * A pane that plots something else is quoted in its own units, so handing it
   * that step is not a coarse answer but an answer to a different question. It
   * shipped as one: a host setting the instrument's 0.10 tick chart-wide made
   * `PriceScale.precision` report one decimal on *every* pane, so a William VIX
   * Fix reading 0.61 was labelled "0.6" and an RSI ladder read "70.0, 50.0,
   * 30.0". Withheld, those axes fall back to inferring precision from the range
   * they actually cover, which is the reading their own numbers imply.
   *
   * Only the chart-wide setters filter. An axis named outright
   * (`setPriceAxisOptions`, a series' `priceFormat`) is the caller saying what
   * that one axis quotes, and is obeyed.
   */
  private _scalePatchFor(pane: Pane, patch: Partial<PriceScaleOptions>): Partial<PriceScaleOptions> {
    if (patch.minMove === undefined || this._pricePanes.has(pane)) return patch;
    const out = { ...patch };
    delete out.minMove;
    // Withholding the tick is only half the answer. Left to the span alone a
    // bounded oscillator reads too coarse (an RSI over 0..100 implies a step of
    // 1 and prints "62" for 62.24), so the pane that does not quote the
    // instrument gets the floor instead of the tick, not neither.
    out.minPrecision = NON_INSTRUMENT_PRECISION;
    return out;
  }

  /**
   * Record that a pane quotes the instrument, and hand it the tick it was not
   * given while it did not.
   *
   * The primary pane is one from birth. Any other pane starts out an
   * indicator's, so a host adding a second symbol to a pane of its own has to
   * be able to promote one after the fact, or the comparison would lose the
   * tick-sized axis it has always had.
   */
  private _claimPricePane(pane: Pane): void {
    if (this._pricePanes.has(pane)) return;
    this._pricePanes.add(pane);
    const minMove = this._priceScaleOptions?.minMove;
    // The floor comes off as the tick goes on: a declared tick is the stronger
    // statement, and a promoted pane must end up indistinguishable from one
    // that quoted the instrument all along.
    for (const scale of pane.axisScales()) {
      scale.setOptions(minMove !== undefined ? { minMove, minPrecision: 0 } : { minPrecision: 0 });
    }
  }

  /** The primary pane's price-scale options (what the Scales tab reads), wherever it sits. */
  public priceScaleOptions(): PriceScaleOptions {
    return { ...this._primaryPane.priceScale.options };
  }

  /**
   * Put every pane's price axis back under autoscale, or pin it where it is.
   * `PriceScale.setAutoScale` alone changes nothing on screen until something
   * else asks for a frame; this re-measures and repaints.
   */
  public setAutoScale(on: boolean): void {
    for (const pane of this._panes) {
      // Auto-fit and a pinned price-per-bar ratio ask opposite things of the
      // same range, so the one just asked for wins.
      for (const { scaleId } of pane.visibleAxes(this._emptyPriceAxis)) {
        if (on) pane.setRatioLock(scaleId, false, 0, 0);
        pane.scaleFor(scaleId).setAutoScale(on);
      }
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._layoutChanged('setAutoScale');
  }

  /** Whether only the primary series contributes to autoscale on its current scale. */
  public priceOnlyAutoScale(): boolean {
    return this._priceOnlyAutoScale;
  }

  /** Keep manual ranges and ratio locks while choosing which data auto-fit measures. */
  public setPriceOnlyAutoScale(on: boolean): void {
    if (typeof on !== 'boolean' || on === this._priceOnlyAutoScale) return;
    this._priceOnlyAutoScale = on;
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('objects:change', {});
  }

  // ── one price axis at a time (what a price-axis menu acts on) ─────────────
  // The setters above are chart-wide, which is what a settings dialog wants. A
  // menu raised on one axis strip is the other case: it names a pane and a
  // scale, and every item it offers has to be readable back to draw its own
  // ticks and to grey what does not apply.

  /**
   * State of one price axis, for a host rendering a menu over it: what is
   * currently on, and which items are worth offering. Null for a pane that does
   * not exist.
   *
   * `active` false is a scale no series maps to: the ladder on an empty chart,
   * or the side a menu was raised on before anything was plotted there. That is
   * a row to render disabled with its state visible, not one to leave out.
   */
  public priceAxisState(paneIndex = this._primaryIndex(), scaleId: PriceScaleId = 'right'): PriceAxisState | null {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return null;
    const scale = pane.scaleFor(scaleId);
    const side = pane.axisPlacement(scaleId).side === 'left' ? 'left' : 'right';
    const other: 'right' | 'left' = scaleId === 'left' ? 'right' : 'left';
    return {
      paneIndex,
      scaleId,
      side,
      active: pane.usesScale(scaleId),
      autoFit: scale.autoScale,
      inverted: scale.options.inverted,
      mode: scale.options.mode,
      scaled: scale.scaled,
      lockRatio: pane.ratioLocked(scaleId),
      movable: (scaleId === 'right' || scaleId === 'left') && this._canMovePriceAxis(paneIndex, scaleId, other),
    };
  }

  /** Detached visible placement. Hidden named scales retain their independent range. */
  public priceAxisPlacement(paneIndex: number, scaleId: PriceScaleId): PriceAxisPlacement | null {
    if (!this._validPriceScaleId(scaleId)) return null;
    return this._priceAxisPane(paneIndex)?.axisPlacement(scaleId) ?? null;
  }

  /** Move or reorder a scale without changing its ID, sources, formatter or range. */
  public setPriceAxisPlacement(paneIndex: number, scaleId: PriceScaleId, side: PriceAxisSide, order?: number): boolean {
    const pane = this._priceAxisPane(paneIndex);
    if (!pane || !this._validPriceScaleId(scaleId) || !pane.setAxisPlacement(scaleId, side, order)) return false;
    this._recomputeAxisColumns();
    this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('priceAxisPlacementChanged', { paneIndex, scaleId, ...pane.axisPlacement(scaleId) });
    this.emit('objects:change', {});
    return true;
  }

  /** Active price columns in pane CSS coordinates, ordered nearest the plot on each side. */
  public priceAxisLayout(paneIndex = this._primaryIndex()): readonly PriceAxisSlot[] {
    return this._priceAxisPane(paneIndex)?.axisSlots(this._renderContext(paneIndex))
      .map(slot => ({ ...slot, x: slot.x + this._leftAxisWidth })) ?? [];
  }

  private _priceAxisPane(paneIndex: number): Pane | undefined {
    return !this._destroyed && Number.isInteger(paneIndex) && paneIndex >= 0 ? this._panes[paneIndex] : undefined;
  }

  /**
   * Options for one pane's scale (mode, invert, tick size, margins) rather than
   * every pane's. The four modes are one field, so picking one drops the
   * previous by construction: a menu renders them as a single choice.
   */
  public setPriceAxisOptions(paneIndex: number, scaleId: PriceScaleId, patch: Partial<PriceScaleOptions>): void {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return;
    pane.scaleFor(scaleId).setOptions(patch);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._layoutChanged('setPriceAxisOptions');
  }

  /**
   * Auto-fit one axis: its range tracks the data again, or stays where the user
   * left it. Turning it on releases any ratio lock on that axis, for the reason
   * given in `setAutoScale`.
   */
  public setPriceAxisAutoFit(paneIndex: number, scaleId: PriceScaleId, on: boolean): void {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return;
    if (on) pane.setRatioLock(scaleId, false, 0, 0);
    pane.scaleFor(scaleId).setAutoScale(on);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._layoutChanged('setPriceAxisAutoFit');
  }

  /**
   * Pin one axis' price-per-bar ratio: zooming the time axis then rescales the
   * prices with it, so a trend drawn at 45 degrees stays at 45 degrees. The
   * axis goes manual, because auto-fit would re-fit the data every frame and
   * undo the ratio being held.
   *
   * Returns whether the axis is now in the state asked for. Locking fails on a
   * scale nothing has measured: there is no ratio to hold on an empty pane, or
   * on one whose series plot no values at all.
   */
  public setPriceAxisLockRatio(paneIndex: number, scaleId: PriceScaleId, on: boolean): boolean {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return false;
    if (on) this._ensureScaledFor(paneIndex, scaleId);
    const ok = pane.setRatioLock(scaleId, on, this._timeScale.barSpacing, pane.scaleFor(scaleId).height);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._layoutChanged('setPriceAxisLockRatio');
    return ok;
  }

  /**
   * Move a pane's price axis to the other strip, taking the series that map to
   * it and everything the axis was set to. Returns false when that side carries
   * nothing, or when the other side is already occupied: one strip draws one
   * axis (see `Pane.moveSeriesScale`), which is what `movable` reports.
   *
   * @deprecated Removed in 3.0.0. Use {@link Chart.setPriceAxisPlacement} (since 2.5.4), which moves a scale's
   * column and keeps its id; this method instead swaps the built-in side scales and reassigns their series and
   * studies.
   */
  public movePriceAxis(paneIndex: number, from: 'right' | 'left', to: 'right' | 'left'): boolean {
    const pane = this._panes[paneIndex];
    if (!this._canMovePriceAxis(paneIndex, from, to) || !pane.moveSeriesScale(from, to)) return false;
    for (const claim of this._indicatorRanges.values()) if (claim.pane === pane && claim.scaleId === from) claim.scaleId = to;
    for (const instance of this._indicators) {
      if (instance.paneIndex !== paneIndex) continue;
      const local = instance.renderResources().series.filter(item => !item.overlay);
      const localPrices = instance.renderResources().primitives.filter(item => !item.overlay && pane.primitiveScaleId(item.primitive) !== null);
      if (local.length ? local.every(item => this._seriesRecords.get(item.api)?.scaleId === to)
        : localPrices.length && localPrices.every(item => pane.primitiveScaleId(item.primitive) === to)) instance.adoptPriceScale(to);
    }
    // The moved axis keeps its own formatting (the scale object travels with
    // it); the strip it vacated starts again from the chart-wide defaults, the
    // way a scale used for the first time does.
    const vacated = pane.scaleFor(from);
    if (this._priceScaleOptions) vacated.setOptions(this._scalePatchFor(pane, this._priceScaleOptions));
    vacated.setPriceFormatter(this._priceFormatter);
    this._recomputeAxisColumns(); // the columns are reserved by what is in use
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('priceAxisMoved', { paneIndex, from, to });
    return true;
  }

  private _canMovePriceAxis(paneIndex: number, from: 'right' | 'left', to: 'right' | 'left'): boolean {
    const pane = this._panes[paneIndex];
    if (!pane || from === to || !pane.usesScale(from) || pane.usesScale(to)) return false;
    // The legacy transfer supports uniform local studies. Mixed studies and
    // price overlays use explicit plot assignments or stable axis placement.
    for (const instance of this._indicators) {
      const resources = instance.renderResources();
      const series = resources.series.filter(item => this._seriesOwners.get(item.api)?.pane === pane);
      const primitives = resources.primitives.filter(item => pane.hasPrimitive(item.primitive) && pane.primitiveScaleId(item.primitive) !== null);
      const movingSeries = series.filter(item => this._seriesRecords.get(item.api)?.scaleId === from);
      const movingPrimitives = primitives.filter(item => pane.primitiveScaleId(item.primitive) === from);
      if (!movingSeries.length && !movingPrimitives.length) continue;
      if (movingSeries.some(item => item.overlay) || movingPrimitives.some(item => item.overlay)) return false;
      if (series.some(item => !item.overlay && this._seriesRecords.get(item.api)?.scaleId !== from)
        || primitives.some(item => !item.overlay && pane.primitiveScaleId(item.primitive) !== from)) return false;
    }
    return true;
  }

  /** Measure one scale on demand, the way `_ensureScaled` does for the pane's right one. */
  private _ensureScaledFor(paneIndex: number, scaleId: PriceScaleId): void {
    const pane = this._panes[paneIndex];
    if (pane === undefined || pane.scaleFor(scaleId).scaled) return;
    pane.autoscale(this._renderContext(paneIndex));
  }

  /**
   * Per-field status-line switches, applied to every pane legend on the chart:
   * the host's symbol row and the indicator rows alike, which is what makes one
   * switch mean the same thing everywhere. Merges field by field.
   */
  public setStatusLineOptions(patch: LegendStatusLineOptions): void {
    Object.assign(this._statusLine, patch);
    for (const entry of this._legends) entry.legend.setOptions({ statusLine: this._statusLine });
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._layoutChanged('setStatusLineOptions');
  }

  public statusLineOptions(): LegendStatusLineOptions {
    return { ...this._statusLine };
  }

  /** Whether study legend rows are replaced by their applied-instance count. */
  public indicatorLegendCollapsed(): boolean {
    return this._indicatorLegendCollapsed;
  }

  /** A display preference only; studies retain visibility, calculation and subscription state. */
  public setIndicatorLegendCollapsed(on: boolean): void {
    if (typeof on !== 'boolean' || on === this._indicatorLegendCollapsed) return;
    this._indicatorLegendCollapsed = on;
    this._restackLegends();
    this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Cursor));
    this.emit('objects:change', {});
  }

  /**
   * How large a legend's action buttons are drawn, in media px.
   *
   * Chart-wide rather than per legend: the rows stack against the height the
   * buttons need, so two sizes on one pane would stack against two different
   * heights and overlap. The primitive holds it to a range it can actually
   * draw.
   */
  public setLegendIconSize(size: number): void {
    if (!Number.isFinite(size)) return;
    this._legendIconSize = size;
    for (const entry of this._legends) entry.legend.setOptions({ iconSize: size });
    // A relayout rather than a restack alone: a collapsed strip is one row tall.
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  public legendIconSize(): number | undefined {
    return this._legendIconSize;
  }

  /**
   * Turn the axis-strip chrome on or off, and hand it a clock. Merges field by
   * field, so switching the countdown on leaves the corner clock alone.
   */
  public setAxisChromeOptions(patch: AxisChromeOptions): void {
    if (patch.sessionClock !== undefined) {
      if (typeof patch.sessionClock === 'object') this._sessionClockForm = { ...patch.sessionClock };
      // A bare `true` means "on with whatever this clock was configured as",
      // not "on with the defaults, and forget what you were told" (see
      // `_sessionClockForm`).
      this._axisChrome.sessionClock = patch.sessionClock === true
        ? this._sessionClockForm ?? true
        : patch.sessionClock;
    }
    if (patch.barCountdown !== undefined) this._axisChrome.barCountdown = patch.barCountdown;
    if (patch.clock !== undefined) {
      this._axisChrome.clock = patch.clock;
      this._wallClock = patch.clock;
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._layoutChanged('setAxisChromeOptions');
  }

  /** The axis-chrome switches as they stand. */
  public axisChromeOptions(): AxisChromeOptions {
    return { ...this._axisChrome };
  }

  /** Crosshair behaviour ('normal' or 'magnet'). Set it via `applyOptions`. */
  public crosshairMode(): CrosshairMode {
    return this._crosshairMode;
  }

  /** Whether the vertical crosshair snaps to an existing primary bar's center. */
  public crosshairSnapToBar(): boolean {
    return this._crosshairSnapToBar;
  }

  /**
   * Whether the price pane may leave the top of the stack, see
   * `ChartOptions.movablePrimaryPane`. False unless the host opted in, and
   * while it is false the price pane stays at slot 0 for the life of the chart.
   */
  public movablePrimaryPane(): boolean {
    return this._movablePrimaryPane;
  }

  /** The active palette. Swap it with `setTheme`. */
  public theme(): ChartTheme {
    return this._theme;
  }

  /**
   * Flatten every pane's base + overlay canvas into one opaque canvas (device
   * px). The chart renders as stacked layered canvases, so the browser's native
   * right-click "Save image" only captures the layer under the pointer (usually
   * the transparent crosshair overlay) — use this to export the full chart.
   */
  public takeScreenshot(): HTMLCanvasElement {
    const dpr = this._pixelRatio();
    const out = this._doc.createElement('canvas');
    out.width = Math.max(1, Math.round(this._width * dpr));
    out.height = Math.max(1, Math.round(this._height * dpr));
    const g = out.getContext('2d');
    if (g === null) return out;
    g.fillStyle = this._theme.background;
    g.fillRect(0, 0, out.width, out.height);
    const layout = this._paneLayout();
    for (let i = 0; i < this._panes.length; i++) {
      if (this._layoutWeight(i) <= 0) continue;
      const y = Math.round((layout[i]?.top ?? 0) * dpr);
      for (const layer of [this._panes[i].base, this._panes[i].top]) {
        // Hidden or unmeasured buffers are invalid Canvas2D image sources.
        if (layer.element.width > 0 && layer.element.height > 0) g.drawImage(layer.element, 0, y);
      }
    }
    return out;
  }

  /**
   * The chart as a standalone SVG document: every pane's base and overlay
   * paint, in the order the DOM stacks them, run once into a serialising
   * context at pixel ratio 1. Text stays text (selectable, searchable) and
   * lines stay lines, so the file scales without the blur a PNG picks up.
   *
   * Nothing transient is in it: no crosshair, no hover state, no drag. What is
   * in it is exactly what the renderers, primitives and drawing tools draw,
   * because it is the same code drawing. A primitive that paints through a
   * call with no vector form (a bitmap logo, a shadow) is simply thinner in
   * the export; see `SvgContext` for the list.
   *
   * Returns the string only. Saving it is the host's job, the way
   * `downloadScreenshot` is the host-facing half of `takeScreenshot`:
   * `new Blob([svg], { type: 'image/svg+xml' })` and an anchor is all it takes.
   */
  public exportSVG(options: ExportSvgOptions = {}): string {
    // The type already says 1; an untyped caller asking for 2 gets told why
    // rather than a document that looks the same and is not.
    if (options.dpr !== undefined && options.dpr !== 1) {
      throw new RangeError('exportSVG: dpr must be 1, SVG has no device pixels');
    }
    const width = Math.max(1, Math.round(options.width ?? this._width));
    const height = Math.max(1, Math.round(options.height ?? this._height));
    const background = options.background !== false;
    const svg = new SvgContext(width, height, { background: background ? this._theme.background : undefined });
    const g = svg.asCanvasContext();
    // The same order as a frame: indicator recomputes land before anything is
    // measured, so a study whose inputs changed this tick exports as it will
    // next paint, not as it last did.
    this._flushIndicators();
    const liveWidth = this._width;
    const liveHeight = this._height;
    const resized = width !== liveWidth || height !== liveHeight;
    if (resized) {
      this._width = width;
      this._height = height;
      this._relayout(true);
    }
    try {
      if (background && this._theme.background !== 'transparent') {
        svg.fillStyle = this._theme.background;
        svg.fillRect(0, 0, width, height);
      }
      const layout = this._paneLayout();
      const topPane = this._topPaneIndex();
      for (let i = 0; i < this._panes.length; i++) {
        if (this._layoutWeight(i) <= 0) continue; // hidden behind a maximized pane
        const pane = this._panes[i];
        const ctx: PaneRenderContext = {
          ...this._renderContext(i),
          dpr: 1, hoverId: null, hoverKey: null, dragId: null, paintBackground: background,
        };
        // The DOM starts each canvas at its pane box's top and lays the
        // separator over the first row, so the export paints the pane in that
        // same box and the rule over it, or the second pane would sit a pixel
        // away from where it is on screen.
        svg.pushGroup(
          { 'data-pane': i },
          { translate: { x: 0, y: layout[i].top }, clip: { x: 0, y: 0, width, height: layout[i].height } },
        );
        // A Full frame's sequence for one pane, minus the crosshair.
        pane.autoscale(ctx);
        pane.paintBase(ctx, g);
        pane.paintTop(null, ctx, g);
        svg.popGroup();
        if (i !== topPane) {
          svg.fillStyle = this._theme.paneSeparator;
          svg.fillRect(0, layout[i].top, width, hairlineHeight(1));
        }
      }
    } finally {
      if (resized) {
        this._width = liveWidth;
        this._height = liveHeight;
        this._relayout(true);
        // Every auto scale was just measured against the export geometry; a
        // Full frame measures it back against the screen's.
        this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      }
    }
    return svg.toString();
  }

  /** Chart-anchored primitives, re-homed by `_rehomeAnchored`. */
  private readonly _anchored: { primitive: IPrimitive; anchor: PrimitiveAnchor }[] = [];

  private _addPrimitive(paneIndex: number, primitive: IPrimitive): void {
    this._ensurePane(paneIndex);
    const host: PrimitiveHost = {
      // A 'top' primitive is drawn only by `Pane.paintTop`, so repainting the
      // base canvas for it is work nothing consumes. That is the difference
      // between a cursor-following overlay costing one overlay repaint and it
      // costing a full series redraw on every mousemove, times every chart in a
      // linked grid. Read per call rather than captured at attach: `zOrder()`
      // is a method, and a primitive is free to change layer.
      requestUpdate: (): void => {
        const index = this._panes.findIndex(pane => pane.hasPrimitive(primitive));
        // One placed in the series band paints on the base canvas, whatever its own band.
        const top = primitive.zOrder() === 'top' && this._panes[index]?.primitiveStackAbove(primitive) == null;
        this.invalidate((m) => m.invalidatePane(index, { level: top ? InvalidationLevel.Cursor : InvalidationLevel.Light, autoScale: false }));
      },
    };
    this._panes[paneIndex].addPrimitive(primitive, host);
    // Track legend rows however they were added — a host can add its own (a
    // symbol/OHLC row) and indicator legends must stack beneath it.
    if (primitive instanceof PaneLegend) {
      this._legends.push({ legend: primitive, paneIndex });
      primitive.setOptions({ hasOpenInterest: this.hasOpenInterest });
      // A row added after the switches were set still obeys them; a legend that
      // brought its own `statusLine` keeps whatever it set on top. Skipped when
      // the chart has no switches to push, which is the usual case: `setOptions`
      // asks for a repaint, and asking for one to write an empty object is a
      // frame nobody needed.
      if (Object.keys(this._statusLine).length > 0) {
        const own = primitive.options().statusLine;
        primitive.setOptions({ statusLine: { ...this._statusLine, ...own } });
      }
      // A chart-wide size also governs host rows so their row heights agree.
      if (this._legendIconSize !== undefined) {
        primitive.setOptions({ iconSize: this._legendIconSize });
      }
      this._restackLegends();
    }
    this.invalidate((m) => m.invalidatePane(paneIndex, { level: InvalidationLevel.Light, autoScale: false }));
  }

  /** Remove a primitive from whichever pane holds it. */
  public removePrimitive(primitive: IPrimitive): void {
    // Drop the anchor registration FIRST. Without this the pane copy goes but
    // the registry entry stays, and the next pane add, remove, move or maximize
    // calls `_rehomeAnchored` and puts the removed primitive back on the chart.
    // A remove that a later unrelated action silently undoes is worse than one
    // that fails loudly.
    const ai = this._anchored.findIndex((a) => a.primitive === primitive);
    if (ai >= 0) this._anchored.splice(ai, 1);
    const li = this._legends.findIndex((l) => l.legend === primitive);
    if (li >= 0) this._legends.splice(li, 1);
    for (let i = 0; i < this._panes.length; i++) {
      if (this._panes[i].removePrimitive(primitive)) {
        if (li >= 0) this._restackLegends();
        this._recomputeAxisColumns();
        this.invalidate((m) => m.invalidatePane(i, { level: InvalidationLevel.Light, autoScale: false }));
        return;
      }
    }
  }

  /**
   * Renumber legend rows per pane in insertion order, so removing one closes
   * the gap instead of leaving a hole where it used to sit.
   */
  private _restackLegends(): void {
    const rowByPane = new Map<number, number>();
    const top = this._priceCornerIndex(), count = this._indicators.length;
    const leads = new Map<number, PaneLegend>();
    for (const { legend, paneIndex } of this._legends) if (this._studyLegends.has(legend) && !leads.has(paneIndex)) leads.set(paneIndex, legend);
    // A study pane's first study row carries the pane controls, open or folded,
    // whether a removal, a move or a host row above it made it first, and no
    // other study row does. The price pane's rows never do, in any slot: its
    // rows are on-chart studies, and a row's controls would read as moving or
    // folding that study. On a strip its collapse control is the only way
    // back: the row goes first, above any row the host placed there, and
    // compact rows leave it showing. A strip is one row tall, so a row below
    // it neither draws nor answers the pointer: it would start inside the
    // strip's lower inset.
    const strip = (entry: { legend: PaneLegend; paneIndex: number }): boolean => leads.get(entry.paneIndex) === entry.legend && this._collapsedShown(entry.paneIndex);
    // A row offers only what its study's policy lets the user do: no close
    // button on a study the user may not remove, no gear on one they may not
    // configure. The pane controls act on the pane and stay.
    const policies = new Map(this._indicators.map(study => [study.legend(), study.policy()]));
    let reserved = false;
    for (const entry of [...this._legends.filter(strip), ...this._legends.filter(entry => !strip(entry))]) {
      let row = rowByPane.get(entry.paneIndex) ?? 0;
      const owned = this._studyLegends.has(entry.legend);
      const folded = owned && this._indicatorLegendCollapsed && !strip(entry);
      entry.legend.setSuppressed(folded || row > 0 && this._collapsedShown(entry.paneIndex));
      if (count > 0 && entry.paneIndex === top && owned && !reserved) {
        this._indicatorLegendRow = row++;
        reserved = true;
      }
      const pane = this._panes[entry.paneIndex];
      const collapsed = this._collapsed.has(pane);
      if (owned) {
        // A host that rewrote the row since (`legend().setOptions({ actions })`) keeps what it wrote.
        const kept = this._legendActions.get(entry.legend), shown = entry.legend.options().actions;
        const base = kept === undefined || kept[1] !== shown ? shown ?? [] : kept[0], policy = policies.get(entry.legend);
        const allowed = base.filter(action => !(action === 'close' && policy?.removable === false)
          && !(action === 'settings' && policy?.configurable === false));
        const actions = leadActions(allowed, pane !== undefined && pane !== this._primaryPane && leads.get(entry.paneIndex) === entry.legend);
        entry.legend.setOptions({ row, collapsed, actions });
        this._legendActions.set(entry.legend, [base, actions]);
      } else entry.legend.setOptions({ row });
      rowByPane.set(entry.paneIndex, row + (!folded && entry.legend.options().visible !== false ? 1 : 0));
    }
    if (!reserved) this._indicatorLegendRow = rowByPane.get(top) ?? 0;
    if (count > 0 && this._indicatorLegendToggle === null) {
      this._indicatorLegendToggle = new IndicatorLegendToggle();
      this.addPrimitive(this._indicatorLegendToggle, { anchor: 'primary-pane' });
    } else if (count === 0 && this._indicatorLegendToggle !== null) {
      const toggle = this._indicatorLegendToggle;
      this._indicatorLegendToggle = null;
      this.removePrimitive(toggle);
    }
    this._syncLegendOffsets();
  }

  /**
   * Apply `legendOffset` to the price pane wherever it sits, and to the pane
   * maximized over it while it is hidden, rather than to a fixed index.
   *
   * The offset describes the corner a host covers with its own readout of the
   * price: a symbol line, an OHLC row. That readout belongs to the price pane,
   * so it moves with it when the pane is moved below its studies. Maximizing a
   * study pane hides the price pane, and the maximized pane then renders in
   * the corner the host overlay covers; pinning the offset to one index left
   * it drawing its legend straight through the host's readout.
   *
   * Host-added legend rows are left alone: the host positions its own.
   */
  private _syncLegendOffsets(): void {
    const corner = this._priceCornerIndex(), primary = this._primaryIndex();
    const height = paneLegendRowHeight({ iconSize: this._legendIconSize });
    const defaultToggleTop = this._legendOffset.top + this._indicatorLegendRow * height;
    let toggleTop = defaultToggleTop;
    for (const entry of this._legends) {
      const options = entry.legend.options();
      if (this._studyLegends.has(entry.legend) || entry.paneIndex !== corner
        || options.visible === false || (options.row ?? 0) >= this._indicatorLegendRow) continue;
      toggleTop = Math.max(toggleTop, (options.top ?? DEFAULT_LEGEND_TOP) + ((options.row ?? 0) + 1) * paneLegendRowHeight(options));
    }
    for (const entry of this._legends) {
      if (!this._studyLegends.has(entry.legend)) continue;
      const covered = entry.paneIndex === corner || entry.paneIndex === primary;
      entry.legend.setOptions(
        covered
          ? { top: this._legendOffset.top + (this._indicatorLegendToggle ? toggleTop - defaultToggleTop : 0), left: this._legendOffset.left }
          : { top: DEFAULT_LEGEND_TOP, left: DEFAULT_LEGEND_LEFT },
      );
    }
    this._indicatorLegendToggle?.setOptions({ count: this._indicators.length, collapsed: this._indicatorLegendCollapsed,
      left: this._legendOffset.left, top: toggleTop, height });
  }

  /**
   * A host for the (lazy-loaded) trade layer to attach/detach its primitives
   * on a pane. Without an index it follows the primary price pane, resolved at
   * each attach, so an order line drawn after the price pane moved still lands
   * beside the candles.
   */
  public tradeHost(paneIndex?: number): { addPrimitive(p: IPrimitive): void; removePrimitive(p: IPrimitive): void } {
    return {
      addPrimitive: (p: IPrimitive): void => this._addPrimitive(paneIndex ?? this._primaryIndex(), p),
      removePrimitive: (p: IPrimitive): void => this.removePrimitive(p),
    };
  }

  /** Apply one live bar; auto-scroll only on a genuine right-edge append. */
  private _updateBar(dataId: number, bar: Bar, options?: SeriesUpdateOptions): void {
    validateSeriesOptions(options, true);
    const bars = this._dataLayer.seriesBars(dataId);
    const tailTime = bars[bars.length - 1]?.time;
    const change = tailTime === undefined || bar.time > tailTime ? 'append' : bar.time === tailTime ? 'replace' : 'correction';
    const wasAtRight = this._timeScale.rightOffset >= 0;
    const kind = this._dataLayer.update(dataId, bar);
    this._seriesProvenance.get(dataId)?.record(change, Math.max(tailTime ?? bar.time, bar.time), options);
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    // Only a real append advances the view; late/historical inserts must not
    // be treated as a new right-edge bar (would wrongly auto-scroll / shift).
    if (kind === 'append' && !wasAtRight) {
      this._mutateTimeScale(() => this._timeScale.setRightOffset(this._timeScale.rightOffset - 1));
    }
    if (dataId === this._firstDataId.value) this._invalidateIndicators();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
    if (dataId === this._firstDataId.value) this.emit('data:update', { kind: 'update', time: bar.time });
  }

  private _ensurePane(index: number): void {
    const added: number[] = [];
    while (this._panes.length <= index) {
      // price pane (0) takes full weight; lower panes (volume/indicators) are shorter
      this._addPane(this._panes.length === 0 ? 1 : 0.32);
      added.push(this._panes.length - 1);
    }
    if (added.length === 0) return;
    this._relayout();
    // Panes are made lazily, when an indicator asks for one, and that used to be
    // silent: `paneRemoved` existed with no counterpart. A host with chrome at
    // the bottom of the chart had no way to learn the bottom had moved. Emitted
    // after the relayout so a listener reads settled geometry.
    this._rehomeAnchored();
    for (const paneIndex of added) this.emit('paneAdded', { paneIndex });
  }

  private _setData(dataId: number, bars: readonly Bar[], options?: BarConfirmationOptions): void {
    validateSeriesOptions(options);
    if (dataId === this._firstDataId.value) this._stopNavigationMotion();
    this._dataLayer.setSeriesData(dataId, bars);
    const sorted = this._dataLayer.seriesBars(dataId);
    this._seriesProvenance.get(dataId)?.record('reset', sorted[sorted.length - 1]?.time, options);
    // An indicator's plots are series in this same layer, so `baseIndex` is the
    // longest of *all* of them, this one included. Replacing the primary series
    // wholesale can therefore leave the axis measured against an indicator that
    // has not been recomputed yet: shorten the price series and the indicator's
    // own series still holds the old, longer count until the next frame.
    //
    // That is not a cosmetic lag. `baseIndex` is what converts a logical range
    // into `rightOffset`, so a host that replaces its data and then positions
    // the viewport in the same turn -- entering replay does exactly that -- aims
    // at a right edge hundreds of bars past the end of the data and draws an
    // empty chart. Recomputing before the base index is read closes that window.
    //
    // The tick path is deliberately left deferred, which is where the coalescing
    // earns its keep: an appended bar makes the primary the longest series, so
    // the base index is already right with the indicator a bar behind, and a
    // burst of ticks between two frames still costs one recompute.
    if (dataId === this._firstDataId.value) {
      this._invalidateIndicators();
      this._flushIndicators();
    }
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    if (!this._hasFitContent && this._dataLayer.length > 0) {
      this._timeScale.setWidth(Math.max(0, this._width - this._rightAxisWidth - this._leftAxisWidth));
      this._hasFitContent = this._fitDefaultView();
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
    if (dataId === this._firstDataId.value) this.emit('data:update', { kind: 'reset' });
  }

  /** History paging: merge older bars, preserving the viewport (§4.2). */
  private _prependData(dataId: number, bars: readonly Bar[]): void {
    this._dataLayer.addBars(dataId, bars);
    const sorted = this._dataLayer.seriesBars(dataId);
    this._seriesProvenance.get(dataId)?.record('prepend', sorted[sorted.length - 1]?.time);
    // baseIndex shifts up by the inserted count; updating it keeps the same
    // bars on screen because (rightEdge − index) is invariant.
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    if (dataId === this._firstDataId.value) this._invalidateIndicators();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
    if (dataId === this._firstDataId.value) this.emit('data:update', { kind: 'prepend' });
  }

  /**
   * The render backend the chart is painting series with right now: what the
   * first pane was given, which is the `renderer` option unless its factory
   * declined (no WebGL2 on this device) and the 2D backend stood in, and
   * `canvas2d` from the moment a GPU backend degrades ('renderer:fallback').
   */
  public get rendererKind(): RenderBackendKind {
    return this._rendererKind ?? 'canvas2d';
  }

  /**
   * The name `rendererKind` shipped under; the same value.
   *
   * @deprecated Removed in 3.0.0. Use {@link Chart.rendererKind} (since 2.0.0), which reports the same backend.
   */
  public get renderer(): RenderBackendKind {
    return this.rendererKind;
  }

  /** A backend for one more pane, with the 2D one standing in for a refusal. */
  private _newBackend(): IRenderBackend {
    const backend = this._backendFactory() ?? resolveRenderBackend('canvas2d')();
    if (backend === null) throw new Error('openalgo-charts: the canvas2d render backend factory returned null');
    if (this._rendererKind === null) {
      this._rendererKind = backend.kind;
      // An explicit ask that the device could not honour. Once, at the first
      // pane, and only for an explicit kind: 'auto' promised nothing.
      if (this._requestedRenderer !== null && this._requestedRenderer !== 'auto' && backend.kind !== this._requestedRenderer) {
        // eslint-disable-next-line no-console
        console.warn(`openalgo-charts: render backend "${this._requestedRenderer}" is unavailable on this device; using "${backend.kind}"`);
      }
    }
    return backend;
  }

  /**
   * Leave the GPU backend for good. Every pane is switched in the same call
   * so the chart never paints half its panes on each path, later panes get
   * the 2D factory, and the frame that noticed is repainted on the new
   * backends (the one just painted went through the old backend's own 2D
   * path, so nothing was blank in between).
   */
  private _fallbackToCanvas2d(reason: RendererFallbackReason): void {
    const from = this.rendererKind;
    this._backendFactory = resolveRenderBackend('canvas2d');
    for (const pane of this._panes) pane.setBackend(this._newBackend());
    this._rendererKind = 'canvas2d';
    const event: RendererFallbackEvent = { from, to: 'canvas2d', reason };
    this.emit('renderer:fallback', event);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  private _addPane(weight = 1): Pane {
    const pane = new Pane(this._doc, this._newBackend());
    pane.weight = weight;
    // The first pane is the primary one and quotes the instrument by
    // construction: it is where `addSeries` puts a series that names no pane,
    // and it exists before any host has said what goes on it. Every later
    // pane is made for an indicator, so it holds its own units until a price
    // series lands on it (`_claimPricePane`), and inherits the chart-wide
    // defaults without the instrument's tick.
    if (this._panes.length === 0) {
      this._pricePanes.add(pane);
      this._primaryPane = pane;
    } else {
      // Independent of whether a host ever declares a tick. Most do not, and an
      // oscillator on a chart with no tick at all still has to print a reading
      // fine enough to compare against its own levels.
      for (const scale of pane.scales()) scale.setOptions({ minPrecision: NON_INSTRUMENT_PRECISION });
    }
    pane.priceScale.setPriceFormatter(this._priceFormatter);
    if (this._priceScaleOptions) pane.priceScale.setOptions(this._scalePatchFor(pane, this._priceScaleOptions));
    this._panes.push(pane);
    this._container.appendChild(pane.element);
    this._observeCanvases(pane, true);
    return pane;
  }

  /**
   * Set a custom price formatter for every pane's axis labels, last-price tag,
   * and price-line labels at runtime (e.g. switch to a currency format). Pass
   * null to restore the default tick-size-aware formatting.
   */
  public setPriceFormatter(fn: ((price: number) => string) | null): void {
    this._priceFormatter = fn;
    for (const pane of this._panes) pane.priceScale.setPriceFormatter(fn);
    // A per-series precision override outranks the chart-wide formatter on its
    // own scale, so re-assert it: the loop above just replaced it.
    for (const pane of this._panes) {
      for (const record of pane.series()) {
        if (record.style.precision !== undefined) this._applyPrecision(pane.scaleOf(record), record.style.precision);
      }
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /**
   * Set a custom time-axis + crosshair label formatter (UTC seconds -> string)
   * at runtime. Pass undefined to restore the IST default.
   */
  public setTimeFormatter(fn: ((utcSeconds: number, tickMark?: TickMarkType) => string) | undefined): void {
    this._timeFormatter = fn;
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /** The IANA zone the chart labels time in. */
  public timezone(): string {
    return this._timezone;
  }

  /**
   * Change the zone the time axis and crosshair label in, without rebuilding the
   * chart: a terminal switching from an NSE symbol to a US one needs exactly
   * this. Throws on a name the runtime does not recognise, rather than quietly
   * labelling in the old zone, because a chart showing the wrong hours is the
   * kind of wrong nobody notices until it costs money.
   */
  public setTimezone(zone: string): void {
    const next = checkedTimezone(zone);
    if (next === this._timezone) return;
    this._timezone = next;
    // Not only a relabelling: a session-anchored indicator (VWAP, CPR, TWAP,
    // seasonality) resets on the chart's calendar, so moving the calendar
    // changes the numbers and not just the axis under them.
    this._invalidateIndicators();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('timezone:changed', { timezone: next });
  }

  /**
   * Turn pointer gestures into anchor placement instead of panning. A host arms
   * this while a drawing tool is active: a press no longer scrolls the chart, and
   * a press-drag-release is reported as two `click` events (press point, then
   * release point, the latter tagged `viaDrag`) so a two-point shape can be drawn
   * in one gesture. `DrawingController` drives this for you.
   */
  public setPlacementMode(active: boolean): void {
    this._placementMode = active;
    if (active) cancelPick(this);
  }

  /**
   * Arm the next plot click to answer with a price, a bar time, or both as a
   * `'point'`, handed to `cb`. Returns a cancel function; arming another pick
   * on this chart cancels the pending one. `pick:start` and `pick:end` bracket
   * it so a host can show its own cursor while the pick is live. A target's
   * pane limits where the click counts and its scale is the one a price, a
   * point's included, is read on. See `input/pick` for why this does not touch
   * placement mode.
   */
  public beginPick(kind: 'point', cb: (value: PickPoint) => void, options?: PickOptions): PickHandle;
  public beginPick(kind: PickKind, cb: (value: number) => void, options?: PickOptions): PickHandle;
  public beginPick(kind: PickKind | 'point', cb: (value: never) => void, options: PickOptions = {}): PickHandle {
    if (this._destroyed || this._destroying) throw new Error('Cannot pick on a destroyed chart');
    if (this._placementMode) throw new Error('Finish drawing placement before picking a study value');
    if (options === null || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
      || Object.values(Object.getOwnPropertyDescriptors(options)).some(item => !('value' in item))) throw new TypeError('Invalid pick options');
    const fields = Object.getOwnPropertyDescriptors(options);
    const paneIndex = fields.paneIndex?.value as PickOptions['paneIndex'];
    const priceScaleId = fields.priceScaleId?.value as PickOptions['priceScaleId'];
    if (paneIndex !== undefined && (!Number.isSafeInteger(paneIndex) || paneIndex < 0 || !this._panes[paneIndex])) throw new RangeError('Invalid pick pane');
    const targetPane = paneIndex ?? (priceScaleId !== undefined ? this._firstPaneSlot() : undefined);
    if (priceScaleId !== undefined && (kind === 'time' || !this._validPriceScaleId(priceScaleId)
      || !Object.prototype.hasOwnProperty.call(this._panes[targetPane!]?.scaleStates() ?? {}, priceScaleId))) throw new RangeError('Invalid pick scale');
    return beginPickResolved(this, kind, cb as (value: number | PickPoint) => void, payload => {
      const click = payload as Partial<ChartClickEvent>, point = click?.point, index = click?.paneIndex;
      if (index === undefined || !Number.isSafeInteger(index) || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || click.viaDrag || (click.id !== undefined && click.id !== null) || (targetPane !== undefined && index !== targetPane)) return null;
      const pane = this._panes[index];
      const height = (this._paneLayout()[index]?.height ?? 0) - (index === this._bottomPaneIndex() ? this._timeAxisHeight : 0);
      if (!pane || point.x < this._leftAxisWidth || point.x >= this._width - this._rightAxisWidth || point.y < 0 || point.y >= height) return null;
      if (kind === 'time') return click.time ?? null;
      this._ensureScaled(index);
      const price = priceScaleId === undefined ? click.price ?? null
        : Object.prototype.hasOwnProperty.call(pane.scaleStates(), priceScaleId) ? pane.scaleFor(priceScaleId).yToPrice(point.y) : null;
      return kind === 'price' || price === null ? price : { time: click.time ?? Number.NaN, price };
    });
  }

  /** Swap the palette at runtime (dark/light toggle) without recreating the chart. */
  public setTheme(theme: ChartTheme): void {
    this._theme = theme;
    this._container.style.background = theme.background;
    // The rules are DOM, not paint: a frame does not recolour them.
    this._syncSeparators();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /**
   * Apply a subset of chart options at runtime (theme, grid, formatters,
   * crosshair mode) without recreating the chart.
   */
  public applyOptions(opts: {
    theme?: ChartTheme;
    grid?: Partial<GridOptions>;
    canvas?: CanvasOptions;
    statusLine?: LegendStatusLineOptions;
    legendIconSize?: number;
    priceScale?: Partial<PriceScaleOptions>;
    priceFormatter?: ((price: number) => string) | null;
    timeFormatter?: ((utcSeconds: number, tickMark?: TickMarkType) => string) | undefined;
    timezone?: string;
    crosshairMode?: CrosshairMode;
    crosshairSnapToBar?: boolean;
  }): void {
    this._withinLayoutChange(() => {
      if (opts.theme) this.setTheme(opts.theme);
      if (opts.grid) this.setGridOptions(opts.grid);
      if (opts.canvas) this.setCanvasOptions(opts.canvas);
      if (opts.statusLine) this.setStatusLineOptions(opts.statusLine);
      if (opts.legendIconSize !== undefined) this.setLegendIconSize(opts.legendIconSize);
      if (opts.priceScale) this.setPriceScaleOptions(opts.priceScale);
      if (opts.priceFormatter !== undefined) this.setPriceFormatter(opts.priceFormatter);
      if ('timeFormatter' in opts) this.setTimeFormatter(opts.timeFormatter);
      if (opts.timezone !== undefined) this.setTimezone(opts.timezone);
      if (opts.crosshairMode) this._crosshairMode = opts.crosshairMode;
      if (typeof opts.crosshairSnapToBar === 'boolean') {
        this._crosshairSnapToBar = opts.crosshairSnapToBar;
        this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
      }
    });
    this._layoutChanged('applyOptions');
  }

  public panes(): readonly Pane[] {
    return this._panes;
  }

  /**
   * Capture the chart's serialisable state: viewport, grid, crosshair mode,
   * pane weights and price scales, indicator instances, and a `drawings` slot
   * the drawing tier fills. JSON-safe.
   *
   * Series **data** is not captured — the app owns that (it knows the symbol,
   * the timeframe, and the feed). Series *descriptors* are, so an app that
   * rebuilds its own series can re-apply their styling and placement.
   */
  public getState(): ChartState & ChartSettingsState & { timezone: string } {
    const studyInputs = planIndicatorDependencies(this._indicators.map(item => item.dependencyNode())).dependencies;
    const panes: PaneState[] = this._panes.map((pane) => {
      const states = pane.scaleStates();
      for (const [instanceId, claim] of this._indicatorRanges) {
        if (claim.pane !== pane) continue;
        const scale = pane.scaleFor(claim.scaleId), token = this._ownedScaleRanges.get(scale);
        const ownership = token ? scale.ownedFixedRangeState(token) : null;
        if (ownership && states[claim.scaleId] && !states[claim.scaleId]!.indicatorRange) states[claim.scaleId]!.indicatorRange = { instanceId, manual: ownership.manual };
      }
      const { right, ...scales } = states;
      const state: PaneState = {
        weight: pane.weight,
        priceScale: right!,
      };
      if (Object.keys(scales).length) state.scales = scales;
      if (this._collapsed.has(pane)) state.collapsed = true;
      return state;
    });

    const series: SeriesState[] = [];
    this._panes.forEach((pane, paneIndex) => {
      for (const record of pane.series()) {
        const style = Object.fromEntries(Object.entries(record.style).filter(([, value]) => value !== undefined));
        series.push({ type: record.type, style, paneIndex, priceScaleId: record.scaleId });
      }
    });

    const primary = this._primaryIndex();
    const state: ChartState & ChartSettingsState & { timezone: string } = {
      // Version 2 only when the price pane has moved. Every pane index in a
      // state is a visual slot, and a reader older than `primaryPane` would
      // put the price pane's scales, studies and drawings on whatever pane
      // holds slot 0; refusing the newer version is the right answer for it.
      // A layout with the price pane in place is written exactly as it always
      // was, so every existing reader still opens it.
      version: primary > 0 ? CHART_STATE_VERSION : 1,
      // Saved unconditionally, including the default: a layout restored after
      // the default itself changes should still read the hours it was saved with.
      timezone: this._timezone,
      viewport: { ...this.getVisibleLogicalRange() },
      barSpacing: this._timeScale.barSpacing,
      navigation: this.navigationOptions(),
      grid: this.gridOptions(),
      // The settings dialog's own slice. It lives beside `grid` rather than
      // inside it because these are chart-wide overrides, and it is declared by
      // the settings module so `ChartState` stays the shape of the core.
      canvas: this.canvasOptions(),
      statusLine: this.statusLineOptions(),
      watermark: this.watermarkOptions(),
      trading: { ...this._tradingSettings },
      // The two switches, never the clock function: a callback does not survive
      // JSON, and the host that supplied one supplies it again on the way back.
      axisChrome: {
        sessionClock: this._axisChrome.sessionClock,
        barCountdown: this._axisChrome.barCountdown,
      },
      events: this.eventOptions(),
      crosshairMode: this._crosshairMode,
      crosshairSnapToBar: this._crosshairSnapToBar,
      priceOnlyAutoScale: this._priceOnlyAutoScale,
      indicatorLegendCollapsed: this._indicatorLegendCollapsed,
      panes,
      ...(primary > 0 ? { primaryPane: primary } : {}),
      series,
      indicators: this._indicators.map((i) => ({
        indicatorId: i.indicatorId,
        instanceId: i.id,
        settings: i.settings(),
        paneIndex: i.paneIndex,
        visible: i.visible(),
        ...(studyInputs.get(i.id)?.length ? { studyInputs: studyInputs.get(i.id)!.map(edge => edge.inputKey) } : {}),
        ...(i.priceScaleId() === null ? {} : { priceScaleId: i.priceScaleId()! }),
        ...(Object.keys(i.plotPriceScaleIds()).length ? { plotPriceScaleIds: i.plotPriceScaleIds() } : {}),
        // Restrictions only: an unrestricted study saves what it always did.
        ...(Object.keys(i.policy()).length ? { policy: { ...i.policy() } } : {}),
      })),
      ...(typeof this._sourceAbove === 'string' ? { sourceAbove: this._sourceAbove } : {}),
    };
    if (this._drawingState !== undefined) state.drawings = this._drawingState;
    if (this._alertState !== undefined) state.alerts = parseAlertsDocument(this._alertState);
    return state;
  }

  /**
   * Re-apply a state captured by `getState`. Restores grid, crosshair mode,
   * pane weights and price scales, indicators, and the viewport — everything
   * the chart is the source of truth for.
   *
   * It does **not** recreate series: the chart has no way to know their data.
   * The returned report lists the series descriptors it saw so the caller can
   * rebuild them (`addSeries(s.type, { paneIndex: s.paneIndex, style: s.style })`)
   * and then feed them.
   *
   * Restore the viewport *after* your data lands — logical ranges index bars, so
   * a range applied to an empty chart means nothing. Call `restoreState` again
   * (or `setVisibleLogicalRange`) once the series are populated.
   */
  public restoreState(state: unknown, options: ChartRestoreOptions = {}): RestoreReport {
    const s = state as (ChartState & ChartSettingsState & { timezone?: unknown }) | null;
    if (s === null || typeof s !== 'object' || typeof s.version !== 'number') {
      return { applied: false, series: [], indicators: 0, reason: 'not a chart state object' };
    }
    if (s.version > CHART_STATE_VERSION) {
      return { applied: false, series: [], indicators: 0, reason: `state version ${s.version} is newer than ${CHART_STATE_VERSION}` };
    }

    let alerts: AlertsDocument | undefined;
    let panes: PaneState[] | undefined;
    let primaryPane: number | undefined;
    let studies: PreparedIndicatorRestore | undefined;
    const preservedFormats = new Map<Pane, Set<PriceScaleId>>();
    const reservedIds = new Set<string>();
    try {
      const priceOnly = Object.getOwnPropertyDescriptor(s, 'priceOnlyAutoScale');
      if (priceOnly && (!('value' in priceOnly) || (priceOnly.value !== undefined && typeof priceOnly.value !== 'boolean'))) {
        throw new Error('Invalid price-only autoscale preference');
      }
      const collapsed = Object.getOwnPropertyDescriptor(s, 'indicatorLegendCollapsed');
      if (collapsed && (!('value' in collapsed) || (collapsed.value !== undefined && typeof collapsed.value !== 'boolean'))) {
        throw new Error('Invalid indicator legend preference');
      }
      const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
        && [Object.prototype, null].includes(Object.getPrototypeOf(value))
        && Object.values(Object.getOwnPropertyDescriptors(value)).every(property => 'value' in property);
      if (!plain(options)) throw new Error('Invalid chart restore options');
      if (options.preserveScaleFormats !== undefined) {
        const selectors = options.preserveScaleFormats;
        if (!Array.isArray(selectors)) throw new Error('Invalid preserved scale formats');
        const properties = Object.getOwnPropertyDescriptors(selectors);
        if (Reflect.ownKeys(properties).some(key => key !== 'length' && (typeof key !== 'string'
          || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= selectors.length
          || !('value' in properties[key])))) throw new Error('Invalid preserved scale formats');
        for (let index = 0; index < selectors.length; index++) {
          const selector = properties[index]?.value as unknown;
          if (!plain(selector) || typeof selector.paneIndex !== 'number' || !Number.isInteger(selector.paneIndex) || selector.paneIndex < 0
            || !this._validPriceScaleId(selector.scaleId)) throw new Error('Invalid preserved scale selector');
          const pane = this._panes[selector.paneIndex];
          if (!pane || !Object.prototype.hasOwnProperty.call(pane.scaleStates(), selector.scaleId)) {
            throw new Error('Preserved scale must already exist');
          }
          const ids = preservedFormats.get(pane) ?? new Set<PriceScaleId>();
          ids.add(selector.scaleId);
          preservedFormats.set(pane, ids);
        }
      }
      if (s.panes !== undefined) {
        if (!Array.isArray(s.panes)) throw new Error('Invalid pane list');
        panes = s.panes.map(pane => parsePaneState(pane, true));
      }
      // Checked with the rest, before anything is applied: a slot that names no
      // saved pane would put the price pane's scales on a study pane.
      const slot = Object.getOwnPropertyDescriptor(s, 'primaryPane');
      if (slot && (!('value' in slot) || slot.value !== undefined)) {
        const at: unknown = slot.value;
        if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || !(at < (panes?.length ?? 0))) throw new Error('Invalid primary pane slot');
        // The same rule a workspace document enforces: a version 1 reader
        // trusts the version and would lay the price pane's scales on slot 0.
        if (s.version < 2) throw new Error('A moved price pane needs chart version 2');
        // The one switch: a chart that did not opt in keeps its price pane on
        // top, and a layout that moved it would put every slot on the wrong pane.
        if (at > 0 && !this._movablePrimaryPane) throw new Error('A moved price pane needs movablePrimaryPane');
        primaryPane = at;
      }
      if (s.alerts !== undefined) alerts = parseAlertsDocument(s.alerts);
      if (s.sourceAbove !== undefined && (typeof s.sourceAbove !== 'string' || !s.sourceAbove.trim())) throw new Error('Invalid source placement');
      if (s.indicators !== undefined) {
        if (!Array.isArray(s.indicators)) throw new Error('Invalid indicator list');
        for (const spec of s.indicators) {
          if ('plotPriceScaleIds' in spec) {
            const property = Object.getOwnPropertyDescriptor(spec, 'plotPriceScaleIds');
            if (!property?.enumerable || !('value' in property)) throw new Error('Invalid indicator plot price scale map field');
          }
          if (spec.priceScaleId !== undefined && !this._validPriceScaleId(spec.priceScaleId)) throw new Error('Invalid indicator price scale');
          if (spec.instanceId === undefined) continue;
          if (typeof spec.instanceId !== 'string' || !spec.instanceId.trim() || reservedIds.has(spec.instanceId)) {
            throw new Error('Invalid or duplicate indicator instance id');
          }
          reservedIds.add(spec.instanceId);
        }
        this._reserveAlertStudyIds(alerts, reservedIds);
        const used = new Set([...reservedIds, ...this._indicatorReservedIds, ...this._indicators.map(item => item.id)]);
        const specs = s.indicators.map(spec => ({ ...spec, settings: cloneIndicatorSettings(spec.settings ?? {}),
          ...(spec.policy === undefined ? {} : { policy: parseIndicatorPolicy(spec.policy) }) }));
        // Missing producers remain reserved even when no descriptor can recreate them.
        for (const spec of specs) for (const value of Object.values(spec.settings)) {
          if (value && typeof value === 'object' && 'kind' in value && value.kind === 'indicator'
            && 'instanceId' in value && typeof value.instanceId === 'string') {
            used.add(value.instanceId);
            reservedIds.add(value.instanceId);
          }
        }
        let generated = 0;
        for (const spec of specs) {
          if (spec.instanceId === undefined) {
            do { spec.instanceId = `restored-study-${++generated}`; } while (used.has(spec.instanceId));
            used.add(spec.instanceId);
          }
          reservedIds.add(spec.instanceId);
        }
        const descriptors = new Map(specs.filter(spec => hasIndicator(spec.indicatorId))
          .map(spec => [spec.instanceId!, getIndicator(spec.indicatorId)]));
        const nodes = specs.flatMap(spec => {
          const descriptor = descriptors.get(spec.instanceId!);
          if (descriptor && spec.plotPriceScaleIds !== undefined) {
            spec.plotPriceScaleIds = parseIndicatorPlotPriceScales(descriptor, spec.plotPriceScaleIds);
          }
          if (descriptor) {
            validateIndicatorInputs(descriptor.inputs, spec.settings);
            // Against the slot the price pane will hold once the layout lands:
            // an old layout puts it at the top, a partial one leaves it be.
            validateIndicatorScaleAssignment(descriptor, spec.priceScaleId, spec.plotPriceScaleIds, spec.paneIndex,
              panes === undefined ? this._primaryIndex() : primaryPane ?? 0);
          }
          return descriptor ? [{ id: spec.instanceId!, descriptor, settings: spec.settings }] : [];
        });
        studies = { specs, order: planIndicatorDependencies(nodes).order, descriptors };
      }
    } catch (error) {
      return { applied: false, series: [], indicators: 0, reason: error instanceof Error ? error.message : 'Invalid saved alerts or identities' };
    }
    // Restore callbacks may add studies before the saved layout is applied.
    this._reserveAlertStudyIds(alerts, reservedIds);
    for (const id of reservedIds) this._indicatorReservedIds.add(id);
    const generation = ++this._restoreGeneration;
    const previousPriceOnly = this._priceOnlyAutoScale;
    const previousLegendCollapsed = this._indicatorLegendCollapsed;
    this.emit('state:restore:start', {});
    const before = this._timeScale.visibleRange();
    try {
      // A start listener can synchronously install a newer layout on this chart.
      if (generation !== this._restoreGeneration) {
        return { applied: false, series: [], indicators: 0, reason: 'superseded by a newer chart restore' };
      }
      // The layout setters a restore calls are the restore, which the start
      // and end events announce; they do not each fire `layout:change`.
      const report = this._withinLayoutChange(() =>
        this._mutateTimeScale(() => this._restoreState(s, alerts, reservedIds, panes, primaryPane ?? 0, studies, preservedFormats)));
      if (report.applied && generation === this._restoreGeneration && (previousPriceOnly !== this._priceOnlyAutoScale
        || previousLegendCollapsed !== this._indicatorLegendCollapsed)) {
        this.emit('objects:change', {});
      }
      return report;
    }
    finally {
      preservedFormats.clear();
      // Restore listeners can replace the viewport after its last internal paint.
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      this._emitViewportIfMoved(before);
      this.emit('state:restore:end', {});
    }
  }

  private _restoreState(s: ChartState & ChartSettingsState & { timezone?: unknown }, alerts: AlertsDocument | undefined,
    reservedIds: Set<string>, panes: PaneState[] | undefined, primaryPane: number, studies: PreparedIndicatorRestore | undefined,
    preservedFormats: PreservedScaleFormats): RestoreReport {

    // Old locks describe the outgoing ranges, not the settings about to be restored.
    if (panes) for (const pane of this._panes) pane.clearRatioLocks();

    if (s.grid) this.setGridOptions(s.grid);
    // Canvas before the panes: its margins are chart-wide, and a pane's own
    // saved marginTop/marginBottom is the more specific answer, so it must land
    // last and win.
    if (s.canvas) this.setCanvasOptions(s.canvas);
    if (s.statusLine) this.setStatusLineOptions(s.statusLine);
    if (s.watermark) this.setWatermarkOptions(s.watermark);
    if (s.trading) this.setTradingSettings(s.trading);
    if (s.axisChrome) this.setAxisChromeOptions(s.axisChrome);
    if (s.navigation && typeof s.navigation === 'object') this._patchNavigation(s.navigation);
    if (s.events) this.setEventOptions(s.events);
    if (s.crosshairMode) this._crosshairMode = s.crosshairMode;
    if (typeof s.crosshairSnapToBar === 'boolean') this._crosshairSnapToBar = s.crosshairSnapToBar;
    const priceOnly = Object.getOwnPropertyDescriptor(s, 'priceOnlyAutoScale');
    if (priceOnly && typeof priceOnly.value === 'boolean') this._priceOnlyAutoScale = priceOnly.value;
    const collapsed = Object.getOwnPropertyDescriptor(s, 'indicatorLegendCollapsed');
    if (collapsed && typeof collapsed.value === 'boolean') this._indicatorLegendCollapsed = collapsed.value;
    this._restackLegends();
    // A saved zone is data of unknown provenance, so an unrecognised name is
    // skipped rather than thrown: the rest of the layout is still restorable,
    // and a whole saved workspace should not be lost to one stale zone name.
    if (typeof s.timezone === 'string' && isValidTimezone(s.timezone)) this.setTimezone(s.timezone);

    // The panes themselves first: the indicators below are placed by index, so
    // the panes have to exist and be weighted before they are rebuilt. Their
    // price scales are *not* set here, see below. The price pane goes to its
    // saved slot before anything is applied by index, and a layout that names
    // no slot is one from before the price pane could move: its slot is 0.
    if (panes) {
      for (let i = 0; i < panes.length; i++) this._ensurePane(i);
      this.setPrimaryPaneIndex(primaryPane);
      panes.forEach((ps, i) => { this._panes[i].weight = ps.weight; });
    }
    if (panes || studies) {
      // A layout that does not fold a pane opens it, and the price pane never
      // folds, in whatever slot. That covers a pane it does not list at all:
      // rebuilt studies land on the existing panes and would otherwise open
      // inside a stale strip.
      this._panes.forEach((pane, i) => {
        if (pane !== this._primaryPane && panes?.[i]?.collapsed) this._collapsed.add(pane);
        else this._collapsed.delete(pane);
      });
      this._relayout();
      this._rehomeAnchored();
    }

    // Indicators are fully derivable from the source data, so they *can* be
    // recreated. Replace rather than append, so restore is idempotent.
    let indicators = 0;
    if (studies) {
      this._indicatorRefreshes.clear();
      // A restore is the host's act: it replaces a protected study as well.
      for (const instance of this._indicators.splice(0)) instance.remove({ force: true });
      const byId = new Map(studies.specs.map(spec => [spec.instanceId!, spec]));
      for (const id of studies.order) {
        const spec = byId.get(id)!;
        const descriptor = studies.descriptors.get(id)!;
        const instance = new IndicatorInstance(
          this._indicatorHost(preservedFormats), descriptor, spec.settings, spec.paneIndex,
          spec.instanceId, reservedIds, spec.priceScaleId, spec.plotPriceScaleIds, spec.policy,
        );
        reservedIds.add(instance.id);
        this._indicators.push(instance);
        if (spec.visible === false) instance.setVisible(false);
        indicators += 1;
      }
      const display = new Map(studies.specs.map((spec, index) => [spec.instanceId!, index]));
      this._indicators.sort((a, b) => display.get(a.id)! - display.get(b.id)!);
      // With the studies it is read with: a layout from before the source could
      // move says nothing, and the source stays behind the studies just made.
      this._sourceAbove = s.sourceAbove;
      this._reorderIndicatorResources();
    }

    // Price scales last of all, for the same reason the canvas block goes
    // first: this is the most specific answer for each pane, and everything
    // above moves ranges around. Rebuilding an indicator in particular takes a
    // pane's axis with it, so a scale restored before that step is a scale the
    // restore then throws away.
    const ratioLocks: { pane: Pane; id: PriceScaleId; reference: NonNullable<PriceScaleState['ratioLock']> }[] = [];
    if (panes) {
      panes.forEach((ps, i) => {
        const pane = this._panes[i];
        if (pane === undefined) return;
        const entries = [['right', ps.priceScale], ...Object.entries(ps.scales ?? {})] as [PriceScaleId, PriceScaleState][];
        pane.restoreAxisPlacements(new Map(entries.flatMap(([id, saved]) => saved.placement ? [[id, saved.placement] as const] : [])));
        for (const [id, saved] of entries) {
          const scale = pane.scaleFor(id);
          const options: Partial<PriceScaleOptions> = {
            marginTop: saved.marginTop, marginBottom: saved.marginBottom, minMove: saved.minMove,
            mode: saved.mode, inverted: saved.inverted,
          };
          if (saved.minPrecision !== undefined) options.minPrecision = saved.minPrecision;
          // Legacy snapshots may carry an instrument tick broadcast into an oscillator.
          // New snapshots explicitly preserve the precision configured on each scale.
          scale.setOptions(id === 'right' && saved.minPrecision === undefined ? this._scalePatchFor(pane, options) : options);
          const claim = saved.indicatorRange ? this._indicatorRanges.get(saved.indicatorRange.instanceId) : undefined;
          const ownDefault = claim && claim.pane === pane && claim.scaleId === id
            && saved.fixedRange?.min === claim.range.min && saved.fixedRange?.max === claim.range.max;
          if (ownDefault) {
            if (!scale.ownsFixedRange(claim.token)) {
              scale.setFixedRange(null);
              scale.setAutoScale(true);
              scale.setOwnedFixedRange(claim.token, claim.range);
              this._ownedScaleRanges.set(scale, claim.token);
            }
            scale.setAutoScale(true);
            if (saved.indicatorRange!.manual) {
              scale.setAutoScale(false);
              if (saved.range) scale.setPriceRange(saved.range);
            }
          } else {
            if (saved.fixedRange !== undefined) scale.setFixedRange(saved.fixedRange);
            scale.setAutoScale(saved.autoScale);
            if (!saved.autoScale && saved.range) scale.setPriceRange(saved.range);
          }
          if (saved.ratioLock) ratioLocks.push({ pane, id, reference: saved.ratioLock });
        }
      });
    }

    // Drawings name panes by slot, in the layout the state describes, which is
    // the one standing now. They go on before the pruning below, so a pane the
    // restore then empties and removes shifts them with every other pane
    // (`paneRemoved`) instead of leaving them on slots that have moved. The
    // case that needs it: a host that swaps studies keeps its drawings, and a
    // study pane above the price pane empties, which moves the price pane up.
    this._drawingState = s.drawings;
    this.emit('drawings:restore', s.drawings ?? []);

    // Unavailable studies leave empty panes, but a live study can have no plot
    // series. Keep its pane and host primitives; chart furniture alone does not
    // occupy a pane. Walk backwards so removal keeps the remaining indices valid.
    // A study pane above the price pane is as prunable as one below it.
    for (let i = this._panes.length - 1; i >= 0; i--) {
      const pane = this._panes[i];
      if (pane !== this._primaryPane && pane.series().length === 0 && !this._indicators.some(study => study.paneIndex === i)
        && pane.primitives().every(primitive => primitive === this._timeNav || this._anchored.some(entry => entry.primitive === primitive))) this.removePane(i);
    }

    this._alertState = alerts;
    this._recomputeAxisColumns();
    if (s.barSpacing !== undefined) this._timeScale.setBarSpacing(s.barSpacing);
    if (s.viewport && this._dataLayer.length > 0) this.setVisibleLogicalRange(s.viewport);
    // Lock references belong to the saved geometry. Applying them after pane pruning
    // and viewport restoration prevents intermediate layouts from scaling the range twice.
    for (const { pane, id, reference } of ratioLocks) {
      if (this._panes.includes(pane)) pane.setRatioLock(id, true, reference.barSpacing, reference.height);
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('alerts:restore', alerts ?? { version: 1, alerts: [] });
    this.emit('objects:change', {});
    return { applied: true, series: s.series ?? [], indicators };
  }

  /**
   * The opaque `drawings` slot in the chart state. The base engine only
   * round-trips it; the drawing tier reads and writes it.
   */
  public drawingState(): unknown {
    return this._drawingState;
  }

  public setDrawingState(value: unknown): void {
    this._drawingState = value;
    this.emit('objects:change', {});
  }

  /**
   * A price rounded to the tick the pane's own axis is written with, or, on
   * the price pane of an instrument with a tick schedule, to the tick of the
   * band the price falls in.
   *
   * A dragged alert's price comes from a pointer, and a pixel maps to a price
   * with a dozen decimals behind it: dropped where the axis reads 1255.90 it
   * was stored as 1255.8706204379562, a price the instrument cannot trade at
   * and a number nothing in the interface could show. The scale already knows
   * the tick, because it is the one the axis is written with, so this is the
   * chart's answer rather than something every host works out again.
   *
   * A scale holds one tick, and with a schedule that is the grid every band
   * lies on: 105.87 is on a 0.01 grid and still no price in a 0.25 band. So
   * the price pane, whose prices are the instrument's, asks the schedule.
   * Another pane is in a study's own units, which no schedule describes.
   *
   * A scale with no declared tick rounds nothing: there is no tick to round to
   * and inventing one would move a price somebody chose.
   */
  public snapPrice(paneIndex: number, price: number): number {
    if (!Number.isFinite(price)) return price;
    if (this._tickSchedule !== null && paneIndex === this._primaryIndex()) return this._tickSchedule.round(price);
    const step = this._panes[paneIndex]?.priceScale.options.minMove ?? 0;
    return step > 0 ? roundToTick(price, step) : price;
  }

  /**
   * The instrument's tick schedule, or null for a constant tick, the default.
   * `Instrument.applyTo` sets it from the instrument's `tickBands`.
   */
  public tickSchedule(): TickSchedule | null {
    return this._tickSchedule;
  }

  /**
   * Hand the chart the instrument's price-dependent ticks, for a host that
   * keeps its own instrument metadata rather than calling
   * `Instrument.applyTo`. Price alerts and anything else rounding through
   * {@link snapPrice} on the price pane then land in the band a price falls
   * in, and the trading layer's order and bracket drags take the same
   * schedule, now or when it is built. Null restores the constant tick. It
   * describes the loaded instrument, so it is not part of the saved state.
   */
  public setTickSchedule(schedule: TickSchedule | null): void {
    // Refused here, where the host made the mistake, rather than on the first
    // drag: a dragged price rounds with `round`, and a range bound pushed past
    // the opposite one backs off with `step`.
    const given = schedule as Partial<TickSchedule> | null | undefined;
    if (given != null && (typeof given.round !== 'function' || typeof given.step !== 'function')) {
      throw new TypeError('chart.setTickSchedule takes a schedule built with new TickSchedule(bands), or null');
    }
    this._tickSchedule = schedule ?? null;
    this._trading?.setTickSchedule(this._tickSchedule);
  }

  /** Detached JSON state, also available when no alert controller is attached. */
  public alertState(): AlertsDocument | undefined {
    return this._alertState === undefined ? undefined : parseAlertsDocument(this._alertState);
  }

  /** Runtime snapshot. JSON safety of opaque payloads is checked when state is read. */
  public setAlertState(document: AlertsDocument | undefined): void {
    if (document !== undefined) {
      if (document.version !== 1) throw new Error('Unsupported alert document');
      for (const alert of document.alerts) validateAlert(alert);
    }
    this._alertState = document === undefined ? undefined : { version: 1, alerts: document.alerts.map(copyAlert) };
    this._reserveAlertStudyIds(this._alertState, this._indicatorReservedIds);
  }

  private _reserveAlertStudyIds(document: AlertsDocument | undefined, reserved: Set<string>): void {
    // Missing anchors must stay missing when a later study is allocated an ID.
    for (const { source } of document?.alerts ?? []) {
      if (source.kind === 'indicator') reserved.add(source.instanceId);
      else if (source.kind === 'drawing' && source.input) reserved.add(source.input.instanceId);
    }
  }

  public invalidate(build: (mask: InvalidateMask) => void): void {
    if (this._pending === null) this._pending = new InvalidateMask();
    build(this._pending);
    if (this._scaleMutationDepth === 0) this._loop.requestFrame();
  }

  /**
   * Measure the container once more, a frame after construction.
   *
   * The size read in the constructor is only what the browser has resolved so
   * far. A chart created from a script that runs before the flex/grid layout
   * settles measures a pre-layout box, lays its panes into it, and then hears
   * the *same* stale contentRect from the ResizeObserver in that frame, so
   * nothing corrects it until an unrelated resize: the reported symptom is a
   * large empty band under the chart that a refresh makes go away.
   *
   * Only a real measurement is allowed to win. Zero or absent means a container
   * that is hidden or not in the document yet, and overwriting a size the host
   * applied by hand with that would be a worse bug than the one being fixed;
   * the ResizeObserver still picks such a container up when it appears.
   */
  private _remeasure(): void {
    if (this._panes.length === 0) return; // destroyed before the frame ran
    const width = this._container.clientWidth;
    const height = this._container.clientHeight;
    if (!(width > 0) || !(height > 0)) return;
    this.applySize(width, height);
    // Inside an animation frame callback: a frame requested now runs in the
    // next one, after this one has shown the canvases the resize cleared.
    this._paintNow();
  }

  public applySize(width: number, height: number): void {
    if (width === this._width && height === this._height) return;
    this._width = width;
    this._height = height;
    this._relayout();
    // Hidden tabs can receive history before they have any usable plot width.
    if (!this._hasFitContent) this._hasFitContent = this._fitDefaultView();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('resize', { width, height });
  }

  /**
   * Distribute height across panes by weight; sync the shared time-scale width.
   *
   * `geometryOnly` sizes the layout arithmetic (pane boxes, scale heights, the
   * time-scale width) and leaves the DOM and the canvases alone. The vector
   * export uses it to paint at a size that is not the screen's and then to put
   * the screen's back, without clearing a canvas or moving a flex box on the
   * way through.
   */
  private _relayout(geometryOnly = false): void {
    this._measureAxisColumns();
    if (!geometryOnly) {
      this._syncTimeNavPane();
      // Weights just changed, so the pane at the chart's top may have too.
      this._restackLegends();
    }
    const dpr = this._pixelRatio();
    if (!geometryOnly) this._layoutRatio = dpr;
    const layout = this._paneLayout();
    const bottomPane = this._bottomPaneIndex();
    this._panes.forEach((pane, paneIndex) => {
      const h = layout[paneIndex].height;
      if (geometryOnly) pane.setLayoutSize(this._width, h);
      else {
        // No share means gone, not merely short: a zero-height box still paints
        // its separator hairline, and its canvases still answer hit tests.
        pane.element.style.display = this._layoutWeight(paneIndex) > 0 ? '' : 'none';
        // The DOM box is given the SAME pixel height the canvas is sized to,
        // rather than a flex ratio. With `flex: w 1 0` the browser distributed the
        // container's *real* height while the canvas used `this._height`, so any
        // drift between the two (a container that resized before the observer
        // fired) silently offset every hit-test from what was drawn: pane
        // boundaries, legend buttons, and crosshair mapping all landed elsewhere.
        // Deriving both from one number makes layout == hit-test by construction.
        pane.element.style.flex = `0 0 ${h}px`;
        pane.resize(this._width, h, dpr);
      }
      // Scale height is a layout property (see Pane.setScaleHeights). A strip's
      // scales span the strip, so nothing measured against them reaches below it.
      pane.setScaleHeights(Math.max(0, h - (paneIndex === bottomPane ? this._timeAxisHeight : 0)));
    });
    if (!geometryOnly) this._syncSeparators();
    this._timeScale.setWidth(Math.max(0, this._width - this._rightAxisWidth - this._leftAxisWidth));
  }

  /**
   * A hairline between stacked panes: over every pane but the one against the
   * chart's top, a whole number of device pixels tall. It sits on the DOM box,
   * so it is exactly on the boundary the user drags.
   */
  private _syncSeparators(): void {
    const height = hairlineHeight(this._pixelRatio());
    const topPane = this._topPaneIndex();
    this._panes.forEach((pane, i) => pane.setSeparator(height, i === topPane ? null : this._theme.paneSeparator));
  }

  /**
   * Reserve the chart-wide axis columns: a left one as soon as any pane has a
   * left price scale in use, and the right one unless every scale in use has
   * moved off it. A chart with nothing on any scale keeps its right column,
   * which is where an empty chart's ladder belongs; the columns are chart-wide
   * rather than per pane because the panes share one time axis and their plots
   * have to start and end at the same x.
   */
  private _recomputeAxisColumns(): void {
    const before = [this._leftAxisWidth, this._rightAxisWidth, this._axisColumnWidth];
    this._measureAxisColumns();
    if (before[0] === this._leftAxisWidth && before[1] === this._rightAxisWidth && before[2] === this._axisColumnWidth) return;
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  private _measureAxisColumns(): void {
    let left = 0, right = 0;
    this._emptyPriceAxis = !this._panes.some(pane => pane.series().length > 0
      || pane.primitives().some(primitive => pane.primitiveScaleId(primitive) !== null));
    for (const pane of this._panes) {
      const axes = pane.visibleAxes(this._emptyPriceAxis);
      left = Math.max(left, axes.filter(axis => axis.side === 'left').length);
      right = Math.max(right, axes.filter(axis => axis.side === 'right').length);
    }
    this._axisColumnWidth = Math.max(0, Math.min(this._priceAxisWidth, this._width / (left + right + 1)));
    this._leftAxisWidth = left * this._axisColumnWidth;
    this._rightAxisWidth = right * this._axisColumnWidth;
  }

  /**
   * The share of the chart a pane gets. While one pane is maximized it takes
   * everything and the rest take nothing, so they lay out at zero height and
   * are hidden outright rather than collapsed to a sliver. A sliver still
   * paints a strip of squeezed candles and a separator hairline above the very
   * pane the user asked to see on its own.
   *
   * Stored weights are never touched, so restoring is exact and `getState`
   * cannot persist a placeholder.
   */
  private _layoutWeight(index: number): number {
    const pane = this._panes[index];
    if (pane === undefined) return 0;
    if (this._maximizedPane === null) return pane.weight;
    return index === this._maximizedPane ? 1 : 0;
  }

  /** First pane with a share of the chart: the one that sits against the top edge. */
  private _topPaneIndex(): number {
    for (let i = 0; i < this._panes.length; i++) if (this._layoutWeight(i) > 0) return i;
    return 0;
  }

  /**
   * Last pane with a share of the chart: the one that owns the time axis, even
   * as a strip, so the axis stays at the foot of the chart. `open` asks for the
   * last one with a plot instead, which is where chart furniture belongs.
   */
  private _bottomPaneIndex(open = false): number {
    for (let i = this._panes.length - 1; i >= 0; i--) if (this._layoutWeight(i) > 0 && !(open && this._collapsedShown(i))) return i;
    return this._panes.length - 1;
  }

  /** Drawn as a strip right now: a maximized pane shows whole whatever it is set to. */
  private _collapsedShown(index: number): boolean {
    return this._maximizedPane === null && this._collapsed.has(this._panes[index]);
  }

  /** Grab tolerance around a pane boundary, in media px. */
  private static readonly DIVIDER_GRAB = 4;

  /**
   * The two panes a press at `y` resizes, or null. Boundary `i` separates pane
   * `i` from pane `i + 1`; the last pane's bottom is the chart edge and is not
   * draggable. A strip keeps its height, so a boundary beside one moves height
   * between the nearest open panes either side of it. A pane hidden behind a
   * maximized one is never a side: dragging it would rewrite a weight nobody
   * can see.
   */
  private _dividerAt(y: number): [number, number] | null {
    const layout = this._paneLayout();
    const sizable = (i: number): boolean => this._layoutWeight(i) > 0 && !this._collapsedShown(i);
    for (let i = 0; i < layout.length - 1; i++) {
      if (Math.abs(y - layout[i].top - layout[i].height) > Chart.DIVIDER_GRAB) continue;
      let a = i, b = i + 1;
      while (a >= 0 && !sizable(a)) a--;
      while (b < layout.length && !sizable(b)) b++;
      if (a >= 0 && b < layout.length) return [a, b];
    }
    return null;
  }

  /**
   * Set a pane's relative height weight. Panes share the chart height in
   * proportion to their weights, so only the ratio matters.
   */
  public setPaneWeight(index: number, weight: number): void {
    const pane = this._panes[index];
    if (pane === undefined) return;
    pane.weight = Math.max(0.05, weight);
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._layoutChanged('setPaneWeight');
  }

  public paneWeight(index: number): number {
    return this._panes[index]?.weight ?? 0;
  }

  /**
   * Remove a pane, everything drawn in it, and any indicator that lives there.
   * The primary price pane is never removable, in whatever slot it sits:
   * removing it would leave the chart with no price series to describe and
   * nothing for a series, a price line or an on-chart study to default to. A
   * study pane is removable in any slot, the top one included.
   *
   * Returns false when the index is out of range or names the primary pane,
   * and when it holds a study whose policy is not `removable` unless
   * `options.force` is set.
   */
  public removePane(index: number, options: IndicatorEditOptions = {}): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this._panes.length || this._panes[index] === this._primaryPane) return false;
    if (this._indicators.some(study => study.paneIndex === index && !this._policyAllows(study, 'removable', options))) return false;
    if (this._eventPane === index) {
      // The strip goes home to the price pane, before the slots shift.
      const home = this._primaryIndex();
      if (this._eventMarkers !== null) {
        this.removePrimitive(this._eventMarkers);
        this._addPrimitive(home, this._eventMarkers);
        this.emit('events:change', undefined);
      }
      this._eventPane = home;
    }
    if (this._eventPane > index) this._eventPane -= 1;
    // Indicators own their series, so let them tear themselves down first —
    // otherwise their series rows would outlive the pane holding them.
    for (let i = this._indicators.length - 1; i >= 0; i--) {
      if (this._indicators[i].paneIndex !== index) continue;
      const [instance] = this._indicators.splice(i, 1);
      instance.remove({ force: true });
    }
    const pane = this._panes[index];
    for (const record of [...pane.series()]) {
      pane.removeSeries(record);
      this._dataLayer.removeSeries(record.dataId);
      this._seriesProvenance.delete(record.dataId);
      if (this._firstDataId.value === record.dataId) this._firstDataId.value = null;
    }
    this._observeCanvases(pane, false);
    pane.destroy();
    this._panes.splice(index, 1);
    // Keep the maximize target on the pane it named. Removing the maximized
    // pane leaves nothing maximized; removing one above it shifts it up. Left
    // alone, the index would point at whichever pane inherited the slot and
    // the wrong one would fill the chart.
    if (this._maximizedPane !== null) {
      if (this._maximizedPane === index) this._maximizedPane = null;
      else if (this._maximizedPane > index) this._maximizedPane -= 1;
    }
    // Indicators below the removed pane shift up one.
    for (const indicator of this._indicators) {
      if (indicator.paneIndex > index) indicator.shiftPane(-1);
    }
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    this._recomputeAxisColumns();
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._rehomeAnchored();
    this._syncLegendPanes();
    this._remapSavedDrawings(slot => slot === index ? null : slot > index ? slot - 1 : slot);
    this.emit('paneRemoved', { paneIndex: index });
    return true;
  }

  /**
   * Keep the saved drawings' slots in step with a pane that moved or went,
   * for the draw tier that has not loaded yet: it reads them from
   * `drawingState()` whenever it arrives, and a stale slot would put a drawing
   * on the wrong pane or recreate one that is gone. The slot is the draw
   * tier's document and opaque here, so only its pane field is touched, on a
   * copy, and a drawing on a removed pane goes with it, as the tier drops it.
   * A tier that is listening writes its own document right after the event.
   */
  private _remapSavedDrawings(map: (slot: number) => number | null): void {
    const saved = this._drawingState as { drawings?: unknown } | unknown[] | null | undefined;
    const list = Array.isArray(saved) ? saved : Array.isArray(saved?.drawings) ? saved.drawings as unknown[] : null;
    if (list === null) return;
    const next = list.flatMap(entry => {
      // An entry without a pane is on pane 0, the way the draw tier reads it.
      const slot = (entry as { paneIndex?: unknown } | null)?.paneIndex ?? 0;
      if (typeof entry !== 'object' || entry === null || !Number.isInteger(slot)) return [entry];
      const to = map(slot as number);
      return to === null ? [] : to === slot ? [entry] : [{ ...entry, paneIndex: to }];
    });
    this._drawingState = Array.isArray(saved) ? next : { ...saved, drawings: next };
  }

  /**
   * Move a pane up or down one slot, swapping it with its neighbour.
   *
   * By default the primary price pane is pinned at the top, as it always was:
   * a move that would take it off slot 0, or put a study pane above it, is
   * refused, so a host that means the price pane when it passes 0 keeps
   * meaning it. With `movablePrimaryPane` on, any pane moves, the price pane
   * included, and any pane can displace it: the price pane is then an identity
   * rather than a slot (see `primaryPaneIndex`), and everything that means
   * "the price pane" follows it. Returns false for an unknown slot, a
   * direction other than -1 or 1, a move off either end, or a pinned price pane.
   */
  public movePane(index: number, direction: -1 | 1): boolean {
    const target = index + direction;
    if ((direction !== -1 && direction !== 1) || !Number.isInteger(index)
      || index < 0 || target < 0 || index >= this._panes.length || target >= this._panes.length) return false;
    const panes = this._panes;
    if (!this._movablePrimaryPane && (panes[index] === this._primaryPane || panes[target] === this._primaryPane)) return false;
    // Before the event, so a drawing tier listening to it writes over this with its own.
    this._remapSavedDrawings(slot => slot === index ? target : slot === target ? index : slot);
    [panes[index], panes[target]] = [panes[target], panes[index]];
    if (this._eventPane === index) this._eventPane = target;
    else if (this._eventPane === target) this._eventPane = index;
    if (this._eventMarkers !== null) this.emit('events:change', undefined);
    // The target names a slot, and the two panes just swapped slots.
    if (this._maximizedPane === index) this._maximizedPane = target;
    else if (this._maximizedPane === target) this._maximizedPane = index;
    for (const indicator of this._indicators) {
      if (indicator.paneIndex === index) indicator.shiftPane(direction);
      else if (indicator.paneIndex === target) indicator.shiftPane(-direction);
    }
    // Re-append in the new order so the DOM matches the pane array.
    for (const pane of panes) this._container.appendChild(pane.element);
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._rehomeAnchored();
    this._syncLegendPanes();
    this.emit('paneMoved', { from: index, to: target });
    return true;
  }

  /**
   * Where the primary price pane sits in the stack, counted from the top. The
   * primary pane is the one the chart is built with. It holds the price series
   * a host adds without naming a pane and the on-chart studies, and it is what
   * every call that defaults to "the price pane" means: `addSeries`,
   * `addPriceLine`, `addEventMarkers`, `addPrimitive`, `tradeHost`, the
   * coordinate calls, comparisons, and a drawing magnet or price alert. It is
   * 0 until something moves it, and always 0 on a chart without
   * `movablePrimaryPane`; it is never removed and never collapsed.
   */
  public primaryPaneIndex(): number {
    return this._primaryIndex();
  }

  /**
   * Move the primary price pane to another slot, for example below its
   * studies. It goes one adjacent move at a time, so each step is an ordinary
   * `movePane` with its own `paneMoved` event: drawings, alerts and anything a
   * host keys by slot follow it the way they follow any other move. Weights,
   * scales, a fold or a maximize stay with the panes that own them. Returns
   * false for a slot that does not exist or the slot it already holds, and
   * always false on a chart built without `movablePrimaryPane`, where the price
   * pane stays at the top: that option is the one switch for every move.
   */
  public setPrimaryPaneIndex(index: number): boolean {
    if (this._destroyed || !this._movablePrimaryPane || !Number.isInteger(index) || index < 0 || index >= this._panes.length) return false;
    let at = this._primaryIndex();
    if (at === index) return false;
    // A `paneMoved` listener may itself move panes, so the walk follows the
    // pane rather than counting steps, and gives up rather than chase one
    // that keeps moving it back.
    for (let steps = 0; at !== index; steps++) {
      if (steps > 2 * this._panes.length || !this.movePane(at, index > at ? 1 : -1)) return false;
      at = this._primaryIndex();
    }
    return true;
  }

  /** The primary pane's slot; 0 once the chart is torn down and there are no panes. */
  private _primaryIndex(): number {
    return Math.max(0, this._panes.indexOf(this._primaryPane));
  }

  /** Slot of the pane holding the primary series, the price pane before there is one. */
  private _firstPaneSlot(): number {
    const slot = this._firstPane === null ? -1 : this._panes.indexOf(this._firstPane);
    return slot < 0 ? this._primaryIndex() : slot;
  }

  /**
   * Expand one pane to fill the chart, hiding the others. Calling it again (or
   * on another pane) puts the stack back exactly as it was, since the stored
   * weights were never disturbed.
   */
  public maximizePane(index: number): boolean {
    if (index < 0 || index >= this._panes.length) return false;
    this._maximizedPane = this._maximizedPane === index ? null : index;
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    // Maximize is the case a host cannot work around: it HIDES the other panes,
    // so chrome pinned to the price pane disappears rather than merely sitting wrong.
    this._rehomeAnchored();
    this.emit('paneMaximized', { paneIndex: this._maximizedPane });
    return true;
  }

  /** The maximized pane index, or null when none is. */
  public maximizedPane(): number | null {
    return this._maximizedPane;
  }

  /**
   * Fold a pane to a header strip, or open it again. A collapsed pane keeps
   * everything it holds: its series still take data, its studies still
   * recompute, and its drawings, scales and stored weight are untouched, so
   * opening it brings back exactly the height it had. The strip shows one
   * legend row, the pane's first study row with the control that opens it,
   * ahead of any row the host placed there, and on the bottom pane the time
   * axis; nothing else in it paints or answers the pointer, and no coordinate
   * conversion maps a price onto it.
   *
   * The primary price pane stays open in whatever slot it sits, top, middle or
   * bottom: it carries the price the chart exists to show, and a chart always
   * keeps one open pane for its furniture and the time navigator. Collapse is
   * a property of a pane rather than a slot, so a fold travels with its pane
   * through a move, and a study pane moved above the price pane, to slot 0,
   * folds like any other. Collapsing the maximized pane ends the maximize,
   * since a strip cannot fill the chart; maximizing a collapsed pane shows it
   * whole until the maximize ends. Returns false for the primary pane, an
   * unknown index, a value that is not a boolean, or no change.
   */
  public setPaneCollapsed(index: number, collapsed: boolean): boolean {
    const pane = this._panes[index];
    if (!Number.isInteger(index) || pane === undefined || pane === this._primaryPane
      || typeof collapsed !== 'boolean' || this._collapsed.has(pane) === collapsed) return false;
    if (collapsed) this._collapsed.add(pane);
    else this._collapsed.delete(pane);
    const ended = collapsed && this._maximizedPane === index;
    if (ended) this._maximizedPane = null;
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    // The lowest open pane may have changed, and the brand mark lives there.
    this._rehomeAnchored();
    if (ended) this.emit('paneMaximized', { paneIndex: null });
    this.emit('paneCollapsed', { paneIndex: index, collapsed });
    return true;
  }

  /** Whether a pane is collapsed to its header strip. The primary price pane never is. */
  public paneCollapsed(index: number): boolean {
    return this._collapsed.has(this._panes[index]);
  }

  /**
   * Route a pane-legend button press. Ids look like `indicator:<instanceId>::close`.
   * Returns true when the id was ours and was handled.
   */
  private _handleLegendAction(externalId: string): boolean {
    if (externalId === INDICATOR_LEGEND_TOGGLE) {
      this.setIndicatorLegendCollapsed(!this._indicatorLegendCollapsed);
      return true;
    }
    const sep = externalId.lastIndexOf('::');
    if (sep < 0) return false;
    const action = externalId.slice(sep + 2);
    // Navigator buttons run the same commands the keyboard does, so the two
    // paths can never drift apart.
    if (this._timeNav !== null && externalId.startsWith(`${this._timeNav.options().id}::`)) {
      if (this._runShortcut(action)) {
        this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      }
      return true;
    }
    // A host-owned legend row (a symbol/OHLC row) also reveals on hover; swallow
    // its click so it never surfaces as a phantom id.
    if (action === 'row' && !externalId.startsWith('indicator:')) return true;
    if (!externalId.startsWith('indicator:')) return false;
    const instanceId = externalId.slice('indicator:'.length, sep);
    // `::row` is the hover target that reveals the controls — never an action.
    if (action === 'row') return true;
    const indicator = this._indicators.find((i) => i.id === instanceId);
    if (indicator === undefined) return false;
    const paneIndex = indicator.paneIndex;
    switch (action) {
      // A press on a button the policy withheld (a stale hit id) does nothing:
      // the user's press is exactly what a policy restricts.
      case 'close':
        this.removeIndicator(instanceId);   // prunes its pane if it emptied
        return true;
      case 'hide': indicator.setVisible(!indicator.visible()); return true;
      case 'up': this.movePane(paneIndex, -1); return true;
      case 'down': this.movePane(paneIndex, 1); return true;
      case 'collapse': this.setPaneCollapsed(paneIndex, !this.paneCollapsed(paneIndex)); return true;
      case 'maximize': this.maximizePane(paneIndex); return true;
      // The engine is canvas-only and ships no DOM, so the settings form is the
      // host's. Everything it needs to *generate* one is on the descriptor
      // (`inputs`), and applying it is `indicator.setSettings(patch)`.
      case 'settings':
        if (indicator.policy().configurable !== false) this.emit('indicatorSettings', { instanceId, indicatorId: indicator.indicatorId, paneIndex });
        return true;
      // Same payload as the gear, and for the same reason: the engine holds no
      // code and no DOM, so it says which indicator was asked about and the
      // host decides what to show.
      case 'source':
        this.emit('indicatorSource', { instanceId, indicatorId: indicator.indicatorId, paneIndex });
        return true;
      default: return false;
    }
  }

  private _indicatorLegendHit(paneIndex: number, x: number, y: number): boolean {
    return this._indicatorLegendToggle !== null
      && this._panes[paneIndex]?.hasPrimitive(this._indicatorLegendToggle) === true
      && this._indicatorLegendToggle.hitTest(x - this._leftAxisWidth, y) !== null;
  }

  /**
   * Cumulative top + height of each pane: the source of truth for the DOM
   * boxes, the canvases and hit-testing alike. A collapsed pane is a fixed
   * strip one legend row tall, with the time axis under it when it is the
   * bottom pane, and the open panes share what is left by weight, so folding
   * one never rewrites a stored weight.
   *
   * Every boundary between panes sits on a device pixel (`alignToDevicePixels`),
   * so each canvas covers a whole number of device pixels and the separator
   * gets a row of its own. It is done here rather than where the boxes
   * are sized, so hit testing agrees with the pixels by construction.
   */
  private _paneLayout(): { top: number; height: number }[] {
    return alignToDevicePixels(this._paneShares(), this._pixelRatio());
  }

  /** The layout by weight and strip height alone, before device-pixel rounding. */
  private _paneShares(): { top: number; height: number }[] {
    const bottom = this._bottomPaneIndex();
    const strip = paneLegendRowHeight({ iconSize: this._legendIconSize }) + 2 * DEFAULT_LEGEND_TOP;
    const strips = this._panes.map((_, i) => this._collapsedShown(i) ? strip + (i === bottom ? this._timeAxisHeight : 0) : 0);
    let fixed = 0, total = 0;
    strips.forEach((h, i) => { fixed += h; if (!h) total += this._layoutWeight(i); });
    // Strips taller than the chart shrink together rather than overflow it.
    const shrink = fixed > this._height ? this._height / fixed : 1;
    const free = Math.max(0, this._height - fixed);
    let top = 0;
    return strips.map((h, i) => {
      const out = { top, height: h ? h * shrink : total > 0 ? (free * this._layoutWeight(i)) / total : 0 };
      top += out.height;
      return out;
    });
  }

  /**
   * Keyboard hints for the navigator tooltips, read from the live keymap so a
   * rebind shows up in the tooltip instead of a stale hardcoded string. The
   * one-bar step buttons have no default binding, so they get no hint.
   */
  private _navHints(opts?: Partial<TimeNavigatorOptions>): Partial<Record<string, string>> {
    if (opts?.hints !== undefined) return opts.hints;
    if (this._shortcuts === null) return {};
    const out: Record<string, string> = {};
    for (const e of this._shortcuts.list()) {
      if (e.command !== 'zoomIn' && e.command !== 'zoomOut' && e.command !== 'resetScale') continue;
      const combo = e.combos[0];
      if (combo !== undefined) out[e.command] = prettyCombo(combo);
    }
    return out;
  }

  /**
   * Keep the navigator on the lowest open pane: it belongs just above the time
   * axis, and adding, removing or collapsing a pane moves which one that is.
   * Its current pane is found by identity: a pane removed above it shifts the
   * slot it was added at, and removing it from that stale slot missed it and
   * attached it a second time.
   */
  private _syncTimeNavPane(): void {
    const nav = this._timeNav;
    if (nav === null) return;
    const target = this._bottomPaneIndex(true);
    const current = this._panes.findIndex(pane => pane.hasPrimitive(nav));
    this._timeNavPane = target;
    if (target === current || target < 0) return;
    this._panes[current]?.removePrimitive(nav);
    this._addPrimitive(target, nav);
  }

  /**
   * Push the pointer to the navigator and keep painting while it fades, so the
   * animation runs even when nothing else on the chart is changing.
   */
  private _feedTimeNav(p: { x: number; y: number } | null): void {
    const nav = this._timeNav;
    if (nav === null) return;
    nav.setPointer(p);
    if (nav.animating()) this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
  }

  /** How one pane paints and hit-tests right now: the bottom one carries the time axis. */
  private _renderContext(paneIndex: number): PaneRenderContext {
    return {
      timeScale: this._timeScale,
      dataLayer: this._dataLayer,
      priceOnlyAutoScale: this._priceOnlyAutoScale,
      primaryDataId: this._primary?.record.dataId,
      dpr: this._pixelRatio(),
      priceAxisWidth: this._rightAxisWidth,
      axisColumnWidth: this._axisColumnWidth,
      emptyPriceAxis: this._emptyPriceAxis,
      timeAxisHeight: this._timeAxisHeight,
      showTimeAxis: paneIndex === this._bottomPaneIndex(),
      collapsed: this._collapsedShown(paneIndex),
      conflate: this._conflate,
      conflationFactor: this._conflationFactor,
      theme: this._theme,
      showVertGrid: this._gridVert,
      showHorzGrid: this._gridHorz,
      canvasOptions: this._canvas,
      timeFormatter: this._timeFormatter,
      timezone: this._timezone,
      leftAxisWidth: this._leftAxisWidth,
      hoverId: this._hoverId,
      hoverKey: this._hoverKey,
      dragId: this._dragId,
      sessionClock: this._sessionClockOptions(),
      barCountdown: this._barCountdownOptions(),
      stackSlot: (entry: string) => this._stackSlot(paneIndex, entry),
    };
  }

  /**
   * The corner clock's options, or undefined when it is off. Built per frame so
   * a zone change reaches it without the pane holding a stale copy.
   */
  private _sessionClockOptions(): SessionClockOptions | undefined {
    const on = this._axisChrome.sessionClock;
    if (on === undefined || on === false) return undefined;
    return {
      visible: true,
      now: this._wallClock,
      timezone: this._timezone,
      showOffset: on === true ? undefined : on.showOffset,
    };
  }

  /**
   * The countdown row's options, or undefined when it is off or there is
   * nothing to count. The interval is read back from the bars rather than
   * configured: the chart is never told its own timeframe, and a chart that
   * switched timeframe mid-session has to follow within a screen of bars.
   */
  private _barCountdownOptions(): BarCountdownOptions | undefined {
    if (this._axisChrome.barCountdown !== true) return undefined;
    const last = this._dataLayer.indexToTime(this._dataLayer.baseIndex);
    if (last === undefined) return undefined;
    return {
      visible: true,
      now: this._wallClock,
      lastBarTime: last,
      intervalSec: medianBarInterval(this._dataLayer),
    };
  }

  private _observeSize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this._resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      this.applySize(entry.contentRect.width, entry.contentRect.height);
      // Resizing a canvas clears it, and this callback runs after the
      // frame's animation callbacks, just before the browser paints. Left
      // to the next frame, the repaint would put one cleared frame on screen
      // for every step of a window drag.
      this._paintNow();
    });
    this._resizeObserver.observe(this._container);
    if (typeof ResizeObserverEntry !== 'undefined' && 'devicePixelContentBoxSize' in ResizeObserverEntry.prototype) {
      this._deviceObserver = new ResizeObserver(entries => this._onDevicePixels(entries));
      for (const pane of this._panes) this._observeCanvases(pane, true);
    }
  }

  /** Start or stop reading a pane's canvases' device-pixel boxes. */
  private _observeCanvases(pane: Pane, on: boolean): void {
    const observer = this._deviceObserver;
    if (observer === null) return;
    for (const layer of [pane.base, pane.top]) {
      if (on) observer.observe(layer.element, { box: 'device-pixel-content-box' });
      else observer.unobserve(layer.element);
    }
  }

  /**
   * Give each canvas the backing store the browser says its box covers. A
   * canvas that starts part way into a device pixel is snapped to one pixel
   * more or fewer than `media x dpr`, and a store one pixel off is stretched
   * over the box, blurring every line on it.
   */
  private _onDevicePixels(entries: readonly ResizeObserverEntry[]): void {
    if (this._destroyed || this._destroying) return;
    let changed = false;
    for (const entry of entries) {
      const layer = this._canvasLayerOf(entry.target);
      const device = entry.devicePixelContentBoxSize?.[0];
      const box = entry.contentBoxSize?.[0];
      if (layer === null || device === undefined || box === undefined) continue;
      // Measured before a relayout in this same frame: the box it describes
      // is gone, and the entry for the new one follows before the paint.
      if (Math.abs(box.inlineSize - layer.mediaWidth) > 0.05 || Math.abs(box.blockSize - layer.mediaHeight) > 0.05) continue;
      if (layer.setDeviceSize(device.inlineSize, device.blockSize)) changed = true;
    }
    if (!changed) return;
    this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Full));
    this._paintNow();
  }

  private _canvasLayerOf(target: Element): CanvasLayer | null {
    for (const pane of this._panes) {
      if (pane.base.element === target) return pane.base;
      if (pane.top.element === target) return pane.top;
    }
    return null;
  }

  /** The window the chart's document shows in, or null outside a browser. */
  private _view(): Window | null {
    const view = this._doc.defaultView;
    if (view) return view;
    return typeof window === 'undefined' ? null : window;
  }

  /**
   * Follow the device pixel ratio. It changes with no box changing size when
   * the window moves to a screen of another density, and no size observer
   * hears of that, so the canvases would stay at the old ratio, stretched and
   * blurred. A resolution query matches the one ratio it was made for, so
   * each change makes a new one for the ratio now in force.
   *
   * The window's `resize` is heard too: a zoom fires it, and it is the one
   * signal left in a browser whose query list takes no change listener. It
   * costs a comparison when the ratio has not moved.
   */
  private _watchPixelRatio(): void {
    this._unwatchPixelRatio();
    const view = this._view();
    if (view === null || this._destroying || this._destroyed) return;
    if (typeof view.addEventListener === 'function') {
      view.addEventListener('resize', this._checkPixelRatio);
      this._ratioView = view;
    }
    if (typeof view.matchMedia !== 'function') return;
    const query = view.matchMedia(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
    if (typeof query?.addEventListener !== 'function') return;
    query.addEventListener('change', this._onPixelRatio);
    this._ratioQuery = query;
  }

  private _unwatchPixelRatio(): void {
    this._ratioQuery?.removeEventListener('change', this._onPixelRatio);
    this._ratioQuery = null;
    this._ratioView?.removeEventListener('resize', this._checkPixelRatio);
    this._ratioView = null;
  }

  private readonly _onPixelRatio = (): void => {
    if (this._destroyed || this._destroying) return;
    this._watchPixelRatio();
    this._checkPixelRatio();
  };

  /** Size the canvases again if the ratio is no longer the one they were sized at. */
  private readonly _checkPixelRatio = (): void => {
    if (this._destroyed || this._destroying || this._pixelRatio() === this._layoutRatio) return;
    this._relayout();
    this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Full));
    this._paintNow();
  };

  /**
   * Run the pending frame now rather than on the next animation frame, for
   * the callbacks that clear a canvas once this frame's animation callbacks
   * have run: a resize observed before the browser paints, a new pixel ratio.
   * Waiting would show the cleared canvas for a frame.
   */
  private _paintNow(): void {
    if (this._destroyed || this._destroying || this._pending === null || this._scaleMutationDepth > 0) return;
    this._loop.stop();
    this._onFrame();
  }

  private _onFrame(): void {
    if (this._destroyed || this._destroying) return;
    // Before the mask is taken, not after: recomputing writes plot data, which
    // invalidates, and that invalidation has to land in this frame's mask
    // rather than in the next frame's.
    this._flushIndicators();

    const mask = this._pending;
    this._pending = null;
    if (mask === null || mask.isEmpty()) return;

    const global = mask.globalLevel;
    let easing = false;
    const now = this._now();
    const fraction = this._autoscaleTime === null || ++this._autoscaleFrames >= 90
      ? 1 : 1 - Math.exp(-Math.max(1, now - this._autoscaleTime) / 80);
    if (this._autoscaleTime !== null) this._autoscaleTime = now;
    // Keep the actual pointer untouched for drawing and hit tests. Resolve at
    // paint time so toggling the option or changing the viewport takes effect
    // without waiting for another pointer event, across every pane at once.
    let crosshairX = this._cursor?.x ?? 0;
    const snapSeries = this._firstDataId.value ?? this._primaryPane.series()[0]?.dataId;
    if (this._cursor !== null && this._crosshairSnapToBar && snapSeries !== undefined) {
      const index = Math.round(this._timeScale.xToIndex(crosshairX));
      if (this._dataLayer.visibleBars(snapSeries, index, index).length > 0) {
        crosshairX = this._timeScale.indexToX(index);
      }
    }
    for (let i = 0; i < this._panes.length; i++) {
      const pane = this._panes[i];
      const perPane = mask.paneInvalidation(i);
      const level = Math.max(global, perPane?.level ?? InvalidationLevel.None);
      const ctx = this._renderContext(i);
      if (level >= InvalidationLevel.Full || perPane?.autoScale || this._autoscaleTime !== null) {
        easing = pane.autoscale(ctx, fraction) || easing;
      }
      if (level >= InvalidationLevel.Light) pane.paintBase(ctx);
      if (level >= InvalidationLevel.Cursor && !this._overlayFrozen) {
        // Global crosshair: every pane draws the vertical line at the shared x;
        // only the hovered pane draws the horizontal line + price tag; the bottom
        // pane draws the date tag.
        const cross = this._cursor === null
          ? null
          : { x: crosshairX, yLocal: i === this._cursorPane ? this._cursor.y : null, showTimeTag: ctx.showTimeAxis };
        pane.paintTop(cross, ctx);
      }
    }
    if (easing) this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Light));
    else this._autoscaleTime = null;
    const nav = this._timeNav;
    if (nav?.animating() && !this._schedulingTimeNav
      && (!this._overlayFrozen || nav.zOrder() !== 'top')
      && this._panes[this._timeNavPane]?.primitives().includes(nav)) {
      // A stationary pointer still needs the rest of the fade. The guard also
      // bounds reentry from a synchronous injected scheduler with a frozen clock.
      this._schedulingTimeNav = true;
      try { this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Light)); }
      finally { this._schedulingTimeNav = false; }
    }
    // After the loop, not inside it: swapping a pane's backend while its
    // frame is half painted would hand the rest of that frame to a backend
    // that never began one. The device is shared, so one pane's answer is
    // every pane's.
    if (this._rendererKind !== null && this._rendererKind !== 'canvas2d') {
      for (const pane of this._panes) {
        const reason = pane.backendDegradation;
        if (reason !== null) { this._fallbackToCanvas2d(reason); break; }
      }
    }
  }

  // ── input handling ──────────────────────────────────────────────────────

  private _attachInput(): void {
    if (typeof window === 'undefined') return;
    const el = this._container;
    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerup', this._onPointerUpNative);
    el.addEventListener('pointercancel', this._onPointerCancel);
    el.addEventListener('lostpointercapture', this._onLostPointerCapture);
    el.addEventListener('pointerleave', this._onPointerLeave);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('dblclick', this._onDblClick);
    el.addEventListener('pointerenter', this._onPointerEnter);
    el.addEventListener('contextmenu', this._onContextMenu);
    // Keyboard: listen on the document when available (so shortcuts fire on hover
    // without focusing the chart), else on the focusable container. The handler
    // gates by scope / hover / focus.
    const keyTarget: HTMLElement | Document =
      typeof this._doc.addEventListener === 'function' ? this._doc : el;
    keyTarget.addEventListener('keydown', this._onKeyDown as EventListener);
    this._keyTarget = keyTarget;
  }

  private readonly _onPointerEnter = (): void => { this._pointerInside = true; };

  /**
   * The chart renders as stacked canvases, so the browser's right-click
   * "Save image as…" would capture only the topmost (transparent overlay)
   * layer — a blank image. Just before the native menu opens, composite the
   * clicked pane's base layer *beneath* its overlay bitmap so the saved image
   * is the visible chart, and freeze overlay repaints (live ticks repaint every
   * few hundred ms and would wipe the snapshot while the menu is open). The
   * freeze lifts on the next pointer/wheel/key input after the menu closes.
   * Apps that present their own menu (preventDefault on contextmenu) are
   * unaffected. Multi-pane note: the native save captures the clicked pane
   * only — use `downloadScreenshot()` for the full multi-pane composite.
   *
   * A listener on the `contextmenu` **chart** event takes over entirely: it is
   * told what was hit, and the snapshot is skipped, since the app is raising a
   * menu of its own instead of the browser's.
   */
  private readonly _onContextMenu = (e: MouseEvent): void => {
    if (e.defaultPrevented) return; // app shows its own menu (e.g. order entry)
    const p = this._localPoint(e);
    const pane = this._panes[p.pane];
    if (pane === undefined) return;
    // Size, not presence: `off` leaves an empty set behind, and treating that
    // as "an app is handling it" would silently retire the snapshot fallback
    // for the rest of the chart's life.
    const listeners = this._listeners.get('contextmenu');
    if (listeners !== undefined && listeners.size > 0) {
      this.emit('contextmenu', this._contextMenuEvent(e, p));
      return;
    }
    // Null the crosshair without invalidating: a pointerleave fired while the
    // native menu is open must not schedule a repaint that wipes the snapshot.
    this._cursor = null;
    this._cursorPane = null;
    try {
      const g = pane.top.ctx;
      g.save();
      g.globalCompositeOperation = 'destination-over';
      g.drawImage(pane.base.element, 0, 0);
      g.restore();
      this._overlayFrozen = true;
    } catch { /* zero-sized or detached canvas — nothing to snapshot */ }
  };

  /** Build the `contextmenu` payload: where the pointer is, and what it is over. */
  private _contextMenuEvent(
    e: MouseEvent,
    p: { x: number; y: number; pane: number; localY: number; paneHeight: number },
  ): ContextMenuEvent {
    const plotX = p.x - this._leftAxisWidth;
    const onPlot = plotX >= 0 && p.x < this._width - this._rightAxisWidth;
    const index = onPlot ? Math.round(this._timeScale.xToIndex(plotX)) : null;
    if (onPlot) this._ensureScaled(p.pane); // a menu can be raised before the first paint
    return {
      paneIndex: p.pane,
      point: { x: p.x, y: p.y },
      price: onPlot ? this._priceAt(p.pane, p.localY) : null,
      time: index === null ? null : (this._dataLayer.indexToTime(index) ?? null),
      index,
      target: this._contextTarget(p, onPlot, index),
      preventDefault: (): void => e.preventDefault(),
    };
  }

  /**
   * Classify what the pointer is over. A canvas hands an app a pixel, not an
   * object, so this is the part it cannot work out for itself, and the part
   * that decides which menu items make sense.
   */
  private _contextTarget(
    p: { x: number; pane: number; localY: number; paneHeight: number },
    onPlot: boolean,
    index: number | null,
  ): ContextMenuTarget {
    const isBottom = p.pane === this._bottomPaneIndex();
    const onRightAxis = p.x >= this._width - this._rightAxisWidth;
    const onTimeAxis = isBottom && p.localY >= p.paneHeight - this._timeAxisHeight;
    // The time axis spans the full width, including the left column: a click in
    // the bottom-left corner is on the dates, not on a price ladder that stops
    // above them. The bottom-*right* corner stays the price axis', which is
    // where its own labels run out.
    if (onTimeAxis && !onRightAxis) return { kind: 'time-scale', id: null };
    if (!onPlot) {
      const slot = this._axisAt(p.pane, p.x);
      return slot ? { kind: 'price-scale', id: null, side: slot.side, scaleId: slot.scaleId } : { kind: 'empty', id: null };
    }

    const pane = this._panes[p.pane];
    const context = this._renderContext(p.pane);
    const hit = this._hitAt(p.pane, p.x, p.localY);
    // A strip plots nothing, so nothing on it can be under the pointer.
    const record = index === null || this._collapsedShown(p.pane) ? null : this._seriesAt(p.pane, index, p.localY);
    // What is painted on top takes the menu: a drawing placed under a source
    // or a study loses the pointer to that series where the two overlap.
    if (hit != null && !(record !== null && hit.paintedBy !== undefined && pane.paintsBelowSeries(hit.paintedBy, record, context))) {
      const id = hit.externalId;
      if (id.startsWith('draw:')) return { kind: 'drawing', id };
      if (id.startsWith('indicator:')) {
        const sep = id.lastIndexOf('::');
        const instanceId = id.slice('indicator:'.length, sep < 0 ? undefined : sep);
        return { kind: 'indicator', id, instanceId };
      }
      // A host-owned legend (the symbol/OHLC row) hit-tests as `${id}::row`.
      if (id.endsWith('::row')) return { kind: 'legend', id };
      return { kind: 'primitive', id };
    }
    if (record === null) return { kind: 'empty', id: null };
    for (const instance of this._indicators) {
      for (const plot of getIndicator(instance.indicatorId).plots) {
        const series = instance.series(plot.key);
        if (series && this._seriesRecords.get(series) === record) {
          return { kind: 'indicator', id: `indicator:${instance.id}`, instanceId: instance.id, plotKey: plot.key };
        }
      }
    }
    return { kind: 'series', id: null, seriesType: record.type };
  }

  /** Vacant aligned cells have no scale target, even if a hidden scale exists. */
  private _axisAt(paneIndex: number, x: number): PriceAxisSlot | undefined {
    return this.priceAxisLayout(paneIndex).find(slot => x >= slot.x && x < slot.x + slot.width);
  }

  /**
   * Which series the pointer sits on, if any. A pane is one bitmap, so "on the
   * candle" has to be recomputed rather than looked up: take each series'
   * autoscale extents for the bar under the cursor and test the band they span,
   * with a few px of slack so a 1px line is still a target.
   */
  private _seriesAt(paneIndex: number, index: number, localY: number): SeriesRecord | null {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return null;
    const tol = 3;
    // Later series paint above earlier series, so their context actions win overlaps.
    const records = pane.series();
    for (let position = records.length - 1; position >= 0; position--) {
      const record = records[position];
      if (record.style.visible === false) continue;
      const bars = this._dataLayer.visibleBars(record.dataId, index, index);
      if (bars.length === 0) continue;
      const ext = getChartType(record.type).extents(bars[0].bar, record.style);
      if (!isFinite(ext.min) || !isFinite(ext.max)) continue;
      const scale = pane.scaleOf(record);
      const a = scale.priceToY(ext.max);
      const b = scale.priceToY(ext.min);
      if (localY >= Math.min(a, b) - tol && localY <= Math.max(a, b) + tol) return record;
    }
    return null;
  }

  /**
   * The price under a pane-local y, for an event payload. Null on a strip: it
   * plots nothing, so a price read off it would place a drawing, an alert or a
   * pick somewhere nobody can see.
   */
  private _priceAt(paneIndex: number, y: number): number | null {
    return this._collapsedShown(paneIndex) ? null : this._panes[paneIndex]?.yToPrice(y) ?? null;
  }

  /** Resume overlay repaints after the native context menu closes. */
  private _unfreezeOverlay(): void {
    if (!this._overlayFrozen) return;
    this._overlayFrozen = false;
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
  }

  private _localPoint(e: { clientX: number; clientY: number }): { x: number; y: number; pane: number; localY: number; paneHeight: number } {
    const rect = this._container.getBoundingClientRect();
    return this._project(e.clientX - rect.left, e.clientY - rect.top, this._paneLayout());
  }

  /** Container media px to the pane under it and that pane's local y. */
  private _project(x: number, y: number, layout: { top: number; height: number }[]): { x: number; y: number; pane: number; localY: number; paneHeight: number } {
    // Map Y to a pane by cumulative weighted heights, matching the DOM/canvas layout.
    let pane = 0;
    for (let i = 0; i < layout.length; i++) if (y >= layout[i].top) pane = i;
    const pl = layout[pane] ?? { top: 0, height: this._height };
    return { x, y, pane, localY: y - pl.top, paneHeight: pl.height };
  }

  /**
   * Every position a drag passed through since the previous move event, in
   * the same space as the payload's `point`. The rect and layout are read once
   * for the batch: a fast stroke coalesces several positions per frame, and
   * each one going back to the DOM is layout work on the pointer path.
   */
  private _dragSamples(e: PointerEvent): PointerSample[] {
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events: readonly PointerEvent[] = coalesced.length > 0 ? coalesced : [e];
    const rect = this._container.getBoundingClientRect();
    const layout = this._paneLayout();
    const out: PointerSample[] = [];
    for (const s of events) {
      const p = this._project(s.clientX - rect.left, s.clientY - rect.top, layout);
      out.push({ x: p.x, y: this._dragId === null ? p.localY : p.y - (layout[this._downPane]?.top ?? 0), pressure: pointerPressure(s) });
    }
    return out;
  }

  /**
   * Pointer facts for a click. Modifiers and device come from the release,
   * pressure from the press: a release always reads 0, which would leave the
   * field carrying nothing on any device.
   */
  private _clickInfo(e: PointerLike): PointerInfo & { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean } {
    const info = pointerInfo(e);
    info.pressure = this._downPressure;
    // The flat flags predate `modifiers` and are deprecated, removed in 3.0.0;
    // they stay until then so a host typed against either keeps working.
    return { ...info, shiftKey: info.modifiers.shift, ctrlKey: info.modifiers.ctrl, metaKey: info.modifiers.meta };
  }

  private readonly _onPointerDown = (e: PointerEvent): void => {
    this._unfreezeOverlay();
    // Only the primary button starts a pan / line-drag. A right-click (context
    // menu) also fires pointerdown, and its pointerup is often swallowed by the
    // menu — arming the drag state then makes the chart pan with no button held.
    if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && e.button !== 0) return;
    this._previousPressOnIndicatorToggle = this._lastPressOnIndicatorToggle;
    this._lastPressOnIndicatorToggle = false;
    this._endedPointers.delete(e.pointerId);
    if (this._pointers.size === 0) this._navigationCancelled = false;
    this._stopKinetic();
    // Taking hold of the chart ends a zoom glide too: the viewport is the
    // user's again the moment they touch it.
    this._stopZoomGlide();
    const p = this._localPoint(e);
    this._pointers.set(e.pointerId, { x: p.x, y: p.y, pane: p.pane });
    // `setPointerCapture` throws NotFoundError when the pointer id is not
    // currently active (a synthetic event, or one already released). The
    // optional call only guarded against the method being absent, so the throw
    // aborted the rest of pointerdown — losing the divider grab, the axis-drag
    // arm, and the line-drag arm. Capture is an optimisation; never fatal.
    try { this._container.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    if (this._navigationCancelled) return;
    if (this._pointers.size >= 2) { this._beginPinch(); return; } // second finger → pinch, skip single-drag
    this._downPane = p.pane;
    this._downX = p.x;
    this._downLocalY = p.localY;
    this._downPressure = pointerPressure(e);

    // Pane divider: pressing within a few px of the boundary between two panes
    // starts a resize, redistributing weight between them.
    const divider = this._dividerAt(p.y);
    if (divider !== null) {
      const layout = this._paneLayout();
      const [a, b] = divider;
      this._paneResize = {
        a, b,
        startY: p.y,
        aWeight: this._panes[a].weight,
        bWeight: this._panes[b].weight,
        aHeight: layout[a].height,
        bHeight: layout[b].height,
      };
      this._dragging = false;
      return;
    }

    // Axis-drag rescale: dragging the price axis (right strip) rescales Y;
    // dragging the time axis (bottom strip of the last pane) rescales X.
    const plotWidth = Math.max(0, this._width - this._rightAxisWidth);
    // Either strip rescales the axis drawn in it: a pane whose scale was moved
    // to the left has no right ladder to grab, and before the move the left one
    // was drawn but not draggable.
    const onLeftAxis = this._leftAxisWidth > 0 && p.x < this._leftAxisWidth;
    const onPriceAxis = p.x >= plotWidth || onLeftAxis;
    const onTimeAxis = p.pane === this._bottomPaneIndex() && p.localY >= p.paneHeight - this._timeAxisHeight;
    if (onPriceAxis) {
      const slot = this._axisAt(p.pane, p.x);
      this._dragging = false;
      if (!slot || this._navigation.zoomEnabled === false) { this._axisDrag = 'empty'; return; }
      this._axisDrag = 'price';
      this._axisDragScale = this._panes[p.pane].scaleFor(slot.scaleId);
      this._axisStartCoord = p.localY;
      const r = this._axisDragScale.priceRange();
      this._axisStartMin = r.min;
      this._axisStartMax = r.max;
      this._dragging = false;
      return;
    }
    if (onTimeAxis) {
      if (this._navigation.zoomEnabled === false) { this._axisDrag = 'empty'; return; }
      this._axisDrag = 'time';
      this._axisStartCoord = p.x;
      this._axisStartSpacing = this._timeScale.barSpacing;
      this._dragging = false;
      return;
    }

    if (this._indicatorLegendHit(p.pane, p.x, p.localY)) {
      this._lastPressOnIndicatorToggle = true;
      this._indicatorTogglePress = { pointerId: e.pointerId, moved: false };
      this._dragging = false;
      this._pointerMoved = false;
      return;
    }

    // The mark takes the press only where nothing else answers it: see `_hitAt`.
    const hit = this._panes[p.pane]?.hitTestPrimitives(p.x - this._leftAxisWidth, p.localY, this._renderContext(p.pane), this._branding);
    if (this._branding !== null && !hit && this._brandingHit(p.pane, p.x, p.localY)) {
      this._brandingPress = { pointerId: e.pointerId, mark: this._branding, moved: false };
      this._dragging = false;
      this._pointerMoved = false;
      return;
    }

    // While a host is placing something (a drawing tool is armed), a press is the
    // start of a shape, not a pan. Bail before the drag/hit paths so the gesture
    // can only produce anchors — `_onPointerUp` turns it into clicks.
    if (this._placementMode) {
      this._dragging = false;
      this._pointerMoved = false;
      return;
    }

    // If the press lands on a draggable line (order/SL/TP), drag it — don't pan.
    // `draggable` primitives (drawing anchors/shapes) arm regardless of a host
    // callback — they publish through the `drag` event bus. The `ns-resize`
    // form is the original price-line path and still needs `subscribeDrag`.
    if (hit && (hit.draggable === true || (hit.cursor === 'ns-resize' && this._dragCb !== null))) {
      this._dragId = hit.externalId;
      this._dragPriceScale = hit.priceScale ?? null;
      this._dragCancelOnEscape = hit.cancelOnEscape === true;
      this._dragMoved = false;
      this._ensureScaled(p.pane);
      this._dragFrom = {
        time: this._xToTime(p.x),
        price: this._dragPriceScale?.yToPrice(p.localY) ?? this._panes[p.pane].yToPrice(p.localY),
      };
      this._setHover(hit); // active state + cursor even when no hover preceded (touch)
      // Hide the crosshair while dragging a line — a frozen crosshair at the
      // grab point reads as a phantom second line (the axis tag tracks price).
      this._cursor = null;
      this._cursorPane = null;
      this._readoutTime = null;
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
      this._dragging = false;
      this._pointerMoved = false;
      const start: ChartDragEndEvent = {
        id: hit.externalId, ...this._dragFrom, paneIndex: this._downPane,
        point: { x: p.x, y: p.localY }, ...pointerInfo(e),
      };
      this.emit('drag:start', start);
      return;
    }

    this._dragging = this._navigation.panEnabled !== false;
    // Hover-only controls must survive a repaint between press and release.
    this._setHover(hit ?? null);
    this._pointerMoved = false;
    this._dragStartX = p.x;
    this._dragStartY = p.y;
    this._lastDragY = p.y;
    this._dragStartOffset = this._timeScale.rightOffset;
    this._lastDragX = p.x;
    this._lastDragT = this._now();
    this._dragVelocity = 0;
  };

  private readonly _onPointerMove = (e: PointerEvent): void => {
    this._unfreezeOverlay();
    // Hover from a second device must not move or release the pointer that owns the gesture.
    if (this._pointers.size > 0 && !this._pointers.has(e.pointerId)) return;
    // Safety: if the primary button is no longer held (missed pointerup — e.g.
    // released over a context menu or outside the window), end any drag now.
    if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && (e.buttons & 1) === 0
      && (this._pointers.has(e.pointerId) || this._dragging || this._dragId !== null || this._axisDrag !== null || this._brandingPress !== null || this._indicatorTogglePress !== null)) {
      if (this._brandingPress !== null) this._brandingPress.moved = true;
      if (this._indicatorTogglePress !== null) this._indicatorTogglePress.moved = true;
      this._onPointerUp(e);
      // Marked after the fact, not before: the recovery IS this pointer's one
      // real end, so it has to run. What must be swallowed is the release that
      // follows it.
      this._endedPointers.add(e.pointerId);
      return;
    }
    const p = this._localPoint(e);
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: p.x, y: p.y, pane: p.pane });
    if (this._navigationCancelled) return;
    if (this._pinch !== null) { this._updatePinch(); return; }
    if (this._axisDrag === 'empty') return;
    if (this._indicatorTogglePress !== null) {
      if (Math.abs(p.x - this._downX) > 3 || Math.abs(p.localY - this._downLocalY) > 3 || p.pane !== this._downPane) {
        this._indicatorTogglePress.moved = true;
      }
      return;
    }
    if (this._brandingPress !== null) {
      if (Math.abs(p.x - this._downX) > 3 || Math.abs(p.localY - this._downLocalY) > 3
        || p.pane !== this._downPane || (e.pointerType === 'mouse' && (e.buttons & 1) === 0)) {
        this._brandingPress.moved = true;
      }
      return;
    }
    if (this._axisDrag === 'price') {
      // drag up (dy<0) → expand (zoom in); drag down → compress (zoom out)
      const dy = p.localY - this._axisStartCoord;
      const factor = Math.exp(dy * 0.005);
      const centre = (this._axisStartMin + this._axisStartMax) / 2;
      const half = ((this._axisStartMax - this._axisStartMin) / 2) * factor;
      const ps = this._axisDragScale ?? this._panes[this._downPane].priceScale;
      ps.setPriceRange({ min: centre - half, max: centre + half });
      ps.setAutoScale(false);
      this.invalidate((m) => m.invalidatePane(this._downPane, { level: InvalidationLevel.Light, autoScale: false }));
      return;
    }
    if (this._paneResize !== null) {
      const r = this._paneResize;
      // Move `dy` px of height from one pane to the other, keeping their summed
      // weight constant so the other panes are untouched. Clamped so neither
      // side collapses below a usable height.
      const total = r.aHeight + r.bHeight;
      const sum = r.aWeight + r.bWeight;
      const min = Math.min(24, total / 4);
      const aH = Math.max(min, Math.min(total - min, r.aHeight + (p.y - r.startY)));
      this._panes[r.a].weight = (aH / total) * sum;
      this._panes[r.b].weight = sum - this._panes[r.a].weight;
      this._relayout();
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      return;
    }
    if (this._axisDrag === 'time') {
      this._beginAutoscaleMotion();
      // Drag left to widen bars; drag right to show more bars in the same space.
      const dx = p.x - this._axisStartCoord;
      this._mutateTimeScale(() => this._timeScale.setBarSpacing(this._axisStartSpacing * Math.exp(-dx * 0.005)));
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      this._emitViewport('zoom');
      return;
    }
    // Placement mode suppresses the pan path, which is where `_pointerMoved`
    // is normally set — track the gesture here so pointerup can still tell a
    // click from a drag-to-draw.
    if ((this._placementMode || !this._dragging) && this._pointers.size > 0
      && (Math.abs(p.x - this._downX) > 3 || Math.abs(p.localY - this._downLocalY) > 3)) {
      this._pointerMoved = true;
    }
    if (this._dragId !== null) {
      const localY = p.y - (this._paneLayout()[this._downPane]?.top ?? 0);
      if (Math.abs(p.x - this._downX) > 3 || Math.abs(localY - this._downLocalY) > 3) this._dragMoved = true;
      const price = this._dragPriceScale?.yToPrice(localY) ?? this._panes[this._downPane].yToPrice(localY);
      const time = this._xToTime(p.x);
      this._dragCb?.(this._dragId, price, time);
      const drag: ChartDragEvent = {
        id: this._dragId, price, time, paneIndex: this._downPane,
        // The grab origin, so a consumer's delta starts at the press instead of
        // the first move — otherwise the shape lags the cursor by one event.
        fromPrice: this._dragFrom.price, fromTime: this._dragFrom.time,
        point: { x: p.x, y: localY },
        samples: this._dragSamples(e),
        ...pointerInfo(e),
      };
      this.emit('drag', drag);
      return;
    }
    if (this._dragging) {
      this._beginAutoscaleMotion();
      const dx = p.x - this._dragStartX;
      if (Math.abs(dx) > 3 || Math.abs(p.y - this._dragStartY) > 3) this._pointerMoved = true;
      if (this._pointerMoved && this._hoverId !== null) this._setHover(null);
      // horizontal: scroll time
      this._mutateTimeScale(() => this._timeScale.setRightOffset(this._dragStartOffset - dx / this._timeScale.barSpacing));
      // Horizontal-only mode preserves autoscale when the pointer moves vertically.
      if (e.pointerType === 'touch' || this._navigation.mousePan === 'both') {
        // A strip's scale is not on screen, so a drag across it pans time only.
        const scale = this._collapsedShown(this._downPane) ? undefined : this._panes[this._downPane]?.priceScale;
        const fromStart = p.y - this._dragStartY;
        // Minor mouse/pen drift must not turn an automatic axis into a frozen
        // manual range. Once vertical movement is intentional, include its full
        // distance from the press; already-manual axes retain fine adjustments.
        if (scale && (e.pointerType === 'touch' || !scale.autoScale || Math.abs(fromStart) > 3)) {
          scale.panByPixels(e.pointerType !== 'touch' && scale.autoScale ? fromStart : p.y - this._lastDragY);
        }
      }
      this._lastDragY = p.y;
      const t = this._now();
      const dt = t - this._lastDragT;
      if (dt > 0) {
        // Blend rather than replace, and let an idle gap wash the old value out.
        // Sampling only on pointermove means a drag that stops and holds keeps
        // whatever velocity its last moving frame had, so releasing after a
        // deliberate pause flings the chart as if it were still moving. Decay is
        // measured in elapsed time, so it works the same on a throttled feed.
        const instant = (p.x - this._lastDragX) / dt;
        const keep = Math.exp(-dt / KINETIC_VELOCITY_HALFLIFE_MS);
        this._dragVelocity = this._dragVelocity * keep + instant * (1 - keep);
      }
      this._lastDragX = p.x;
      this._lastDragT = t;
      this._maybeLoadHistory();
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      this._emitViewport('pan');
      return;
    }
    this._updateCursor(p.pane, p.x, p.localY, p.y, e);
  };

  private readonly _onPointerUp = (e: PointerEvent): void => {
    if (this._pointers.size > 0 && !this._pointers.has(e.pointerId)) return;
    const togglePress = this._indicatorTogglePress?.pointerId === e.pointerId ? this._indicatorTogglePress : null;
    if (togglePress) this._indicatorTogglePress = null;
    // Finish ownership before release: a host can report lost capture synchronously.
    this._pointers.delete(e.pointerId);
    try { this._container.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
    // A gesture ends once. `_onPointerMove` calls this directly when it finds the
    // button already released, because a release over a context menu or outside
    // the window never reaches us -- and the real `pointerup` still arrives after
    // it. Without this guard that second call finds the drag already torn down,
    // falls through to the plain click branch, and fires the same click again at
    // the stale press coordinates. Every host control addressed by
    // `subscribeClick` doubles: a legend's hide toggles twice and looks dead.
    if (this._endedPointers.has(e.pointerId)) { this._endedPointers.delete(e.pointerId); return; }
    if (this._navigationCancelled) {
      if (this._pointers.size === 0) this._navigationCancelled = false;
      this._endedPointers.add(e.pointerId);
      return;
    }
    if (togglePress) {
      const p = this._localPoint(e);
      this._endedPointers.add(e.pointerId);
      if (!togglePress.moved && p.pane === this._downPane && Math.abs(p.x - this._downX) <= 3
        && Math.abs(p.localY - this._downLocalY) <= 3 && this._indicatorLegendHit(p.pane, p.x, p.localY)) {
        this._handleLegendAction(INDICATOR_LEGEND_TOGGLE);
      }
      return;
    }
    if (this._brandingPress?.pointerId === e.pointerId) {
      const press = this._brandingPress;
      this._brandingPress = null;
      const p = this._localPoint(e);
      if (!press.moved && press.mark === this._branding && p.pane === this._downPane
        && Math.abs(p.x - this._downX) <= 3 && Math.abs(p.localY - this._downLocalY) <= 3
        && this._brandingHit(p.pane, p.x, p.localY)) {
        const href = press.mark.href();
        if (href && /^https?:\/\//i.test(href)) this._doc.defaultView?.open(href, '_blank', 'noopener,noreferrer');
      }
      this._endedPointers.add(e.pointerId);
      return;
    }
    if (this._pinch !== null) {
      // Keep the remaining finger in the same gesture so its release cannot place a drawing.
      if (this._pointers.size === 0) { this._pinch = null; this._dragging = false; }
      return;
    }
    if (this._paneResize !== null) {
      this._paneResize = null;
      this.emit('paneResized', { paneIndex: this._downPane });
      return;
    }
    if (this._axisDrag !== null) {
      this._axisDrag = null;
      this._axisDragScale = null;
      return;
    }
    if (this._dragId !== null) {
      const p = this._localPoint(e);
      const localY = p.y - (this._paneLayout()[this._downPane]?.top ?? 0);
      const price = this._dragPriceScale?.yToPrice(localY) ?? this._panes[this._downPane].yToPrice(localY);
      const time = this._xToTime(p.x);
      this._dragEndCb?.(this._dragId, price, time);
      const end: ChartDragEndEvent = {
        id: this._dragId, price, time, paneIndex: this._downPane,
        point: { x: p.x, y: localY },
        ...pointerInfo(e),
      };
      this.emit('drag:end', end);
      // A press on a draggable primitive arms a drag, so this branch used to
      // swallow the release — and a plain click on a drawing never reached the
      // click path, leaving it unselectable. A gesture that never moved is a
      // click by any reasonable reading.
      if (!this._dragMoved) {
        const id = this._dragId;
        this._clickCb?.(id);
        const click: ChartClickEvent = {
          id, price, time,
          paneIndex: this._downPane,
          point: { x: this._downX, y: this._downLocalY },
          ...this._clickInfo(e),
        };
        this.emit('click', click);
      }
      this._dragId = null;
      this._dragPriceScale = null;
      // Re-evaluate hover at the release point (mouse keeps hovering the line;
      // touch has no pointer any more) and drop the dragging visual state.
      const hit = e.pointerType === 'touch' ? null : this._hitAt(p.pane, p.x, p.localY);
      this._setHover(hit);
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
      return;
    }
    const wasPanning = this._dragging;
    this._dragging = false;
    // Placement mode: a press-drag-release is how every charting UI draws a
    // two-point shape, but the click branch below is gated on the pointer having
    // stayed still, so the gesture used to place nothing at all. Replay it as the
    // two clicks it means — press point, then release point. `viaDrag` lets the
    // host ignore the second one for single-anchor tools it already completed.
    if (this._placementMode && this._pointerMoved) {
      if (wasPanning) this._setHover(null);
      const p = this._localPoint(e);
      this._ensureScaled(this._downPane);
      const info = this._clickInfo(e);
      const press: ChartClickEvent = {
        id: null,
        price: this._priceAt(this._downPane, this._downLocalY),
        time: this._xToTime(this._downX),
        paneIndex: this._downPane,
        point: { x: this._downX, y: this._downLocalY },
        ...info,
      };
      this.emit('click', press);
      const release: ChartClickEvent = {
        id: null,
        price: this._priceAt(this._downPane, p.localY),
        time: this._xToTime(p.x),
        paneIndex: this._downPane,
        point: { x: p.x, y: p.localY },
        viaDrag: true,
        ...info,
      };
      this.emit('click', release);
      return;
    }
    // Always hit-test a clean click: the chart's own chrome (pane-legend
    // buttons) must work whether or not the host subscribed to clicks.
    if (!this._pointerMoved) {
      const hit = this._hitAt(this._downPane, this._downX, this._downLocalY);
      if (wasPanning) this._setHover(e.pointerType === 'touch' ? null : hit ?? null);
      // Pane-legend buttons are the chart's own chrome — handle them here so
      // the host doesn't have to re-implement remove/hide/move/maximize.
      if (hit && this._handleLegendAction(hit.externalId)) return;
      if (hit) this._clickCb?.(hit.externalId);
      // The event carries position and fires on empty plot too, which is what a
      // tool that *places* something (a drawing, an alert) needs; `id` is null
      // there. `subscribeClick` stays hit-only for back-compat.
      this._ensureScaled(this._downPane);
      const click: ChartClickEvent = {
        id: hit?.externalId ?? null,
        price: this._priceAt(this._downPane, this._downLocalY),
        time: this._xToTime(this._downX),
        paneIndex: this._downPane,
        point: { x: this._downX, y: this._downLocalY },
        // Modifier flags ride along so the draw tier can make a shift or
        // ctrl click additive to the selection; the payload carries no event.
        ...this._clickInfo(e),
      };
      this.emit('click', click);
      return;
    }
    if (wasPanning) this._setHover(null);
    // A mouse or pen release places the viewport precisely; only a touch flick coasts.
    if (wasPanning && this._navigation.panEnabled !== false && e.pointerType === 'touch' && e.type !== 'pointercancel'
      && KineticAnimation.shouldAnimate(this._dragVelocity)) this._startKinetic(this._dragVelocity);
  };

  /**
   * DOM pointerup entry point. Mirrors the primary-button guard in
   * `_onPointerDown`: a right-click (or any non-primary mouse button) fires
   * pointerdown *and* pointerup, but `_onPointerDown` ignores it — so the
   * down state (`_downX`/`_downLocalY`/`_downPane`/`_pointerMoved`) is never
   * refreshed and still holds the *previous* left-click. Letting a non-primary
   * pointerup through would re-run the click branch against that stale position
   * and replay the last click (e.g. re-firing a Buy/Sell button → a phantom
   * order). Touch and pen tip contact use button 0. The internal
   * recovery call from `_onPointerMove` invokes `_onPointerUp` directly, so it
   * bypasses this filter and still ends a drag when a button release is missed.
   */
  private readonly _onPointerUpNative = (e: PointerEvent): void => {
    if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && e.button !== 0) return;
    this._onPointerUp(e);
  };

  private readonly _onPointerCancel = (e: PointerEvent): void => {
    // Existing hosts still receive their end notification; transactional consumers
    // discard the draft first so cancellation can never become a saved edit.
    this._cancelPrimitiveDrag('pointercancel');
    if (this._pointers.has(e.pointerId)) this._pointerMoved = true;
    if (this._brandingPress?.pointerId === e.pointerId) this._brandingPress.moved = true;
    if (this._indicatorTogglePress?.pointerId === e.pointerId) this._indicatorTogglePress.moved = true;
    this._onPointerUp(e);
  };

  private readonly _onLostPointerCapture = (e: PointerEvent): void => {
    if (this._indicatorTogglePress?.pointerId === e.pointerId) {
      this._indicatorTogglePress.moved = true;
      this._onPointerUp(e);
      return;
    }
    // Another element can take capture before release. Abandon the pan without a click or fling.
    if (!this._pointers.has(e.pointerId) || this._dragId !== null || this._paneResize !== null || this._brandingPress !== null) return;
    if (this._pinch !== null || this._navigationCancelled) {
      this._navigationCancelled = true;
      this._pinch = null;
    }
    this._dragging = false;
    this._axisDrag = null;
    this._axisDragScale = null;
    this._dragVelocity = 0;
    this._pointerMoved = true;
    this._pointers.delete(e.pointerId);
    if (this._pointers.size === 0) this._navigationCancelled = false;
    this._endedPointers.add(e.pointerId);
    this._setHover(null);
  };

  /** The corner mark's hit at a container x and pane y, whatever else is there. */
  private _brandingHit(paneIndex: number, x: number, y: number): PrimitiveHit | null {
    const pane = this._panes[paneIndex];
    if (this._branding === null || !pane?.hasPrimitive(this._branding)) return null;
    const isBottom = paneIndex === this._bottomPaneIndex();
    return this._branding.hitTest(x - this._leftAxisWidth, y, {
      timeScale: this._timeScale, priceScale: pane.priceScale, dataLayer: this._dataLayer,
      plotWidth: this._width - this._leftAxisWidth - this._rightAxisWidth,
      plotHeight: (this._paneLayout()[paneIndex]?.height ?? 0) - (isBottom ? this._timeAxisHeight : 0),
      priceAxisWidth: this._rightAxisWidth, dpr: this._pixelRatio(), theme: this._theme,
    });
  }

  /**
   * What the pointer is over on a pane, at a container x and pane y. The
   * corner mark comes last: a note pinned over it, or anything else there,
   * is what the user can see and means to grab, and the mark is only a link.
   */
  private _hitAt(paneIndex: number, x: number, y: number): PrimitiveHit | null {
    return this._panes[paneIndex]?.hitTestPrimitives(x - this._leftAxisWidth, y, this._renderContext(paneIndex), this._branding)
      ?? this._brandingHit(paneIndex, x, y);
  }

  private readonly _onPointerLeave = (): void => {
    this._pointerInside = false;
    this._feedTimeNav(null);
    if (this._dragId === null) this._setHover(null); // keep the active state while dragging
    if (this._cursor !== null) {
      this._cursor = null;
      this._cursorPane = null;
      // clear the crosshair from every pane (global vertical line)
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
      // Pointer left the plot: legends fall back to the latest bar.
      for (const indicator of this._indicators) indicator.updateLegendValues();
      const cleared = { time: null, index: null, price: null, bar: null, point: null, paneIndex: null };
      this._crosshairCb?.(cleared);
      this.emit('crosshair:readout', cleared);
      this.emit('crosshair:move', cleared);
    }
  };

  private readonly _onWheel = (e: WheelEvent): void => {
    const delta = wheelPixels(e, this._width, this._height);
    if (delta.x === 0 && delta.y === 0) return;
    const p = this._localPoint(e);
    const onLeft = this._leftAxisWidth > 0 && p.x < this._leftAxisWidth;
    const onRight = this._rightAxisWidth > 0 && p.x >= this._width - this._rightAxisWidth;
    const horizontal = !onLeft && !onRight && !e.ctrlKey && !e.metaKey
      && (e.shiftKey || Math.abs(delta.x) > Math.abs(delta.y));
    if (horizontal ? this._navigation.panEnabled === false : this._navigation.zoomEnabled === false) return;
    if (!horizontal && delta.y === 0) return;
    this._unfreezeOverlay();
    e.preventDefault();
    this._stopKinetic();
    if (onLeft || onRight) {
      if (delta.y === 0) return;
      const slot = this._axisAt(p.pane, p.x);
      if (!slot) return;
      this._stopZoomGlide();
      const pane = this._panes[p.pane];
      const scale = pane.scaleFor(slot.scaleId);
      scale.scaleAtY(p.localY, Math.exp(-wheelLogFactor(delta.y)));
      this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Full));
      return;
    }
    if (horizontal) {
      this._stopZoomGlide();
      this._beginAutoscaleMotion();
      this._mutateTimeScale(() => this._timeScale.scrollByPixels(-(e.shiftKey && delta.x === 0 ? delta.y : delta.x)));
      this._maybeLoadHistory();
      this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Full));
      this._emitViewport('pan');
      return;
    }
    if (delta.y === 0) return;
    const focusX = this._zoomAnchor === 'right' && !e.ctrlKey && !e.metaKey
      ? this._timeScale.width : Math.max(0, Math.min(this._timeScale.width, p.x - this._leftAxisWidth));
    // Carry the unpainted distance across device changes and cursor movement.
    // Bound the target now so input at a limit cannot accumulate invisible debt.
    const remaining = this._zoomGlide === null ? 0 : this._zoomGlide.totalLogFactor - this._zoomGlideApplied;
    const spacing = this._timeScale.barSpacing;
    const target = this._timeScale.constrainBarSpacing(spacing * Math.exp(remaining + wheelLogFactor(delta.y)));
    const logFactor = Math.log(target / spacing);
    this._stopZoomGlide();
    if (logFactor === 0) return;
    if (!this._animZoom || !ZoomGlide.shouldAnimate(logFactor)) {
      this._applyZoom(focusX, logFactor);
      return;
    }
    const lead = logFactor * ZoomGlide.leadFraction();
    const epoch = this._navigationEpoch;
    this._applyZoom(focusX, lead);
    if (this._destroyed || epoch !== this._navigationEpoch) return;
    this._startZoomGlide(focusX, logFactor - lead);
  };

  /** One zoom step, applied now. Shared by the instant path and each glide frame. */
  private _applyZoom(focusX: number, logFactor: number): void {
    if (this._navigation.zoomEnabled === false) return;
    this._beginAutoscaleMotion();
    this._mutateTimeScale(() => this._timeScale.zoomAtX(focusX, Math.exp(logFactor)));
    this._maybeLoadHistory();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._emitViewport('zoom');
  }

  private _startZoomGlide(focusX: number, logFactor: number): void {
    if (this._navigation.zoomEnabled === false) return;
    const glide = new ZoomGlide(logFactor);
    this._zoomGlide = glide;
    this._zoomGlideStart = this._now();
    this._zoomGlideApplied = 0;
    let frames = 0;
    const step = (): void => {
      if (this._zoomGlide !== glide || this._destroyed || this._navigation.zoomEnabled === false) return;
      const elapsed = this._now() - this._zoomGlideStart;
      const applied = glide.appliedAt(elapsed);
      const delta = applied - this._zoomGlideApplied;
      this._zoomGlideApplied = applied;
      // A frame that moved nothing still costs a full-pane repaint, so skip it.
      if (delta !== 0) this._applyZoom(focusX, delta);
      if (this._zoomGlide !== glide || this._destroyed) return;
      if (!glide.finished(elapsed) && ++frames < ZOOM_GLIDE_MAX_FRAMES) {
        this._zoomHandle = this._raf.schedule(step);
      } else {
        // Land exactly on the target: the curve only approaches it.
        const remainder = glide.totalLogFactor - this._zoomGlideApplied;
        if (remainder !== 0) this._applyZoom(focusX, remainder);
        this._zoomHandle = null;
        this._zoomGlide = null;
      }
    };
    this._zoomHandle = this._raf.schedule(step);
  }

  private _beginAutoscaleMotion(): void {
    if (!this._animAutoscale || this._autoscaleTime !== null) return;
    this._autoscaleTime = this._now() - 16;
    this._autoscaleFrames = 0;
  }

  private _stopNavigationMotion(): void {
    this._navigationEpoch++;
    this._stopZoomGlide();
    this._stopKinetic();
    this._autoscaleTime = null;
  }

  private _stopZoomGlide(): void {
    if (this._zoomHandle !== null) {
      this._raf.cancel(this._zoomHandle);
      this._zoomHandle = null;
    }
    this._zoomGlide = null;
  }

  /**
   * Restore the preferred visible bar count and re-enable
   * auto-scaling on every price axis (undoing any pan/zoom or manual axis drag).
   * Same as double-clicking the chart.
   */
  public resetScale(): void {
    this._stopNavigationMotion();
    const before = this._timeScale.visibleRange();
    this._hasFitContent = this._fitDefaultView();
    for (const pane of this._panes) {
      // "Back to the default view" includes the ratio locks: one would otherwise
      // sit in the map holding a scale that has just been told to auto-fit.
      pane.clearRatioLocks();
      for (const scale of pane.scales()) scale.setAutoScale(true);
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._emitViewportIfMoved(before);
  }

  private readonly _onDblClick = (e: { clientX: number; clientY: number }): void => {
    // A count-control press cannot participate in a chart double click. The
    // browser counts clicks on the canvas even when the first collapsed a row;
    // two later plot or axis presses retain the normal double-click action.
    if (this._lastPressOnIndicatorToggle || this._previousPressOnIndicatorToggle) return;
    const p = this._localPoint(e);
    if (this._indicatorLegendHit(p.pane, p.x, p.localY)) return;
    // The mark's own double click does nothing; one on a drawing over it is the drawing's.
    if (this._brandingHit(p.pane, p.x, p.localY)
      && !this._panes[p.pane]?.hitTestPrimitives(p.x - this._leftAxisWidth, p.localY, this._renderContext(p.pane), this._branding)) return;
    const ev: DoubleClickEvent = { paneIndex: p.pane, x: p.x, y: p.y, handled: false };
    this.emit('dblclick', ev);
    // While a tool is armed a double-click means "finish this shape" — a
    // variable-anchor tool has no other way to end — so it must not also throw
    // the view back to its default mid-placement. A listener that took the
    // press for itself has said so on the event.
    if (this._placementMode || ev.handled) return;
    if (this._doubleClick === 'reset' && this._navigation.zoomEnabled !== false) this.resetScale();
    else if (this._doubleClick === 'maximize') this.maximizePane(p.pane);
  };

  // ── multi-touch pinch (zoom + two-finger pan) ─────────────────────────────
  private _beginPinch(): void {
    this._cancelPrimitiveDrag('pinch');
    this._brandingPress = null;
    this._indicatorTogglePress = null;
    const pts = [...this._pointers.values()];
    this._pinch = pinchState(pts[0], pts[1]);
    this._pinchPane = pts[0].pane;
    // abort any single-pointer interaction so it doesn't fight the pinch
    this._dragging = false; this._axisDrag = null; this._axisDragScale = null; this._dragId = null; this._pointerMoved = true;
    this._dragPriceScale = null;
    this._setHover(null);
  }

  private _updatePinch(): void {
    const pts = [...this._pointers.values()];
    if (pts.length < 2 || this._pinch === null) return;
    const cur = pinchState(pts[0], pts[1]);
    const d = pinchDelta(this._pinch, cur);
    this._pinch = cur;
    const zoom = this._navigation.zoomEnabled !== false && d.factor !== 1;
    const pan = this._navigation.panEnabled !== false && (d.dx !== 0 || d.dy !== 0);
    if (!zoom && !pan) return;
    this._beginAutoscaleMotion();
    this._mutateTimeScale(() => {
      if (zoom) this._timeScale.zoomAtX(cur.cx, d.factor);
      if (pan) this._timeScale.setRightOffset(this._timeScale.rightOffset - d.dx / this._timeScale.barSpacing);
    });
    if (pan && d.dy !== 0 && !this._collapsedShown(this._pinchPane)) this._panes[this._pinchPane]?.priceScale.panByPixels(d.dy);
    this._maybeLoadHistory();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._emitViewport(zoom ? 'zoom' : 'pan');
  }

  // ── keyboard navigation (focus the chart, then arrows / +- / Home) ────────
  private _cancelPrimitiveDrag(reason: 'pointercancel' | 'pinch' | 'escape'): void {
    if (this._dragId === null) return;
    this._dragMoved = true;
    this.emit('drag:cancel', { id: this._dragId, paneIndex: this._downPane, reason });
  }

  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    this._unfreezeOverlay();
    // Opt-in drafts own Escape without stranding legacy consumers that require a release.
    if (e.key === 'Escape' && this._dragCancelOnEscape && this._dragId !== null && !ShortcutManager.shouldIgnore(e.target)) {
      this._cancelPrimitiveDrag('escape');
      this._dragId = null;
      this._dragPriceScale = null;
      this._dragging = false;
      this._pointerMoved = true;
      for (const id of this._pointers.keys()) this._endedPointers.add(id);
      this._pointers.clear();
      this._setHover(null);
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
      e.preventDefault();
      return;
    }
    const sc = this._shortcuts;
    if (sc === null || ShortcutManager.shouldIgnore(e.target) || !this._shortcutsActive()) return;
    const cmd = sc.resolve(e);
    if (cmd === null) return;
    if (!this._navigationAllowed(cmd)) return;
    let handled = this._runShortcut(cmd);
    if (!handled) handled = sc.runCustom(cmd);
    if (!handled) return;
    e.preventDefault();
    sc.emitTrigger(cmd);
    this._maybeLoadHistory();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
  };

  /** Scope gating: hover keeps keys chart-local; global always acts. */
  private _shortcutsActive(): boolean {
    if (this._shortcuts === null) return false;
    if (this._shortcuts.scope === 'global' || this._pointerInside) return true;
    const active = this._doc.activeElement as Node | null;
    return active !== null && (active === this._container || this._container.contains?.(active) === true);
  }

  /** Execute a built-in command; returns false for unknown (custom) commands. */
  private _runShortcut(command: string): boolean {
    if (!this._navigationAllowed(command)) return false;
    const ts = this._timeScale;
    // Keyboard navigation moves the same viewport a drag or a wheel does, so it
    // announces itself the same way: a chart linked into a grid must follow an
    // arrow key, not only a gesture. `panUp` / `panDown` move a price scale, not
    // the time window, and deliberately emit nothing (the payload is a time
    // range, and `_emitViewportIfMoved` sees no movement in it anyway).
    const pan = (bars: number): boolean => {
      this._stopZoomGlide();
      this._beginAutoscaleMotion();
      const before = ts.visibleRange();
      this._mutateTimeScale(() => ts.setRightOffset(ts.rightOffset + bars));
      this._emitViewportIfMoved(before);
      return true;
    };
    const zoom = (factor: number): boolean => {
      this._stopZoomGlide();
      this._beginAutoscaleMotion();
      const before = ts.visibleRange();
      this._mutateTimeScale(() => ts.zoomAtX(this._width / 2, factor));
      this._emitViewportIfMoved(before);
      return true;
    };
    switch (command) {
      case 'panLeftBar': return pan(-1);
      case 'panRightBar': return pan(1);
      case 'panLeft': return pan(-2);
      case 'panRight': return pan(2);
      case 'panLeftFast': return pan(-10);
      case 'panRightFast': return pan(10);
      case 'panUp': this._primaryPane.priceScale.panByPixels(20); return true;
      case 'panDown': this._primaryPane.priceScale.panByPixels(-20); return true;
      case 'zoomIn': return zoom(1.1);
      case 'zoomOut': return zoom(1 / 1.1);
      case 'resetScale': this.resetScale(); return true;
      case 'fitContent': this.fitContent(); return true;
      case 'screenshot': this.downloadScreenshot(); return true;
      case 'toggleGridVert': this.setGridOptions({ vertLines: !this._gridVert }); return true;
      case 'toggleGridHorz': this.setGridOptions({ horzLines: !this._gridHorz }); return true;
      case 'toggleCrosshairMagnet': this._crosshairMode = this._crosshairMode === 'magnet' ? 'normal' : 'magnet'; return true;
      default: return false;
    }
  }

  /**
   * Composite the full chart (all panes + overlays) and trigger a PNG download.
   * This is what the screenshot keyboard shortcut runs; call it from a toolbar
   * button for a reliable "save image" — the browser's native right-click
   * "Save image as…" captures only the topmost (transparent overlay) canvas.
   */
  public downloadScreenshot(filename = 'chart.png'): void {
    try {
      const canvas = this.takeScreenshot();
      const a = this._doc.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = filename;
      a.click();
    } catch { /* ignore (tainted canvas / no DOM) */ }
  }

  /** Refresh the polite live-region summary screen readers announce. */
  private _updateAccessibleSummary(): void {
    if (this._liveRegion === null) return;
    const n = this._dataLayer.length;
    let txt = `${n} bar${n === 1 ? '' : 's'}`;
    if (this._firstDataId.value !== null && this._panes.includes(this._primaryPane)) {
      const last = this._dataLayer.lastIndexedBar(this._firstDataId.value);
      if (last !== null) txt += `, latest price ${this._primaryPane.priceScale.format(last.bar.close)}`;
    }
    this._liveRegion.textContent = `Financial chart, ${txt}`;
  }

  /**
   * Track the primitive under the pointer: apply its cursor hint to the
   * container and repaint on hover enter/leave so lines/pills can render
   * hover states (they read `hoverId` off the render context).
   */
  private _setHover(hit: PrimitiveHit | null): void {
    const id = hit?.externalId ?? null;
    const key = hit?.hoverKey ?? id;
    this._container.style.cursor = this._dragging && hit?.cursor !== 'pointer' ? 'grabbing' : hit?.cursor ?? '';
    if (id === this._hoverId && key === this._hoverKey) return;
    const changedId = id !== this._hoverId;
    // Hover-styled primitives on the base canvas need a light repaint, no
    // rescale. A change that touches only 'top' primitives (leaving a drawing
    // for another, or for empty space) is the overlay's alone: the pointer
    // moves sixty times a second, and repainting the series for a line it
    // merely passes over is a stutter.
    const onBase = hit !== null && hit.zOrder !== 'top';
    const level = onBase || this._hoverOnBase ? InvalidationLevel.Light : InvalidationLevel.Cursor;
    this._hoverId = id;
    this._hoverKey = key;
    this._hoverOnBase = onBase;
    this.invalidate((m) => m.invalidateGlobal(level));
    if (changedId) this.emit('hover', { id });
  }

  private _updateCursor(paneIndex: number, x: number, localY: number, containerY: number, source: PointerEvent): void {
    // Plot spans [leftAxisWidth, width - priceAxisWidth]; work in plot-relative x.
    const rightEdge = this._width - this._rightAxisWidth;
    const plotX = x - this._leftAxisWidth;
    const plotWidth = Math.max(0, rightEdge - this._leftAxisWidth);
    if (plotX < 0 || plotX > plotWidth) {
      this._onPointerLeave();
      return;
    }
    const pane = this._panes[paneIndex];
    const hit = this._hitAt(paneIndex, x, localY);
    // A pane boundary beats a primitive hit: the divider is a thin target and
    // the legend rows sit right below one.
    if (hit === null && this._dividerAt(containerY) !== null) {
      this._setHover(null);
      this._container.style.cursor = 'row-resize';
      return;
    }
    this._setHover(hit);
    // The navigator reveals on pointer position, not on hover id — see the note
    // in time-navigator.ts. Only the lowest open pane carries it.
    // The hover label occupies the same bottom strip as the navigation row.
    this._feedTimeNav(paneIndex === this._timeNavPane && !this._brandingHit(paneIndex, x, localY)
      ? { x: plotX, y: localY } : null);
    let y = localY;
    const index = Math.round(this._timeScale.xToIndex(plotX));
    let hoveredBar: Bar | null = null;
    if (this._firstDataId.value !== null) {
      const bars = this._dataLayer.visibleBars(this._firstDataId.value, index, index);
      if (bars.length > 0) {
        hoveredBar = bars[0].bar;
        // Magnet only snaps within the pane that holds the price series — never
        // in the volume/indicator panes (their scale isn't a price scale).
        if (this._crosshairMode === 'magnet' && paneIndex === this._firstPaneSlot()) {
          const snapped = magnetSnapPrice(pane.yToPrice(localY), hoveredBar);
          y = pane.priceToY(snapped);
        }
      }
    }
    this._cursorPane = paneIndex;
    this._cursor = { x: plotX, y }; // plot-relative; the crosshair line is drawn inside the plot shift
    this._readoutTime = hoveredBar?.time ?? null;
    // Legend rows read the bar under the crosshair, like every charting package.
    for (const indicator of this._indicators) indicator.updateLegendValues(index);
    // global crosshair → repaint every pane's overlay (cheap; base untouched)
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
    if (this._crosshairCb !== null || this._listeners.get('crosshair:move') !== undefined || this._listeners.get('crosshair:readout') !== undefined) {
      const time = this._dataLayer.indexToTime(index);
      const move: CrosshairMoveEvent = {
        time: time ?? null,
        index,
        price: this._priceAt(paneIndex, localY),
        bar: hoveredBar,
        point: { x, y: containerY },
        paneIndex,
        // Whether a pointer is down for this move. Placement mode swallows the
        // pan path, so this is the only way a consumer can tell a hover from a
        // drag while it is still happening — what freehand drawing samples.
        pressed: this._pointers.size > 0,
        ...pointerInfo(source),
        // Only while pressed: a hover has no trail worth carrying, and the key
        // set of the hover payload is what hosts and tests pin.
        ...(this._pointers.size > 0 ? { samples: this._dragSamples(source) } : {}),
      };
      this._crosshairCb?.(move);
      this.emit('crosshair:readout', move);
      this.emit('crosshair:move', move);
    }
  }

  private _maybeLoadHistory(): void {
    if (this._historyLoader === null || this._loadingHistory) return;
    const range = this._timeScale.visibleRange();
    if (range.from < 10) {
      this._loadingHistory = true;
      this.emit('lazy-load', {
        from: this._dataLayer.indexToTime(Math.round(range.from)) ?? null,
        to: this._dataLayer.indexToTime(Math.round(range.to)) ?? null,
        direction: 'backward',
      });
      this._historyLoader();
    }
  }

  /**
   * Coast after a flick. Runs on the INJECTED scheduler, not the global
   * requestAnimationFrame: a host that supplies its own raf expects to own
   * every frame this chart schedules, and reaching past it also made the
   * glide untestable, which is why the missing pan event on each frame went
   * unnoticed until a browser drove it.
   */
  private _startKinetic(velocity: number): void {
    if (this._navigation.panEnabled === false) return;
    this._stopKinetic();
    const epoch = this._kineticEpoch;
    const anim = new KineticAnimation(velocity);
    if (anim.durationMs <= 0) return;
    const start = this._now();
    let lastDist = 0;
    // A frame budget as well as a time budget. The loop is bounded in time, but
    // it re-schedules itself through the injected scheduler, and a host may run
    // that synchronously (the test harness does, deliberately, so a repaint is
    // observable inline). Time-based termination alone then never fires and the
    // loop recurses until the stack goes. A glide is well under a second, so
    // ten seconds of frames is a ceiling no real animation reaches.
    let frames = 0;
    const step = (): void => {
      if (epoch !== this._kineticEpoch || this._destroyed || this._navigation.panEnabled === false) return;
      const elapsed = this._now() - start;
      const dist = anim.distanceAt(elapsed);
      const delta = dist - lastDist;
      lastDist = dist;
      this._beginAutoscaleMotion();
      this._mutateTimeScale(() => this._timeScale.setRightOffset(this._timeScale.rightOffset - delta / this._timeScale.barSpacing));
      this._maybeLoadHistory();
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      // The glide is a pan like any other and has to say so. Without this the
      // drag emits its last event at the moment the pointer lifts, and everything
      // downstream (a linked chart, a host tracking the visible range) is left on
      // that window while this one coasts on for another few hundred milliseconds.
      this._emitViewport('pan');
      if (epoch !== this._kineticEpoch || this._destroyed) return;
      if (!anim.finished(elapsed) && ++frames < KINETIC_MAX_FRAMES) {
        this._kineticHandle = this._raf.schedule(step);
      } else {
        this._kineticHandle = null;
      }
    };
    this._kineticHandle = this._raf.schedule(step);
  }

  private _stopKinetic(): void {
    this._kineticEpoch++;
    if (this._kineticHandle !== null) {
      this._raf.cancel(this._kineticHandle);
      this._kineticHandle = null;
    }
  }

  /**
   * True once `destroy()` has run. Anything holding a chart it did not create
   * (a link group, a controller, a host cache) needs to know the object is a
   * corpse before it calls into it: inferring it from a side effect such as an
   * empty pane list works only for as long as nothing else can empty one.
   */
  public get isDestroyed(): boolean {
    return this._destroyed;
  }
  private _destroyed = false;
  private _destroying = false;

  public destroy(): void {
    if (this._destroyed || this._destroying) return;
    this._destroying = true;
    this._barsRequests.abort();
    this._timeScale.setChangeHandler(null);
    this._loop.stop();
    if (this._remeasureHandle !== null) {
      this._raf.cancel(this._remeasureHandle);
      this._remeasureHandle = null;
    }
    this._stopNavigationMotion();
    for (const indicator of this._indicators.splice(0)) indicator.remove({ force: true });
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._deviceObserver?.disconnect();
    this._deviceObserver = null;
    this._unwatchPixelRatio();
    if (typeof window !== 'undefined') {
      const el = this._container;
      el.removeEventListener('pointerdown', this._onPointerDown);
      el.removeEventListener('pointermove', this._onPointerMove);
      el.removeEventListener('pointerup', this._onPointerUpNative);
      el.removeEventListener('pointercancel', this._onPointerCancel);
      el.removeEventListener('lostpointercapture', this._onLostPointerCapture);
      el.removeEventListener('pointerleave', this._onPointerLeave);
      el.removeEventListener('wheel', this._onWheel);
      el.removeEventListener('dblclick', this._onDblClick);
      el.removeEventListener('pointerenter', this._onPointerEnter);
      el.removeEventListener('contextmenu', this._onContextMenu);
      this._keyTarget?.removeEventListener('keydown', this._onKeyDown as EventListener);
      this._keyTarget = null;
    }
    this._liveRegion?.remove();
    this._liveRegion = null;
    this._container.style.cursor = ''; // drop any hover cursor hint we applied
    this._pointers.clear();
    for (const pane of this._panes) pane.destroy(); // detaches primitives + removes element
    this._panes.length = 0;
    this._seriesProvenance.clear();
    // Announced last, with the chart already torn down: a 'destroy' listener is
    // there to let go of it (unsubscribe, drop it from a link group), not to
    // read it, and it must see the same dead object every other holder sees.
    this._destroyed = true;
    this.emit('destroy', {});
    // Subscriptions on a destroyed chart would otherwise be retained forever,
    // keeping every listener's closure (and whatever it captured) alive.
    this._listeners.clear();
  }
}

/** Create a chart inside the given container element. */
export function createChart(container: HTMLElement, options: ChartOptions = {}): Chart {
  return new Chart(container, options);
}

/**
 * Render a shortcut combo for a tooltip: physical key codes turned into the
 * symbols a user recognises (`Equal` -> `+`, `ArrowDown` -> `↓`).
 */
function prettyCombo(combo: string): string {
  const KEYS: Record<string, string> = {
    Equal: '+', Minus: '-', NumpadAdd: '+', NumpadSubtract: '-',
    ArrowLeft: '<', ArrowRight: '>', ArrowUp: '^', ArrowDown: 'v',
  };
  return combo.split('+').map((p) => p.trim())
    .map((p) => (p === 'Mod' ? 'Ctrl' : KEYS[p] ?? p.replace(/^(Key|Digit)/, '')))
    .join(' + ');
}
