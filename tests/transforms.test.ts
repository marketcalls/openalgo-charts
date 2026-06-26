import { describe, it, expect } from 'vitest';
import '../src/transform/index'; // side effect: registers point-figure & kagi renderers
import { runTransform, ensureIncreasingTimes } from '../src/transform/transform';
import { HeikinAshiTransform } from '../src/transform/heikin-ashi';
import { RenkoTransform } from '../src/transform/renko';
import { RangeBarsTransform } from '../src/transform/range-bars';
import { LineBreakTransform } from '../src/transform/line-break';
import { PointFigureTransform } from '../src/transform/point-figure';
import { KagiTransform } from '../src/transform/kagi';
import { getChartType, type DrawItem } from '../src/model/chart-type-registry';
import type { Bar } from '../src/model/bar';
import { makeCtx } from './helpers/fake-ctx';

let T = 1000;
const closes = (cs: number[]): Bar[] => cs.map((c) => ({ time: T++, open: c, high: c + 0.0, low: c - 0.0, close: c }));
const ohlc = (o: number, h: number, l: number, c: number, t = T++): Bar => ({ time: t, open: o, high: h, low: l, close: c });
const oc = (b: Bar): [number, number] => [b.open, b.close];

describe('ensureIncreasingTimes', () => {
  it('bumps colliding times to keep one logical index per element', () => {
    const out = ensureIncreasingTimes([
      { time: 100, open: 1, high: 1, low: 1, close: 1 },
      { time: 100, open: 2, high: 2, low: 2, close: 2 },
      { time: 100, open: 3, high: 3, low: 3, close: 3 },
    ]);
    expect(out.map((b) => b.time)).toEqual([100, 101, 102]);
  });
});

describe('Heikin Ashi', () => {
  it('applies the HA formula (first bar seeds haOpen)', () => {
    const out = runTransform(new HeikinAshiTransform(), [ohlc(10, 12, 8, 11, 1)]);
    expect(out[0]).toMatchObject({ open: 10.5, close: 10.25, high: 12, low: 8 });
  });
  it('is 1:1 with input bars', () => {
    const bars = [ohlc(10, 12, 8, 11, 1), ohlc(11, 13, 9, 10, 2), ohlc(10, 11, 9, 10, 3)];
    expect(runTransform(new HeikinAshiTransform(), bars)).toHaveLength(3);
  });
});

describe('Renko', () => {
  it('emits one brick per box-size move, with directions', () => {
    T = 1;
    const out = runTransform(new RenkoTransform({ boxSize: 1 }), closes([100, 100.5, 102, 101, 98.5]));
    expect(out).toHaveLength(5); // 2 up, 1 down, 2 down
    expect(out[0].close).toBeGreaterThan(out[0].open); // up brick
    expect(out[2].close).toBeLessThan(out[2].open); // down brick
  });

  it('completed bricks are stable as more data arrives (incremental == batch prefix)', () => {
    T = 1; const prefix = runTransform(new RenkoTransform({ boxSize: 1 }), closes([100, 100.5, 102]));
    T = 1; const full = runTransform(new RenkoTransform({ boxSize: 1 }), closes([100, 100.5, 102, 101, 98.5]));
    expect(prefix.map(oc)).toEqual(full.slice(0, prefix.length).map(oc));
  });
});

describe('Range bars', () => {
  it('completes a bar when high-low reaches the range', () => {
    T = 1;
    const out = runTransform(new RangeBarsTransform({ range: 2 }), closes([10, 11, 12, 9, 9.5]));
    expect(out).toHaveLength(2); // one completed (10->12) + flush of the partial
    expect(out[0].high - out[0].low).toBeGreaterThanOrEqual(2);
  });
});

describe('Line Break', () => {
  it('forms a new line only on a break of the prior N lines', () => {
    T = 1;
    const out = runTransform(new LineBreakTransform({ lines: 3 }), closes([10, 11, 9, 12, 8]));
    expect(out).toHaveLength(4);
  });
});

describe('Point & Figure', () => {
  it('emits columns on reversals with X/O direction', () => {
    T = 1;
    const out = runTransform(new PointFigureTransform({ boxSize: 1, reversal: 3 }), closes([100, 101, 102, 103, 99]));
    expect(out).toHaveLength(2); // completed X column + flushed O column
    expect(out[0].close).toBeGreaterThanOrEqual(out[0].open); // X (up)
    expect(out[1].close).toBeLessThan(out[1].open); // O (down)
  });
});

describe('Kagi', () => {
  it('emits a vertex per reversal and encodes thickness in volume', () => {
    T = 1;
    const out = runTransform(new KagiTransform({ reversal: 2 }), closes([10, 13, 11, 14, 9]));
    expect(out).toHaveLength(4);
    expect(out.map((b) => b.time)).toEqual([...out].map((b) => b.time).sort((a, b) => a - b)); // strictly increasing
    expect([0, 1]).toContain(out[0].volume); // thickness flag
  });
});

describe('Family-B rendering (recording context)', () => {
  const toY = (v: number): number => 1000 - v;
  it('point-figure stacks glyphs (strokes) using boxSize', () => {
    T = 1;
    const cols = runTransform(new PointFigureTransform({ boxSize: 1, reversal: 3 }), closes([100, 101, 102, 103, 99]));
    const items: DrawItem[] = cols.map((b, i) => ({ x: 10 + i * 20, bar: b }));
    const { ctx, rec } = makeCtx();
    getChartType('point-figure').draw(ctx, items, toY, 20, 1, { boxSize: 1, upColor: '#0a0', downColor: '#a00' }, { plotHeight: 1000, maxVolume: 0 });
    expect(rec.count('stroke')).toBeGreaterThan(0);
  });

  it('kagi connects vertices with stepped strokes', () => {
    T = 1;
    const verts = runTransform(new KagiTransform({ reversal: 2 }), closes([10, 13, 11, 14, 9]));
    const items: DrawItem[] = verts.map((b, i) => ({ x: 10 + i * 20, bar: b }));
    const { ctx, rec } = makeCtx();
    getChartType('kagi').draw(ctx, items, toY, 20, 1, { thickColor: '#0a0', thinColor: '#a00' }, { plotHeight: 1000, maxVolume: 0 });
    expect(rec.count('stroke')).toBe(items.length - 1); // one stepped segment per gap
  });
});
