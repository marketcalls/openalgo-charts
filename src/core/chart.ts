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
import type { PriceScaleOptions } from '../scale/price-scale';
import { DataLayer } from '../model/data-layer';
import { createSeriesRecord, type SeriesApi } from '../model/series';
import { getChartType, type SeriesType } from '../model/chart-type-registry';
import type { SeriesStyle } from '../render/series-style';
import type { Bar, SeriesDataItem } from '../model/bar';
import { toBar } from '../model/bar';
import { KineticAnimation } from '../input/kinetic';
import { magnetSnapPrice, type CrosshairMode } from '../input/crosshair';
import { ShortcutManager } from '../input/shortcuts';
import type { ShortcutManagerOptions } from '../input/shortcuts';
import { TradingController } from './trading-controller';
import { pinchState, pinchDelta, type PinchState } from '../input/touch';
import type { IPrimitive, PrimitiveHost } from '../primitives/primitive';
import { PriceLine, type PriceLineOptions } from '../primitives/price-line';
import { SeriesMarkers } from '../primitives/markers';
import { EventMarkers } from '../primitives/event-markers';

export interface ChartOptions {
  document?: Document;
  pixelRatio?: () => number;
  raf?: { schedule: RafScheduler; cancel?: RafCanceller };
  /** Full palette; pass `darkTheme` (default), `lightTheme`, or a custom ChartTheme. */
  theme?: ChartTheme;
  priceAxisWidth?: number;
  timeAxisHeight?: number;
  /**
   * Crosshair behaviour. 'normal' (default) — the cross follows the pointer
   * exactly. 'magnet' — the horizontal line snaps to the nearest O/H/L/C of the
   * bar under the cursor (price pane only).
   */
  crosshairMode?: CrosshairMode;
  /** Time source for kinetic animation (defaults to performance.now). */
  now?: () => number;
  /** Enable OHLC-preserving conflation when zoomed out (§4.4). Default false. */
  conflate?: boolean;
  /** Conflation aggressiveness (default 1). */
  conflationFactor?: number;
  /** Grid line visibility. Both default to true. */
  grid?: { vertLines?: boolean; horzLines?: boolean };
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
   * `mode: 'linear' | 'logarithmic'`, `inverted`, and top/bottom margins).
   * Tune a single pane later via `chart.panes()[n].priceScale.setOptions(...)`.
   */
  priceScale?: Partial<PriceScaleOptions>;
  /**
   * Custom time-axis and crosshair label formatter (receives UTC seconds). When
   * omitted, labels use IST (Indian market default). e.g. for UTC:
   * `(s) => new Date(s * 1000).toISOString().slice(11, 16)`.
   */
  timeFormatter?: (utcSeconds: number) => string;
}

export interface AddSeriesOptions {
  /** Target pane index (0 = price). Higher panes are created on demand. */
  paneIndex?: number;
  /** Style overrides merged onto the chart type's defaults. */
  style?: SeriesStyle;
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
}

function defaultPixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

export class Chart {
  private readonly _container: HTMLElement;
  private readonly _doc: Document;
  private readonly _pixelRatio: () => number;
  private readonly _theme: ChartTheme;
  private readonly _panes: Pane[] = [];
  private readonly _loop: RenderLoop;
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
  private _cursorPane: number | null = null;
  private _cursor: { x: number; y: number } | null = null;
  private _dragging = false;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _lastDragY = 0;
  // multi-touch: active pointers + current pinch gesture
  private readonly _pointers = new Map<number, { x: number; y: number; pane: number }>();
  private _pinch: PinchState | null = null;
  private _pinchPane = 0;
  private _liveRegion: HTMLElement | null = null;
  private _dragStartOffset = 0;
  private _lastDragX = 0;
  private _lastDragT = 0;
  private _dragVelocity = 0;
  private _kineticHandle: number | null = null;
  private readonly _firstDataId: { value: number | null } = { value: null };
  /** Pane holding the primary price series (only this pane gets magnet snapping). */
  private _firstPaneIndex = 0;
  private _historyLoader: (() => void) | null = null;
  private _loadingHistory = false;
  private _clickCb: ((externalId: string) => void) | null = null;
  private _crosshairCb: ((e: CrosshairMoveEvent) => void) | null = null;
  private _pointerMoved = false;
  private _downPane = 0;
  private _downX = 0;
  private _downLocalY = 0;
  private _dragId: string | null = null; // externalId of the primitive being dragged
  private _dragCb: ((externalId: string, price: number) => void) | null = null;
  private _dragEndCb: ((externalId: string, price: number) => void) | null = null;
  // axis-drag rescale (price axis = vertical, time axis = horizontal)
  private _axisDrag: 'price' | 'time' | null = null;
  private _axisStartCoord = 0;
  private _axisStartMin = 0;
  private _axisStartMax = 0;
  private _axisStartSpacing = 0;
  private _priceFormatter: ((price: number) => string) | null = null;
  private _priceScaleOptions: Partial<PriceScaleOptions> | null = null;
  private _timeFormatter: ((utcSeconds: number) => string) | undefined = undefined;

