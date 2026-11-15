import { describe, expect, it, vi } from 'vitest';
import type { Bar } from '../src/model/bar';
import type { BarsRequest, DataFeed, LiveBarMeta } from '../src/feed/types';
import { SessionCalendar } from '../src/feed/instrument';
import { CandleBuilder } from '../src/feed/candle-builder';
import { aggregateTimeframeBars } from '../src/feed/timeframe-bars';
import { withTimeframes } from '../src/feed/timeframe-feed';
import { planTimeframe, type TimeframeMarket } from '../src/feed/timeframe-plan';

const start = Date.parse('2026-01-28T09:00:00Z') / 1000;
const calendar = new SessionCalendar({ timezone: 'UTC', sessions: ['0900-1000:23456'] });
const market: TimeframeMarket = { key: 'source:v1', calendar, sources: [{ interval: '1m', bounds(t) {
  const from = Math.floor(t / 60) * 60;
  return { time: from, from, to: from + 60 };
} }] };
const req: BarsRequest = { symbol: 'X', exchange: 'TEST', interval: '7m', from: start, to: start + 420 };
const bars = (n = 7): Bar[] => Array.from({ length: n }, (_, i) => ({ time: start + i * 60, open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i, volume: 2, oi: 100 + i }));
const plan = () => planTimeframe(req, market);
const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('timeframe aggregation', () => {
  it('aggregates OHLCV and last OI', () => {
    expect(aggregateTimeframeBars(bars(), plan())).toEqual([{ time: start, open: 10, high: 18, low: 9, close: 17, volume: 14, oi: 106 }]);
  });
  it('sorts and replaces duplicate source timestamps instead of adding volume twice', () => {
    const input = bars().reverse();
    input.push({ ...bars()[3]!, high: 50, volume: 9 });
    expect(aggregateTimeframeBars(input, plan())[0]).toMatchObject({ open: 10, close: 17, high: 50, volume: 21 });
  });
  it('does not invent volume or OI missing from contributions', () => {
    const input = bars();
    delete input[2]!.volume;
    delete input[6]!.oi;
    const result = aggregateTimeframeBars(input, plan())[0]!;
    expect(result.volume).toBeUndefined();
    expect(result.oi).toBeUndefined();
  });
  it('rejects source bars crossing incompatible boundaries', () => {
    const bad = { ...plan(), source: { interval: '1m', bounds: (t: number) => ({ time: t, from: t, to: t + 120 }) } };
    expect(() => aggregateTimeframeBars(bars(), bad)).toThrow(/boundar/i);
  });
  it('does not fill missing observations and clips the last session bucket', () => {
    const input = bars(60).filter((_, i) => i < 7 || i >= 56);
    const result = aggregateTimeframeBars(input, plan());
    expect(result.map(bar => bar.time)).toEqual([start, start + 56 * 60]);
    expect(result[1]!.volume).toBe(8);
  });
});

