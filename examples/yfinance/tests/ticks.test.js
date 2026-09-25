import { describe, it, expect, beforeEach } from 'vitest';
import { HOST_TICK_BANDS, tickScheduleFor, snapPrice, tickNote } from '../src/ticks.js';
import { initOrders, placeOrder, fillMarket, repriceOrder } from '../src/orders.js';
import { initBracket, makeBracket, setBracketPrice } from '../src/bracket.js';
import { fakeDom, fakeStorage, flatBar } from './helpers.js';

globalThis.requestAnimationFrame = () => 0;

describe('the host tick rules', () => {
  it('supplies a schedule only for the fixture symbol that carries one', () => {
    const ticks = tickScheduleFor('banded');
    expect(ticks.bands).toEqual(HOST_TICK_BANDS.BANDED);
    expect(ticks.minMove).toBe(0.01);
    expect(tickScheduleFor('AAPL')).toBeNull();
    expect(tickScheduleFor('RELIANCE.NS')).toBeNull();
    expect(tickScheduleFor(undefined)).toBeNull();
  });

  it('rounds to two decimals without a schedule, exactly as before', () => {
    expect(snapPrice(null, 101.239)).toBe(101.24);
    expect(snapPrice(null, 100.03)).toBe(100.03);
    expect(tickNote(null, 100)).toBe('');
  });

  it('rounds on the band a price is in with a schedule', () => {
    const ticks = tickScheduleFor('BANDED');
    expect(snapPrice(ticks, 99.994)).toBe(99.99);
    expect(snapPrice(ticks, 99.996)).toBe(100);
    expect(snapPrice(ticks, 100.03)).toBe(100.05);
    expect(tickNote(ticks, 99.99)).toBe(', tick 0.01');
    expect(tickNote(ticks, 100)).toBe(', tick 0.05');
  });
});

function freshApp(ticks) {
  return {
    chart: null, req: { symbol: 'BANDED' }, currentBars: [flatBar(1, 99.98)], ticks,
    orders: [], nextOrderId: 1, position: null, posLine: null, fills: [], markersApi: null,
    bracket: null, bLines: null,
  };
}

describe('orders on a scheduled instrument', () => {
  let app;
  let dom;
  beforeEach(() => {
    dom = fakeDom({ qty: '10', product: 'MIS' });
    fakeStorage();
    app = freshApp(tickScheduleFor('BANDED'));
    initOrders(app);
  });

  it('rests a limit order at the price its band allows', () => {
    placeOrder('BUY', 'LIMIT', 100.03);
    placeOrder('SELL', 'LIMIT', 99.994);
    expect(app.orders.map((o) => o.price)).toEqual([100.05, 99.99]);
    expect(dom.get('status').textContent).toContain('@ 99.99 (MIS), tick 0.01');
  });

  it('reprices a dragged order line across the boundary on the new grid', () => {
    placeOrder('BUY', 'LIMIT', 99.98);
    const moved = [];
    app.orders[0].line = { setPrice: (p) => moved.push(p) };
    repriceOrder('order:1', 100.071);
    expect(app.orders[0].price).toBe(100.05);
    expect(dom.get('status').textContent).toBe('BUY LIMIT order -> 100.05, tick 0.05');
    repriceOrder('order:1', 99.9851);
    expect(app.orders[0].price).toBe(99.99);
    expect(moved).toEqual([100.05, 99.99]);
    repriceOrder('order:9', 50);
    expect(app.orders[0].price).toBe(99.99);
  });

  it('fills a market order at the last price on the grid', () => {
    app.currentBars = [flatBar(2, 100.03)];
    fillMarket('BUY', 10);
    expect(app.position).toEqual({ netQty: 10, avgPrice: 100.05 });
  });

  it('keeps the unscheduled drag on two decimals', () => {
    app.ticks = null;
    placeOrder('BUY', 'LIMIT', 99.98);
    app.orders[0].line = { setPrice: () => {} };
    repriceOrder('order:1', 100.071);
    expect(app.orders[0].price).toBe(100.07);
    expect(dom.get('status').textContent).toBe('BUY LIMIT order -> 100.07');
  });
});

describe('a bracket on a scheduled instrument', () => {
  let app;
  beforeEach(() => {
    fakeDom({ qty: '10' });
    fakeStorage();
    app = freshApp(tickScheduleFor('BANDED'));
    app.chart = {
      addPriceLine: (opts) => { const line = { ...opts, setPrice: (p) => { line.price = p; }, setOptions: () => {} }; return line; },
      removePrimitive: () => {}, priceToCoordinate: () => null,
    };
    initOrders(app);
    initBracket(app);
  });

  it('opens with each leg on the grid of its own band', () => {
    makeBracket('BUY');
    // 99.98 * 1.012 = 101.17976 on the 0.05 band; 99.98 * 0.99 on the 0.01 band.
    expect(app.bracket).toMatchObject({ entry: 99.98, target: 101.2, stop: 98.98 });
  });

  it('keeps each exit one tick of its own band away from the entry', () => {
    makeBracket('BUY');
    setBracketPrice('tp', 50);
    expect(app.bracket.target).toBe(99.99);
    setBracketPrice('entry', 100.03);
    expect(app.bracket).toMatchObject({ entry: 100.05, target: 100.1, stop: 99.05 });
    setBracketPrice('sl', 101);
    // One tick below 100.05 is 100.00, on the band that starts there.
    expect(app.bracket.stop).toBe(100);
    setBracketPrice('tp', 100.12);
    expect(app.bracket.target).toBe(100.1);
    expect(app.bLines.tp.price).toBe(100.1);
  });

  it('mirrors the bounds for a short across the boundary', () => {
    app.currentBars = [flatBar(2, 100)];
    makeBracket('SELL');
    setBracketPrice('tp', 150);
    expect(app.bracket.target).toBe(99.99);
    setBracketPrice('sl', 20);
    expect(app.bracket.stop).toBe(100.05);
  });
});
