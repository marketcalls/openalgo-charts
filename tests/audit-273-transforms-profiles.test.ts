import { describe, expect, it } from 'vitest';
import { bucketPrice, priceBuckets } from '../src/profile/profile-model';
import { computeVolumeProfile } from '../src/profile/volume-profile';
import { computeTpo } from '../src/profile/tpo';
import { computeVolumeProfileSessions } from '../src/profile/volume-profile-family';
import { computeMarketProfile, rowOf, DEFAULT_MARKET_PROFILE_OPTIONS } from '../src/profile/market-profile';
import { footprintRowPrice } from '../src/profile/footprint';
import type { Bar } from '../src/model/bar';

/** `ticks` whole ticks as a host sends the price: the double nearest the decimal. */
const price = (ticks: number, tick: number): number => Number((ticks * tick).toFixed(10));

/** The row of whole tick `t`, counted in integers: a tick exactly between two row centres belongs to the upper row. */
const rowOfTick = (t: number, rowTicks: number): number => Math.floor((2 * t + rowTicks) / (2 * rowTicks));

/** A seeded walk on whole ticks, so the expected rows can be counted in integers. */
function tickWalk(seed: number, base: number, spread: number, n = 375): { bars: Bar[]; low: number[]; high: number[] } {
  let s = seed >>> 0 || 1;
  const next = (): number => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0xffffffff; };
  const bars: Bar[] = [], low: number[] = [], high: number[] = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const o = p, c = o + Math.round((next() - 0.5) * spread);
    const h = Math.max(o, c) + Math.floor(next() * spread / 2), l = Math.min(o, c) - Math.floor(next() * spread / 2);
    low.push(l); high.push(h);
    bars.push({ time: 1_709_523_900 + i * 60, open: o, high: h, low: l, close: c, volume: 1000 });
    p = c;
  }
  return { bars, low, high };
}

describe('I2: profile rows on a decimal row size', () => {
  // 100.15 / 0.1 is 1001.4999999999999 and 100.45 / 0.1 is 1004.5000000000001, so a plain
  // round sent half-row prices one way or the other by binary accident.
  it('puts every half-row price in the upper row, whichever way the division rounds', () => {
    expect([100.05, 100.15, 100.25, 100.35, 100.45, 100.55].map(p => bucketPrice(p, 0.1)))
      .toEqual([100.1, 100.2, 100.3, 100.4, 100.5, 100.6]);
  });

  it.each([
    [0.05, 2, 2000], [0.05, 4, 2000], [0.01, 10, 18000], [0.01, 20, 18000],
    [0.0001, 10, 10800], [0.05, 20, 440000], [0.1, 20, 220000], [0.05, 3, 2000],
  ])('buckets each tick as whole-tick counting does: tick %d, %d ticks a row, from tick %d', (tick, rowTicks, from) => {
    const row = price(rowTicks, tick);
    const perRow = new Map<number, number>();
    for (let t = from; t <= from + 40 * rowTicks; t++) {
      const got = bucketPrice(price(t, tick), row);
      expect(got).toBe(price(rowOfTick(t, rowTicks) * rowTicks, tick));
      perRow.set(got, (perRow.get(got) ?? 0) + 1);
    }
    // The rows strictly inside the walk all hold the same number of ticks.
    const counts = [...perRow.values()].slice(1, -1);
    expect(new Set(counts)).toEqual(new Set([rowTicks]));
  });

  it('gives every 0.10 row of a flat 0.05 tape the same volume', () => {
    const bars: Bar[] = [];
    for (let t = 2000; t <= 2200; t++) {
      const p = price(t, 0.05);
      bars.push({ time: t * 60, open: p, high: p, low: p, close: p, volume: 100 });
    }
    const vp = computeVolumeProfile(bars, 0.1);
    // 100.00 is the lowest row and holds 100.00 alone: 99.95 never traded.
    expect(vp.buckets[vp.buckets.length - 1]).toEqual({ price: 100, volume: 100 });
    expect(new Set(vp.buckets.slice(0, -1).map(b => b.volume))).toEqual(new Set([200]));
  });

  it.each([[0.05, 2, 2000, 6], [0.05, 4, 2000, 10], [0.01, 10, 18000, 30], [0.0001, 10, 10800, 30]])(
    'agrees with whole-tick bucketing in every profile: tick %d, %d ticks a row',
    (tick, rowTicks, base, spread) => {
      const row = price(rowTicks, tick);
      for (let seed = 1; seed <= 12; seed++) {
        const { bars, low, high } = tickWalk(seed, base, spread);
        const priced = bars.map(b => ({ ...b, open: price(b.open, tick), high: price(b.high, tick), low: price(b.low, tick), close: price(b.close, tick) }));
        const volume = new Map<number, number>();
        const tpos = new Map<number, Set<number>>();
        bars.forEach((_, i) => {
          const a = rowOfTick(low[i]!, rowTicks), z = rowOfTick(high[i]!, rowTicks);
          for (let r = a; r <= z; r++) {
            const p = price(r * rowTicks, tick);
            volume.set(p, (volume.get(p) ?? 0) + 1000 / (z - a + 1));
            if (!tpos.has(p)) tpos.set(p, new Set());
            tpos.get(p)!.add(Math.floor(i / 30));
          }
        });
        const rows = [...volume.keys()].sort((x, y) => y - x);

        const vp = computeVolumeProfile(priced, row);
        expect(vp.buckets.map(b => b.price)).toEqual(rows);
        vp.buckets.forEach(b => expect(b.volume).toBeCloseTo(volume.get(b.price)!, 6));

        const vs = computeVolumeProfileSessions(priced, { tickSize: row, session: 'composite' }).sessions[0]!;
        expect(vs.levels.map(l => l.price)).toEqual(rows);

        const tpo = computeTpo(priced, 30, row);
        expect(tpo.buckets.map(b => [b.price, b.count])).toEqual(rows.map(p => [p, tpos.get(p)!.size]));

        const mp = computeMarketProfile(priced, { tickSize: tick, rowTicks, session: 'composite', blockMinutes: 30 }).sessions[0]!;
        expect(mp.levels.map(l => [l.price, l.count])).toEqual(rows.map(p => [p, tpos.get(p)!.size]));
      }
    },
  );

  it('rounds a price onto the market profile row the profile counts it in', () => {
    const options = { ...DEFAULT_MARKET_PROFILE_OPTIONS, tickSize: 0.05, rowTicks: 2 };
    expect([100.15, 100.25, 100.35, 100.45].map(p => rowOf(p, options))).toEqual([100.2, 100.3, 100.4, 100.5]);
  });
});

