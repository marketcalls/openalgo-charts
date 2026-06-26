/**
 * Supertrend — matching `openalgo.ta.supertrend(high, low, close, period=10, multiplier=3.0)`,
 * which returns (supertrend value, direction). Direction follows the OpenAlgo
 * convention: -1 = uptrend (line is support below price), +1 = downtrend (line
 * is resistance above price). ATR uses Wilder smoothing (see ./atr).
 */
import type { Bar } from '../model/bar';
import { atr } from './atr';

export interface SupertrendPoint {
  /** The Supertrend band value, or NaN during ATR warmup. */
  value: number;
  /** -1 = uptrend (bullish), +1 = downtrend (bearish). */
  direction: -1 | 1;
}

/** Supertrend value + direction per bar. Warmup bars carry value=NaN. */
export function supertrend(bars: readonly Bar[], period = 10, multiplier = 3): SupertrendPoint[] {
  const n = bars.length;
  const out: SupertrendPoint[] = bars.map(() => ({ value: NaN, direction: 1 }));
  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);
  const a = atr(high, low, close, period);

  let prevUpper = NaN;
  let prevLower = NaN;
  let prevST = NaN;
  let started = false;

  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i])) continue;
    const hl2 = (high[i] + low[i]) / 2;
    const basicUpper = hl2 + multiplier * a[i];
    const basicLower = hl2 - multiplier * a[i];

    // Final bands carry forward unless price broke them (standard Supertrend rule).
    const finalUpper = !started
      ? basicUpper
      : basicUpper < prevUpper || close[i - 1] > prevUpper ? basicUpper : prevUpper;
    const finalLower = !started
      ? basicLower
      : basicLower > prevLower || close[i - 1] < prevLower ? basicLower : prevLower;

    let st: number;
    let dir: -1 | 1;
    if (!started || prevST === prevUpper) {
      // previously following the upper band (downtrend) — flip up if close clears it
      if (close[i] <= finalUpper) { st = finalUpper; dir = 1; }
      else { st = finalLower; dir = -1; }
    } else {
      // previously following the lower band (uptrend) — flip down if close breaks it
      if (close[i] >= finalLower) { st = finalLower; dir = -1; }
      else { st = finalUpper; dir = 1; }
    }

    out[i] = { value: st, direction: dir };
    prevUpper = finalUpper;
    prevLower = finalLower;
    prevST = st;
    started = true;
  }
  return out;
}

/**
 * Supertrend as two plottable `line` series for direction coloring: `up`
 * (uptrend / support, typically green) carries the value only while direction is
 * -1; `down` (downtrend / resistance, typically red) only while +1. The inactive
 * series carries NaN, so each renders as separate segments that swap at flips
 * (the line renderer breaks across non-finite points).
 */
export function supertrendSeries(
  bars: readonly Bar[],
  period = 10,
  multiplier = 3,
): { up: Bar[]; down: Bar[] } {
  const st = supertrend(bars, period, multiplier);
  const point = (time: number, v: number): Bar => ({ time, open: v, high: v, low: v, close: v });
  const up: Bar[] = [];
  const down: Bar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const p = st[i];
    const active = Number.isFinite(p.value);
    up.push(point(bars[i].time, active && p.direction === -1 ? p.value : NaN));
    down.push(point(bars[i].time, active && p.direction === 1 ? p.value : NaN));
  }
  return { up, down };
}
