/**
 * Line-family renderers (ARCHITECTURE.md §6, §6A): line, line+markers, step,
 * area, baseline, HLC-area. Pure point geometry is split out for unit testing.
 */
import type { Bar } from '../model/bar';
import type { SeriesStyle } from './series-style';
import { verticalGradient } from './gradient';

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

/**
 * A polyline in media px, as two coordinate arrays and a count.
 *
 * The renderers below run for every line series (every indicator plot among
 * them) on every frame of a pan, and they used to build a `{ x, y }` object
 * per bar each time, twice for a step line and twice again under an area:
 * garbage by the next frame. They fill these in place instead. A renderer
 * runs start to end without yielding, so one set serves every series; each
 * is filled and read within one renderer, and a renderer that calls
 * `drawLine` is done with the line's points before it does.
 */
interface Polyline {
  xs: number[];
  ys: number[];
  n: number;
}

const polyline = (): Polyline => ({ xs: [], ys: [], n: 0 });

/** The values' line and its step form; an HLC band's upper and lower edges. */
const VALUES = polyline(), STEPS = polyline(), HIGHS = polyline(), LOWS = polyline();

/** Per-point colours of the line being drawn, reused like the points. */
const COLORS: (string | undefined)[] = [];

/**
 * Close a fill of `n` points. A view zoomed back in from a very wide one gives
 * the room back rather than keeping a whole history's worth for good.
 */
function settle(line: Polyline, n: number): void {
  line.n = n;
  if (line.xs.length > 16_384 && n * 4 < line.xs.length) line.xs.length = line.ys.length = n;
}

/** Which bar value a polyline follows. */
const CLOSE = 0, HIGH = 1, LOW = 2;

/** `valuePoints`, written into `line`: the same x and y for each item, in order. */
function project(line: Polyline, items: readonly LineDrawItem[], toY: (value: number) => number, field: number): void {
  const xs = line.xs, ys = line.ys;
  for (let i = 0; i < items.length; i++) {
    const it = items[i], b = it.bar;
    xs[i] = it.x;
    ys[i] = toY(field === CLOSE ? b.close : field === HIGH ? b.high : b.low);
  }
  settle(line, items.length);
}

/** `stepPoints`, written into `out`: 2n - 1 points, the horizontal leg of each step first. */
function projectSteps(src: Polyline, out: Polyline): void {
  const sx = src.xs, sy = src.ys, xs = out.xs, ys = out.ys;
  let k = 0;
  for (let i = 0; i < src.n; i++) {
    if (i > 0) { xs[k] = sx[i]; ys[k++] = sy[i - 1]; } // horizontal
    xs[k] = sx[i]; ys[k++] = sy[i]; // vertical
  }
  settle(out, k);
}

/**
 * Per-point colours aligned to the polyline drawn for `items`, or undefined
 * when not one point carries its own. Undefined is the fast path every
 * ordinary series takes: `strokePolyline` then walks the whole line into a
 * single stroke, as before.
 */
function pointColors(items: readonly LineDrawItem[], step: boolean): (string | undefined)[] | undefined {
  let any = false;
  for (let i = 0; i < items.length; i++) if (items[i].bar.color !== undefined) { any = true; break; }
  if (!any) return undefined;
  let k = 0;
  for (let i = 0; i < items.length; i++) {
    const color = items[i].bar.color;
    // A step's horizontal and vertical legs both belong to the span arriving at
    // this bar, so they take one colour rather than meeting half-recoloured.
    if (step && k > 0) COLORS[k++] = color;
    COLORS[k++] = color;
  }
  COLORS.length = k;
  return COLORS;
}

