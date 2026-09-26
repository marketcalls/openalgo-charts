/**
 * Top-level chart orchestrator (ARCHITECTURE.md §3.3). Owns the shared
 * DataLayer + time scale, the panes, the invalidate mask, and the render loop.
 * Phase 2 renders static candlesticks with price/time axes; pan/zoom (Phase 3)
 * and live data (Phase 4) build on this.
 */
import { InvalidateMask, InvalidationLevel } from './invalidate-mask';
import { RenderLoop, type RafScheduler, type RafCanceller } from './render-loop';
import { type Pane, type PaneRenderContext } from './pane';
import { ChartMotion, type MotionHost } from './chart-motion';
import { ChartPixels, type PixelsHost } from './chart-pixels';
import {
  compactVolume, type ZoomAnchor, type DoubleClickAction, type ChartWatermarkOptions,
  type PlotRect, type ChartEventOptions, type AxisChromeOptions, type ExportSvgOptions,
  type ChartNavigationOptions, type ChartOptions, type AddSeriesOptions, type CrosshairMoveEvent,
  type PointerInfo, type ChartEventClick, type LayoutSetter,
  type LayoutChangeEvent, type RendererFallbackEvent,
} from './chart-types';
// The public option and event types live in chart-types.ts. Every name is
// re-exported here, so an import of './chart' finds what it always found.
// `ChartClickEvent` and `PriceAxisState` stay in this file: COMPATIBILITY.md
// and its test record chart.ts as the home of their deprecated members.
export { compactVolume, PRICE_SCALE_MODES } from './chart-types';
export type {
  ZoomAnchor, DoubleClickAction, DoubleClickEvent, ChartWatermarkOptions, PlotRect, BrandingChangedEvent,
  ChartEventOptions, AxisChromeOptions, ExportSvgOptions, ChartNavigationOptions, ChartOptions,
  AddSeriesOptions, CrosshairMoveEvent, PointerModifiers, PointerKind, PointerSample, PointerInfo,
  ChartEventClick, ChartDragEvent, ChartDragEndEvent, ContextMenuTargetKind,
  ContextMenuTarget, LayoutSetter, LayoutChangeEvent, ContextMenuEvent, RendererFallbackEvent,
} from './chart-types';
import type { PriceAxisPlacement, PriceAxisSide, PriceAxisSlot } from '../model/price-axis-layout';
import { type ChartTheme, DEFAULT_THEME } from '../theme';
import { TimeScale } from '../scale/time-scale';
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
import { createSeriesRecord, type SeriesApi, type SeriesRecord, type PriceScaleId, type BarConfirmationOptions, type SeriesUpdateOptions } from '../model/series';
import { bindSeriesProvenance, SeriesProvenance, validateSeriesOptions } from '../model/series-provenance';
import { getChartType, type SeriesType } from '../model/chart-type-registry';
import {
  type IndicatorBarsProvider, type IndicatorBarsProviderAccess, type IndicatorSettings,
} from '../model/indicator-registry';

import { type IndicatorInstance, type IndicatorApi, type IndicatorHost } from '../model/indicator-instance';
import { type IndicatorEditOptions, type IndicatorPolicy } from '../model/indicator-policy';
import type { AlertsDocument } from '../alerts/types';
import { copyAlert, parseAlertsDocument, validateAlert } from '../alerts/document';
import type { ChartDataContext } from '../model/indicator-registry';
import type { ChartState, RestoreReport, ChartRestoreOptions } from '../model/chart-state';
import type { SeriesStyle } from '../render/series-style';
import type { Bar, SeriesDataItem } from '../model/bar';
import { toBar } from '../model/bar';
import type { CrosshairMode } from '../input/crosshair';
import { ShortcutManager } from '../input/shortcuts';
import { TradingController, DEFAULT_TRADING_COLORS, type TradingColors, type TradingSettings } from './trading-controller';
import { beginPickResolved, cancelPick, type PickKind, type PickOptions, type PickHandle, type PickPoint } from '../input/pick';
import type { IPrimitive, PrimitiveHost, PrimitiveAnchor, PrimitivePlacement } from '../primitives/primitive';
import { PriceLine, type PriceLineOptions } from '../primitives/price-line';
import { SeriesMarkers } from '../primitives/markers';
import { EventMarkers, type ChartEvent, type EventGroup, type EventMarkersOptions } from '../primitives/event-markers';
import { PaneLegend, type PaneLegendAction, type LegendStatusLineOptions } from '../primitives/pane-legend';
import { TimeNavigator, type TimeNavigatorOptions } from '../primitives/time-navigator';
import type { ChartSettingsState } from '../model/chart-settings';
import { LogoWatermark, type LogoWatermarkOptions } from '../primitives/watermark';
import { TextWatermark } from '../primitives/text-watermark';
import type { TickSchedule } from '../feed/tick-schedule';
import { DEFAULT_TIMEZONE, isValidTimezone } from '../feed/time';
import { clamp, roundToTick } from '../helpers/math';
// Last, so the runtime modules imported above still load in the order they did.
import { ChartPersistence, type PersistenceHost, type PreservedScaleFormats } from './chart-state';
import { ChartStudies, type StudiesHost } from './chart-studies';
import { ChartInput, type InputHost } from './chart-input';
import { ChartPanes, NON_INSTRUMENT_PRECISION, type PanesHost } from './chart-panes';
import { ChartLegends, type LegendsHost } from './chart-legends';

