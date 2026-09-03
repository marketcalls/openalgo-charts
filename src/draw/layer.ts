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
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from 'openalgo-charts';
import type { Drawing, ScreenPoint } from './types';
import { getDrawingTool, hasDrawingTool } from './tools';

/** Grab radius for a shape, in media px. */
const GRAB = 6;
/** Anchor handle radius, in media px. */
const HANDLE = 5;

/** Which side of the series a layer paints on. */
export type DrawingLayerOrder = 'bottom' | 'top';

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
  /** Anchors of the in-progress drawing, plus the live cursor point. */
  private _preview: Drawing | null = null;
  /** The layer under this one, whose handles and hits this layer answers for. */
  private _below: DrawingLayer | null = null;
  /** The layer that has taken over this one's handles and hit-testing. */
  private _above: DrawingLayer | null = null;

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
    for (const d of this._handled()) this._drawHandles(ctx, rc, this._points(rc, d), d.tool);
    if (this._below !== null) {
      for (const d of this._below._handled()) this._drawHandles(ctx, rc, this._points(rc, d), d.tool);
    }
  }

  private _drawHandles(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext, pts: readonly ScreenPoint[], toolId: string): void {
    const dpr = rc.dpr;
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
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
    for (const sel of this._handled()) {
      const pts = this._points(rc, sel);
      for (const i of handleIndices(sel.tool, pts.length)) {
        if (Math.hypot(x - pts[i].x, y - pts[i].y) <= HANDLE + 2) {
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
      if (dist === null || !Number.isFinite(dist) || dist > GRAB) continue;
      if (best === null || dist < best.distance) best = { id: d.id, distance: dist };
    }
    if (best === null) return null;
    return {
      externalId: `draw:${best.id}`,
      zOrder: 'top', distance: best.distance, cursor: 'move', draggable: true,
    };
  }
}
