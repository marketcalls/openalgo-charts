import { describe, it, expect } from 'vitest';
import { DomLadder, ladderCapability, buildRows, visibleRows } from '../src/trade/dom-ladder';
import { FakeBroker } from '../src/trade/fake-broker';
import type { MarketDepth } from '../src/feed/types';
import type { PrimitiveRenderContext } from '../src/primitives/primitive';
import { PriceScale } from '../src/scale/price-scale';
import { TimeScale } from '../src/scale/time-scale';
import { DataLayer } from '../src/model/data-layer';
import { makeCtx } from './helpers/fake-ctx';

const depth = (levels: number): MarketDepth => FakeBroker.makeDepth(100, levels, 0.05);

function rc(): PrimitiveRenderContext {
  const priceScale = new PriceScale();
  priceScale.setHeight(400);
  priceScale.setPriceRange({ min: 95, max: 105 });
  const timeScale = new TimeScale();
  timeScale.setWidth(600);
  return { timeScale, priceScale, dataLayer: new DataLayer(), plotWidth: 600, plotHeight: 400, priceAxisWidth: 56, dpr: 1 };
}

describe('ladder capability (graceful degradation)', () => {
  it('classifies depth size into tiers', () => {
    expect(ladderCapability({ bids: [], asks: [], ltp: 100 })).toBe('none');
    expect(ladderCapability(depth(5))).toBe('compact');
    expect(ladderCapability(depth(20))).toBe('deep');
    expect(ladderCapability(depth(200))).toBe('deep');
  });
});

describe('buildRows aggregation', () => {
  it('merges bid/ask into price rows sorted high→low', () => {
    const rows = buildRows(depth(5), 0.05, 1);
    expect(rows.length).toBe(10); // 5 bids + 5 asks, distinct prices
    for (let i = 1; i < rows.length; i++) expect(rows[i].price).toBeLessThan(rows[i - 1].price);
  });

  it('buckets every N ticks when grouping deep books', () => {
    const grouped = buildRows(depth(20), 0.05, 5); // 0.25 buckets
    const ungrouped = buildRows(depth(20), 0.05, 1);
    expect(grouped.length).toBeLessThan(ungrouped.length);
    // total qty is preserved across aggregation
    const sum = (rows: { bidQty: number; askQty: number }[]) =>
      rows.reduce((a, r) => a + r.bidQty + r.askQty, 0);
    expect(sum(grouped)).toBe(sum(ungrouped));
  });
});

describe('virtualization', () => {
  it('caps rendered rows to maxRows for a deep book', () => {
    const rows = buildRows(depth(200), 0.05, 1);
    const priceToY = (p: number): number => 400 * (1 - (p - 0) / 200); // wide range → many on screen
    const vis = visibleRows(rows, priceToY, 400, 14, 60);
    expect(vis.length).toBeLessThanOrEqual(60);
  });

  it('culls rows whose price is off-screen', () => {
    // 200 levels × 0.05 = ±10 (90→110); visible range [95,105] → outer levels cull
    const rows = buildRows(depth(200), 0.05, 1);
    const priceScale = rc().priceScale; // [95,105]
    const vis = visibleRows(rows, (p) => priceScale.priceToY(p), 400, 14, 1000);
    expect(vis.length).toBeLessThan(rows.length);
    for (const r of vis) {
      const y = priceScale.priceToY(r.price);
      expect(y).toBeGreaterThanOrEqual(-14);
      expect(y).toBeLessThanOrEqual(414);
    }
  });
});

describe('DomLadder primitive', () => {
  it('renders bars for a populated book', () => {
    const ladder = new DomLadder({ tickSize: 0.05 });
    ladder.setDepth(depth(20));
    const { ctx, rec } = makeCtx();
    ladder.draw(ctx, rc());
    expect(rec.count('fillRect')).toBeGreaterThan(0);
    expect(ladder.tier()).toBe('deep');
  });

  it('degrades gracefully with no depth (draws nothing)', () => {
    const ladder = new DomLadder();
    const { ctx, rec } = makeCtx();
    ladder.draw(ctx, rc()); // never setDepth
    expect(rec.ops.length).toBe(0);
    expect(ladder.tier()).toBe('none');
  });

  it('hit-tests a price level inside the strip with side', () => {
    const r = rc();
    const ladder = new DomLadder({ tickSize: 0.05, width: 96 });
    ladder.setDepth(depth(5));
    const { ctx } = makeCtx();
    ladder.draw(ctx, r); // populates row hit positions
    const askPrice = 100.05;
    const y = r.priceScale.priceToY(askPrice);
    const hit = ladder.hitTest(r.plotWidth - 10, y, r);
    expect(hit?.externalId.startsWith('ladder-')).toBe(true);
  });
});