function strokePolyline(
  ctx: CanvasRenderingContext2D,
  line: Polyline,
  dpr: number,
  colors?: readonly (string | undefined)[],
): void {
  const n = line.n, xs = line.xs, ys = line.ys;
  if (n === 0) return;
  // What a point that names no colour of its own falls back to.
  const fallback = ctx.strokeStyle;
  // Break the line across non-finite points (whitespace gaps) so indicators with
  // holes (an RSI warm-up, the Supertrend up/down split) render as separate segments.
  ctx.beginPath();
  let prev = -1;
  let run: string | undefined;
  let drawn = false; // the open path holds at least one segment
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) { prev = -1; continue; }
    if (prev < 0) { ctx.moveTo(x * dpr, y * dpr); prev = i; continue; }
    // A per-point colour series: the segment arriving at a bar takes that
    // bar's colour. A change strokes the run accumulated so far and restarts the
    // path from the same point, so consecutive runs abut with no seam. With no
    // colours at all `c` tracks `run`, the test never fires, and the whole line
    // goes down in one stroke exactly as it did before.
    const c = colors === undefined ? run : colors[i];
    if (c !== run) {
      if (drawn) {
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(xs[prev] * dpr, ys[prev] * dpr);
        drawn = false;
      }
      ctx.strokeStyle = c ?? fallback;
      run = c;
    }
    ctx.lineTo(x * dpr, y * dpr);
    prev = i;
    drawn = true;
  }
  ctx.stroke();
}

