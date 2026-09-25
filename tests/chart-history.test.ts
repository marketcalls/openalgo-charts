/**
 * The chart-wide history: one timeline for studies, their settings, the chart
 * type, price scales, panes and drawings. Each command type is taken back and
 * applied again against a measured chart, interleaved with drawing steps, and
 * checked against what it must never do: roll back price data, fire an alert
 * again, or touch an order.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Chart } from '../src/core/chart';
import { AlertController } from '../src/alerts/controller';
import { registerIndicator, readChartSettings, applyChartSettings } from '../src/index';
import type { Bar } from '../src/index';
import { fakeDocument } from './helpers/fake-dom';
import { DrawingController } from '../src/draw/index';
import { ChartHistory, type ChartHistoryError } from '../src/widget/history';

const T0 = 1700000000;
beforeAll(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= {};
});

const bars = (n: number): Bar[] => Array.from({ length: n }, (_, i) => {
  const c = 100 + Math.sin(i / 4) * 5 + i * 0.1;
  return { time: T0 + i * 60, open: c - 0.5, high: c + 2, low: c - 2, close: c, volume: 10 + i };
});

let failNext = false;
registerIndicator({
  id: 'hist-osc', name: 'History oscillator', placement: 'pane',
  inputs: [
    { key: 'length', type: 'number', label: 'Length', default: 5 },
    { key: 'source', type: 'source', label: 'Source', default: 'close', allowStudyOutputs: true },
  ],
  plots: [{ key: 'value', title: 'Value', type: 'line' }],
  calc: (b) => {
    if (failNext) throw new Error('calculation refused');
    return { value: b.map(x => x.close) };
  },
});
registerIndicator({
  id: 'hist-overlay', name: 'History overlay', placement: 'onchart',
  inputs: [{ key: 'length', type: 'number', label: 'Length', default: 3 }],
  plots: [{ key: 'value', title: 'Value', type: 'line' }],
  calc: (b) => ({ value: b.map(x => x.high) }),
});
registerIndicator({
  id: 'hist-alerting', name: 'History alerting', placement: 'pane',
  inputs: [{ key: 'length', type: 'number', label: 'Length', default: 2 }],
  plots: [{ key: 'value', title: 'Value', type: 'line' }],
  // True on every bar: any evaluation of history would announce each one.
  alerts: [{ id: 'always', title: 'Always', when: () => true }],
  calc: (b) => ({ value: b.map(x => x.close) }),
});
let asyncWork: Promise<void> = Promise.resolve();
registerIndicator({
  id: 'hist-async', name: 'History async', placement: 'pane',
  inputs: [{ key: 'length', type: 'number', label: 'Length', default: 4 }],
  plots: [{ key: 'value', title: 'Value', type: 'line' }],
  calc: (b, _s, store) => ({ value: b.map(x => (store.ready === true ? x.close : null)) }),
  attach: (ctx) => {
    ctx.setDataStatus?.({ state: 'loading' });
    asyncWork = Promise.resolve().then(() => Promise.resolve()).then(() => {
      if (ctx.signal?.aborted) return;
      ctx.store.ready = true;
      ctx.setDataStatus?.({ state: 'ready' });
      ctx.requestRecompute();
    });
  },
});

const charts: Chart[] = [];
function makeChart(options: Record<string, unknown> = {}): Chart {
  const chart = new Chart(fakeDocument().createElement('div') as unknown as HTMLElement, {
    document: fakeDocument(),
    raf: { schedule: (cb: (t: number) => void) => { cb(0); return 0; } },
    pixelRatio: () => 1, shortcuts: false, ...options,
  });
  chart.applySize(800, 600);
  charts.push(chart);
  return chart;
}
afterEach(() => { failNext = false; for (const chart of charts.splice(0)) if (!chart.isDestroyed) chart.destroy(); });

interface Rig { chart: Chart; draw: DrawingController; history: ChartHistory; errors: ChartHistoryError[] }
function rig(options: Record<string, unknown> = {}): Rig {
  const chart = makeChart(options);
  chart.addSeries('candlestick').setData(bars(80));
  const draw = new DrawingController(chart);
  const errors: ChartHistoryError[] = [];
  const history = new ChartHistory(chart, { draw, onError: e => errors.push(e) });
  return { chart, draw, history, errors };
}

/** The turn an action ran in is over: observed changes are recorded then. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

const studyIds = (chart: Chart): string[] => chart.indicators().map(s => s.id);
const layout = (chart: Chart) => ({
  studies: chart.indicators().map(s => ({ id: s.id, pane: s.paneIndex, settings: s.settings(), visible: s.visible(), scale: s.priceScaleId() })),
  weights: chart.panes().map((_, i) => chart.paneWeight(i)),
  collapsed: chart.panes().map((_, i) => chart.paneCollapsed(i)),
});
const line = (price: number, paneIndex = 0) => ({ tool: 'horizontal-line', paneIndex, points: [{ time: T0 + 10 * 60, price }], style: {} });
/**
 * Each pane's studies in their stacking order, without ids. The order across
 * panes is not a thing the chart lets anyone set; within a pane it is the
 * order the rows and the plots are drawn in.
 */
