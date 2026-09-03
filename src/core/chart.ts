/**
 * Top-level chart orchestrator (ARCHITECTURE.md §3.3). Owns the shared
 * DataLayer + time scale, the panes, the invalidate mask, and the render loop.
 * Phase 2 renders static candlesticks with price/time axes; pan/zoom (Phase 3)
 * and live data (Phase 4) build on this.
 */
import { InvalidateMask, InvalidationLevel } from './invalidate-mask';
import { RenderLoop, type RafScheduler, type RafCanceller } from './render-loop';
import { Pane, type PaneRenderContext } from './pane';
import { type ChartTheme, DEFAULT_THEME } from '../theme';
import { TimeScale } from '../scale/time-scale';
import type { LogicalRange } from '../scale/time-scale';
import type { PriceScaleOptions, PriceScaleMode, PriceScale } from '../scale/price-scale';
import { medianBarInterval, type TickMarkType, type SessionClockOptions, type BarCountdownOptions } from '../render/axis';
import { resolvePlotMargins, type CanvasOptions, type GridOptions } from '../render/grid';
import { DataLayer } from '../model/data-layer';
import { createSeriesRecord, type SeriesApi, type SeriesRecord, type PriceScaleId } from '../model/series';
import { getChartType, type SeriesType } from '../model/chart-type-registry';
import {
  getIndicator, hasIndicator, plotStyleKeys,
  type IndicatorDescriptor, type IndicatorSettings,
} from '../model/indicator-registry';

/**
 * Colours the 2nd and later instances of the same indicator rotate through.
 * Chosen to stay apart on both dark and light panes and to read as distinct at
 * a 1px stroke, which rules out near-neighbour hues.
 */
/** PaneLegend's own defaults, restated so a pane can be reset to them. */
const DEFAULT_LEGEND_TOP = 6;
const DEFAULT_LEGEND_LEFT = 8;
/** How close to the chart top counts as "in the host's corner", in media px. */
const LEGEND_TOP_EPS = 12;

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

const INSTANCE_PALETTE: readonly string[] = [
  '#f5a623', '#26a69a', '#ab47bc', '#ef5350',
  '#26c6da', '#8bc34a', '#ff7043', '#5c6bc0',
];
import { IndicatorInstance, type IndicatorApi, type IndicatorHost } from '../model/indicator-instance';
import {
  CHART_STATE_VERSION,
  type ChartState,
  type PaneState,
  type SeriesState,
  type RestoreReport,
} from '../model/chart-state';
import type { SeriesStyle } from '../render/series-style';
import type { Bar, SeriesDataItem } from '../model/bar';
import { toBar } from '../model/bar';
import { KineticAnimation } from '../input/kinetic';
import { ZoomGlide } from '../input/zoom-glide';
import { magnetSnapPrice, type CrosshairMode } from '../input/crosshair';
import { ShortcutManager } from '../input/shortcuts';
import type { ShortcutManagerOptions } from '../input/shortcuts';
import { TradingController, DEFAULT_TRADING_COLORS, type TradingColors, type TradingSettings } from './trading-controller';
import { pinchState, pinchDelta, type PinchState } from '../input/touch';
import { beginPick, type PickKind } from '../input/pick';
import type { IPrimitive, PrimitiveHost, PrimitiveHit, PrimitiveAnchor, PrimitivePlacement } from '../primitives/primitive';
import { PriceLine, type PriceLineOptions } from '../primitives/price-line';
import { SeriesMarkers } from '../primitives/markers';
import { EventMarkers, type ChartEvent } from '../primitives/event-markers';
import { PaneLegend, type PaneLegendAction, type LegendStatusLineOptions } from '../primitives/pane-legend';
import { ChartTable } from '../primitives/table';
import { TimeNavigator, type TimeNavigatorOptions } from '../primitives/time-navigator';
import type { ChartSettingsState } from '../model/chart-settings';
import { DEFAULT_TIMEZONE, isValidTimezone } from '../feed/time';
import { clamp } from '../helpers/math';

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

export interface ChartOptions {
  document?: Document;
  pixelRatio?: () => number;
  raf?: { schedule: RafScheduler; cancel?: RafCanceller };
  /** Full palette; pass `lightTheme` (the default), `darkTheme`, or a custom ChartTheme. */
  theme?: ChartTheme;
  priceAxisWidth?: number;
  timeAxisHeight?: number;
  /**
   * Where indicator legend rows start inside **one** pane, in media px. A host
   * that draws its own overlay in a pane's top-left corner — an OHLC readout, a
   * symbol line, a trade panel — needs to push these clear of it, or the rows
   * land underneath and their settings / close buttons become invisible and
   * unclickable.
   *
   * It follows whichever pane currently renders at that corner, which is
   * normally pane 0 — but maximizing a lower pane parks the others at a
   * placeholder weight, so the maximized pane moves into the same corner and
   * inherits the offset. Every other pane keeps the default corner, because a
   * short lower pane would have its legend pushed off it entirely.
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
  /**
   * What a wheel zoom holds still: the bar under the cursor, or the right edge
   * (the latest bar). Default `'cursor'`, which is what the chart has always
   * done. `'right'` keeps the most recent bar pinned while history stretches
   * away from it, which is what a live chart usually wants.
   */
  zoomAnchor?: ZoomAnchor;
  /** Enable OHLC-preserving conflation when zoomed out (§4.4). Default false. */
  conflate?: boolean;
  /** Conflation aggressiveness (default 1). */
  conflationFactor?: number;
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
}

export interface AddSeriesOptions {
  /** Target pane index (0 = price). Higher panes are created on demand. */
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
   * `price` (tick-size precision), `volume` (compact 1.2K / 3.4M / 5.6B), or a
   * `custom` formatter (currency, percent, ...).
   */
  priceFormat?:
    | { type: 'price'; precision?: number; minMove?: number }
    | { type: 'volume' }
    | { type: 'custom'; formatter: (value: number) => string };
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
  /** Strip this scale is drawn in. The overlay scale reports 'right' and draws none. */
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
  /** Whether `movePriceAxis` would do anything: something to move, and a free side. */
  movable: boolean;
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
  private readonly _loop: RenderLoop;
  /** The frame scheduler, kept for the one-shot re-measure after construction. */
  private readonly _raf: { schedule: RafScheduler; cancel: RafCanceller };
  private _remeasureHandle: number | null = null;
  private readonly _dataLayer = new DataLayer();
  private readonly _timeScale = new TimeScale();
  private readonly _priceAxisWidth: number;
  private readonly _timeAxisHeight: number;
  private _pending: InvalidateMask | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _width = 0;
  private _height = 0;
  private _hasFitContent = false;

