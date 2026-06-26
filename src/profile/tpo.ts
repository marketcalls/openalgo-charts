/**
 * Time Price Opportunity / Market Profile (ARCHITECTURE.md §6A). Buckets
 * intraday bars into TPO periods and counts how many periods traded at each
 * price. Derives POC, Value Area, and the Initial Balance (first periods'
 * range). Derivable from OHLCV intraday bars. Pure + testable.
 */
import type { Bar } from '../model/bar';
import type { TpoResult } from './profile-model';
import { priceBuckets } from './profile-model';

export function computeTpo(
  bars: readonly Bar[],
  periodBars: number,
  tickSize: number,
  valueAreaPercent = 0.7,
  ibPeriods = 2,
): TpoResult {
  const period = Math.max(1, periodBars);
  const count = new Map<number, number>();
  let ibHigh = -Infinity;
  let ibLow = Infinity;

  const numPeriods = Math.ceil(bars.length / period);
  for (let p = 0; p < numPeriods; p++) {
    const slice = bars.slice(p * period, (p + 1) * period);
    if (slice.length === 0) continue;
    let pHigh = -Infinity;
    let pLow = Infinity;
    for (const b of slice) { pHigh = Math.max(pHigh, b.high); pLow = Math.min(pLow, b.low); }
    if (p < ibPeriods) { ibHigh = Math.max(ibHigh, pHigh); ibLow = Math.min(ibLow, pLow); }
    for (const bkt of priceBuckets(pLow, pHigh, tickSize)) count.set(bkt, (count.get(bkt) ?? 0) + 1);
  }

  const buckets = Array.from(count.entries())
    .map(([price, c]) => ({ price, count: c }))
    .sort((a, b) => b.price - a.price);

  if (buckets.length === 0) {
    return { buckets, poc: 0, vah: 0, val: 0, ib: { high: 0, low: 0 } };
  }

  const total = buckets.reduce((s, b) => s + b.count, 0);
  let pocIdx = 0;
  for (let i = 1; i < buckets.length; i++) if (buckets[i].count > buckets[pocIdx].count) pocIdx = i;

  let upper = pocIdx;
  let lower = pocIdx;
  let acc = buckets[pocIdx].count;
  const target = total * valueAreaPercent;
  while (acc < target && (upper > 0 || lower < buckets.length - 1)) {
    const up = upper > 0 ? buckets[upper - 1].count : -1;
    const down = lower < buckets.length - 1 ? buckets[lower + 1].count : -1;
    if (up >= down) { upper -= 1; acc += buckets[upper].count; }
    else { lower += 1; acc += buckets[lower].count; }
  }

  return {
    buckets,
    poc: buckets[pocIdx].price,
    vah: buckets[upper].price,
    val: buckets[lower].price,
    ib: { high: ibHigh, low: ibLow },
  };
}
