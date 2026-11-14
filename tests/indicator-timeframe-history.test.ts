import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/indicators/index';
import { Chart } from '../src/core/chart';
import { getIndicator, indicatorDefaults, type IndicatorBarsProviderAccess, type IndicatorSettings, type IndicatorSnapshotRequest, type RequestedBarsSnapshot } from '../src/model/indicator-registry';
import type { Bar } from '../src/model/bar';
import { fakeDocument } from './helpers/fake-dom';
import { ReplayController } from '../src/replay/controller';

const day = 86400, start = Date.parse('2025-01-01T00:00:00Z') / 1000;
const daily: Bar[] = Array.from({ length: 300 }, (_, i) => ({ time: start + i * day, open: 100 + i * 0.2, high: 105 + i * 0.2, low: 95 + i * 0.2, close: 100 + i * 0.2 + 3 * Math.sin(i), volume: 1000 + i }));
const intraday: Bar[] = Array.from({ length: 12 }, (_, i) => ({ time: daily[299]!.time + (9 * 60 + i * 5) * 60, open: 399, high: 401, low: 398, close: 400 }));
const snapshot = (bars = daily): RequestedBarsSnapshot => ({ bars, availableAt: bars.map(bar => bar.time + 16 * 3600), confirmed: bars.map((_, i) => i < bars.length - 1) });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const charts: Chart[] = [];
const replays: ReplayController[] = [];
afterEach(() => { replays.splice(0).forEach(replay => replay.stop()); charts.splice(0).forEach(chart => chart.destroy()); });
function harness(overrides: Partial<IndicatorBarsProviderAccess> = {}) {
  const document = fakeDocument();
  const requestSnapshot = vi.fn(async (_request: IndicatorSnapshotRequest) => snapshot());
  const provider: IndicatorBarsProviderAccess = { supportsWarmup: true, requestBars: async () => [], requestSnapshot, ...overrides };
  const chart = new Chart(document.createElement('div'), { document, barsProvider: provider, pixelRatio: () => 1, shortcuts: false, raf: { schedule: () => 1, cancel: () => {} } });
  charts.push(chart); chart.applySize(800, 600);
  chart.setDataContext({ symbol: 'TEST', exchange: 'TEST', interval: '5m' });
  const series = chart.addSeries('candlestick'); series.setData(intraday);
  return { chart, series, requestSnapshot };
}

