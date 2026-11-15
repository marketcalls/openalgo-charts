/**
 * Order and position identity (audit T1).
 *
 * OpenAlgo's books carry one row per symbol, exchange and product. The adapter
 * used to keep only the symbol, and the controller kept one position marker per
 * symbol, so INFY CNC +100 and INFY MIS -50 collapsed into one marker reading
 * -50, and a reconcile handed the whole book drew every instrument's orders on
 * one chart, a futures order at 52000 stretching an equity chart's scale to it.
 * A position row with an unreadable quantity read as flat.
 */
import { describe, expect, it } from 'vitest';
import { OpenAlgoTradeFeed, mapPosition, type RawOrder } from '../src/feed/openalgo-trade';
import { TradeController, type TradeHost } from '../src/trade/trade-controller';
import { WorkingOrderLine } from '../src/trade/order-line';
import { PositionMarker } from '../src/trade/position';
import { BracketGroup } from '../src/trade/bracket';
import type { Order, Position } from '../src/trade/types';
import type { IPrimitive } from '../src/primitives/primitive';

const positionRows = [
  { symbol: 'INFY', exchange: 'NSE', product: 'CNC', quantity: '100', average_price: '1500.00' },
  { symbol: 'INFY', exchange: 'NSE', product: 'MIS', quantity: '-50', average_price: '1520.00' },
  { symbol: 'INFY', exchange: 'BSE', product: 'CNC', quantity: '10', average_price: '1501.00' },
  { symbol: 'RELIANCE', exchange: 'BSE', product: 'CNC', quantity: '10', average_price: '2900.00' },
];
const orderRows: RawOrder[] = [
  { orderid: '1', symbol: 'BANKNIFTY26NOVFUT', exchange: 'NFO', action: 'BUY', pricetype: 'LIMIT', product: 'NRML',
    quantity: '30', price: '52000', trigger_price: '0', order_status: 'open' },
  { orderid: '2', symbol: 'INFY', exchange: 'BSE', action: 'SELL', pricetype: 'LIMIT', product: 'CNC',
    quantity: '10', price: '1550', trigger_price: '0', order_status: 'open' },
  { orderid: '3', symbol: 'INFY', exchange: 'NSE', action: 'SELL', pricetype: 'LIMIT', product: 'MIS',
    quantity: '50', price: '1490', trigger_price: '0', order_status: 'open' },
];

function feedFor(positions: unknown[], orders: unknown[] = orderRows): OpenAlgoTradeFeed {
  const fetchImpl = (async (url: string) => ({
    ok: true, status: 200,
    json: async () => ({ status: 'success', data: String(url).endsWith('/positionbook') ? positions : { orders } }),
  } as Response)) as unknown as typeof fetch;
  return new OpenAlgoTradeFeed({ baseUrl: 'http://x', apiKey: 'k', fetchImpl });
}

class Host implements TradeHost {
  public live: IPrimitive[] = [];
  public addPrimitive(p: IPrimitive): void { this.live.push(p); }
  public removePrimitive(p: IPrimitive): void { this.live = this.live.filter((q) => q !== p); }
  public markers(): Position[] { return this.live.filter((p) => p instanceof PositionMarker).map((p) => (p as PositionMarker).position); }
  public lines(): Order[] { return this.live.filter((p) => p instanceof WorkingOrderLine).map((p) => (p as WorkingOrderLine).order); }
}

describe('the OpenAlgo adapter keeps exchange and product', () => {
  it('on every order and position row it reads', async () => {
    const feed = feedFor(positionRows);
    const orders = await feed.getOrders();
    expect(orders.map((o) => [o.id, o.exchange, o.product])).toEqual([['1', 'NFO', 'NRML'], ['2', 'BSE', 'CNC'], ['3', 'NSE', 'MIS']]);
    const positions = await feed.getPositions();
    expect(positions).toEqual([
      { symbol: 'INFY', exchange: 'NSE', product: 'CNC', netQty: 100, avgPrice: 1500 },
      { symbol: 'INFY', exchange: 'NSE', product: 'MIS', netQty: -50, avgPrice: 1520 },
      { symbol: 'INFY', exchange: 'BSE', product: 'CNC', netQty: 10, avgPrice: 1501 },
      { symbol: 'RELIANCE', exchange: 'BSE', product: 'CNC', netQty: 10, avgPrice: 2900 },
    ]);
  });

  it('leaves both out of a row that does not carry them, as before', async () => {
    const feed = feedFor([{ symbol: 'SBIN', quantity: '5', average_price: '780' }],
      [{ orderid: '9', symbol: 'SBIN', action: 'BUY', pricetype: 'LIMIT', quantity: 5, price: 780, order_status: 'open' }]);
    expect(await feed.getPositions()).toEqual([{ symbol: 'SBIN', netQty: 5, avgPrice: 780 }]);
    const [order] = await feed.getOrders();
    expect(order).not.toHaveProperty('exchange');
    expect(order).not.toHaveProperty('product');
  });
});

