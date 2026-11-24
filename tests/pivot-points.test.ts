import { describe, it, expect } from 'vitest';
import { indicatorDefaults } from '../src/model/indicator-registry';
import type { IndicatorSettings } from '../src/model/indicator-registry';
import type { Bar } from '../src/model/bar';
import { PIVOT_POINTS, STUDY_INDICATORS } from '../src/indicators/studies';

/** 09:30 IST on the given IST calendar date, in UTC seconds. */
const istMorning = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d, 4) / 1000;

interface Day { date: readonly [number, number, number]; open: number; high: number; low: number; close: number }

/**
 * Six hourly bars per day. The open, the extremes and the close each sit on a
 * different bar, so a level that read the wrong bar of the period cannot land
 * on the right number by accident.
 */
const session = ({ date, open, high, low, close }: Day): Bar[] => {
  const mid = (high + low) / 2;
  const t = istMorning(...date);
  const bar = (i: number, o: number, h: number, l: number, c: number): Bar =>
    ({ time: t + i * 3600, open: o, high: h, low: l, close: c, volume: 100 });
  return [
    bar(0, open, Math.max(open, mid) + 0.5, Math.min(open, mid) - 0.5, mid),
    bar(1, mid, high, mid - 1, mid),
    bar(2, mid, mid + 1, mid - 1, mid),
    bar(3, mid, mid + 1, low, mid),
    bar(4, mid, mid + 1, mid - 1, mid),
    bar(5, mid, Math.max(close, mid) + 0.5, Math.min(close, mid) - 0.5, close),
  ];
};

/** Monday to Thursday. Tuesday is the period whose levels Wednesday carries. */
const DAYS: readonly Day[] = [
  { date: [2024, 1, 1], open: 99, high: 104, low: 96, close: 101 },
  { date: [2024, 1, 2], open: 95, high: 110, low: 90, close: 100 },
  { date: [2024, 1, 3], open: 104, high: 108, low: 98, close: 106 },
  { date: [2024, 1, 4], open: 105, high: 112, low: 101, close: 103 },
];
const bars = DAYS.flatMap(session);
/** First bar of Wednesday: the frame built from Tuesday (95, 110, 90, 100), opening at 104. */
const WED = 12;
const THU = 18;

const settings = (over: IndicatorSettings = {}): IndicatorSettings =>
  ({ ...indicatorDefaults(PIVOT_POINTS), frame: 'daily', show4: true, show5: true, ...over });
const calc = (over: IndicatorSettings = {}, input: readonly Bar[] = bars): Record<string, (number | null)[]> =>
  PIVOT_POINTS.calc(input, settings(over), {}) as Record<string, (number | null)[]>;
const at = (values: Record<string, (number | null)[]>, i: number): Record<string, number | null> =>
  Object.fromEntries(Object.entries(values).map(([k, column]) => [k, column[i] ?? null]));

/** Compare every level of a frame, to the cent: null means the kind has no such level. */
const expectLevels = (got: Record<string, number | null>, want: Record<string, number | null>): void => {
  for (const key of ['p', 's1', 's2', 's3', 's4', 's5', 'r1', 'r2', 'r3', 'r4', 'r5']) {
    const expected = want[key] ?? null;
    if (expected === null) expect(got[key], key).toBeNull();
    else expect(got[key], key).toBeCloseTo(expected, 6);
  }
};

describe('Pivot Points Standard: registration', () => {
  it('is a price-pane study in the studies group', () => {
    expect(STUDY_INDICATORS.map((d) => d.id)).toContain('pivot-points');
    expect(PIVOT_POINTS.placement).toBe('onchart');
    expect(PIVOT_POINTS.plots.map((p) => p.key)).toEqual(['p', 's1', 'r1', 's2', 'r2', 's3', 'r3', 's4', 'r4', 's5', 'r5']);
  });

  it('draws flat levels with a riser at the boundary, not a slope between frames', () => {
    expect(PIVOT_POINTS.plots.every((p) => p.type === 'step')).toBe(true);
  });
});

