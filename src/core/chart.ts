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
import { createCandlestickRecord, type SeriesApi, type SeriesType } from '../model/series';
import type { CandleStyle } from '../render/candles';
import type { Bar } from '../model/bar';
import { KineticAnimation } from '../input/kinetic';
import { magnetSnapPrice, type CrosshairMode } from '../input/crosshair';

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

  /** Add a series (Phase 2: candlestick) and return its data handle. */
  public addSeries(type: SeriesType, style?: Partial<CandleStyle>): SeriesApi {
    if (type !== 'candlestick') {
      throw new Error(`openalgo-charts: series type "${type}" arrives in a later phase`);
    }
    const dataId = this._dataLayer.createSeries();
    if (this._firstDataId.value === null) this._firstDataId.value = dataId;
    const record = createCandlestickRecord(dataId, style);
    // Phase 2: all series live on the first (price) pane.
    this._panes[0].addSeries(record);
    return {
      setData: (bars: readonly Bar[]): void => this._setData(dataId, bars),
      prependData: (bars: readonly Bar[]): void => this._prependData(dataId, bars),
    };
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

  private _addPane(): Pane {
    const pane = new Pane(this._doc, this._theme);
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
    const dpr = this._pixelRatio();
    const paneHeight = this._panes.length > 0 ? height / this._panes.length : height;
    for (const pane of this._panes) pane.resize(width, paneHeight, dpr);
    this._timeScale.setWidth(Math.max(0, width - this._priceAxisWidth));
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
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
    this._dragging = true;
    const p = this._localPoint(e);
    this._dragStartX = p.x;
    this._dragStartOffset = this._timeScale.rightOffset;
    this._lastDragX = p.x;
    this._lastDragT = this._now();
    this._dragVelocity = 0;
    this._container.setPointerCapture?.(e.pointerId);
  };

  private readonly _onPointerMove = (e: PointerEvent): void => {
    const p = this._localPoint(e);
    if (this._dragging) {
      const dx = p.x - this._dragStartX;
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
    this._dragging = false;
    this._container.releasePointerCapture?.(e.pointerId);
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
