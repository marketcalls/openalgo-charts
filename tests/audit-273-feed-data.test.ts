/**
 * The packaged live feed and the data controller against history they did not
 * build: a seed off the epoch grid, frames without a quantity, a refresh that
 * lags the stream, a derived timeframe fed stale frames, and a warm load whose
 * tail request comes back empty.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAlgoLiveDataFeed } from '../src/feed/openalgo-live';
import { CandleBuilder } from '../src/feed/candle-builder';
import { DataLoadingController } from '../src/feed/data-controller';
import { withBarCache } from '../src/feed/cache';
import { withTimeframes } from '../src/feed/timeframe-feed';
import { SessionCalendar } from '../src/feed/instrument';
import type { BarSubscriptionOptions, BarsRequest, DataFeed } from '../src/feed/types';
import type { Bar } from '../src/model/bar';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

/** UTC seconds of a wall-clock time in IST on 12 November 2026 (plus `days`). */
const ist = (h: number, m: number, days = 0): number => Date.UTC(2026, 10, 12 + days, h, m) / 1000 - 19_800;

function liveFeed() {
  let socket: { onmessage: ((event: { data: string }) => void) | null } | undefined;
  const feed = new OpenAlgoLiveDataFeed({
    apiKey: 'k', baseUrl: '', wsUrl: 'ws://test', heartbeat: { timeoutMs: 0 },
    socketFactory: () => (socket = { readyState: 1, send() {}, close() {}, onopen: null, onclose: null, onmessage: null } as never),
  });
  cleanup.push(() => feed.close());
  const frame = (data: Record<string, unknown>): void => socket!.onmessage!({ data: JSON.stringify({ data: { symbol: 'X', exchange: 'NSE', ...data } }) });
  /** Subscribe seeded from `seed`, returning every bar the feed delivers. */
  const subscribe = (interval: string, seed: Bar): Bar[] => {
    const bars: Bar[] = [];
    feed.subscribeBars({ symbol: 'X', exchange: 'NSE', interval, from: 0 }, bar => bars.push(bar), { seedFrom: seed });
    return bars;
  };
  return { frame, subscribe };
}
const seedAt = (time: number): Bar => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 1000 });

describe('the live candle grid follows the history it is seeded with', () => {
  it('keeps session-anchored hourly bars on their 09:15 grid', () => {
    const { frame, subscribe } = liveFeed();
    const bars = subscribe('1h', seedAt(ist(10, 15)));
    for (const [h, m, price] of [[10, 20, 101], [10, 29, 102], [10, 31, 104.8], [11, 10, 106]] as const) frame({ ltp: price, ltq: 1, timestamp: ist(h, m) });
    expect(bars.map(bar => bar.time)).toEqual([ist(10, 15), ist(10, 15), ist(10, 15), ist(10, 15)]);
    expect(bars[3]).toMatchObject({ open: 100, high: 106, close: 106 });
    frame({ ltp: 107, ltq: 1, timestamp: ist(11, 16) });
    expect(bars[4]!.time).toBe(ist(11, 15));
  });

  it('keeps thirty-minute bars on the session grid', () => {
    const { frame, subscribe } = liveFeed();
    const bars = subscribe('30m', seedAt(ist(10, 15)));
    frame({ ltp: 101, ltq: 1, timestamp: ist(10, 31) });
    frame({ ltp: 102, ltq: 1, timestamp: ist(10, 46) });
    expect(bars.map(bar => bar.time)).toEqual([ist(10, 15), ist(10, 45)]);
  });

  it('keeps a daily bar stamped at IST midnight whole through the day', () => {
    const { frame, subscribe } = liveFeed();
    const bars = subscribe('D', seedAt(ist(0, 0)));
    frame({ ltp: 101, ltq: 1, timestamp: ist(10, 0) });
    frame({ ltp: 102, ltq: 1, timestamp: ist(15, 0) });
    frame({ ltp: 103, ltq: 1, timestamp: ist(9, 20, 1) });
    expect(bars.map(bar => bar.time)).toEqual([ist(0, 0), ist(0, 0), ist(0, 0, 1)]);
  });

  it('leaves a daily bar stamped at 00:00 UTC exactly as before', () => {
    const { frame, subscribe } = liveFeed();
    const midnight = Date.UTC(2026, 10, 12) / 1000;
    const bars = subscribe('D', seedAt(midnight));
    frame({ ltp: 101, ltq: 1, timestamp: ist(10, 0) });
    frame({ ltp: 102, ltq: 1, timestamp: ist(6, 0, 1) });
    expect(bars.map(bar => bar.time)).toEqual([midnight, midnight + 86_400]);
  });

  it('keeps a Monday-stamped weekly bar whole through Friday', () => {
    const { frame, subscribe } = liveFeed();
    const monday = Date.UTC(2026, 10, 9) / 1000;
    const bars = subscribe('W', seedAt(monday));
    frame({ ltp: 101, ltq: 1, timestamp: monday + 2 * 86_400 + 18_000 });
    frame({ ltp: 102, ltq: 1, timestamp: monday + 4 * 86_400 + 18_000 });
    frame({ ltp: 103, ltq: 1, timestamp: monday + 7 * 86_400 + 18_000 });
    expect(bars.map(bar => bar.time)).toEqual([monday, monday, monday + 604_800]);
  });
});

