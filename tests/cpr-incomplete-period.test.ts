import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/model/bar';
import { indicatorDefaults } from '../src/model/indicator-registry';
import { CPR } from '../src/indicators/studies';

type Period = 'daily' | 'weekly' | 'monthly';
const prefixes = { daily: 'd', weekly: 'w', monthly: 'm' };
const levels = ['Pivot', 'S1', 'S2', 'S3', 'R1', 'R2', 'R3', 'Bc', 'Tc'];
const ordinary = [35, -30, -65, -130, 70, 135, 170, 50, 20];
// Complete next period: high7, low4, final close5, pivot16/3.
const recovered = [
  5.333333333333333, 3.666666666666666, 2.333333333333333,
  0.6666666666666661, 6.666666666666666, 8.333333333333332,
  9.666666666666666, 5.5, 5.166666666666666,
];

/**
 * Observation 0 is the tail of the period before, which is all the history
 * holds of it, so its absurd range must never reach a level. Observations 1 to
 * 3 are the first period whose start the history covers, 4 and 5 the two after.
 */
function observations(period: Period): Bar[] {
  const dates = period === 'daily'
    ? [[0, 1, 9], [0, 2, 9], [0, 2, 10], [0, 2, 11], [0, 3, 9], [0, 4, 9]]
    : period === 'weekly'
      ? [[-1, 29, 9], [0, 1, 9], [0, 2, 9], [0, 3, 9], [0, 8, 9], [0, 15, 9]]
      : [[-1, 29, 9], [0, 2, 9], [0, 3, 9], [0, 4, 9], [1, 2, 9], [2, 2, 9]];
  return dates.map(([month, day, hour], i) => ({
    time: Date.UTC(2024, month, day, hour) / 1000,
    open: 5, high: [1000, 100, 20, 10, 7, 7][i], low: [-1000, 0, 1, 2, 4, 4][i], close: 5,
  }));
}

function run(bars: readonly Bar[], period: Period) {
  return CPR.calc(bars, {
    ...indicatorDefaults(CPR), pivotMode: 'manual', timezone: 'UTC', displayS1R1: true,
    showDaily: period === 'daily', showWeekly: period === 'weekly', showMonthly: period === 'monthly',
  }, {});
}

function readings(bars: readonly Bar[], period: Period, index: number) {
  const values = run(bars, period);
  return levels.map(level => values[prefixes[period] + level][index]);
}

for (const period of ['daily', 'weekly', 'monthly'] as const) {
  describe(`CPR incomplete ${period} observations`, () => {
    it('preserves all ordinary levels and the warmup through the first covered period', () => {
      const bars = observations(period), values = run(bars, period);
      for (const level of levels) expect(values[prefixes[period] + level].slice(0, 4)).toEqual([null, null, null, null]);
      expect(readings(bars, period, 4)).toEqual(ordinary);
      expect(readings(bars, period, 5)).toEqual(recovered);
      for (const prefix of Object.values(prefixes).filter(p => p !== prefixes[period])) {
        for (const level of levels) expect(values[prefix + level]).toEqual(Array(6).fill(null));
      }
    });

    for (const field of ['high', 'low'] as const) {
      for (const position of [1, 2, 3]) {
        it.each([NaN, Infinity, -Infinity])(`keeps ${field} unavailable from observation ${position} until the next boundary (%s)`, missing => {
          const bars = observations(period);
          bars[position][field] = missing;
          expect(readings(bars, period, 4)).toEqual(Array(9).fill(null));
          expect(readings(bars, period, 5)).toEqual(recovered);
        });
      }
    }

    it.each([NaN, Infinity, -Infinity])('uses the final close after an earlier unavailable close (%s)', missing => {
      const bars = observations(period);
      bars[1].close = missing;
      bars[2].close = missing;
      expect(readings(bars, period, 4)).toEqual(ordinary);
    });

    it.each([NaN, Infinity, -Infinity])('withholds all nine levels when the final close is unavailable (%s)', missing => {
      const bars = observations(period);
      bars[3].close = missing;
      expect(readings(bars, period, 4)).toEqual(Array(9).fill(null));
      expect(readings(bars, period, 5)).toEqual(recovered);
    });

    it('does not change the frozen prior frame when the current period is incomplete', () => {
      const bars = observations(period);
      bars[4].high = NaN;
      expect(readings(bars, period, 4)).toEqual(ordinary);
      expect(readings(bars, period, 5)).toEqual(Array(9).fill(null));
    });

    it('recomputes a corrected observation without caching the incomplete frame', () => {
      const bars = observations(period);
      bars[2].high = NaN;
      expect(readings(bars, period, 4)).toEqual(Array(9).fill(null));
      bars[2].high = 20;
      expect(readings(bars, period, 4)).toEqual(ordinary);
      bars[2].high = NaN;
      expect(readings(bars, period, 4)).toEqual(Array(9).fill(null));
    });

    it('keeps prefix results stable and does not mutate observations', () => {
      const bars = observations(period);
      bars[2].high = NaN;
      bars.forEach(Object.freeze);
      Object.freeze(bars);
      const full = run(bars, period);
      for (let end = 1; end <= bars.length; end++) {
        const prefix = run(bars.slice(0, end), period);
        for (const key of Object.keys(full)) expect(prefix[key]).toEqual(full[key].slice(0, end));
      }
    });
  });
}

