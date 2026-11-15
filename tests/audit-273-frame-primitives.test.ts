/**
 * A primitive that throws costs that primitive alone (audit C6).
 *
 * The chart draws host plugins in the middle of its own frame. One that throws
 * used to leave the pane between a save and its restore and abort everything
 * after it: the rest of the pane's primitives, its last-price tag and time
 * axis, every later pane and the overlays, on every frame while the fault
 * lasted. These pin that the frame completes around the fault, that the canvas
 * state stack comes out balanced even when the primitive threw between its own
 * save and restore, and that the error is reported once rather than once a frame.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Chart } from '../src/core/chart';
import type { PaneRenderContext } from '../src/core/pane';
import { fakeDocument } from './helpers/fake-dom';
import type { RecordingContext } from './helpers/fake-ctx';
import type { IPrimitive, ZOrder } from '../src/primitives/primitive';
import type { PriceLineOptions } from '../src/primitives/price-line';

const T0 = 1_700_000_000;
const bars = Array.from({ length: 200 }, (_, k) => ({
  time: T0 + k * 60, open: 100 + k, high: 102 + k, low: 99 + k, close: 101.37 + k,
}));

/** The context the chart hands a pane's hit test, read through the chart's private seam. */
const renderContext = (chart: Chart, index: number): PaneRenderContext =>
  (chart as unknown as { _renderContext(index: number): PaneRenderContext })._renderContext(index);

/** A chart whose frames run when `frame` drains them, so a throw has nowhere to hide. */
function makeChart(): { chart: Chart; frame: () => void } {
  const queue: (() => void)[] = [];
  const doc = fakeDocument();
  const chart = new Chart(doc.createElement('div'), {
    document: doc, pixelRatio: () => 1, shortcuts: false,
    raf: { schedule: (cb: () => void) => { queue.push(cb); return queue.length; }, cancel: () => {} },
  });
  chart.applySize(900, 600);
  const frame = (): void => { let n = 0; while (queue.length > 0 && n++ < 16) queue.shift()!(); };
  return { chart, frame };
}

const rec = (ctx: CanvasRenderingContext2D): RecordingContext => ctx as unknown as RecordingContext;

/** Every canvas of every pane, with its op log emptied. */
function clearOps(chart: Chart): void {
  for (const pane of chart.panes()) { rec(pane.base.ctx).ops.length = 0; rec(pane.top.ctx).ops.length = 0; }
}

/** Saves minus restores per canvas: zero is a frame that left the state stack where it found it. */
function imbalance(chart: Chart): number[] {
  return chart.panes().flatMap(pane => [pane.base.ctx, pane.top.ctx].map(ctx => rec(ctx).count('save') - rec(ctx).count('restore')));
}

/** A primitive that records each draw. */
function recorder(zOrder: ZOrder): IPrimitive & { draws: number } {
  return { draws: 0, zOrder: () => zOrder, draw(): void { this.draws++; } };
}

/** A primitive that opens its own state and throws before closing it, the way a price line did. */
function faulty(zOrder: ZOrder, message = 'plugin bug'): IPrimitive {
  return { zOrder: () => zOrder, draw(ctx: CanvasRenderingContext2D): void { ctx.save(); ctx.save(); throw new Error(message); } };
}

let reported: unknown[];
const g = globalThis as { reportError?: (error: unknown) => void };
let saved: typeof g.reportError;
beforeEach(() => { reported = []; saved = g.reportError; g.reportError = (error): void => { reported.push(error); }; });
afterEach(() => { g.reportError = saved; });

