/**
 * A native restore that fails while it rebuilds a study, in the study's own
 * constructor or its first calculation, leaves the chart as it found it and
 * says why, instead of throwing once the studies it replaces are gone. That
 * is the one failure the checks before a restore cannot see.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/indicators/index';
import { Chart, type Bar } from '../src/index';
import { registerIndicator } from '../src/model/indicator-registry';
import { DrawingController } from '../src/draw/index';
import { fakeDocument } from './helpers/fake-dom';

const T0 = 1_700_000_000;
const bars: Bar[] = Array.from({ length: 60 }, (_, i) => ({ time: T0 + i * 60, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i }));

registerIndicator({ id: 'audit-273b-calc-throws', name: 'Fails to calculate', placement: 'pane', inputs: [],
  plots: [{ key: 'x', type: 'line', title: 'X' }], calc: () => { throw new Error('Audit calculation failure'); } });
registerIndicator({ id: 'audit-273b-build-throws', name: 'Fails to build', placement: 'pane', inputs: [],
  plots: [{ key: 'x', type: 'no-such-series-type' as 'line', title: 'X' }], calc: bars => ({ x: bars.map(bar => bar.close) }) });

const charts: Chart[] = [];
afterEach(() => { for (const chart of charts.splice(0)) chart.destroy(); });

function makeChart(): Chart {
  const chart = new Chart(fakeDocument().createElement('div'), {
    document: fakeDocument(), pixelRatio: () => 1, shortcuts: false,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
  });
  charts.push(chart);
  chart.applySize(800, 600);
  chart.addSeries('candlestick').setData(bars);
  return chart;
}

/**
 * The state as data. Compared by value: the draw tier rereads the drawings
 * laid back on and writes each record's fields in its own order.
 */
const saved = (chart: Chart): unknown => JSON.parse(JSON.stringify(chart.getState()));

/** A chart with studies on the price pane and their own, a drawing and a setting to lose. */
function furnished() {
  const chart = makeChart();
  const draw = new DrawingController(chart);
  const studies = [chart.addIndicator('sma', { length: 9 }), chart.addIndicator('rsi', { length: 7 })];
  draw.add({ tool: 'trend-line', paneIndex: 0, style: {}, points: [{ time: bars[5]!.time, price: 105 }, { time: bars[20]!.time, price: 120 }] });
  chart.setGridOptions({ vertLines: false, horzLines: false });
  return { chart, draw, ids: studies.map(study => study.id), before: saved(chart) };
}

describe('N01 follow-up: a study that fails while it is rebuilt', () => {
  it.each([
    ['its calculation', 'audit-273b-calc-throws', 'Audit calculation failure'],
    ['its constructor', 'audit-273b-build-throws', 'no-such-series-type'],
  ])('refuses the restore when %s throws and keeps every study, drawing and setting', (_, indicatorId, message) => {
    const { chart, draw, ids, before } = furnished();
    let report: ReturnType<Chart['restoreState']> | undefined;
    // Studies that build first, a grid and a timezone that land before the
    // studies do, and a pane: all of it has to go back.
    const state = { version: 1, timezone: 'America/New_York', grid: { vertLines: true, horzLines: true },
      indicators: [{ indicatorId: 'ema', settings: {} }, { indicatorId: 'macd', settings: {} }, { indicatorId, settings: {} }] };
    expect(() => { report = chart.restoreState(JSON.parse(JSON.stringify(state))); }).not.toThrow();
    expect(report?.applied).toBe(false);
    expect(report?.reason).toContain(message);
    expect(chart.indicators().map(item => item.id)).toEqual(ids);
    expect(draw.drawings()).toHaveLength(1);
    expect(saved(chart)).toEqual(before);
  });

  it('ends every restore it announces, and keeps the panes it had', () => {
    const { chart, before } = furnished();
    const events: string[] = [];
    chart.on('state:restore:start', () => events.push('start'));
    chart.on('state:restore:end', () => events.push('end'));
    chart.restoreState({ version: 1, indicators: [{ indicatorId: 'audit-273b-calc-throws', settings: {} }] });
    // Every start has its end, and the last word is an end.
    expect(events.filter(e => e === 'start').length).toBe(events.filter(e => e === 'end').length);
    expect(events[events.length - 1]).toBe('end');
    expect(saved(chart)).toEqual(before);
    expect(chart.panes()).toHaveLength(2);
  });

  it('restores as before once refused, and announces an ordinary restore once', () => {
    const { chart, ids } = furnished();
    chart.restoreState({ version: 1, indicators: [{ indicatorId: 'audit-273b-calc-throws', settings: {} }] });
    expect(chart.restoreState(chart.getState()).applied).toBe(true);
    expect(chart.indicators().map(item => item.id)).toEqual(ids);
    const reported = vi.fn();
    chart.on('state:restore:end', reported);
    expect(chart.restoreState({ version: 1, indicators: [{ indicatorId: 'rsi', settings: {} }] }).applied).toBe(true);
    expect(reported).toHaveBeenCalledTimes(1);
  });

  it('throws, once, when the state it lays back fails as well', () => {
    let failing = false;
    registerIndicator({ id: 'audit-273b-fails-later', name: 'Fails later', placement: 'pane', inputs: [],
      plots: [{ key: 'x', type: 'line', title: 'X' }],
      calc: bars => { if (failing) throw new Error('Audit later failure'); return { x: bars.map(bar => bar.close) }; } });
    const chart = makeChart();
    chart.addIndicator('audit-273b-fails-later');
    const state = chart.getState();
    failing = true;
    const ends = vi.fn();
    chart.on('state:restore:end', ends);
    expect(() => chart.restoreState(state)).toThrow('Audit later failure');
    // The restore and the one undo it tried, no more.
    expect(ends).toHaveBeenCalledTimes(2);
  });
});