// ── history that begins inside a period ──────────────────────────────────────

/** One in 2^31, Park and Miller, so the walk is the same on every run. */
function walk(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * Five-minute NSE sessions, 09:15 to 15:30 IST, on the weekdays from Monday
 * 4 March 2024, as a random walk round 1000.
 */
function nseFiveMinute(days: number): Bar[] {
  const rnd = walk(21);
  const out: Bar[] = [];
  let close = 1000;
  for (let day = Date.UTC(2024, 2, 4) / 1000; out.length < days * 75; day += 86400) {
    if ([0, 6].includes(new Date(day * 1000).getUTCDay())) continue;
    for (let k = 0; k < 75; k++) {
      const open = close;
      close = Math.round(open * (1 + (rnd() - 0.5) * 0.004) * 20) / 20;
      out.push({
        time: day + 3 * 3600 + 45 * 60 + k * 300, open, close,
        high: Math.round(Math.max(open, close) * (1 + rnd() * 0.001) * 20) / 20,
        low: Math.round(Math.min(open, close) * (1 - rnd() * 0.001) * 20) / 20,
      });
    }
  }
  return out;
}

/** IST wall clock of a bar, `2024-03-20T09:15`. */
const ist = (bar: Bar): string => new Date((bar.time + 19800) * 1000).toISOString().slice(0, 16);

describe('CPR on a history that begins inside a period', () => {
  const all = nseFiveMinute(50);
  // History cut 40 bars into the first session, on a Thursday, and on the 20th:
  // the first period loaded is a slice of the real one.
  const cuts: readonly (readonly [Period, string])[] = [
    ['daily', '2024-03-04T12:35'], ['weekly', '2024-03-07T09:15'], ['monthly', '2024-03-20T09:15'],
  ];

  for (const [period, from] of cuts) {
    it(`prints no ${period} level from the partial first period, and the full history's level everywhere else`, () => {
      const start = all.findIndex(bar => ist(bar) === from);
      expect(start).toBeGreaterThan(0);
      const cut = all.slice(start);
      const full = run(all, period);
      const part = run(cut, period);
      // The second loaded period would carry the partial first one's frame; the
      // third is the first whose previous period the history covers.
      const [second, third] = cut.map((_, i) => i).filter(i => i > 0 && isBoundary(cut, i, period));
      expect(second, 'a second period').toBeDefined();
      expect(third, 'a third period').toBeDefined();
      for (const level of levels) {
        const key = prefixes[period] + level;
        expect(part[key].slice(0, third), key).toEqual(Array(third).fill(null));
        expect(part[key][third], key).not.toBeNull();
        // Wherever the cut history prints, loading the earlier bars changes nothing.
        part[key].forEach((value, i) => {
          if (value !== null) expect(value, `${key} at ${ist(cut[i]!)}`).toBe(full[key][start + i]);
        });
      }
    });
  }
});

/** Whether bar `i` opens a new frame, read the way the study reads it: a new IST day, Monday-based week or month. */
function isBoundary(bars: readonly Bar[], i: number, period: Period): boolean {
  const a = ist(bars[i - 1]!);
  const b = ist(bars[i]!);
  if (period === 'daily') return a.slice(0, 10) !== b.slice(0, 10);
  if (period === 'monthly') return a.slice(0, 7) !== b.slice(0, 7);
  const monday = (s: string): number => {
    const t = Date.parse(`${s.slice(0, 10)}T00:00:00Z`) / 86400000;
    return Math.floor((t + 3) / 7);
  };
  return monday(a) !== monday(b);
}
