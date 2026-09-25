import { afterEach, describe, expect, it } from 'vitest';
import type { Bar } from '../src/model/bar';
import type { BarsRequest, DataFeed, UnsubscribeFn } from '../src/feed/types';
import { barCacheKey, withBarCache } from '../src/feed/cache';
import { HistoryRequestPool } from '../src/feed/request-pool';
import { DataLoadingController } from '../src/feed/data-controller';
import { OpenAlgoDataFeed } from '../src/feed/openalgo-rest';
import { Instrument } from '../src/feed/instrument';
import { Chart } from '../src/core/chart';
import { fakeDocument } from './helpers/fake-dom';

// A session, an adjustment, a currency and a unit are separate series from the
// provider, never a view of one series. These tests hold each layer that keys,
// shares or labels history to that: nothing may serve one variant's bars as
// another's, and nothing may pretend a provider serves a variant it never declared.

const T0 = 1_700_000_000;
const bar = (time: number, close = 100): Bar => ({ time, open: 100, high: Math.max(101, close), low: 99, close, volume: 5 });
const series = (start: number, count: number, close: number): Bar[] =>
  Array.from({ length: count }, (_, i) => bar(start + i * 60, close + i));
const base: BarsRequest = { symbol: 'AAPL', exchange: 'US', interval: '1m', from: T0, to: T0 + 600 };
const extended = { session: 'extended' as const };
const settle = async (): Promise<void> => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const last = <T>(items: readonly T[]): T => items[items.length - 1];
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); });

function variantFeed(extra: Partial<DataFeed> = {}): DataFeed & { calls: BarsRequest[] } {
  const calls: BarsRequest[] = [];
  return {
    calls,
    // The extended series is a different series, with different prices, so a
    // cache or pool that mixes the two shows up in the closes, not just the count.
    getBars: async req => {
      calls.push({ ...req });
      return series(T0, 11, req.variant?.session === 'extended' ? 500 : 100);
    },
    ...extra,
  };
}

describe('data variants in the bar cache', () => {
  it('keeps each variant of one series in its own entry', async () => {
    const feed = variantFeed();
    const cache = withBarCache(feed, { now: () => (T0 + 86_400) * 1000 });
    const regular = await cache.getBars({ ...base });
    const ext = await cache.getBars({ ...base, variant: extended });
    expect(feed.calls).toHaveLength(2);
    expect(feed.calls[1].variant).toEqual(extended);
    expect(regular[0].close).toBe(100);
    expect(ext[0].close).toBe(500);
    // Both are warm now, each from its own entry.
    expect((await cache.getBars({ ...base }))[0].close).toBe(100);
    expect((await cache.getBars({ ...base, variant: extended }))[0].close).toBe(500);
    expect(feed.calls).toHaveLength(2);
    expect(cache.stats().entries).toBe(2);
    expect(await cache.getCachedBars({ ...base, variant: { adjustment: 'raw' } })).toBeUndefined();
  });

  it('keeps the default key byte-identical, so entries persisted before variants stay readable', () => {
    expect(barCacheKey({ symbol: 'A', exchange: 'X', interval: '1m' })).toBe('A|X|1m');
    expect(barCacheKey({ symbol: 'A', exchange: 'X', interval: '1m', variant: {} })).toBe('A|X|1m');
    const keys = new Set([
      barCacheKey({ symbol: 'A', exchange: 'X', interval: '1m' }),
      barCacheKey({ symbol: 'A', exchange: 'X', interval: '1m', variant: extended }),
      barCacheKey({ symbol: 'A', exchange: 'X', interval: '1m', variant: { session: 'regular' } }),
      barCacheKey({ symbol: 'A', exchange: 'X', interval: '1m', variant: { adjustment: 'raw' } }),
      barCacheKey({ symbol: 'A', exchange: 'X', interval: '1m', variant: { currency: 'USD' } }),
      barCacheKey({ symbol: 'A', exchange: 'X', interval: '1m', variant: { unit: 'USD' } }),
    ]);
    expect(keys.size).toBe(6);
  });

  it('invalidates one variant and leaves the other warm', async () => {
    const feed = variantFeed();
    const cache = withBarCache(feed, { now: () => (T0 + 86_400) * 1000 });
    await cache.getBars({ ...base });
    await cache.getBars({ ...base, variant: extended });
    await cache.invalidate({ symbol: 'AAPL', exchange: 'US', interval: '1m', variant: extended });
    await cache.getBars({ ...base });
    expect(feed.calls).toHaveLength(2);
    await cache.getBars({ ...base, variant: extended });
    expect(feed.calls).toHaveLength(3);
  });

  it('forwards the provider declaration, so a cached feed still says what it can serve', async () => {
    const declared = variantFeed({ dataVariants: () => ({ sessions: ['regular', 'extended'] }) });
    const cache = withBarCache(declared);
    expect(typeof cache.dataVariants).toBe('function');
    expect(await cache.dataVariants!({ symbol: 'AAPL', exchange: 'US', interval: '1m' })).toEqual({ sessions: ['regular', 'extended'] });
    expect(withBarCache(variantFeed()).dataVariants).toBeUndefined();
  });
});

