/**
 * A bar without prices (a whitespace gap, which the chart stores as NaN OHLC)
 * inside a profile's session or period. Its NaN reached every Math.max and
 * Math.min it met, so one gap made the session's high, low and range
 * extension NaN, a period it opened lost its range, and a TPO period holding
 * one lost all its letters and the initial balance with them.
 */
import { describe, expect, it } from 'vitest';
import { computeMarketProfile } from '../src/profile/market-profile';
import { computeTpo } from '../src/profile/tpo';
import type { Bar } from '../src/model/bar';

const T0 = 1_709_523_900; // 09:15 IST, a session open
const gap = (time: number): Bar => ({ time, open: NaN, high: NaN, low: NaN, close: NaN });
const bar = (time: number, low: number, high: number): Bar => ({ time, open: low, high, low, close: high, volume: 100 });
// Periods of 30 minutes from 09:15, or from a gap a minute before: 0, 1, 1, 2.
const priced = [bar(T0, 100, 101), bar(T0 + 1800, 100.5, 102), bar(T0 + 2700, 99.5, 101), bar(T0 + 3600, 101, 103)];
const options = { tickSize: 0.5, blockMinutes: 30, initialBalancePeriods: 2 };

describe('market profile: a session with a bar without prices', () => {
  it.each([
    ['opens on', [gap(T0 - 60), ...priced]],
    ['holds', [priced[0]!, gap(T0 + 900), ...priced.slice(1)]],
    ['ends on', [...priced, gap(T0 + 4500)]],
  ])('reads its high, low, balance, open and close from the bars with prices when it %s one', (_, bars) => {
    const [session] = computeMarketProfile(bars, options).sessions;
    expect(session).toMatchObject({
      high: 103, low: 99.5, open: 100, close: 103,
      initialBalance: { high: 102, low: 99.5 },
      rangeExtension: { up: 1, down: 0 },
    });
    for (const period of session!.periodDetail) {
      expect(Number.isFinite(period.high) && Number.isFinite(period.low), `period ${period.index}`).toBe(true);
    }
    expect(session!.dayType).toBeTypeOf('string');
  });

  it('keeps its letters where they were: counted from the session\'s first bar, priced or not', () => {
    // From 09:00 the priced bars fall in periods 0, 1, 2, 2; from 09:15 they would not.
    const [session] = computeMarketProfile([gap(T0 - 900), ...priced], options).sessions;
    expect(session!.startTime).toBe(T0 - 900);
    expect(session!.levels.find(level => level.price === 103)!.letters).toBe('C');
    expect(session!.levels.find(level => level.price === 100)!.letters).toBe('AC');
  });
});

describe('TPO: a period with a bar without prices', () => {
  it('counts the period from its bars with prices, and keeps the initial balance', () => {
    // Periods of two bars: [gap, 100-101], [100.5-102, 99.5-101], [101-103].
    const tpo = computeTpo([gap(T0 - 60), ...priced], 2, 0.5);
    expect(tpo.ib).toEqual({ high: 102, low: 99.5 });
    expect(tpo.buckets.find(b => b.price === 100)!.count).toBe(2);
    expect(tpo.buckets.find(b => b.price === 103)!.count).toBe(1);
  });

  it('takes the balance from the profile when its periods hold no prices at all, as the market profile does', () => {
    const tpo = computeTpo([gap(T0), gap(T0 + 60), gap(T0 + 120), gap(T0 + 180), priced[3]!], 2, 0.5);
    expect(tpo.ib).toEqual({ high: 103, low: 101 });
  });
});
