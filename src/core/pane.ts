/**
 * A pane is one vertically-stacked drawing region (price pane, volume pane,
 * indicator pane). It owns a base + top canvas (ARCHITECTURE.md §3.1) and a
 * price scale, and renders its series against the shared time scale + DataLayer.
 */
import { CanvasLayer } from './canvas';
import { PriceScale } from '../scale/price-scale';
import { type TimeScale } from '../scale/time-scale';
import { type DataLayer } from '../model/data-layer';
import type { SeriesRecord, PriceScaleId } from '../model/series';
import { computeGridLines, drawGrid, resolveGridStyle, resolveScaleStyle, type CanvasOptions } from '../render/grid';
import { getChartType, type DrawItem, type SeriesRenderContext } from '../model/chart-type-registry';
import type { SeriesStyle } from '../render/series-style';
import { conflationGroupSize, conflateItems } from '../model/conflation';
import {
  drawPriceAxis, drawLeftPriceAxis, drawTimeAxis, drawLastPriceLabel, drawSessionClock,
  drawTimeAxisPill, lastPriceTagHeight, AXIS_LABEL_PRIORITY, resolveAxisLabels, drawSeriesValueTag,
  type PlotLayout, type TickMarkType, type AxisLabelBand,
  type SessionClockOptions, type BarCountdownOptions,
} from '../render/axis';
import { drawCrosshair, drawCrosshairTag, resolveCrosshairStyle } from '../render/crosshair';
import { bestHit, type IPrimitive, type PrimitiveHit, type PrimitiveHost, type PrimitiveRenderContext } from '../primitives/primitive';
import type { ChartTheme } from '../theme';
import { DEFAULT_TIMEZONE, formatZonedCrosshairLabel } from '../feed/time';

export interface PaneRenderContext {
  timeScale: TimeScale;
  dataLayer: DataLayer;
  dpr: number;
  priceAxisWidth: number;
  /** Left inset (px) reserved chart-wide for a left price axis; 0/absent when none. */
  leftAxisWidth?: number;
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
  /**
   * The settings dialog's Canvas block (grid, crosshair, scales, margins).
   * Named `canvasOptions` rather than `canvas` so it is never mistaken for the
   * canvas element. Every field is an override: unset falls back to the theme.
   */
  canvasOptions?: CanvasOptions;
  /** Optional custom time label formatter (UTC seconds -> string). Defaults to IST. */
  timeFormatter?: (utcSeconds: number, tickMark?: TickMarkType) => string;
  /**
   * IANA zone the time axis and crosshair label in. Absent means the shipped
   * default ('Asia/Kolkata'); an explicit `timeFormatter` outranks it, because a
   * host that formats its own labels has already decided the question.
   */
  timezone?: string;
  /**
   * The corner clock between the two axis strips. Absent draws nothing, which
   * is the shipped chart: it is chrome a host asks for.
   */
  sessionClock?: SessionClockOptions;
  /**
   * The countdown row inside the last-price tag. Absent leaves the tag the one
   * line it has always been.
   */
  barCountdown?: BarCountdownOptions;
  /** externalId of the primitive under the pointer (hover visual state). */
  hoverId?: string | null;
  /** externalId of the line currently being dragged (active visual state). */
  dragId?: string | null;
  /**
   * Fill the pane with the theme background before anything else. Absent means
   * yes, which is every on-screen frame; the vector export turns it off for a
   * document that is meant to sit on the host's own page.
   */
  paintBackground?: boolean;
}

/**
 * The one colour that stands for a series, for a tag that is too small to carry
 * more than one. Line-family series say it outright; a candle or bar family says
 * it per direction, so the current bar picks the side.
 *
 * Undefined means the series has no colour of its own to borrow, and no tag is
 * worth inventing one for.
 */
function seriesTagColor(style: SeriesStyle, up: boolean): string | undefined {
  if (typeof style.color === 'string') return style.color;
  const directional = up ? style.upColor : style.downColor;
  if (typeof directional === 'string') return directional;
  if (typeof style.closeColor === 'string') return style.closeColor;
  return undefined;
}

