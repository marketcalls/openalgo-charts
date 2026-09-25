/**
 * A `DrawingLayer` renders the drawings of one pane and answers the chart's
 * hit-test. Anchors live in `{ time, price }`, so the layer maps them through
 * the *fractional* index helpers: the gapless axis means an anchor can sit
 * between bars (inside a collapsed weekend) or past the last one (a forward
 * projection), and whole-index lookups have nothing to return there.
 *
 * Each pane carries **two** layers, one at z-order `bottom` for drawings with a
 * negative `zIndex` (under the series) and one at `top` for the rest. The top
 * one takes over handles and hit-testing for the pair through `setBelow`, so a
 * shape parked under the candles still shows its grab handles above them and
 * a click lands on whatever the eye sees on top.
 *
 * Hit ids are `draw:<id>` for the body and `draw:<id>#<n>` for anchor `n`, so
 * the controller can tell "move the whole shape" from "move this handle".
 *
 * A viewport drawing (`space: 'viewport'`) skips the time and price mapping:
 * its anchors are fractions of this pane's plot and scale by the plot size in
 * the render context, which is all that pan and zoom never touch. Everything
 * after the projection (paint, handles, hit-testing) is shared, so the two
 * spaces cannot drift apart in how they are grabbed.
 *
 * The hover ring, the magnet ring and the hover handles are all overlay
 * state: they change on every pointer move, so they must only ever cost the
 * top canvas. The layer that paints them is the one whose `requestUpdate`
 * the chart maps to the cursor tier, which is why the bottom layer of a pair
 * stores that state and asks for nothing.
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from 'openalgo-charts';
import type { Drawing, DrawingPoint, ScreenPoint } from './types';
import { getDrawingTool, hasDrawingTool } from './tools';
import { withDrawingTextMetrics } from './text-metrics';
import { anchorCount, viewportToPlot } from './viewport';

/** Grab radius for a shape, in media px. */
const GRAB = 6;
/** Anchor handle radius, in media px. */
const HANDLE = 5;
/** Radius of the magnet ring, in media px. */
const SNAP_RING = 5.5;
/**
 * A fingertip covers far more than a mouse pointer, and it hides what it
 * touches. Doubling the targets is what keeps a handle grabbable on a phone
 * without a visible change on a desktop.
 */
const TOUCH_SCALE = 2;

/** Which side of the series a layer paints on. */
export type DrawingLayerOrder = 'bottom' | 'top';

/** The pointer kinds the layer sizes its targets for. */
export type DrawingPointerKind = 'mouse' | 'touch' | 'pen';

/** A `zIndex` a host forgot, or corrupted, paints with the series band. */
const zOf = (d: Drawing): number => (Number.isFinite(d.zIndex) ? d.zIndex : 0);

/** Read-only to the user (`policy.editable` false): selectable, never grabbed. */
const readOnly = (d: Drawing): boolean => d.policy?.editable === false;

/**
 * Whether the layer can run this drawing's tool at all. A viewport drawing
 * whose tool never declared viewport support (a plugin tool, a hand-edited
 * save) would hand the tool an empty `drawing.points` it may index into, so
 * it is kept in the model and left unpainted and unhittable instead.
 */
function runnable(d: Drawing): boolean {
  return hasDrawingTool(d.tool) && (d.space !== 'viewport' || getDrawingTool(d.tool).viewport === true);
}

/**
 * A drawing's anchors in plot-relative media px: time and price through the
 * pane's scales, or viewport fractions through the plot size.
 */
export function projectAnchors(rc: PrimitiveRenderContext, d: Drawing): ScreenPoint[] {
  if (d.space === 'viewport') return viewportToPlot(d.viewportPoints ?? [], rc.plotWidth, rc.plotHeight);
  return d.points.map((p) => ({
    x: rc.timeScale.indexToX(rc.dataLayer.timeToIndexFloat(p.time)),
    y: rc.priceScale.priceToY(p.price),
  }));
}

/**
 * Paint order: by `zIndex`, ties by array position. `Array.prototype.sort` is
 * stable, which is what makes the tie rule hold without a second key.
 */
export function sortByZIndex(drawings: readonly Drawing[]): Drawing[] {
  return drawings.slice().sort((a, b) => zOf(a) - zOf(b));
}

/**
 * Which anchors get a grab handle. A freehand stroke carries one anchor per
 * sample, so handling all of them buries the ink under dozens of circles and
 * makes the shape itself impossible to grab: only the two ends mean anything,
 * which is what a brush shows elsewhere.
 */