describe('Pivot Points Standard: the six level sets', () => {
  // Tuesday: open 95, high 110, low 90, close 100. Range 20. Wednesday opens at 104.
  it('traditional', () => {
    expectLevels(at(calc({ kind: 'traditional' }), WED), {
      p: 100, r1: 110, s1: 90, r2: 120, s2: 80, r3: 130, s3: 70, r4: 140, s4: 60, r5: 150, s5: 50,
    });
  });

  it('fibonacci', () => {
    expectLevels(at(calc({ kind: 'fibonacci' }), WED), {
      p: 100, r1: 107.64, s1: 92.36, r2: 112.36, s2: 87.64, r3: 120, s3: 80,
    });
  });

  it('woodie weights the open of the period being traded', () => {
    expectLevels(at(calc({ kind: 'woodie' }), WED), {
      p: 102, r1: 114, s1: 94, r2: 122, s2: 82, r3: 134, s3: 74, r4: 154, s4: 54,
    });
  });

  it('classic', () => {
    expectLevels(at(calc({ kind: 'classic' }), WED), {
      p: 100, r1: 110, s1: 90, r2: 120, s2: 80, r3: 140, s3: 60, r4: 160, s4: 40,
    });
  });

  it('demark picks its sum from how the prior period closed against its open', () => {
    // Tuesday closed above its open: 2H + L + C = 410.
    expectLevels(at(calc({ kind: 'demark' }), WED), { p: 102.5, r1: 115, s1: 95 });
    // Wednesday (104, 108, 98, 106) closed up as well: 2 * 108 + 98 + 106 = 420.
    expectLevels(at(calc({ kind: 'demark' }), THU), { p: 105, r1: 112, s1: 102 });
    // A down close weights the low, an unchanged one the close.
    const down = [...DAYS.slice(0, 1), { ...DAYS[1]!, open: 105 }, ...DAYS.slice(2)].flatMap(session);
    expectLevels(at(calc({ kind: 'demark' }, down), WED), { p: 97.5, r1: 105, s1: 85 });
    const flat = [...DAYS.slice(0, 1), { ...DAYS[1]!, open: 100 }, ...DAYS.slice(2)].flatMap(session);
    expectLevels(at(calc({ kind: 'demark' }, flat), WED), { p: 100, r1: 110, s1: 90 });
  });

  it('demark shows nothing when the prior period has no open to judge by', () => {
    const noOpen = bars.map((b, i) => (i === 6 ? { ...b, open: NaN } : b));
    expectLevels(at(calc({ kind: 'demark' }, noOpen), WED), {});
    // The sets that never read that open are unaffected.
    expectLevels(at(calc({ kind: 'classic' }, noOpen), WED), at(calc({ kind: 'classic' }), WED));
  });

  it('camarilla', () => {
    expectLevels(at(calc({ kind: 'camarilla' }), WED), {
      p: 100,
      r1: 100 + 22 / 12, s1: 100 - 22 / 12,
      r2: 100 + 22 / 6, s2: 100 - 22 / 6,
      r3: 105.5, s3: 94.5,
      r4: 111, s4: 89,
      r5: (110 / 90) * 100, s5: 200 - (110 / 90) * 100,
    });
  });
});