const stacks = (chart: Chart) => chart.panes().map((_, slot) => chart.indicators().filter(s => s.paneIndex === slot)
  .map(s => ({ indicatorId: s.indicatorId, settings: s.settings(), visible: s.visible(), scale: s.priceScaleId() })));

describe('studies', () => {
  it('takes an added study back and brings it again, settings and pane included', async () => {
    const { chart, history } = rig();
    const before = layout(chart);
    const study = chart.addIndicator('hist-osc', { length: 9 });
    await settle();
    expect(history.canUndo()).toBe(true);
    expect(history.peekUndo()?.changes).toContain('study-add');
    const added = layout(chart);

    expect(history.undo()).toBe(true);
    expect(studyIds(chart)).toEqual([]);
    expect(chart.panes()).toHaveLength(1);
    expect(layout(chart)).toEqual(before);

    expect(history.redo()).toBe(true);
    expect(chart.indicators()).toHaveLength(1);
    expect(chart.indicators()[0].settings()).toEqual(study.settings());
    expect(chart.indicators()[0].paneIndex).toBe(1);
    expect(layout(chart).weights).toEqual(added.weights);
  });

  it('brings a removed study back to its slot, weight, fold, scale, visibility and stack position', async () => {
    const { chart, history } = rig();
    const a = chart.addIndicator('hist-osc', { length: 3 });
    const b = chart.addIndicator('hist-osc', { length: 4 });
    const c = chart.addIndicator('hist-osc', { length: 5 });
    const overlay = chart.addIndicator('hist-overlay', { length: 7 }, { priceScaleId: 'left' });
    const second = chart.addIndicator('hist-overlay', { length: 8 });
    chart.setPaneWeight(2, 0.9);
    chart.setPaneCollapsed(2, true);
    b.setVisible(false);
    await settle();
    history.clear();
    const before = layout(chart);
    const beforeStacks = stacks(chart);

    history.group()();                    // an empty group is no step
    chart.removeIndicator(b.id);          // the pane in the middle goes with it
    chart.removeIndicator(overlay.id);
    await settle();
    expect(chart.panes()).toHaveLength(3);
    expect(history.peekUndo()?.changes).toEqual(['study-remove']);

    expect(history.undo()).toBe(true);
    // Until the chart takes an instance id back, a study returns under a new
    // one; everything else about it is as it was, the row it held included.
    expect(stacks(chart)).toEqual(beforeStacks);
    expect(layout(chart).weights).toEqual(before.weights);
    expect(layout(chart).collapsed).toEqual(before.collapsed);
    const pricePane = chart.indicators().filter(s => s.paneIndex === 0);
    expect(pricePane[0].priceScaleId()).toBe('left');
    expect(pricePane[1].id).toBe(second.id);
    expect(a.paneIndex).toBe(1);
    expect(c.paneIndex).toBe(3);
    expect(history.canUndo()).toBe(false);

    expect(history.redo()).toBe(true);
    expect(chart.indicators()).toHaveLength(3);
    expect(chart.panes()).toHaveLength(3);
    expect(history.undo()).toBe(true);
    expect(stacks(chart)).toEqual(beforeStacks);
    expect(layout(chart).collapsed).toEqual(before.collapsed);
  });

  it('asks the chart for the removed instance id and keeps a dependent reading it', async () => {
    const { chart, history } = rig();
    const source = chart.addIndicator('hist-osc', { length: 3 });
    const reader = chart.addIndicator('hist-osc', { source: { kind: 'indicator', instanceId: source.id, plotKey: 'value' } });
    await settle();
    history.clear();
    const add = vi.spyOn(chart, 'addIndicator');
    chart.removeIndicator(source.id);
    await settle();
    history.undo();
    // The id is asked for, so a chart that can reuse it answers to the same one.
    expect(add.mock.calls[0][2]).toMatchObject({ instanceId: source.id });
    const other = (): ReturnType<Chart['indicators']>[number] => chart.indicators().find(s => s.id !== reader.id)!;
    const readsFrom = (): string => (reader.settings().source as { instanceId: string }).instanceId;
    expect(readsFrom()).toBe(other().id);
    expect(other().paneIndex).toBe(1);
    expect(reader.paneIndex).toBe(2);

    // Removed and brought back again: the reader follows each time.
    history.redo();
    expect(chart.indicators().map(s => s.id)).toEqual([reader.id]);
    history.undo();
    expect(readsFrom()).toBe(other().id);
    expect(other().settings().length).toBe(3);

    // Later steps that name the study reach it under whichever id it answers to.
    other().setSettings({ length: 11 });
    await settle();
    history.undo();
    expect(other().settings().length).toBe(3);
    history.redo();
    expect(other().settings().length).toBe(11);
  });

  it('records study settings, visibility, scale assignment and stacking as steps', async () => {
    const { chart, history } = rig();
    const one = chart.addIndicator('hist-overlay', { length: 3 });
    const two = chart.addIndicator('hist-overlay', { length: 4 });
    await settle();
    history.clear();

    one.setSettings({ length: 12, 'value:color': '#ff0000' });
    await settle();
    two.setVisible(false);
    await settle();
    one.setPriceScale('left');
    await settle();
    chart.reorderIndicator(two.id, -1);
    await settle();
    expect(studyIds(chart)).toEqual([two.id, one.id]);

    expect(history.peekUndo()?.changes).toEqual(['study-order']);
    history.undo();
    expect(studyIds(chart)).toEqual([one.id, two.id]);
    history.undo();
    expect(one.priceScaleId()).toBeNull();
    history.undo();
    expect(two.visible()).toBe(true);
    history.undo();
    expect(one.settings().length).toBe(3);
    expect(one.settings()['value:color']).not.toBe('#ff0000');
    expect(history.canUndo()).toBe(false);

    for (let i = 0; i < 4; i++) expect(history.redo()).toBe(true);
    expect(one.settings()).toMatchObject({ length: 12, 'value:color': '#ff0000' });
    expect(two.visible()).toBe(false);
    expect(one.priceScaleId()).toBe('left');
    expect(studyIds(chart)).toEqual([two.id, one.id]);
  });

  it('moves a study back to the pane it left, recreating the pane it emptied', async () => {
    const { chart, history } = rig();
    const a = chart.addIndicator('hist-osc');
    const b = chart.addIndicator('hist-osc');
    chart.setPaneWeight(2, 0.6);
    await settle();
    history.clear();
    chart.moveIndicator(b.id, 1);
    await settle();
    expect(chart.panes()).toHaveLength(2);
    history.undo();
    expect(chart.panes()).toHaveLength(3);
    expect(b.paneIndex).toBe(2);
    expect(a.paneIndex).toBe(1);
    expect(chart.paneWeight(2)).toBeCloseTo(0.6);
    history.redo();
    expect(b.paneIndex).toBe(1);
    expect(chart.panes()).toHaveLength(2);
  });
});