export function drawLine(
  ctx: CanvasRenderingContext2D,
  items: readonly LineDrawItem[],
  toY: (v: number) => number,
  dpr: number,
  style: SeriesStyle,
): void {
  const base = VALUES;
  project(base, items, toY, CLOSE);
  let pts = base;
  if (style.step) projectSteps(base, pts = STEPS);
  const cols = pointColors(items, style.step === true);
  ctx.save();
  ctx.strokeStyle = style.color ?? '#4f8cff';
  // Not rounded to whole device px: snapping a 1.5px stroke up to 2px reads
  // heavier and blockier than the width the caller asked for. Rounding only
  // helps axis-aligned rules, and a polyline is rarely one. Round caps + joins
  // keep reversals and segment ends smooth rather than chiselled.
  ctx.lineWidth = Math.max(1, (style.lineWidth ?? 1.5) * dpr);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const dash = style.lineStyle === 'dashed' ? [6 * dpr, 4 * dpr]
    : style.lineStyle === 'dotted' ? [1 * dpr, 3 * dpr]
    : [];
  ctx.setLineDash(dash);
  // markersOnly: dots with no connecting stroke (Parabolic SAR, scatter plots).
  if (!style.markersOnly) strokePolyline(ctx, pts, dpr, cols);
  ctx.setLineDash([]);
  if (style.markers || style.markersOnly) {
    const r = (style.markerRadius ?? 2) * dpr;
    const fill = style.color ?? '#4f8cff';
    ctx.fillStyle = fill;
    for (let i = 0; i < base.n; i++) {
      const x = base.xs[i], y = base.ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      // A dot follows its own bar's colour, not the segment rule: a marker sits
      // on the bar rather than between two of them.
      if (cols !== undefined) ctx.fillStyle = items[i].bar.color ?? fill;
      ctx.beginPath();
      ctx.arc(x * dpr, y * dpr, r, 0, Math.PI * 2);
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
  const pts = VALUES;
  project(pts, items, toY, CLOSE);
  const n = pts.n, xs = pts.xs, ys = pts.ys;
  if (n === 0) return;
  const baseY = plotHeight * dpr;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(xs[0] * dpr, baseY);
  for (let i = 0; i < n; i++) ctx.lineTo(xs[i] * dpr, ys[i] * dpr);
  ctx.lineTo(xs[n - 1] * dpr, baseY);
  ctx.closePath();
  // vertical gradient: solid-ish near the line fading toward the baseline
  ctx.fillStyle = verticalGradient(
    ctx, baseY,
    style.areaTopColor ?? 'rgba(79,140,255,0.40)',
    style.areaBottomColor ?? 'rgba(79,140,255,0.00)',
  );
  ctx.fill();
  ctx.restore();
  // The outline is a plain line, so it carries the dash the caller asked for.
  // The fill keeps its own gradient: a dashed edge over a solid body is the
  // shape of an area chart, and dashing the fill too would just look broken.
  drawLine(ctx, items, toY, dpr, {
    color: style.color ?? '#4f8cff',
    lineWidth: style.lineWidth ?? 1.5,
    lineStyle: style.lineStyle,
  });
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
  const pts = VALUES;
  project(pts, items, toY, CLOSE);
  const n = pts.n, xs = pts.xs, ys = pts.ys;
  if (n === 0) return;

  // Gradient fills: above-base region fades down from topFill, below-base fades up
  // from bottomFill. Built as one area polygon to the base line, clipped at baseY.
  const minX = xs[0] * dpr;
  const maxX = xs[n - 1] * dpr;
  const buildArea = (): void => {
    ctx.beginPath();
    ctx.moveTo(minX, baseY);
    for (let i = 0; i < n; i++) ctx.lineTo(xs[i] * dpr, ys[i] * dpr);
    ctx.lineTo(maxX, baseY);
    ctx.closePath();
  };
  const topFill = style.areaTopColor ?? 'rgba(38,166,154,0.20)';
  const botFill = style.areaBottomColor ?? 'rgba(239,83,80,0.20)';
  const BIG = 1e5;
  // above base
  ctx.save();
  ctx.beginPath(); ctx.rect(minX, baseY - BIG, maxX - minX, BIG); ctx.clip();
  buildArea();
  ctx.fillStyle = verticalGradient(ctx, baseY, topFill, 'rgba(0,0,0,0)');
  ctx.fill();
  ctx.restore();
  // below base
  ctx.save();
  ctx.beginPath(); ctx.rect(minX, baseY, maxX - minX, BIG); ctx.clip();
  buildArea();
  ctx.fillStyle = botFill;
  ctx.fill();
  ctx.restore();

  ctx.save();
  // split stroke: above-base in topColor, below-base in bottomColor
  for (let i = 1; i < n; i++) {
    const ay = ys[i - 1], by = ys[i];
    const above = (ay + by) / 2 <= baseY / dpr; // smaller y = higher price = above base
    ctx.strokeStyle = above ? (style.topColor ?? '#26a69a') : (style.bottomColor ?? '#ef5350');
    ctx.lineWidth = Math.max(1, Math.round((style.lineWidth ?? 1.5) * dpr));
    ctx.beginPath();
    ctx.moveTo(xs[i - 1] * dpr, ay * dpr);
    ctx.lineTo(xs[i] * dpr, by * dpr);
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
  const highs = HIGHS, lows = LOWS;
  project(highs, items, toY, HIGH);
  project(lows, items, toY, LOW);
  const n = highs.n;
  // fill between high and low
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(highs.xs[0] * dpr, highs.ys[0] * dpr);
  for (let i = 0; i < n; i++) ctx.lineTo(highs.xs[i] * dpr, highs.ys[i] * dpr);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(lows.xs[i] * dpr, lows.ys[i] * dpr);
  ctx.closePath();
  ctx.fillStyle = style.areaTopColor ?? 'rgba(79,140,255,0.15)';
  ctx.fill();
  ctx.restore();
  // The two edges of the band, each drawn only when the caller named a colour
  // for it. They have no default: an HLC area is a filled band plus a close
  // line, so a caller who never set these gets exactly the frame it always got.
  strokeEdge(ctx, highs, style.highColor, style, dpr);
  strokeEdge(ctx, lows, style.lowColor, style, dpr);
  drawLine(ctx, items, toY, dpr, { color: style.closeColor ?? '#4f8cff', lineWidth: style.lineWidth ?? 1.5 });
}

/** One edge of an HLC band, in its own colour, or nothing without one. */
function strokeEdge(ctx: CanvasRenderingContext2D, edge: Polyline, color: string | undefined, style: SeriesStyle, dpr: number): void {
  if (color === undefined) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, Math.round((style.lineWidth ?? 1.5) * dpr));
  strokePolyline(ctx, edge, dpr);
  ctx.restore();
}
