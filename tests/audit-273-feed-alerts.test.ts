/**
 * Trader alerts and the live display across history refreshes, failed
 * refreshes and a store held at its retention cap. Each of these reaches the
 * chart as a replacement of the primary bars rather than an append, and none
 * of them may cost an alert the bars the stream delivered meanwhile. A
 * replacement that is not the stream's own (a new series, a warm load) still
 * stays silent.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OpenAlgoLiveDataFeed } from '../src/feed/openalgo-live';
import type { SocketLike } from '../src/feed/openalgo-ws';
import type { Bar } from '../src/model/bar';
import { AlertController, Chart } from '../src/index';
import type { AlertTriggeredPayload, SeriesApi } from '../src/index';
import { createWidget, type Widget, type WidgetOptions } from '../src/widget/widget';
import { fakeDocument } from './helpers/fake-dom';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument } from './helpers/fake-dom-widget';

beforeAll(ensureWindowGlobal);
/** A minute boundary. */
const T = 1_700_000_040;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function deferred() {
  let resolve!: (bars: Bar[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Bar[]>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function make(history: () => Promise<Bar[]>, loading: WidgetOptions['loading'] = {}) {
  const sockets: SocketLike[] = [];
  const feed = new OpenAlgoLiveDataFeed({
    baseUrl: 'https://feed.test', apiKey: 'fixture', wsUrl: 'ws://feed.test', heartbeat: { timeoutMs: 0 },
    fetchImpl: (async () => ({ ok: true, json: async () => ({ status: 'success', data: await history() }) }) as Response) as typeof fetch,
    socketFactory: () => {
      const socket: SocketLike = { readyState: 1, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null };
      sockets.push(socket);
      return socket;
    },
  });
  cleanup.push(() => feed.close());
  const doc = fakeWidgetDocument();
  const widget: Widget = createWidget(fakeContainer(doc) as unknown as HTMLElement, {
    feed, symbol: 'X', exchange: 'NSE', interval: '1m', lookbackBars: 30, now: () => (T + 30) * 1000, loading,
    document: doc as unknown as Document, pixelRatio: () => 1,
    raf: { schedule: cb => { cb(); return 1; }, cancel: () => {} },
  });
  widget.chart.applySize(800, 600);
  cleanup.push(() => widget.destroy());
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'auth', status: 'success' }) });
  const fired: AlertTriggeredPayload[] = [];
  widget.chart.on('alert:triggered', payload => fired.push(payload as AlertTriggeredPayload));
  const tick = (time: number, price: number): void => sockets[0]!.onmessage?.({ data: JSON.stringify({
    type: 'market_data', mode: 1, topic: 'X.NSE', data: { ltp: price, ltq: 1, timestamp: time } }) });
  return { widget, fired, tick };
}

const b1: Bar = { time: T - 60, open: 99, high: 99.5, low: 98.5, close: 99, volume: 100 };
const b2: Bar = { time: T, open: 99, high: 99.5, low: 98.8, close: 99.2, volume: 10 };
const level = { source: { kind: 'price', price: 100 }, condition: 'crossing' } as const;

describe('alerts across a history refresh in flight', () => {
  it('judges a close whose rollover arrives while the refresh is out', async () => {
    const pending = deferred();
    let calls = 0;
    const { widget, fired, tick } = make(async () => ++calls === 1 ? [b1, b2] : pending.promise);
    await flush();
    widget.alerts.add({ ...level, policy: 'onBarClose' });
    tick(T + 40, 101);
    const refresh = widget.reload();
    await flush();
    tick(T + 61, 101.5);
    pending.resolve([b1, { ...b2, high: 101, close: 101, volume: 12 }, { time: T + 60, open: 101.5, high: 101.5, low: 101.5, close: 101.5, volume: 1 }]);
    await refresh;
    await flush();
    expect(fired.map(event => [event.time, event.price])).toEqual([[T, 101]]);
    tick(T + 121, 101.7);
    tick(T + 181, 101.8);
    expect(fired).toHaveLength(1);
  });

  it('judges a touch that lands while the refresh is out', async () => {
    const pending = deferred();
    let calls = 0;
    const { widget, fired, tick } = make(async () => ++calls === 1 ? [b1, b2] : pending.promise);
    await flush();
    widget.alerts.add({ ...level, policy: 'onTouch' });
    tick(T + 35, 99.5);
    const refresh = widget.reload();
    await flush();
    tick(T + 40, 101);
    // History has not seen the trade through the level yet.
    pending.resolve([b1, { ...b2, high: 99.6, close: 99.5, volume: 11 }]);
    await refresh;
    await flush();
    expect(fired.map(event => [event.time, event.price])).toEqual([[T, 100]]);
  });
});