describe('chart type and price scales', () => {
  it('takes a chart type back without touching the bars, including a bar that arrived since', async () => {
    const { chart, history } = rig();
    const series = chart.primarySeries()!;
    const setData = vi.spyOn(series, 'setData');
    chart.setSeriesType(series, 'line');
    await settle();
    expect(history.peekUndo()?.changes).toEqual(['chart-type']);
    const tick = { ...bars(81)[80] };
    series.update(tick);
    history.undo();
    expect(chart.seriesType(series)).toBe('candlestick');
    expect(series.getData()).toHaveLength(81);
    expect(series.getData()[80]).toMatchObject({ time: tick.time, close: tick.close });
    history.redo();
    expect(chart.seriesType(series)).toBe('line');
    expect(series.getData()).toHaveLength(81);
    expect(setData).not.toHaveBeenCalled();
  });

  it('routes the chart type through the host when it owns it', async () => {
    const chart = makeChart();
    chart.addSeries('candlestick').setData(bars(40));
    const setChartType = vi.fn((type: string) => chart.setSeriesType(chart.primarySeries()!, type as never));
    const history = new ChartHistory(chart, { setChartType });
    chart.setSeriesType(chart.primarySeries()!, 'area');
    await settle();
    history.undo();
    expect(setChartType).toHaveBeenCalledWith('candlestick');
  });

  it('records scale options, auto-fit and chart settings made in a transaction', async () => {
    const { chart, history } = rig();
    history.transact(() => chart.setPriceAxisOptions(0, 'right', { mode: 'logarithmic', inverted: true }), 'Scale');
    history.transact(() => chart.setPriceAxisAutoFit(0, 'right', false));
    const settings = readChartSettings(chart);
    const key = Object.keys(settings).find(k => k === 'grid.vertLines' || k.endsWith('vertLines'));
    expect(key).toBeDefined();
    history.transact(() => chart.setGridOptions({ vertLines: !settings[key!] }));
    expect(history.peekUndo()?.changes).toEqual(['settings']);

    history.undo();
    expect(readChartSettings(chart)[key!]).toBe(settings[key!]);
    history.undo();
    expect(chart.priceAxisState(0, 'right')?.autoFit).toBe(true);
    // The primary scale's mode is also a chart setting, so both are named.
    expect(history.peekUndo()).toEqual({ label: 'Scale', changes: expect.arrayContaining(['axis', 'settings']) });
    history.undo();
    expect(chart.priceAxisState(0, 'right')).toMatchObject({ mode: 'linear', inverted: false });
    history.redo();
    expect(chart.priceAxisState(0, 'right')).toMatchObject({ mode: 'logarithmic', inverted: true });
  });

  it('replays one axis inverted from its menu on that axis alone, and a chart-wide invert on every pane', async () => {
    const { chart, history } = rig();
    chart.addIndicator('hist-osc');
    chart.addIndicator('hist-osc');
    await settle();
    history.clear();
    const inverted = (): boolean[] => chart.panes().map((_, i) => chart.priceAxisState(i, 'right')!.inverted);

    history.transact(() => chart.setPriceAxisOptions(0, 'right', { inverted: true }), 'Axis menu');
    expect(inverted()).toEqual([true, false, false]);
    history.undo();
    expect(inverted()).toEqual([false, false, false]);
    history.redo();
    expect(inverted()).toEqual([true, false, false]);
    history.undo();

    history.transact(() => applyChartSettings(chart, { 'scales.inverted': true }), 'Settings');
    expect(inverted()).toEqual([true, true, true]);
    expect(history.peekUndo()?.changes).toEqual(expect.arrayContaining(['settings', 'axis']));
    history.undo();
    expect(inverted()).toEqual([false, false, false]);
    history.redo();
    expect(inverted()).toEqual([true, true, true]);
    // The chart-wide default came back with it: a pane made now is inverted too.
    chart.addIndicator('hist-osc');
    expect(inverted()).toEqual([true, true, true, true]);
  });

  it('takes back a scale placement and a series scale assignment', async () => {
    const { chart, history } = rig();
    const series = chart.primarySeries()!;
    chart.setSeriesPriceScale(series, 'left');
    await settle();
    expect(history.peekUndo()?.changes).toContain('series-scale');
    chart.setPriceAxisPlacement(0, 'left', 'right', 1);
    await settle();
    expect(chart.priceAxisPlacement(0, 'left')).toEqual({ side: 'right', order: 1 });
    history.undo();
    expect(chart.priceAxisPlacement(0, 'left')?.side).toBe('left');
    history.undo();
    expect(series.priceScale()).toBe(chart.panes()[0].scaleFor('right'));
    history.redo();
    expect(series.priceScale()).toBe(chart.panes()[0].scaleFor('left'));
  });
});

