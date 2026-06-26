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

export interface ChartOptions {
  document?: Document;
  pixelRatio?: () => number;
  raf?: { schedule: RafScheduler; cancel?: RafCanceller };
  theme?: PaneTheme;
  priceAxisWidth?: number;
  timeAxisHeight?: number;
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

  public constructor(container: HTMLElement, options: ChartOptions = {}) {
    this._container = container;
    this._doc = options.document ?? container.ownerDocument;
    this._pixelRatio = options.pixelRatio ?? defaultPixelRatio;
    this._theme = options.theme ?? DEFAULT_PANE_THEME;
    this._priceAxisWidth = options.priceAxisWidth ?? 56;
    this._timeAxisHeight = options.timeAxisHeight ?? 22;

    container.style.position = container.style.position || 'relative';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';

    this._loop = options.raf
      ? new RenderLoop(() => this._onFrame(), options.raf.schedule, options.raf.cancel)
      : new RenderLoop(() => this._onFrame());

    this._addPane();
    this._observeSize();
    this.applySize(container.clientWidth, container.clientHeight);
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
    const record = createCandlestickRecord(dataId, style);
    // Phase 2: all series live on the first (price) pane.
    this._panes[0].addSeries(record);
    return {
      setData: (bars: readonly Bar[]): void => this._setData(dataId, bars),
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
      if (level >= InvalidationLevel.Cursor) pane.paintTop();
    }
  }

  public destroy(): void {
    this._loop.stop();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    for (const pane of this._panes) pane.element.remove();
    this._panes.length = 0;
  }
}

/** Create a chart inside the given container element. */
export function createChart(container: HTMLElement, options: ChartOptions = {}): Chart {
  return new Chart(container, options);
}
