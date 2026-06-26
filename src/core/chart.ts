/**
 * Top-level chart orchestrator (ARCHITECTURE.md §3.3). Owns the shared
 * DataLayer + time scale, the panes, the invalidate mask, and the render loop.
 * Phase 2 renders static candlesticks with price/time axes; pan/zoom (Phase 3)
 * and live data (Phase 4) build on this.
 */
import { InvalidateMask, InvalidationLevel } from './invalidate-mask';
import { RenderLoop, type RafScheduler, type RafCanceller } from './render-loop';
import { Pane, type PaneTheme, DEFAULT_PANE_THEME, type PaneRenderContext } from './pane';
import { TimeScale } from '../scale/time-scale';
import { DataLayer } from '../model/data-layer';
import { createSeriesRecord, type SeriesApi } from '../model/series';
import { getChartType, type SeriesType } from '../model/chart-type-registry';
import type { SeriesStyle } from '../render/series-style';
import type { Bar } from '../model/bar';
import { KineticAnimation } from '../input/kinetic';
import { magnetSnapPrice, type CrosshairMode } from '../input/crosshair';
import type { IPrimitive, PrimitiveHost } from '../primitives/primitive';
import { PriceLine, type PriceLineOptions } from '../primitives/price-line';
import { SeriesMarkers } from '../primitives/markers';
import { EventMarkers } from '../primitives/event-markers';

export interface ChartOptions {
  document?: Document;
  pixelRatio?: () => number;
  raf?: { schedule: RafScheduler; cancel?: RafCanceller };
  theme?: PaneTheme;
  priceAxisWidth?: number;
  timeAxisHeight?: number;
  /** Crosshair behaviour: 'normal' (free) or 'magnet' (snap to O/H/L/C). */
  crosshairMode?: CrosshairMode;
  /** Time source for kinetic animation (defaults to performance.now). */
  now?: () => number;
}

export interface AddSeriesOptions {
  /** Target pane index (0 = price). Higher panes are created on demand. */
  paneIndex?: number;
  /** Style overrides merged onto the chart type's defaults. */
  style?: SeriesStyle;
}

function defaultPixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

export class Chart {
  private readonly _container: HTMLElement;
  private readonly _doc: Document;
  private readonly _pixelRatio: () => number;
  private readonly _theme: PaneTheme;
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
  private readonly _crosshairMode: CrosshairMode;
  private readonly _now: () => number;
  private _cursorPane: number | null = null;
  private _cursor: { x: number; y: number } | null = null;
  private _dragging = false;
  private _dragStartX = 0;
  private _dragStartOffset = 0;
  private _lastDragX = 0;
  private _lastDragT = 0;
  private _dragVelocity = 0;
  private _kineticHandle: number | null = null;
  private readonly _firstDataId: { value: number | null } = { value: null };
  private _historyLoader: (() => void) | null = null;
  private _loadingHistory = false;
  private _clickCb: ((externalId: string) => void) | null = null;
  private _pointerMoved = false;
  private _downPane = 0;
  private _downX = 0;
  private _downLocalY = 0;
  private _dragId: string | null = null; // externalId of the primitive being dragged
  private _dragCb: ((externalId: string, price: number) => void) | null = null;
  private _dragEndCb: ((externalId: string, price: number) => void) | null = null;