describe('a position read never invents a flat position', () => {
  it('refuses a row whose quantity cannot be read', () => {
    expect(() => mapPosition({ symbol: 'SBIN', quantity: 'n/a', average_price: '' })).toThrow(/quantity/);
    expect(() => mapPosition({ symbol: 'SBIN', average_price: '780' })).toThrow(/quantity/);
  });

  it('refuses an open position whose average price cannot be read, and a row with no symbol', () => {
    expect(() => mapPosition({ symbol: 'SBIN', quantity: '5', average_price: 'abc' })).toThrow(/average_price/);
    expect(() => mapPosition({ quantity: '5', average_price: '780' })).toThrow(/symbol/);
  });

  it('still reads a flat row whose average price is blank', () => {
    expect(mapPosition({ symbol: 'SBIN', quantity: '0', average_price: '' })).toEqual({ symbol: 'SBIN', netQty: 0, avgPrice: 0 });
  });

  it('fails the whole position read, naming the row, rather than drop or zero it', async () => {
    const feed = feedFor([...positionRows, { symbol: 'SBIN', exchange: 'NSE', product: 'MIS', quantity: 'n/a', average_price: '' }]);
    await expect(feed.getPositions()).rejects.toThrow(/positions\[4\]\.quantity/);
  });
});

describe('TradeController keys a position by symbol, exchange and product', () => {
  it('draws one marker per row of the book', () => {
    const host = new Host();
    const tc = new TradeController(host);
    const positions: Position[] = positionRows.map((r) => mapPosition(r));
    tc.reconcile([], positions);
    expect(tc.positionCount()).toBe(4);
    expect(host.markers().filter((p) => p.symbol === 'INFY').map((p) => p.netQty)).toEqual([100, -50, 10]);
    // An update replaces the row it names and no other.
    tc.reconcile([], positions.map((p) => (p.product === 'MIS' ? { ...p, netQty: -25 } : p)));
    expect(host.markers().map((p) => p.netQty)).toEqual([100, -25, 10, 10]);
    tc.reconcile([], positions.filter((p) => p.product !== 'MIS'));
    expect(host.markers().map((p) => p.netQty)).toEqual([100, 10, 10]);
  });

  it('pairs a bracket with the position of its own product', () => {
    const host = new Host();
    const tc = new TradeController(host);
    const leg = (id: string, role: 'sl' | 'tp', price: number): Order => ({ id, symbol: 'INFY', exchange: 'NSE', product: 'MIS',
      side: 'SELL', type: role === 'sl' ? 'SL-M' : 'LIMIT', qty: 50, filledQty: 0, price, status: 'working', role,
      ...(role === 'sl' ? { triggerPrice: price } : {}) });
    tc.reconcile([leg('s', 'sl', 1480), leg('t', 'tp', 1560)], [
      { symbol: 'INFY', exchange: 'NSE', product: 'MIS', netQty: 50, avgPrice: 1520 },
      { symbol: 'INFY', exchange: 'NSE', product: 'CNC', netQty: 100, avgPrice: 1500 },
    ]);
    const brackets = host.live.filter((p) => p instanceof BracketGroup) as BracketGroup[];
    expect(brackets.map((b) => b.state.entry)).toEqual([1520]);
  });
});

describe('TradeController can reconcile one instrument', () => {
  it('draws only the orders and positions of the chart instrument, so others stay out of its autoscale', async () => {
    const feed = feedFor(positionRows);
    const host = new Host();
    const tc = new TradeController(host);
    tc.reconcile(await feed.getOrders() as Order[], await feed.getPositions(), { symbol: 'INFY', exchange: 'NSE' });
    expect(host.lines().map((o) => o.id)).toEqual(['3']);
    expect(host.markers().map((p) => p.product)).toEqual(['CNC', 'MIS']);
    const scaled = host.live.flatMap((p) => { const a = p.autoscaleInfo?.(); return a ? [a.min, a.max] : []; });
    expect(Math.max(...scaled)).toBeLessThan(2000);
  });

  it('takes a row that names no exchange as the instrument when the symbol matches', () => {
    const host = new Host();
    const tc = new TradeController(host);
    tc.reconcile([], [{ symbol: 'INFY', netQty: 5, avgPrice: 1500 }, { symbol: 'TCS', netQty: 5, avgPrice: 4000 }],
      { symbol: 'INFY', exchange: 'NSE' });
    expect(host.markers().map((p) => p.symbol)).toEqual(['INFY']);
  });

  it('removes what it drew for another instrument once the filter moves', async () => {
    const feed = feedFor(positionRows);
    const host = new Host();
    const tc = new TradeController(host);
    const orders = await feed.getOrders() as Order[], positions = await feed.getPositions();
    tc.reconcile(orders, positions, { symbol: 'INFY', exchange: 'NSE' });
    tc.reconcile(orders, positions, { symbol: 'INFY', exchange: 'BSE' });
    expect(host.lines().map((o) => o.id)).toEqual(['2']);
    expect(host.markers().map((p) => [p.exchange, p.netQty])).toEqual([['BSE', 10]]);
  });

  it('without an instrument still draws the whole book', async () => {
    const feed = feedFor(positionRows);
    const host = new Host();
    const tc = new TradeController(host);
    tc.reconcile(await feed.getOrders() as Order[], await feed.getPositions());
    expect(tc.orderLineCount()).toBe(3);
    expect(tc.positionCount()).toBe(4);
  });
});
