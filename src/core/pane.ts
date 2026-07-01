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
import { computeGridLines, drawGrid } from '../render/grid';
import { getChartType, type DrawItem, type SeriesRenderContext } from '../model/chart-type-registry';
import { conflationGroupSize, conflateItems } from '../model/conflation';
import { drawPriceAxis, drawTimeAxis, drawLastPriceLabel, type AxisStyle, type PlotLayout } from '../render/axis';
import { drawCrosshair, drawCrosshairTag } from '../render/crosshair';
import { bestHit, type IPrimitive, type PrimitiveHit, type PrimitiveHost, type PrimitiveRenderContext } from '../primitives/primitive';
import type { ChartTheme } from '../theme';
import { formatIstCrosshairLabel } from '../feed/time';

export interface PaneRenderContext {
  timeScale: TimeScale;
  dataLayer: DataLayer;
  dpr: number;
  priceAxisWidth: number;
  timeAxisHeight: number;
  /** Only the bottom pane draws the time axis. */
  showTimeAxis: boolean;
  /** Enable OHLC-preserving conflation when bars fall below ~0.5px (§4.4). */
  conflate: boolean;
  /** Conflation aggressiveness (1 = perf only; higher = more smoothing). */
  conflationFactor: number;
  /** Active palette — drives chrome, series defaults, and trade colors. */
  theme: ChartTheme;
  /** Draw the vertical (time) grid lines. */
  showVertGrid: boolean;
  /** Draw the horizontal (price) grid lines. */
  showHorzGrid: boolean;
}

export class Pane {
  public readonly element: HTMLElement;
  public readonly base: CanvasLayer;
  public readonly top: CanvasLayer;
  public readonly priceScale = new PriceScale();
  /** Relative height weight within the chart (price=1, volume≈0.3). */
  public weight = 1;
  private readonly _series: SeriesRecord[] = [];
  private readonly _primitives: IPrimitive[] = [];
  private _width = 0;
  private _height = 0;

