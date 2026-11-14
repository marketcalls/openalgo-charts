/**
 * What a native restore refuses before it changes anything, and what it never
 * takes from a saved state: a study on a pane slot that cannot exist, a pane
 * list no chart could hold, and a callback where the state can only carry
 * data. Each case is a document a host may restore without having built it.
 */
import { describe, expect, it } from 'vitest';
import '../src/indicators/index';
import { Chart, type Bar } from '../src/index';
import { DrawingController } from '../src/draw/index';
import { parseWorkspaceDocument } from '../src/workspace/index';
import { fakeDocument } from './helpers/fake-dom';
import { workspaceFixture } from './helpers/workspace-fixture';

const T0 = 1_700_000_000;
const bars: Bar[] = Array.from({ length: 60 }, (_, i) => ({ time: T0 + i * 60, open: 100, high: 102, low: 99, close: 101 }));

function makeChart(frames?: Array<() => void>, clock?: () => number): Chart {
  const chart = new Chart(fakeDocument().createElement('div'), {
    document: fakeDocument(), pixelRatio: () => 1, shortcuts: false,
    raf: frames === undefined
      ? { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} }
      : { schedule: (cb: () => void) => { frames.push(cb); return frames.length; }, cancel: () => {} },
    ...(clock === undefined ? {} : { axisChrome: { clock } }),
  });
  chart.applySize(800, 600);
  chart.addSeries('candlestick').setData(bars);
  return chart;
}

const PANE = { weight: 1, priceScale: { autoScale: true, marginTop: 0.1, marginBottom: 0.1, minMove: 0.01, mode: 'linear', inverted: false } };

describe('native restore: study placement is checked before anything changes', () => {
  it.each([-1, 0.5, 'bad', null, 300])('refuses a study on pane %j and keeps the studies, drawings and settings it had', (paneIndex) => {
    const chart = makeChart();
    const draw = new DrawingController(chart);
    const sma = chart.addIndicator('sma', { length: 9 });
    const line = draw.add({ tool: 'trend-line', paneIndex: 0, style: {}, points: [{ time: bars[5]!.time, price: 100 }, { time: bars[20]!.time, price: 101 }] });
    chart.setGridOptions({ vertLines: false, horzLines: false });
    const before = JSON.stringify(chart.getState());
    let report: ReturnType<Chart['restoreState']> | undefined;
    // A JSON round trip, as a document read from storage or a share arrives.
    expect(() => {
      report = chart.restoreState(JSON.parse(JSON.stringify({ version: 1, grid: { vertLines: true, horzLines: true },
        indicators: [{ indicatorId: 'rsi', settings: { length: 14 }, paneIndex }] })));
    }).not.toThrow();
    expect(report?.applied).toBe(false);
    expect(report?.reason).toMatch(/pane/i);
    expect(chart.indicators().map(item => item.id)).toEqual([sma.id]);
    expect(draw.drawings().map(item => item.id)).toEqual([line.id]);
    expect(JSON.stringify(chart.getState())).toBe(before);
  });

  it('still places a study on a pane the layout leaves to it, and one that names no pane', () => {
    const chart = makeChart();
    expect(chart.restoreState({ version: 1, indicators: [{ indicatorId: 'rsi', settings: {}, paneIndex: 2 }] }).applied).toBe(true);
    expect(chart.indicators()).toHaveLength(1);
    const legacy = { version: 1, indicators: [{ indicatorId: 'rsi', settings: {} }] };
    expect(chart.restoreState(legacy).applied).toBe(true);
    expect(chart.indicators()).toHaveLength(1);
  });
});

describe('native restore: the pane list is bounded', () => {
  it('refuses a pane list far past any chart, before it makes one pane', () => {
    const chart = makeChart();
    const study = chart.addIndicator('rsi');
    const panes = chart.panes().length;
    const report = chart.restoreState({ version: 1, panes: Array.from({ length: 300 }, () => PANE), indicators: [] });
    expect(report.applied).toBe(false);
    expect(report.reason).toMatch(/pane/i);
    expect(chart.panes()).toHaveLength(panes);
    expect(chart.indicators().map(item => item.id)).toEqual([study.id]);
  });

  it('still restores a host layout with more panes than a portable workspace allows', () => {
    const chart = makeChart();
    const report = chart.restoreState({ version: 1, panes: Array.from({ length: 64 }, () => PANE),
      indicators: Array.from({ length: 63 }, (_, i) => ({ indicatorId: 'rsi', settings: {}, paneIndex: i + 1 })) });
    expect(report.applied, report.reason).toBe(true);
    expect(chart.panes()).toHaveLength(64);
  });
});

describe('native restore: the wall clock is never state', () => {
  it('keeps the host clock when a saved state carries one, and paints every frame after', () => {
    const frames: Array<() => void> = [];
    const chart = makeChart(frames, () => T0 + 3600);
    while (frames.length) frames.shift()!();
    const report = chart.restoreState(JSON.parse('{"version":1,"axisChrome":{"sessionClock":true,"barCountdown":true,"clock":1}}'));
    expect(report.applied).toBe(true);
    // The switches are state and land; the callback is the host's and stays.
    expect(chart.axisChromeOptions().barCountdown).toBe(true);
    expect(chart.axisChromeOptions().sessionClock).toBe(true);
    expect(typeof chart.axisChromeOptions().clock).toBe('function');
    for (let n = 0; n < 3; n++) {
      chart.applySize(800 + n, 600);
      expect(() => { while (frames.length) frames.shift()!(); }).not.toThrow();
    }
  });

  it('is dropped by the workspace parser, which keeps the switches', () => {
    const doc = workspaceFixture();
    (doc.panes[0].chart as Record<string, unknown>).axisChrome = { sessionClock: true, barCountdown: true, clock: 1 };
    expect(parseWorkspaceDocument(doc).panes[0]!.chart.axisChrome).toEqual({ sessionClock: true, barCountdown: true });
  });
});
