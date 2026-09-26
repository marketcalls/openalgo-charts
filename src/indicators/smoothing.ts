/**
 * Warmup-gap alignment and the "Smoothing" block, shared by the built-in
 * studies that chain one average onto another indicator's output.
 *
 * Internal to the indicator tier: `./index` does not export it, and no base
 * module imports it, so none of it reaches a chart-only build. It exists so
 * the alignment rule and the Smoothing block are written once. Private copies
 * of these helpers and of the block's option list sat in eight study modules,
 * where one copy could be corrected and its siblings left behind.
 */
import { sma, wma, rma, vwma, smaSeededEma } from './calc';

/**
 * The Smoothing block's choices, for every study that offers the block. 'None'
 * leaves the average off and `BOLLINGER_MA` also draws the two band plots; the
 * rest name a `smoothingMa` kernel.
 */
export const SMOOTHING_MA_TYPES: readonly { label: string; value: string }[] = [
  { label: 'None', value: 'None' },
  { label: 'SMA', value: 'SMA' },
  { label: 'SMA + Bollinger Bands', value: 'SMA + Bollinger Bands' },
  { label: 'EMA', value: 'EMA' },
  { label: 'SMMA (RMA)', value: 'SMMA (RMA)' },
  { label: 'WMA', value: 'WMA' },
  { label: 'VWMA', value: 'VWMA' },
];

/** Set by `maType` when the two Bollinger band plots become visible. */
export const BOLLINGER_MA = 'SMA + Bollinger Bands';

/**
 * Run `smooth` over the tail that begins at the series' first real value, then
 * pad the answer back to full length.
 *
 * Chaining a smoother straight onto a series that already has a warmup gap gets
 * the wrong answer: a recursive average carries one NaN forever, a windowed one
 * counts holes as bars, and a rolling extreme quietly replies from a short
 * window (`highest` skips non-finite values rather than refusing). A study
 * simply does not exist before its first value, and the smoother's window has
 * to start counting there. `start` is the tail's offset, for a smoother that
 * pairs the series with a second one (VWMA and its volumes). Later gaps stay
 * the smoother's responsibility.
 */
export function fromFirstValue(
  values: readonly number[],
  smooth: (tail: readonly number[], start: number) => number[],
): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  let start = 0;
  while (start < n && !Number.isFinite(values[start])) start += 1;
  if (start >= n) return out;
  const tail = smooth(values.slice(start), start);
  for (let i = 0; i < tail.length && start + i < n; i++) out[start + i] = tail[i];
  return out;
}

/**
 * Align a chained SMA-seeded EMA with its input's leading warmup gap.
 * Smoothing starts at the first finite value and the result is padded back to
 * the original bar positions. `smaSeededEma` supplies finite-window seeding and
 * subsequent gap behavior; the wrapper keeps the composition's alignment explicit.
 */
export function emaOfGapped(values: readonly number[], period: number): number[] {
  return fromFirstValue(values, (tail) => smaSeededEma(tail, period));
}

/**
 * The Smoothing block's kernel switch, applied to an indicator's own output,
 * and the moving-average ribbon's, applied to a price source.
 *
 * Every branch starts at the smoothed series' first real value, because that
 * series is usually an indicator with a warmup gap. A running total that prints
 * from bar 0 (OBV) or a price source has no leading gap, so the alignment
 * passes it through untouched; for a whole length the kernels give the same
 * answer either way. 'SMA', 'SMA + Bollinger Bands' and, because a settings
 * blob can carry anything, every unknown kind take the SMA branch.
 */
export function smoothingMa(
  kind: string,
  values: readonly number[],
  volumes: readonly number[],
  length: number,
): number[] {
  switch (kind) {
    case 'EMA': return emaOfGapped(values, length);
    case 'SMMA (RMA)': return fromFirstValue(values, (t) => rma(t, length));
    case 'WMA': return fromFirstValue(values, (t) => wma(t, length));
    case 'VWMA': return fromFirstValue(values, (t, start) => vwma(t, volumes.slice(start), length));
    default: return fromFirstValue(values, (t) => sma(t, length));
  }
}
