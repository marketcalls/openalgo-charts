import { describe, it, expect } from 'vitest';
import { niceNum, niceTicks, precisionForStep } from '../src/scale/ticks';
import { PriceScale, autoscaleRange } from '../src/scale/price-scale';
import { TimeScale } from '../src/scale/time-scale';
import { optimalBarWidth } from '../src/render/candles';

describe('ticks', () => {
  it('rounds to nice numbers', () => {
    expect(niceNum(0.9, true)).toBe(1);
    expect(niceNum(23, true)).toBe(20);
    expect(niceNum(7, false)).toBe(10);
  });

  it('generates ascending in-range ticks', () => {
    const t = niceTicks(0, 100, 6);
    expect(t[0]).toBeGreaterThanOrEqual(0);
    expect(t[t.length - 1]).toBeLessThanOrEqual(100);
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
  });

  it('handles degenerate ranges without looping', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(NaN, 10)).toHaveLength(1);
  });

  it('derives precision from step', () => {
    expect(precisionForStep(1)).toBe(0);
    expect(precisionForStep(0.05)).toBe(2);
    expect(precisionForStep(0.001)).toBe(3);
  });
});

describe('PriceScale', () => {
  it('autoscale adds margins around extremes', () => {
    const r = autoscaleRange(100, 200, 0.1, 0.1);
    expect(r.min).toBeCloseTo(90);
    expect(r.max).toBeCloseTo(210);
  });

  it('widens a flat range so it is drawable', () => {
    const r = autoscaleRange(100, 100, 0.1, 0.1);
    expect(r.max).toBeGreaterThan(r.min);
  });

  it('maps price ↔ y invertibly (higher price → smaller y)', () => {
    const ps = new PriceScale();
    ps.setHeight(400);
    ps.setPriceRange({ min: 0, max: 100 });
    expect(ps.priceToY(100)).toBeCloseTo(0);
    expect(ps.priceToY(0)).toBeCloseTo(400);
    expect(ps.priceToY(50)).toBeCloseTo(200);
    expect(ps.yToPrice(200)).toBeCloseTo(50);
  });

  it('snaps to tick size and formats with derived precision', () => {
    const ps = new PriceScale({ minMove: 0.05 });
    expect(ps.snapToTick(100.07)).toBeCloseTo(100.05);
    expect(ps.format(100.05)).toBe('100.05');
  });
});

describe('TimeScale', () => {
  it('maps logical index ↔ x invertibly', () => {
    const ts = new TimeScale({ barSpacing: 10, rightOffset: 0 });
    ts.setWidth(500);
    ts.setBaseIndex(49); // 50 bars, base at right edge
    // rightEdgeIndex = 49; indexToX(49) = width = 500
    expect(ts.indexToX(49)).toBeCloseTo(500);
    expect(ts.indexToX(48)).toBeCloseTo(490);
    expect(ts.xToIndex(500)).toBeCloseTo(49);
    expect(ts.xToIndex(490)).toBeCloseTo(48);
  });

  it('clamps bar spacing to its bounds', () => {
    const ts = new TimeScale({ minBarSpacing: 2, maxBarSpacing: 50 });
    ts.setBarSpacing(1000);
    expect(ts.barSpacing).toBe(50);
    ts.setBarSpacing(0.1);
    expect(ts.barSpacing).toBe(2);
  });

  it('fitContent sizes spacing to the bar count', () => {
    const ts = new TimeScale();
    ts.setWidth(800);
    ts.fitContent(100);
    const vis = ts.visibleRange();
    // the latest bar (index 99) should be at/near the right edge
    expect(vis.to).toBeGreaterThanOrEqual(99);
    expect(ts.barSpacing).toBeGreaterThan(0);
  });
});

describe('optimalBarWidth', () => {
  it('grows with spacing, stays >= 1, parity-matched to the wick', () => {
    expect(optimalBarWidth(1, 1)).toBeGreaterThanOrEqual(1);
    expect(optimalBarWidth(10, 1)).toBeGreaterThan(optimalBarWidth(4, 1));
    // wick width at dpr=1 is 1 (odd) → body must be odd
    expect(optimalBarWidth(10, 1) % 2).toBe(1);
  });
});