describe('panes', () => {
  it('moves, folds and resizes panes as separate steps and walks them back in order', async () => {
    const { chart, history } = rig();
    const a = chart.addIndicator('hist-osc');
    const b = chart.addIndicator('hist-osc');
    await settle();
    history.clear();
    chart.movePane(1, 1);
    await settle();
    chart.setPaneCollapsed(1, true);
    await settle();
    history.transact(() => chart.setPaneWeight(2, 0.7), 'Resize');
    chart.setPaneWeight(1, 0.4);
    chart.emit('paneResized', { paneIndex: 1 });   // a divider drag ends
    await settle();
    expect(history.peekUndo()?.changes).toEqual(['pane-weight']);

    history.undo();
    expect(chart.paneWeight(1)).toBeCloseTo(0.32);
    history.undo();
    expect(chart.paneWeight(2)).toBeCloseTo(0.32);
    history.undo();
    expect(chart.paneCollapsed(1)).toBe(false);
    history.undo();
    expect([a.paneIndex, b.paneIndex]).toEqual([1, 2]);
    expect(history.canUndo()).toBe(false);
    for (let i = 0; i < 4; i++) history.redo();
    expect([a.paneIndex, b.paneIndex]).toEqual([2, 1]);
    expect(chart.paneCollapsed(1)).toBe(true);
  });

  it('brings back a removed pane with every study and drawing it held', async () => {
    const { chart, draw, history } = rig();
    const a = chart.addIndicator('hist-osc', { length: 6 });
    chart.addIndicator('hist-osc', { length: 7 }, { paneIndex: 1 });
    chart.addIndicator('hist-osc', { length: 8 });
    await settle();
    const marker = draw.add(line(50, 1));
    history.clear();
    chart.removePane(1);
    await settle();
    expect(chart.indicators()).toHaveLength(1);
    expect(draw.get(marker.id)).toBeUndefined();

    history.undo();
    expect(chart.panes()).toHaveLength(3);
    expect(stacks(chart).map(pane => pane.map(s => s.settings.length))).toEqual([[], [6, 7], [8]]);
    expect(draw.get(marker.id)?.paneIndex).toBe(1);
    history.redo();
    expect(chart.panes()).toHaveLength(2);
    expect(draw.get(marker.id)).toBeUndefined();
    expect(chart.indicators().some(s => s.id === a.id)).toBe(false);
  });

  it('puts a price pane moved below its studies back on top', async () => {
    const { chart, history } = rig({ movablePrimaryPane: true });
    chart.addIndicator('hist-osc');
    await settle();
    history.clear();
    expect(chart.setPrimaryPaneIndex(1)).toBe(true);
    await settle();
    expect(history.peekUndo()?.changes).toContain('pane-order');
    history.undo();
    expect(chart.primaryPaneIndex()).toBe(0);
    history.redo();
    expect(chart.primaryPaneIndex()).toBe(1);
  });
});