describe('profile rows and footprint rows', () => {
  // The two share the row grid and differ, by design, only on a tick exactly between two row
  // centres: the profile sends it up, so every row spans the same ticks; the footprint sends it
  // to the even row, the reference order flow convention.
  it.each([1, 2, 3, 4, 5, 20, 40])('put every tick off a row boundary in the same row: %d ticks a row', (rowTicks) => {
    const options = { ...DEFAULT_MARKET_PROFILE_OPTIONS, tickSize: 0.05, rowTicks };
    for (let t = 440_000; t <= 440_000 + 6 * rowTicks; t++) {
      const p = price(t, 0.05);
      const boundary = rowTicks % 2 === 0 && t % rowTicks === rowTicks / 2;
      if (boundary) {
        expect(rowOf(p, options)).toBe(price(rowOfTick(t, rowTicks) * rowTicks, 0.05));
      } else {
        expect(rowOf(p, options)).toBe(footprintRowPrice(p, 0.05, rowTicks));
      }
    }
  });
});

describe('N07: rows finer than 1e-8', () => {
  it('keeps rows of 1e-9 apart instead of rounding them all to 0', () => {
    expect(bucketPrice(4e-9, 1e-9)).toBe(4e-9);
    expect(priceBuckets(1e-9, 4e-9, 1e-9)).toEqual([1e-9, 2e-9, 3e-9, 4e-9]);
    const vp = computeVolumeProfile([{ time: 0, open: 2e-9, high: 4e-9, low: 1e-9, close: 3e-9, volume: 400 }], 1e-9);
    expect(vp.buckets).toEqual([4e-9, 3e-9, 2e-9, 1e-9].map(p => ({ price: p, volume: 100 })));
    expect(vp.poc).toBe(4e-9);
  });

  it('keeps the rows of an ordinary step exactly as they were', () => {
    expect(priceBuckets(100, 100.2, 0.05)).toEqual([100, 100.05, 100.1, 100.15, 100.2]);
    expect(bucketPrice(100.003, 0.05)).toBe(100);
    expect(bucketPrice(24000.7, 2)).toBe(24000);
  });
});

describe('I8: a profile bar whose volume is not a number', () => {
  const t0 = 1_705_290_300;
  const bars: Bar[] = Array.from({ length: 20 }, (_, i) => {
    const c = 1000 + Math.round(Math.sin(i / 2) * 6);
    return { time: t0 + i * 300, open: c - 1, high: c + 2, low: c - 3, close: c, volume: 100 + i * 7 };
  });
  const without = bars.map((b, i) => {
    if (i !== 7) return b;
    const { volume: _volume, ...rest } = b;
    return rest;
  });

  it.each([NaN, Infinity, -50])('reads %d as no volume, like an absent one', (bad) => {
    const holed = bars.map((b, i) => (i === 7 ? { ...b, volume: bad } : b));
    const vp = computeVolumeProfile(holed, 1);
    expect(Number.isFinite(vp.totalVolume)).toBe(true);
    expect(vp).toEqual(computeVolumeProfile(without, 1));
    expect(computeVolumeProfileSessions(holed, { tickSize: 1, session: 'day' }))
      .toEqual(computeVolumeProfileSessions(without, { tickSize: 1, session: 'day' }));
    expect(computeMarketProfile(holed, { tickSize: 1, session: 'day' }))
      .toEqual(computeMarketProfile(without, { tickSize: 1, session: 'day' }));
  });
});