describe('the live display and alerts after a failed refresh', () => {
  it('shows and judges what the stream delivered while the failed request was out', async () => {
    const pending = deferred();
    let calls = 0;
    const { widget, fired, tick } = make(async () => ++calls === 1 ? [b1, b2] : pending.promise);
    await flush();
    widget.alerts.add({ ...level, policy: 'onTouch' });
    tick(T + 35, 99.5);
    const refresh = widget.reload();
    await flush();
    tick(T + 40, 101);
    pending.reject(new Error('history 500'));
    await refresh;
    await flush();
    expect(widget.dataController!.getState().status).toBe('stale');
    expect(widget.series.getData().slice(-1)[0]).toMatchObject({ time: T, high: 101, close: 101 });
    expect(fired).toHaveLength(1);
  });

  it('keeps following the stream, judges each close once, and recovers on the next refresh', async () => {
    let calls = 0;
    const { widget, fired, tick } = make(async () => {
      if (++calls === 2) throw new Error('history 500');
      return calls === 1 ? [b1, b2] : [b1, { ...b2, high: 101, close: 101 }, { time: T + 60, open: 101.5, high: 101.6, low: 101.5, close: 101.6, volume: 2 }];
    });
    await flush();
    widget.alerts.add({ ...level, policy: 'onBarClose', repeat: 'everyTime' });
    await widget.reload();
    await flush();
    expect(widget.dataController!.getState().status).toBe('stale');
    tick(T + 40, 101);
    tick(T + 61, 101.5);
    tick(T + 62, 101.6);
    expect(widget.series.getData().map(bar => [bar.time, bar.close])).toEqual([[T - 60, 99], [T, 101], [T + 60, 101.6]]);
    expect(fired.map(event => event.time)).toEqual([T]);
    await widget.reload();
    await flush();
    expect(widget.dataController!.getState().status).toBe('ready');
    expect(fired.map(event => event.time)).toEqual([T]);
  });
});

describe('alerts on a store held at its retention cap', () => {
  it('judges the close of every bar the stream appends', async () => {
    const history: Bar[] = [];
    for (let i = 9; i >= 0; i--) history.push({ time: T - i * 60, open: 99, high: 99.5, low: 98.5, close: 99, volume: 100 });
    const { widget, fired, tick } = make(async () => history, { maxBars: 10 });
    await flush();
    widget.alerts.add({ ...level, policy: 'onBarClose', repeat: 'everyTime' });
    tick(T + 40, 101);
    tick(T + 61, 99.5);
    tick(T + 121, 99.4);
    expect(widget.series.getData()).toHaveLength(10);
    expect(fired.map(event => [event.time, event.price])).toEqual([[T, 101], [T + 60, 99.5]]);
  });
});

describe('a replacement the stream did not make stays silent', () => {
  const source = (i: number, close: number): Bar => ({ time: T + i * 60, open: close, high: close + 0.1, low: close - 0.1, close, volume: 10 });
  function chart(): { chart: Chart; series: SeriesApi; alerts: AlertController; fired: AlertTriggeredPayload[] } {
    const doc = fakeDocument();
    const chart = new Chart(doc.createElement('div'), { document: doc, pixelRatio: () => 1, shortcuts: false,
      raf: { schedule: callback => { callback(); return 1; }, cancel: () => {} } });
    cleanup.push(() => chart.destroy());
    chart.applySize(800, 600);
    chart.setDataContext({ symbol: 'X', exchange: 'NSE', interval: '1m' });
    const series = chart.addSeries('candlestick');
    series.setData([source(0, 99), source(1, 99.2)]);
    const alerts = new AlertController(chart, { visuals: false });
    const fired: AlertTriggeredPayload[] = [];
    chart.on('alert:triggered', event => fired.push(event as AlertTriggeredPayload));
    return { chart, series, alerts, fired };
  }

  it('judges a replacement that extends bars the alert judged as they arrived', () => {
    const { series, alerts, fired } = chart();
    alerts.add({ ...level, policy: 'onBarClose' });
    series.update(source(1, 99.4));
    series.setData([source(0, 99), source(1, 101), source(2, 101.2)]);
    expect(fired.map(event => event.time)).toEqual([T + 60]);
  });

  it('seeds a new series silently, even when its second load extends its first', () => {
    const { chart: owner, series, alerts, fired } = chart();
    alerts.add({ ...level, policy: 'onBarClose' });
    series.update(source(1, 99.4));
    // A warm load: cached closed bars first, then history that extends them.
    owner.setDataContext({ symbol: 'Y', exchange: 'NSE', interval: '1m' });
    owner.setDataContext({ symbol: 'X', exchange: 'NSE', interval: '1m' });
    series.setData([source(0, 99), source(1, 99.4)]);
    series.setData([source(0, 99), source(1, 101), source(2, 101.2)]);
    expect(fired).toEqual([]);
    series.update(source(3, 101.3));
    series.update(source(3, 99));
    series.update(source(4, 98.9));
    expect(fired.map(event => event.time)).toEqual([T + 180]);
  });
});
