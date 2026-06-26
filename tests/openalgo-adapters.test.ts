import { describe, it, expect } from 'vitest';
import { parseMessage, formatSubscribe, OpenAlgoWsFeed, type SocketLike } from '../src/feed/openalgo-ws';
import { OpenAlgoTradeFeed, mapOrder } from '../src/feed/openalgo-trade';
import { PriceScale } from '../src/scale/price-scale';

describe('OpenAlgo WS — pure helpers', () => {
  it('formats a subscribe message', () => {
    const msg = JSON.parse(formatSubscribe('k', 'LTP', 'SBIN', 'NSE'));
    expect(msg).toMatchObject({ action: 'subscribe', apikey: 'k', mode: 'LTP', symbol: 'SBIN', exchange: 'NSE' });
  });
  it('parses an LTP message', () => {
    const r = parseMessage({ symbol: 'SBIN', exchange: 'NSE', ltp: 772.5, ltq: 10, timestamp: 1_700_000_000 });
    expect(r).toEqual({ kind: 'ltp', event: { symbol: 'SBIN', exchange: 'NSE', ltp: 772.5, ltq: 10, timeSec: 1_700_000_000 } });
  });
  it('parses a depth message into MarketDepth', () => {
    const r = parseMessage({ symbol: 'SBIN', exchange: 'NSE', depth: { buy: [{ price: 100, quantity: 50 }], sell: [{ price: 100.05, quantity: 40 }] } });
    expect(r?.kind).toBe('depth');
    if (r?.kind === 'depth') {
      expect(r.depth.bids[0]).toEqual({ price: 100, qty: 50 });
      expect(r.depth.asks[0]).toEqual({ price: 100.05, qty: 40 });
    }
  });
  it('returns null for an unrecognised message', () => {
    expect(parseMessage({ foo: 1 })).toBeNull();
    expect(parseMessage('nope')).toBeNull();
  });
});

describe('OpenAlgo WS — feed with injected socket', () => {
  function fakeSocket(): { sock: SocketLike; sent: string[]; emit: (data: string) => void } {
    const sent: string[] = [];
    const sock: SocketLike = { send: (d) => sent.push(d), close: () => {}, onopen: null, onclose: null, onmessage: null };
    return { sock, sent, emit: (data) => sock.onmessage?.({ data }) };
  }

  it('dispatches LTP and depth events to subscribers', () => {
    const f = fakeSocket();
    const feed = new OpenAlgoWsFeed({ url: 'ws://x', apiKey: 'k', socketFactory: () => f.sock });
    feed.connect();
    let ltp = 0;
    let depthRows = 0;
    feed.onLtp((e) => { ltp = e.ltp; });
    feed.onDepth((_s, _e, d) => { depthRows = d.bids.length; });
    feed.subscribe('LTP', 'SBIN', 'NSE');
    expect(f.sent).toHaveLength(1);
    f.emit(JSON.stringify({ symbol: 'SBIN', exchange: 'NSE', ltp: 101.2 }));
    f.emit(JSON.stringify({ symbol: 'SBIN', exchange: 'NSE', depth: { buy: [{ price: 100, quantity: 5 }, { price: 99.95, quantity: 7 }], sell: [] } }));
    expect(ltp).toBe(101.2);
    expect(depthRows).toBe(2);
  });
});

describe('OpenAlgoTradeFeed (offline, injected fetch)', () => {
  function feedFor(capture: { url?: string; body?: Record<string, unknown> }, json: unknown) {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capture.url = url;
      capture.body = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => json } as Response;
    }) as unknown as typeof fetch;
    return new OpenAlgoTradeFeed({ baseUrl: 'http://x', apiKey: 'k', fetchImpl });
  }

  it('place posts to /placeorder and returns the order id', async () => {
    const cap: { url?: string; body?: Record<string, unknown> } = {};
    const feed = feedFor(cap, { orderid: 'OA123' });
    const r = await feed.place({ symbol: 'SBIN', exchange: 'NSE', side: 'BUY', type: 'LIMIT', qty: 10, price: 100, mode: 'live' });
    expect(cap.url).toBe('http://x/api/v1/placeorder');
    expect(cap.body).toMatchObject({ apikey: 'k', symbol: 'SBIN', action: 'BUY', pricetype: 'LIMIT', quantity: 10 });
    expect(r.orderId).toBe('OA123');
  });

  it('modify and cancel hit their endpoints', async () => {
    const cap: { url?: string; body?: Record<string, unknown> } = {};
    const feed = feedFor(cap, {});
    await feed.modify('OA123', { price: 101 });
    expect(cap.url).toBe('http://x/api/v1/modifyorder');
    expect(cap.body).toMatchObject({ orderid: 'OA123', price: 101 });
    await feed.cancel('OA123');
    expect(cap.url).toBe('http://x/api/v1/cancelorder');
    expect(cap.body).toMatchObject({ orderid: 'OA123' });
  });

  it('maps an orderbook row to a broker-agnostic Order', () => {
    const o = mapOrder({ orderid: 'X', symbol: 'SBIN', action: 'SELL', pricetype: 'SL', quantity: 5, filled_quantity: 2, price: 99, order_status: 'open' });
    expect(o).toMatchObject({ id: 'X', side: 'SELL', type: 'SL', qty: 5, filledQty: 2, status: 'working' });
  });
});

describe('PriceScale modes (H9)', () => {
  it('logarithmic mapping places the geometric midpoint at the pane centre', () => {
    const ps = new PriceScale({ mode: 'logarithmic' });
    ps.setHeight(100);
    ps.setPriceRange({ min: 10, max: 1000 }); // log10: 1..3, mid 2 → price 100
    expect(ps.priceToY(100)).toBeCloseTo(50);
    expect(ps.priceToY(1000)).toBeCloseTo(0);
    expect(ps.priceToY(10)).toBeCloseTo(100);
    expect(ps.yToPrice(50)).toBeCloseTo(100);
  });

  it('inverted flips the axis', () => {
    const lin = new PriceScale(); lin.setHeight(100); lin.setPriceRange({ min: 0, max: 100 });
    const inv = new PriceScale({ inverted: true }); inv.setHeight(100); inv.setPriceRange({ min: 0, max: 100 });
    expect(lin.priceToY(100)).toBeCloseTo(0);
    expect(inv.priceToY(100)).toBeCloseTo(100); // high price at the bottom
    expect(inv.yToPrice(0)).toBeCloseTo(0);
  });
});
