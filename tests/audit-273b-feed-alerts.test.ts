/**
 * Trader alerts on what the stream delivered while a history refresh held the
 * display. The display stays where it was until the refresh lands, so an
 * alert armed after the last update, or a touch that crossed the level and
 * came back inside one bar, saw the stream only as part of the replacement
 * the refresh brings, which it cannot tell from history and so seeded on.
 * History the stream never delivered stays silent.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DataLoadingController } from '../src/feed/data-controller';
import { OpenAlgoLiveDataFeed } from '../src/feed/openalgo-live';
import type { SocketLike } from '../src/feed/openalgo-ws';
import type { BarsRequest } from '../src/feed/types';
import type { Bar } from '../src/model/bar';
import type { AlertTriggeredPayload } from '../src/index';
import { createWidget, type Widget } from '../src/widget/widget';
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

function make(history: () => Promise<Bar[]>) {
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
    feed, symbol: 'X', exchange: 'NSE', interval: '1m', lookbackBars: 30, now: () => (T + 30) * 1000,
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

describe('an alert armed after the last update, whose first tick arrives during a refresh', () => {
  it('fires on a touch without a refresh, the control', async () => {
    const { widget, fired, tick } = make(async () => [b1, b2]);
    await flush();
    widget.alerts.add({ ...level, policy: 'onTouch' });
    tick(T + 40, 101);
    expect(fired).toHaveLength(1);
  });

  it.each(['onTouch', 'onBarClose'] as const)('judges that tick, %s', async policy => {
    const pending = deferred();
    let calls = 0;
    const { widget, fired, tick } = make(async () => ++calls === 1 ? [b1, b2] : pending.promise);
    await flush();
    widget.alerts.add({ ...level, policy });
    const refresh = widget.reload();
    await flush();
    tick(T + 40, 101);
    if (policy === 'onBarClose') tick(T + 61, 101.5);
    // The display is held while history is out.
    expect(widget.series.getData().slice(-1)[0]).toMatchObject({ time: T, close: 99.2 });
    pending.resolve([b1, b2]);
    await refresh;
    await flush();
    expect(fired.map(event => [event.time, event.price])).toEqual([[T, policy === 'onTouch' ? 100 : 101]]);
    expect(widget.series.getData().find(bar => bar.time === T)).toMatchObject({ high: 101, close: 101 });
  });

  it('judges it when the refresh fails too', async () => {
    const pending = deferred();
    let calls = 0;
    const { widget, fired, tick } = make(async () => ++calls === 1 ? [b1, b2] : pending.promise);
    await flush();
    widget.alerts.add({ ...level, policy: 'onTouch' });
    const refresh = widget.reload();
    await flush();
    tick(T + 40, 101);
    pending.reject(new Error('history 500'));
    await refresh;
    await flush();
    expect(widget.dataController!.getState().status).toBe('stale');
    expect(fired).toHaveLength(1);
  });

  it('stays silent when only history moved the bar across the level', async () => {
    const pending = deferred();
    let calls = 0;
    const { widget, fired, tick } = make(async () => ++calls === 1 ? [b1, b2] : pending.promise);
    await flush();
    widget.alerts.add({ ...level, policy: 'onTouch' });
    widget.alerts.add({ ...level, policy: 'onBarClose' });
    const refresh = widget.reload();
    await flush();
    pending.resolve([b1, { ...b2, high: 101, close: 101 }, { time: T + 60, open: 101.2, high: 101.4, low: 101.1, close: 101.3, volume: 3 }]);
    await refresh;
    await flush();
    expect(fired).toEqual([]);
    // The stream after the refresh is judged as usual.
    tick(T + 65, 99.6);
    expect(fired.map(event => event.time)).toEqual([T + 60]);
  });
});

describe('a touch that crosses and returns inside one bar while a refresh is out', () => {
  it('fires once on the excursion', async () => {
    const pending = deferred();
    let calls = 0;
    const { widget, fired, tick } = make(async () => ++calls === 1 ? [b1, b2] : pending.promise);
    await flush();
    widget.alerts.add({ ...level, policy: 'onTouch' });
    tick(T + 35, 99.5);
    const refresh = widget.reload();
    await flush();
    tick(T + 40, 101);
    tick(T + 45, 99.6);
    pending.resolve([b1, b2]);
    await refresh;
    await flush();
    expect(widget.series.getData().slice(-1)[0]).toMatchObject({ time: T, high: 101, close: 99.6 });
    expect(fired.map(event => [event.time, event.price])).toEqual([[T, 100]]);
  });
});

describe('the data controller across a refresh that held the display', () => {
  const req: BarsRequest = { symbol: 'AAA', exchange: 'NSE', interval: '1m', from: 0, to: 300 };
  const bar = (time: number, close: number): Bar => ({ time, open: 10, high: Math.max(10, close), low: Math.min(10, close), close, volume: 5 });

  it('shows each bar the stream delivered meanwhile, in order, before the refresh replaces them', async () => {
    const pending = deferred();
    let calls = 0;
    let push!: (value: Bar) => void;
    const controller = new DataLoadingController({ getBars: async () => ++calls === 1 ? [bar(60, 11), bar(120, 12)] : pending.promise,
      subscribeBars: (_request, callback) => { push = callback; return () => {}; } }, { now: () => 300 });
    cleanup.push(() => controller.destroy());
    await controller.load(req);
    const seen: [string, string, number[]][] = [];
    controller.subscribe(state => seen.push([state.reason, state.status, state.bars.map(item => item.close)]));
    const refresh = controller.refresh();
    push(bar(120, 13));
    push(bar(120, 14));
    push(bar(180, 15));
    expect(seen).toEqual([['state', 'refreshing', [11, 12]]]);
    pending.resolve([bar(60, 11), bar(120, 12)]);
    await refresh;
    expect(seen).toEqual([
      ['state', 'refreshing', [11, 12]],
      ['live', 'refreshing', [11, 14]],
      ['live', 'refreshing', [11, 14, 15]],
      ['refresh', 'ready', [11, 14, 15]],
    ]);
  });

  function streamed(second: () => Promise<Bar[]>) {
    let calls = 0;
    let push!: (value: Bar) => void;
    const controller = new DataLoadingController({
      getBars: async request => request.symbol !== 'AAA' ? [bar(60, 50)] : ++calls === 1 ? [bar(60, 11), bar(120, 12)] : second(),
      subscribeBars: (_request, callback) => { push = callback; return () => {}; } }, { now: () => 300 });
    cleanup.push(() => controller.destroy());
    return { controller, push: (value: Bar) => push(value) };
  }

  it('shows nothing while paused, which holds the display', async () => {
    const pending = deferred();
    const { controller, push } = streamed(() => pending.promise);
    await controller.load(req);
    controller.setPaused(true);
    const seen: [string, number[]][] = [];
    controller.subscribe(state => seen.push([state.reason, state.bars.map(item => item.close)]));
    const refresh = controller.refresh();
    push(bar(120, 13));
    pending.resolve([bar(60, 11), bar(120, 12)]);
    await refresh;
    expect(seen).toEqual([['state', [11, 12]], ['refresh', [11, 12]]]);
    expect(controller.bars().map(item => item.close)).toEqual([11, 13]);
  });

  it('stops when a listener moves to another instrument on the way', async () => {
    const pending = deferred();
    const { controller, push } = streamed(() => pending.promise);
    await controller.load(req);
    const seen: [string, string | undefined, number[]][] = [];
    let moved: Promise<readonly Bar[]> | undefined;
    controller.subscribe(state => {
      seen.push([state.reason, state.request?.symbol, state.bars.map(item => item.close)]);
      if (state.reason === 'live') moved ??= controller.load({ ...req, symbol: 'BBB' });
    });
    const refresh = controller.refresh();
    push(bar(120, 13));
    push(bar(180, 14));
    pending.resolve([bar(60, 11), bar(120, 12)]);
    await refresh;
    await moved;
    expect(seen.filter(([, symbol]) => symbol === 'AAA')).toEqual([['state', 'AAA', [11, 12]], ['live', 'AAA', [11, 13]]]);
    // Nothing of the abandoned refresh reaches the new instrument's snapshots.
    expect(seen.filter(([, symbol, closes]) => symbol === 'BBB' && closes.some(close => close !== 50))).toEqual([]);
    expect(controller.bars().map(item => item.close)).toEqual([50]);
  });

  it('shows nothing extra when the stream delivered nothing meanwhile', async () => {
    const controller = new DataLoadingController({ getBars: async () => [bar(60, 11), bar(120, 12)],
      subscribeBars: () => () => {} }, { now: () => 300 });
    cleanup.push(() => controller.destroy());
    await controller.load(req);
    const reasons: string[] = [];
    controller.subscribe(state => reasons.push(state.reason));
    await controller.refresh();
    expect(reasons).toEqual(['state', 'refresh']);
  });
});
