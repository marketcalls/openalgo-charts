/**
 * A book read in the other endpoint's shape is not a book (re-audit N11).
 *
 * OpenAlgo's orderbook nests its rows beside its statistics, `data.orders`,
 * and its positionbook sends `data` as the list itself. One helper read both
 * and took `data.orders` from either, so a positionbook answer in the
 * orderbook's shape, `{ data: { orders: [] } }`, read as no positions: the
 * host reconciled a flat account and the visible position disappeared. A
 * position read in any other shape is unknown, and throws.
 */
import { describe, expect, it } from 'vitest';
import { OpenAlgoTradeFeed } from '../src/feed/openalgo-trade';
import { TradeController } from '../src/trade/trade-controller';
import type { IPrimitive } from '../src/index';
import type { Order } from '../src/trade/types';

const order = { orderid: 'OA1', symbol: 'INFY', exchange: 'NSE', product: 'MIS', action: 'BUY', pricetype: 'LIMIT',
  quantity: 10, price: 100, order_status: 'open' };
const position = { symbol: 'INFY', exchange: 'NSE', product: 'MIS', quantity: '10', average_price: '100' };

function feedReplying(replies: Record<string, unknown>): OpenAlgoTradeFeed {
  const fetchImpl = (async (url: string) => ({ ok: true, status: 200,
    json: async () => replies[String(url).replace('http://x', '')] } as Response)) as unknown as typeof fetch;
  return new OpenAlgoTradeFeed({ baseUrl: 'http://x', apiKey: 'k', fetchImpl, verifyMode: 'off' });
}

class Host {
  public live: IPrimitive[] = [];
  public addPrimitive(p: IPrimitive): void { this.live.push(p); }
  public removePrimitive(p: IPrimitive): void { this.live = this.live.filter((q) => q !== p); }
}

describe('the positionbook takes only its own collection shape', () => {
  it.each([
    { status: 'success', data: { orders: [] } },
    { status: 'success', data: { orders: [position] } },
    { status: 'success', data: { orders: [], statistics: {} } },
    { data: { orders: [] } },
  ])('getPositions throws on the orderbook shape %j', async (reply) => {
    const feed = feedReplying({ '/api/v1/positionbook': reply });
    await expect(feed.getPositions()).rejects.toThrow(/positionbook returned no readable book/);
  });

  it('keeps the visible position when that read throws, as a host that reconciles on success does', async () => {
    const host = new Host();
    const tc = new TradeController(host);
    const instrument = { symbol: 'INFY', exchange: 'NSE' };
    const good = feedReplying({ '/api/v1/positionbook': { status: 'success', data: [position] } });
    tc.reconcile([], await good.getPositions(), instrument);
    expect(tc.positionCount()).toBe(1);
    const wrong = feedReplying({ '/api/v1/positionbook': { status: 'success', data: { orders: [] } } });
    await wrong.getPositions().then((rows) => tc.reconcile([], rows, instrument), () => undefined);
    expect(tc.positionCount()).toBe(1);
  });

  it('still reads its documented list, empty or not', async () => {
    const feed = feedReplying({ '/api/v1/positionbook': { status: 'success', data: [position] } });
    expect(await feed.getPositions()).toEqual([{ symbol: 'INFY', exchange: 'NSE', product: 'MIS', netQty: 10, avgPrice: 100 }]);
    const empty = feedReplying({ '/api/v1/positionbook': { status: 'success', data: [] } });
    expect(await empty.getPositions()).toEqual([]);
  });
});

describe('the orderbook keeps both shapes it accepted', () => {
  it.each([
    { status: 'success', data: { orders: [order], statistics: {} } },
    { status: 'success', data: [order] },
  ])('reads %j', async (reply) => {
    const feed = feedReplying({ '/api/v1/orderbook': reply });
    expect((await feed.getOrders() as Order[]).map((o) => o.id)).toEqual(['OA1']);
  });
});