describe('data variants in shared history requests', () => {
  it('never lets two variants share one request in flight', async () => {
    const seen: unknown[] = [];
    const pool = new HistoryRequestPool({ getBars: req => { seen.push(req.variant); return new Promise<Bar[]>(() => {}); } });
    void pool.getBars({ ...base });
    void pool.getBars({ ...base, variant: extended });
    void pool.getBars({ ...base, variant: { session: 'extended' } });
    await settle();
    expect(seen).toEqual([undefined, extended]);
  });
});

describe('data variants in the loading controller', () => {
  function make(feed: DataFeed) {
    const controller = new DataLoadingController(feed, { now: () => T0 + 600 });
    cleanups.push(() => controller.destroy());
    return controller;
  }

  it('reports a variant the provider never declared as unsupported and asks it for nothing', async () => {
    let subscribed = 0, cached = 0;
    const feed = variantFeed({
      getCachedBars: async () => { cached++; return undefined; },
      subscribeBars: () => { subscribed++; return () => {}; },
    });
    const controller = make(feed);
    await controller.load({ ...base, variant: extended });
    expect(controller.getState()).toMatchObject({ status: 'unsupported', unsupported: 'session', bars: [] });
    expect(controller.getState().request?.variant).toEqual(extended);
    expect(controller.getState().error?.message).toMatch(/session/);
    expect(feed.calls).toHaveLength(0);
    expect(cached).toBe(0);
    expect(subscribed).toBe(0);
    // Nothing that reaches for more history may fetch the undeclared variant either.
    await controller.refresh();
    await controller.loadMore();
    controller.pushBar(bar(T0 + 900));
    expect(feed.calls).toHaveLength(0);
    expect(controller.bars()).toEqual([]);
    expect(controller.getState().status).toBe('unsupported');
  });

  it('reports a declared list without the value as unsupported on that dimension', async () => {
    const feed = variantFeed({ dataVariants: () => ({ sessions: ['regular', 'extended'], adjustments: ['adjusted'] }) });
    const controller = make(feed);
    await controller.load({ ...base, variant: { session: 'extended', adjustment: 'raw' } });
    expect(controller.getState()).toMatchObject({ status: 'unsupported', unsupported: 'adjustment' });
    expect(feed.calls).toHaveLength(0);
  });

  it('loads and streams a declared variant, and never asks about the default one', async () => {
    const queries: unknown[] = [];
    const streams: BarsRequest[] = [];
    const feed = variantFeed({
      dataVariants: query => { queries.push({ ...query, signal: undefined }); return Promise.resolve({ sessions: ['regular', 'extended'] }); },
      subscribeBars: req => { streams.push(req); return () => {}; },
    });
    const controller = make(feed);
    await controller.load({ ...base });
    expect(queries).toHaveLength(0);
    await controller.load({ ...base, variant: extended });
    expect(queries).toEqual([{ symbol: 'AAPL', exchange: 'US', interval: '1m', signal: undefined }]);
    expect(controller.getState()).toMatchObject({ status: 'ready' });
    expect(controller.getState().unsupported).toBeUndefined();
    expect(controller.bars()[0].close).toBe(500);
    expect(last(feed.calls)!.variant).toEqual(extended);
    expect(last(streams)!.variant).toEqual(extended);
  });

  it('aborts the previous source and resets its bars when only the variant changes', async () => {
    let released = 0;
    const pending: { variant: unknown; signal?: AbortSignal; resolve: (bars: Bar[]) => void }[] = [];
    let first = true;
    const feed = variantFeed({
      dataVariants: () => ({ sessions: ['extended'] }),
      getBars: req => {
        if (first) { first = false; return Promise.resolve(series(T0, 11, 100)); }
        return new Promise<Bar[]>(resolve => { pending.push({ variant: req.variant, signal: req.signal, resolve }); });
      },
      subscribeBars: (): UnsubscribeFn => () => { released++; },
    });
    const controller = make(feed);
    await controller.load({ ...base });
    expect(controller.bars()).toHaveLength(11);
    // A repair of the regular series is in flight when the session switches.
    void controller.refresh();
    await settle();
    expect(pending.map(item => item.variant)).toEqual([undefined]);
    const switching = controller.load({ ...base, variant: extended });
    expect(pending[0].signal?.aborted).toBe(true);
    expect(released).toBe(1);
    expect(controller.bars()).toEqual([]);
    expect(controller.getState()).toMatchObject({ status: 'loading', bars: [] });
    await settle();
    expect(pending.map(item => item.variant)).toEqual([undefined, extended]);
    // The regular answer arriving late changes nothing.
    pending[0].resolve(series(T0, 11, 100));
    pending[1].resolve(series(T0, 3, 500));
    await switching;
    await settle();
    expect(controller.bars().map(value => value.close)).toEqual([500, 501, 502]);
    expect(controller.getState().request?.variant).toEqual(extended);
  });

  it('drops a declaration answer that lands after a newer load', async () => {
    let answer!: (value: { sessions: ('regular' | 'extended')[] }) => void;
    const feed = variantFeed({ dataVariants: () => new Promise(resolve => { answer = resolve; }) });
    const controller = make(feed);
    const first = controller.load({ ...base, variant: extended });
    await controller.load({ ...base, symbol: 'MSFT' });
    answer({ sessions: [] });
    await first;
    expect(controller.getState()).toMatchObject({ status: 'ready' });
    expect(controller.getState().request?.symbol).toBe('MSFT');
  });

  it('reports a malformed variant as an error and fetches nothing', async () => {
    const feed = variantFeed({ dataVariants: () => ({ sessions: ['regular', 'extended'] }) });
    const controller = make(feed);
    await controller.load({ ...base, variant: { session: 'overnight' } as never });
    expect(controller.getState().status).toBe('error');
    expect(controller.getState().error).toBeInstanceOf(TypeError);
    expect(feed.calls).toHaveLength(0);
  });

  it('keeps a default request free of a variant field, byte for byte', async () => {
    const feed = variantFeed();
    const controller = make(feed);
    await controller.load({ ...base, variant: {} });
    expect(controller.getState().request).not.toHaveProperty('variant');
    expect(feed.calls[0]).not.toHaveProperty('variant');
  });
});

