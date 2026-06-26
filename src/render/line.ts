/**
 * Line-family renderers (ARCHITECTURE.md §6, §6A): line, line+markers, step,
 * area, baseline, HLC-area. Pure point geometry is split out for unit testing.
 */
import type { Bar } from '../model/bar';
import type { SeriesStyle } from './series-style';

export interface LineDrawItem {
  x: number; // bar center, media px
  bar: Bar;
}

export interface Pt {
  x: number;
  y: number;
}

/** Pure: project items to screen points using a value accessor (default close). */
export function valuePoints(
  items: readonly LineDrawItem[],
  toY: (value: number) => number,
  value: (b: Bar) => number = (b) => b.close,
): Pt[] {
  return items.map((it) => ({ x: it.x, y: toY(value(it.bar)) }));
}

/** Pure: expand a value polyline into a step (HV) polyline. */
export function stepPoints(pts: readonly Pt[]): Pt[] {
  if (pts.length === 0) return [];
  const out: Pt[] = [{ ...pts[0] }];
  for (let i = 1; i < pts.length; i++) {
    out.push({ x: pts[i].x, y: pts[i - 1].y }); // horizontal
    out.push({ x: pts[i].x, y: pts[i].y }); // vertical
  }
  return out;
}

function strokePolyline(ctx: CanvasRenderingContext2D, pts: readonly Pt[], dpr: number): void {
  if (pts.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x * dpr, pts[0].y * dpr);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * dpr, pts[i].y * dpr);
  ctx.stroke();
}

export function drawLine(
  ctx: CanvasRenderingContext2D,
  items: readonly LineDrawItem[],
  toY: (v: number) => number,
  dpr: number,
  style: SeriesStyle,
): void {
  const base = valuePoints(items, toY);
  const pts = style.step ? stepPoints(base) : base;
  ctx.save();
  ctx.strokeStyle = style.color ?? '#4f8cff';
  ctx.lineWidth = Math.max(1, Math.round((style.lineWidth ?? 1.5) * dpr));
  ctx.lineJoin = 'round';
  strokePolyline(ctx, pts, dpr);
  if (style.markers) {
    const r = (style.markerRadius ?? 2) * dpr;
    ctx.fillStyle = style.color ?? '#4f8cff';
    for (const p of base) {
      ctx.beginPath();
      ctx.arc(p.x * dpr, p.y * dpr, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export function drawArea(
  ctx: CanvasRenderingContext2D,
  items: readonly LineDrawItem[],
  toY: (v: number) => number,
  dpr: number,
  plotHeight: number,
  style: SeriesStyle,
): void {
  const pts = valuePoints(items, toY);
  if (pts.length === 0) return;
  const baseY = plotHeight * dpr;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0].x * dpr, baseY);
  for (const p of pts) ctx.lineTo(p.x * dpr, p.y * dpr);
  ctx.lineTo(pts[pts.length - 1].x * dpr, baseY);
  ctx.closePath();
  ctx.fillStyle = style.areaTopColor ?? 'rgba(79,140,255,0.25)';
  ctx.fill();
  ctx.restore();
  drawLine(ctx, items, toY, dpr, { color: style.color ?? '#4f8cff', lineWidth: style.lineWidth ?? 1.5 });
}

export function drawBaseline(
  ctx: CanvasRenderingContext2D,
  items: readonly LineDrawItem[],
  toY: (v: number) => number,
  dpr: number,
  style: SeriesStyle,
): void {
  const baseValue = style.baseValue ?? 0;
  const baseY = toY(baseValue) * dpr;
  const pts = valuePoints(items, toY);
  ctx.save();
  // split stroke: above-base in topColor, below-base in bottomColor
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const above = (a.y + b.y) / 2 <= baseY / dpr; // smaller y = higher price = above base
    ctx.strokeStyle = above ? (style.topColor ?? '#26a69a') : (style.bottomColor ?? '#ef5350');
    ctx.lineWidth = Math.max(1, Math.round((style.lineWidth ?? 1.5) * dpr));
    ctx.beginPath();
    ctx.moveTo(a.x * dpr, a.y * dpr);
    ctx.lineTo(b.x * dpr, b.y * dpr);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawHlcArea(
  ctx: CanvasRenderingContext2D,
  items: readonly LineDrawItem[],
  toY: (v: number) => number,
  dpr: number,
  style: SeriesStyle,
): void {
  if (items.length === 0) return;
  const highs = valuePoints(items, toY, (b) => b.high);
  const lows = valuePoints(items, toY, (b) => b.low);
  // fill between high and low
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(highs[0].x * dpr, highs[0].y * dpr);
  for (const p of highs) ctx.lineTo(p.x * dpr, p.y * dpr);
  for (let i = lows.length - 1; i >= 0; i--) ctx.lineTo(lows[i].x * dpr, lows[i].y * dpr);
  ctx.closePath();
  ctx.fillStyle = style.areaTopColor ?? 'rgba(79,140,255,0.15)';
  ctx.fill();
  ctx.restore();
  drawLine(ctx, items, toY, dpr, { color: style.closeColor ?? '#4f8cff', lineWidth: style.lineWidth ?? 1.5 });
}