describe('a primitive that throws in draw', () => {
  it('leaves the rest of the frame painting, on every pane, frame after frame', () => {
    const { chart, frame } = makeChart();
    const s = chart.addSeries('candlestick');
    s.setData(bars);
    chart.addSeries('line', { paneIndex: 1 }).setData(bars.map(b => ({ time: b.time, value: b.close })));
    frame();
    const after = recorder('normal'), later = recorder('normal'), overlay = recorder('top');
    chart.addPrimitive(faulty('normal', 'price pane'), 0);
    chart.addPrimitive(after, 0);
    chart.addPrimitive(faulty('normal', 'bottom pane'), 1);
    chart.addPrimitive(later, 1);
    chart.addPrimitive(overlay, 1);
    frame();
    const drawn = (): number[] => [after.draws, later.draws, overlay.draws];
    for (let i = 1; i <= 5; i++) {
      clearOps(chart);
      const before = drawn();
      // An appended bar grows the shared index, so every pane repaints.
      const next = { time: T0 + (199 + i) * 60, open: 300, high: 305 + i, low: 299, close: 300.37 + i };
      expect(() => { s.update(next); frame(); }).not.toThrow();
      expect(drawn().map((count, k) => count - before[k]!)).toEqual([1, 1, 1]);
      expect(imbalance(chart)).toEqual([0, 0, 0, 0]);
    }
    // The bottom pane faulted too: its time axis still labels the strip under its plot.
    const bottom = chart.panes()[1]!;
    const axis = rec(bottom.base.ctx).ops.filter(op => op.type === 'fillText' && op.args[1]! > bottom.priceScale.height);
    expect(axis.length).toBeGreaterThan(0);
    // Reported once each, with the primitive's own error, over six frames.
    expect(reported.map(error => (error as Error).message).sort()).toEqual(['bottom pane', 'price pane']);
  });

  it('keeps the last-price tag of the pane it faulted on', () => {
    const { chart, frame } = makeChart();
    const s = chart.addSeries('candlestick');
    s.setData(bars);
    frame();
    chart.addPrimitive(faulty('normal'), 0);
    frame();
    clearOps(chart);
    s.update({ ...bars[199]!, close: 333.37, high: 334 });
    frame();
    const scale = chart.panes()[0]!.priceScale;
    const texts = rec(chart.panes()[0]!.base.ctx).ops.filter(op => op.type === 'fillText').map(op => op.text);
    expect(texts).toContain(scale.format(333.37));
    expect(imbalance(chart)).toEqual([0, 0]);
  });

  it('paints the series, the axes and the overlay around a fault behind the series', () => {
    const { chart, frame } = makeChart();
    const s = chart.addSeries('candlestick');
    s.setData(bars);
    frame();
    const front = recorder('normal'), overlay = recorder('top');
    chart.addPrimitive(faulty('bottom'), 0);
    chart.addPrimitive(front, 0);
    chart.addPrimitive(overlay, 0);
    clearOps(chart);
    frame();
    // Inside the plot clip, so an unbalanced stack here would clip the axes away.
    expect(imbalance(chart)).toEqual([0, 0]);
    expect(front.draws).toBe(1);
    expect(overlay.draws).toBe(1);
    const base = rec(chart.panes()[0]!.base.ctx);
    expect(base.ops.some(op => op.type === 'fillText')).toBe(true);
    expect(reported).toHaveLength(1);
  });

  it('draws the rest of the overlay around a fault in it', () => {
    const { chart, frame } = makeChart();
    chart.addSeries('candlestick').setData(bars);
    frame();
    const after = recorder('top');
    chart.addPrimitive(faulty('top'), 0);
    chart.addPrimitive(after, 0);
    clearOps(chart);
    frame();
    expect(after.draws).toBe(1);
    expect(imbalance(chart)).toEqual([0, 0]);
    expect(reported).toHaveLength(1);
  });

  it('reports each faulting primitive once', () => {
    const { chart, frame } = makeChart();
    const s = chart.addSeries('candlestick');
    s.setData(bars);
    chart.addPrimitive(faulty('normal', 'first'), 0);
    chart.addPrimitive(faulty('top', 'second'), 0);
    for (let i = 0; i < 4; i++) { s.update({ ...bars[199]!, close: 310 + i }); frame(); }
    expect(reported.map(error => (error as Error).message).sort()).toEqual(['first', 'second']);
  });

  // Audit C6, second round: a fault before any save of its own left what the
  // primitive had set on the context for the primitives after it.
  it.each(['bottom', 'normal', 'top'] as const)('gives the next %s primitive the canvas state from before the fault', (zOrder) => {
    const { chart, frame } = makeChart();
    chart.addSeries('candlestick').setData(bars);
    frame();
    const pane = chart.panes()[0]!;
    const g = zOrder === 'top' ? pane.top.ctx : pane.base.ctx;
    // The recording context keeps no state stack: give it one for the property under test.
    const alphas: number[] = [], { save, restore } = g;
    g.globalAlpha = 1;
    g.save = function (this: CanvasRenderingContext2D): void { alphas.push(this.globalAlpha); save.call(this); };
    g.restore = function (this: CanvasRenderingContext2D): void { if (alphas.length > 0) this.globalAlpha = alphas.pop()!; restore.call(this); };
    const seen: number[] = [];
    chart.addPrimitive({ zOrder: () => zOrder, draw: (ctx) => { ctx.globalAlpha = 0; throw new Error('alpha'); } }, 0);
    chart.addPrimitive({ zOrder: () => zOrder, draw: (ctx) => { seen.push(ctx.globalAlpha); } }, 0);
    frame();
    expect(seen).toEqual([1]);
    expect(g.globalAlpha).toBe(1);
    expect(alphas).toEqual([]);
    expect(reported).toHaveLength(1);
  });

  it('does not let a primitive restore more than it saved pop the pane\'s own state', () => {
    const { chart, frame } = makeChart();
    chart.addSeries('candlestick').setData(bars);
    frame();
    chart.addPrimitive({ zOrder: () => 'bottom', draw: (ctx) => { ctx.restore(); ctx.restore(); } }, 0);
    clearOps(chart);
    frame();
    expect(imbalance(chart)).toEqual([0, 0]);
  });
});