describe('timeframe feed', () => {
  it('expands a mid-bucket request and preserves native aliases and variants', async () => {
    const getBars = vi.fn(async (_request: BarsRequest) => bars());
    const feed = withTimeframes({ getBars }, { market: () => market });
    expect((await feed.getBars({ ...req, from: start + 120, to: start + 300, variant: { adjustment: 'raw' } }))[0]!.open).toBe(10);
    expect(getBars.mock.calls[0]![0]).toMatchObject({ interval: '1m', from: start, to: start + 420, variant: { adjustment: 'raw' } });
    feed.destroy();
  });
  it('reads every declared date span without treating a short window as exhaustion', async () => {
    const getBars = vi.fn(async (r: BarsRequest) => bars().filter(bar => bar.time >= r.from! && bar.time < r.to! && bar.time !== start + 120));
    const feed = withTimeframes({ getBars }, { market: () => ({ ...market, sources: [{ ...market.sources[0]!, maxSpanSeconds: 120 }] }) });
    expect((await feed.getBars(req))[0]!.volume).toBe(12);
    expect(getBars).toHaveBeenCalledTimes(4);
    feed.destroy();
  });
  it('paginates duplicate edges with explicit cursors and rejects failed pages', async () => {
    const input = bars();
    const page = vi.fn(async (r: { before: number }) => {
      if (r.before > start + 180) return { bars: input.slice(3), nextBefore: start + 180, hasMore: true };
      return { bars: input.slice(0, 4), hasMore: false };
    });
    const feed = withTimeframes({ getBars: async () => [], getBarsPage: page }, { market: () => market });
    expect((await feed.getBars(req))[0]!.volume).toBe(14);
    expect(page).toHaveBeenCalledTimes(2);
    page.mockRejectedValueOnce(new Error('offline'));
    await expect(feed.getBars(req)).rejects.toThrow('offline');
    feed.destroy();
  });
  it('keeps cancellation independent and destroys only owned pending work', async () => {
    let finish!: (value: Bar[]) => void;
    const getBars = vi.fn(() => new Promise<Bar[]>(resolve => { finish = resolve; }));
    const feed = withTimeframes({ getBars }, { market: () => market });
    const controller = new AbortController();
    const one = feed.getBars({ ...req, signal: controller.signal });
    const two = feed.getBars(req);
    controller.abort();
    await expect(one).rejects.toMatchObject({ name: 'AbortError' });
    finish(bars());
    expect((await two)[0]!.volume).toBe(14);
    expect(getBars).toHaveBeenCalledTimes(1);
    const pending = feed.getBars(req);
    feed.destroy();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(feed.getBars(req)).rejects.toThrow(/destroyed/i);
  });
  it('returns progressing derived pages without inventing exhaustion', async () => {
    const feed = withTimeframes({ getBars: async r => bars().filter(bar => bar.time >= r.from! && bar.time < r.to!) }, { market: () => market });
    const result = await feed.getBarsPage!({ ...req, before: start + 420, countBack: 1 });
    expect(result.bars).toHaveLength(1);
    expect(result.nextBefore).toBeLessThan(start + 420);
    expect(result.hasMore).not.toBe(false);
    feed.destroy();
  });
  it('replaces live contributions, drops older ones, and resyncs only when the source asks', async () => {
    let emit!: (bar: Bar) => void;
    let reconnect!: () => void;
    const off = vi.fn();
    const raw: DataFeed = { getBars: async () => bars(), subscribeBars(_r, onBar, opts) { emit = onBar; reconnect = opts!.onResync!; return off; } };
    const feed = withTimeframes(raw, { market: () => market, now: () => start + 400 });
    const received: Bar[] = [], metadata: (LiveBarMeta | undefined)[] = [], resync = vi.fn();
    const unsubscribe = feed.subscribeBars!(req, (bar, meta) => { received.push(bar); metadata.push(meta); }, { onResync: resync });
    await flush();
    emit({ ...bars()[6]!, volume: 5, close: 20 });
    expect(received[received.length - 1]).toMatchObject({ volume: 17, open: 10, close: 20 });
    expect(metadata[metadata.length - 1]?.provisional).not.toBe(true);
    emit(bars(8)[7]!);
    const delivered = received.length;
    // A bar from the bucket before the active one is dropped, as the native
    // stream drops a bar older than its tail, rather than refetching history.
    emit(bars()[0]!);
    expect(received).toHaveLength(delivered);
    expect(resync).not.toHaveBeenCalled();
    reconnect();
    expect(resync).toHaveBeenCalledTimes(1);
    unsubscribe();
    feed.destroy();
    expect(off).toHaveBeenCalledTimes(1);
  });
  it('does not advertise an unavailable live capability', () => {
    const feed = withTimeframes({ getBars: async () => [] }, { market: () => market });
    expect(feed.subscribeBars).toBeUndefined();
    feed.destroy();
  });
  it('allows session bucket callbacks without changing cumulative volume resets', () => {
    const builder = new CandleBuilder({ intervalSec: 420, volumeMode: 'day-delta', bucketStart: t => start + Math.floor((t - start) / 420) * 420 });
    builder.onTick({ time: start + 1, price: 10, cumDayVolume: 100 });
    expect(builder.onTick({ time: start + 60, price: 11, cumDayVolume: 105 })!.bar).toMatchObject({ time: start, volume: 5 });
    expect(builder.onTick({ time: start + 420, price: 12, cumDayVolume: 2 })!.bar.volume).toBe(2);
  });
  it('accumulates daily resets inside a custom calendar candle', () => {
    const builder = new CandleBuilder({ volumeMode: 'day-delta', bucketStart: () => start });
    builder.onTick({ time: start, price: 10, cumDayVolume: 100 });
    builder.onTick({ time: start + 60, price: 11, cumDayVolume: 105 });
    expect(builder.onTick({ time: start + 86400, price: 12, cumDayVolume: 2 })!.bar.volume).toBe(7);
    expect(builder.onTick({ time: start + 86460, price: 13, cumDayVolume: 8 })!.bar.volume).toBe(13);
  });
  it('keeps a provisional source contribution provisional after historical bootstrap', async () => {
    let emit!: (bar: Bar, meta?: LiveBarMeta) => void;
    const raw: DataFeed = { getBars: async () => bars(), subscribeBars(_r, onBar) { emit = onBar; return () => {}; } };
    const feed = withTimeframes(raw, { market: () => market, now: () => start + 400 });
    const callback = vi.fn();
    feed.subscribeBars!(req, callback);
    await flush();
    emit(bars(8)[7]!, { provisional: true });
    expect(callback.mock.calls[callback.mock.calls.length - 1]![1]).toEqual({ provisional: true });
    feed.destroy();
  });
});