  // interaction state
  private _crosshairMode: CrosshairMode;
  private _shortcuts: ShortcutManager | null = null;
  private _trading: TradingController | null = null;
  private _pointerInside = false;
  private _keyTarget: HTMLElement | Document | null = null;
  private readonly _now: () => number;
  private readonly _conflate: boolean;
  private readonly _conflationFactor: number;
  private _gridVert = true;
  private _gridHorz = true;
  /** The Canvas option block: overrides of the theme, never a copy of it. */
  private readonly _canvas: CanvasOptions = {};
  /** Status-line switches pushed onto every pane legend, host-added ones included. */
  private readonly _statusLine: LegendStatusLineOptions = {};
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
  private _zoomHandle: number | null = null;
  /** The glide in flight, so a second wheel tick folds into it (see ZoomGlide.add). */
  private _zoomGlide: ZoomGlide | null = null;
  private _zoomGlideStart = 0;
  private _zoomGlideApplied = 0;
  private _zoomGlideX = 0;
  private readonly _animZoom: boolean;
  private readonly _zoomAnchor: ZoomAnchor;
  private readonly _firstDataId: { value: number | null } = { value: null };
  /** Handle + record of the primary price series (see `primarySeries`). */
  private _primary: { api: SeriesApi; record: SeriesRecord } | null = null;
  private readonly _indicators: IndicatorInstance[] = [];
  /** Guards indicator recompute against re-entry via its own `series.setData`. */
  private _recomputing = false;
  private _indicatorsDirty = false;
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
  /** Pane currently maximized, and the weights to restore when it un-maximizes. */
  private _maximizedPane: number | null = null;
  /** Legend rows per pane, so new ones stack below existing ones. */
  private readonly _legends: { legend: PaneLegend; paneIndex: number }[] = [];
  /** Pane holding the primary price series (only this pane gets magnet snapping). */
  private _firstPaneIndex = 0;
  private _historyLoader: (() => void) | null = null;
  private _loadingHistory = false;
  private _clickCb: ((externalId: string) => void) | null = null;
  private _crosshairCb: ((e: CrosshairMoveEvent) => void) | null = null;
  private _pointerMoved = false;
  /** While true, pointer gestures place anchors instead of panning. */
  private _placementMode = false;
  /** Where indicator legend rows start inside a pane (see `legendOffset`). */
  private readonly _legendOffset: { top: number; left: number } = { top: 6, left: 8 };
  private _downPane = 0;
  private _downX = 0;
  private _downLocalY = 0;
  private _dragId: string | null = null; // externalId of the primitive being dragged
  private _hoverId: string | null = null; // externalId of the primitive under the pointer
  private _overlayFrozen = false; // native context menu open: keep the save-image snapshot
  private _dragCb: ((externalId: string, price: number, time: number) => void) | null = null;
  private _dragEndCb: ((externalId: string, price: number, time: number) => void) | null = null;
  // axis-drag rescale (price axis = vertical, time axis = horizontal)
  private _axisDrag: 'price' | 'time' | null = null;
  /** The scale a price-axis drag is rescaling: either side's, whichever strip was grabbed. */
  private _axisDragScale: PriceScale | null = null;
  /** Active pane-divider drag: which boundary, and the weights/heights at grab time. */
  /** True once a primitive drag has actually moved — see the pointerup note. */
  private _dragMoved = false;
  /** Where the drag was grabbed, in data space, so deltas start at the press. */
  private _dragFrom: { time: number; price: number } = { time: 0, price: 0 };
  private _paneResize: {
    index: number; startY: number;
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
  private _timeNav: TimeNavigator | null = null;
  /** Pane the navigator is currently attached to, so it can follow the bottom. */
  private _timeNavPane = -1;

  public constructor(container: HTMLElement, options: ChartOptions = {}) {
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
    this._zoomAnchor = options.zoomAnchor ?? 'cursor';
    this._conflate = options.conflate ?? false;
    this._conflationFactor = options.conflationFactor ?? 1;
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
    // Margins are the price scale's own state in fraction units; the canvas
    // block only carries the dialog's percentages. Fold them in before the
    // first pane exists, so `_addPane` applies both together.
    const margins = resolvePlotMargins(this._canvas.margins);
    if (margins.marginTop !== undefined || margins.marginBottom !== undefined) {
      this._priceScaleOptions = { ...this._priceScaleOptions, ...margins };
    }
    const nav = options.timeNavigator ?? true;
    if (nav !== false) {
      this._timeNav = new TimeNavigator(
        { ...(nav === true ? {} : nav), hints: this._navHints(nav === true ? undefined : nav) },
        this._now,
      );
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
    this._observeSize();
    this._attachInput();
    // A host that mutates the time scale directly (e.g. setVisibleLogicalRange to
    // preserve zoom across a data reload) still triggers a repaint.
    this._timeScale.setChangeHandler(() => this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full)));
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

  public get timeScale(): TimeScale {
    return this._timeScale;
  }

  /** Restore a saved logical range (e.g. preserve the user's zoom across a data reload). */
  public setVisibleLogicalRange(range: LogicalRange): void {
    const before = this._timeScale.visibleRange();
    this._timeScale.setVisibleLogicalRange(range);
    this._emitViewportIfMoved(before);
  }

  /** The current visible logical range. */
  public getVisibleLogicalRange(): LogicalRange {
    return this._timeScale.visibleRange();
  }

  /** Fit all bars into view (no-arg convenience; bar count from the data). */
  public fitContent(): void {
    if (this._dataLayer.length <= 0) return;
    const before = this._timeScale.visibleRange();
    this._timeScale.fitContent(this._dataLayer.length);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._emitViewportIfMoved(before);
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
  }

  /** Add a series and return its data handle. */
  public addSeries(type: SeriesType, options: AddSeriesOptions = {}): SeriesApi {
    return this._createSeries(type, options, true);
  }

  /**
   * `claimPrimary` is false for series the chart creates on a caller's behalf
   * (indicator plots), so an indicator's line never becomes the price series
   * that drives the magnet crosshair and the OHLC legend.
   */
  private _createSeries(type: SeriesType, options: AddSeriesOptions, claimPrimary: boolean): SeriesApi {
    const dataId = this._dataLayer.createSeries();
    const paneIndex = options.paneIndex ?? 0;
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
      this._firstPaneIndex = paneIndex;
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
    const pane = this._panes[paneIndex];
    const scale = pane.scaleOf(record);
    if (options.priceFormat) {
      const pf = options.priceFormat;
      if (pf.type === 'custom') scale.setPriceFormatter(pf.formatter);
      else if (pf.type === 'volume') scale.setPriceFormatter(compactVolume);
      else {
        const minMove = pf.minMove ?? (pf.precision !== undefined ? Math.pow(10, -pf.precision) : undefined);
        if (minMove !== undefined) scale.setOptions({ minMove });
      }
    }
    if (record.style.precision !== undefined) this._applyPrecision(scale, record.style.precision);

    const api: SeriesApi = {
      setData: (bars: readonly SeriesDataItem[]): void => this._setData(dataId, bars.map(toBar)),
      prependData: (bars: readonly SeriesDataItem[]): void => this._prependData(dataId, bars.map(toBar)),
      update: (bar: SeriesDataItem): void => this._updateBar(dataId, toBar(bar)),
      getData: (): Bar[] => this._dataLayer.indexedBars(dataId).map((ib) => ib.bar),
      applyOptions: (patch: Partial<SeriesStyle>): void => {
        Object.assign(record.style, patch);
        // Precision is a label override on the scale, not a style the renderer
        // reads, so it needs pushing across when it changes (including back to
        // "Default", which is the key present and undefined).
        if ('precision' in patch) this._applyPrecision(pane.scaleOf(record), patch.precision);
        this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      },
      remove: (): void => {
        pane.removeSeries(record);
        this._dataLayer.removeSeries(dataId);
        if (this._firstDataId.value === dataId) this._firstDataId.value = null;
        if (this._primary?.record === record) this._primary = null;
        this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
        this._recomputeAxisColumns();
        this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      },
      priceScale: (): PriceScale => pane.scaleOf(record),
      createMarkers: (): SeriesMarkers => {
        const m = new SeriesMarkers(dataId);
        // Resolved now, not at creation: primitives are addressed by slot, and
        // this series' slot may have shifted since.
        this._addPrimitive(this._panes.indexOf(pane), m);
        return m;
      },
    };
    if (isPrimary) this._primary = { api, record };
    return api;
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

  /** Add a horizontal price line (order/SL/TP/alert/level) to a pane. */
  public addPriceLine(opts: PriceLineOptions, paneIndex = 0): PriceLine {
    const line = new PriceLine(opts);
    this._addPrimitive(paneIndex, line);
    return line;
  }

  /** Add an earnings/dividend/split event-marker strip to a pane. */
  public addEventMarkers(paneIndex = 0): EventMarkers {
    const em = new EventMarkers();
    this._addPrimitive(paneIndex, em);
    return em;
  }

  /**
   * Hand the chart the corporate-action / news calendar and let it own the
   * strip. The difference from `addEventMarkers` is who filters: holding the
   * full list here is what lets `setEventOptions` (the settings dialog's Events
   * switches) turn a type off and back on without the host re-supplying data.
   */
  public setEvents(events: readonly ChartEvent[], paneIndex = 0): void {
    this._events = events;
    this._eventPane = paneIndex;
    this._syncEvents();
  }

  /** Turn event types on/off. Unlisted types stay visible. */
  public setEventOptions(patch: ChartEventOptions): void {
    Object.assign(this._eventVisible, patch);
    this._syncEvents();
  }

  public eventOptions(): ChartEventOptions {
    return { ...this._eventVisible };
  }

  private _syncEvents(): void {
    if (this._eventMarkers === null) {
      if (this._events.length === 0) return; // nothing to show, nothing to build
      this._eventMarkers = new EventMarkers();
      this._addPrimitive(this._eventPane, this._eventMarkers);
    }
    const visible = this._eventVisible as Record<string, boolean | undefined>;
    this._eventMarkers.setEvents(this._events.filter((e) => visible[e.type] !== false));
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
   */
  public addIndicator(
    indicatorId: string,
    settings: Readonly<IndicatorSettings> = {},
    options: { paneIndex?: number } = {},
  ): IndicatorApi {
    const descriptor = getIndicator(indicatorId);
    const instance = new IndicatorInstance(
      this._indicatorHost(),
      descriptor,
      this._distinctColors(descriptor, settings),
      options.paneIndex,
    );
    this._indicators.push(instance);
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
   * Every live indicator instance, in the order they were added.
   *
   * Flushes any pending recompute first. Indicator maths is deferred to the
   * frame, so a caller that updates a bar and reads a value back in the same
   * turn would otherwise see the previous tick's numbers.
   */
  public indicators(): readonly IndicatorApi[] {
    this._flushIndicators();
    return this._indicators;
  }

  /** Remove one indicator instance by its handle id. Returns true if it existed. */
  public removeIndicator(instanceId: string): boolean {
    const i = this._indicators.findIndex((x) => x.id === instanceId);
    if (i < 0) return false;
    const { indicatorId, paneIndex } = this._indicators[i];
    this._indicators[i].remove();
    this._indicators.splice(i, 1);
    this.emit('indicatorRemoved', { instanceId, indicatorId, paneIndex });
    // An indicator pane that just emptied has nothing left to show. This lived
    // in the legend's close handler, so only the on-chart × pruned the pane — a
    // host removing the same indicator from its own UI left it behind, and
    // `getState` then persisted the orphan, so every reload restored a blank
    // region. Doing it here means every caller behaves the same.
    if (paneIndex > 0 && this._panes[paneIndex]?.series().length === 0) this.removePane(paneIndex);
    return true;
  }

  private _indicatorHost(): IndicatorHost {
    return {
      flushIndicators: (): void => this._flushIndicators(),
      // The scale that draws the ladder is the one that decides how a number on
      // that pane is written, floor, tick, custom formatter and all.
      formatPrice: (paneIndex: number, value: number): string | undefined =>
        this._panes[paneIndex]?.priceScale.format(value),
      addIndicatorLegend: (o): PaneLegend => {
        // The first legend on a non-price pane also carries the pane-level
        // controls (move / maximize), the way a charting pane toolbar does;
        // extra rows keep only their own show / settings / delete.
        const paneActions: PaneLegendAction[] =
          o.row === 0 && o.paneIndex > 0
            ? ['hide', 'settings', 'up', 'down', 'maximize', 'close']
            : ['hide', 'settings', 'close'];
        // _syncLegendOffsets decides which pane wears the offset, and runs on
        // every relayout; this is just the initial placement.
        const legend = new PaneLegend({ ...o, actions: paneActions });
        this._addPrimitive(o.paneIndex, legend);
        return legend;
      },
      removeIndicatorLegend: (legend): void => {
        this.removePrimitive(legend);
        this._restackLegends();
      },
      legendRowsOn: (paneIndex): number => this._legends.filter((l) => l.paneIndex === paneIndex).length,
      addIndicatorSeries: (type, paneIndex, style, priceScaleId): SeriesApi =>
        this._createSeries(
          type as SeriesType,
          { paneIndex, style: style as SeriesStyle | undefined, priceScaleId: priceScaleId as PriceScaleId | undefined },
          false,
        ),
      addIndicatorLevel: (l, paneIndex): PriceLine => {
        // `dashed` rides along beside `lineStyle` because a descriptor written
        // before the three-way style existed still sets only the boolean, and
        // PriceLine reads it when `lineStyle` is absent.
        const opts: PriceLineOptions = {
          price: l.price, color: l.color, lineWidth: l.lineWidth, dashed: l.dashed,
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
      nextPaneIndex: (): number => this._panes.length,
      // The calendar a session anchor resets on and the calendar the axis is
      // labelled in have to be the same one, or a VWAP restarts in the middle
      // of the afternoon the axis is showing.
      timezone: (): string => this._timezone,
      // The same clock the countdown row reads, so an indicator that decides
      // whether the last bar is still forming agrees with the axis about it.
      // `symbol` and `interval` are deliberately absent: the core is handed
      // bars and never an instrument, and a host that knows one implements its
      // own IndicatorHost rather than having the engine invent a name.
      now: (): number => this._wallClock(),
      // The tick size the price scale is already formatting and snapping to.
      // Unlike symbol and interval, the chart genuinely knows this one, so an
      // indicator sizing a range in ticks does not have to be told twice.
      //
      // Answered per pane, so a pane that does not quote the instrument says
      // undefined (see `_scalePatchFor`). That is what the legend beside that
      // axis wants; an indicator's `calc` wants the instrument's own tick, and
      // asks pane 0 for it.
      tickSize: (paneIndex: number): number | undefined => {
        const pane = this._panes[paneIndex] ?? this._panes[0];
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
        pane.priceScale.setFixedRange(range);
        if (range === null) pane.priceScale.setAutoScale(true);
      },
    };
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
    if (!this._indicatorsDirty) return;
    if (this._recomputing || this._indicators.length === 0) {
      this._indicatorsDirty = false;
      return;
    }
    this._indicatorsDirty = false;
    this._recomputing = true;
    try {
      for (const indicator of this._indicators) indicator.recompute();
    } finally {
      this._recomputing = false;
    }
  }

  /** Subscribe to clicks on hit-testable primitives (markers, events, lines). */
  public subscribeClick(cb: (externalId: string) => void): void {
    this._clickCb = cb;
  }

  /**
   * Subscribe to crosshair movement for an OHLC legend / tooltip. The callback
   * fires with the hovered bar of the primary price series on every move, and
   * with all-null fields when the pointer leaves the plot.
   */
  public subscribeCrosshairMove(cb: (e: CrosshairMoveEvent) => void): void {
    this._crosshairCb = cb;
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
    pane.autoscale(this._renderContext(paneIndex === this._bottomPaneIndex()));
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
  // 'click', 'dblclick', 'hover', 'drag', 'drag:end', 'pan', 'zoom', 'resize',
  // 'lazy-load', 'paneAdded', 'paneRemoved', 'paneMoved', 'paneMaximized', 'paneResized',
  // 'priceAxisMoved', 'indicatorRemoved', 'indicatorSettings', 'destroy'. The
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

  /** Public: attach any primitive (indicators, profiles, custom overlays) to a pane. */
  public addPrimitive(primitive: IPrimitive, where: number | PrimitivePlacement = 0): void {
    if (typeof where === 'number') { this._addPrimitive(where, primitive); return; }
    // Chart furniture: a brand mark, a corner clock. It belongs to the CHART,
    // not to whichever pane happens to be last, so the engine re-homes it as
    // panes come and go instead of every host writing its own placeWatermark().
    this._anchored.push({ primitive, anchor: where.anchor });
    this._addPrimitive(this._anchorTarget(where.anchor), primitive);
  }

  /** The pane a chart anchor currently resolves to. */
  private _anchorTarget(anchor: PrimitiveAnchor): number {
    return anchor === 'chart-bottom' ? this._bottomPaneIndex() : this._topPaneIndex();
  }

  /**
   * Move every chart-anchored primitive to the pane its anchor now names.
   *
   * Called after anything that changes which pane sits at an edge: a pane added,
   * removed, moved, or maximized. Maximize matters most and is the case a host
   * cannot easily handle itself: it HIDES the other panes, so a mark pinned to
   * pane 0 vanishes with it rather than merely sitting in the wrong place.
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
   * doesn't exist. The inverse is `coordinateToPrice`.
   */
  public priceToCoordinate(price: number, paneIndex = 0): number | null {
    this._ensureScaled(paneIndex);
    const pane = this._panes[paneIndex];
    if (pane === undefined) return null;
    const top = this._paneLayout()[paneIndex]?.top ?? 0;
    return top + pane.priceToY(price);
  }

  /** Map a container-relative media-px Y back to a price on a pane (inverse of priceToCoordinate). */
  public coordinateToPrice(y: number, paneIndex = 0): number | null {
    this._ensureScaled(paneIndex);
    const pane = this._panes[paneIndex];
    if (pane === undefined) return null;
    const top = this._paneLayout()[paneIndex]?.top ?? 0;
    return pane.yToPrice(y - top);
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
    if (patch.grid) this.setGridOptions(patch.grid); // keeps the visibility pair in step
    if (patch.crosshair) this._canvas.crosshair = { ...this._canvas.crosshair, ...patch.crosshair };
    if (patch.scales) this._canvas.scales = { ...this._canvas.scales, ...patch.scales };
    if (patch.margins) {
      this._canvas.margins = { ...this._canvas.margins, ...patch.margins };
      // No second margin state: the price scale already owns marginTop/Bottom
      // as fractions, and this only converts the dialog's percentages.
      this.setPriceScaleOptions(resolvePlotMargins(this._canvas.margins), 'axes');
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
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
   * Pane 0 is one from birth. Any other pane starts out an indicator's, so a
   * host adding a second symbol to a pane of its own has to be able to promote
   * one after the fact, or the comparison would lose the tick-sized axis it has
   * always had.
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

  /** The primary pane's price-scale options (what the Scales tab reads). */
  public priceScaleOptions(): PriceScaleOptions {
    return { ...this._panes[0].priceScale.options };
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
      if (on) pane.setRatioLock('right', false, 0, 0);
      pane.priceScale.setAutoScale(on);
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
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
  public priceAxisState(paneIndex = 0, scaleId: PriceScaleId = 'right'): PriceAxisState | null {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return null;
    const scale = pane.scaleFor(scaleId);
    const side: 'right' | 'left' = scaleId === 'left' ? 'left' : 'right';
    const other: 'right' | 'left' = side === 'left' ? 'right' : 'left';
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
      movable: scaleId !== '' && pane.usesScale(scaleId) && !pane.usesScale(other),
    };
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
    return ok;
  }

  /**
   * Move a pane's price axis to the other strip, taking the series that map to
   * it and everything the axis was set to. Returns false when that side carries
   * nothing, or when the other side is already occupied: one strip draws one
   * axis (see `Pane.moveSeriesScale`), which is what `movable` reports.
   */
  public movePriceAxis(paneIndex: number, from: 'right' | 'left', to: 'right' | 'left'): boolean {
    const pane = this._panes[paneIndex];
    if (pane === undefined || !pane.moveSeriesScale(from, to)) return false;
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

  /** Measure one scale on demand, the way `_ensureScaled` does for the pane's right one. */
  private _ensureScaledFor(paneIndex: number, scaleId: PriceScaleId): void {
    const pane = this._panes[paneIndex];
    if (pane === undefined || pane.scaleFor(scaleId).scaled) return;
    pane.autoscale(this._renderContext(paneIndex === this._bottomPaneIndex()));
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
  }

  public statusLineOptions(): LegendStatusLineOptions {
    return { ...this._statusLine };
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
  }

  /** The axis-chrome switches as they stand. */
  public axisChromeOptions(): AxisChromeOptions {
    return { ...this._axisChrome };
  }

  /** Crosshair behaviour ('normal' or 'magnet'). Set it via `applyOptions`. */
  public crosshairMode(): CrosshairMode {
    return this._crosshairMode;
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
      const y = Math.round((layout[i]?.top ?? 0) * dpr);
      g.drawImage(this._panes[i].base.element, 0, y);
      g.drawImage(this._panes[i].top.element, 0, y);
    }
    return out;
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
      requestUpdate: (): void =>
        this.invalidate((m) => m.invalidatePane(paneIndex, {
          level: primitive.zOrder() === 'top' ? InvalidationLevel.Cursor : InvalidationLevel.Light,
          autoScale: false,
        })),
    };
    this._panes[paneIndex].addPrimitive(primitive, host);
    // Track legend rows however they were added — a host can add its own (a
    // symbol/OHLC row) and indicator legends must stack beneath it.
    if (primitive instanceof PaneLegend) {
      this._legends.push({ legend: primitive, paneIndex });
      // A row added after the switches were set still obeys them; a legend that
      // brought its own `statusLine` keeps whatever it set on top. Skipped when
      // the chart has no switches to push, which is the usual case: `setOptions`
      // asks for a repaint, and asking for one to write an empty object is a
      // frame nobody needed.
      if (Object.keys(this._statusLine).length > 0) {
        const own = primitive.options().statusLine;
        primitive.setOptions({ statusLine: { ...this._statusLine, ...own } });
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
    for (const entry of this._legends) {
      const row = rowByPane.get(entry.paneIndex) ?? 0;
      entry.legend.setOptions({ row });
      rowByPane.set(entry.paneIndex, row + 1);
    }
    this._syncLegendOffsets();
  }

  /**
   * Apply `legendOffset` to whichever pane currently renders at the chart's
   * top-left, rather than a fixed index.
   *
   * The offset describes a region of the *chart* the host has covered with its
   * own overlay — a symbol line, an OHLC readout. Normally that is pane 0, but
   * maximizing a lower pane parks the others at a placeholder weight, so the
   * maximized pane ends up rendering in that same corner. Pinning the offset to
   * pane 0 left it drawing its legend straight through the host's readout.
   *
   * Host-added legend rows are left alone: the host positions its own.
   */
  private _syncLegendOffsets(): void {
    const layout = this._paneLayout();
    for (const entry of this._legends) {
      if (!entry.legend.options().id.startsWith('indicator:')) continue;
      // A collapsed pane above still occupies a fraction of a pixel, so "at the
      // top" is a tolerance rather than an equality.
      const atTop = (layout[entry.paneIndex]?.top ?? Number.POSITIVE_INFINITY) <= LEGEND_TOP_EPS;
      entry.legend.setOptions(
        atTop
          ? { top: this._legendOffset.top, left: this._legendOffset.left }
          : { top: DEFAULT_LEGEND_TOP, left: DEFAULT_LEGEND_LEFT },
      );
    }
  }

  /** A host for the (lazy-loaded) trade layer to attach/detach its primitives on a pane. */
  public tradeHost(paneIndex = 0): { addPrimitive(p: IPrimitive): void; removePrimitive(p: IPrimitive): void } {
    return {
      addPrimitive: (p: IPrimitive): void => this._addPrimitive(paneIndex, p),
      removePrimitive: (p: IPrimitive): void => this.removePrimitive(p),
    };
  }

  /** Apply one live bar; auto-scroll only on a genuine right-edge append. */
  private _updateBar(dataId: number, bar: Bar): void {
    const wasAtRight = this._timeScale.rightOffset >= 0;
    const kind = this._dataLayer.update(dataId, bar);
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    // Only a real append advances the view; late/historical inserts must not
    // be treated as a new right-edge bar (would wrongly auto-scroll / shift).
    if (kind === 'append' && !wasAtRight) {
      this._timeScale.setRightOffset(this._timeScale.rightOffset - 1);
    }
    if (dataId === this._firstDataId.value) this._invalidateIndicators();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
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

  private _setData(dataId: number, bars: readonly Bar[]): void {
    this._dataLayer.setSeriesData(dataId, bars);
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
      this._timeScale.fitContent(this._dataLayer.length);
      this._hasFitContent = true;
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
  }

  /** History paging: merge older bars, preserving the viewport (§4.2). */
  private _prependData(dataId: number, bars: readonly Bar[]): void {
    this._dataLayer.addBars(dataId, bars);
    // baseIndex shifts up by the inserted count; updating it keeps the same
    // bars on screen because (rightEdge − index) is invariant.
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    if (dataId === this._firstDataId.value) this._invalidateIndicators();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
  }

  private _addPane(weight = 1): Pane {
    const pane = new Pane(this._doc);
    pane.weight = weight;
    // Pane 0 quotes the instrument by construction: it is where `addSeries`
    // puts a series that names no pane, and it exists before any host has said
    // what goes on it. Every later pane is made for an indicator, so it holds
    // its own units until a price series lands on it (`_claimPricePane`), and
    // inherits the chart-wide defaults without the instrument's tick.
    if (this._panes.length === 0) this._pricePanes.add(pane);
    else {
      // Independent of whether a host ever declares a tick. Most do not, and an
      // oscillator on a chart with no tick at all still has to print a reading
      // fine enough to compare against its own levels.
      for (const scale of pane.scales()) scale.setOptions({ minPrecision: NON_INSTRUMENT_PRECISION });
    }
    pane.priceScale.setPriceFormatter(this._priceFormatter);
    if (this._priceScaleOptions) pane.priceScale.setOptions(this._scalePatchFor(pane, this._priceScaleOptions));
    this._panes.push(pane);
    this._container.appendChild(pane.element);
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
  }

  /**
   * Arm the next plot click to answer with a price or a bar time, handed to
   * `cb`. Returns a cancel function; arming another pick on this chart cancels
   * the pending one. `pick:start` and `pick:end` bracket it so a host can show
   * its own cursor while the pick is live. See `input/pick` for why this does
   * not touch placement mode.
   */
  public beginPick(kind: PickKind, cb: (value: number) => void): () => void {
    return beginPick(this, kind, cb);
  }

  /** Swap the palette at runtime (dark/light toggle) without recreating the chart. */
  public setTheme(theme: ChartTheme): void {
    this._theme = theme;
    this._container.style.background = theme.background;
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
    priceScale?: Partial<PriceScaleOptions>;
    priceFormatter?: ((price: number) => string) | null;
    timeFormatter?: ((utcSeconds: number, tickMark?: TickMarkType) => string) | undefined;
    timezone?: string;
    crosshairMode?: CrosshairMode;
  }): void {
    if (opts.theme) this.setTheme(opts.theme);
    if (opts.grid) this.setGridOptions(opts.grid);
    if (opts.canvas) this.setCanvasOptions(opts.canvas);
    if (opts.statusLine) this.setStatusLineOptions(opts.statusLine);
    if (opts.priceScale) this.setPriceScaleOptions(opts.priceScale);
    if (opts.priceFormatter !== undefined) this.setPriceFormatter(opts.priceFormatter);
    if ('timeFormatter' in opts) this.setTimeFormatter(opts.timeFormatter);
    if (opts.timezone !== undefined) this.setTimezone(opts.timezone);
    if (opts.crosshairMode) this._crosshairMode = opts.crosshairMode;
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
    const panes: PaneState[] = this._panes.map((pane) => {
      const scale = pane.priceScale;
      const o = scale.options;
      const state: PaneState = {
        weight: pane.weight,
        priceScale: {
          marginTop: o.marginTop, marginBottom: o.marginBottom, minMove: o.minMove,
          mode: o.mode, inverted: o.inverted, autoScale: scale.autoScale,
        },
      };
      if (!scale.autoScale) state.priceScale.range = { ...scale.priceRange() };
      return state;
    });

    const series: SeriesState[] = [];
    this._panes.forEach((pane, paneIndex) => {
      for (const record of pane.series()) {
        series.push({ type: record.type, style: { ...record.style }, paneIndex, priceScaleId: record.scaleId });
      }
    });

    const state: ChartState & ChartSettingsState & { timezone: string } = {
      version: CHART_STATE_VERSION,
      // Saved unconditionally, including the default: a layout restored after
      // the default itself changes should still read the hours it was saved with.
      timezone: this._timezone,
      viewport: { ...this.getVisibleLogicalRange() },
      barSpacing: this._timeScale.barSpacing,
      grid: this.gridOptions(),
      // The settings dialog's own slice. It lives beside `grid` rather than
      // inside it because these are chart-wide overrides, and it is declared by
      // the settings module so `ChartState` stays the shape of the core.
      canvas: this.canvasOptions(),
      statusLine: this.statusLineOptions(),
      trading: { ...this._tradingSettings },
      // The two switches, never the clock function: a callback does not survive
      // JSON, and the host that supplied one supplies it again on the way back.
      axisChrome: {
        sessionClock: this._axisChrome.sessionClock,
        barCountdown: this._axisChrome.barCountdown,
      },
      events: this.eventOptions(),
      crosshairMode: this._crosshairMode,
      panes,
      series,
      indicators: this._indicators.map((i) => ({
        indicatorId: i.indicatorId,
        settings: i.settings(),
        paneIndex: i.paneIndex,
      })),
    };
    if (this._drawingState !== undefined) state.drawings = this._drawingState;
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
  public restoreState(state: unknown): RestoreReport {
    const s = state as (ChartState & ChartSettingsState & { timezone?: unknown }) | null;
    if (s === null || typeof s !== 'object' || typeof s.version !== 'number') {
      return { applied: false, series: [], indicators: 0, reason: 'not a chart state object' };
    }
    if (s.version > CHART_STATE_VERSION) {
      return { applied: false, series: [], indicators: 0, reason: `state version ${s.version} is newer than ${CHART_STATE_VERSION}` };
    }

    if (s.grid) this.setGridOptions(s.grid);
    // Canvas before the panes: its margins are chart-wide, and a pane's own
    // saved marginTop/marginBottom is the more specific answer, so it must land
    // last and win.
    if (s.canvas) this.setCanvasOptions(s.canvas);
    if (s.statusLine) this.setStatusLineOptions(s.statusLine);
    if (s.trading) this.setTradingSettings(s.trading);
    if (s.axisChrome) this.setAxisChromeOptions(s.axisChrome);
    if (s.events) this.setEventOptions(s.events);
    if (s.crosshairMode) this._crosshairMode = s.crosshairMode;
    // A saved zone is data of unknown provenance, so an unrecognised name is
    // skipped rather than thrown: the rest of the layout is still restorable,
    // and a whole saved workspace should not be lost to one stale zone name.
    if (typeof s.timezone === 'string' && isValidTimezone(s.timezone)) this.setTimezone(s.timezone);

    // The panes themselves first: the indicators below are placed by index, so
    // the panes have to exist and be weighted before they are rebuilt. Their
    // price scales are *not* set here, see below.
    if (s.panes) {
      s.panes.forEach((ps, i) => {
        this._ensurePane(i);
        this._panes[i].weight = ps.weight;
      });
      this._relayout();
    }

    // Indicators are fully derivable from the source data, so they *can* be
    // recreated. Replace rather than append, so restore is idempotent.
    let indicators = 0;
    if (s.indicators) {
      for (const instance of this._indicators) instance.remove();
      this._indicators.length = 0;
      // The band an oscillator declares for its own pane (RSI 0..100) is
      // declared by the instance that *claimed* that pane. A restored instance
      // is handed its pane index instead of claiming one, so it declares
      // nothing, while the outgoing instance withdrew its band on the way out:
      // the pane was left free-autoscaling and re-measured itself against the
      // oscillator's own values. Re-declare it here, taking the first indicator
      // on each pane as the one that made it, which is what creation order
      // means and what the saved order preserves.
      const declared = new Set<number>();
      for (const spec of s.indicators) {
        if (!hasIndicator(spec.indicatorId)) continue; // tier not loaded — skip, don't throw
        const descriptor = getIndicator(spec.indicatorId);
        this._indicators.push(new IndicatorInstance(
          this._indicatorHost(), descriptor, spec.settings, spec.paneIndex,
        ));
        indicators += 1;
        if (spec.paneIndex > 0 && !declared.has(spec.paneIndex)) {
          declared.add(spec.paneIndex);
          this._panes[spec.paneIndex]?.priceScale.setFixedRange(descriptor.range?.(spec.settings) ?? null);
        }
      }
    }

    // Price scales last of all, for the same reason the canvas block goes
    // first: this is the most specific answer for each pane, and everything
    // above moves ranges around. Rebuilding an indicator in particular takes a
    // pane's axis with it, so a scale restored before that step is a scale the
    // restore then throws away.
    if (s.panes) {
      s.panes.forEach((ps, i) => {
        const pane = this._panes[i];
        if (pane === undefined) return;
        const scale = pane.priceScale;
        // Filtered like a chart-wide patch, and for a sharper reason: a saved
        // tick on an oscillator's pane is a tick that was broadcast there, not
        // one anybody chose, and it is exactly what a layout saved before this
        // was fixed carries. Restoring it faithfully would put the wrong
        // precision back on a pane the chart-wide setter no longer reaches to
        // correct, so the defect would outlive the fix in every saved workspace.
        scale.setOptions(this._scalePatchFor(pane, {
          marginTop: ps.priceScale.marginTop, marginBottom: ps.priceScale.marginBottom,
          minMove: ps.priceScale.minMove, mode: ps.priceScale.mode, inverted: ps.priceScale.inverted,
        }));
        scale.setAutoScale(ps.priceScale.autoScale);
        if (!ps.priceScale.autoScale && ps.priceScale.range) scale.setPriceRange(ps.priceScale.range);
      });
    }

    // A saved pane only exists to hold an indicator, and an indicator is skipped
    // when its tier was never imported — so a restore can leave a pane behind
    // with nothing in it. An empty pane still claims its weight and still draws
    // a default 0..100 axis, which reads as a large blank region under the
    // chart. Drop them, the same way removing the last indicator from a pane
    // already does. Walk backwards so the indices stay valid as panes go.
    for (let i = this._panes.length - 1; i > 0; i--) {
      if (this._panes[i].series().length === 0) this.removePane(i);
    }

    this._drawingState = s.drawings;
    if (s.barSpacing !== undefined) this._timeScale.setBarSpacing(s.barSpacing);
    if (s.viewport && this._dataLayer.length > 0) this.setVisibleLogicalRange(s.viewport);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
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
  }

  public invalidate(build: (mask: InvalidateMask) => void): void {
    if (this._pending === null) this._pending = new InvalidateMask();
    build(this._pending);
    this._loop.requestFrame();
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
  }

  public applySize(width: number, height: number): void {
    if (width === this._width && height === this._height) return;
    this._width = width;
    this._height = height;
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('resize', { width, height });
  }

  /** Distribute height across panes by weight; sync the shared time-scale width. */
  private _relayout(): void {
    this._syncTimeNavPane();
    // Weights just changed, so the pane at the chart's top may have too.
    this._syncLegendOffsets();
    const dpr = this._pixelRatio();
    const total = this._weightTotal();
    const topPane = this._topPaneIndex();
    const bottomPane = this._bottomPaneIndex();
    this._panes.forEach((pane, paneIndex) => {
      const share = this._layoutWeight(paneIndex);
      const h = (this._height * share) / total;
      // No share means gone, not merely short: a zero-height box still paints
      // its separator hairline, and its canvases still answer hit tests.
      pane.element.style.display = share > 0 ? '' : 'none';
      // The DOM box is given the SAME pixel height the canvas is sized to,
      // rather than a flex ratio. With `flex: w 1 0` the browser distributed the
      // container's *real* height while the canvas used `this._height` — so any
      // drift between the two (a container that resized before the observer
      // fired) silently offset every hit-test from what was drawn: pane
      // boundaries, legend buttons, and crosshair mapping all landed elsewhere.
      // Deriving both from one number makes layout == hit-test by construction.
      pane.element.style.flex = `0 0 ${h}px`;
      // A hairline between stacked panes — every pane but the first. Drawn on
      // the DOM box, so it sits exactly on the boundary the user drags.
      const first = paneIndex === topPane;
      pane.element.style.borderTopWidth = first ? '0px' : '1px';
      pane.element.style.borderTopColor = first ? 'transparent' : this._theme.paneSeparator;
      pane.resize(this._width, h, dpr);
      // Scale height is a layout property — see Pane.setScaleHeights.
      const isLast = paneIndex === bottomPane;
      pane.setScaleHeights(Math.max(0, h - (isLast ? this._timeAxisHeight : 0)));
    })
    this._timeScale.setWidth(Math.max(0, this._width - this._rightAxisWidth - this._leftAxisWidth));
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
    const anyLeft = this._panes.some((p) => p.hasLeftScale());
    const anyRight = this._panes.some((p) => p.usesScale('right'));
    const left = anyLeft ? this._priceAxisWidth : 0;
    const right = anyRight || !anyLeft ? this._priceAxisWidth : 0;
    if (left === this._leftAxisWidth && right === this._rightAxisWidth) return;
    this._leftAxisWidth = left;
    this._rightAxisWidth = right;
    this._relayout();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
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

  /** Last pane with a share of the chart: the one that owns the time axis. */
  private _bottomPaneIndex(): number {
    for (let i = this._panes.length - 1; i >= 0; i--) if (this._layoutWeight(i) > 0) return i;
    return this._panes.length - 1;
  }

  private _weightTotal(): number {
    let total = 0;
    for (let i = 0; i < this._panes.length; i++) total += this._layoutWeight(i);
    return total <= 0 ? 1 : total;
  }

  /** Grab tolerance around a pane boundary, in media px. */
  private static readonly DIVIDER_GRAB = 4;

  /**
   * Index of the pane whose *bottom* boundary is within grab range of `y`, or
   * null. Boundary `i` separates pane `i` from pane `i + 1`; the last pane's
   * bottom is the chart edge and is not draggable.
   */
  private _dividerAt(y: number): number | null {
    const layout = this._paneLayout();
    for (let i = 0; i < layout.length - 1; i++) {
      const boundary = layout[i].top + layout[i].height;
      if (Math.abs(y - boundary) <= Chart.DIVIDER_GRAB) return i;
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
  }

  public paneWeight(index: number): number {
    return this._panes[index]?.weight ?? 0;
  }

  /**
   * Remove a pane, everything drawn in it, and any indicator that lives there.
   * Pane 0 (price) is never removable — removing it would leave the chart with
   * no time axis owner.
   *
   * Returns false when the index is out of range or is pane 0.
   */
  public removePane(index: number): boolean {
    if (index <= 0 || index >= this._panes.length) return false;
    // Indicators own their series, so let them tear themselves down first —
    // otherwise their series rows would outlive the pane holding them.
    for (let i = this._indicators.length - 1; i >= 0; i--) {
      if (this._indicators[i].paneIndex !== index) continue;
      this._indicators[i].remove();
      this._indicators.splice(i, 1);
    }
    const pane = this._panes[index];
    for (const record of [...pane.series()]) {
      pane.removeSeries(record);
      this._dataLayer.removeSeries(record.dataId);
      if (this._firstDataId.value === record.dataId) this._firstDataId.value = null;
    }
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
    this.emit('paneRemoved', { paneIndex: index });
    return true;
  }

  /**
   * Move a pane up or down one slot. Pane 0 (price) is pinned — it owns the
   * primary series and the shared price context — so a move that would displace
   * it is refused.
   */
  public movePane(index: number, direction: -1 | 1): boolean {
    const target = index + direction;
    if (index <= 0 || target <= 0 || index >= this._panes.length || target >= this._panes.length) return false;
    const panes = this._panes;
    [panes[index], panes[target]] = [panes[target], panes[index]];
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
    this.emit('paneMoved', { from: index, to: target });
    return true;
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
    // so chrome pinned to pane 0 disappears rather than merely sitting wrong.
    this._rehomeAnchored();
    this.emit('paneMaximized', { paneIndex: this._maximizedPane });
    return true;
  }

  /** The maximized pane index, or null when none is. */
  public maximizedPane(): number | null {
    return this._maximizedPane;
  }

  /**
   * Route a pane-legend button press. Ids look like `indicator:<instanceId>::close`.
   * Returns true when the id was ours and was handled.
   */
  private _handleLegendAction(externalId: string): boolean {
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
      case 'close':
        this.removeIndicator(instanceId);   // prunes its pane if it emptied
        return true;
      case 'hide': indicator.setVisible(!indicator.visible()); return true;
      case 'up': this.movePane(paneIndex, -1); return true;
      case 'down': this.movePane(paneIndex, 1); return true;
      case 'maximize': this.maximizePane(paneIndex); return true;
      // The engine is canvas-only and ships no DOM, so the settings form is the
      // host's. Everything it needs to *generate* one is on the descriptor
      // (`inputs`), and applying it is `indicator.setSettings(patch)`.
      case 'settings':
        this.emit('indicatorSettings', { instanceId, indicatorId: indicator.indicatorId, paneIndex });
        return true;
      default: return false;
    }
  }

  /** Cumulative top + height of each pane, by weight (the source of truth for hit-testing). */
  private _paneLayout(): { top: number; height: number }[] {
    const total = this._weightTotal();
    const out: { top: number; height: number }[] = [];
    let top = 0;
    for (let i = 0; i < this._panes.length; i++) {
      const h = (this._height * this._layoutWeight(i)) / total;
      out.push({ top, height: h });
      top += h;
    }
    return out;
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
      if (e.command !== 'zoomIn' && e.command !== 'zoomOut') continue;
      const combo = e.combos[0];
      if (combo !== undefined) out[e.command] = prettyCombo(combo);
    }
    return out;
  }

  /**
   * Keep the navigator on the bottom pane — it belongs just above the time
   * axis, and adding or removing a pane moves which one that is.
   */
  private _syncTimeNavPane(): void {
    if (this._timeNav === null) return;
    const target = this._bottomPaneIndex();
    if (target === this._timeNavPane || target < 0) return;
    if (this._timeNavPane >= 0) this._panes[this._timeNavPane]?.removePrimitive(this._timeNav);
    this._addPrimitive(target, this._timeNav);
    this._timeNavPane = target;
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

  private _renderContext(showTimeAxis: boolean): PaneRenderContext {
    return {
      timeScale: this._timeScale,
      dataLayer: this._dataLayer,
      dpr: this._pixelRatio(),
      priceAxisWidth: this._rightAxisWidth,
      timeAxisHeight: this._timeAxisHeight,
      showTimeAxis,
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
      dragId: this._dragId,
      sessionClock: this._sessionClockOptions(),
      barCountdown: this._barCountdownOptions(),
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
      if (entry) this.applySize(entry.contentRect.width, entry.contentRect.height);
    });
    this._resizeObserver.observe(this._container);
  }

  private _onFrame(): void {
    // Before the mask is taken, not after: recomputing writes plot data, which
    // invalidates, and that invalidation has to land in this frame's mask
    // rather than in the next frame's.
    this._flushIndicators();

    const mask = this._pending;
    this._pending = null;
    if (mask === null || mask.isEmpty()) return;

    const global = mask.globalLevel;
    for (let i = 0; i < this._panes.length; i++) {
      const pane = this._panes[i];
      const perPane = mask.paneInvalidation(i);
      const level = Math.max(global, perPane?.level ?? InvalidationLevel.None);
      const isBottom = i === this._bottomPaneIndex();
      const ctx = this._renderContext(isBottom);
      if (level >= InvalidationLevel.Full || perPane?.autoScale) pane.autoscale(ctx);
      if (level >= InvalidationLevel.Light) pane.paintBase(ctx);
      if (level >= InvalidationLevel.Cursor && !this._overlayFrozen) {
        // Global crosshair: every pane draws the vertical line at the shared x;
        // only the hovered pane draws the horizontal line + price tag; the bottom
        // pane draws the date tag.
        const cross = this._cursor === null
          ? null
          : { x: this._cursor.x, yLocal: i === this._cursorPane ? this._cursor.y : null, showTimeTag: isBottom };
        pane.paintTop(cross, ctx);
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
    el.addEventListener('pointercancel', this._onPointerUp);
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
      price: onPlot ? this._panes[p.pane].yToPrice(p.localY) : null,
      time: index === null ? null : (this._dataLayer.indexToTime(index) ?? null),
      index,
      target: this._contextTarget(p, plotX, onPlot, index),
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
    plotX: number,
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
      const side: 'right' | 'left' = onRightAxis ? 'right' : 'left';
      return { kind: 'price-scale', id: null, side, scaleId: this._axisScaleId(p.pane, side) };
    }

    const hit = this._panes[p.pane]?.hitTestPrimitives(plotX, p.localY, this._renderContext(isBottom));
    if (hit != null) {
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
    const type = index === null ? null : this._seriesAt(p.pane, index, p.localY);
    return type === null ? { kind: 'empty', id: null } : { kind: 'series', id: null, seriesType: type };
  }

  /**
   * Which of a pane's scales an axis strip acts on. Normally the side's own
   * one, but a pane whose only values sit on the hidden overlay scale (a volume
   * pane, an indicator that plots against nothing else) has no series on either
   * side, and the overlay is the scale a menu raised there has to act on.
   */
  private _axisScaleId(paneIndex: number, side: 'right' | 'left'): PriceScaleId {
    const pane = this._panes[paneIndex];
    if (pane === undefined || pane.usesScale(side)) return side;
    return pane.usesScale('') ? '' : side;
  }

  /**
   * Which series the pointer sits on, if any. A pane is one bitmap, so "on the
   * candle" has to be recomputed rather than looked up: take each series'
   * autoscale extents for the bar under the cursor and test the band they span,
   * with a few px of slack so a 1px line is still a target.
   */
  private _seriesAt(paneIndex: number, index: number, localY: number): SeriesType | null {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return null;
    const tol = 3;
    for (const record of pane.series()) {
      if (record.style.visible === false) continue;
      const bars = this._dataLayer.visibleBars(record.dataId, index, index);
      if (bars.length === 0) continue;
      const ext = getChartType(record.type).extents(bars[0].bar, record.style);
      if (!isFinite(ext.min) || !isFinite(ext.max)) continue;
      const scale = pane.scaleOf(record);
      const a = scale.priceToY(ext.max);
      const b = scale.priceToY(ext.min);
      if (localY >= Math.min(a, b) - tol && localY <= Math.max(a, b) + tol) return record.type;
    }
    return null;
  }

  /** Resume overlay repaints after the native context menu closes. */
  private _unfreezeOverlay(): void {
    if (!this._overlayFrozen) return;
    this._overlayFrozen = false;
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
  }

  private _localPoint(e: { clientX: number; clientY: number }): { x: number; y: number; pane: number; localY: number; paneHeight: number } {
    const rect = this._container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Map Y to a pane by cumulative *weighted* heights — matches the DOM/canvas layout.
    const layout = this._paneLayout();
    let pane = 0;
    for (let i = 0; i < layout.length; i++) if (y >= layout[i].top) pane = i;
    const pl = layout[pane] ?? { top: 0, height: this._height };
    return { x, y, pane, localY: y - pl.top, paneHeight: pl.height };
  }

  private readonly _onPointerDown = (e: PointerEvent): void => {
    this._unfreezeOverlay();
    // Only the primary button starts a pan / line-drag. A right-click (context
    // menu) also fires pointerdown, and its pointerup is often swallowed by the
    // menu — arming the drag state then makes the chart pan with no button held.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
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
    if (this._pointers.size >= 2) { this._beginPinch(); return; } // second finger → pinch, skip single-drag
    this._downPane = p.pane;
    this._downX = p.x;
    this._downLocalY = p.localY;

    // Pane divider: pressing within a few px of the boundary between two panes
    // starts a resize, redistributing weight between them.
    const divider = this._dividerAt(p.y);
    if (divider !== null) {
      const layout = this._paneLayout();
      this._paneResize = {
        index: divider,
        startY: p.y,
        aWeight: this._panes[divider].weight,
        bWeight: this._panes[divider + 1].weight,
        aHeight: layout[divider].height,
        bHeight: layout[divider + 1].height,
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
      this._axisDrag = 'price';
      this._axisDragScale = onLeftAxis
        ? this._panes[p.pane].scaleFor('left')
        : this._panes[p.pane].priceScale;
      this._axisStartCoord = p.localY;
      const r = this._axisDragScale.priceRange();
      this._axisStartMin = r.min;
      this._axisStartMax = r.max;
      this._dragging = false;
      return;
    }
    if (onTimeAxis) {
      this._axisDrag = 'time';
      this._axisStartCoord = p.x;
      this._axisStartSpacing = this._timeScale.barSpacing;
      this._dragging = false;
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
    const hit = this._panes[p.pane]?.hitTestPrimitives(p.x - this._leftAxisWidth, p.localY, this._renderContext(p.pane === this._bottomPaneIndex()));
    // `draggable` primitives (drawing anchors/shapes) arm regardless of a host
    // callback — they publish through the `drag` event bus. The `ns-resize`
    // form is the original price-line path and still needs `subscribeDrag`.
    if (hit && (hit.draggable === true || (hit.cursor === 'ns-resize' && this._dragCb !== null))) {
      this._dragId = hit.externalId;
      this._dragMoved = false;
      this._ensureScaled(p.pane);
      this._dragFrom = {
        time: this._xToTime(p.x),
        price: this._panes[p.pane].yToPrice(p.localY),
      };
      this._setHover(hit); // active state + cursor even when no hover preceded (touch)
      // Hide the crosshair while dragging a line — a frozen crosshair at the
      // grab point reads as a phantom second line (the axis tag tracks price).
      this._cursor = null;
      this._cursorPane = null;
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
      this._dragging = false;
      this._pointerMoved = false;
      return;
    }

    this._dragging = true;
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
    // Safety: if the primary button is no longer held (missed pointerup — e.g.
    // released over a context menu or outside the window), end any drag now.
    if (e.pointerType === 'mouse' && (e.buttons & 1) === 0 && (this._dragging || this._dragId !== null || this._axisDrag !== null)) {
      this._onPointerUp(e);
      // Marked after the fact, not before: the recovery IS this pointer's one
      // real end, so it has to run. What must be swallowed is the release that
      // follows it.
      this._endedPointers.add(e.pointerId);
      return;
    }
    const p = this._localPoint(e);
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: p.x, y: p.y, pane: p.pane });
    if (this._pinch !== null) { this._updatePinch(); return; }
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
      this._panes[r.index].weight = (aH / total) * sum;
      this._panes[r.index + 1].weight = sum - this._panes[r.index].weight;
      this._relayout();
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      return;
    }
    if (this._axisDrag === 'time') {
      // drag right (dx>0) → expand (wider bars); drag left → compress
      const dx = p.x - this._axisStartCoord;
      this._timeScale.setBarSpacing(this._axisStartSpacing * Math.exp(dx * 0.005));
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      return;
    }
    // Placement mode suppresses the pan path, which is where `_pointerMoved`
    // is normally set — track the gesture here so pointerup can still tell a
    // click from a drag-to-draw.
    if (this._placementMode && this._pointers.size > 0
      && (Math.abs(p.x - this._downX) > 3 || Math.abs(p.localY - this._downLocalY) > 3)) {
      this._pointerMoved = true;
    }
    if (this._dragId !== null) {
      if (Math.abs(p.x - this._downX) > 3 || Math.abs(p.localY - this._downLocalY) > 3) this._dragMoved = true;
      const price = this._panes[this._downPane].yToPrice(p.localY);
      const time = this._xToTime(p.x);
      this._dragCb?.(this._dragId, price, time);
      this.emit('drag', {
        id: this._dragId, price, time, paneIndex: this._downPane,
        // The grab origin, so a consumer's delta starts at the press instead of
        // the first move — otherwise the shape lags the cursor by one event.
        fromPrice: this._dragFrom.price, fromTime: this._dragFrom.time,
      });
      return;
    }
    if (this._dragging) {
      const dx = p.x - this._dragStartX;
      if (Math.abs(dx) > 3 || Math.abs(p.y - this._dragStartY) > 3) this._pointerMoved = true;
      // horizontal: scroll time
      this._timeScale.setRightOffset(this._dragStartOffset - dx / this._timeScale.barSpacing);
      // vertical: pan the dragged pane's price scale (incremental, switches to manual)
      this._panes[this._downPane]?.priceScale.panByPixels(p.y - this._lastDragY);
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
    this._updateCursor(p.pane, p.x, p.localY, p.y);
  };

  private readonly _onPointerUp = (e: PointerEvent): void => {
    try { this._container.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
    // A gesture ends once. `_onPointerMove` calls this directly when it finds the
    // button already released, because a release over a context menu or outside
    // the window never reaches us -- and the real `pointerup` still arrives after
    // it. Without this guard that second call finds the drag already torn down,
    // falls through to the plain click branch, and fires the same click again at
    // the stale press coordinates. Every host control addressed by
    // `subscribeClick` doubles: a legend's hide toggles twice and looks dead.
    if (this._endedPointers.has(e.pointerId)) { this._endedPointers.delete(e.pointerId); return; }
    this._pointers.delete(e.pointerId);
    if (this._pinch !== null) {
      // a finger lifted mid-pinch: end the gesture; don't start a drag with the remnant
      if (this._pointers.size < 2) { this._pinch = null; this._dragging = false; }
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
      const price = this._panes[this._downPane].yToPrice(p.localY);
      const time = this._xToTime(p.x);
      this._dragEndCb?.(this._dragId, price, time);
      this.emit('drag:end', { id: this._dragId, price, time, paneIndex: this._downPane });
      // A press on a draggable primitive arms a drag, so this branch used to
      // swallow the release — and a plain click on a drawing never reached the
      // click path, leaving it unselectable. A gesture that never moved is a
      // click by any reasonable reading.
      if (!this._dragMoved) {
        const id = this._dragId;
        this._clickCb?.(id);
        this.emit('click', {
          id, price, time,
          paneIndex: this._downPane,
          point: { x: this._downX, y: this._downLocalY },
          shiftKey: e.shiftKey === true, ctrlKey: e.ctrlKey === true, metaKey: e.metaKey === true,
        });
      }
      this._dragId = null;
      // Re-evaluate hover at the release point (mouse keeps hovering the line;
      // touch has no pointer any more) and drop the dragging visual state.
      const hit = e.pointerType === 'touch'
        ? null
        : this._panes[p.pane]?.hitTestPrimitives(p.x - this._leftAxisWidth, p.localY, this._renderContext(p.pane === this._bottomPaneIndex())) ?? null;
      this._setHover(hit);
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
      return;
    }
    this._dragging = false;
    // Placement mode: a press-drag-release is how every charting UI draws a
    // two-point shape, but the click branch below is gated on the pointer having
    // stayed still, so the gesture used to place nothing at all. Replay it as the
    // two clicks it means — press point, then release point. `viaDrag` lets the
    // host ignore the second one for single-anchor tools it already completed.
    if (this._placementMode && this._pointerMoved) {
      const p = this._localPoint(e);
      this._ensureScaled(this._downPane);
      this.emit('click', {
        id: null,
        price: this._panes[this._downPane]?.yToPrice(this._downLocalY) ?? null,
        time: this._xToTime(this._downX),
        paneIndex: this._downPane,
        point: { x: this._downX, y: this._downLocalY },
      });
      this.emit('click', {
        id: null,
        price: this._panes[this._downPane]?.yToPrice(p.localY) ?? null,
        time: this._xToTime(p.x),
        paneIndex: this._downPane,
        point: { x: p.x, y: p.localY },
        viaDrag: true,
      });
      return;
    }
    // Always hit-test a clean click: the chart's own chrome (pane-legend
    // buttons) must work whether or not the host subscribed to clicks.
    if (!this._pointerMoved) {
      const isBottom = this._downPane === this._bottomPaneIndex();
      const hit = this._panes[this._downPane]?.hitTestPrimitives(this._downX - this._leftAxisWidth, this._downLocalY, this._renderContext(isBottom));
      // Pane-legend buttons are the chart's own chrome — handle them here so
      // the host doesn't have to re-implement remove/hide/move/maximize.
      if (hit && this._handleLegendAction(hit.externalId)) return;
      if (hit) this._clickCb?.(hit.externalId);
      // The event carries position and fires on empty plot too, which is what a
      // tool that *places* something (a drawing, an alert) needs; `id` is null
      // there. `subscribeClick` stays hit-only for back-compat.
      this._ensureScaled(this._downPane);
      this.emit('click', {
        id: hit?.externalId ?? null,
        price: this._panes[this._downPane]?.yToPrice(this._downLocalY) ?? null,
        time: this._xToTime(this._downX),
        paneIndex: this._downPane,
        point: { x: this._downX, y: this._downLocalY },
        // Modifier flags ride along so the draw tier can make a shift or
        // ctrl click additive to the selection; the payload carries no event.
        shiftKey: e.shiftKey === true, ctrlKey: e.ctrlKey === true, metaKey: e.metaKey === true,
      });
      return;
    }
    if (KineticAnimation.shouldAnimate(this._dragVelocity)) this._startKinetic(this._dragVelocity);
  };

  /**
   * DOM pointerup entry point. Mirrors the primary-button guard in
   * `_onPointerDown`: a right-click (or any non-primary mouse button) fires
   * pointerdown *and* pointerup, but `_onPointerDown` ignores it — so the
   * down state (`_downX`/`_downLocalY`/`_downPane`/`_pointerMoved`) is never
   * refreshed and still holds the *previous* left-click. Letting a non-primary
   * pointerup through would re-run the click branch against that stale position
   * and replay the last click (e.g. re-firing a Buy/Sell button → a phantom
   * order). Touch/pen are unaffected (they contact with button 0). The internal
   * recovery call from `_onPointerMove` invokes `_onPointerUp` directly, so it
   * bypasses this filter and still ends a drag when a button release is missed.
   */
  private readonly _onPointerUpNative = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this._onPointerUp(e);
  };

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
      this.emit('crosshair:move', cleared);
    }
  };

  private readonly _onWheel = (e: WheelEvent): void => {
    this._unfreezeOverlay();
    e.preventDefault();
    const logFactor = e.deltaY < 0 ? Math.log(1.1) : -Math.log(1.1);
    // 'right' pins the latest bar: zoom about the right edge of the plot, so
    // history stretches away from it instead of the cursor's bar staying put.
    const focusX = this._zoomAnchor === 'right' ? this._timeScale.width : this._localPoint(e).x;

    if (!this._animZoom || !ZoomGlide.shouldAnimate(logFactor)) {
      this._stopZoomGlide();
      this._applyZoom(focusX, logFactor);
      return;
    }
    // A tick during a glide extends it rather than starting a new one, or a
    // fast scroll would restart the ease on every notch and barely move.
    // The lead lands on the event itself, so there is no input latency and a
    // synchronous read of the viewport after a wheel sees it move.
    const lead = logFactor * ZoomGlide.leadFraction();
    this._applyZoom(focusX, lead);
    const rest = logFactor - lead;

    if (this._zoomGlide !== null && this._zoomGlideX === focusX) {
      this._zoomGlide.add(rest, this._zoomGlideApplied, this._now() - this._zoomGlideStart);
      return;
    }
    this._stopZoomGlide();
    this._startZoomGlide(focusX, rest);
  };

  /** One zoom step, applied now. Shared by the instant path and each glide frame. */
  private _applyZoom(focusX: number, logFactor: number): void {
    this._timeScale.zoomAtX(focusX, Math.exp(logFactor));
    this._maybeLoadHistory();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._emitViewport('zoom');
  }

  private _startZoomGlide(focusX: number, logFactor: number): void {
    const glide = new ZoomGlide(logFactor);
    this._zoomGlide = glide;
    this._zoomGlideStart = this._now();
    this._zoomGlideApplied = 0;
    this._zoomGlideX = focusX;
    let frames = 0;
    const step = (): void => {
      const elapsed = this._now() - this._zoomGlideStart;
      const applied = glide.appliedAt(elapsed);
      const delta = applied - this._zoomGlideApplied;
      this._zoomGlideApplied = applied;
      // A frame that moved nothing still costs a full-pane repaint, so skip it.
      if (delta !== 0) this._applyZoom(focusX, delta);
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

  private _stopZoomGlide(): void {
    if (this._zoomHandle !== null) {
      this._raf.cancel(this._zoomHandle);
      this._zoomHandle = null;
    }
    this._zoomGlide = null;
  }

  /**
   * Restore the default view: fit all bars on the time axis and re-enable
   * auto-scaling on every price axis (undoing any pan/zoom or manual axis drag).
   * Same as double-clicking the chart.
   */
  public resetScale(): void {
    const before = this._timeScale.visibleRange();
    if (this._dataLayer.length > 0) this._timeScale.fitContent(this._dataLayer.length);
    for (const pane of this._panes) {
      // "Back to the default view" includes the ratio locks: one would otherwise
      // sit in the map holding a scale that has just been told to auto-fit.
      pane.clearRatioLocks();
      pane.priceScale.setAutoScale(true);
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._emitViewportIfMoved(before);
  }

  private readonly _onDblClick = (): void => {
    this.emit('dblclick', {});
    // While a tool is armed a double-click means "finish this shape" — a
    // variable-anchor tool has no other way to end — so it must not also throw
    // the view back to its default mid-placement.
    if (!this._placementMode) this.resetScale();
  };

  // ── multi-touch pinch (zoom + two-finger pan) ─────────────────────────────
  private _beginPinch(): void {
    const pts = [...this._pointers.values()];
    this._pinch = pinchState(pts[0], pts[1]);
    this._pinchPane = pts[0].pane;
    // abort any single-pointer interaction so it doesn't fight the pinch
    this._dragging = false; this._axisDrag = null; this._axisDragScale = null; this._dragId = null; this._pointerMoved = true;
  }

  private _updatePinch(): void {
    const pts = [...this._pointers.values()];
    if (pts.length < 2 || this._pinch === null) return;
    const cur = pinchState(pts[0], pts[1]);
    const d = pinchDelta(this._pinch, cur);
    if (d.factor !== 1) this._timeScale.zoomAtX(cur.cx, d.factor);                       // pinch → zoom time
    this._timeScale.setRightOffset(this._timeScale.rightOffset - d.dx / this._timeScale.barSpacing); // two-finger pan X
    this._panes[this._pinchPane]?.priceScale.panByPixels(d.dy);                          // two-finger pan Y
    this._pinch = cur;
    this._maybeLoadHistory();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._emitViewport(d.factor !== 1 ? 'zoom' : 'pan');
  }

  // ── keyboard navigation (focus the chart, then arrows / +- / Home) ────────
  private readonly _onKeyDown = (e: KeyboardEvent): void => {
    this._unfreezeOverlay();
    const sc = this._shortcuts;
    if (sc === null || ShortcutManager.shouldIgnore(e.target) || !this._shortcutsActive()) return;
    const cmd = sc.resolve(e);
    if (cmd === null) return;
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
    const ts = this._timeScale;
    // Keyboard navigation moves the same viewport a drag or a wheel does, so it
    // announces itself the same way: a chart linked into a grid must follow an
    // arrow key, not only a gesture. `panUp` / `panDown` move a price scale, not
    // the time window, and deliberately emit nothing (the payload is a time
    // range, and `_emitViewportIfMoved` sees no movement in it anyway).
    const pan = (bars: number): boolean => {
      const before = ts.visibleRange();
      ts.setRightOffset(ts.rightOffset + bars);
      this._emitViewportIfMoved(before);
      return true;
    };
    const zoom = (factor: number): boolean => {
      const before = ts.visibleRange();
      ts.zoomAtX(this._width / 2, factor);
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
      case 'panUp': this._panes[0]?.priceScale.panByPixels(20); return true;
      case 'panDown': this._panes[0]?.priceScale.panByPixels(-20); return true;
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
    if (this._firstDataId.value !== null && this._panes[0] !== undefined) {
      const last = this._dataLayer.lastIndexedBar(this._firstDataId.value);
      if (last !== null) txt += `, latest price ${this._panes[0].priceScale.format(last.bar.close)}`;
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
    this._container.style.cursor = hit?.cursor ?? '';
    if (id === this._hoverId) return;
    this._hoverId = id;
    // hover-styled primitives draw on the base canvas → light repaint, no rescale
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Light));
    this.emit('hover', { id });
  }

  private _updateCursor(paneIndex: number, x: number, localY: number, containerY = localY): void {
    // Plot spans [leftAxisWidth, width - priceAxisWidth]; work in plot-relative x.
    const rightEdge = this._width - this._rightAxisWidth;
    const plotX = x - this._leftAxisWidth;
    const plotWidth = Math.max(0, rightEdge - this._leftAxisWidth);
    if (plotX < 0 || plotX > plotWidth) {
      this._onPointerLeave();
      return;
    }
    const pane = this._panes[paneIndex];
    const hit = pane.hitTestPrimitives(plotX, localY, this._renderContext(paneIndex === this._bottomPaneIndex())) ?? null;
    // A pane boundary beats a primitive hit: the divider is a thin target and
    // the legend rows sit right below one.
    if (hit === null && this._dividerAt(containerY) !== null) {
      this._setHover(null);
      this._container.style.cursor = 'row-resize';
      return;
    }
    this._setHover(hit);
    // The navigator reveals on pointer position, not on hover id — see the note
    // in time-navigator.ts. Only the bottom pane carries it.
    this._feedTimeNav(paneIndex === this._bottomPaneIndex() ? { x: plotX, y: localY } : null);
    let y = localY;
    const index = Math.round(this._timeScale.xToIndex(plotX));
    let hoveredBar: Bar | null = null;
    if (this._firstDataId.value !== null) {
      const bars = this._dataLayer.visibleBars(this._firstDataId.value, index, index);
      if (bars.length > 0) {
        hoveredBar = bars[0].bar;
        // Magnet only snaps within the pane that holds the price series — never
        // in the volume/indicator panes (their scale isn't a price scale).
        if (this._crosshairMode === 'magnet' && paneIndex === this._firstPaneIndex) {
          const snapped = magnetSnapPrice(pane.yToPrice(localY), hoveredBar);
          y = pane.priceToY(snapped);
        }
      }
    }
    this._cursorPane = paneIndex;
    this._cursor = { x: plotX, y }; // plot-relative; the crosshair line is drawn inside the plot shift
    // Legend rows read the bar under the crosshair, like every charting package.
    for (const indicator of this._indicators) indicator.updateLegendValues(index);
    // global crosshair → repaint every pane's overlay (cheap; base untouched)
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
    if (this._crosshairCb !== null || this._listeners.get('crosshair:move') !== undefined) {
      const time = this._dataLayer.indexToTime(index);
      const move = {
        time: time ?? null,
        index,
        price: pane.yToPrice(localY),
        bar: hoveredBar,
        point: { x, y: containerY },
        paneIndex,
        // Whether a pointer is down for this move. Placement mode swallows the
        // pan path, so this is the only way a consumer can tell a hover from a
        // drag while it is still happening — what freehand drawing samples.
        pressed: this._pointers.size > 0,
      };
      this._crosshairCb?.(move);
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
      const elapsed = this._now() - start;
      const dist = anim.distanceAt(elapsed);
      const delta = dist - lastDist;
      lastDist = dist;
      this._timeScale.setRightOffset(this._timeScale.rightOffset - delta / this._timeScale.barSpacing);
      this._maybeLoadHistory();
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      // The glide is a pan like any other and has to say so. Without this the
      // drag emits its last event at the moment the pointer lifts, and everything
      // downstream (a linked chart, a host tracking the visible range) is left on
      // that window while this one coasts on for another few hundred milliseconds.
      this._emitViewport('pan');
      if (!anim.finished(elapsed) && ++frames < KINETIC_MAX_FRAMES) {
        this._kineticHandle = this._raf.schedule(step);
      } else {
        this._kineticHandle = null;
      }
    };
    this._kineticHandle = this._raf.schedule(step);
  }

  private _stopKinetic(): void {
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

  public destroy(): void {
    if (this._destroyed) return; // idempotent: a second call must not re-emit
    this._loop.stop();
    if (this._remeasureHandle !== null) {
      this._raf.cancel(this._remeasureHandle);
      this._remeasureHandle = null;
    }
    this._stopKinetic();
    this._stopZoomGlide();
    for (const indicator of this._indicators) indicator.remove();
    this._indicators.length = 0;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (typeof window !== 'undefined') {
      const el = this._container;
      el.removeEventListener('pointerdown', this._onPointerDown);
      el.removeEventListener('pointermove', this._onPointerMove);
      el.removeEventListener('pointerup', this._onPointerUpNative);
      el.removeEventListener('pointercancel', this._onPointerUp);
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
