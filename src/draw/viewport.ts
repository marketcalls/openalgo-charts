/**
 * The arithmetic of viewport anchors (`Drawing.space === 'viewport'`), shared
 * by the layer that paints them, the controller that moves them, and the
 * migration and clipboard that read them from outside. Pure: no registry, no
 * chart, so the migration can use it and stay pure too.
 *
 * A viewport anchor is a fraction of its pane's plot, so the only operations
 * are validation, a clamped shift, and the two scalings to and from pixels,
 * which need nothing but the plot's size.
 */
import type { Drawing, ScreenPoint, ViewportPoint } from './types';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Whether a drawing is pinned to the screen rather than to time and price. */
export const isViewportDrawing = (d: Pick<Drawing, 'space'>): boolean => d.space === 'viewport';

/** The anchors a drawing carries in its own space: what decides whether it is complete. */
export const anchorCount = (d: Drawing): number =>
  d.space === 'viewport' ? d.viewportPoints?.length ?? 0 : d.points.length;

/**
 * A list of finite `{ x, y }` records as fresh objects, or null. Empty is
 * null as well: a drawing with no anchor can never be painted or grabbed.
 * Values outside 0..1 are kept, since a host may deliberately place a note
 * part way off its pane; only a gesture is kept inside it.
 */
export function readViewportPoints(value: unknown, max = Infinity): ViewportPoint[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
  const out: ViewportPoint[] = [];
  for (const p of value) {
    if (!isRecord(p) || !isNum(p.x) || !isNum(p.y)) return null;
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** One anchor held inside its pane. */
export const clampViewportPoint = (p: ViewportPoint): ViewportPoint => ({ x: clamp01(p.x), y: clamp01(p.y) });

/**
 * The widest step along one axis that keeps every value inside 0..1, or at
 * least no further outside it than it already was. A shape a host parked part
 * way off the pane may move back in, never further out.
 */
function limit(values: readonly number[], delta: number): number {
  const lo = Math.min(0, -Math.min(...values));
  const hi = Math.max(0, 1 - Math.max(...values));
  return delta < lo ? lo : delta > hi ? hi : delta;
}

/**
 * Every anchor moved by the same fraction, the step clamped as a whole so the
 * shape keeps its size and proportions at the pane's edge instead of being
 * squashed against it. What a body drag, a nudge and a paste offset share.
 */
export function shiftViewportPoints(points: readonly ViewportPoint[], dx: number, dy: number): ViewportPoint[] {
  if (points.length === 0) return [];
  const sx = limit(points.map((p) => p.x), dx);
  const sy = limit(points.map((p) => p.y), dy);
  return points.map((p) => ({ x: p.x + sx, y: p.y + sy }));
}

/** Viewport anchors to plot-relative media px on a plot of `width` by `height`. */
export function viewportToPlot(points: readonly ViewportPoint[], width: number, height: number): ScreenPoint[] {
  return points.map((p) => ({ x: p.x * width, y: p.y * height }));
}