describe('Pivot Points Standard: frames', () => {
  it('holds one frame for every bar of a period', () => {
    const values = calc();
    for (let i = WED; i < THU; i++) expectLevels(at(values, i), at(values, WED));
    expect(values.p![THU]).not.toBe(values.p![WED]);
  });

  it('shows nothing until the history holds a whole prior period', () => {
    const values = calc();
    // Monday may be a slice of its session, so Tuesday has no frame to stand on.
    for (let i = 0; i < WED; i++) expectLevels(at(values, i), {});
  });

  it('never reads the forming period: a tick on the last bar leaves its frame alone', () => {
    const moved = bars.map((b, i) => (i === bars.length - 1 ? { ...b, high: 500, low: 1, close: 250 } : b));
    expectLevels(at(calc({}, moved), bars.length - 1), at(calc(), bars.length - 1));
  });

  it('builds weekly frames on the calendar week', () => {
    const daily: Bar[] = Array.from({ length: 21 }, (_, i) => {
      const c = 100 + i;
      return { time: istMorning(2024, 1, 1) + i * 86400, open: c - 1, high: c + 2, low: c - 2, close: c, volume: 1 };
    });
    const values = calc({ frame: 'weekly' }, daily);
    // Week two is days 7 to 13: high 115, low 105, close 113.
    expect(values.p![13]).toBeNull();
    expect(values.p![14]).toBeCloseTo((115 + 105 + 113) / 3, 6);
    expect(values.p![20]).toBe(values.p![14]);
  });

  it('auto picks a frame coarser than the bars', () => {
    // Hourly bars are past the fifteen-minute line, so they take the week.
    const hourly = calc({ frame: 'auto' });
    expect(hourly.p!.every((v) => v === null)).toBe(true);
    const fine: Bar[] = DAYS.flatMap((day) => session(day).map((b, i) => ({ ...b, time: istMorning(...day.date) + i * 300 })));
    expectLevels(at(calc({ frame: 'auto' }, fine), WED), at(calc({ frame: 'daily' }, fine), WED));
    expect(calc({ frame: 'auto' }, fine).p![WED]).toBe(100);
  });

  it('follows the chart zone for a calendar frame', () => {
    // 31 January 20:00 UTC is still January in New York and already February in IST.
    const t = (d: number, h: number): number => Date.UTC(2024, 0, d, h) / 1000;
    const flat = (time: number, c: number): Bar => ({ time, open: c, high: c + 1, low: c - 1, close: c, volume: 1 });
    const series = [
      flat(Date.UTC(2023, 10, 15, 15) / 1000, 80), flat(Date.UTC(2023, 11, 15, 15) / 1000, 90),
      flat(t(30, 15), 100), flat(t(31, 20), 120), flat(Date.UTC(2024, 1, 1, 15) / 1000, 121),
    ];
    const ist = calc({ frame: 'monthly' }, series);
    const ny = calc({ frame: 'monthly', timezone: 'America/New_York' }, series);
    // IST: the 20:00 bar opens February, so it already carries January's frame (one bar, 100).
    expect(ist.p![3]).toBeCloseTo(100, 6);
    // New York: that bar still belongs to January and carries December's frame.
    expect(ny.p![3]).toBeCloseTo(90, 6);
  });
});

describe('Pivot Points Standard: inputs reach the output', () => {
  it('draws three pairs until the outer two are switched on', () => {
    const row = at(PIVOT_POINTS.calc(bars, { ...indicatorDefaults(PIVOT_POINTS), frame: 'daily' }, {}) as Record<string, (number | null)[]>, WED);
    expect([row.s3, row.r3]).toEqual([70, 130]);
    expect([row.s4, row.r4, row.s5, row.r5]).toEqual([null, null, null, null]);
    // A settings blob without the keys, as a host passing `{}` sends, reads the same.
    const bare = at(PIVOT_POINTS.calc(bars, { frame: 'daily' }, {}) as Record<string, (number | null)[]>, WED);
    expect([bare.r3, bare.r4]).toEqual([130, null]);
  });

  it('hides a level pair, and the pivot, on request', () => {
    const values = calc({ showP: false, show2: false });
    const row = at(values, WED);
    expect(row.p).toBeNull();
    expect(row.s2).toBeNull();
    expect(row.r2).toBeNull();
    expect(row.s1).toBe(90);
    expect(row.r3).toBe(130);
  });

  it('a nonfinite extreme invalidates that period only', () => {
    const broken = bars.map((b, i) => (i === 8 ? { ...b, high: NaN } : b));
    const values = calc({}, broken);
    expectLevels(at(values, WED), {});
    expectLevels(at(values, THU), at(calc(), THU));
  });
});
