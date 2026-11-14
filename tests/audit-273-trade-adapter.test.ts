/**
 * OpenAlgo trade adapter answers that are not what they look like (audit N10 to
 * N12). An HTTP 200 can still carry a refusal, or nothing readable at all: a
 * cancel that resolves on one tells the trader an order is gone when it may be
 * live, and a book read that returns [] for one tells the host every order is
 * gone and every position flat. A direct modify skipped the numeric checks
 * place runs, sent NaN as null, and cached the bad values for the next edit.
 */
import { describe, expect, it } from 'vitest';
import { OpenAlgoTradeFeed } from '../src/feed/openalgo-trade';

const row = { orderid: 'OA1', symbol: 'SBIN', exchange: 'NSE', product: 'MIS', action: 'BUY', pricetype: 'LIMIT',
  quantity: 10, price: 100, order_status: 'open' };

function harness(constraints?: ConstructorParameters<typeof OpenAlgoTradeFeed>[0]['constraints']) {
  const replies: Record<string, unknown> = {
    '/api/v1/orderbook': { status: 'success', data: [row] },
    '/api/v1/positionbook': { status: 'success', data: [{ symbol: 'SBIN', quantity: '10', average_price: '100' }] },
    '/api/v1/modifyorder': { status: 'success', orderid: 'OA1' },
    '/api/v1/cancelorder': { status: 'success', orderid: 'OA1' },
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace('http://x', '');
    writes.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return { ok: true, status: 200, json: async () => replies[path] } as Response;
  }) as unknown as typeof fetch;
  const feed = new OpenAlgoTradeFeed({ baseUrl: 'http://x', apiKey: 'k', fetchImpl, verifyMode: 'off',
    ...(constraints ? { constraints } : {}) });
  return { feed, replies, writes, sent: (path: string) => writes.filter((w) => w.path === path).map((w) => w.body) };
}

describe('cancel needs a readable acknowledgement (N10)', () => {
  it('rejects an HTTP-success body that says error, with the broker message', async () => {
    const h = harness();
    h.replies['/api/v1/cancelorder'] = { status: 'error', message: 'broker rejected cancellation' };
    const err = await h.feed.cancel('OA1').catch((e: unknown) => e);
    expect(String(err)).toMatch(/broker rejected cancellation/);
    // The request left, so the refusal is not pre-flight.
    expect(err).not.toHaveProperty('preflight');
  });

  it.each([{}, null, { status: 'pending' }, { orderid: 'OTHER' }])('rejects an acknowledgement it cannot read: %j', async (reply) => {
    const h = harness();
    h.replies['/api/v1/cancelorder'] = reply;
    const err = await h.feed.cancel('OA1').catch((e: unknown) => e);
    expect(String(err)).toMatch(/cancelorder returned no readable acknowledgement/);
    expect(err).not.toHaveProperty('preflight');
  });

  it('accepts a success status, or a bare echo of the same order id', async () => {
    const h = harness();
    await expect(h.feed.cancel('OA1')).resolves.toBeUndefined();
    h.replies['/api/v1/cancelorder'] = { orderid: 'OA1' };
    await expect(h.feed.cancel('OA1')).resolves.toBeUndefined();
  });
});

describe('a book read that cannot be read is not an empty book (N11)', () => {
  const unreadable = [
    { status: 'error', message: 'book temporarily unavailable' },
    {},
    { status: 'success' },
    { status: 'success', data: { statistics: {} } },
    { status: 'success', data: 'none' },
    { status: 'pending', data: [] },
    null,
  ];

  it.each(unreadable)('getOrders and getOrderBook throw on %j', async (reply) => {
    const h = harness();
    h.replies['/api/v1/orderbook'] = reply;
    await expect(h.feed.getOrders()).rejects.toThrow(/orderbook/);
    await expect(h.feed.getOrderBook()).rejects.toThrow(/orderbook/);
  });

  it.each(unreadable)('getPositions throws on %j', async (reply) => {
    const h = harness();
    h.replies['/api/v1/positionbook'] = reply;
    await expect(h.feed.getPositions()).rejects.toThrow(/positionbook/);
  });

  it('names the broker message of an error envelope', async () => {
    const h = harness();
    h.replies['/api/v1/orderbook'] = { status: 'error', message: 'book temporarily unavailable' };
    await expect(h.feed.getOrders()).rejects.toThrow(/book temporarily unavailable/);
  });

  it('keeps an explicit empty book empty', async () => {
    const h = harness();
    h.replies['/api/v1/orderbook'] = { status: 'success', data: { orders: [], statistics: {} } };
    h.replies['/api/v1/positionbook'] = { status: 'success', data: [] };
    expect(await h.feed.getOrderBook()).toEqual({ orders: [], quarantined: [] });
    expect(await h.feed.getPositions()).toEqual([]);
    h.replies['/api/v1/orderbook'] = { status: 'success', data: [] };
    expect(await h.feed.getOrders()).toEqual([]);
  });

  it('leaves the cached modify context alone when a read fails', async () => {
    const h = harness();
    await h.feed.getOrders();
    h.replies['/api/v1/orderbook'] = { status: 'error', message: 'down' };
    await expect(h.feed.getOrders()).rejects.toThrow();
    await h.feed.modify('OA1', { price: 101 });
    expect(h.sent('/api/v1/modifyorder')[0]).toMatchObject({ symbol: 'SBIN', quantity: 10, price: 101 });
  });
});

describe('a direct modify checks its numbers before anything is sent (N12)', () => {
  const invalid = [
    { qty: -1 }, { qty: 0 }, { qty: Number.NaN }, { qty: 2.5 },
    { price: Number.NaN }, { price: Number.POSITIVE_INFINITY },
    { triggerPrice: Number.NaN }, { triggerPrice: Number.NEGATIVE_INFINITY },
    { qty: -1, price: Number.NaN },
  ];

  it.each(invalid)('refuses %j pre-flight and sends nothing', async (patch) => {
    const h = harness();
    await h.feed.getOrders();
    await expect(h.feed.modify('OA1', patch)).rejects.toMatchObject({ preflight: true });
    expect(h.sent('/api/v1/modifyorder')).toEqual([]);
  });

  it('leaves the cached context intact, so the next edit carries the real values', async () => {
    const h = harness();
    await h.feed.getOrders();
    await expect(h.feed.modify('OA1', { qty: -1, price: Number.NaN })).rejects.toMatchObject({ preflight: true });
    // Not marked uncertain either: nothing left, so no new book read is needed.
    await h.feed.modify('OA1', { triggerPrice: 99 });
    expect(h.sent('/api/v1/modifyorder')).toEqual([expect.objectContaining({ quantity: 10, price: 100, trigger_price: 99 })]);
  });

  it('applies the configured lot grid and freeze limit, as place does', async () => {
    const h = harness(() => ({ tickSize: 0.05, lotSize: 5, freezeQty: 50 }));
    await h.feed.getOrders();
    await expect(h.feed.modify('OA1', { qty: 7 })).rejects.toMatchObject({ preflight: true });
    await expect(h.feed.modify('OA1', { qty: 55 })).rejects.toMatchObject({ preflight: true });
    await h.feed.modify('OA1', { qty: 15 });
    expect(h.sent('/api/v1/modifyorder')).toEqual([expect.objectContaining({ quantity: 15 })]);
  });
});
