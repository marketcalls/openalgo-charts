import { afterEach, expect, it, vi } from 'vitest';
import { SampleMarketDataFeed } from '../examples/sample-feed';
import { rowTimeToUtcSeconds } from '../src/feed/openalgo-rest';

afterEach(() => vi.unstubAllGlobals());
const rows = Array.from({ length: 6 }, (_, index) => ({ timestamp: `2026-09-29 09:${15 + index}:00`,
  open: 100 + index, high: 110 + index, low: 90 + index, close: 105 + index, volume: index + 1 }));
const from = rowTimeToUtcSeconds(rows[0]!.timestamp);
const request = { symbol: 'NIFTY', exchange: 'NSE', interval: '5m', from, to: from + 3600 };

it('maps response timestamps and aggregates OHLCV into the requested interval', async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'success', data: rows }) }));
  vi.stubGlobal('fetch', fetch);
  const feed = new SampleMarketDataFeed();
  const bars = await feed.getBars(request);
  expect(bars).toEqual([
    { time: from, open: 100, high: 114, low: 90, close: 109, volume: 15 },
    { time: from + 300, open: 105, high: 115, low: 95, close: 110, volume: 6 },
  ]);
  const minutes = await feed.getBars({ ...request, interval: '1m', from: from + 60, to: from + 180, countBack: 2 });
  expect(minutes.map(bar => bar.time)).toEqual([from + 120, from + 180]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects unsupported instruments and intervals without serving another instrument', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const feed = new SampleMarketDataFeed();
  await expect(feed.getBars({ ...request, symbol: 'UNKNOWN' })).rejects.toThrow('no sample data');
  await expect(feed.getBars({ ...request, interval: 'nonsense' })).rejects.toThrow('unknown interval');
  expect(fetch).not.toHaveBeenCalled();
});

it('honors cancellation before fetching and after the response arrives', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const feed = new SampleMarketDataFeed();
  await expect(feed.getBars({ ...request, signal: controller.signal })).rejects.toBeDefined();
  expect(fetch).not.toHaveBeenCalled();
  const pending = new AbortController();
  fetch.mockImplementation(async () => ({ ok: true, json: async () => {
    pending.abort();
    return { status: 'success', data: rows };
  } }));
  await expect(feed.getBars({ ...request, signal: pending.signal })).rejects.toBeDefined();
});