describe('one timeline with drawings', () => {
  it('interleaves drawing steps with chart steps and walks them in order both ways', async () => {
    const { chart, draw, history } = rig();
    const first = draw.add(line(101));
    const study = chart.addIndicator('hist-osc');
    await settle();
    draw.update(first.id, { style: { color: '#123456' } });
    study.setSettings({ length: 21 });
    await settle();
    expect(history.peekUndo()?.changes).toEqual(['study-settings']);

    history.undo();
    expect(study.settings().length).toBe(5);
    expect(draw.get(first.id)?.style.color).toBe('#123456');
    expect(history.peekUndo()?.changes).toEqual(['drawing']);
    history.undo();
    expect(draw.get(first.id)?.style.color).not.toBe('#123456');
    history.undo();
    expect(chart.indicators()).toHaveLength(0);
    expect(draw.get(first.id)).toBeDefined();
    history.undo();
    expect(draw.drawings()).toHaveLength(0);
    expect(history.canUndo()).toBe(false);

    history.redo();
    expect(draw.drawings()).toHaveLength(1);
    expect(chart.indicators()).toHaveLength(0);
    history.redo();
    expect(chart.indicators()).toHaveLength(1);
    history.redo();
    expect(draw.get(first.id)?.style.color).toBe('#123456');
    history.redo();
    expect(chart.indicators()[0].settings().length).toBe(21);
    expect(history.canRedo()).toBe(false);
  });

  it('invalidates redo on any new action, chart or drawing', async () => {
    const { chart, draw, history } = rig();
    chart.addIndicator('hist-osc');
    await settle();
    history.undo();
    expect(history.canRedo()).toBe(true);
    draw.add(line(99));
    expect(history.canRedo()).toBe(false);
    history.undo();
    expect(history.canRedo()).toBe(true);
    chart.addIndicator('hist-overlay');
    await settle();
    expect(history.canRedo()).toBe(false);
    expect(history.redo()).toBe(false);
  });

  it('follows a host that presses the drawing controller directly', async () => {
    const { chart, draw, history } = rig();
    chart.addIndicator('hist-osc');
    await settle();
    draw.add(line(99));
    draw.undo();
    expect(history.canRedo()).toBe(true);
    history.undo();
    expect(chart.indicators()).toHaveLength(0);
    history.redo();
    history.redo();
    expect(draw.drawings()).toHaveLength(1);
  });

  it('skips drawing steps the controller no longer holds', async () => {
    const { chart, draw, history } = rig();
    draw.add(line(99));
    chart.addIndicator('hist-osc');
    await settle();
    draw.fromJSON({ version: 1, drawings: [] });
    expect(history.undo()).toBe(true);
    expect(chart.indicators()).toHaveLength(0);
    expect(history.canUndo()).toBe(false);
    expect(history.undo()).toBe(false);
  });
});