describe('built-in independent timeframe history', () => {
  it('shows daily EMA 200 on a short five-minute chart using the exact daily calculation', async () => {
    const h = harness(), indicator = h.chart.addIndicator('ema', { length: 200, timeframe: 'D' });
    await settle();
    const descriptor = getIndicator('ema')!;
    const expected = descriptor.calc(daily, { ...indicatorDefaults(descriptor), length: 200, timeframe: '' }, {}).ma![298];
    expect(expected).not.toBeNull();
    expect(indicator.values().ma).toEqual(intraday.map(() => expected));
    expect(h.requestSnapshot.mock.calls[0]![0]).toMatchObject({ interval: 'D', warmupBars: 200 });
    expect(indicator.dataStatus()?.state).toBe('ready');
  });
  it('retains the legacy fold for providers without the warmup contract', async () => {
    const h = harness({ supportsWarmup: false });
    const indicator = h.chart.addIndicator('ema', { length: 200, timeframe: 'D' });
    await settle();
    expect(indicator.values().ma!.every(value => value === null)).toBe(true);
    expect(h.requestSnapshot).not.toHaveBeenCalled();
  });
  it('does not request daily history on price-only updates or style changes', async () => {
    const h = harness(), indicator = h.chart.addIndicator('ema', { length: 200, timeframe: 'D' });
    await settle();
    const before = [...indicator.values().ma!];
    h.series.update({ ...intraday[intraday.length - 1]!, close: 500 });
    indicator.setSettings({ 'ma:color': '#ff0000' });
    await settle();
    expect(indicator.values().ma).toEqual(before);
    expect(h.requestSnapshot).toHaveBeenCalledTimes(1);
    indicator.setSettings({ length: 210 });
    await settle();
    expect(h.requestSnapshot).toHaveBeenCalledTimes(2);
    expect(h.requestSnapshot.mock.calls[1]![0].warmupBars).toBe(210);
  });
  it('aborts removed or superseded requests', async () => {
    const requests: IndicatorSnapshotRequest[] = [];
    const h = harness({ requestSnapshot: request => { requests.push(request); return new Promise(() => {}); } });
    const indicator = h.chart.addIndicator('ema', { length: 200, timeframe: 'D' });
    expect(requests).toHaveLength(1);
    h.chart.setDataContext({ symbol: 'SECOND', exchange: 'TEST', interval: '5m' });
    expect(requests[0]!.signal?.aborted).toBe(true);
    h.chart.removeIndicator(indicator.id);
    expect(requests[requests.length - 1]!.signal?.aborted).toBe(true);
  });
  it('requests a timeframe the chart bars do not divide into; only the local fold refuses it', async () => {
    const h = harness();
    h.chart.setDataContext({ symbol: 'TEST', exchange: 'TEST', interval: '3m' });
    const indicator = h.chart.addIndicator('ema', { length: 5, timeframe: '5m' });
    await settle();
    expect(h.requestSnapshot.mock.calls[h.requestSnapshot.mock.calls.length - 1]![0]).toMatchObject({ interval: '5m' });
    expect(indicator.dataStatus()?.state).toBe('ready');
    const legacy = harness({ supportsWarmup: false });
    legacy.chart.setDataContext({ symbol: 'TEST', exchange: 'TEST', interval: '3m' });
    const folded = legacy.chart.addIndicator('ema', { length: 5, timeframe: '5m' });
    await settle();
    expect(folded.values().ma.every(value => value === null)).toBe(true);
    expect(String((folded.dataStatus() as { error?: unknown } | null)?.error)).toMatch(/not a whole multiple/);
    expect(legacy.requestSnapshot).not.toHaveBeenCalled();
  });
  it('rejects forward-looking displacement on independent history', async () => {
    const h = harness(), indicator = h.chart.addIndicator('donchian', { length: 20, offset: -1, timeframe: 'D' });
    await settle();
    expect(indicator.dataStatus()?.state).toBe('unsupported');
    expect(h.requestSnapshot).not.toHaveBeenCalled();
  });
  it('refreshes on a provider revision and never exposes the current daily close', async () => {
    const h = harness(), indicator = h.chart.addIndicator('ema', { length: 200, timeframe: 'D' });
    await settle();
    const before = [...indicator.values().ma!];
    const changed = daily.map((bar, i) => i === 299 ? { ...bar, close: 9999 } : bar);
    h.chart.setBarsProvider({ supportsWarmup: true, requestBars: async () => [], requestSnapshot: async () => snapshot(changed) });
    await settle();
    expect(indicator.values().ma).toEqual(before);
  });
  it('refreshes an expanded chart history and clears requested status on returning to chart timeframe', async () => {
    const h = harness(), indicator = h.chart.addIndicator('ema', { length: 200, timeframe: 'D' });
    await settle();
    h.series.setData([{ ...intraday[0]!, time: intraday[0]!.time - day }, ...intraday]);
    await settle();
    expect(h.requestSnapshot).toHaveBeenCalledTimes(2);
    expect(h.requestSnapshot.mock.calls[1]![0].from).toBe(intraday[0]!.time - day);
    h.chart.setBarsProvider({ supportsWarmup: true, requestBars: async () => [], requestSnapshot: async () => { throw new Error('offline'); } });
    await settle();
    expect(indicator.dataStatus()?.state).toBe('error');
    indicator.setSettings({ timeframe: '', length: 3 });
    expect(indicator.values().ma!.some(value => value !== null)).toBe(true);
    expect(indicator.dataStatus()?.state).toBe('ready');
  });
  it('respects unknown availability barriers', async () => {
    const value = snapshot(); value.availableAt = value.availableAt.map((at, i) => i === 200 ? null : at);
    const h = harness({ requestSnapshot: async () => value });
    const indicator = h.chart.addIndicator('ema', { length: 200, timeframe: 'D' });
    await settle();
    const descriptor = getIndicator('ema')!;
    const expected = descriptor.calc(daily, { ...indicatorDefaults(descriptor), length: 200, timeframe: '' }, {}).ma![199];
    expect(indicator.values().ma).toEqual(intraday.map(() => expected));
  });
  it('requests historical versions on replay entry, backward seek and exit', async () => {
    const h = harness(), indicator = h.chart.addIndicator('ema', { length: 200, timeframe: 'D' });
    await settle();
    const expected = [...indicator.values().ma!];
    const later = intraday[8]!.time + 60, earlier = intraday[3]!.time + 60;
    const replay = new ReplayController(h.chart, { timing: { barEndTime: bar => bar.time + 300 }, startTime: later });
    replays.push(replay); await settle();
    expect(h.requestSnapshot.mock.calls[h.requestSnapshot.mock.calls.length - 1]![0].asOf).toBe(later);
    replay.seekTime(earlier); await settle();
    expect(h.requestSnapshot.mock.calls[h.requestSnapshot.mock.calls.length - 1]![0].asOf).toBe(earlier);
    expect(indicator.values().ma!.every(value => value === expected[0])).toBe(true);
    replay.stop(); await settle();
    expect(h.requestSnapshot.mock.calls[h.requestSnapshot.mock.calls.length - 1]![0].asOf).toBeUndefined();
    expect(indicator.values().ma).toEqual(expected);
  });
});

// Every opted-in kernel must receive enough real observations for a data plot.
// Filled background columns alone would conceal an unwarmed multi-stage smoother.
describe('built-in warmup recipes', () => {
  const ids = ['sma', 'ema', 'wma', 'vwma', 'hma', 'dema', 'tema', 'alma', 'smma', 't3', 'lsma', 'kama', 'mcginley-dynamic', 'zlema', 'vidya', 'bollinger', 'keltner-channel', 'donchian', 'envelope', 'supertrend', 'parabolic-sar', 'atr', 'rsi', 'macd', 'stochastic', 'stochastic-rsi', 'williams-percent-r', 'cci', 'adx'];
  it.each(ids)('%s requests sufficient default and configured history', async id => {
    for (const changed of [false, true]) {
      const descriptor = getIndicator(id)!;
      const settings: IndicatorSettings = indicatorDefaults(descriptor);
      if (changed) for (const input of descriptor.inputs) {
        if (input.type === 'number' && /length|period|smoothing/i.test(input.key)) settings[input.key] = 25;
      }
      let count = 0;
      const h = harness({ requestSnapshot: async request => {
        count = request.warmupBars ?? 0;
        const bars = daily.slice(299 - count, 299);
        return { bars, availableAt: bars.map(bar => bar.time + 16 * 3600), confirmed: bars.map(() => true) };
      } });
      const indicator = h.chart.addIndicator(id, { ...settings, timeframe: 'D' });
      await settle();
      expect(count, `${id} warmup`).toBeGreaterThan(0);
      const values = indicator.values();
      const plotKeys = descriptor.plots.filter(plot => plot.type === 'line' || plot.type === 'histogram').map(plot => plot.key);
      expect(plotKeys.some(key => values[key]?.some(value => value !== null && Number.isFinite(value))), `${id}: ${count} bars`).toBe(true);
      h.chart.destroy();
    }
  });
});
