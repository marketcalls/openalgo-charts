/**
 * The pane limit a native restore holds a saved state to counts the panes its
 * studies will open, not only the ones it lists: a legacy study that names no
 * pane opens one of its own, so a list of them was a way past the limit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/indicators/index';
import { Chart, type Bar } from '../src/index';
import { fakeDocument } from './helpers/fake-dom';

const T0 = 1_700_000_000;
const bars: Bar[] = Array.from({ length: 30 }, (_, i) => ({ time: T0 + i * 60, open: 100, high: 102, low: 99, close: 101 }));
const PANE = { weight: 1, priceScale: { autoScale: true, marginTop: 0.1, marginBottom: 0.1, minMove: 0.01, mode: 'linear', inverted: false } };

const charts: Chart[] = [];
afterEach(() => { for (const chart of charts.splice(0)) chart.destroy(); });

/**
 * A chart that never paints. These cases count panes, not pixels, and a
 * recording context repainting hundreds of panes on every pane made keeps
 * every call it was ever given.
 */
function makeChart(): Chart {
  const chart = new Chart(fakeDocument().createElement('div'), {
    document: fakeDocument(), pixelRatio: () => 1, shortcuts: false,
    raf: { schedule: () => 1, cancel: () => {} },
  });
  charts.push(chart);
  chart.applySize(800, 600);
  chart.addSeries('candlestick').setData(bars);
  return chart;
}

/** `n` studies as a layout from before studies saved their pane: none names one. */
const legacy = (n: number, indicatorId = 'rsi') => Array.from({ length: n }, () => ({ indicatorId, settings: {} }));

/** The reason the explicit case gives, which the implicit one must give too. */
function listReason(): string | undefined {
  return makeChart().restoreState({ version: 1, panes: Array.from({ length: 300 }, () => PANE), indicators: [] }).reason;
}

describe('S3 follow-up: studies that name no pane are counted against the pane limit', () => {
  it('refuses 300 legacy pane studies before it changes anything, as it refuses 300 listed panes', () => {
    const chart = makeChart();
    const study = chart.addIndicator('macd');
    const before = JSON.stringify(chart.getState());
    const start = vi.fn();
    chart.on('state:restore:start', start);
    const report = chart.restoreState(JSON.parse(JSON.stringify({ version: 1, indicators: legacy(300) })));
    expect(report.applied).toBe(false);
    expect(report.reason).toBe(listReason());
    expect(start).not.toHaveBeenCalled();
    expect(chart.indicators().map(item => item.id)).toEqual([study.id]);
    expect(chart.panes()).toHaveLength(2);
    expect(JSON.stringify(chart.getState())).toBe(before);
  });

  it('counts the listed panes the studies open after', () => {
    const chart = makeChart();
    const report = chart.restoreState({ version: 1, panes: Array.from({ length: 200 }, () => PANE), indicators: legacy(57) });
    expect(report.applied).toBe(false);
    expect(report.reason).toBe(listReason());
    expect(chart.panes()).toHaveLength(1);
  });

  it('counts the panes up to a named slot, then the studies that open their own after it', () => {
    const chart = makeChart();
    const report = chart.restoreState({ version: 1, indicators: [{ indicatorId: 'rsi', settings: {}, paneIndex: 250 }, ...legacy(6)] });
    expect(report.applied).toBe(false);
    expect(chart.panes()).toHaveLength(1);
  });

  it('still restores a legacy layout that fills the limit exactly, and refuses one more', () => {
    const chart = makeChart();
    expect(chart.restoreState({ version: 1, indicators: legacy(256) }).applied).toBe(false);
    const report = chart.restoreState({ version: 1, indicators: legacy(255) });
    expect(report.applied, report.reason).toBe(true);
    expect(chart.panes()).toHaveLength(256);
    expect(chart.indicators()).toHaveLength(255);
  });

  it('does not count a price-pane study that names no pane', () => {
    const chart = makeChart();
    const report = chart.restoreState({ version: 1, indicators: [...legacy(300, 'sma'), ...legacy(2)] });
    expect(report.applied, report.reason).toBe(true);
    expect(chart.panes()).toHaveLength(3);
  });
});
