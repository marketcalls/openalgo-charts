import { describe, expect, it } from 'vitest';
import { getSeriesTransform, type Bar } from '../src/index';
import {
  registerTransformChartTypes, runTransform, HeikinAshiTransform, RenkoTransform, RangeBarsTransform, LineBreakTransform,
  PointFigureTransform, KagiTransform, type ISeriesTransform, type PointFigureColumn,
} from '../src/transform/index';

registerTransformChartTypes();

const T0 = 1_700_000_000;
const flat = (closes: number[]): Bar[] => closes.map((c, i) => ({ time: T0 + i * 60, open: c, high: c, low: c, close: c, volume: 1 }));
const ohlc = (rows: number[][]): Bar[] => rows.map(([o, h, l, c], i) => ({ time: T0 + i * 60, open: o!, high: h!, low: l!, close: c! }));
/** The double a host sends for a decimal price. */
const decimal = (x: number): number => Number(x.toFixed(10));

describe('I4: Renko on a decimal box', () => {
  it.each([[0.05, 250, 200], [0.1, 100, 100], [0.2, 99.6, 60], [0.3, 30, 50]])(
    'box %d: one brick for every exact one-box move from %d, on clean prices',
    (box, start, steps) => {
      const up = Array.from({ length: steps + 1 }, (_, i) => decimal(start + i * box));
      const down = up.slice(0, -1).reverse();
      const bricks = runTransform(new RenkoTransform({ boxSize: box }), flat([...up, ...down]));
      // Single-box reversal is the documented rule: the way back down is one brick a box too.
      expect(bricks).toHaveLength(2 * steps);
      expect(bricks[steps - 1]!.close).toBe(up[steps]);
      expect(bricks[bricks.length - 1]!.close).toBe(up[0]);
      for (const b of bricks) {
        expect(b.open).toBe(decimal(b.open));
        expect(b.close).toBe(decimal(b.close));
      }
    },
  );

  it('still reverses after a single box', () => {
    const bricks = runTransform(new RenkoTransform({ boxSize: 10 }), flat([100, 121, 110, 100]));
    expect(bricks.map(b => [b.open, b.close])).toEqual([[100, 110], [110, 120], [120, 110], [110, 100]]);
  });
});

describe('I5: point and figure reads a box as reached only when price reaches its value', () => {
  const pf = (rows: number[][], options = {}): PointFigureColumn[] =>
    runTransform(new PointFigureTransform({ boxSize: 1, reversal: 3, ...options }), ohlc(rows)) as PointFigureColumn[];

  it('opens an O column only once the low reaches the third box down', () => {
    // An X column at 20: a low of 17.99 has not reached 17.
    const held = pf([[18, 18, 18, 18], [18, 20, 18, 20], [19.5, 19.5, 17.99, 18.5]]);
    expect(held.map(c => [c.low, c.high, c.boxes])).toEqual([[18, 21, 3]]);
    const turned = pf([[18, 18, 18, 18], [18, 20, 18, 20], [19.5, 19.5, 17, 18.5]]);
    expect(turned.map(c => [c.low, c.high, c.boxes])).toEqual([[18, 21, 3], [17, 20, 3]]);
  });

  it('fills an O box only when the low reaches it, so the reversal up is counted from there', () => {
    // A low of 10.5 reaches 11, not 10: turning up needs 14, not 13.
    const held = pf([[14, 14, 14, 14], [14, 14, 10.5, 10.5], [11, 13, 11, 13]]);
    expect(held.map(c => [c.low, c.high, c.boxes])).toEqual([[11, 15, 4]]);
    const turned = pf([[14, 14, 14, 14], [14, 14, 10.5, 10.5], [11, 14, 11, 14]]);
    expect(turned.map(c => [c.low, c.high, c.boxes])).toEqual([[11, 15, 4], [12, 15, 3]]);
  });

  it('counts a decimal box that is touched exactly', () => {
    // floor(100.3 / 0.1) is 1002: the touch of 100.3 used to miss its box.
    const up = pf([[100, 100, 100, 100], [100, 100.3, 100, 100.3]], { boxSize: 0.1 });
    expect(up.map(c => c.boxes)).toEqual([4]);
    expect(up[0]!.high).toBeCloseTo(100.4, 9);
    const down = pf([[100, 100, 100, 100], [100, 100, 99.7, 99.7]], { boxSize: 0.1 });
    expect(down.map(c => c.boxes)).toEqual([4]);
    expect(down[0]!.low).toBeCloseTo(99.7, 9);
    // And three exact boxes of 0.1 against an X column reverse it.
    const turned = pf([[100, 100, 100, 100], [100, 100.5, 100, 100.5], [100.4, 100.4, 100.2, 100.2]], { boxSize: 0.1 });
    expect(turned.map(c => c.close > c.open)).toEqual([true, false]);
  });
});

