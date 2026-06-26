/**
 * A pane is one vertically-stacked drawing region (price pane, volume pane,
 * indicator pane). It owns a base + top canvas (ARCHITECTURE.md §3.1) and a
 * price scale, and renders its series against the shared time scale + DataLayer.
 */
import { CanvasLayer } from './canvas';
import { PriceScale } from '../scale/price-scale';
import { TimeScale } from '../scale/time-scale';
import { DataLayer } from '../model/data-layer';
import type { SeriesRecord } from '../model/series';
import { computeGridLines, drawGrid, type GridStyle } from '../render/grid';
import { drawCandles, type CandleDrawItem } from '../render/candles';
import { drawHistogram, type HistogramDrawItem } from '../render/histogram';
import { drawPriceAxis, drawTimeAxis, drawLastPriceLabel, type AxisStyle, DEFAULT_AXIS_STYLE, type PlotLayout } from '../render/axis';
import { drawCrosshair } from '../render/crosshair';

export interface PaneTheme {
  background: string;
  grid: GridStyle;
  axis: AxisStyle;
}

export const DEFAULT_PANE_THEME: PaneTheme = {
  background: '#0d0e12',
  grid: { color: '#161a26', lineWidth: 1 },
  axis: DEFAULT_AXIS_STYLE,
};

export interface PaneRenderContext {
  timeScale: TimeScale;
  dataLayer: DataLayer;
  dpr: number;
  priceAxisWidth: number;
  timeAxisHeight: number;
  /** Only the bottom pane draws the time axis. */
  showTimeAxis: boolean;
}

export class Pane {
  public readonly element: HTMLElement;
  public readonly base: CanvasLayer;
  public readonly top: CanvasLayer;
  public readonly priceScale = new PriceScale();
  /** Relative height weight within the chart (price=1, volume≈0.3). */
  public weight = 1;
  private readonly _series: SeriesRecord[] = [];
  private _width = 0;
  private _height = 0;
  private readonly _theme: PaneTheme;

  public constructor(doc: Document, theme: PaneTheme = DEFAULT_PANE_THEME) {
    this._theme = theme;
    this.element = doc.createElement('div');
    this.element.style.position = 'relative';
    this.element.style.width = '100%';
    this.element.style.flex = '1 1 auto';
    this.element.style.overflow = 'hidden';
    this.base = new CanvasLayer(doc, 0);
    this.top = new CanvasLayer(doc, 1);
    this.element.appendChild(this.base.element);
    this.element.appendChild(this.top.element);
  }

  public addSeries(record: SeriesRecord): void {
    this._series.push(record);
  }

  public series(): readonly SeriesRecord[] {
    return this._series;
  }

  public resize(width: number, height: number, dpr: number): void {
    this._width = width;
    this._height = height;
    this.base.resize(width, height, dpr);
    this.top.resize(width, height, dpr);
  }

  private _layout(ctx: PaneRenderContext): PlotLayout {
    return {
      plotWidth: Math.max(0, this._width - ctx.priceAxisWidth),
      plotHeight: Math.max(0, this._height - (ctx.showTimeAxis ? ctx.timeAxisHeight : 0)),
      priceAxisWidth: ctx.priceAxisWidth,
      timeAxisHeight: ctx.showTimeAxis ? ctx.timeAxisHeight : 0,
    };
  }

  /** Recompute the price range from the visible bars of all series in this pane. */
  public autoscale(ctx: PaneRenderContext): void {
    const layout = this._layout(ctx);
    this.priceScale.setHeight(layout.plotHeight);
    const range = ctx.timeScale.visibleRange();
    let low = Infinity;
    let high = -Infinity;
    for (const s of this._series) {
      for (const ib of ctx.dataLayer.visibleBars(s.dataId, range.from, range.to)) {
        if (ib.bar.low < low) low = ib.bar.low;
        if (ib.bar.high > high) high = ib.bar.high;
      }
    }
    if (low <= high) this.priceScale.autoscale(low, high);
  }

  /** Paint background + grid + series + axes on the base canvas. */
  public paintBase(ctx: PaneRenderContext): void {
    const layout = this._layout(ctx);
    const dpr = ctx.dpr;
    const g = this.base.ctx;
    this.base.clearBitmap();

    // background (full pane)
    g.fillStyle = this._theme.background;
    g.fillRect(0, 0, Math.round(this._width * dpr), Math.round(this._height * dpr));

    // grid within the plot area
    const lines = computeGridLines(layout.plotWidth, layout.plotHeight, { spacing: 60 });
    drawGrid(g, lines, layout.plotWidth, layout.plotHeight, dpr, this._theme.grid);

    // series
    const range = ctx.timeScale.visibleRange();
    const priceToY = (p: number): number => this.priceScale.priceToY(p);
    let lastClose: number | null = null;
    let lastUp = true;
    for (const s of this._series) {
      const visible = ctx.dataLayer.visibleBars(s.dataId, range.from, range.to);
      if (s.type === 'candlestick') {
        const items: CandleDrawItem[] = visible.map((ib) => ({ x: ctx.timeScale.indexToX(ib.index), bar: ib.bar }));
        drawCandles(g, items, priceToY, ctx.timeScale.barSpacing, dpr, s.style);
        const all = ctx.dataLayer.indexedBars(s.dataId);
        const last = all[all.length - 1];
        if (last !== undefined) {
          lastClose = last.bar.close;
          lastUp = last.bar.close >= last.bar.open;
        }
      } else {
        const items: HistogramDrawItem[] = visible.map((ib) => ({ x: ctx.timeScale.indexToX(ib.index), bar: ib.bar }));
        drawHistogram(g, items, priceToY, ctx.timeScale.barSpacing, dpr, s.style);
      }
    }

    // axes
    drawPriceAxis(g, this.priceScale, layout, dpr, this._theme.axis);
    if (lastClose !== null) {
      drawLastPriceLabel(g, this.priceScale, lastClose, lastUp, layout, dpr);
    }
    if (ctx.showTimeAxis) {
      drawTimeAxis(g, ctx.timeScale, ctx.dataLayer, layout, dpr, this._theme.axis);
    }
  }

  /** Top (overlay) canvas: crosshair/hover. Cheap — only this repaints on cursor moves. */
  public paintTop(crosshair: { x: number; y: number } | null, ctx: PaneRenderContext): void {
    this.top.clearBitmap();
    if (crosshair === null) return;
    const layout = this._layout(ctx);
    drawCrosshair(this.top.ctx, crosshair.x, crosshair.y, layout.plotWidth, layout.plotHeight, ctx.dpr);
  }

  /** Price at a media-px y on this pane (for crosshair magnet). */
  public yToPrice(y: number): number {
    return this.priceScale.yToPrice(y);
  }
}
