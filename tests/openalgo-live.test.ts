import { describe, it, expect } from 'vitest';
import { OpenAlgoLiveDataFeed, intervalToSeconds } from '../src/feed/openalgo-live';
import type { Bar } from '../src/model/bar';

describe('intervalToSeconds', () => {
  it('maps bare and prefixed daily/weekly tokens', () => {
    expect(intervalToSeconds('D')).toBe(86400);
    expect(intervalToSeconds('W')).toBe(604800);
    expect(intervalToSeconds('1D')).toBe(86400);
    expect(intervalToSeconds('1W')).toBe(604800);
  });
  it('maps intraday tokens', () => {
    expect(intervalToSeconds('1s')).toBe(1);
    expect(intervalToSeconds('1m')).toBe(60);
    expect(intervalToSeconds('5m')).toBe(300);
    expect(intervalToSeconds('1h')).toBe(3600);
    expect(intervalToSeconds('4h')).toBe(14400);
  });
  it('falls back to 60 for unknown tokens', () => {
    expect(intervalToSeconds('bogus')).toBe(60);
    expect(intervalToSeconds('')).toBe(60);
  });
});

// A driveable in-memory socket for the WS feed.
function fakeSocket(): any {
  const s: any = {
    sent: [] as string[], readyState: 1,
    onopen: null, onclose: null, onerror: null, onmessage: null,
    send(d: string) { s.sent.push(d); },
    close() {},
  };
  return s;
}
function ltpFrame(fields: Record<string, unknown>): { data: string } {
  return { data: JSON.stringify({ data: fields }) };
}

function makeFeed(volumeMode: 'ltq-sum' | 'day-delta'): { feed: OpenAlgoLiveDataFeed; sock: () => any } {
  let sock: any;
  const feed = new OpenAlgoLiveDataFeed({
    apiKey: 'k', baseUrl: '', wsUrl: 'ws://test', volumeMode,
    socketFactory: () => (sock = fakeSocket()),
  });
  return { feed, sock: () => sock };
}

describe('OpenAlgoLiveDataFeed.subscribeBars', () => {
  it('filters ticks by both symbol and exchange', () => {
    const { feed, sock } = makeFeed('ltq-sum');
    const bars: Bar[] = [];
    feed.subscribeBars({ symbol: 'X', exchange: 'NSE', interval: '1h', from: 0 }, (b) => bars.push(b));
    const s = sock();
    s.onmessage(ltpFrame({ symbol: 'X', exchange: 'BSE', ltp: 100, ltq: 1, timestamp: 1700000000 })); // wrong exchange
    s.onmessage(ltpFrame({ symbol: 'Y', exchange: 'NSE', ltp: 100, ltq: 1, timestamp: 1700000000 })); // wrong symbol
    expect(bars).toHaveLength(0);
    s.onmessage(ltpFrame({ symbol: 'X', exchange: 'NSE', ltp: 101, ltq: 2, timestamp: 1700000000 })); // match
    expect(bars.length).toBeGreaterThan(0);
    expect(bars[bars.length - 1].close).toBe(101);
  });

  it('diffs cumulative day volume in day-delta mode', () => {
    const { feed, sock } = makeFeed('day-delta');
    const bars: Bar[] = [];
    feed.subscribeBars({ symbol: 'X', exchange: 'NSE', interval: '1h', from: 0 }, (b) => bars.push(b));
    const s = sock();
    const t = 1700000000; // same hour bucket for both ticks
    s.onmessage(ltpFrame({ symbol: 'X', exchange: 'NSE', ltp: 100, volume: 1000, timestamp: t }));
    s.onmessage(ltpFrame({ symbol: 'X', exchange: 'NSE', ltp: 102, volume: 1500, timestamp: t + 60 }));
    const last = bars[bars.length - 1];
    expect(last.volume).toBe(500); // 1500 - 1000, not the raw cumulative
  });

  it('uses the current time when a tick omits its timestamp (never buckets at the epoch)', () => {
    const { feed, sock } = makeFeed('ltq-sum');
    const bars: Bar[] = [];
    feed.subscribeBars({ symbol: 'X', exchange: 'NSE', interval: '1m', from: 0 }, (b) => bars.push(b));
    sock().onmessage(ltpFrame({ symbol: 'X', exchange: 'NSE', ltp: 100, ltq: 1 })); // no timestamp
    expect(bars.length).toBeGreaterThan(0);
    expect(bars[bars.length - 1].time).toBeGreaterThan(1_600_000_000); // a recent epoch, not 0
  });
});
