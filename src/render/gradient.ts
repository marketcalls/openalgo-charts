/**
 * Cached vertical gradients (ARCHITECTURE.md §6). A `CanvasGradient` belongs to
 * the context that created it, so the cache is keyed per-context (WeakMap) and
 * by height + colors. Used for area/baseline fills.
 */
const perCtx = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>();

export function verticalGradient(
  ctx: CanvasRenderingContext2D,
  heightPx: number,
  topColor: string,
  bottomColor: string,
): CanvasGradient {
  let m = perCtx.get(ctx);
  if (m === undefined) { m = new Map(); perCtx.set(ctx, m); }
  const key = `${Math.round(heightPx)}|${topColor}|${bottomColor}`;
  let g = m.get(key);
  if (g === undefined) {
    g = ctx.createLinearGradient(0, 0, 0, heightPx);
    g.addColorStop(0, topColor);
    g.addColorStop(1, bottomColor);
    m.set(key, g);
  }
  return g;
}