function handleIndices(toolId: string, count: number): number[] {
  if (hasDrawingTool(toolId) && getDrawingTool(toolId).freehand === true && count > 2) {
    return [0, count - 1];
  }
  return Array.from({ length: count }, (_, i) => i);
}

export class DrawingLayer implements IPrimitive {
  private readonly _order: DrawingLayerOrder;
  /** In paint order. */
  private _drawings: Drawing[] = [];
  private _host: PrimitiveHost | null = null;
  private _selected: string[] = [];
  /** The drawing under the pointer, whether or not it is selected. */
  private _hovered: string | null = null;
  /** Where the next click will land while the magnet is pulling it. */
  private _snap: DrawingPoint | null = null;
  /** Anchors of the in-progress drawing, plus the live cursor point. */
  private _preview: Drawing | null = null;
  /** The layer under this one, whose handles and hits this layer answers for. */
  private _below: DrawingLayer | null = null;
  /** The layer that has taken over this one's handles and hit-testing. */
  private _above: DrawingLayer | null = null;
  /** Sizes grab targets for the device last seen. */
  private _touch = false;

  public constructor(order: DrawingLayerOrder = 'top') {
    this._order = order;
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return this._order; }
  /** Drawings overlay the price range; they never drive it. */
  public autoscaleInfo(): null { return null; }

  public setDrawings(drawings: readonly Drawing[]): void {
    this._drawings = sortByZIndex(drawings);
    this._host?.requestUpdate();
  }

  public setSelected(ids: readonly string[]): void {
    if (ids.length === this._selected.length && ids.every((id, i) => id === this._selected[i])) return;
    this._selected = ids.slice();
    this._host?.requestUpdate();
  }

  /**
   * The drawing under the pointer. Its handles paint at a lighter weight than
   * a selection's, as the hint that it can be grabbed. Repaints only from the
   * layer that paints handles: the adopted bottom layer keeps the id for its
   * own bookkeeping and asks for nothing, since its repaint costs the series.
   */
  public setHovered(id: string | null): void {
    if (id === this._hovered) return;
    this._hovered = id;
    this._requestOverlay();
  }

  public hovered(): string | null {
    return this._hovered;
  }

  /**
   * The point the magnet will snap the next click to, or null when it is not
   * pulling. Painted as a hollow ring so the user sees the anchor land before
   * committing to it.
   */
  public setSnapPoint(point: DrawingPoint | null): void {
    if (point === null ? this._snap === null : this._snap !== null && this._snap.time === point.time && this._snap.price === point.price) return;
    this._snap = point === null ? null : { time: point.time, price: point.price };
    this._requestOverlay();
  }

  public snapPoint(): DrawingPoint | null {
    return this._snap;
  }

  /**
   * Size the grab targets for the device in use. Touch doubles the radii; a
   * mouse or a pen keeps the desktop sizes. The render context may carry the
   * same fact (`pointerType`), and when it does that wins per call, so a
   * first touch on a fresh chart is already sized right.
   */
  public setPointerType(kind: DrawingPointerKind | null | undefined): void {
    this._touch = kind === 'touch';
  }

  public setPreview(drawing: Drawing | null): void {
    this._preview = drawing;
    this._host?.requestUpdate();
  }

  /**
   * Adopt the layer under this one. From then on this layer paints the handles
   * of both and answers `hitTest` for both, and the adopted layer paints bodies
   * only. Handles have to live up here: a selected drawing under the series
   * would otherwise have its handles buried under the candles, and a handle
   * you cannot see is a handle you cannot grab. Pass null to release.
   */
  public setBelow(layer: DrawingLayer | null): void {
    if (this._below === layer) return;
    if (this._below !== null) this._below._above = null;
    this._below = layer;
    if (layer !== null) {
      if (layer._above !== null && layer._above !== this) layer._above._below = null;
      layer._above = this;
      layer._host?.requestUpdate();
    }
    this._host?.requestUpdate();
  }

  /** Repaint for overlay-only state, from the layer that paints it. */
  private _requestOverlay(): void {
    if (this._above !== null) return;
    this._host?.requestUpdate();
  }

  /** Whether targets are sized for a fingertip on this call. */
  private _isTouch(rc: PrimitiveRenderContext): boolean {
    const kind = (rc as { pointerType?: unknown }).pointerType;
    if (kind === 'touch') return true;
    if (kind === 'mouse' || kind === 'pen') return false;
    return this._touch;
  }