describe('I7: Kagi thickness on the bar that reverses the line', () => {
  const flags = (closes: number[]): number[][] =>
    runTransform(new KagiTransform({ reversal: 5 }), flat(closes)).map(v => [v.close, v.volume!]);

  it('turns thin when the reversal bar itself breaks the prior waist, and thick on a shoulder', () => {
    expect(flags([100, 110, 104, 112, 100, 101, 106])).toEqual([[110, 1], [104, 0], [112, 1], [100, 0], [106, 0]]);
    expect(flags([100, 90, 96, 91, 103, 102, 97])).toEqual([[100, 0], [90, 0], [96, 0], [91, 0], [103, 1], [97, 1]]);
  });

  it('gives the same flags whether the level breaks on the reversal bar or the bar after', () => {
    expect(flags([100, 110, 104, 112, 100, 101, 106])).toEqual(flags([100, 110, 104, 112, 105, 100, 101, 106]));
    expect(flags([100, 90, 96, 91, 103, 102, 97])).toEqual(flags([100, 90, 96, 91, 96, 103, 102, 97]));
  });
});

/** A zigzag that turns every ten bars, wide from bar 10 on, so ATR sizing has to move. */
function zigzag(n = 120): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const leg = Math.floor(i / 10), k = i % 10;
    const c = 100 + (leg % 2 === 0 ? k : 10 - k) * 6;
    const w = i < 10 ? 1 : 5;
    return { time: T0 + i * 60, open: c, high: c + w, low: c - w, close: c, volume: 100 };
  });
}
const whitespace = (b: Bar): Bar => ({ time: b.time, open: NaN, high: NaN, low: NaN, close: NaN });

type Make = [name: string, make: () => ISeriesTransform];
const MAKES: Make[] = [
  ['renko fixed', () => new RenkoTransform({ boxSize: 4 })],
  ['renko atr', () => new RenkoTransform({ mode: 'atr', atrPeriod: 3 })],
  ['renko percent hl', () => new RenkoTransform({ mode: 'percent', percent: 2, method: 'hl' })],
  ['point-figure fixed', () => new PointFigureTransform({ boxSize: 4, reversal: 3 })],
  ['point-figure atr', () => new PointFigureTransform({ mode: 'atr', atrPeriod: 3, reversal: 2 })],
  ['point-figure close', () => new PointFigureTransform({ boxSize: 4, reversal: 2, method: 'close' })],
  ['range-bars', () => new RangeBarsTransform({ range: 10 })],
  ['line-break', () => new LineBreakTransform({ lines: 3 })],
  ['kagi', () => new KagiTransform({ reversal: 8 })],
];

