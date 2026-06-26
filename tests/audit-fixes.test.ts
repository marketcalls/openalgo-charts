import { describe, it, expect } from 'vitest';
import { utcSecondsToIstDateString } from '../src/feed/time';
import { OrderEngine } from '../src/trade/order-engine';
import type { OrderConstraints } from '../src/trade/validation';
import { FakeBroker } from '../src/trade/fake-broker';
import { DataLayer } from '../src/model/data-layer';
import { getChartType, registerChartType } from '../src/model/chart-type-registry';
import { WorkingOrderLine } from '../src/trade/order-line';
import type { Bar } from '../src/model/bar';

const bar = (time: number, c: number): Bar => ({ time, open: c, high: c + 1, low: c - 1, close: c });
const C: OrderConstraints = { tickSize: 0.05, priceBand: { lower: 90, upper: 110 }, freezeQty: 1000 };

describe('C1 — history date formatting', () => {
  it('formats UTC seconds as an IST YYYY-MM-DD date', () => {
    // 2024-01-15 03:45 UTC = 09:15 IST → 2024-01-15
    expect(utcSecondsToIstDateString(Date.UTC(2024, 0, 15, 3, 45) / 1000)).toBe('2024-01-15');
    // 2024-01-14 20:00 UTC = 2024-01-15 01:30 IST → still the 15th in IST
    expect(utcSecondsToIstDateString(Date.UTC(2024, 0, 14, 20, 0) / 1000)).toBe('2024-01-15');
  });
});

describe('H2 — modify validation never sends an out-of-band price', () => {
  it('skips the modify and reports a validation error', async () => {
    const broker = new FakeBroker();
    let rejected = '';
    const eng = new OrderEngine({ feed: broker, constraints: C, armed: true, onValidationError: (r) => { rejected = r; } });
    const r = await eng.placeOrder({ symbol: 'X', side: 'BUY', type: 'LIMIT', qty: 10, price: 100 });
    const brokerId = broker.orders()[0].id;
    const before = broker.orders().find((o) => o.id === brokerId)!.price;
    eng.requestModify(r.clientId!, 999); // out of band
    await Promise.resolve();
    expect(rejected).not.toBe('');
    expect(broker.orders().find((o) => o.id === brokerId)!.price).toBe(before); // unchanged
  });
});

describe('H3 — idempotency token is released on a failed place (retry allowed)', () => {
  it('lets the same clientToken be retried after a broker reject', async () => {
    const broker = new FakeBroker();
    const eng = new OrderEngine({ feed: broker, constraints: C, armed: true });
    broker.rejectNextPlace = 'transport error';
    const r1 = await eng.placeOrder({ symbol: 'X', side: 'BUY', type: 'LIMIT', qty: 10, price: 100, clientToken: 'tokA' });
    expect(r1.ok).toBe(false);
    const r2 = await eng.placeOrder({ symbol: 'X', side: 'BUY', type: 'LIMIT', qty: 10, price: 100, clientToken: 'tokA' }); // retry
    expect(r2.ok).toBe(true);
    expect(broker.orders()).toHaveLength(1);
  });
});

describe('H4 — order line repaints on LTP', () => {
  it('setLtp requests a host update', () => {
    let updates = 0;
    const line = new WorkingOrderLine({ id: 'o1', symbol: 'X', side: 'BUY', type: 'LIMIT', qty: 10, filledQty: 0, price: 100, status: 'working' });
    line.attached({ requestUpdate: () => { updates++; } });
    line.setLtp(101);
    expect(updates).toBe(1);
  });
});

describe('H5/H6 — registry custom keys + clear tier error', () => {
  it('accepts a custom string chart type', () => {
    registerChartType('my-custom-style', { defaultStyle: {}, isPriceSeries: true, draw: () => {}, extents: (b) => ({ min: b.low, max: b.high }) });
    expect(() => getChartType('my-custom-style')).not.toThrow();
  });
  it('gives a tier-specific error for transform-only types when not loaded', () => {
    // Fresh registry state in this isolated test file → transform tier not imported
    expect(() => getChartType('point-figure')).toThrow(/transform tier/);
  });
});

describe('H7 — DataLayer.update reports change kind', () => {
  it('distinguishes append / replace / insert', () => {
    const dl = new DataLayer();
    const id = dl.createSeries();
    dl.setSeriesData(id, [bar(100, 1), bar(200, 2)]);
    expect(dl.update(id, bar(300, 3))).toBe('append');         // newer
    expect(dl.update(id, bar(300, 3.5))).toBe('replace');      // same time as last
    expect(dl.update(id, bar(150, 1.5))).toBe('insert');       // older → historical insert
  });
});