  public constructor(container: HTMLElement, options: ChartOptions = {}) {
    this._container = container;
    this._doc = options.document ?? container.ownerDocument;
    this._pixelRatio = options.pixelRatio ?? defaultPixelRatio;
    this._theme = options.theme ?? DEFAULT_THEME;
    this._priceAxisWidth = options.priceAxisWidth ?? 56;
    this._timeAxisHeight = options.timeAxisHeight ?? 22;
    this._crosshairMode = options.crosshairMode ?? 'normal';
    const sc = options.shortcuts;
    this._shortcuts = sc === false ? null : (sc instanceof ShortcutManager ? sc : new ShortcutManager(sc ?? {}));
    this._now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : 0));
    this._conflate = options.conflate ?? false;
    this._conflationFactor = options.conflationFactor ?? 1;
    this._priceFormatter = options.priceFormatter ?? null;
    this._priceScaleOptions = options.priceScale ?? null;
    this._timeFormatter = options.timeFormatter;
    this._gridVert = options.grid?.vertLines ?? true;
    this._gridHorz = options.grid?.horzLines ?? true;

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

    this._loop = options.raf
      ? new RenderLoop(() => this._onFrame(), options.raf.schedule, options.raf.cancel)
      : new RenderLoop(() => this._onFrame());

    this._addPane();
    this._observeSize();
    this._attachInput();
    // A host that mutates the time scale directly (e.g. setVisibleLogicalRange to
    // preserve zoom across a data reload) still triggers a repaint.
    this._timeScale.setChangeHandler(() => this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full)));
    this.applySize(container.clientWidth, container.clientHeight);
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
    this._timeScale.setVisibleLogicalRange(range);
  }

  /** The current visible logical range. */
  public getVisibleLogicalRange(): LogicalRange {
    return this._timeScale.visibleRange();
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
    if (this._trading === null) this._trading = new TradingController(this);
    return this._trading;
  }

  /** Add a series and return its data handle. */
  public addSeries(type: SeriesType, options: AddSeriesOptions = {}): SeriesApi {
    const dataId = this._dataLayer.createSeries();
    const paneIndex = options.paneIndex ?? 0;
    this._ensurePane(paneIndex);
    // The first price-type series drives the magnet crosshair + OHLC legend.
    if (this._firstDataId.value === null && getChartType(type).isPriceSeries) {
      this._firstDataId.value = dataId;
      this._firstPaneIndex = paneIndex;
    }
    this._panes[paneIndex].addSeries(createSeriesRecord(dataId, type, options.style));
    return {
      setData: (bars: readonly SeriesDataItem[]): void => this._setData(dataId, bars.map(toBar)),
      prependData: (bars: readonly SeriesDataItem[]): void => this._prependData(dataId, bars.map(toBar)),
      update: (bar: SeriesDataItem): void => this._updateBar(dataId, toBar(bar)),
      getData: (): Bar[] => this._dataLayer.indexedBars(dataId).map((ib) => ib.bar),
      createMarkers: (): SeriesMarkers => {
        const m = new SeriesMarkers(dataId);
        this._addPrimitive(paneIndex, m);
        return m;
      },
    };
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

  /** Subscribe to drags of draggable lines (order/SL/TP). Fires per move and on release. */
  public subscribeDrag(onDrag: (externalId: string, price: number) => void, onDragEnd?: (externalId: string, price: number) => void): void {
    this._dragCb = onDrag;
    this._dragEndCb = onDragEnd ?? null;
  }

  // ── unified event bus ─────────────────────────────────────────────────────
  // One `on(name, cb)` surface for every chart event, complementing the typed
  // `subscribe*` helpers. Names emitted by the core: 'ready', 'crosshair:move',
  // 'click', 'pan', 'zoom', 'resize', 'lazy-load'. The trade layer routes its
  // 'trading:*' events through here too, so `chart.on('trading:order_modify')`
  // and `chart.trading.on('order_modify')` are equivalent.
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

  /** Public: attach any primitive (indicators, profiles, custom overlays) to a pane. */
  public addPrimitive(primitive: IPrimitive, paneIndex = 0): void {
    this._addPrimitive(paneIndex, primitive);
  }

  /**
   * Map a price to a container-relative Y in media (CSS) px, for positioning DOM
   * overlays (order panels, tooltips) over a pane. Returns null if the pane
   * doesn't exist. The inverse is `coordinateToPrice`.
   */
  public priceToCoordinate(price: number, paneIndex = 0): number | null {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return null;
    const top = this._paneLayout()[paneIndex]?.top ?? 0;
    return top + pane.priceScale.priceToY(price);
  }

  /** Map a container-relative media-px Y back to a price on a pane (inverse of priceToCoordinate). */
  public coordinateToPrice(y: number, paneIndex = 0): number | null {
    const pane = this._panes[paneIndex];
    if (pane === undefined) return null;
    const top = this._paneLayout()[paneIndex]?.top ?? 0;
    return pane.priceScale.yToPrice(y - top);
  }

  /**
   * Toggle the vertical (time) and/or horizontal (price) grid lines at runtime.
   * Omitted fields keep their current visibility. Repaints every pane.
   */
  public setGridOptions(opts: { vertLines?: boolean; horzLines?: boolean }): void {
    if (opts.vertLines !== undefined) this._gridVert = opts.vertLines;
    if (opts.horzLines !== undefined) this._gridHorz = opts.horzLines;
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /** Current grid line visibility. */
  public gridOptions(): { vertLines: boolean; horzLines: boolean } {
    return { vertLines: this._gridVert, horzLines: this._gridHorz };
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

  private _addPrimitive(paneIndex: number, primitive: IPrimitive): void {
    this._ensurePane(paneIndex);
    const host: PrimitiveHost = {
      requestUpdate: (): void =>
        this.invalidate((m) => m.invalidatePane(paneIndex, { level: InvalidationLevel.Light, autoScale: false })),
    };
    this._panes[paneIndex].addPrimitive(primitive, host);
    this.invalidate((m) => m.invalidatePane(paneIndex, { level: InvalidationLevel.Light, autoScale: false }));
  }

  /** Remove a primitive from whichever pane holds it. */
  public removePrimitive(primitive: IPrimitive): void {
    for (let i = 0; i < this._panes.length; i++) {
      if (this._panes[i].removePrimitive(primitive)) {
        this.invalidate((m) => m.invalidatePane(i, { level: InvalidationLevel.Light, autoScale: false }));
        return;
      }
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
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
  }

  private _ensurePane(index: number): void {
    let changed = false;
    while (this._panes.length <= index) {
      // price pane (0) takes full weight; lower panes (volume/indicators) are shorter
      this._addPane(this._panes.length === 0 ? 1 : 0.32);
      changed = true;
    }
    if (changed) this._relayout();
  }

  private _setData(dataId: number, bars: readonly Bar[]): void {
    this._dataLayer.setSeriesData(dataId, bars);
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    if (!this._hasFitContent && this._dataLayer.length > 0) {
      this._timeScale.setWidth(Math.max(0, this._width - this._priceAxisWidth));
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
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._updateAccessibleSummary();
  }

  private _addPane(weight = 1): Pane {
    const pane = new Pane(this._doc);
    pane.weight = weight;
    pane.priceScale.setPriceFormatter(this._priceFormatter);
    if (this._priceScaleOptions) pane.priceScale.setOptions(this._priceScaleOptions);
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
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  /**
   * Set a custom time-axis + crosshair label formatter (UTC seconds -> string)
   * at runtime. Pass undefined to restore the IST default.
   */
  public setTimeFormatter(fn: ((utcSeconds: number) => string) | undefined): void {
    this._timeFormatter = fn;
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  public panes(): readonly Pane[] {
    return this._panes;
  }

  public invalidate(build: (mask: InvalidateMask) => void): void {
    if (this._pending === null) this._pending = new InvalidateMask();
    build(this._pending);
    this._loop.requestFrame();
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
    const dpr = this._pixelRatio();
    const total = this._weightTotal();
    for (const pane of this._panes) {
      // DOM box and canvas use the SAME weighted height so layout == hit-test.
      pane.element.style.flex = `${pane.weight} 1 0`;
      pane.resize(this._width, (this._height * pane.weight) / total, dpr);
    }
    this._timeScale.setWidth(Math.max(0, this._width - this._priceAxisWidth));
  }

  private _weightTotal(): number {
    let total = 0;
    for (const pane of this._panes) total += pane.weight;
    return total <= 0 ? 1 : total;
  }

  /** Cumulative top + height of each pane, by weight (the source of truth for hit-testing). */
  private _paneLayout(): { top: number; height: number }[] {
    const total = this._weightTotal();
    const out: { top: number; height: number }[] = [];
    let top = 0;
    for (const pane of this._panes) {
      const h = (this._height * pane.weight) / total;
      out.push({ top, height: h });
      top += h;
    }
    return out;
  }

  private _renderContext(showTimeAxis: boolean): PaneRenderContext {
    return {
      timeScale: this._timeScale,
      dataLayer: this._dataLayer,
      dpr: this._pixelRatio(),
      priceAxisWidth: this._priceAxisWidth,
      timeAxisHeight: this._timeAxisHeight,
      showTimeAxis,
      conflate: this._conflate,
      conflationFactor: this._conflationFactor,
      theme: this._theme,
      showVertGrid: this._gridVert,
      showHorzGrid: this._gridHorz,
      timeFormatter: this._timeFormatter,
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
    const mask = this._pending;
    this._pending = null;
    if (mask === null || mask.isEmpty()) return;

    const global = mask.globalLevel;
    for (let i = 0; i < this._panes.length; i++) {
      const pane = this._panes[i];
      const perPane = mask.paneInvalidation(i);
      const level = Math.max(global, perPane?.level ?? InvalidationLevel.None);
      const isBottom = i === this._panes.length - 1;
      const ctx = this._renderContext(isBottom);
      if (level >= InvalidationLevel.Full || perPane?.autoScale) pane.autoscale(ctx);
      if (level >= InvalidationLevel.Light) pane.paintBase(ctx);
      if (level >= InvalidationLevel.Cursor) {
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
    el.addEventListener('pointerup', this._onPointerUp);
    el.addEventListener('pointercancel', this._onPointerUp);
    el.addEventListener('pointerleave', this._onPointerLeave);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('dblclick', this._onDblClick);
    el.addEventListener('pointerenter', this._onPointerEnter);
    // Keyboard: listen on the document when available (so shortcuts fire on hover
    // without focusing the chart), else on the focusable container. The handler
    // gates by scope / hover / focus.
    const keyTarget: HTMLElement | Document =
      typeof this._doc.addEventListener === 'function' ? this._doc : el;
    keyTarget.addEventListener('keydown', this._onKeyDown as EventListener);
    this._keyTarget = keyTarget;
  }

  private readonly _onPointerEnter = (): void => { this._pointerInside = true; };

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
    this._stopKinetic();
    const p = this._localPoint(e);
    this._pointers.set(e.pointerId, { x: p.x, y: p.y, pane: p.pane });
    this._container.setPointerCapture?.(e.pointerId);
    if (this._pointers.size >= 2) { this._beginPinch(); return; } // second finger → pinch, skip single-drag
    this._downPane = p.pane;
    this._downX = p.x;
    this._downLocalY = p.localY;

    // Axis-drag rescale: dragging the price axis (right strip) rescales Y;
    // dragging the time axis (bottom strip of the last pane) rescales X.
    const plotWidth = Math.max(0, this._width - this._priceAxisWidth);
    const onPriceAxis = p.x >= plotWidth;
    const onTimeAxis = p.pane === this._panes.length - 1 && p.localY >= p.paneHeight - this._timeAxisHeight;
    if (onPriceAxis) {
      this._axisDrag = 'price';
      this._axisStartCoord = p.localY;
      const r = this._panes[p.pane].priceScale.priceRange();
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

    // If the press lands on a draggable line (order/SL/TP), drag it — don't pan.
    const hit = this._panes[p.pane]?.hitTestPrimitives(p.x, p.localY, this._renderContext(p.pane === this._panes.length - 1));
    if (hit && hit.cursor === 'ns-resize' && this._dragCb !== null) {
      this._dragId = hit.externalId;
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
    const p = this._localPoint(e);
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, { x: p.x, y: p.y, pane: p.pane });
    if (this._pinch !== null) { this._updatePinch(); return; }
    if (this._axisDrag === 'price') {
      // drag up (dy<0) → expand (zoom in); drag down → compress (zoom out)
      const dy = p.localY - this._axisStartCoord;
      const factor = Math.exp(dy * 0.005);
      const centre = (this._axisStartMin + this._axisStartMax) / 2;
      const half = ((this._axisStartMax - this._axisStartMin) / 2) * factor;
      const ps = this._panes[this._downPane].priceScale;
      ps.setPriceRange({ min: centre - half, max: centre + half });
      ps.setAutoScale(false);
      this.invalidate((m) => m.invalidatePane(this._downPane, { level: InvalidationLevel.Light, autoScale: false }));
      return;
    }
    if (this._axisDrag === 'time') {
      // drag right (dx>0) → expand (wider bars); drag left → compress
      const dx = p.x - this._axisStartCoord;
      this._timeScale.setBarSpacing(this._axisStartSpacing * Math.exp(dx * 0.005));
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      return;
    }
    if (this._dragId !== null) {
      const price = this._panes[this._downPane].priceScale.yToPrice(p.localY);
      this._dragCb?.(this._dragId, price);
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
      if (dt > 0) this._dragVelocity = (p.x - this._lastDragX) / dt;
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
    this._container.releasePointerCapture?.(e.pointerId);
    this._pointers.delete(e.pointerId);
    if (this._pinch !== null) {
      // a finger lifted mid-pinch: end the gesture; don't start a drag with the remnant
      if (this._pointers.size < 2) { this._pinch = null; this._dragging = false; }
      return;
    }
    if (this._axisDrag !== null) {
      this._axisDrag = null;
      return;
    }
    if (this._dragId !== null) {
      const p = this._localPoint(e);
      const price = this._panes[this._downPane].priceScale.yToPrice(p.localY);
      this._dragEndCb?.(this._dragId, price);
      this._dragId = null;
      return;
    }
    this._dragging = false;
    if (!this._pointerMoved && this._clickCb !== null) {
      const isBottom = this._downPane === this._panes.length - 1;
      const hit = this._panes[this._downPane]?.hitTestPrimitives(this._downX, this._downLocalY, this._renderContext(isBottom));
      if (hit) {
        this._clickCb(hit.externalId);
        this.emit('click', { id: hit.externalId });
      }
      return;
    }
    if (KineticAnimation.shouldAnimate(this._dragVelocity)) this._startKinetic(this._dragVelocity);
  };

  private readonly _onPointerLeave = (): void => {
    this._pointerInside = false;
    if (this._cursor !== null) {
      this._cursor = null;
      this._cursorPane = null;
      // clear the crosshair from every pane (global vertical line)
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Cursor));
      const cleared = { time: null, index: null, price: null, bar: null, point: null };
      this._crosshairCb?.(cleared);
      this.emit('crosshair:move', cleared);
    }
  };

  private readonly _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this._localPoint(e);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this._timeScale.zoomAtX(p.x, factor);
    this._maybeLoadHistory();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._emitViewport('zoom');
  };

  /**
   * Restore the default view: fit all bars on the time axis and re-enable
   * auto-scaling on every price axis (undoing any pan/zoom or manual axis drag).
   * Same as double-clicking the chart.
   */
  public resetScale(): void {
    if (this._dataLayer.length > 0) this._timeScale.fitContent(this._dataLayer.length);
    for (const pane of this._panes) pane.priceScale.setAutoScale(true);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  private readonly _onDblClick = (): void => this.resetScale();

  // ── multi-touch pinch (zoom + two-finger pan) ─────────────────────────────
  private _beginPinch(): void {
    const pts = [...this._pointers.values()];
    this._pinch = pinchState(pts[0], pts[1]);
    this._pinchPane = pts[0].pane;
    // abort any single-pointer interaction so it doesn't fight the pinch
    this._dragging = false; this._axisDrag = null; this._dragId = null; this._pointerMoved = true;
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
    switch (command) {
      case 'panLeft': ts.setRightOffset(ts.rightOffset - 2); return true;
      case 'panRight': ts.setRightOffset(ts.rightOffset + 2); return true;
      case 'panLeftFast': ts.setRightOffset(ts.rightOffset - 10); return true;
      case 'panRightFast': ts.setRightOffset(ts.rightOffset + 10); return true;
      case 'panUp': this._panes[0]?.priceScale.panByPixels(20); return true;
      case 'panDown': this._panes[0]?.priceScale.panByPixels(-20); return true;
      case 'zoomIn': ts.zoomAtX(this._width / 2, 1.1); return true;
      case 'zoomOut': ts.zoomAtX(this._width / 2, 1 / 1.1); return true;
      case 'resetScale': this.resetScale(); return true;
      case 'fitContent': if (this._dataLayer.length > 0) ts.fitContent(this._dataLayer.length); return true;
      case 'screenshot': this._downloadScreenshot(); return true;
      case 'toggleGridVert': this.setGridOptions({ vertLines: !this._gridVert }); return true;
      case 'toggleGridHorz': this.setGridOptions({ horzLines: !this._gridHorz }); return true;
      case 'toggleCrosshairMagnet': this._crosshairMode = this._crosshairMode === 'magnet' ? 'normal' : 'magnet'; return true;
      default: return false;
    }
  }

  private _downloadScreenshot(): void {
    try {
      const canvas = this.takeScreenshot();
      const a = this._doc.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'chart.png';
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

  private _updateCursor(paneIndex: number, x: number, localY: number, containerY = localY): void {
    const plotWidth = Math.max(0, this._width - this._priceAxisWidth);
    if (x > plotWidth) {
      this._onPointerLeave();
      return;
    }
    const pane = this._panes[paneIndex];
    let y = localY;
    const index = Math.round(this._timeScale.xToIndex(x));
    let hoveredBar: Bar | null = null;
    if (this._firstDataId.value !== null) {
      const bars = this._dataLayer.visibleBars(this._firstDataId.value, index, index);
      if (bars.length > 0) {
        hoveredBar = bars[0].bar;
        // Magnet only snaps within the pane that holds the price series — never
        // in the volume/indicator panes (their scale isn't a price scale).
        if (this._crosshairMode === 'magnet' && paneIndex === this._firstPaneIndex) {
          const snapped = magnetSnapPrice(pane.yToPrice(localY), hoveredBar);
          y = pane.priceScale.priceToY(snapped);
        }
      }
    }
    this._cursorPane = paneIndex;
    this._cursor = { x, y };
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

  private _startKinetic(velocity: number): void {
    const anim = new KineticAnimation(velocity);
    if (anim.durationMs <= 0) return;
    const start = this._now();
    let lastDist = 0;
    const step = (): void => {
      const elapsed = this._now() - start;
      const dist = anim.distanceAt(elapsed);
      const delta = dist - lastDist;
      lastDist = dist;
      this._timeScale.setRightOffset(this._timeScale.rightOffset - delta / this._timeScale.barSpacing);
      this._maybeLoadHistory();
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      if (!anim.finished(elapsed)) {
        this._kineticHandle = requestAnimationFrame(step);
      } else {
        this._kineticHandle = null;
      }
    };
    this._kineticHandle = requestAnimationFrame(step);
  }

  private _stopKinetic(): void {
    if (this._kineticHandle !== null) {
      cancelAnimationFrame(this._kineticHandle);
      this._kineticHandle = null;
    }
  }

  public destroy(): void {
    this._loop.stop();
    this._stopKinetic();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    if (typeof window !== 'undefined') {
      const el = this._container;
      el.removeEventListener('pointerdown', this._onPointerDown);
      el.removeEventListener('pointermove', this._onPointerMove);
      el.removeEventListener('pointerup', this._onPointerUp);
      el.removeEventListener('pointercancel', this._onPointerUp);
      el.removeEventListener('pointerleave', this._onPointerLeave);
      el.removeEventListener('wheel', this._onWheel);
      el.removeEventListener('dblclick', this._onDblClick);
      el.removeEventListener('pointerenter', this._onPointerEnter);
      this._keyTarget?.removeEventListener('keydown', this._onKeyDown as EventListener);
      this._keyTarget = null;
    }
    this._liveRegion?.remove();
    this._liveRegion = null;
    this._pointers.clear();
    for (const pane of this._panes) pane.destroy(); // detaches primitives + removes element
    this._panes.length = 0;
  }
}

/** Create a chart inside the given container element. */
export function createChart(container: HTMLElement, options: ChartOptions = {}): Chart {
  return new Chart(container, options);
}
