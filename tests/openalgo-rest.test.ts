import { describe, it, expect } from 'vitest';
import { mapHistoryResponse, rowTimeToUtcSeconds, OpenAlgoDataFeed } from '../src/feed/openalgo-rest';
import { istStringToUtcSeconds } from '../src/feed/time';

describe('rowTimeToUtcSeconds', () => {
  it('treats large numbers as epoch ms, small as seconds', () => {
    expect(rowTimeToUtcSeconds(1_700_000_000)).toBe(1_700_000_000);
    expect(rowTimeToUtcSeconds(1_700_000_000_000)).toBe(1_700_000_000);
  });
  it('parses IST date/time strings', () => {
    expect(rowTimeToUtcSeconds('2024-01-15 09:15:00')).toBe(istStringToUtcSeconds('2024-01-15 09:15:00'));
  });
  it('parses numeric strings', () => {
    expect(rowTimeToUtcSeconds('1700000000')).toBe(1_700_000_000);
  });
});

describe('mapHistoryResponse', () => {
  it('maps and sorts rows, tolerating timestamp vs time keys', () => {
    const bars = mapHistoryResponse({
      status: 'success',
      data: [
        { timestamp: 1_700_000_120, open: 2, high: 3, low: 1, close: 2.5, volume: 10 },
        { time: 1_700_000_060, open: 1, high: 2, low: 0.5, close: 1.5 },
      ],
    });
    expect(bars.map((b) => b.time)).toEqual([1_700_000_060, 1_700_000_120]); // sorted
    expect(bars[0]).toMatchObject({ open: 1, close: 1.5 });
    expect(bars[1].volume).toBe(10);
  });

  it('skips rows without a timestamp and handles empty data', () => {
    expect(mapHistoryResponse({})).toEqual([]);
    const bars = mapHistoryResponse({ data: [{ open: 1, high: 1, low: 1, close: 1 } as never] });
    expect(bars).toEqual([]);
  });
});

describe('OpenAlgoDataFeed.getBars (offline, injected fetch)', () => {
  it('posts to /api/v1/history and maps the response', async () => {
    let calledUrl = '';
    let calledBody: unknown;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ timestamp: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 5 }],
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const feed = new OpenAlgoDataFeed({ baseUrl: 'http://localhost:5000', apiKey: 'k', fetchImpl: fakeFetch });
    const bars = await feed.getBars({ symbol: 'RELIANCE', exchange: 'NSE', interval: '1m' });

    expect(calledUrl).toBe('http://localhost:5000/api/v1/history');
    expect(calledBody).toMatchObject({ apikey: 'k', symbol: 'RELIANCE', exchange: 'NSE', interval: '1m' });
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ time: 1_700_000_000, close: 1.5, volume: 5 });
  });

  it('throws on a non-ok response', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 500 } as Response)) as unknown as typeof fetch;
    const feed = new OpenAlgoDataFeed({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch });
    await expect(feed.getBars({ symbol: 'X', exchange: 'NSE', interval: '1m' })).rejects.toThrow();
  });
});