  private _grabRadius(rc: PrimitiveRenderContext): number {
    return this._isTouch(rc) ? GRAB * TOUCH_SCALE : GRAB;
  }

  private _handleRadius(rc: PrimitiveRenderContext): number {
    return this._isTouch(rc) ? HANDLE * TOUCH_SCALE : HANDLE;
  }

  /** Map an anchor to media px on this pane. */
  private _project(rc: PrimitiveRenderContext, time: number, price: number): ScreenPoint {
    return {
      x: rc.timeScale.indexToX(rc.dataLayer.timeToIndexFloat(time)),
      y: rc.priceScale.priceToY(price),
    };
  }

  private _points(rc: PrimitiveRenderContext, d: Drawing): ScreenPoint[] {
    return projectAnchors(rc, d);
  }

  /** Selected, unlocked drawings of this layer, in paint order. */
  private _handled(): Drawing[] {
    if (this._selected.length === 0) return [];
    const sel = new Set(this._selected);
    return this._drawings.filter((d) => sel.has(d.id) && d.locked !== true && d.visible !== false && runnable(d));
  }

  /**
   * The hovered drawing of this layer, when it is one that could be grabbed
   * and is not already showing selection handles.
   */
  private _hoverHandled(): Drawing | null {
    const id = this._hovered;
    if (id === null || this._selected.includes(id)) return null;
    const d = this._drawings.find((x) => x.id === id);
    return d === undefined || d.locked === true || d.visible === false || readOnly(d) || !runnable(d) ? null : d;
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    // Top primitives share a canvas with axis labels and cannot rely on the
    // series clip. Keep drawing bodies, previews and handles inside this pane.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, Math.round(rc.plotWidth * rc.dpr), Math.round(rc.plotHeight * rc.dpr));
    ctx.clip();
    try { withDrawingTextMetrics(ctx, () => this._drawContent(ctx, this._drawingContext(rc))); } finally { ctx.restore(); }
  }

  private _drawingContext(rc: PrimitiveRenderContext): PrimitiveRenderContext {
    // Drawing input uses the chart's primary price readout. Rendering and hit
    // testing must use that same scale after a host moves it to the left axis.
    return rc.readoutPriceScale ? { ...rc, priceScale: rc.readoutPriceScale } : rc;
  }

