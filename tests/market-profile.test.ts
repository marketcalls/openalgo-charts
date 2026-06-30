import { describe, it, expect } from 'vitest';
import { computeMarketProfile, tpoLetter } from '../src/profile/market-profile';
import { istStringToUtcSeconds } from '../src/feed/time';
import type { Bar } from '../src/model/bar';

const bar = (time: number, low: number, high: number, volume = 100): Bar => ({
  time, open: low, high, low, close: high, volume,
});

describe('TPO letters', () => {
  it('maps period index to A-Z then a-z and wraps', () => {
    expect(tpoLetter(0)).toBe('A');
    expect(tpoLetter(25)).toBe('Z');
    expect(tpoLetter(26)).toBe('a');
    expect(tpoLetter(51)).toBe('z');
    expect(tpoLetter(52)).toBe('A');
  });
});

describe('computeMarketProfile', () => {
  // Two 30-minute periods in one IST day, tick = 1.
  const t0 = istStringToUtcSeconds('2024-01-15 09:15:00');
  const bars = [
    bar(t0, 100, 110),          // period 0 (A): 100..110
    bar(t0 + 1800, 105, 110),   // period 1 (B): 105..110
  ];

  it('builds one day session with letters, POC, IB and value area', () => {
    const { sessions } = computeMarketProfile(bars, { tickSize: 1, session: 'day', blockMinutes: 30, initialBalancePeriods: 2 });
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.periods).toBe(2);
    // Top level 110 was touched by both periods -> "AB".
    expect(s.levels[0].price).toBe(110);
    expect(s.levels[0].letters).toBe('AB');
    // Initial balance spans both periods' range.
    expect(s.initialBalance).toEqual({ high: 110, low: 100 });
    // VAH >= POC >= VAL by price.
    expect(s.vah).toBeGreaterThanOrEqual(s.poc);
    expect(s.poc).toBeGreaterThanOrEqual(s.val);
  });

  it('flags poor highs and single prints', () => {
    const { sessions } = computeMarketProfile(bars, { tickSize: 1, session: 'day', blockMinutes: 30 });
    const s = sessions[0];
    // 110 printed two TPOs -> weak (poor) high; 100 printed one -> not a poor low.
    expect(s.poorHigh).toBe(true);
    expect(s.poorLow).toBe(false);
    // 101..104 are lone TPOs away from the extremes.
    expect(s.singlePrints).toContain(102);
    expect(s.singlePrints).not.toContain(100); // bottom extreme excluded
  });

  it('segments sessions by IST day', () => {
    const day2 = istStringToUtcSeconds('2024-01-16 09:15:00');
    const multi = [...bars, bar(day2, 120, 125), bar(day2 + 1800, 121, 126)];
    const { sessions } = computeMarketProfile(multi, { tickSize: 1, session: 'day', blockMinutes: 30 });
    expect(sessions).toHaveLength(2);
    expect(sessions[1].levels[0].price).toBe(126);
  });

  it('composite mode builds a single profile over all bars', () => {
    const day2 = istStringToUtcSeconds('2024-01-16 09:15:00');
    const multi = [...bars, bar(day2, 120, 125)];
    const { sessions } = computeMarketProfile(multi, { tickSize: 1, session: 'composite', blockMinutes: 30 });
    expect(sessions).toHaveLength(1);
  });

  it('distributes volume across the price range', () => {
    const { sessions } = computeMarketProfile([bar(t0, 100, 104, 500)], { tickSize: 1, session: 'day' });
    const s = sessions[0];
    const totalVol = s.levels.reduce((sum, l) => sum + l.volume, 0);
    expect(Math.round(totalVol)).toBe(500);
    expect(s.totalVolume).toBe(500);
  });
});