  public constructor(doc: Document) {
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

  public addPrimitive(primitive: IPrimitive, host: PrimitiveHost): void {
    this._primitives.push(primitive);
    primitive.attached?.(host);
  }

  /** Remove a primitive if present; returns true if it was found. */
  public removePrimitive(primitive: IPrimitive): boolean {
    const i = this._primitives.indexOf(primitive);
    if (i < 0) return false;
    this._primitives.splice(i, 1);
    primitive.detached?.();
    return true;
  }

  /** Detach every primitive (lifecycle cleanup) and remove the pane element. */
  public destroy(): void {
    for (const p of this._primitives) p.detached?.();
    this._primitives.length = 0;
    this.element.remove();
  }

  private _primitiveContext(ctx: PaneRenderContext): PrimitiveRenderContext {
    const layout = this._layout(ctx);
    return {
      timeScale: ctx.timeScale,
      priceScale: this.priceScale,
      dataLayer: ctx.dataLayer,
      plotWidth: layout.plotWidth,
      plotHeight: layout.plotHeight,
      priceAxisWidth: ctx.priceAxisWidth,
      dpr: ctx.dpr,
      theme: ctx.theme,
    };
  }

  /** Topmost primitive hit at media-px (x,y) relative to this pane's plot. */
  public hitTestPrimitives(x: number, y: number, ctx: PaneRenderContext): PrimitiveHit | null {
    const prc = this._primitiveContext(ctx);
    return bestHit(this._primitives.map((p) => (p.hitTest ? p.hitTest(x, y, prc) : null)));
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
    if (!this.priceScale.autoScale) return; // manual (axis-dragged) range — leave it
    const range = ctx.timeScale.visibleRange();
    let low = Infinity;
    let high = -Infinity;
    for (const s of this._series) {
      const entry = getChartType(s.type);
      for (const ib of ctx.dataLayer.visibleBars(s.dataId, range.from, range.to)) {
        const ext = entry.extents(ib.bar, s.style);
        if (ext.min < low) low = ext.min;
        if (ext.max > high) high = ext.max;
      }
    }
    for (const p of this._primitives) {
      const ext = p.autoscaleInfo?.();
      if (ext) {
        if (ext.min < low) low = ext.min;
        if (ext.max > high) high = ext.max;
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

    const axisStyle: AxisStyle = {
      textColor: ctx.theme.axisText,
      lineColor: ctx.theme.axisLine,
      font: '11px system-ui, sans-serif',
    };

    // background (full pane)
    g.fillStyle = ctx.theme.background;
    g.fillRect(0, 0, Math.round(this._width * dpr), Math.round(this._height * dpr));

    // grid within the plot area (vertical/horizontal independently toggleable)
    if (ctx.showVertGrid || ctx.showHorzGrid) {
      const lines = computeGridLines(layout.plotWidth, layout.plotHeight, { spacing: 60 });
      drawGrid(g, {
        verticals: ctx.showVertGrid ? lines.verticals : [],
        horizontals: ctx.showHorzGrid ? lines.horizontals : [],
      }, layout.plotWidth, layout.plotHeight, dpr, { color: ctx.theme.grid, lineWidth: 1 });
    }

    // bottom-layer primitives (background zones) draw behind series
    const prc = this._primitiveContext(ctx);
    for (const p of this._primitives) if (p.zOrder() === 'bottom') p.draw(g, prc);

    // series (registry-driven — the core never switches on type)
    const range = ctx.timeScale.visibleRange();
    const priceToY = (p: number): number => this.priceScale.priceToY(p);
    let lastClose: number | null = null;
    let lastUp = true;
    const groupSize = ctx.conflate
      ? conflationGroupSize(ctx.timeScale.barSpacing, dpr, 0.5, ctx.conflationFactor)
      : 1;
    for (const s of this._series) {
      const entry = getChartType(s.type);
      const visible = ctx.dataLayer.visibleBars(s.dataId, range.from, range.to);
      let items: DrawItem[] = visible.map((ib) => ({ x: ctx.timeScale.indexToX(ib.index), bar: ib.bar }));
      if (groupSize > 1) items = conflateItems(items, groupSize);
      let maxVolume = 0;
      for (const it of items) if ((it.bar.volume ?? 0) > maxVolume) maxVolume = it.bar.volume ?? 0;
      const rc: SeriesRenderContext = { plotHeight: layout.plotHeight, maxVolume, theme: ctx.theme };
      entry.draw(g, items, priceToY, ctx.timeScale.barSpacing, dpr, s.style, rc);
      if (entry.isPriceSeries) {
        const last = ctx.dataLayer.lastIndexedBar(s.dataId);
        if (last !== null) {
          lastClose = last.bar.close;
          lastUp = last.bar.close >= last.bar.open;
        }
      }
    }

    // normal-layer primitives (price lines, markers, events) draw over series
    for (const p of this._primitives) if (p.zOrder() === 'normal') p.draw(g, prc);

    // axes
    drawPriceAxis(g, this.priceScale, layout, dpr, axisStyle);
    if (lastClose !== null) {
      drawLastPriceLabel(g, this.priceScale, lastClose, lastUp, layout, dpr, axisStyle, {
        up: ctx.theme.lastPriceUp, down: ctx.theme.lastPriceDown, text: ctx.theme.lastPriceText,
      });
    }
    if (ctx.showTimeAxis) {
      drawTimeAxis(g, ctx.timeScale, ctx.dataLayer, layout, dpr, axisStyle);
    }
  }

  /**
   * Top (overlay) canvas: top-layer primitives + crosshair. Cheap repaint on
   * cursor moves. `cross.x` is the shared plot x (vertical line, drawn in every
   * pane for a global crosshair); `cross.yLocal` is the price-line y for the
   * hovered pane only (null elsewhere); `cross.showTimeTag` draws the date tag
   * on the bottom pane's axis strip.
   */
  public paintTop(
    cross: { x: number; yLocal: number | null; showTimeTag: boolean } | null,
    ctx: PaneRenderContext,
  ): void {
    this.top.clearBitmap();
    const prc = this._primitiveContext(ctx);
    for (const p of this._primitives) if (p.zOrder() === 'top') p.draw(this.top.ctx, prc);
    if (cross === null) return;

    const layout = this._layout(ctx);
    const g = this.top.ctx;
    const dpr = ctx.dpr;
    drawCrosshair(g, cross.x, cross.yLocal, layout.plotWidth, layout.plotHeight, dpr, ctx.theme.crosshair);

    // price tag on the right axis (hovered pane only)
    if (cross.yLocal !== null) {
      const price = this.priceScale.yToPrice(cross.yLocal);
      drawCrosshairTag(g, this.priceScale.format(price), layout.plotWidth * dpr, cross.yLocal * dpr, dpr,
        ctx.theme.crosshair, ctx.theme.lastPriceText, 'right');
    }
    // date/time tag on the bottom pane's axis strip
    if (cross.showTimeTag && cross.x >= 0 && cross.x <= layout.plotWidth) {
      const idx = Math.round(ctx.timeScale.xToIndex(cross.x));
      const t = ctx.dataLayer.indexToTime(idx);
      if (t !== undefined) {
        drawCrosshairTag(g, formatIstCrosshairLabel(t), cross.x * dpr, layout.plotHeight * dpr, dpr,
          ctx.theme.crosshair, ctx.theme.lastPriceText, 'bottom');
      }
    }
  }

  /** Price at a media-px y on this pane (for crosshair magnet). */
  public yToPrice(y: number): number {
    return this.priceScale.yToPrice(y);
  }
}
