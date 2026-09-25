/**
 * Recorded drawing steps carry an identity a chart-wide history can follow.
 * The controller keeps its own undo and redo branches; a host that interleaves
 * other edits with them has to know which change was recorded as a step, and
 * which steps each branch still holds, or it cannot tell a live step from one
 * a reset, a trim or a host's forced edit has taken away.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Chart } from '../src/core/chart';
import { fakeDocument } from './helpers/fake-dom';
import { DrawingController, type DrawingChangeEvent } from '../src/draw/index';
import type { Bar } from '../src/model/bar';

const T0 = 1700000000;
beforeAll(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= {};
});
const bars = (n: number): Bar[] => Array.from({ length: n }, (_, i) => {
  const c = 100 + Math.sin(i / 4) * 5;
  return { time: T0 + i * 60, open: c, high: c + 2, low: c - 2, close: c, volume: 10 };
});
const charts: Chart[] = [];
function makeChart(): Chart {
  const chart = new Chart(fakeDocument().createElement('div') as unknown as HTMLElement, {
    document: fakeDocument(),
    raf: { schedule: (cb: (t: number) => void) => { cb(0); return 0; } },
    pixelRatio: () => 1, shortcuts: false,
  });
  chart.applySize(800, 600);
  chart.addSeries('candlestick').setData(bars(120));
  charts.push(chart);
  return chart;
}
afterEach(() => { for (const chart of charts.splice(0)) chart.destroy(); });

const line = (price: number) => ({
  tool: 'horizontal-line', paneIndex: 0,
  points: [{ time: T0 + 10 * 60, price }], style: {},
});

function changes(chart: Chart): DrawingChangeEvent[] {
  const out: DrawingChangeEvent[] = [];
  chart.on('drawing:change', payload => out.push(payload as DrawingChangeEvent));
  return out;
}

describe('drawing history steps', () => {
  it('names each recorded step on its change event and in the branches, oldest first', () => {
    const chart = makeChart();
    const draw = new DrawingController(chart);
    const seen = changes(chart);
    const a = draw.add(line(101));
    const b = draw.add(line(102));
    draw.update(a.id, { style: { color: '#ff0000' } });
    const steps = seen.map(change => change.step);
    expect(steps.every(step => typeof step === 'number')).toBe(true);
    expect(new Set(steps).size).toBe(3);
    expect(draw.historySteps()).toEqual({ undo: steps, redo: [] });

    draw.undo();
    expect(draw.historySteps()).toEqual({ undo: steps.slice(0, 2), redo: [steps[2]] });
    // Moving along the branches records nothing new.
    expect(seen[seen.length - 1]).toMatchObject({ kind: 'undo' });
    expect(seen[seen.length - 1]?.step).toBeUndefined();
    draw.redo();
    expect(draw.historySteps()).toEqual({ undo: steps, redo: [] });
    expect(seen[seen.length - 1]?.step).toBeUndefined();
    draw.remove(b.id);
    expect(draw.historySteps().undo).toHaveLength(4);
  });

  it('gives no step to what the history does not hold: a host edit, a linked commit, a reset', () => {
    const chart = makeChart();
    const draw = new DrawingController(chart);
    const seen = changes(chart);
    const mark = draw.add({ ...line(103), policy: { editable: false } });
    draw.update(mark.id, { style: { color: '#00ff00' } }, { force: true });
    draw.applyLinkedDrawing('linked', { ...line(104), id: 'linked', zIndex: 0, style: {} });
    expect(seen.map(change => change.step)).toEqual([undefined, undefined, undefined]);
    expect(draw.historySteps()).toEqual({ undo: [], redo: [] });

    draw.add(line(105));
    expect(draw.historySteps().undo).toHaveLength(1);
    draw.fromJSON({ version: 1, drawings: [] });
    expect(draw.historySteps()).toEqual({ undo: [], redo: [] });
  });

  it('records a drag as one step when it ends and none when it is cancelled', () => {
    const chart = makeChart();
    const draw = new DrawingController(chart);
    const d = draw.add(line(101));
    const seen = changes(chart);
    const before = draw.historySteps().undo.slice();
    chart.emit('drag', { id: `draw:${d.id}`, time: T0 + 10 * 60, price: 101, paneIndex: 0 });
    chart.emit('drag', { id: `draw:${d.id}`, time: T0 + 12 * 60, price: 104, paneIndex: 0 });
    expect(draw.cancelDrag()).toBe(true);
    expect(draw.historySteps().undo).toEqual(before);
    expect(seen.some(change => change.step !== undefined)).toBe(false);

    chart.emit('drag', { id: `draw:${d.id}`, time: T0 + 10 * 60, price: 101, paneIndex: 0 });
    chart.emit('drag', { id: `draw:${d.id}`, time: T0 + 12 * 60, price: 104, paneIndex: 0 });
    chart.emit('drag:end', {});
    const recorded = seen.filter(change => change.step !== undefined);
    expect(recorded).toHaveLength(1);
    expect(draw.historySteps().undo).toEqual([...before, recorded[0].step]);
  });

  it('keeps steps unique across controllers, so a rebuilt chart never reuses one', () => {
    const first = new DrawingController(makeChart());
    first.add(line(101));
    const second = new DrawingController(makeChart());
    second.add(line(101));
    expect(first.historySteps().undo[0]).not.toBe(second.historySteps().undo[0]);
  });

  it('drops the step a trim pushes out of the undo branch', () => {
    const chart = makeChart();
    const draw = new DrawingController(chart, { historyLimit: 2 });
    const seen = changes(chart);
    draw.add(line(101)); draw.add(line(102)); draw.add(line(103));
    expect(draw.historySteps().undo).toEqual(seen.slice(1).map(change => change.step));
  });
});