export class Pane {
  public readonly element: HTMLElement;
  public readonly base: CanvasLayer;
  public readonly top: CanvasLayer;
  private _rightScale = new PriceScale();
  /** Extra scales created on demand: left axis and a hidden overlay (volume). */
  private _leftScale: PriceScale | null = null;
  private _overlayScale: PriceScale | null = null;
  /**
   * Scales whose price-per-bar ratio is pinned, with the geometry the ratio was
   * last held against. A lock stores that geometry rather than a number,
   * because the ratio lives in the scale's *transformed* span (log prices are
   * not linear in price) and only the scale itself can measure that. Every
   * later change in bar spacing or pane height is answered by the opposite
   * change in the visible span, which needs no such measurement.
   */
  private readonly _ratioLocks = new Map<PriceScaleId, { barSpacing: number; height: number }>();
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
    // The rule between stacked panes. A CSS border rather than a canvas line:
    // it lands on the DOM box boundary, so it cannot drift from the pane it
    // separates when weights change, and costs nothing to repaint.
    this.element.style.borderTopStyle = 'solid';
    this.element.style.borderTopWidth = '0px';
    this.element.style.boxSizing = 'border-box';
    this.base = new CanvasLayer(doc, 0);
    this.top = new CanvasLayer(doc, 1);
    this.element.appendChild(this.base.element);
    this.element.appendChild(this.top.element);
  }

  /**
   * The 'right' scale: the pane's primary axis, and the one a series maps to
   * unless it names another. A getter over a field rather than a plain readonly
   * property because `moveSeriesScale` swaps the two side scales, and the range,
   * mode, margins, tick size and formatter all belong to the axis being moved.
   */
  public get priceScale(): PriceScale {
    return this._rightScale;
  }

  public addSeries(record: SeriesRecord): void {
    this._scaleFor(record.scaleId); // create the target scale if needed
    this._series.push(record);
  }

  /** The PriceScale for a scale id, creating the left/overlay scale on first use. */
  private _scaleFor(id: PriceScaleId): PriceScale {
    if (id === 'left') return (this._leftScale ??= new PriceScale());
    if (id === '') return (this._overlayScale ??= new PriceScale());
    return this._rightScale;
  }

  /**
   * The scale for an id, created if this pane has never used it. A host acting
   * on one axis (a price-axis menu) needs the scale a side *would* use, not
   * only the ones series happen to occupy; an empty scale draws nothing,
   * because both the axis strip and the left column are gated on a scale
   * having been measured.
   */
  public scaleFor(id: PriceScaleId): PriceScale {
    return this._scaleFor(id);
  }

  /** True when some series on this pane maps to the named scale. */
  public usesScale(id: PriceScaleId): boolean {
    return this._series.some((s) => s.scaleId === id);
  }

  /**
   * Move every series on one side's scale to the other side, axis and all.
   *
   * The two scale objects are swapped rather than their state copied across:
   * the range, mode, margins, tick size and any custom formatter are all
   * properties of the axis being moved, and copying would have to enumerate
   * every one of them (and gain a field each time one is added). What is left
   * behind carries nothing, so it is reset: keeping its range would label the
   * vacated strip with a ladder for prices that are no longer on that side.
   *
   * Refuses when the target side already carries series. One side draws one
   * axis, so a move onto an occupied side could only mean stacking two ladders
   * in one strip or silently sending the sitting tenant the other way, and
   * neither is what "move this axis to the left" asks for.
   */
  public moveSeriesScale(from: 'right' | 'left', to: 'right' | 'left'): boolean {
    if (from === to || !this.usesScale(from) || this.usesScale(to)) return false;
    const moving = this._scaleFor(from);
    const vacated = this._scaleFor(to);
    if (to === 'left') {
      this._leftScale = moving;
      this._rightScale = vacated;
    } else {
      this._rightScale = moving;
      this._leftScale = vacated;
    }
    for (const s of this._series) if (s.scaleId === from) s.scaleId = to;
    // `reset` declines to throw away a range a user set by hand, which is right
    // everywhere else and wrong here: there is no series left to re-measure it.
    // A declared band goes first, or the strip would keep the range and the
    // auto-fit refusal that came with the series that just left it.
    vacated.setFixedRange(null);
    vacated.setAutoScale(true);
    vacated.reset();
    const lock = this._ratioLocks.get(from);
    if (lock !== undefined) {
      this._ratioLocks.delete(from);
      this._ratioLocks.set(to, lock);
    }
    return true;
  }

  /** Whether this scale's price-per-bar ratio is currently pinned. */
  public ratioLocked(id: PriceScaleId): boolean {
    return this._ratioLocks.has(id);
  }

  /**
   * Pin (or release) the price-per-bar ratio of one scale, against the geometry
   * in force right now. A locked scale is manual by definition: autoscaling it
   * would re-fit the data every frame and undo the ratio being held.
   *
   * Locking a scale nothing has measured does nothing: there is no ratio to
   * hold yet, and switching it to manual would strand it on the 0..1
   * placeholder with nothing left to measure it. Returns whether the scale
   * ended up in the state asked for; releasing always succeeds.
   */
  public setRatioLock(id: PriceScaleId, on: boolean, barSpacing: number, plotHeight: number): boolean {
    if (!on) {
      this._ratioLocks.delete(id);
      return true;
    }
    const scale = this._scaleFor(id);
    if (!scale.scaled || !(barSpacing > 0) || !(plotHeight > 0)) return false;
    scale.setAutoScale(false);
    this._ratioLocks.set(id, { barSpacing, height: plotHeight });
    return true;
  }

  /** Release every ratio lock on this pane (resetting the view drops them). */
  public clearRatioLocks(): void {
    this._ratioLocks.clear();
  }

  /** The price scale a series maps to (for the series handle's `priceScale()`). */
  public scaleOf(record: SeriesRecord): PriceScale {
    return this._scaleFor(record.scaleId);
  }

  /**
   * Every scale this pane has actually created. The left and overlay scales are
   * built on demand, so a caller applying a pane-wide setting (plot margins,
   * label precision) needs the live set rather than all three ids.
   */
  public scales(): PriceScale[] {
    const out: PriceScale[] = [this.priceScale];
    if (this._leftScale !== null) out.push(this._leftScale);
    if (this._overlayScale !== null) out.push(this._overlayScale);
    return out;
  }

  /**
   * The scales that draw a ladder: the right one and, once something uses it,
   * the left. The hidden overlay scale is deliberately not here.
   *
   * That scale is positioned by whoever created it and by nobody else. A volume
   * histogram sitting in the bottom fifth of the price pane is an overlay with
   * `marginTop: 0.82`, and a chart-wide plot-margin change that swept it up
   * with the visible axes replaced that 0.82 with the dialog's number: the bars
   * grew to fill most of the pane, and putting the dialog back where it started
   * wrote 0.1, not the 0.82 nobody had recorded. Destructive and unrecoverable,
   * from a control that only claims to move the plot inside its own axes.
   */
  public axisScales(): PriceScale[] {
    const out: PriceScale[] = [this.priceScale];
    if (this._leftScale !== null) out.push(this._leftScale);
    return out;
  }

  /** True when a left-axis scale is active (some series maps to it). */
  public hasLeftScale(): boolean {
    return this._leftScale !== null && this._series.some((s) => s.scaleId === 'left');
  }

  /** Remove a series record if present; returns true if it was found. */
  public removeSeries(record: SeriesRecord): boolean {
    const i = this._series.indexOf(record);
    if (i < 0) return false;
    this._series.splice(i, 1);
    // A scale with nothing left on it keeps describing what just left, and a
    // pane is reused when one indicator replaces another. Forget the range so
    // the next occupant is measured on its own terms, or not labelled at all.
    if (!this._series.some((s) => s.scaleId === record.scaleId)) {
      this._scaleFor(record.scaleId).reset();
    }
    return true;
  }

  public series(): readonly SeriesRecord[] {
    return this._series;
  }

  /** Primitives attached to this pane, in draw order. */
  public primitives(): readonly IPrimitive[] {
    return this._primitives;
  }

  public addPrimitive(primitive: IPrimitive, host: PrimitiveHost): void {
    this._primitives.push(primitive);
    primitive.attached?.(host);
  }

  /** Whether this pane currently holds `primitive`. */
  public hasPrimitive(primitive: IPrimitive): boolean {
    return this._primitives.includes(primitive);
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
      hoverId: ctx.hoverId ?? null,
      dragId: ctx.dragId ?? null,
      bars: () => {
        for (const s of this._series) {
          if (getChartType(s.type).isPriceSeries) return ctx.dataLayer.seriesBars(s.dataId);
        }
        return [];
      },
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

  /**
   * Lay the pane out at a size without touching its canvases. The vector
   * export paints at a size of the caller's choosing and then puts the live
   * size back; resizing a canvas clears it, so going through `resize` would
   * blank the screen until the next frame.
   */
  public setLayoutSize(width: number, height: number): void {
    this._width = width;
    this._height = height;
  }

  /**
   * Give every scale on this pane its plot height. Height is a *layout*
   * property, but it used to be set only inside the autoscale pass — so any
   * y↔price conversion before the first paint divided by zero and returned
   * ±Infinity. Layout is when the height is actually known.
   */
  public setScaleHeights(plotHeight: number): void {
    this.priceScale.setHeight(plotHeight);
    this._leftScale?.setHeight(plotHeight);
    this._overlayScale?.setHeight(plotHeight);
  }

  private _layout(ctx: PaneRenderContext): PlotLayout {
    const plotLeft = ctx.leftAxisWidth ?? 0;
    return {
      plotWidth: Math.max(0, this._width - ctx.priceAxisWidth - plotLeft),
      plotHeight: Math.max(0, this._height - (ctx.showTimeAxis ? ctx.timeAxisHeight : 0)),
      priceAxisWidth: ctx.priceAxisWidth,
      timeAxisHeight: ctx.showTimeAxis ? ctx.timeAxisHeight : 0,
      plotLeft,
    };
  }

  /** Autoscale each active price scale from its own series (independent axes). */
  public autoscale(ctx: PaneRenderContext): void {
    const layout = this._layout(ctx);
    const range = ctx.timeScale.visibleRange();
    // Right scale also expands for primitives (price lines etc.).
    this._autoscaleScale(this.priceScale, (s) => s.scaleId === 'right', true, ctx, layout.plotHeight, range);
    if (this._leftScale) this._autoscaleScale(this._leftScale, (s) => s.scaleId === 'left', false, ctx, layout.plotHeight, range);
    if (this._overlayScale) this._autoscaleScale(this._overlayScale, (s) => s.scaleId === '', false, ctx, layout.plotHeight, range);
    // After the measuring pass and before anything reads a range: a locked
    // scale is manual, so nothing above touched it, and the correction has to
    // land before the axis is labelled from it.
    if (this._ratioLocks.size > 0) this._applyRatioLocks(ctx.timeScale.barSpacing, layout.plotHeight);
    // Every scale on the pane now holds a measured range, and nothing has been
    // painted yet. That is the only window in which a primitive can correct a
    // scale and still have the axis drawn from the corrected value.
    for (const p of this._primitives) p.afterAutoscale?.();
  }

  private _autoscaleScale(
    scale: PriceScale,
    match: (s: SeriesRecord) => boolean,
    includePrimitives: boolean,
    ctx: PaneRenderContext,
    plotHeight: number,
    range: { from: number; to: number },
  ): void {
    scale.setHeight(plotHeight);
    // Before the manual-range early-out on purpose: an axis-dragged scale still
    // has to label itself, and the gather loop below never runs for it. Guarded
    // on the mode because visibleBars allocates per series.
    const mode = scale.options.mode;
    if (mode === 'percentage' || mode === 'indexed-to-100') {
      scale.setBaseline(this._firstVisibleValue(match, ctx, range));
    }
    if (!scale.autoScale) return; // manual (axis-dragged) range: leave it
    let low = Infinity;
    let high = -Infinity;
    for (const s of this._series) {
      if (s.style.visible === false || !match(s)) continue;
      const entry = getChartType(s.type);
      for (const ib of ctx.dataLayer.visibleBars(s.dataId, range.from, range.to)) {
        const ext = entry.extents(ib.bar, s.style);
        if (ext.min < low) low = ext.min;
        if (ext.max > high) high = ext.max;
      }
    }
    if (includePrimitives) {
      for (const p of this._primitives) {
        const ext = p.autoscaleInfo?.();
        if (ext) {
          if (ext.min < low) low = ext.min;
          if (ext.max > high) high = ext.max;
        }
      }
    }
    if (low <= high) scale.autoscale(low, high);
  }

  /**
   * Hold every locked scale's price-per-bar ratio against the geometry it is
   * being painted into. A bar is `barSpacing` px wide and the plot is
   * `plotHeight` px tall, so a fixed ratio means the visible price span moves
   * with height / barSpacing: zoom in on time and the same slope needs fewer
   * prices in view to keep drawing at the same angle.
   */
  private _applyRatioLocks(barSpacing: number, plotHeight: number): void {
    if (!(barSpacing > 0) || !(plotHeight > 0)) return;
    for (const [id, ref] of this._ratioLocks) {
      const factor = (plotHeight / barSpacing) / (ref.height / ref.barSpacing);
      // Advance the reference even when the correction is skipped, or a scale
      // that could not take one would keep answering for geometry two zooms old.
      ref.barSpacing = barSpacing;
      ref.height = plotHeight;
      if (!isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-9) continue;
      const scale = this._scaleFor(id);
      if (scale.scaled) this._scaleSpan(scale, factor);
    }
  }

  /**
   * Multiply a scale's visible span by `factor` around the middle of the pane,
   * in the scale's own transformed space so a log axis scales by decades rather
   * than by price. Reading the endpoints back through `yToPrice` is what keeps
   * this transform-agnostic: y is linear in transformed space by construction,
   * whichever mode the scale is in.
   */
  private _scaleSpan(scale: PriceScale, factor: number): void {
    const h = scale.height;
    if (!(h > 0)) return;
    const half = (h / 2) * factor;
    const a = scale.yToPrice(h / 2 - half);
    const b = scale.yToPrice(h / 2 + half);
    if (!isFinite(a) || !isFinite(b) || a === b) return;
    scale.setPriceRange({ min: Math.min(a, b), max: Math.max(a, b) });
  }

  /** Close of the first visible bar on this scale: the rebasing modes quote against it. */
  private _firstVisibleValue(
    match: (s: SeriesRecord) => boolean,
    ctx: PaneRenderContext,
    range: { from: number; to: number },
  ): number | null {
    for (const s of this._series) {
      if (s.style.visible === false || !match(s)) continue;
      for (const ib of ctx.dataLayer.visibleBars(s.dataId, range.from, range.to)) {
        if (isFinite(ib.bar.close)) return ib.bar.close; // whitespace bars are NaN
      }
    }
    return null;
  }

  /**
   * Paint background + grid + series + axes on the base canvas, or into
   * `target` when given: the vector export runs this exact pass into a
   * serialising context, so what it produces is the frame and not a
   * re-description of it. Only the pane's own canvas is cleared first; a
   * target starts empty by construction.
   */
  public paintBase(ctx: PaneRenderContext, target?: CanvasRenderingContext2D): void {
    const layout = this._layout(ctx);
    const dpr = ctx.dpr;
    const g = target ?? this.base.ctx;
    if (target === undefined) this.base.clearBitmap();

    const axisStyle = resolveScaleStyle(ctx.theme, ctx.canvasOptions?.scales);

    // background (full pane), skipped when transparent so the page shows through
    if (ctx.paintBackground !== false && ctx.theme.background !== 'transparent') {
      g.fillStyle = ctx.theme.background;
      g.fillRect(0, 0, Math.round(this._width * dpr), Math.round(this._height * dpr));
    }

    // Left price axis strip (absolute coords), drawn before the plot is shifted.
    if (this._leftScale && layout.plotLeft > 0) {
      if (this._leftScale.scaled) {
        drawLeftPriceAxis(g, this._leftScale, layout.plotLeft, layout.plotHeight, dpr, axisStyle);
      }
    }

    // Shift the plot right by the reserved left-axis width (0 = a no-op).
    g.save();
    if (layout.plotLeft > 0) g.translate(Math.round(layout.plotLeft * dpr), 0);

    // Grid within the plot area. Visibility still comes from the render context
    // (setGridOptions is the long-standing switch); colour, dash, width and
    // spacing come from the canvas block, per axis.
    const gridOpts = ctx.canvasOptions?.grid;
    const lines = computeGridLines(layout.plotWidth, layout.plotHeight, {
      ...gridOpts,
      spacing: gridOpts?.spacing ?? 60,
      vertLines: ctx.showVertGrid,
      horzLines: ctx.showHorzGrid,
    });
    if (lines.verticals.length > 0 || lines.horizontals.length > 0) {
      drawGrid(g, lines, layout.plotWidth, layout.plotHeight, dpr, resolveGridStyle(ctx.theme, gridOpts, dpr));
    }

    // Everything that draws *in* the plot is clipped to it.
    //
    // A bar is positioned by its centre and drawn outward, so the newest bar
    // sitting against the right edge paints half a body and a wick past it, into
    // the price-axis strip, where it shows through behind the labels. Scrolling
    // the series under the axis makes it obvious. The axis ladder and the tags
    // are drawn after this block is restored, because they live in that strip on
    // purpose and clipping them would erase them.
    g.save();
    g.beginPath();
    g.rect(0, 0, Math.round(layout.plotWidth * dpr), Math.round(layout.plotHeight * dpr));
    g.clip();

    // bottom-layer primitives (background zones) draw behind series
    const prc = this._primitiveContext(ctx);
    for (const p of this._primitives) if (p.zOrder() === 'bottom') p.draw(g, prc);

    // series (registry-driven — the core never switches on type)
    const range = ctx.timeScale.visibleRange();
    // Last-price line/tag follows the pane's readout series (the main one),
    // whichever side its scale is drawn on.
    const readout = this._readoutScale();
    let lastEntry: { close: number; up: boolean; showLine: boolean; showTag: boolean } | null = null;
    // Every other series on the readout scale that is currently plotting a
    // number: an indicator overlay, a comparison line, a study on its own pane.
    // The main series keeps its dedicated tag above; these are what tells a
    // reader where a Supertrend or a moving average sits without tracing the
    // line back to the edge by eye.
    const valueTags: { price: number; color: string }[] = [];
    const groupSize = ctx.conflate
      ? conflationGroupSize(ctx.timeScale.barSpacing, dpr, 0.5, ctx.conflationFactor)
      : 1;
    for (const s of this._series) {
      if (s.style.visible === false) continue;
      const scale = this._scaleFor(s.scaleId);
      const priceToY = (p: number): number => scale.priceToY(p);
      const entry = getChartType(s.type);
      const visible = ctx.dataLayer.visibleBars(s.dataId, range.from, range.to);
      let items: DrawItem[] = visible.map((ib) => ({ x: ctx.timeScale.indexToX(ib.index), bar: ib.bar }));
      if (groupSize > 1) items = conflateItems(items, groupSize);
      // Previous-close colouring needs the bar left of the visible range to
      // colour the first drawn one; nothing else does, so only that mode pays
      // for the lookup, and only a series with no bar there falls back.
      if (s.style.colorByPreviousClose === true && items.length > 0) {
        const before = ctx.dataLayer.visibleBars(s.dataId, visible[0].index - 1, visible[0].index - 1);
        if (before.length > 0) items[0].prevClose = before[0].bar.close;
      }
      let maxVolume = 0;
      for (const it of items) if ((it.bar.volume ?? 0) > maxVolume) maxVolume = it.bar.volume ?? 0;
      const rc: SeriesRenderContext = { plotHeight: layout.plotHeight, maxVolume, theme: ctx.theme };
      entry.draw(g, items, priceToY, ctx.timeScale.barSpacing, dpr, s.style, rc);
      // Only the readout scale has a strip to write into. A volume overlay
      // sitting on its own hidden scale is excluded by that alone, while a
      // volume study on a pane of its own is on the readout scale and does get
      // a tag, formatted by the same scale as the ladder beside it.
      if (scale === readout) {
        const last = ctx.dataLayer.lastIndexedBar(s.dataId);
        if (last !== null && entry.isPriceSeries && lastEntry === null) {
          // The first price series on the readout scale is the instrument, and
          // it owns the last-price line and the countdown tag.
          lastEntry = {
            close: last.bar.close,
            up: last.bar.close >= last.bar.open,
            showLine: s.style.priceLineVisible !== false,
            showTag: s.style.lastValueVisible !== false,
          };
        } else if (last !== null && s.style.lastValueVisible !== false) {
          // A plot that is currently `na` writes NaN rather than dropping the
          // point, and a tag for it would either be blank or, worse, the stale
          // value from whenever the line last had one. A flipped Supertrend's
          // dormant half shows no tag, which is the honest answer.
          const color = seriesTagColor(s.style, last.bar.close >= last.bar.open);
          if (color !== undefined && Number.isFinite(last.bar.close)) {
            valueTags.push({ price: last.bar.close, color });
          }
        }
      }
    }

    // End of the plot clip. Everything below draws into the axis strip on
    // purpose: the ladder, the last-price tag, the trading pills. Restoring here
    // and not at the end of the frame is the whole point.
    g.restore();

    // axis ticks first, then the last-price line/tag, then trading primitives —
    // order/position pill groups stay legible when the LTP crosses them
    // A scale nothing has measured still holds the placeholder 0..1, and
    // labelling it prints a price ladder the pane has no prices for: an
    // indicator whose whole output is a table or a set of markers plots no
    // values, so its pane came up reading 0.00 to 1.00.
    // The last-price tag lands in the same strip a moment from now, so the tick
    // it will cover is reserved before the ladder is drawn. Without this the tag
    // paints straight over a tick label and the two read as mush, which is the
    // whole reason `resolveAxisLabels` exists.
    //
    // Nothing is reserved when there is no tag, or when it falls outside the
    // plot (where `drawLastPriceLabel` bails), so a pane without one draws every
    // tick exactly as it always has.
    const showLastTag = lastEntry !== null && lastEntry.showTag && readout === this._rightScale;
    // The countdown makes the tag taller, so it must be the same question here
    // and in the call below, or the reservation would be the wrong size.
    const withCountdown = ctx.barCountdown?.visible === true;
    //
    // The series tags are resolved here rather than left to `drawPriceAxis`,
    // which drops the flags of whatever it is handed: it decides which ticks
    // survive a reservation, not which reservations survive each other. Two
    // moving averages a rupee apart are exactly that second question, and the
    // last-price tag outranking both of them is the answer we want.
    const inPlot = (y: number): boolean => y >= 0 && y <= layout.plotHeight * dpr;
    const bands: AxisLabelBand[] = [];
    if (lastEntry !== null && showLastTag) {
      const y = Math.round(readout.priceToY(lastEntry.close) * dpr);
      if (inPlot(y)) {
        bands.push({ y, height: lastPriceTagHeight(dpr, withCountdown), priority: AXIS_LABEL_PRIORITY.lastPrice });
      }
    }
    // Series tags share the right-hand strip, so a scale that has moved to the
    // left has nowhere to put them, the same reason the last-price tag is
    // suppressed there.
    const tagBase = bands.length;
    const showValueTags = readout === this._rightScale;
    if (showValueTags) {
      for (const t of valueTags) {
        const y = Math.round(readout.priceToY(t.price) * dpr);
        bands.push({
          y,
          height: inPlot(y) ? lastPriceTagHeight(dpr) : NaN,
          priority: AXIS_LABEL_PRIORITY.seriesValue,
        });
      }
    }
    // Same gap the ladder is resolved with, so a tag that survives here is not
    // then drawn a pixel from the tick it displaced.
    const allowed = bands.length > 0 ? resolveAxisLabels(bands, 2 * dpr) : [];
    const reserved: AxisLabelBand[] | undefined =
      bands.length > 0 ? bands.filter((_, i) => allowed[i]) : undefined;
    if (this.priceScale.scaled) drawPriceAxis(g, this.priceScale, layout, dpr, axisStyle, reserved);
    if (showValueTags) {
      for (let i = 0; i < valueTags.length; i++) {
        if (!allowed[tagBase + i]) continue;
        drawSeriesValueTag(g, readout, valueTags[i].price, valueTags[i].color, layout, dpr, axisStyle);
      }
    }
    if (lastEntry !== null) {
      // The tag belongs in the right-hand strip, which a scale that has moved
      // to the left no longer has: the line still means something without it,
      // a tag drawn into a column that is not there does not.
      drawLastPriceLabel(g, readout, lastEntry.close, lastEntry.up, layout, dpr, axisStyle, {
        up: ctx.theme.lastPriceUp, down: ctx.theme.lastPriceDown, text: ctx.theme.lastPriceText,
      }, lastEntry.showLine, showLastTag, ctx.barCountdown);
    }

    // normal-layer primitives (price lines, markers, events) draw over series
    for (const p of this._primitives) if (p.zOrder() === 'normal') p.draw(g, prc);

    if (ctx.showTimeAxis) {
      // The zone goes to the axis rather than being pre-baked into a formatter
      // here: the axis is what decides date-versus-clock and what computes the
      // `tickMark` hint, so a host formatter and the default one only agree on
      // where the day turns over if both are decided on the same calendar.
      drawTimeAxis(g, ctx.timeScale, ctx.dataLayer, layout, dpr, axisStyle, ctx.timeFormatter, ctx.timezone);
      // The corner the two strips meet in, which no tick, tag or series ever
      // occupies. Drawn last so it sits over the time axis's own row.
      if (ctx.sessionClock !== undefined) drawSessionClock(g, layout, dpr, ctx.sessionClock, axisStyle);
    }
    g.restore(); // end plot shift
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
    target?: CanvasRenderingContext2D,
  ): void {
    if (target === undefined) this.top.clearBitmap();
    const layout = this._layout(ctx);
    const g = target ?? this.top.ctx;
    const dpr = ctx.dpr;
    // Shift top-layer primitives + crosshair by the reserved left-axis width.
    g.save();
    if (layout.plotLeft > 0) g.translate(Math.round(layout.plotLeft * dpr), 0);
    const prc = this._primitiveContext(ctx);
    for (const p of this._primitives) if (p.zOrder() === 'top') p.draw(g, prc);
    if (cross !== null) {
      const style = resolveCrosshairStyle(ctx.theme, ctx.canvasOptions?.crosshair, dpr);
      drawCrosshair(g, cross.x, cross.yLocal, layout.plotWidth, layout.plotHeight, dpr,
        style.color, style.width, style.dash);

      // An overridden crosshair colour tints its value tags too, the way the
      // reference dialog does; an explicit label background still wins.
      const tagBg = ctx.theme.crosshairLabelBackground ?? style.color;
      const showTags = ctx.theme.crosshairLabelVisible !== false;
      // price tag on the strip this pane's prices are actually labelled in
      // (hovered pane only)
      if (showTags && cross.yLocal !== null) {
        const scale = this._readoutScale();
        const text = scale.format(scale.yToPrice(cross.yLocal));
        const onLeft = scale === this._leftScale && layout.plotLeft > 0;
        // The tag is drawn rightward from the x it is given, so putting one in
        // the left strip means starting a whole tag-width back from the plot.
        const x = onLeft ? -this._tagWidth(g, text, dpr) : layout.plotWidth * dpr;
        drawCrosshairTag(g, text, x, cross.yLocal * dpr, dpr, tagBg, ctx.theme.lastPriceText, 'right');
      }
      // date/time tag on the bottom pane's axis strip (cross.x is plot-relative)
      if (showTags && cross.showTimeTag && cross.x >= 0 && cross.x <= layout.plotWidth) {
        const idx = Math.round(ctx.timeScale.xToIndex(cross.x));
        const t = ctx.dataLayer.indexToTime(idx);
        if (t !== undefined) {
          const label = ctx.timeFormatter
            ? ctx.timeFormatter(t)
            : formatZonedCrosshairLabel(t, ctx.timezone ?? DEFAULT_TIMEZONE);
          // A pill rather than a plain tag: this one lands on the time strip,
          // over tick labels already on the base canvas, so it needs the
          // opaque backplate to cut them out and the rounded, slightly taller
          // box to read as a separate object instead of one more tick label in
          // a different colour. The price tag above has neither problem.
          drawTimeAxisPill(
            g, label, cross.x * dpr, layout.plotHeight * dpr, dpr,
            { background: tagBg, textColor: ctx.theme.lastPriceText, backplate: ctx.theme.background },
            resolveScaleStyle(ctx.theme, ctx.canvasOptions?.scales),
          );
        }
      }
    }
    g.restore();
  }

  /**
   * The scale this pane's price readout belongs to: the one its first visible
   * price series maps to, falling back to the right scale. A pane whose series
   * sit on the left axis has nothing on the right one, and reading the
   * crosshair price off it would tag the cursor with the 0..1 placeholder.
   */
  private _readoutScale(): PriceScale {
    for (const s of this._series) {
      if (s.style.visible === false) continue;
      if (getChartType(s.type).isPriceSeries) return this._scaleFor(s.scaleId);
    }
    return this._rightScale;
  }

  /**
   * The scale a price quoted for this pane belongs to: the crosshair readout,
   * the price on a click or a drag, and the chart's coordinate API all mean
   * this one. It is the right scale in every layout that has not moved an axis.
   */
  public readoutScale(): PriceScale {
    return this._readoutScale();
  }

  /** Media-px y of a price on this pane's readout scale. The inverse of `yToPrice`. */
  public priceToY(price: number): number {
    return this._readoutScale().priceToY(price);
  }

  /**
   * Width of the box `drawCrosshairTag` draws for this text, in bitmap px. The
   * font and padding are restated from it because it measures privately and a
   * left-hand tag has to know its own width before it can be positioned.
   */
  private _tagWidth(g: CanvasRenderingContext2D, text: string, dpr: number): number {
    g.save();
    g.font = `${11 * dpr}px system-ui, sans-serif`;
    const w = g.measureText(text).width + 12 * dpr + 1;
    g.restore();
    return w;
  }

  /** Price at a media-px y on this pane (crosshair magnet, click/drag readout). */
  public yToPrice(y: number): number {
    return this._readoutScale().yToPrice(y);
  }
}