describe('coalescing', () => {
  it('merges a live colour edit into one step, and a cancelled group into none', async () => {
    const { chart, draw, history } = rig();
    const study = chart.addIndicator('hist-osc');
    const d = draw.add(line(100));
    await settle();
    history.clear();
    const color = study.settings()['value:color'];
    const drawn = draw.get(d.id)?.style.color;

    let end = history.group('Colour');
    for (const next of ['#110000', '#220000', '#330000']) {
      study.setSettings({ 'value:color': next });
      await settle();
      draw.update(d.id, { style: { color: next } });
    }
    end();
    expect(history.peekUndo()).toEqual({ label: 'Colour', changes: ['study-settings', 'drawing'] });
    expect(history.undo()).toBe(true);
    expect(study.settings()['value:color']).toBe(color);
    expect(draw.get(d.id)?.style.color).toBe(drawn);
    expect(history.canUndo()).toBe(false);
    expect(history.redo()).toBe(true);
    expect(study.settings()['value:color']).toBe('#330000');
    expect(draw.get(d.id)?.style.color).toBe('#330000');

    const original = study.settings().length;
    end = history.group('Dialog');
    study.setSettings({ length: 30 });
    await settle();
    study.setSettings({ length: original });   // Cancel puts it back
    end();
    expect(history.peekUndo()?.label).toBe('Colour');
    history.undo();
    expect(history.canUndo()).toBe(false);
  });

  it('leaves a host change made in the middle of a group out of the step', async () => {
    const { chart, history } = rig();
    const study = chart.addIndicator('hist-osc');
    await settle();
    history.clear();
    const end = history.group('Dialog');
    history.transact(() => chart.setPriceAxisOptions(1, 'right', { inverted: true }));
    study.setSettings({ length: 11 });
    await settle();
    // The host's own change while the dialog is open: a scale it owns.
    history.ignore(() => chart.setPriceAxisOptions(1, 'right', { mode: 'percentage' }));
    history.transact(() => chart.setPriceAxisOptions(1, 'right', { marginTop: 0.25 }));
    study.setSettings({ length: 12 });
    await settle();
    end();
    expect(history.undo()).toBe(true);
    expect(study.settings().length).toBe(5);
    expect(chart.priceAxisState(1, 'right')).toMatchObject({ inverted: false, mode: 'percentage' });
    expect(chart.panes()[1].scaleFor('right').options.marginTop).toBeCloseTo(0.1);
    expect(history.redo()).toBe(true);
    expect(study.settings().length).toBe(12);
    expect(chart.priceAxisState(1, 'right')).toMatchObject({ inverted: true, mode: 'percentage' });
  });

  it('records a transaction as one step, drawings included, and joins nested ones', () => {
    const { chart, draw, history } = rig();
    history.transact(() => {
      chart.addIndicator('hist-osc');
      history.transact(() => chart.addIndicator('hist-overlay'));
      draw.add(line(100));
    }, 'Template');
    expect(history.peekUndo()).toEqual({ label: 'Template', changes: expect.arrayContaining(['study-add', 'drawing']) });
    history.undo();
    expect(chart.indicators()).toHaveLength(0);
    expect(draw.drawings()).toHaveLength(0);
    expect(history.canUndo()).toBe(false);
    history.redo();
    expect(chart.indicators()).toHaveLength(2);
    expect(draw.drawings()).toHaveLength(1);
  });

  it('keeps a whole divider drag as one step', async () => {
    const { chart, history } = rig();
    chart.addIndicator('hist-osc');
    await settle();
    history.clear();
    for (const w of [0.4, 0.5, 0.6]) chart.setPaneWeight(1, w);
    chart.emit('paneResized', { paneIndex: 0 });
    await settle();
    history.undo();
    expect(chart.paneWeight(1)).toBeCloseTo(0.32);
    expect(history.canUndo()).toBe(false);
  });
});

describe('what history never does', () => {
  it('fires no study alert and replays no trader alert when a step brings a study back', async () => {
    const { chart, history } = rig();
    const alerts = new AlertController(chart);
    alerts.add({ source: { kind: 'price', price: 105 } });
    const fired: unknown[] = [];
    for (const event of ['indicator:alert', 'alert:triggered', 'alert:created', 'alert:removed', 'alerts:restored']) {
      chart.on(event, payload => fired.push([event, payload]));
    }
    const study = chart.addIndicator('hist-alerting');
    await settle();
    chart.removeIndicator(study.id);
    await settle();
    const alertState = JSON.stringify(alerts.list());
    history.undo();
    history.redo();
    history.undo();
    expect(fired).toEqual([]);
    expect(JSON.stringify(alerts.list())).toBe(alertState);
    // The study is live and still judges new bars; only history stays quiet.
    chart.primarySeries()!.update(bars(81)[80]);
    expect(fired.some(entry => (entry as unknown[])[0] === 'indicator:alert')).toBe(true);
  });

  it('never writes bars, whatever it takes back', async () => {
    const { chart, draw, history } = rig();
    const series = chart.primarySeries()!;
    const data = series.getData();
    const setData = vi.spyOn(series, 'setData');
    const update = vi.spyOn(series, 'update');
    chart.addIndicator('hist-osc');
    await settle();
    chart.setSeriesType(series, 'bar');
    await settle();
    draw.add(line(100));
    while (history.undo());
    while (history.redo());
    expect(setData).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(series.getData()).toEqual(data);
  });
});