describe('data variants at the OpenAlgo adapter', () => {
  it('refuses a variant its history API cannot serve instead of relabelling the default series', async () => {
    let fetched = 0;
    const feed = new OpenAlgoDataFeed({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: (async () => { fetched++; throw new Error('no'); }) as unknown as typeof fetch });
    await expect(feed.getBars({ ...base, variant: extended })).rejects.toMatchObject({ name: 'DataVariantUnsupportedError' });
    expect(fetched).toBe(0);
  });
});

describe('data variants survive instrument metadata', () => {
  it('keeps the host variant when metadata is applied', () => {
    const document = fakeDocument();
    const chart = new Chart(document.createElement('div'), { document, raf: { schedule: () => 0 }, shortcuts: false });
    cleanups.push(() => chart.destroy());
    chart.applySize(800, 600);
    chart.addSeries('candlestick');
    chart.setDataContext({ symbol: 'AAPL', exchange: 'US', interval: '1m', variant: extended });
    new Instrument({ symbol: 'AAPL', exchange: 'US', timezone: 'America/New_York', priceTick: 0.01, pricePrecision: 2,
      quantityStep: 1, intervals: ['1m'], calendar: { sessions: ['0930-1600:23456'] }, hasOpenInterest: false }).applyTo(chart, '1m');
    // The capability changed, so the chart really took a new context from the metadata.
    expect(chart.getDataContext()).toEqual({ symbol: 'AAPL', exchange: 'US', interval: '1m', hasOpenInterest: false, variant: extended });
  });
});
