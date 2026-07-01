import { describe, it, expect } from 'vitest';
import { TimeScale } from '../src/scale/time-scale';
import { getChartType } from '../src/model/chart-type-registry';
import { darkTheme } from '../src/theme';
import { Chart } from '../src/core/chart';
import { makeCtx, RecordingContext } from './helpers/fake-ctx';
import type { Bar } from '../src/model/bar';

const di = (x: number, close: number): { x: number; bar: Bar } => ({ x, bar: { time: x, open: close, high: close, low: close, close } });
const bar = (time: number, c: number): Bar => ({ time, open: c, high: c + 1, low: c - 1, close: c });

function recordingDoc(): Document {
  const make = (tag: string): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(), style: {}, children: [],
      appendChild(c: unknown) { (el.children as unknown[]).push(c); return c; },
      remove() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
    };
    if (tag === 'canvas') { el.width = 0; el.height = 0; el.getContext = () => new RecordingContext() as unknown as CanvasRenderingContext2D; }
    return el;
  };
  return { createElement: (t: string) => make(t) } as unknown as Document;
}
function makeChart(opts: Record<string, unknown> = {}): Chart {
  const doc = recordingDoc();
  const container = doc.createElement('div') as unknown as Record<string, unknown>;
  container.clientWidth = 800; container.clientHeight = 600;
  return new Chart(container as unknown as HTMLElement, {
    document: doc, pixelRatio: () => 1, raf: { schedule: () => 0, cancel: () => {} }, ...opts,
  });
}

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

describe('Task 2: series.applyOptions / remove / visible', () => {
  it('applyOptions recolors and toggles visibility', () => {
    const chart = makeChart();
    const a = chart.addSeries('line');
    a.setData([bar(100, 1), bar(160, 2)]);
    a.applyOptions({ color: '#ff0000', visible: false });
    const rec = chart.panes()[0].series()[0];
    expect(rec.style.color).toBe('#ff0000');
    expect(rec.style.visible).toBe(false);
  });
  it('remove() detaches the series and frees its data', () => {
    const chart = makeChart();
    const a = chart.addSeries('line'); a.setData([bar(100, 1), bar(160, 2)]);
    const b = chart.addSeries('line'); b.setData([bar(100, 3), bar(160, 4)]);
    const c = chart.addSeries('line'); c.setData([bar(100, 5), bar(160, 6)]);
    expect(chart.panes()[0].series().length).toBe(3);
    b.remove(); // remove the middle one
    const left = chart.panes()[0].series();
    expect(left.length).toBe(2);
    // the remaining two are a and c (b gone), and a repaint does not throw
    expect(() => a.applyOptions({ color: '#0f0' })).not.toThrow();
    expect(left[0].style.color).toBe('#0f0');
  });
});
