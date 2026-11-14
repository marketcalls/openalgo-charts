/**
 * The price axis names prices, so every label has to be the price its rung sits
 * at, and on an instrument with a declared tick every rung has to be a price it
 * can trade at. Three ways that failed in 2.7.2:
 *
 *  - The ladder knew nothing about the tick. On a tight range the step fell
 *    below it (0.005 on a 0.01 tick) and each rung was printed rounded to the
 *    tick's decimals: 8.095 and 8.100 both read "8.10", one of them 5 px from
 *    where a real 8.10 is drawn.
 *  - The tick's decimals were read off its magnitude, so a 0.25 tick printed
 *    one decimal and a 2.5 tick none: a valid 100.25 read "100.3" and 102.5
 *    read "103", at any visible range.
 *  - Precision stopped at eight decimals, so every price under about 1e-7
 *    printed the same "0.00000001".
 *
 * With no tick declared the axis must not move, which the last block pins
 * against the pre-change implementation.
 */
import { describe, it, expect } from 'vitest';
import { Chart } from '../src/core/chart';
import { PriceScale } from '../src/scale/price-scale';
import { niceTicks } from '../src/scale/ticks';
import { priceTickCount } from '../src/render/axis';
import { fakeDocument } from './helpers/fake-dom';
import type { RecordingContext } from './helpers/fake-ctx';

/** A scale with an instrument tick, autoscaled the way a pane does it. */
function ticked(tick: number, lo: number, hi: number, height = 600): PriceScale {
  const s = new PriceScale({ minMove: tick });
  s.setHeight(height);
  s.autoscale(lo, hi);
  return s;
}

/** Whether `x` is a whole number, to the float noise a product of decimals carries. */
const whole = (x: number): boolean => Math.abs(x - Math.round(x)) < 1e-6;