describe('live volume without a quantity on the frame', () => {
  it('leaves a new bar volume unknown, and the seeded bar its own, on price-only frames', () => {
    const { frame, subscribe } = liveFeed();
    const bars = subscribe('1m', seedAt(ist(10, 15)));
    frame({ ltp: 101, timestamp: ist(10, 15) + 20 });
    frame({ ltp: 102, timestamp: ist(10, 16) + 5 });
    frame({ ltp: 103, timestamp: ist(10, 16) + 9 });
    expect(bars.map(bar => bar.volume)).toEqual([1000, undefined, undefined]);
  });

  it('takes the change in the day total when a frame carries one but no quantity', () => {
    const { frame, subscribe } = liveFeed();
    const bars = subscribe('1m', seedAt(ist(10, 15)));
    frame({ ltp: 101, volume: 50_000, timestamp: ist(10, 15) + 20 });
    frame({ ltp: 101, volume: 50_030, timestamp: ist(10, 15) + 40 });
    frame({ ltp: 102, volume: 50_050, timestamp: ist(10, 16) + 5 });
    expect(bars.map(bar => bar.volume)).toEqual([1000, 1030, 20]);
  });

  it('still sums the quantity a frame does carry', () => {
    const builder = new CandleBuilder({ intervalSec: 60 });
    builder.seed(seedAt(600));
    builder.onTick({ time: 610, price: 101, ltq: 4, cumDayVolume: 90_000 });
    expect(builder.onTick({ time: 660, price: 102, ltq: 3, cumDayVolume: 90_100 })!.bar.volume).toBe(3);
  });

  it('keeps the builder counting a frame with neither as no volume, as hosts that fill it from history rely on', () => {
    // OpenAlgo's terminal drives the builder on Depth frames, which carry no
    // quantity, and seeds the volume from history polls: its bars stay numbers.
    const builder = new CandleBuilder({ intervalSec: 60 });
    builder.seed(seedAt(600));
    expect(builder.onTick({ time: 610, price: 101 })!.bar.volume).toBe(1000);
    expect(builder.onTick({ time: 660, price: 102 })!.bar.volume).toBe(0);
    expect(builder.onTick({ time: 670, price: 103 })!.bar.volume).toBe(0);
  });

  it('does not read a missing day total as a reset in day-delta mode', () => {
    const builder = new CandleBuilder({ intervalSec: 60, volumeMode: 'day-delta' });
    builder.onTick({ time: 600, price: 100, cumDayVolume: 1000 });
    builder.onTick({ time: 610, price: 101, cumDayVolume: 1500 });
    expect(builder.onTick({ time: 620, price: 102 })!.bar.volume).toBe(500);
    expect(builder.onTick({ time: 660, price: 103 })!.bar.volume).toBe(0);
    expect(builder.onTick({ time: 670, price: 103, cumDayVolume: 1600 })!.bar.volume).toBe(100);
  });
});