  public constructor(container: HTMLElement, options: ChartOptions = {}) {
    this._container = container;
    this._doc = options.document ?? container.ownerDocument;
    this._pixelRatio = options.pixelRatio ?? defaultPixelRatio;
    this._theme = options.theme ?? DEFAULT_PANE_THEME;
    this._priceAxisWidth = options.priceAxisWidth ?? 56;
    this._timeAxisHeight = options.timeAxisHeight ?? 22;
    this._crosshairMode = options.crosshairMode ?? 'magnet';
    this._now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : 0));

    container.style.position = container.style.position || 'relative';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';

    this._loop = options.raf
      ? new RenderLoop(() => this._onFrame(), options.raf.schedule, options.raf.cancel)
      : new RenderLoop(() => this._onFrame());

    this._addPane();
    this._observeSize();
    this._attachInput();
    this.applySize(container.clientWidth, container.clientHeight);
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

  /** Add a series and return its data handle. */
  public addSeries(type: SeriesType, options: AddSeriesOptions = {}): SeriesApi {
    const dataId = this._dataLayer.createSeries();
    const paneIndex = options.paneIndex ?? 0;
    this._ensurePane(paneIndex);
    // The first price-type series on pane 0 drives the magnet crosshair.
    if (this._firstDataId.value === null && getChartType(type).isPriceSeries) {
      this._firstDataId.value = dataId;
    }
    this._panes[paneIndex].addSeries(createSeriesRecord(dataId, type, options.style));
    return {
      setData: (bars: readonly Bar[]): void => this._setData(dataId, bars),
      prependData: (bars: readonly Bar[]): void => this._prependData(dataId, bars),
      update: (bar: Bar): void => this._updateBar(dataId, bar),
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

  /** Subscribe to drags of draggable lines (order/SL/TP). Fires per move and on release. */
  public subscribeDrag(onDrag: (externalId: string, price: number) => void, onDragEnd?: (externalId: string, price: number) => void): void {
    this._dragCb = onDrag;
    this._dragEndCb = onDragEnd ?? null;
  }

  /** Public: attach any primitive (indicators, profiles, custom overlays) to a pane. */
  public addPrimitive(primitive: IPrimitive, paneIndex = 0): void {
    this._addPrimitive(paneIndex, primitive);
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

  /** Apply one live bar; auto-scroll only when the latest bar is at the right edge. */
  private _updateBar(dataId: number, bar: Bar): void {
    const wasAtRight = this._timeScale.rightOffset >= 0;
    const added = this._dataLayer.update(dataId, bar);
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    if (added && !wasAtRight) {
      // viewing history: compensate so existing bars don't drift
      this._timeScale.setRightOffset(this._timeScale.rightOffset - 1);
    }
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
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
  }

  /** History paging: merge older bars, preserving the viewport (§4.2). */
  private _prependData(dataId: number, bars: readonly Bar[]): void {
    this._dataLayer.addBars(dataId, bars);
    // baseIndex shifts up by the inserted count; updating it keeps the same
    // bars on screen because (rightEdge − index) is invariant.
    this._timeScale.setBaseIndex(this._dataLayer.baseIndex);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  private _addPane(weight = 1): Pane {
    const pane = new Pane(this._doc, this._theme);
    pane.weight = weight;
    this._panes.push(pane);
    this._container.appendChild(pane.element);
    return pane;
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
  }

  /** Distribute height across panes by weight; sync the shared time-scale width. */
  private _relayout(): void {
    const dpr = this._pixelRatio();
    let total = 0;
    for (const pane of this._panes) total += pane.weight;
    if (total <= 0) total = 1;
    for (const pane of this._panes) {
      pane.resize(this._width, (this._height * pane.weight) / total, dpr);
    }
    this._timeScale.setWidth(Math.max(0, this._width - this._priceAxisWidth));
  }

  private _renderContext(showTimeAxis: boolean): PaneRenderContext {
    return {
      timeScale: this._timeScale,
      dataLayer: this._dataLayer,
      dpr: this._pixelRatio(),
      priceAxisWidth: this._priceAxisWidth,
      timeAxisHeight: this._timeAxisHeight,
      showTimeAxis,
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
        const cross = this._cursorPane === i && this._cursor !== null ? this._cursor : null;
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
    el.addEventListener('pointerleave', this._onPointerLeave);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('dblclick', this._onDblClick);
  }

  private _localPoint(e: { clientX: number; clientY: number }): { x: number; y: number; pane: number; localY: number } {
    const rect = this._container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const paneHeight = this._height / Math.max(1, this._panes.length);
    const pane = Math.min(this._panes.length - 1, Math.max(0, Math.floor(y / paneHeight)));
    return { x, y, pane, localY: y - pane * paneHeight };
  }

  private readonly _onPointerDown = (e: PointerEvent): void => {
    this._stopKinetic();
    const p = this._localPoint(e);
    this._downPane = p.pane;
    this._downX = p.x;
    this._downLocalY = p.localY;
    this._container.setPointerCapture?.(e.pointerId);

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
    this._dragStartOffset = this._timeScale.rightOffset;
    this._lastDragX = p.x;
    this._lastDragT = this._now();
    this._dragVelocity = 0;
  };

  private readonly _onPointerMove = (e: PointerEvent): void => {
    const p = this._localPoint(e);
    if (this._dragId !== null) {
      const price = this._panes[this._downPane].priceScale.yToPrice(p.localY);
      this._dragCb?.(this._dragId, price);
      return;
    }
    if (this._dragging) {
      const dx = p.x - this._dragStartX;
      if (Math.abs(dx) > 3) this._pointerMoved = true;
      this._timeScale.setRightOffset(this._dragStartOffset - dx / this._timeScale.barSpacing);
      const t = this._now();
      const dt = t - this._lastDragT;
      if (dt > 0) this._dragVelocity = (p.x - this._lastDragX) / dt;
      this._lastDragX = p.x;
      this._lastDragT = t;
      this._maybeLoadHistory();
      this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      return;
    }
    this._updateCursor(p.pane, p.x, p.localY);
  };

  private readonly _onPointerUp = (e: PointerEvent): void => {
    this._container.releasePointerCapture?.(e.pointerId);
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
      if (hit) this._clickCb(hit.externalId);
      return;
    }
    if (KineticAnimation.shouldAnimate(this._dragVelocity)) this._startKinetic(this._dragVelocity);
  };

  private readonly _onPointerLeave = (): void => {
    if (this._cursor !== null) {
      const pane = this._cursorPane;
      this._cursor = null;
      this._cursorPane = null;
      if (pane !== null) this.invalidate((m) => m.invalidatePane(pane, { level: InvalidationLevel.Cursor, autoScale: false }));
    }
  };

  private readonly _onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this._localPoint(e);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this._timeScale.zoomAtX(p.x, factor);
    this._maybeLoadHistory();
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  };

  private readonly _onDblClick = (): void => {
    if (this._dataLayer.length > 0) this._timeScale.fitContent(this._dataLayer.length);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  };

  private _updateCursor(paneIndex: number, x: number, localY: number): void {
    const plotWidth = Math.max(0, this._width - this._priceAxisWidth);
    if (x > plotWidth) {
      this._onPointerLeave();
      return;
    }
    const pane = this._panes[paneIndex];
    let y = localY;
    if (this._crosshairMode === 'magnet' && this._firstDataId.value !== null) {
      const index = Math.round(this._timeScale.xToIndex(x));
      const bars = this._dataLayer.visibleBars(this._firstDataId.value, index, index);
      if (bars.length > 0) {
        const snapped = magnetSnapPrice(pane.yToPrice(localY), bars[0].bar);
        y = pane.priceScale.priceToY(snapped);
      }
    }
    this._cursorPane = paneIndex;
    this._cursor = { x, y };
    this.invalidate((m) => m.invalidatePane(paneIndex, { level: InvalidationLevel.Cursor, autoScale: false }));
  }

  private _maybeLoadHistory(): void {
    if (this._historyLoader === null || this._loadingHistory) return;
    const range = this._timeScale.visibleRange();
    if (range.from < 10) {
      this._loadingHistory = true;
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
      el.removeEventListener('pointerleave', this._onPointerLeave);
      el.removeEventListener('wheel', this._onWheel);
      el.removeEventListener('dblclick', this._onDblClick);
    }
    for (const pane of this._panes) pane.element.remove();
    this._panes.length = 0;
  }
}

/** Create a chart inside the given container element. */
export function createChart(container: HTMLElement, options: ChartOptions = {}): Chart {
  return new Chart(container, options);
}
