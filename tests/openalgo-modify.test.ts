import { describe, expect, it, vi } from 'vitest';
import { OpenAlgoTradeFeed, type OpenAlgoTradeConfig, type RawOrder } from '../src/feed/openalgo-trade';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function response(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status });
}

const accepted = () => response({ status: 'success', orderid: 'OA1' });
const row = (patch: Partial<RawOrder> = {}): RawOrder => ({
  orderid: 'OA1', symbol: 'SBIN', exchange: 'NSE', action: 'BUY', pricetype: 'SL',
  product: 'MIS', quantity: 5, price: 100, trigger_price: 95, order_status: 'open', ...patch,
});
const book = (rows: RawOrder[]) => response({ status: 'success', data: rows });

function harness(config: Pick<OpenAlgoTradeConfig, 'capabilities'> = {}) {
  const writes: Record<string, unknown>[] = [];
  const cancels: Record<string, unknown>[] = [];
  const replies: Array<Response | Promise<Response> | Error> = [];
  const reads: Array<Response | Promise<Response>> = [];
  const feed = new OpenAlgoTradeFeed({
    baseUrl: 'https://broker.invalid', apiKey: 'synthetic-placeholder', verifyMode: 'off',
    ...config,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/orderbook')) return reads.shift() ?? book([row()]);
      if (String(url).endsWith('/placeorder')) return accepted();
      if (String(url).endsWith('/cancelorder')) {
        cancels.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return accepted();
      }
      writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const reply = replies.shift() ?? accepted();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  const place = () => feed.place({ symbol: 'SBIN', exchange: 'NSE', side: 'BUY', type: 'SL',
    product: 'MIS', qty: 5, price: 100, triggerPrice: 95, mode: 'live' });
  return { feed, writes, cancels, replies, reads, place };
}

describe('acknowledged OpenAlgo modify context', () => {
  const cases = [
    { field: 'price', rejected: { price: 110 }, next: { triggerPrice: 96 },
      expected: { price: 100, trigger_price: 96, quantity: 5 } },
    { field: 'quantity', rejected: { qty: 9 }, next: { triggerPrice: 96 },
      expected: { price: 100, trigger_price: 96, quantity: 5 } },
    { field: 'trigger', rejected: { triggerPrice: 90 }, next: { price: 101 },
      expected: { price: 101, trigger_price: 95, quantity: 5 } },
  ];

  for (const status of [200, 400]) {
    it.each(cases)(`refreshes accepted values after a rejected $field change (HTTP ${status})`, async test => {
      const h = harness();
      await h.place();
      h.replies.push(response({ status: 'error', message: 'Synthetic rejection' }, status));
      await expect(h.feed.modify('OA1', test.rejected)).rejects.toThrow('Synthetic rejection');
      await expect(h.feed.modify('OA1', test.next)).rejects.toMatchObject({ preflight: true });
      expect(h.writes).toHaveLength(1);
      await h.feed.getOrders();
      await h.feed.modify('OA1', test.next);
      expect(h.writes[1]).toMatchObject(test.expected);
    });
  }

  it('retains each acknowledged partial change for later payloads', async () => {
    const h = harness();
    await h.place();
    await h.feed.modify('OA1', { price: 110 });
    await h.feed.modify('OA1', { qty: 7 });
    await h.feed.modify('OA1', { triggerPrice: 96 });
    expect(h.writes[2]).toMatchObject({ price: 110, quantity: 7, trigger_price: 96 });
  });

  it.each([true, false])('builds a queued patch after the previous acknowledgement (accepted: %s)', async success => {
    const h = harness(), first = deferred<Response>();
    await h.place();
    h.replies.push(first.promise);
    const pending = h.feed.modify('OA1', { price: 110 }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(h.writes).toHaveLength(1));
    const patch = { triggerPrice: 96 };
    const next = h.feed.modify('OA1', patch).catch((error: unknown) => error);
    patch.triggerPrice = 999;
    await Promise.resolve();
    expect(h.writes).toHaveLength(1);
    first.resolve(success ? accepted() : response({ status: 'error', message: 'Synthetic rejection' }, 400));
    await pending;
    if (success) await next;
    else {
      expect(await next).toMatchObject({ preflight: true });
      expect(h.writes).toHaveLength(1);
      await h.feed.getOrders();
      await h.feed.modify('OA1', { triggerPrice: 96 });
    }
    expect(h.writes[1]).toMatchObject({ price: success ? 110 : 100, quantity: 5, trigger_price: 96 });
    await h.feed.modify('OA1', { qty: 7 });
    expect(h.writes[2]).toMatchObject({ price: success ? 110 : 100, quantity: 7, trigger_price: 96 });
  });

  it('does not delay a different order behind a pending modification', async () => {
    const h = harness(), first = deferred<Response>();
    h.reads.push(book([row(), row({ orderid: 'OA2' })]));
    await h.feed.getOrders();
    h.replies.push(first.promise);
    const pending = h.feed.modify('OA1', { price: 110 });
    await vi.waitFor(() => expect(h.writes).toHaveLength(1));
    await h.feed.modify('OA2', { qty: 7 });
    expect(h.writes[1]).toMatchObject({ orderid: 'OA2', price: 100, quantity: 7 });
    first.resolve(accepted());
    await pending;
  });
});

describe('OpenAlgo modify and order book races', () => {
  it('does not let a read started before a successful write roll it back', async () => {
    const h = harness(), oldBook = deferred<Response>();
    await h.place();
    h.reads.push(oldBook.promise);
    const reading = h.feed.getOrders();
    await h.feed.modify('OA1', { price: 110 });
    oldBook.resolve(book([row()]));
    await reading;
    await h.feed.modify('OA1', { triggerPrice: 96 });
    expect(h.writes[1]).toMatchObject({ price: 110, trigger_price: 96 });
  });

  it('retains an acknowledged delta when a book read finishes during the write', async () => {
    const h = harness(), write = deferred<Response>();
    await h.place();
    h.replies.push(write.promise);
    const pending = h.feed.modify('OA1', { price: 110 });
    await vi.waitFor(() => expect(h.writes).toHaveLength(1));
    await h.feed.getOrders();
    write.resolve(accepted());
    await pending;
    await h.feed.modify('OA1', { triggerPrice: 96 });
    expect(h.writes[1]).toMatchObject({ price: 110, trigger_price: 96 });
  });

  it('uses a fresh book after acknowledgement as the broker authority', async () => {
    const h = harness();
    await h.place();
    await h.feed.modify('OA1', { price: 110 });
    h.reads.push(book([row({ price: 112, quantity: 9 })]));
    await h.feed.getOrders();
    await h.feed.modify('OA1', { triggerPrice: 96 });
    expect(h.writes[1]).toMatchObject({ price: 112, quantity: 9, trigger_price: 96 });
  });

  it('does not replace a newer book with a slower older response', async () => {
    const h = harness(), oldBook = deferred<Response>();
    await h.place();
    h.reads.push(oldBook.promise, book([row({ price: 112, quantity: 9 })]));
    const reading = h.feed.getOrders();
    await h.feed.getOrders();
    oldBook.resolve(book([row()]));
    await reading;
    await h.feed.modify('OA1', { triggerPrice: 96 });
    expect(h.writes[0]).toMatchObject({ price: 112, quantity: 9, trigger_price: 96 });
  });

  const ambiguous = [
    { name: 'lost transport response', reply: new Error('Synthetic response lost') },
    { name: 'HTTP 400 Invalid JSON response after broker acceptance',
      reply: response({ status: 'error', message: 'Invalid JSON response' }, 400) },
    { name: 'server error after broker dispatch', reply: response({ status: 'error', message: 'Internal error' }, 500) },
    { name: 'unreadable JSON response', reply: new Response('{', { status: 200 }) },
    { name: 'missing acknowledgement', reply: response({}) },
  ];

  it.each(ambiguous)('keeps cancellation available while a new book is required after $name', async test => {
    const h = harness({ capabilities: request => ({ cancel:
      request.symbol === 'SBIN' && request.exchange === 'NSE' && request.type === 'SL',
    }) }), oldBook = deferred<Response>();
    await h.place();
    h.reads.push(oldBook.promise);
    const reading = h.feed.getOrders();
    h.replies.push(test.reply);
    await expect(h.feed.modify('OA1', { price: 110 })).rejects.toThrow();
    await h.feed.cancel('OA1');
    expect(h.cancels).toEqual([{ apikey: 'synthetic-placeholder', orderid: 'OA1', strategy: 'openalgo-charts' }]);
    oldBook.resolve(book([row()]));
    await reading;
    await expect(h.feed.modify('OA1', { triggerPrice: 96 })).rejects.toMatchObject({ preflight: true });
    expect(h.writes).toHaveLength(1);
    h.reads.push(book([row({ quantity: 'unreadable' })]));
    await h.feed.getOrders();
    await expect(h.feed.modify('OA1', { triggerPrice: 96 })).rejects.toMatchObject({ preflight: true });
    expect(h.writes).toHaveLength(1);
    h.reads.push(book([row({ price: 110, quantity: 6 })]));
    await h.feed.getOrders();
    await h.feed.modify('OA1', { triggerPrice: 96 });
    expect(h.writes[1]).toMatchObject({ price: 110, quantity: 6, trigger_price: 96 });
  });
});
