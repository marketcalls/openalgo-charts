import { describe, it, expect } from 'vitest';
import { TimeScale } from '../src/scale/time-scale';
import { getChartType } from '../src/model/chart-type-registry';
import { darkTheme } from '../src/theme';
import { makeCtx } from './helpers/fake-ctx';
import type { Bar } from '../src/model/bar';

const di = (x: number, close: number): { x: number; bar: Bar } => ({ x, bar: { time: x, open: close, high: close, low: close, close } });

// Parity gaps to replace a third-party charting lib in OpenAlgo.
// Task 3: timeScale.setVisibleLogicalRange (preserve zoom across a data reload).

describe('Task 3: setVisibleLogicalRange', () => {
  it('restores a saved logical window after a reload changes base + zoom', () => {
    const ts = new TimeScale();
    ts.setWidth(600);
    ts.setBaseIndex(199);
    ts.fitContent(200);
    const before = ts.getVisibleLogicalRange();

    // Simulate a full-history reconcile: more bars, refit (jumps to default view).
    ts.setBaseIndex(499);
    ts.fitContent(500);
    expect(ts.visibleRange().to).not.toBeCloseTo(before.to, 1);

    // Restore the saved window.
    ts.setVisibleLogicalRange(before);
    const after = ts.getVisibleLogicalRange();
    expect(after.to).toBeCloseTo(before.to, 3);
    expect(after.from).toBeCloseTo(before.from, 3);
  });

  it('ignores a non-positive span and fires the change handler on apply', () => {
    const ts = new TimeScale();
    ts.setWidth(400);
    ts.setBaseIndex(99);
    ts.fitContent(100);
    let fired = 0;
    ts.setChangeHandler(() => { fired += 1; });
    ts.setVisibleLogicalRange({ from: 50, to: 50 }); // zero span -> no-op
    expect(fired).toBe(0);
    ts.setVisibleLogicalRange({ from: 40, to: 90 }); // valid
    expect(fired).toBe(1);
    expect(ts.visibleRange().to).toBeCloseTo(90, 3);
  });
});

describe('Task 5: dashed / dotted line series', () => {
  const rc = { plotHeight: 100, maxVolume: 0, theme: darkTheme };
  const items = [di(0, 1), di(10, 2), di(20, 1.5)];
  it('applies a dash pattern for a dashed line and none for solid', () => {
    const dashed = makeCtx();
    getChartType('line').draw(dashed.ctx, items, (v) => v, 8, 1, { lineStyle: 'dashed' }, rc);
    expect(dashed.rec.ops.some((o) => o.type === 'setLineDash' && o.args.length > 0)).toBe(true);

    const solid = makeCtx();
    getChartType('line').draw(solid.ctx, items, (v) => v, 8, 1, {}, rc);
    // solid only ever sets an empty dash
    expect(solid.rec.ops.filter((o) => o.type === 'setLineDash').every((o) => o.args.length === 0)).toBe(true);
  });
  it('dotted uses a tighter pattern than dashed', () => {
    const dotted = makeCtx();
    getChartType('line').draw(dotted.ctx, items, (v) => v, 8, 1, { lineStyle: 'dotted' }, rc);
    const set = dotted.rec.ops.find((o) => o.type === 'setLineDash' && o.args.length > 0);
    expect(set?.args[0]).toBe(1); // dotted dash length
  });
});
