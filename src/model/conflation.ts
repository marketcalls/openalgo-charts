/**
 * Optional OHLC-preserving conflation / downsampling (ARCHITECTURE.md §4.4).
 * When zoomed far out, many bars map to sub-pixel widths; drawing them all is
 * wasted work. Conflation merges groups of bars into one, preserving candle
 * shape — open = first, close = last, high = max, low = min, volume = sum
 * (never a lossy average). Off by default; enabling it changes nothing until
 * bars fall below the pixel threshold.
 */
import type { Bar } from './bar';

/**
 * How many source bars to merge per drawn bar. Returns 1 (no conflation) while
 * each bar is at least `minPx` wide; otherwise ceil(minPx / barWidthPx) scaled
 * by `factor` (higher = more aggressive smoothing).
 */
export function conflationGroupSize(barSpacing: number, dpr: number, minPx = 0.5, factor = 1): number {
  const widthPx = barSpacing * dpr;
  if (widthPx <= 0) return 1;
  const threshold = minPx * Math.max(1, factor);
  if (widthPx >= threshold) return 1;
  return Math.max(1, Math.ceil(threshold / widthPx));
}

/** Merge a single group of bars into one OHLC-preserving bar (uses the first bar's time). */
export function mergeBars(group: readonly Bar[]): Bar {
  const first = group[0];
  let high = first.high;
  let low = first.low;
  let volume = first.volume ?? 0;
  let hasVolume = first.volume !== undefined;
  for (let i = 1; i < group.length; i++) {
    const b = group[i];
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    if (b.volume !== undefined) { volume += b.volume; hasVolume = true; }
  }
  const merged: Bar = {
    time: first.time,
    open: first.open,
    high,
    low,
    close: group[group.length - 1].close,
  };
  if (hasVolume) merged.volume = volume;
  return merged;
}

/** Conflate a bar series into groups of `groupSize` (identity when groupSize ≤ 1). */
export function conflateBars(bars: readonly Bar[], groupSize: number): Bar[] {
  if (groupSize <= 1) return bars.slice();
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i += groupSize) {
    out.push(mergeBars(bars.slice(i, i + groupSize)));
  }
  return out;
}

/** Conflate already-projected draw items: merge bars and place x at the group centre. */
export function conflateItems<T extends { x: number; bar: Bar }>(items: readonly T[], groupSize: number): { x: number; bar: Bar }[] {
  if (groupSize <= 1) return items.map((it) => ({ x: it.x, bar: it.bar }));
  const out: { x: number; bar: Bar }[] = [];
  for (let i = 0; i < items.length; i += groupSize) {
    const group = items.slice(i, i + groupSize);
    const x = group.reduce((s, it) => s + it.x, 0) / group.length;
    out.push({ x, bar: mergeBars(group.map((it) => it.bar)) });
  }
  return out;
}