describe('failures', () => {
  it('leaves the history true to the chart when a step cannot be taken back', async () => {
    const { chart, history, errors } = rig();
    chart.addIndicator('hist-overlay');
    await settle();
    const study = chart.addIndicator('hist-osc', { length: 3 });
    await settle();
    chart.removeIndicator(study.id);
    await settle();
    chart.setSeriesType(chart.primarySeries()!, 'line');
    await settle();
    history.undo();                        // the chart type: fine
    failNext = true;                       // the study can no longer be built
    expect(history.undo()).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].direction).toBe('undo');
    expect(chart.indicators().map(s => s.indicatorId)).toEqual(['hist-overlay']);
    // The steps behind the one that failed describe a chart this one no
    // longer leads back to; the redo branch still does.
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
    failNext = false;
    history.redo();
    expect(chart.seriesType(chart.primarySeries()!)).toBe('line');
  });

  it('rolls back a command that throws and drops it with what was behind it', () => {
    const { chart, history, errors } = rig();
    let value = 0;
    history.transact(() => chart.addIndicator('hist-osc'));
    history.push({ label: 'Host', undo: () => { throw new Error('host refused'); }, redo: () => { value = 1; } });
    expect(history.undo()).toBe(false);
    expect(errors[0]).toMatchObject({ direction: 'undo', step: { label: 'Host', changes: ['command'] } });
    expect(chart.indicators()).toHaveLength(1);
    expect(history.canUndo()).toBe(false);
    expect(value).toBe(0);
  });

  it('undoes and redoes a host command in its place in the timeline', async () => {
    const { chart, history } = rig();
    let type = 'a';
    history.push({ label: 'Type', undo: () => { type = 'a'; }, redo: () => { type = 'b'; } });
    type = 'b';
    chart.addIndicator('hist-osc');
    await settle();
    history.undo();
    expect(type).toBe('b');
    history.undo();
    expect(type).toBe('a');
    history.redo();
    expect(type).toBe('b');
    expect(history.redo()).toBe(true);
    expect(chart.indicators()).toHaveLength(1);
    expect(history.push({ undo: () => false, redo: () => true })).toBeUndefined();
    expect(history.undo()).toBe(false);
  });
});

describe('nested callbacks and async work', () => {
  it('records a listener reacting to the user in the same step, and a listener reacting to an undo in none', async () => {
    const { chart, history } = rig();
    const study = chart.addIndicator('hist-osc');
    await settle();
    history.clear();
    let react = true;
    chart.on('indicatorRemoved', () => { if (react) chart.addIndicator('hist-overlay'); });
    chart.removeIndicator(study.id);
    await settle();
    expect(chart.indicators().map(s => s.indicatorId)).toEqual(['hist-overlay']);
    react = false;
    history.undo();
    expect(chart.indicators().map(s => s.indicatorId)).toEqual(['hist-osc']);
    expect(history.canUndo()).toBe(false);

    // A listener that adjusts the chart as a step is applied is part of that step.
    const off = chart.on('objects:change', () => { if (chart.paneWeight(1) !== 0.5) chart.setPaneWeight(1, 0.5); });
    history.redo();
    history.undo();
    off();
    await settle();
    expect(history.canRedo()).toBe(true);
    expect(history.canUndo()).toBe(false);
  });

  it('refuses an undo pressed from inside an undo', async () => {
    const { chart, history } = rig();
    chart.addIndicator('hist-osc');
    await settle();
    chart.addIndicator('hist-overlay');
    await settle();
    const inner: boolean[] = [];
    const off = chart.on('indicatorRemoved', () => inner.push(history.undo()));
    history.undo();
    off();
    expect(inner).toEqual([false]);
    expect(chart.indicators().map(s => s.indicatorId)).toEqual(['hist-osc']);
  });

  it('records nothing when a study brought back finishes its asynchronous work', async () => {
    const { chart, history } = rig();
    const study = chart.addIndicator('hist-async');
    await asyncWork;
    await settle();
    history.clear();
    chart.removeIndicator(study.id);
    await settle();
    history.undo();
    expect(history.canRedo()).toBe(true);
    await asyncWork;
    await settle();
    expect(chart.indicators()[0].values().value?.some(v => v !== null)).toBe(true);
    expect(history.canRedo()).toBe(true);
    expect(history.canUndo()).toBe(false);
  });
});