/** A zone name the runtime recognises, or a readable failure at the call site. */
function checkedTimezone(zone: string): string {
  if (!isValidTimezone(zone)) {
    throw new Error(`openalgo-charts: unknown IANA time zone "${zone}"`);
  }
  return zone;
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
  /** Whether the host supplied `raf`, and so owns every frame, the resize ones included. */
  private readonly _rafInjected: boolean;
  private _remeasureHandle: number | null = null;
  private readonly _dataLayer = new DataLayer();
  private readonly _timeScale: TimeScale;
  private _timeScaleMutationDepth = 0;
  private readonly _priceAxisWidth: number;
  private readonly _timeAxisHeight: number;
  private _pending: InvalidateMask | null = null;
  private _scaleMutationDepth = 0;
  /** Size and device-pixel-ratio observation; see chart-pixels.ts. */
  private readonly _pixels = new ChartPixels(this._pixelsHost());
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
  /** Pointer, wheel and keyboard routing, hover, and the gesture state they keep; see chart-input.ts. */
  private readonly _input = new ChartInput(this._inputHost());
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
  private readonly _navigation: ChartNavigationOptions = { mousePan: 'both', defaultVisibleBars: 0, panEnabled: true, zoomEnabled: true };
  private _liveRegion: HTMLElement | null = null;
  // The fling velocity and the move it was last sampled at stay here although
  // only chart-input.ts reads them: a test sets them on the chart by name, and
  // an accessor that nothing in this file reads fails the unused-member check.
  private _lastDragX = 0;
  private _lastDragT = 0;
  private _dragVelocity = 0;
  /** Kinetic pan, the zoom glide and the autoscale easing they start; see chart-motion.ts. */
  private readonly _motion: ChartMotion;
  private readonly _animZoom: boolean;
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
  /** Saving and restoring the chart state; see chart-state.ts. */
  private readonly _persistence = new ChartPersistence(this._persistenceHost());
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
  /** Adding, moving and recomputing studies, and the host they talk to; see chart-studies.ts. */
  private readonly _studies = new ChartStudies(this, this._studiesHost());
  private _indicatorsDirty = false;
  private readonly _indicatorRefreshes = new Map<string, boolean>();
  private readonly _indicatorReservedIds = new Set<string>();
  /** Opaque drawing-tier payload, round-tripped through get/restoreState. */
  private _drawingState: unknown = undefined;
  private _alertState: AlertsDocument | undefined;
  /** Making, removing, moving, maximizing and folding panes, and their layout; see chart-panes.ts. */
  private readonly _layout = new ChartPanes(this._panesHost());
  /**
   * Panes folded to a header strip. Held by pane identity, like `_pricePanes`,
   * so the fold follows its pane through a move or a removal above it without
   * any index to patch.
   */
  private readonly _collapsed = new WeakSet<Pane>();
  /** Legend rows per pane, so new ones stack below existing ones. */
  private readonly _legends: { legend: PaneLegend; paneIndex: number }[] = [];
  private readonly _studyLegends = new Set<PaneLegend>();
  /** Legend row stacking and offsets, the study count toggle, and legend button presses; see chart-legends.ts. */
  private readonly _legendStack = new ChartLegends(this._legendsHost());
  /**
   * Pane holding the primary price series (only this pane gets magnet
   * snapping). By identity, for the reason `_primaryPane` is: a move changes
   * its slot and nothing else about it.
   */
  private _firstPane: Pane | null = null;
  private _historyLoader: (() => void) | null = null;
  private _loadingHistory = false;
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

    if (options.legendOffset?.top !== undefined) this._legendStack._legendOffset.top = options.legendOffset.top;
    if (options.legendOffset?.left !== undefined) this._legendStack._legendOffset.left = options.legendOffset.left;
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
    this._motion = new ChartMotion(this._motionHost(), options.animAutoscale ?? this._animZoom);
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
    this._rafInjected = options.raf !== undefined;
    this._loop = new RenderLoop(() => this._onFrame(), this._raf.schedule, this._raf.cancel);

    this._layout._addPane();
    this.setBranding(options.branding ?? true);
    this.setWatermarkOptions(options.watermark ?? false);
    this._pixels._observeSize();
    this._pixels._watchPixelRatio();
    this._input._attachInput();
    // Direct navigation shares the chart's events; internal gestures and data
    // updates already own their repaint, animation and notification boundaries.
    this._timeScale.setChangeHandler((before) => {
      if (this._timeScaleMutationDepth > 0 || this._destroyed) return;
      this._motion._stopNavigationMotion();
      const after = this._timeScale.visibleRange();
      if (after.from === before.from && after.to === before.to) return;
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      this._emitViewportIfMoved(before);
    });
    this.applySize(container.clientWidth, container.clientHeight);
    this._remeasureHandle = this._raf.schedule(() => {
      this._remeasureHandle = null;
      this._layout._remeasure();
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
    this._motion._stopNavigationMotion();
    this._timeScale.setVisibleLogicalRange(range);
  }

  /** The current visible logical range. */
  public getVisibleLogicalRange(): LogicalRange {
    return this._timeScale.visibleRange();
  }

  /** Fit all bars into view (no-arg convenience; bar count from the data). */
  public fitContent(): void {
    this._motion._stopNavigationMotion();
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
      if (stopZoom) this._motion._navigationEpoch++;
      if (stopPan) this._motion._stopKinetic();
      if (stopZoom) this._motion._stopZoomGlide();
      this._motion._autoscaleTime = null;
      if (this._input._pinch !== null || (stopPan && this._input._dragging)
        || (stopZoom && (this._input._axisDrag === 'price' || this._input._axisDrag === 'time'))) {
        this._input._navigationCancelled = true;
        this._input._dragging = false;
        this._input._axisDrag = null;
        this._input._axisDragScale = null;
        this._input._pinch = null;
        this._input._pointerMoved = true;
        this._dragVelocity = 0;
        this._input._setHover(null);
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
    this._studies._reconcileIndicatorRanges();
    this._applySeriesPriceFormat(target, owner.priceFormat);
    if (record.style.precision !== undefined) this._applyPrecision(target, record.style.precision);
    this._layout._recomputeAxisColumns();
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
    this._layout._ensurePane(paneIndex);
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
    this._layout._recomputeAxisColumns(); // reserve/free the axis columns
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
        if (!owner.indicatorOwned) this._studies._reconcileIndicatorRanges();
        this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
        this._layout._recomputeAxisColumns();
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
    if (!owner.indicatorOwned) this._studies._reconcileIndicatorRanges();
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
    return this._studies.addIndicator(indicatorId, settings, options);
  }

  /**
   * Every live indicator instance, in renderer stacking order.
   *
   * Flushes any pending recompute first. Indicator maths is deferred to the
   * frame, so a caller that updates a bar and reads a value back in the same
   * turn would otherwise see the previous tick's numbers.
   */
  public indicators(): readonly IndicatorApi[] {
    return this._studies.indicators();
  }

  /**
   * Move an existing study to an existing pane or a new pane at panes().length.
   * A study whose policy is not `movable` stays unless `options.force` is set.
   */
  public moveIndicator(instanceId: string, paneIndex: number, options: IndicatorEditOptions = {}): boolean {
    return this._studies.moveIndicator(instanceId, paneIndex, options);
  }

  /**
   * Change study stacking order among studies on the same pane. A study whose
   * policy is not `movable` stays unless `options.force` is set.
   */
  public reorderIndicator(instanceId: string, direction: -1 | 1, options: IndicatorEditOptions = {}): boolean {
    return this._studies.reorderIndicator(instanceId, direction, options);
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
    this._studies._reorderIndicatorResources();
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

  /**
   * Remove one indicator instance by its handle id. Returns true if it existed
   * and went; a study whose policy is not `removable` stays unless
   * `options.force` is set.
   */
  public removeIndicator(instanceId: string, options: IndicatorEditOptions = {}): boolean {
    return this._studies.removeIndicator(instanceId, options);
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

  /**
   * The `IndicatorHost` a study instance talks to; see chart-studies.ts. Kept
   * here by name because the restore and tests build a host through it.
   */
  private _indicatorHost(preservedFormats?: PreservedScaleFormats): IndicatorHost {
    return this._studies._indicatorHost(preservedFormats);
  }

  /** What the study host reads, writes and drives of the chart; see `StudiesHost`. */
  private _studiesHost(): StudiesHost {
    // A getter's own `this` is the host literal, so the live fields are read
    // and written through the chart.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const chart = this;
    return {
      get _panes() { return chart._panes; },
      get _primaryPane() { return chart._primaryPane; },
      get _indicators() { return chart._indicators; },
      get _indicatorRanges() { return chart._indicatorRanges; },
      get _ownedScaleRanges() { return chart._ownedScaleRanges; },
      get _indicatorRefreshes() { return chart._indicatorRefreshes; },
      get _indicatorReservedIds() { return chart._indicatorReservedIds; },
      get _seriesRecords() { return chart._seriesRecords; },
      get _seriesOwners() { return chart._seriesOwners; },
      get _seriesProvenance() { return chart._seriesProvenance; },
      get _firstDataId() { return chart._firstDataId; },
      get _dataLayer() { return chart._dataLayer; },
      get _loop() { return chart._loop; },
      get _legends() { return chart._legends; },
      get _legendActions() { return chart._legendActions; },
      get _studyLegends() { return chart._studyLegends; },
      get _timeNav() { return chart._timeNav; },
      get _anchored() { return chart._anchored; },
      get _timezone() { return chart._timezone; },
      get _dataContext() { return chart._dataContext; },
      get _barsProvider() { return chart._barsProvider; },
      get _barsRequests() { return chart._barsRequests; },
      get _barsProviderRevision() { return chart._barsProviderRevision; },
      get _requestedDataRevision() { return chart._requestedDataRevision; },
      get _destroyed() { return chart._destroyed; },
      get isDestroyed() { return chart.isDestroyed; },
      get _indicatorsDirty() { return chart._indicatorsDirty; },
      set _indicatorsDirty(value) { chart._indicatorsDirty = value; },
      get _scaleMutationDepth() { return chart._scaleMutationDepth; },
      set _scaleMutationDepth(value) { chart._scaleMutationDepth = value; },
      _wallClock: () => this._wallClock(),
      _primaryIndex: () => this._primaryIndex(),
      _readoutIndex: () => this._readoutIndex(),
      _validPriceScaleId: (value): value is PriceScaleId => this._validPriceScaleId(value),
      _policyAllows: (study, flag, options) => this._policyAllows(study, flag, options),
      seriesType: series => this.seriesType(series),
      primarySeries: () => this.primarySeries(),
      hasSnapshotProvider: () => this.hasSnapshotProvider(),
      _createSeries: (type, options, claimPrimary, preservedFormats) => this._createSeries(type, options, claimPrimary, preservedFormats),
      _setSeriesType: (series, type, notify) => this._setSeriesType(series, type, notify),
      _applySeriesPriceFormat: (scale, pf) => this._applySeriesPriceFormat(scale, pf),
      _applyPrecision: (scale, precision) => this._applyPrecision(scale, precision),
      addPriceLine: (opts, paneIndex) => this.addPriceLine(opts, paneIndex),
      _addPrimitive: (paneIndex, primitive) => this._addPrimitive(paneIndex, primitive),
      removePrimitive: primitive => this.removePrimitive(primitive),
      _ensurePane: index => this._layout._ensurePane(index),
      removePane: index => this.removePane(index),
      _placeSource: () => this._placeSource(),
      _reanchorSource: () => this._reanchorSource(),
      _syncLegendPanes: () => this._legendStack._syncLegendPanes(),
      _restackLegends: () => this._legendStack._restackLegends(),
      _recomputeAxisColumns: () => this._layout._recomputeAxisColumns(),
      _relayout: () => this._layout._relayout(),
      invalidate: build => this.invalidate(build),
      on: (event, cb) => this.on(event, cb),
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  private _validPriceScaleId(value: unknown): value is PriceScaleId {
    return typeof value === 'string' && (value === 'right' || value === 'left' || value === '' || value.startsWith('overlay:'));
  }

  /** Subscribe to clicks on hit-testable primitives (markers, events, lines). */
  public subscribeClick(cb: (externalId: string) => void): void {
    this._input._clickCb = cb;
  }

  /**
   * Subscribe to crosshair movement for an OHLC legend / tooltip. The callback
   * fires with the hovered bar of the primary price series on every move, and
   * with all-null fields when the pointer leaves the plot. A linked crosshair
   * also updates the readout, with source 'linked' and no pointer coordinates.
   */
  public subscribeCrosshairMove(cb: (e: CrosshairMoveEvent) => void): void {
    this._input._crosshairCb = cb;
  }

  /**
   * Update the readout under a link group's separately drawn crosshair. The
   * physical pointer takes precedence. This never emits a pointer move event,
   * so hosts do not interpret it as drawing input or echo it to another group.
   */
  public setLinkedCrosshairIndex(index: number | null): void {
    if (this.isDestroyed || this._cursor !== null) return;
    const time = index === null ? null : this._dataLayer.indexToTime(index) ?? null;
    if (time === this._input._readoutTime) return;
    this._input._readoutTime = time;
    for (const indicator of this._indicators) indicator.updateLegendValues(index ?? undefined);
    const bar = index === null || this._firstDataId.value === null ? null
      : this._dataLayer.visibleBars(this._firstDataId.value, index, index)[0]?.bar ?? null;
    const readout: CrosshairMoveEvent = { source: 'linked', time, index,
      bar, price: null, point: null, paneIndex: null };
    this._input._crosshairCb?.(readout);
    this.emit('crosshair:readout', readout);
  }

  private _readoutIndex(): number | undefined {
    return this._input._readoutTime === null ? undefined : this._dataLayer.timeToIndex(this._input._readoutTime);
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
    this._input._dragCb = onDrag;
    this._input._dragEndCb = onDragEnd ?? null;
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
    // `typeof` rather than `??` picks the index: the website compiles this file
    // without strict null checks, where `=== undefined` narrows nothing.
    if (where === undefined || typeof where === 'number') { this._addPrimitive(typeof where === 'number' ? where : this._primaryIndex(), primitive); return; }
    // Chart furniture: a brand mark, a corner clock. It belongs to the CHART,
    // not to whichever pane happens to be last, so the engine re-homes it as
    // panes come and go instead of every host writing its own placeWatermark().
    this._anchored.push({ primitive, anchor: where.anchor });
    this._addPrimitive(this._anchorTarget(where.anchor), primitive);
  }

  /** The pane a chart anchor currently resolves to. */
  private _anchorTarget(anchor: PrimitiveAnchor): number {
    if (anchor === 'chart-bottom') return this._bottomPaneIndex(true);
    return anchor === 'primary-pane' ? this._priceCornerIndex() : this._layout._topPaneIndex();
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
    return this._layout._layoutWeight(primary) > 0 ? primary : this._layout._topPaneIndex();
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
    const pane = this._layout._mappedPane(paneIndex);
    return pane && this._paneLayout()[paneIndex].top + pane.priceToY(price);
  }

  /**
   * Map a container-relative media-px Y back to a price on a pane (inverse of
   * priceToCoordinate). Null where that is, for the same panes. Both default
   * to the primary price pane wherever it sits.
   */
  public coordinateToPrice(y: number, paneIndex = this._primaryIndex()): number | null {
    const pane = this._layout._mappedPane(paneIndex);
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
    const layout = this._destroyed || this._layout._collapsedShown(paneIndex) ? undefined : this._paneLayout()[paneIndex];
    if (!layout || !Number.isSafeInteger(paneIndex)) return null;
    this._ensureScaled(paneIndex);
    const width = this._width - this._leftAxisWidth - this._rightAxisWidth;
    const height = layout.height - (paneIndex === this._bottomPaneIndex() ? this._timeAxisHeight : 0);
    return width > 0 && height > 0 ? { left: this._leftAxisWidth, top: layout.top, width, height } : null;
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
    this._layout._recomputeAxisColumns();
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
    this._layout._recomputeAxisColumns(); // the columns are reserved by what is in use
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
    this._legendStack._restackLegends();
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
    this._layout._relayout();
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
      if (this._layout._layoutWeight(i) <= 0) continue;
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
    this._studies._flushIndicators();
    const liveWidth = this._width;
    const liveHeight = this._height;
    const liveRatio = this._layoutRatio;
    // The document is at ratio 1 on every screen, so its panes are laid out at
    // 1 too: laid out at the screen's ratio, the same chart would export other
    // pane boundaries on a 1.5x laptop than on a 1x or 2x monitor.
    const relaid = width !== liveWidth || height !== liveHeight || this._layout._ratioForLayout() !== 1;
    this._layoutRatio = 1;
    if (relaid) {
      this._width = width;
      this._height = height;
      this._layout._relayout(true);
    }
    try {
      if (background && this._theme.background !== 'transparent') {
        svg.fillStyle = this._theme.background;
        svg.fillRect(0, 0, width, height);
      }
      const layout = this._paneLayout();
      const topPane = this._layout._topPaneIndex();
      for (let i = 0; i < this._panes.length; i++) {
        if (this._layout._layoutWeight(i) <= 0) continue; // hidden behind a maximized pane
        const pane = this._panes[i];
        const ctx: PaneRenderContext = {
          ...this._renderContext(i),
          dpr: 1, hoverId: null, hoverKey: null, dragId: null, paintBackground: background,
        };
        // At ratio 1 the DOM draws the separator as a 1px border on the pane
        // box and lets the canvas start below it, its last row hidden by the
        // overflow clip. The export reproduces that box exactly, or the second
        // pane would sit one pixel higher than it does on screen.
        const first = i === topPane;
        const top = layout[i].top + (first ? 0 : 1);
        const paneHeight = layout[i].height - (first ? 0 : 1);
        if (!first) {
          svg.fillStyle = this._theme.paneSeparator;
          svg.fillRect(0, layout[i].top, width, 1);
        }
        svg.pushGroup(
          { 'data-pane': i },
          { translate: { x: 0, y: top }, clip: { x: 0, y: 0, width, height: paneHeight } },
        );
        // A Full frame's sequence for one pane, minus the crosshair.
        pane.autoscale(ctx);
        pane.paintBase(ctx, g);
        pane.paintTop(null, ctx, g);
        svg.popGroup();
      }
    } finally {
      this._layoutRatio = liveRatio;
      if (relaid) {
        this._width = liveWidth;
        this._height = liveHeight;
        this._layout._relayout(true);
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
    this._layout._ensurePane(paneIndex);
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
      this._legendStack._restackLegends();
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
        if (li >= 0) this._legendStack._restackLegends();
        this._layout._recomputeAxisColumns();
        this.invalidate((m) => m.invalidatePane(i, { level: InvalidationLevel.Light, autoScale: false }));
        return;
      }
    }
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
    if (dataId === this._firstDataId.value) this._studies._invalidateIndicators();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
    if (dataId === this._firstDataId.value) this.emit('data:update', { kind: 'update', time: bar.time });
  }

  private _setData(dataId: number, bars: readonly Bar[], options?: BarConfirmationOptions): void {
    validateSeriesOptions(options);
    if (dataId === this._firstDataId.value) this._motion._stopNavigationMotion();
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
      this._studies._invalidateIndicators();
      this._studies._flushIndicators();
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
    if (dataId === this._firstDataId.value) this._studies._invalidateIndicators();
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
    this._studies._invalidateIndicators();
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
    this._input._placementMode = active;
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
    if (this._input._placementMode) throw new Error('Finish drawing placement before picking a study value');
    if (options === null || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
      || Object.values(Object.getOwnPropertyDescriptors(options)).some(item => !('value' in item))) throw new TypeError('Invalid pick options');
    const fields = Object.getOwnPropertyDescriptors(options);
    const paneIndex = fields.paneIndex?.value as PickOptions['paneIndex'];
    const priceScaleId = fields.priceScaleId?.value as PickOptions['priceScaleId'];
    if (paneIndex !== undefined && (!Number.isSafeInteger(paneIndex) || paneIndex < 0 || !this._panes[paneIndex])) throw new RangeError('Invalid pick pane');
    const targetPane = paneIndex ?? (priceScaleId !== undefined ? this._layout._firstPaneSlot() : undefined);
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
    this._layout._syncSeparators();
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
    return this._persistence.getState();
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
    return this._persistence.restoreState(state, options);
  }

  /** What a state capture and a restore read, write and drive; see `PersistenceHost`. */
  private _persistenceHost(): PersistenceHost {
    // A getter's own `this` is the host literal, so the live fields are read
    // and written through the chart.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const chart = this;
    return {
      get _panes() { return chart._panes; },
      get _indicators() { return chart._indicators; },
      get _indicatorRanges() { return chart._indicatorRanges; },
      get _ownedScaleRanges() { return chart._ownedScaleRanges; },
      get _collapsed() { return chart._collapsed; },
      get _timezone() { return chart._timezone; },
      get _timeScale() { return chart._timeScale; },
      get _dataLayer() { return chart._dataLayer; },
      get _tradingSettings() { return chart._tradingSettings; },
      get _axisChrome() { return chart._axisChrome; },
      get _movablePrimaryPane() { return chart._movablePrimaryPane; },
      get _indicatorReservedIds() { return chart._indicatorReservedIds; },
      get _indicatorRefreshes() { return chart._indicatorRefreshes; },
      get _primaryPane() { return chart._primaryPane; },
      get _timeNav() { return chart._timeNav; },
      get _anchored() { return chart._anchored; },
      get _crosshairMode() { return chart._crosshairMode; },
      set _crosshairMode(value) { chart._crosshairMode = value; },
      get _crosshairSnapToBar() { return chart._crosshairSnapToBar; },
      set _crosshairSnapToBar(value) { chart._crosshairSnapToBar = value; },
      get _priceOnlyAutoScale() { return chart._priceOnlyAutoScale; },
      set _priceOnlyAutoScale(value) { chart._priceOnlyAutoScale = value; },
      get _indicatorLegendCollapsed() { return chart._indicatorLegendCollapsed; },
      set _indicatorLegendCollapsed(value) { chart._indicatorLegendCollapsed = value; },
      get _sourceAbove() { return chart._sourceAbove; },
      set _sourceAbove(value) { chart._sourceAbove = value; },
      get _drawingState() { return chart._drawingState; },
      set _drawingState(value) { chart._drawingState = value; },
      get _alertState() { return chart._alertState; },
      set _alertState(value) { chart._alertState = value; },
      _primaryIndex: () => this._primaryIndex(),
      getVisibleLogicalRange: () => this.getVisibleLogicalRange(),
      setVisibleLogicalRange: range => this.setVisibleLogicalRange(range),
      navigationOptions: () => this.navigationOptions(),
      _patchNavigation: patch => this._patchNavigation(patch),
      gridOptions: () => this.gridOptions(),
      setGridOptions: opts => this.setGridOptions(opts),
      canvasOptions: () => this.canvasOptions(),
      setCanvasOptions: patch => this.setCanvasOptions(patch),
      statusLineOptions: () => this.statusLineOptions(),
      setStatusLineOptions: patch => this.setStatusLineOptions(patch),
      watermarkOptions: () => this.watermarkOptions(),
      setWatermarkOptions: options => this.setWatermarkOptions(options),
      setTradingSettings: patch => this.setTradingSettings(patch),
      setAxisChromeOptions: patch => this.setAxisChromeOptions(patch),
      eventOptions: () => this.eventOptions(),
      setEventOptions: patch => this.setEventOptions(patch),
      setTimezone: zone => this.setTimezone(zone),
      _validPriceScaleId: (value): value is PriceScaleId => this._validPriceScaleId(value),
      _reserveAlertStudyIds: (document, reserved) => this._reserveAlertStudyIds(document, reserved),
      emit: (event, payload) => this.emit(event, payload),
      _withinLayoutChange: <T>(fn: () => T): T => this._withinLayoutChange(fn),
      _mutateTimeScale: <T>(apply: () => T): T => this._mutateTimeScale(apply),
      invalidate: build => this.invalidate(build),
      _emitViewportIfMoved: before => this._emitViewportIfMoved(before),
      _restackLegends: () => this._legendStack._restackLegends(),
      _ensurePane: index => this._layout._ensurePane(index),
      setPrimaryPaneIndex: index => this.setPrimaryPaneIndex(index),
      _relayout: () => this._layout._relayout(),
      _rehomeAnchored: () => this._rehomeAnchored(),
      _indicatorHost: preservedFormats => this._indicatorHost(preservedFormats),
      _reorderIndicatorResources: () => this._studies._reorderIndicatorResources(),
      _scalePatchFor: (pane, patch) => this._scalePatchFor(pane, patch),
      removePane: index => this.removePane(index),
      _recomputeAxisColumns: () => this._layout._recomputeAxisColumns(),
    };
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

  public applySize(width: number, height: number): void {
    if (width === this._width && height === this._height) return;
    this._width = width;
    this._height = height;
    this._layout._relayout();
    // Hidden tabs can receive history before they have any usable plot width.
    if (!this._hasFitContent) this._hasFitContent = this._fitDefaultView();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this.emit('resize', { width, height });
  }

  /** Stays on the chart by name: its callers here and tests read the bottom pane through it. */
  private _bottomPaneIndex(open = false): number {
    return this._layout._bottomPaneIndex(open);
  }

  /**
   * Set a pane's relative height weight. Panes share the chart height in
   * proportion to their weights, so only the ratio matters.
   */
  public setPaneWeight(index: number, weight: number): void {
    const pane = this._panes[index];
    if (pane === undefined) return;
    pane.weight = Math.max(0.05, weight);
    this._layout._relayout();
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
    return this._layout.removePane(index, options);
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
    return this._layout.movePane(index, direction);
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
    return this._layout.setPrimaryPaneIndex(index);
  }

  /** The primary pane's slot; 0 once the chart is torn down and there are no panes. */
  private _primaryIndex(): number {
    return Math.max(0, this._panes.indexOf(this._primaryPane));
  }

  /**
   * Expand one pane to fill the chart, hiding the others. Calling it again (or
   * on another pane) puts the stack back exactly as it was, since the stored
   * weights were never disturbed.
   */
  public maximizePane(index: number): boolean {
    return this._layout.maximizePane(index);
  }

  /** The maximized pane index, or null when none is. */
  public maximizedPane(): number | null {
    return this._layout._maximizedPane;
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
    return this._layout.setPaneCollapsed(index, collapsed);
  }

  /** Whether a pane is collapsed to its header strip. The primary price pane never is. */
  public paneCollapsed(index: number): boolean {
    return this._collapsed.has(this._panes[index]);
  }

  /** What the pane stack and its layout read, write and drive of the chart; see `PanesHost`. */
  private _panesHost(): PanesHost {
    // A getter's own `this` is the host literal, so the live fields are read
    // and written through the chart.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const chart = this;
    return {
      get _panes() { return chart._panes; },
      get _firstPane() { return chart._firstPane; },
      get _pricePanes() { return chart._pricePanes; },
      get _collapsed() { return chart._collapsed; },
      get _container() { return chart._container; },
      get _doc() { return chart._doc; },
      get _theme() { return chart._theme; },
      get _timeScale() { return chart._timeScale; },
      get _dataLayer() { return chart._dataLayer; },
      get _pixels() { return chart._pixels; },
      get _indicators() { return chart._indicators; },
      get _seriesProvenance() { return chart._seriesProvenance; },
      get _firstDataId() { return chart._firstDataId; },
      get _priceFormatter() { return chart._priceFormatter; },
      get _priceScaleOptions() { return chart._priceScaleOptions; },
      get _priceAxisWidth() { return chart._priceAxisWidth; },
      get _timeAxisHeight() { return chart._timeAxisHeight; },
      get _width() { return chart._width; },
      get _height() { return chart._height; },
      get _legendIconSize() { return chart._legendIconSize; },
      get _movablePrimaryPane() { return chart._movablePrimaryPane; },
      get _eventMarkers() { return chart._eventMarkers; },
      get _destroyed() { return chart._destroyed; },
      get _primaryPane() { return chart._primaryPane; },
      set _primaryPane(value) { chart._primaryPane = value; },
      get _eventPane() { return chart._eventPane; },
      set _eventPane(value) { chart._eventPane = value; },
      get _drawingState() { return chart._drawingState; },
      set _drawingState(value) { chart._drawingState = value; },
      get _layoutRatio() { return chart._layoutRatio; },
      set _layoutRatio(value) { chart._layoutRatio = value; },
      get _leftAxisWidth() { return chart._leftAxisWidth; },
      set _leftAxisWidth(value) { chart._leftAxisWidth = value; },
      get _rightAxisWidth() { return chart._rightAxisWidth; },
      set _rightAxisWidth(value) { chart._rightAxisWidth = value; },
      get _axisColumnWidth() { return chart._axisColumnWidth; },
      set _axisColumnWidth(value) { chart._axisColumnWidth = value; },
      get _emptyPriceAxis() { return chart._emptyPriceAxis; },
      set _emptyPriceAxis(value) { chart._emptyPriceAxis = value; },
      _pixelRatio: () => this._pixelRatio(),
      _newBackend: () => this._newBackend(),
      _scalePatchFor: (pane, patch) => this._scalePatchFor(pane, patch),
      _primaryIndex: () => this._primaryIndex(),
      _ensureScaled: paneIndex => this._ensureScaled(paneIndex),
      _policyAllows: (study, flag, options) => this._policyAllows(study, flag, options),
      _syncTimeNavPane: () => this._syncTimeNavPane(),
      _restackLegends: () => this._legendStack._restackLegends(),
      _syncLegendPanes: () => this._legendStack._syncLegendPanes(),
      _rehomeAnchored: () => this._rehomeAnchored(),
      _addPrimitive: (paneIndex, primitive) => this._addPrimitive(paneIndex, primitive),
      removePrimitive: primitive => this.removePrimitive(primitive),
      _paintNow: () => this._paintNow(),
      applySize: (width, height) => this.applySize(width, height),
      movePane: (index, direction) => this.movePane(index, direction),
      invalidate: build => this.invalidate(build),
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  /** Stays on the chart by name: the pointer release and tests route a legend press through it. */
  private _handleLegendAction(externalId: string): boolean {
    return this._legendStack._handleLegendAction(externalId);
  }

  /** What the legend rows read and drive of the chart; see `LegendsHost`. */
  private _legendsHost(): LegendsHost {
    // A getter's own `this` is the host literal, so the live fields are read
    // through the chart.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const chart = this;
    return {
      get _panes() { return chart._panes; },
      get _primaryPane() { return chart._primaryPane; },
      get _indicators() { return chart._indicators; },
      get _legends() { return chart._legends; },
      get _studyLegends() { return chart._studyLegends; },
      get _legendActions() { return chart._legendActions; },
      get _collapsed() { return chart._collapsed; },
      get _indicatorLegendCollapsed() { return chart._indicatorLegendCollapsed; },
      get _legendIconSize() { return chart._legendIconSize; },
      get _leftAxisWidth() { return chart._leftAxisWidth; },
      get _timeNav() { return chart._timeNav; },
      _primaryIndex: () => this._primaryIndex(),
      _priceCornerIndex: () => this._priceCornerIndex(),
      _collapsedShown: index => this._layout._collapsedShown(index),
      _runShortcut: command => this._runShortcut(command),
      addPrimitive: (primitive, where) => this.addPrimitive(primitive, where),
      removePrimitive: primitive => this.removePrimitive(primitive),
      setIndicatorLegendCollapsed: on => this.setIndicatorLegendCollapsed(on),
      removeIndicator: instanceId => this.removeIndicator(instanceId),
      movePane: (index, direction) => this.movePane(index, direction),
      setPaneCollapsed: (index, collapsed) => this.setPaneCollapsed(index, collapsed),
      paneCollapsed: index => this.paneCollapsed(index),
      maximizePane: index => this.maximizePane(index),
      invalidate: build => this.invalidate(build),
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  /** Stays on the chart by name: its callers here and tests read the pane boxes through it. */
  private _paneLayout(): { top: number; height: number }[] {
    return this._layout._paneLayout();
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
      collapsed: this._layout._collapsedShown(paneIndex),
      conflate: this._conflate,
      conflationFactor: this._conflationFactor,
      theme: this._theme,
      showVertGrid: this._gridVert,
      showHorzGrid: this._gridHorz,
      canvasOptions: this._canvas,
      timeFormatter: this._timeFormatter,
      timezone: this._timezone,
      leftAxisWidth: this._leftAxisWidth,
      hoverId: this._input._hoverId,
      hoverKey: this._input._hoverKey,
      dragId: this._input._dragId,
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

  /** What the size and pixel-ratio observation reads of the chart; see `PixelsHost`. */
  private _pixelsHost(): PixelsHost {
    // A getter's own `this` is the host literal, so the live fields are read
    // through the chart.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const chart = this;
    return {
      get _destroyed() { return chart._destroyed; },
      get _destroying() { return chart._destroying; },
      get _panes() { return chart._panes; },
      get _container() { return chart._container; },
      get _doc() { return chart._doc; },
      get _layoutRatio() { return chart._layoutRatio; },
      get _onPixelRatio() { return chart._onPixelRatio; },
      get _checkPixelRatio() { return chart._checkPixelRatio; },
      applySize: (width, height) => this.applySize(width, height),
      _paintNow: () => this._paintNow(),
      invalidate: build => this.invalidate(build),
      _pixelRatio: () => this._pixelRatio(),
      _relayout: () => this._layout._relayout(),
    };
  }

  // Arrow fields on the chart, like its other listeners, so each keeps one
  // identity from the add to the remove. The work is in chart-pixels.ts.
  private readonly _onPixelRatio = (): void => this._pixels._onPixelRatio();
  private readonly _checkPixelRatio = (): void => this._pixels._checkPixelRatio();

  /**
   * Run the pending frame now rather than on the next animation frame, for
   * the callbacks that clear a canvas once this frame's animation callbacks
   * have run: a resize observed before the browser paints, a new pixel ratio.
   * Waiting would show the cleared canvas for a frame.
   *
   * Not with a scheduler the host injected (`raf`): that host owns every frame
   * the chart paints, as with the kinetic glide, so the frame already asked
   * for runs when the host runs it.
   */
  private _paintNow(): void {
    if (this._rafInjected) return;
    if (this._destroyed || this._destroying || this._pending === null || this._scaleMutationDepth > 0) return;
    this._loop.stop();
    this._onFrame();
  }

  private _onFrame(): void {
    if (this._destroyed || this._destroying) return;
    // Before the mask is taken, not after: recomputing writes plot data, which
    // invalidates, and that invalidation has to land in this frame's mask
    // rather than in the next frame's.
    this._studies._flushIndicators();

    const mask = this._pending;
    this._pending = null;
    if (mask === null || mask.isEmpty()) return;

    const global = mask.globalLevel;
    let easing = false;
    const now = this._now();
    const fraction = this._motion._autoscaleTime === null || ++this._motion._autoscaleFrames >= 90
      ? 1 : 1 - Math.exp(-Math.max(1, now - this._motion._autoscaleTime) / 80);
    if (this._motion._autoscaleTime !== null) this._motion._autoscaleTime = now;
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
      if (level >= InvalidationLevel.Full || perPane?.autoScale || this._motion._autoscaleTime !== null) {
        easing = pane.autoscale(ctx, fraction) || easing;
      }
      if (level >= InvalidationLevel.Light) pane.paintBase(ctx);
      if (level >= InvalidationLevel.Cursor && !this._input._overlayFrozen) {
        // Global crosshair: every pane draws the vertical line at the shared x;
        // only the hovered pane draws the horizontal line + price tag; the bottom
        // pane draws the date tag.
        const cross = this._cursor === null
          ? null
          : { x: crosshairX, yLocal: i === this._input._cursorPane ? this._cursor.y : null, showTimeTag: ctx.showTimeAxis };
        pane.paintTop(cross, ctx);
      }
    }
    if (easing) this.invalidate(m => m.invalidateGlobal(InvalidationLevel.Light));
    else this._motion._autoscaleTime = null;
    const nav = this._timeNav;
    if (nav?.animating() && !this._schedulingTimeNav
      && (!this._input._overlayFrozen || nav.zOrder() !== 'top')
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

  /** What the input routing reads, writes and drives of the chart; see `InputHost`. */
  private _inputHost(): InputHost {
    // A getter's own `this` is the host literal, so the live fields are read
    // and written through the chart.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const chart = this;
    return {
      get _destroyed() { return chart._destroyed; },
      get _panes() { return chart._panes; },
      get _primaryPane() { return chart._primaryPane; },
      get _container() { return chart._container; },
      get _doc() { return chart._doc; },
      get _width() { return chart._width; },
      get _height() { return chart._height; },
      get _leftAxisWidth() { return chart._leftAxisWidth; },
      get _rightAxisWidth() { return chart._rightAxisWidth; },
      get _timeAxisHeight() { return chart._timeAxisHeight; },
      get _timeScale() { return chart._timeScale; },
      get _dataLayer() { return chart._dataLayer; },
      get _navigation() { return chart._navigation; },
      get _motion() { return chart._motion; },
      get _branding() { return chart._branding; },
      get _indicators() { return chart._indicators; },
      get _seriesRecords() { return chart._seriesRecords; },
      get _listeners() { return chart._listeners; },
      get _shortcuts() { return chart._shortcuts; },
      get _firstDataId() { return chart._firstDataId; },
      get _timeNavPane() { return chart._timeNavPane; },
      get _theme() { return chart._theme; },
      get _gridVert() { return chart._gridVert; },
      get _gridHorz() { return chart._gridHorz; },
      get _zoomAnchor() { return chart._zoomAnchor; },
      get _animZoom() { return chart._animZoom; },
      get _doubleClick() { return chart._doubleClick; },
      get _crosshairMode() { return chart._crosshairMode; },
      set _crosshairMode(value) { chart._crosshairMode = value; },
      get _dragVelocity() { return chart._dragVelocity; },
      set _dragVelocity(value) { chart._dragVelocity = value; },
      get _lastDragX() { return chart._lastDragX; },
      set _lastDragX(value) { chart._lastDragX = value; },
      get _lastDragT() { return chart._lastDragT; },
      set _lastDragT(value) { chart._lastDragT = value; },
      get _onPointerEnter() { return chart._onPointerEnter; },
      get _onContextMenu() { return chart._onContextMenu; },
      get _onPointerDown() { return chart._onPointerDown; },
      get _onPointerMove() { return chart._onPointerMove; },
      get _onPointerUp() { return chart._onPointerUp; },
      get _onPointerUpNative() { return chart._onPointerUpNative; },
      get _onPointerCancel() { return chart._onPointerCancel; },
      get _onLostPointerCapture() { return chart._onLostPointerCapture; },
      get _onPointerLeave() { return chart._onPointerLeave; },
      get _onWheel() { return chart._onWheel; },
      get _onDblClick() { return chart._onDblClick; },
      get _onKeyDown() { return chart._onKeyDown; },
      _now: () => this._now(),
      _pixelRatio: () => this._pixelRatio(),
      _renderContext: paneIndex => this._renderContext(paneIndex),
      _paneLayout: () => this._paneLayout(),
      _bottomPaneIndex: () => this._bottomPaneIndex(),
      _collapsedShown: index => this._layout._collapsedShown(index),
      _dividerAt: y => this._layout._dividerAt(y),
      _relayout: () => this._layout._relayout(),
      _ensureScaled: paneIndex => this._ensureScaled(paneIndex),
      _xToTime: x => this._xToTime(x),
      _mutateTimeScale: <T>(apply: () => T): T => this._mutateTimeScale(apply),
      _emitViewport: type => this._emitViewport(type),
      _emitViewportIfMoved: before => this._emitViewportIfMoved(before),
      _maybeLoadHistory: () => this._maybeLoadHistory(),
      _startKinetic: velocity => this._startKinetic(velocity),
      _indicatorLegendHit: (paneIndex, x, y) => this._legendStack._indicatorLegendHit(paneIndex, x, y),
      _handleLegendAction: externalId => this._handleLegendAction(externalId),
      _feedTimeNav: p => this._feedTimeNav(p),
      _firstPaneSlot: () => this._layout._firstPaneSlot(),
      _navigationAllowed: command => this._navigationAllowed(command),
      _updateAccessibleSummary: () => this._updateAccessibleSummary(),
      priceAxisLayout: paneIndex => this.priceAxisLayout(paneIndex),
      resetScale: () => this.resetScale(),
      fitContent: () => this.fitContent(),
      downloadScreenshot: () => this.downloadScreenshot(),
      setGridOptions: opts => this.setGridOptions(opts),
      maximizePane: index => this.maximizePane(index),
      invalidate: build => this.invalidate(build),
      emit: (event, payload) => this.emit(event, payload),
    };
  }

  // Arrow fields on the chart, like its other listeners, so each keeps one
  // identity from the add to the remove, and tests still drive them by name.
  // The work is in chart-input.ts.
  private readonly _onPointerEnter = (): void => this._input._onPointerEnter();
  private readonly _onContextMenu = (e: MouseEvent): void => this._input._onContextMenu(e);
  private readonly _onPointerDown = (e: PointerEvent): void => this._input._onPointerDown(e);
  private readonly _onPointerMove = (e: PointerEvent): void => this._input._onPointerMove(e);
  private readonly _onPointerUp = (e: PointerEvent): void => this._input._onPointerUp(e);
  private readonly _onPointerUpNative = (e: PointerEvent): void => this._input._onPointerUpNative(e);
  private readonly _onPointerCancel = (e: PointerEvent): void => this._input._onPointerCancel(e);
  private readonly _onLostPointerCapture = (e: PointerEvent): void => this._input._onLostPointerCapture(e);
  private readonly _onPointerLeave = (): void => this._input._onPointerLeave();
  private readonly _onWheel = (e: WheelEvent): void => this._input._onWheel(e);
  private readonly _onDblClick = (e: { clientX: number; clientY: number }): void => this._input._onDblClick(e);
  private readonly _onKeyDown = (e: KeyboardEvent): void => this._input._onKeyDown(e);

  /** Stays on the chart by name: the navigator's buttons and tests run a command through it. */
  private _runShortcut(command: string): boolean {
    return this._input._runShortcut(command);
  }

  /** Stays on the chart by name, for the frame and for tests; the pointer handlers set it. */
  private get _cursor(): { x: number; y: number } | null {
    return this._input._cursor;
  }

  /** What the navigation motion reads and drives of the chart; see `MotionHost`. */
  private _motionHost(): MotionHost {
    // A getter's own `this` is the host literal, so the live fields are read
    // through the chart.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const chart = this;
    return {
      get _navigation() { return chart._navigation; },
      get _destroyed() { return chart._destroyed; },
      get _raf() { return chart._raf; },
      get _timeScale() { return chart._timeScale; },
      _now: () => this._now(),
      _mutateTimeScale: <T>(apply: () => T): T => this._mutateTimeScale(apply),
      _maybeLoadHistory: () => this._maybeLoadHistory(),
      invalidate: build => this.invalidate(build),
      _emitViewport: type => this._emitViewport(type),
    };
  }

  /**
   * Restore the preferred visible bar count and re-enable
   * auto-scaling on every price axis (undoing any pan/zoom or manual axis drag).
   * Same as double-clicking the chart.
   */
  public resetScale(): void {
    this._motion._stopNavigationMotion();
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

  /** Stays on the chart by name: the pointer release and tests start a glide through it. */
  private _startKinetic(velocity: number): void {
    this._motion._startKinetic(velocity);
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
    this._motion._stopNavigationMotion();
    for (const indicator of this._indicators.splice(0)) indicator.remove({ force: true });
    this._pixels._resizeObserver?.disconnect();
    this._pixels._resizeObserver = null;
    this._pixels._deviceObserver?.disconnect();
    this._pixels._deviceObserver = null;
    this._pixels._unwatchPixelRatio();
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
      this._input._keyTarget?.removeEventListener('keydown', this._onKeyDown as EventListener);
      this._input._keyTarget = null;
    }
    this._liveRegion?.remove();
    this._liveRegion = null;
    this._container.style.cursor = ''; // drop any hover cursor hint we applied
    this._input._pointers.clear();
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