describe('a primitive that throws outside draw', () => {
  it('still lets the pane fit the others and answer the pointer', () => {
    const { chart, frame } = makeChart();
    const s = chart.addSeries('candlestick');
    s.setData(bars);
    frame();
    const broken = (key: 'autoscaleInfo' | 'afterAutoscale' | 'hitTest'): IPrimitive =>
      ({ zOrder: () => 'normal', draw: () => {}, [key]: () => { throw new Error(key); } });
    for (const key of ['autoscaleInfo', 'afterAutoscale', 'hitTest'] as const) chart.addPrimitive(broken(key), 0);
    const level = chart.addPriceLine({ price: 1000, color: '#2962ff', id: 'level' });
    // A tick, so the frame re-measures the scales and asks every primitive for its range.
    expect(() => { s.update({ ...bars[199]! }); frame(); }).not.toThrow();
    const pane = chart.panes()[0]!;
    // The level after the broken primitive still widens the range.
    expect(pane.priceScale.priceRange().max).toBeGreaterThanOrEqual(1000);
    const y = pane.priceScale.priceToY(level.price);
    let hit: ReturnType<typeof pane.hitTestPrimitives> = null;
    expect(() => { hit = pane.hitTestPrimitives(300, y, renderContext(chart, 0)); }).not.toThrow();
    expect(hit).not.toBeNull();
    expect(hit!.externalId).toBe('level');
    expect(reported.map(error => (error as Error).message).sort()).toEqual(['afterAutoscale', 'autoscaleInfo', 'hitTest']);
  });
});

describe('a price line from untyped JavaScript', () => {
  it('draws without a colour instead of throwing', () => {
    const { chart, frame } = makeChart();
    chart.addSeries('candlestick').setData(bars);
    frame();
    chart.addPriceLine({ price: 250, id: 'plain' } as unknown as PriceLineOptions);
    clearOps(chart);
    frame();
    expect(reported).toEqual([]);
    const pane = chart.panes()[0]!;
    const y = Math.round(pane.priceScale.priceToY(250)) + 0.5;
    const strokes = rec(pane.base.ctx).ops.filter(op => op.type === 'moveTo' && op.args[1] === y);
    expect(strokes.length).toBeGreaterThan(0);
    expect(rec(pane.base.ctx).ops.some(op => op.type === 'fillText' && op.text === pane.priceScale.format(250))).toBe(true);
  });

  it('draws its pill group without a colour as well', () => {
    const { chart, frame } = makeChart();
    chart.addSeries('candlestick').setData(bars);
    frame();
    chart.addPriceLine({ price: 250, id: 'order', badge: 'BUY', qty: 5, closeButton: true } as unknown as PriceLineOptions);
    clearOps(chart);
    frame();
    expect(reported).toEqual([]);
    const texts = rec(chart.panes()[0]!.base.ctx).ops.filter(op => op.type === 'fillText').map(op => op.text);
    expect(texts).toEqual(expect.arrayContaining(['BUY', '5']));
  });
});
