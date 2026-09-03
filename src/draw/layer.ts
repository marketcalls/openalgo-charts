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
 * The hover ring, the magnet ring and the hover handles are all overlay
 * state: they change on every pointer move, so they must only ever cost the
 * top canvas. The layer that paints them is the one whose `requestUpdate`
 * the chart maps to the cursor tier, which is why the bottom layer of a pair
 * stores that state and asks for nothing.
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from 'openalgo-charts';
import type { Drawing, DrawingPoint, ScreenPoint } from './types';
import { getDrawingTool, hasDrawingTool } from './tools';

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
    return d.points.map((p) => this._project(rc, p.time, p.price));
  }

  /** Selected, unlocked drawings of this layer, in paint order. */
  private _handled(): Drawing[] {
    if (this._selected.length === 0) return [];
    const sel = new Set(this._selected);
    return this._drawings.filter((d) => sel.has(d.id) && d.locked !== true && d.visible !== false);
  }

  /**
   * The hovered drawing of this layer, when it is one that could be grabbed
   * and is not already showing selection handles.
   */
  private _hoverHandled(): Drawing | null {
    const id = this._hovered;
    if (id === null || this._selected.includes(id)) return null;
    const d = this._drawings.find((x) => x.id === id);
    return d === undefined || d.locked === true || d.visible === false ? null : d;
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const selected = new Set(this._selected);
    const all = this._preview === null ? this._drawings : [...this._drawings, this._preview];
    for (const d of all) {
      if (d.visible === false || !hasDrawingTool(d.tool)) continue;
      const tool = getDrawingTool(d.tool);
      if (d.points.length < Math.max(1, tool.points)) continue;
      const media = this._points(rc, d);
      // Skip anything entirely off-pane; a fib grid with a far anchor would
      // otherwise stroke thousands of off-screen px every frame.
      if (!media.some((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;

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
    for (const d of this._handled()) this._drawHandles(ctx, rc, this._points(rc, d), d.tool, false);
    if (this._below !== null) {
      for (const d of this._below._handled()) this._drawHandles(ctx, rc, this._points(rc, d), d.tool, false);
    }
    if (this._snap !== null) this._drawSnapRing(ctx, rc, this._project(rc, this._snap.time, this._snap.price));
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
    let best: { id: string; distance: number } | null = null;
    // Reverse paint order, so the shape painted last wins a tie.
    for (let i = this._drawings.length - 1; i >= 0; i--) {
      const d = this._drawings[i];
      if (d.visible === false || d.locked === true || !hasDrawingTool(d.tool)) continue;
      const tool = getDrawingTool(d.tool);
      if (d.points.length < Math.max(1, tool.points)) continue;
      const dist = tool.distance(x, y, { pts: this._points(rc, d), drawing: d, rc });
      // A non-finite distance must miss, not hit: `NaN > GRAB` is false, so a
      // drawing with an unmappable anchor would otherwise swallow every click
      // on the pane.
      if (dist === null || !Number.isFinite(dist) || dist > grab) continue;
      if (best === null || dist < best.distance) best = { id: d.id, distance: dist };
    }
    if (best === null) return null;
    return {
      externalId: `draw:${best.id}`,
      zOrder: 'top', distance: best.distance, cursor: 'move', draggable: true,
    };
  }
}