const bar = (time: number, close: number): Bar => ({ time, open: 10, high: Math.max(10, close), low: Math.min(10, close), close, volume: 5 });
const req: BarsRequest = { symbol: 'AAA', exchange: 'NSE', interval: '1m', from: 100, to: 300 };

describe('a refresh of the forming bar', () => {
  function streamed(history: () => Bar[]) {
    let push!: (value: Bar) => void;
    let options!: BarSubscriptionOptions;
    const controller = new DataLoadingController({ getBars: async () => history(),
      subscribeBars: (_request, callback, opts) => { push = callback; options = opts!; return () => {}; } }, { now: () => 300 });
    cleanup.push(() => controller.destroy());
    return { controller, push: (value: Bar) => push(value), resync: () => options.onResync!() };
  }

  it('keeps the close the stream showed over a history snapshot that lags it', async () => {
    let calls = 0;
    const { controller, push } = streamed(() => [bar(200, ++calls === 1 ? 10 : 9)]);
    await controller.load(req);
    push(bar(200, 15));
    await controller.refresh();
    expect(controller.bars()[0]).toMatchObject({ open: 10, high: 15, low: 9, close: 15 });
  });

  it('takes the history close after the stream asked to resynchronise', async () => {
    let calls = 0;
    const { controller, push, resync } = streamed(() => [bar(200, ++calls === 1 ? 10 : 20)]);
    await controller.load(req);
    push(bar(200, 15));
    resync();
    await flush();
    expect(controller.bars()[0]).toMatchObject({ high: 20, close: 20 });
  });
});

describe('a derived timeframe fed frames stamped in an older bucket', () => {
  it('neither refreshes history nor resubscribes for them', async () => {
    const start = Date.parse('2026-01-28T09:00:00Z') / 1000;
    const calendar = new SessionCalendar({ timezone: 'UTC', sessions: ['0900-1000:23456'] });
    let requests = 0;
    let subscriptions = 0;
    let emit!: (value: Bar) => void;
    const source: DataFeed = {
      getBars: async () => { requests++; return Array.from({ length: 21 }, (_, i) => bar(start + i * 60, 10)); },
      subscribeBars: (_request, callback) => { subscriptions++; emit = callback; return () => {}; },
    };
    const now = start + 20 * 60 + 30;
    const feed = withTimeframes(source, { now: () => now, market: () => ({ key: 'utc', calendar, sources: [{ interval: '1m', bounds: t => {
      const from = Math.floor(t / 60) * 60;
      return { time: from, from, to: from + 60 };
    } }] }) });
    cleanup.push(() => feed.destroy());
    const controller = new DataLoadingController(feed, { now: () => now });
    cleanup.push(() => controller.destroy());
    await controller.load({ symbol: 'X', exchange: 'TEST', interval: '5m', from: start, to: now });
    await flush();
    const before = { requests, subscriptions };
    for (let i = 0; i < 10; i++) { emit(bar(start + 2 * 60, 10)); await flush(); }
    expect({ requests, subscriptions }).toEqual(before);
    expect(controller.getState().status).toBe('ready');
    emit(bar(start + 20 * 60, 12));
    expect(controller.bars().slice(-1)[0]).toMatchObject({ time: start + 20 * 60, close: 12 });
  });
});

describe('a warm load whose tail request comes back empty', () => {
  it('keeps the cached bars and reports the history stale', async () => {
    const T = 1_700_000_040;
    const now = T + 5 * 60 + 30;
    const full = [0, 1, 2, 3, 4, 5].map(i => bar(T + i * 60, 100 + i));
    let calls = 0;
    const feed = withBarCache({ getBars: async () => ++calls === 1 ? full : [] }, { now: () => now * 1000 });
    const request = { symbol: 'X', exchange: 'NSE', interval: '1m', from: T, to: now };
    const first = new DataLoadingController(feed, { now: () => now });
    await first.load(request);
    first.destroy();
    const second = new DataLoadingController(feed, { now: () => now });
    cleanup.push(() => second.destroy());
    await second.load(request);
    expect(second.getState()).toMatchObject({ status: 'stale', error: expect.any(Error) });
    expect(second.bars().map(value => value.time - T)).toEqual([0, 60, 120, 180, 240]);
  });
});
