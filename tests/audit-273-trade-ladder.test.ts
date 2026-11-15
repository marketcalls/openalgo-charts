/**
 * Depth ladder grouping (audit, below the bar). Bids and asks were bucketed with
 * the same Math.round, so a grouped row could show a bid above the price it
 * rests at, or an ask below it: a better price than the book holds, on a row a
 * click routes to an order. Bids now round down to their group and asks up.
 */
import { describe, expect, it } from 'vitest';
import { buildRows } from '../src/trade/dom-ladder';
import { TickSchedule } from '../src/feed/tick-schedule';
import type { MarketDepth } from '../src/feed/types';

const prices = (from: number, count: number, tick: number): number[] =>
  Array.from({ length: count }, (_, i) => +(from + i * tick).toFixed(4));
const only = (side: 'bids' | 'asks', price: number): MarketDepth =>
  ({ ltp: price, bids: side === 'bids' ? [{ price, qty: 1 }] : [], asks: side === 'asks' ? [{ price, qty: 1 }] : [] });
const rowOf = (book: MarketDepth, tick: number | TickSchedule, groupBy: number): number => buildRows(book, tick, groupBy)[0]!.price;

describe('a grouped ladder never improves on the book', () => {
  it.each([2, 3, 4, 5, 10])('constant tick, groups of %i', (groupBy) => {
    for (const price of prices(99, 41, 0.05)) {
      expect(rowOf(only('bids', price), 0.05, groupBy)).toBeLessThanOrEqual(price + 1e-9);
      expect(rowOf(only('asks', price), 0.05, groupBy)).toBeGreaterThanOrEqual(price - 1e-9);
    }
  });

  it.each([2, 3, 5])('tick schedule, groups of %i', (groupBy) => {
    const ticks = new TickSchedule([{ tick: 0.01 }, { from: 100, tick: 0.05 }]);
    for (const price of [...prices(99.5, 50, 0.01), ...prices(100, 40, 0.05)]) {
      expect(rowOf(only('bids', price), ticks, groupBy)).toBeLessThanOrEqual(price + 1e-9);
      expect(rowOf(only('asks', price), ticks, groupBy)).toBeGreaterThanOrEqual(price - 1e-9);
    }
  });

  it('puts a bid and an ask of one group on the rows either side of the spread', () => {
    const book: MarketDepth = { ltp: 100.07, bids: [{ price: 100.05, qty: 3 }, { price: 100, qty: 2 }],
      asks: [{ price: 100.1, qty: 4 }, { price: 100.15, qty: 5 }] };
    expect(buildRows(book, 0.05, 2)).toEqual([
      { price: 100.2, bidQty: 0, askQty: 5 },
      { price: 100.1, bidQty: 0, askQty: 4 },
      { price: 100, bidQty: 5, askQty: 0 },
    ]);
  });

  it('leaves an ungrouped ladder on the nearest tick, as before', () => {
    const odd: MarketDepth = { ltp: 100, bids: [{ price: 100.04, qty: 1 }], asks: [{ price: 100.06, qty: 1 }] };
    expect(buildRows(odd, 0.05, 1)).toEqual([{ price: 100.05, bidQty: 1, askQty: 1 }]);
  });
});