describe('N08, N09: a bar without a price is a gap, not a value', () => {
  it('sizes ATR Renko again from the bars after one without a high', () => {
    const rising = Array.from({ length: 80 }, (_, i): Bar => {
      const c = 100 + i * 2, w = i < 10 ? 1 : 5;
      return { time: i * 60, open: c, high: c + w, low: c - w, close: c, volume: 100 };
    });
    const holed = rising.map((b, i) => (i === 10 ? { ...b, high: NaN } : b));
    const bricks = runTransform(new RenkoTransform({ mode: 'atr', atrPeriod: 3 }), holed);
    for (const b of bricks.slice(-10)) expect(b.high - b.low).toBeGreaterThan(9);
  });

  it('keeps completing range bars after a whitespace bar, with no NaN in any of them', () => {
    const rising = Array.from({ length: 80 }, (_, i): Bar => ({ time: i * 60, open: 100 + i * 2, high: 101 + i * 2, low: 99 + i * 2, close: 100 + i * 2, volume: 100 }));
    const gapped = rising.map((b, i) => (i === 10 ? { ...whitespace(b), volume: 100 } : b));
    const out = runTransform(new RangeBarsTransform({ range: 2 }), gapped);
    for (const b of out) expect([b.open, b.high, b.low, b.close].every(Number.isFinite)).toBe(true);
    expect(out.filter(b => b.time > 600).length).toBeGreaterThan(30);
  });

  it.each(MAKES)('%s: skips a gap as if the bar were not there', (_name, make) => {
    const bars = zigzag();
    for (const holes of [[0], [1], [2], [10, 25], [37, 38, 39]]) {
      const gapped = bars.map((b, i) => (!holes.includes(i) ? b : i === 25 ? { ...b, high: NaN } : whitespace(b)));
      const kept = bars.filter((_, i) => !holes.includes(i));
      expect(runTransform(make(), gapped)).toEqual(runTransform(make(), kept));
    }
  });
});

describe('Heikin Ashi across a gap', () => {
  it('keeps an empty candle for the gap and carries on from the candle before it', () => {
    const bars = zigzag(40);
    const gapped = bars.map((b, i) => (i === 12 ? whitespace(b) : b));
    const out = runTransform(new HeikinAshiTransform(), gapped);
    expect(out).toHaveLength(bars.length);
    expect(out[12]).toEqual(whitespace(bars[12]!));
    const kept = runTransform(new HeikinAshiTransform(), bars.filter((_, i) => i !== 12));
    expect(out.filter((_, i) => i !== 12)).toEqual(kept);
  });
});

describe('a gap in a live run', () => {
  const SPECS: [string, Record<string, number | string>, () => ISeriesTransform][] = [
    ['heikin-ashi', {}, () => new HeikinAshiTransform()],
    ['renko', { mode: 'atr', atrPeriod: 3 }, () => new RenkoTransform({ mode: 'atr', atrPeriod: 3 })],
    ['range-bars', { range: 10 }, () => new RangeBarsTransform({ range: 10 })],
    ['line-break', { lines: 3 }, () => new LineBreakTransform({ lines: 3 })],
    ['point-figure', { boxSize: 4, reversal: 2 }, () => new PointFigureTransform({ boxSize: 4, reversal: 2 })],
    ['kagi', { reversal: 8 }, () => new KagiTransform({ reversal: 8 })],
  ];

  it.each(SPECS)('%s: the forming bar and history with gaps still equal the batch run', (type, options, make) => {
    const bars = zigzag().map((b, i) => (i === 0 || i === 30 ? whitespace(b) : b));
    const run = getSeriesTransform(type).create(options);
    run.setData(bars.slice(0, 40));
    expect(run.elements()).toEqual(runTransform(make(), bars.slice(0, 40)));
    for (let i = 40; i < bars.length; i++) {
      // A forming bar that is a gap on its first tick, then priced.
      run.update(whitespace(bars[i]!));
      expect(run.elements()).toEqual(runTransform(make(), [...bars.slice(0, i), whitespace(bars[i]!)]));
      run.update(bars[i]!);
      expect(run.elements()).toEqual(runTransform(make(), bars.slice(0, i + 1)));
    }
  });
});