describe('host control', () => {
  it('ignores the host\'s own changes and forgets everything on a restored layout', async () => {
    const { chart, history } = rig();
    history.ignore(() => { chart.addIndicator('hist-osc'); chart.setPaneWeight(1, 0.7); });
    await settle();
    expect(history.canUndo()).toBe(false);
    chart.addIndicator('hist-overlay');
    await settle();
    expect(history.canUndo()).toBe(true);
    const state = chart.getState();
    chart.restoreState(state);
    await settle();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  it('takes back only the fields a step changed, keeping the host\'s own changes beside them', async () => {
    const { chart, history } = rig();
    const study = chart.addIndicator('hist-osc');
    chart.addIndicator('hist-osc');
    await settle();
    history.clear();
    study.setSettings({ length: 20 });
    await settle();
    history.transact(() => chart.setPaneWeight(1, 0.6));
    history.ignore(() => {
      study.setSettings({ 'value:color': '#00aa00' });
      chart.setPaneCollapsed(1, true);
      chart.setPaneWeight(2, 0.5);
    });
    history.undo();
    expect(chart.paneWeight(1)).toBeCloseTo(0.32);
    expect(chart.paneCollapsed(1)).toBe(true);
    history.undo();
    expect(study.settings()).toMatchObject({ length: 5, 'value:color': '#00aa00' });
    expect(chart.paneWeight(2)).toBeCloseTo(0.5);
  });

  it('keeps the chart steps when a host rebuilds its chart and attaches the new one', async () => {
    const { chart, history } = rig();
    chart.addIndicator('hist-osc', { length: 4 });
    await settle();
    const study = chart.indicators()[0];
    study.setSettings({ length: 8 });
    await settle();
    const state = chart.getState();
    chart.destroy();
    const next = makeChart();
    next.addSeries('line').setData(bars(80));
    next.restoreState(state);
    const draw = new DrawingController(next);
    history.attach(next, draw);
    history.undo();
    expect(next.indicators()[0].settings().length).toBe(4);
    history.undo();
    expect(next.indicators()).toHaveLength(0);
    history.redo();
    expect(next.indicators()).toHaveLength(1);
  });

  it('takes back drawing steps a replaced drawing controller recorded, in their place', async () => {
    const { chart, draw, history } = rig();
    chart.addIndicator('hist-osc');
    await settle();
    const made = draw.add(line(101));
    draw.update(made.id, { style: { color: '#abcdef' } });
    chart.addIndicator('hist-overlay');
    await settle();
    // The host rebuilds: a new chart and a new controller, from the old state.
    const state = chart.getState();
    draw.destroy();
    chart.destroy();
    const next = makeChart();
    next.addSeries('candlestick').setData(bars(80));
    const rebuilt = new DrawingController(next);
    next.restoreState(state);
    history.attach(next, rebuilt);
    expect(rebuilt.get(made.id)?.style.color).toBe('#abcdef');
    expect(rebuilt.canUndo()).toBe(false);

    history.undo();
    expect(next.indicators().map(s => s.indicatorId)).toEqual(['hist-osc']);
    history.undo();
    expect(rebuilt.get(made.id)?.style.color).not.toBe('#abcdef');
    history.undo();
    expect(rebuilt.get(made.id)).toBeUndefined();
    history.undo();
    expect(next.indicators()).toHaveLength(0);
    for (let i = 0; i < 4; i++) expect(history.redo()).toBe(true);
    expect(rebuilt.get(made.id)?.style.color).toBe('#abcdef');
    expect(next.indicators()).toHaveLength(2);
    // A step the new controller records joins the same timeline.
    rebuilt.remove(made.id);
    history.undo();
    expect(rebuilt.get(made.id)).toBeDefined();
  });

  it('follows a new drawing controller attached while the old one is still standing', () => {
    const { chart, draw, history } = rig();
    const made = draw.add(line(101));
    const next = makeChart();
    next.addSeries('candlestick').setData(bars(80));
    const rebuilt = new DrawingController(next);
    next.restoreState(chart.getState());
    history.attach(next, rebuilt);
    expect(history.undo()).toBe(true);
    expect(rebuilt.get(made.id)).toBeUndefined();
    // The old controller is no longer the timeline's to press.
    expect(draw.get(made.id)).toBeDefined();
    expect(history.redo()).toBe(true);
    expect(rebuilt.get(made.id)).toBeDefined();
  });

  it('drops the oldest steps past its limit', async () => {
    const chart = makeChart();
    chart.addSeries('candlestick').setData(bars(40));
    const draw = new DrawingController(chart);
    const history = new ChartHistory(chart, { draw, limit: 2 });
    for (const price of [1, 2, 3]) draw.add(line(100 + price));
    let n = 0;
    while (history.undo()) n++;
    expect(n).toBe(2);
    expect(draw.drawings()).toHaveLength(1);
  });

  it('notifies subscribers and stops after destroy', async () => {
    const { chart, history } = rig();
    const seen = vi.fn();
    history.subscribe(seen);
    chart.addIndicator('hist-osc');
    await settle();
    expect(seen).toHaveBeenCalled();
    history.destroy();
    seen.mockClear();
    chart.addIndicator('hist-osc');
    await settle();
    expect(seen).not.toHaveBeenCalled();
    expect(history.undo()).toBe(false);
    expect(history.isDestroyed).toBe(true);
  });
});

describe('settings the history leaves alone', () => {
  it('does not record a view change: a zoom, an axis drag, a pinned range', async () => {
    const { chart, history } = rig();
    chart.setVisibleLogicalRange({ from: 10, to: 40 });
    chart.panes()[0].priceScale.setAutoScale(false);
    chart.emit('objects:change', {});
    await settle();
    expect(history.canUndo()).toBe(false);
  });
});
