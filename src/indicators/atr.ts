/**
 * Average True Range — Wilder's ATR, matching `openalgo.ta.atr(high, low, close, 14)`.
 * Shared by the Supertrend indicator. True range of the first bar is high-low.
 */

/** True range series. tr[0] = high[0]-low[0]; thereafter the classic 3-way max. */
export function trueRange(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
): number[] {
  const n = high.length;
  const tr = new Array<number>(n);
  if (n === 0) return tr;
  tr[0] = high[0] - low[0];
  for (let i = 1; i < n; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }
  return tr;
}

/** Wilder ATR. First value (SMA of the first `period` TRs) lands at index period-1; earlier slots NaN. */
export function atr(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period = 14,
): number[] {
  if (period <= 0) throw new Error('openalgo-charts: ATR period must be > 0');
  const tr = trueRange(high, low, close);
  const n = tr.length;
  const out = new Array<number>(n).fill(NaN);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let a = sum / period;
  out[period - 1] = a;
  for (let i = period; i < n; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}
