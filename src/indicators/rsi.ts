/**
 * Relative Strength Index — Wilder's RSI, matching `openalgo.ta.rsi(close, 14)`.
 *
 * Uses Wilder smoothing (RMA): the first average gain/loss is the simple mean of
 * the first `period` deltas, then each subsequent average carries
 * `(prev*(period-1) + current)/period`. Warmup bars (before enough data) are NaN.
 */
import type { Bar } from '../model/bar';

/** Wilder RSI over a numeric series. Returns NaN for the first `period` slots. */
export function rsi(values: readonly number[], period = 14): number[] {
  if (period <= 0) throw new Error('openalgo-charts: RSI period must be > 0');
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  if (n <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * RSI of bar closes as plottable bars (close = rsi). Warmup bars carry NaN so a
 * `line` series breaks cleanly before the first value (the renderer skips
 * non-finite points) instead of dropping to zero.
 */
export function rsiSeries(bars: readonly Bar[], period = 14): Bar[] {
  const r = rsi(bars.map((b) => b.close), period);
  return bars.map((b, i) => ({ time: b.time, open: r[i], high: r[i], low: r[i], close: r[i] }));
}
