/**
 * Volume Profile (ARCHITECTURE.md §6A). Distributes each bar's volume across the
 * price buckets it spans, then derives the Point of Control and Value Area.
 * From OHLCV this is an approximation (uniform spread across the bar's range);
 * exact profiles need tick data. Pure + testable.
 */
import type { Bar } from '../model/bar';
import type { VolumeProfileResult } from './profile-model';
import { priceBuckets } from './profile-model';

export interface VolumeProfileOptions {
  tickSize: number;
  /** Fraction of total volume contained in the value area (default 0.7). */
  valueAreaPercent: number;
}

export function computeVolumeProfile(
  bars: readonly Bar[],
  tickSize: number,
  valueAreaPercent = 0.7,
): VolumeProfileResult {
  const vol = new Map<number, number>();
  for (const bar of bars) {
    const buckets = priceBuckets(bar.low, bar.high, tickSize);
    const share = (bar.volume ?? 0) / buckets.length;
    for (const b of buckets) vol.set(b, (vol.get(b) ?? 0) + share);
  }
  const buckets = Array.from(vol.entries())
    .map(([price, volume]) => ({ price, volume }))
    .sort((a, b) => b.price - a.price);

  if (buckets.length === 0) {
    return { buckets, poc: 0, vah: 0, val: 0, totalVolume: 0 };
  }

  const total = buckets.reduce((s, b) => s + b.volume, 0);
  // POC: max-volume bucket
  let pocIdx = 0;
  for (let i = 1; i < buckets.length; i++) if (buckets[i].volume > buckets[pocIdx].volume) pocIdx = i;

  // Value area: expand from POC, adding the larger-volume neighbour each step.
  let upper = pocIdx; // toward higher price (lower index, since sorted desc)
  let lower = pocIdx; // toward lower price (higher index)
  let acc = buckets[pocIdx].volume;
  const target = total * valueAreaPercent;
  while (acc < target && (upper > 0 || lower < buckets.length - 1)) {
    const upVol = upper > 0 ? buckets[upper - 1].volume : -1;
    const downVol = lower < buckets.length - 1 ? buckets[lower + 1].volume : -1;
    if (upVol >= downVol) { upper -= 1; acc += buckets[upper].volume; }
    else { lower += 1; acc += buckets[lower].volume; }
  }

  return {
    buckets,
    poc: buckets[pocIdx].price,
    vah: buckets[upper].price, // highest price in the value area
    val: buckets[lower].price, // lowest price in the value area
    totalVolume: total,
  };
}