  private _drawContent(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const selected = new Set(this._selected);
    const all = this._preview === null ? this._drawings : [...this._drawings, this._preview];
    for (const d of all) {
      if (d.visible === false || !runnable(d)) continue;
      const tool = getDrawingTool(d.tool);
      const media = this._points(rc, d);
      if (media.length === 0 || !media.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
      if (anchorCount(d) < Math.max(1, tool.points)) {
        // A multi-point tool cannot paint its final geometry yet. Keep the
        // chosen anchors visible so each click has immediate feedback.
        if (d === this._preview) this._drawPlacementGuide(ctx, rc, media, d);
        continue;
      }

      const style = {
        color: d.style.color ?? rc.theme.lineColor,
        lineWidth: d.style.lineWidth ?? 1.5,
        ...d.style,
      };
      const dpr = rc.dpr;
      ctx.save();
      if (d === this._preview) ctx.globalAlpha = 0.7;
      tool.draw({
        ctx, rc, drawing: d, selected: selected.has(d.id),
        pts: media.map((p) => ({ x: p.x * dpr, y: p.y * dpr })),
        style: { ...style, color: style.color, lineWidth: style.lineWidth },
        formatPrice: (v) => rc.priceScale.format(v),
      });
      ctx.restore();
    }

    // Handles go on after every body so they are never painted over by a
    // later shape, and only the top layer of a pair paints them at all.
    if (this._above !== null) return;
    const hovered = [this._hoverHandled(), this._below?._hoverHandled() ?? null];
    for (const d of hovered) {
      if (d !== null) this._drawHandles(ctx, rc, this._points(rc, d), d.tool, true);
    }
    // A selected read-only drawing shows its anchors at the hover weight: the
    // selection is visible, and nothing claims it can be grabbed.
    for (const d of this._handled()) this._drawHandles(ctx, rc, this._points(rc, d), d.tool, readOnly(d));
    if (this._below !== null) {
      for (const d of this._below._handled()) this._drawHandles(ctx, rc, this._points(rc, d), d.tool, readOnly(d));
    }
    if (this._snap !== null) this._drawSnapRing(ctx, rc, this._project(rc, this._snap.time, this._snap.price));
  }

  private _drawPlacementGuide(
    ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, points: readonly ScreenPoint[], drawing: Drawing,
  ): void {
    const dpr = rc.dpr;
    ctx.save();
    ctx.globalAlpha *= 0.7;
    ctx.strokeStyle = drawing.style.color ?? rc.theme.lineColor;
    ctx.lineWidth = Math.max(1, (drawing.style.lineWidth ?? 1.5) * dpr);
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(points[0].x * dpr, points[0].y * dpr);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x * dpr, points[i].y * dpr);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x * dpr, point.y * dpr, 3 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = rc.theme.background;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Anchor handles. A hover shows them light (thin, translucent) as a hint
   * that the shape can be grabbed; a selection shows them at full weight.
   */
  private _drawHandles(
    ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, pts: readonly ScreenPoint[], toolId: string, light: boolean,
  ): void {
    const dpr = rc.dpr;
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = Math.max(1, Math.round((light ? 1 : 1.5) * dpr));
    if (light) ctx.globalAlpha = 0.6;
    for (const i of handleIndices(toolId, pts.length)) {
      const p = pts[i];
      ctx.beginPath();
      ctx.arc(p.x * dpr, p.y * dpr, HANDLE * dpr, 0, Math.PI * 2);
      ctx.fillStyle = rc.theme.background;
      ctx.fill();
      ctx.strokeStyle = rc.theme.lineColor;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The magnet ring: hollow, in the axis text colour, at the snap point. */
  private _drawSnapRing(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, p: ScreenPoint): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    const dpr = rc.dpr;
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
    ctx.strokeStyle = rc.theme.axisText;
    ctx.beginPath();
    ctx.arc(p.x * dpr, p.y * dpr, SNAP_RING * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  public hitTest(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null {
    rc = this._drawingContext(rc);
    // The layer above answers for this one, so two answers never compete.
    if (this._above !== null) return null;

    // Handles of every selected drawing win: they sit on top of their own body
    // and grabbing an anchor must beat dragging the whole shape.
    const handle = this._hitHandle(x, y, rc) ?? this._below?._hitHandle(x, y, rc) ?? null;
    if (handle !== null) return handle;

    // Bodies on this layer beat anything under the series, whatever the
    // distance: what is painted on top is what the eye expects to grab.
    return this._hitBody(x, y, rc) ?? this._below?._hitBody(x, y, rc) ?? null;
  }

  private _hitHandle(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null {
    const radius = this._handleRadius(rc) + 2;
    for (const sel of this._handled()) {
      if (readOnly(sel)) continue;
      const pts = this._points(rc, sel);
      for (const i of handleIndices(sel.tool, pts.length)) {
        if (Math.hypot(x - pts[i].x, y - pts[i].y) <= radius) {
          return {
            externalId: `draw:${sel.id}#${i}`,
            zOrder: 'top', distance: 0, cursor: 'grabbing', draggable: true,
          };
        }
      }
    }
    return null;
  }

  private _hitBody(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null {
    const grab = this._grabRadius(rc);
    let best: { d: Drawing; distance: number } | null = null;
    // Reverse paint order, so the shape painted last wins a tie.
    for (let i = this._drawings.length - 1; i >= 0; i--) {
      const d = this._drawings[i];
      // An unselectable drawing is not there to the pointer: the click goes
      // through to whatever lies under it.
      if (d.visible === false || d.locked === true || d.policy?.selectable === false || !runnable(d)) continue;
      const tool = getDrawingTool(d.tool);
      if (anchorCount(d) < Math.max(1, tool.points)) continue;
      const dist = tool.distance(x, y, { pts: this._points(rc, d), drawing: d, rc });
      // A non-finite distance must miss, not hit: `NaN > GRAB` is false, so a
      // drawing with an unmappable anchor would otherwise swallow every click
      // on the pane.
      if (dist === null || !Number.isFinite(dist) || dist > grab) continue;
      if (best === null || dist < best.distance) best = { d, distance: dist };
      // No lower shape can beat zero; reverse paint order already wins its tie.
      if (dist === 0) break;
    }
    if (best === null) return null;
    // A read-only body selects on a click, and a press-drag on it pans the
    // chart as it would on empty space, rather than arming a drag that the
    // controller would refuse and leaving the chart frozen under the hand.
    const fixed = readOnly(best.d);
    return {
      externalId: `draw:${best.d.id}`,
      zOrder: 'top', distance: best.distance, cursor: fixed ? 'pointer' : 'move', draggable: !fixed,
    };
  }
}