describe('the ladder of an instrument with a declared tick', () => {
  it('never steps below the tick, and every rung prints as itself', () => {
    // The auditor's sweep: 7 ticks, 5 pane heights, 3 to 40 ticks in view.
    // 2.7.2 printed at least one rung under a number that was not its price in
    // 131 of these 1,330 cases.
    const failures: string[] = [];
    for (const tick of [0.01, 0.05, 0.1, 0.25, 0.5, 1, 5, 2.5, 0.03125, 0.03]) {
      for (const h of [200, 320, 420, 600, 800]) {
        for (let inView = 3; inView <= 40; inView++) {
          const lo = 1000 * tick;
          const s = ticked(tick, lo, lo + inView * tick, h);
          const rungs = s.ticks(priceTickCount(h));
          const labels = rungs.map((p) => s.format(p));
          const where = `tick ${tick} h ${h} ${inView} ticks`;
          rungs.forEach((p, i) => {
            if (Math.abs(Number(labels[i]) - p) > tick * 1e-6) failures.push(`${where}: ${p} printed ${labels[i]}`);
            if (!whole(p / tick)) failures.push(`${where}: ${p} is not a tradable price`);
          });
          if (rungs.length > 1) {
            const step = rungs[1]! - rungs[0]!;
            if (step < tick * (1 - 1e-9) || !whole(step / tick)) failures.push(`${where}: step ${step}`);
          }
          if (new Set(labels).size !== labels.length) failures.push(`${where}: repeated label in ${labels.join(' ')}`);
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('labels a low-priced stock on a 0.01 tick at the tick, not between ticks', () => {
    // 8.10 to 8.15 on a one minute chart: the step was 0.005, printed 8.10 8.10 8.11 8.11 ...
    const s = ticked(0.01, 8.10, 8.15);
    expect(s.ticks(priceTickCount(600)).map((p) => s.format(p)))
      .toEqual(['8.10', '8.11', '8.12', '8.13', '8.14', '8.15']);
  });

  it('keeps an option premium on its 0.05 tick', () => {
    // 2.00 to 2.35 printed 2.02, 2.08, 2.13: none of them a price the option trades at.
    const s = ticked(0.05, 2.00, 2.35);
    const labels = s.ticks(priceTickCount(600)).map((p) => s.format(p));
    expect(labels.length).toBeGreaterThan(2);
    for (const label of labels) expect(whole(Number(label) / 0.05), label).toBe(true);
  });

  it('thins a whole-number tick rather than splitting it', () => {
    // MCX crude, tick 1, six points in view: 6009.5 printed as 6010 beside a real 6010.
    const s = ticked(1, 6010, 6016);
    const rungs = s.ticks(priceTickCount(600));
    expect(rungs.map((p) => s.format(p))).toEqual(rungs.map((p) => String(p)));
    for (const p of rungs) expect(Number.isInteger(p)).toBe(true);
  });

  it('leaves a ladder that was already a whole number of ticks alone', () => {
    // A 0.05 tick on a wide range: a step of 0.2 is four ticks and stays.
    expect(niceTicks(100, 101, 6, 0.05)).toEqual(niceTicks(100, 101, 6));
    expect(niceTicks(19800, 20450, 6, 0.05)).toEqual(niceTicks(19800, 20450, 6));
  });

  it('paints a label for each rung that names the price at its y', () => {
    // Through the real axis on a measured chart, the scenario the auditor
    // painted: tick 0.01, bars between 8.10 and 8.15.
    const doc = fakeDocument();
    const chart = new Chart(doc.createElement('div'), {
      document: doc, pixelRatio: () => 1, shortcuts: false,
      raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
    });
    chart.applySize(900, 640);
    chart.setPriceScaleOptions({ minMove: 0.01 });
    const s = chart.addSeries('candlestick');
    const closes = [8.12, 8.13, 8.11, 8.12, 8.14, 8.13, 8.12, 8.11, 8.12, 8.13];
    s.setData(closes.map((c, i) => ({
      time: 1_700_000_000 + i * 60, open: c, high: Math.min(8.15, c + 0.02), low: Math.max(8.10, c - 0.02), close: c,
    })));
    const pane = chart.panes()[0]!;
    const base = pane.base.ctx as unknown as RecordingContext;
    base.ops.length = 0;
    chart.invalidate((m) => m.invalidateGlobal(3));
    const scale = pane.priceScale;
    const { min, max } = scale.priceRange();
    const perPx = (max - min) / scale.height;
    const painted = base.ops.filter((op) => op.type === 'fillText' && /^\d+\.\d+$/.test(op.text ?? ''));
    expect(painted.length).toBeGreaterThan(2);
    for (const op of painted) {
      // The rung's y is rounded to a whole pixel, so allow one pixel of price.
      expect(Math.abs(Number(op.text) - scale.yToPrice(op.args[1]!)), op.text).toBeLessThanOrEqual(perPx);
    }
    chart.destroy();
  });
});

describe('the decimals of a declared tick', () => {
  it('prints every multiple of a fractional tick exactly, at a wide range', () => {
    for (const [tick, price] of [[0.25, 100.25], [0.125, 100.125], [2.5, 102.5], [0.03125, 100.03125]] as const) {
      const s = ticked(tick, 90, 110);
      expect(s.format(price), `tick ${tick}`).toBe(String(price));
    }
  });

  it('prints them exactly at a tight range too', () => {
    expect(ticked(0.25, 99.5, 101).format(100.75)).toBe('100.75');
    expect(ticked(2.5, 95, 110).format(97.5)).toBe('97.5');
  });

  it('keeps the decimals of the common ticks where they were', () => {
    expect(ticked(0.05, 90, 110).format(100.05)).toBe('100.05');
    expect(ticked(0.01, 90, 110).format(100.1)).toBe('100.10');
    expect(ticked(0.1, 90, 110).format(100.1)).toBe('100.1');
    expect(ticked(1, 90, 110).format(101)).toBe('101');
    expect(ticked(5, 90, 110).format(105)).toBe('105');
  });
});

describe('tiny prices', () => {
  it('tells rungs apart below a hundred-millionth', () => {
    for (const [lo, hi] of [[1.1e-8, 1.35e-8], [1.2e-10, 1.5e-10]] as const) {
      const s = new PriceScale();
      s.setHeight(400);
      s.autoscale(lo, hi);
      const rungs = s.ticks(priceTickCount(400));
      const labels = rungs.map((p) => s.format(p));
      expect(new Set(labels).size, labels.join(' ')).toBe(labels.length);
      rungs.forEach((p, i) => expect(Math.abs(Number(labels[i]) - p)).toBeLessThan((hi - lo) / 100));
    }
  });
});

/**
 * The 2.7.2 precision, transcribed: the magnitude of the step, capped at eight
 * decimals. A default axis must print exactly what it printed then wherever
 * that cap was not the reason for the answer.
 */
function oldPrecision(step: number): number {
  if (step <= 0 || !isFinite(step)) return 2;
  if (step >= 1) return 0;
  return Math.min(8, Math.ceil(-Math.log10(step)));
}

describe('an axis with no tick declared', () => {
  it('draws the ladder and the labels it drew before', () => {
    // The auditor's sweep of spans, heights and price levels.
    for (const h of [90, 200, 400, 640, 960, 1400]) {
      for (let e = -7; e <= 7; e++) {
        for (const mant of [1, 1.3, 1.9, 2.4, 3.3, 4.7, 5.5, 6.9, 8.8]) {
          for (const base of [0, 1, 123.456, 65000, 1e7]) {
            const span = mant * Math.pow(10, e);
            const s = new PriceScale();
            s.setHeight(h);
            s.setPriceRange({ min: base, max: base + span });
            const n = priceTickCount(h);
            const rungs = s.ticks(n);
            expect(rungs).toEqual(niceTicks(base, base + span, n));
            const step = (base + span - base) / 100; // as the scale measures it, float and all
            if (Math.ceil(-Math.log10(step)) > 8) continue; // the cap, fixed above
            const digits = oldPrecision(step);
            expect(rungs.map((p) => s.format(p))).toEqual(rungs.map((p) => p.toFixed(digits)));
          }
        }
      }
    }
  });
});
