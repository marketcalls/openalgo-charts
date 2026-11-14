/**
 * Series transform pipeline (ARCHITECTURE.md §6A, Family B). A transform
 * re-buckets raw OHLC into a derived element series driven by price movement,
 * not the clock. A transform is incremental: `push` takes each source bar
 * once, in time order, and never recomputes what came before. Every push moves
 * the state, so a bar that is still forming is not pushed on each tick (that
 * counts it again every time); a live chart pushes it through a `clone` of
 * the state instead and pushes it for good once it has closed (see ./live).
 *
 * Each derived element is a Bar carrying its source formation time. Because the
 * time scale is index-based, derived elements get uniform spacing automatically
 * (the "ordinal" axis); axis labels read each element's formation time. We only
 * post-process times to be strictly increasing so the shared DataLayer keeps
 * every element on its own logical index (no collisions when many elements form
 * within one source bar).
 */
import type { Bar } from '../model/bar';

export interface ISeriesTransform {
  /** Reset to initial state (start of a fresh batch / re-subscribe). */
  reset(): void;
  /** Feed one source bar; return 0..n newly *completed* derived elements. */
  push(bar: Bar): Bar[];
  /** Optional: emit any in-progress element at end of data. */
  flush?(): Bar[];
  /**
   * Optional: an independent copy of the state, for a live chart to push the
   * forming bar through. `push` changes state on every call, so the bar that
   * is still forming is pushed into a copy on each tick and into the transform
   * itself only once it has closed. The built-in transforms all have one.
   */
  clone?(): ISeriesTransform;
}

/**
 * A shallow copy of a transform: its prototype and every field. A field that
 * holds an object is shared, so a transform whose state has one copies it
 * after this.
 */
export function copyState<T extends object>(transform: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(transform) as object) as T, transform);
}

/**
 * Whether a bar has four finite prices. One without is a gap (a whitespace
 * point reaches a transform as a NaN bar): the price-driven transforms skip it
 * as if it were not there, and Heikin Ashi keeps its slot as an empty candle.
 * One NaN taken into a running ATR, a range bar's extremes or a first line
 * stays in every element after it.
 */
export function isPriced(bar: Bar): boolean {
  return Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close);
}

/**
 * The volume traded while an element formed. A price-driven element is many
 * source bars, or a part of one, so a study reading volume on it needs the sum
 * of the bars pushed since the element before it. Without it every volume study
 * on a brick chart read nothing and drew a flat zero. NaN means no bar has
 * reported a volume, which leaves elements without one, as they always were: an
 * index, or a feed that sends no volume, draws and computes exactly as before.
 */
export function addVolume(sum: number, bar: Bar): number {
  const v = bar.volume;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return sum;
  return Number.isNaN(sum) ? v : sum + v;
}

/**
 * Give the elements one bar completed their volume: the tally on the first,
 * 0 on the rest, so a running total such as OBV keeps counting instead of
 * turning NaN. Returns the tally the next element starts from.
 */
export function settleVolume(out: Bar[], sum: number): number {
  if (out.length === 0) return sum;
  if (!Number.isNaN(sum)) {
    for (let i = 0; i < out.length; i++) out[i] = { ...out[i]!, volume: i === 0 ? sum : 0 };
  }
  return NaN;
}

/** `element` carrying `sum` as its volume, or unchanged when no bar reported one. */
export function withVolume(element: Bar, sum: number): Bar {
  return Number.isNaN(sum) ? element : { ...element, volume: sum };
}

/**
 * Make times strictly increasing (collisions bumped by +1s) so the DataLayer
 * assigns one logical index per element. Labels stay within a few seconds of
 * the real formation time.
 */
export function ensureIncreasingTimes(bars: readonly Bar[]): Bar[] {
  let prev = -Infinity;
  const out: Bar[] = [];
  for (const b of bars) {
    let t = b.time;
    if (t <= prev) t = prev + 1;
    prev = t;
    out.push(t === b.time ? b : { ...b, time: t });
  }
  return out;
}

/** Run a transform over a full batch of bars (history load). */
export function runTransform(transform: ISeriesTransform, bars: readonly Bar[]): Bar[] {
  transform.reset();
  const out: Bar[] = [];
  for (const b of bars) out.push(...transform.push(b));
  if (transform.flush) out.push(...transform.flush());
  return ensureIncreasingTimes(out);
}
