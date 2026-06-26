import { describe, it, expect } from 'vitest';
import { computeVolumeProfile } from '../src/profile/volume-profile';
import { computeTpo } from '../src/profile/tpo';
import {
  computeFootprint, diagonalImbalances, cumulativeDelta, stackedImbalances, type ClassifiedTrade,
} from '../src/profile/footprint';
import { HorizontalProfile, Footprint } from '../src/profile/profile-primitive';
import { priceBuckets } from '../src/profile/profile-model';
import type { Bar } from '../src/model/bar';
import type { PrimitiveRenderContext } from '../src/primitives/primitive';
import { PriceScale } from '../src/scale/price-scale';
import { TimeScale } from '../src/scale/time-scale';
import { DataLayer } from '../src/model/data-layer';
import { makeCtx } from './helpers/fake-ctx';

const bar = (time: number, o: number, h: number, l: number, c: number, v: number): Bar => ({ time, open: o, high: h, low: l, close: c, volume: v });

describe('priceBuckets', () => {
  it('spans inclusive low→high on the tick grid', () => {
    expect(priceBuckets(100, 100.2, 0.05)).toEqual([100, 100.05, 100.1, 100.15, 100.2]);
  });
});

describe('Volume Profile', () => {
  it('finds POC at the most-traded price and a 70% value area', () => {
    // bar that concentrates huge volume in a tight band around 100
    const bars = [
      bar(1, 100, 100.1, 99.9, 100, 100),
      bar(2, 100, 100.05, 99.95, 100, 5000), // dominant volume near 100
      bar(3, 101, 102, 100, 101, 100),
    ];
    const vp = computeVolumeProfile(bars, 0.05, 0.7);
    expect(vp.poc).toBeGreaterThanOrEqual(99.95);
    expect(vp.poc).toBeLessThanOrEqual(100.05);
    expect(vp.vah).toBeGreaterThanOrEqual(vp.val);
    // value area holds ~70% of volume
    const vaVol = vp.buckets.filter((b) => b.price <= vp.vah && b.price >= vp.val).reduce((s, b) => s + b.volume, 0);
    expect(vaVol).toBeGreaterThanOrEqual(vp.totalVolume * 0.7 - 1e-6);
  });

  it('handles empty input', () => {
    const vp = computeVolumeProfile([], 0.05);
    expect(vp.buckets).toHaveLength(0);
    expect(vp.totalVolume).toBe(0);
  });
});

describe('TPO / Market Profile', () => {
  it('counts periods at price, derives POC/VA and the initial balance', () => {
    const bars = [
      bar(1, 100, 101, 99, 100, 0), bar(2, 100, 101, 99, 100, 0), // period 0
      bar(3, 100, 100.5, 99.5, 100, 0), bar(4, 100, 100.5, 99.5, 100, 0), // period 1
      bar(5, 103, 104, 102, 103, 0), bar(6, 103, 104, 102, 103, 0), // period 2
    ];
    const tpo = computeTpo(bars, 2, 0.5, 0.7, 2); // 2 bars/period, IB = first 2 periods
    expect(tpo.buckets.length).toBeGreaterThan(0);
    // prices around 100 are touched by 2 periods → higher count than 103 band
    expect(tpo.poc).toBeGreaterThanOrEqual(99.5);
    expect(tpo.poc).toBeLessThanOrEqual(101);
    // IB spans the first two periods' combined range (99 .. 101)
    expect(tpo.ib.high).toBeCloseTo(101);
    expect(tpo.ib.low).toBeCloseTo(99);
  });
});

describe('Footprint & order flow', () => {
  const trades: ClassifiedTrade[] = [
    { price: 100.0, qty: 30, side: 'ask' },
    { price: 100.0, qty: 10, side: 'bid' },
    { price: 100.05, qty: 50, side: 'ask' },
    { price: 99.95, qty: 40, side: 'bid' },
  ];

  it('aggregates bid/ask per price and computes net delta', () => {
    const fp = computeFootprint(1, trades, 0.05);
    const at100 = fp.cells.find((c) => Math.abs(c.price - 100) < 1e-9)!;
    expect(at100.askVol).toBe(30);
    expect(at100.bidVol).toBe(10);
    // delta = Σ(ask − bid) = (30-10) + (50-0) + (0-40) = 20 + 50 - 40 = 30
    expect(fp.delta).toBe(30);
  });

  it('detects diagonal imbalances by ratio', () => {
    // strong ask at 100.05 vs bid at 100.0 → buy imbalance
    const fp = computeFootprint(1, trades, 0.05);
    const imb = diagonalImbalances(fp.cells, 3);
    expect(imb.some((i) => i.side === 'buy')).toBe(true);
  });

  it('cumulative delta accumulates across bars', () => {
    const bars = [
      computeFootprint(1, [{ price: 100, qty: 10, side: 'ask' }], 0.05), // +10
      computeFootprint(2, [{ price: 100, qty: 4, side: 'bid' }], 0.05),  // -4
      computeFootprint(3, [{ price: 100, qty: 6, side: 'ask' }], 0.05),  // +6
    ];
    expect(cumulativeDelta(bars)).toEqual([10, 6, 12]);
  });

  it('finds stacked imbalances of minimum length', () => {
    const cells = [
      { price: 100.15, bidVol: 1, askVol: 90 },
      { price: 100.10, bidVol: 1, askVol: 90 },
      { price: 100.05, bidVol: 1, askVol: 90 },
      { price: 100.00, bidVol: 1, askVol: 1 },
    ];
    const stacks = stackedImbalances(cells, 3, 3);
    expect(stacks.length).toBeGreaterThanOrEqual(1);
    expect(stacks[0].side).toBe('buy');
    expect(stacks[0].count).toBeGreaterThanOrEqual(3);
  });
});

describe('profile primitives render', () => {
  function rc(): PrimitiveRenderContext {
    const dl = new DataLayer();
    const id = dl.createSeries();
    dl.setSeriesData(id, [bar(1, 100, 101, 99, 100, 10), bar(2, 100, 101, 99, 100, 10)]);
    const priceScale = new PriceScale();
    priceScale.setHeight(400);
    priceScale.setPriceRange({ min: 98, max: 103 });
    const timeScale = new TimeScale();
    timeScale.setWidth(600);
    timeScale.setBaseIndex(dl.baseIndex);
    return { timeScale, priceScale, dataLayer: dl, plotWidth: 600, plotHeight: 400, priceAxisWidth: 56, dpr: 1 };
  }

  it('HorizontalProfile draws bars + POC/VA lines', () => {
    const hp = new HorizontalProfile({
      buckets: [{ price: 100, value: 50 }, { price: 100.5, value: 20 }, { price: 101, value: 5 }],
      poc: 100, vah: 100.5, val: 100, width: 120, side: 'right', barColor: '#345', vaColor: '#456',
    });
    const { ctx, rec } = makeCtx();
    hp.draw(ctx, rc());
    expect(rec.count('fillRect')).toBeGreaterThan(0);
    expect(rec.count('stroke')).toBe(3); // POC + VAH + VAL
  });

  it('Footprint draws cells aligned to chart bars', () => {
    const r = rc();
    const fp = new Footprint();
    fp.setBars([computeFootprint(1, [{ price: 100, qty: 5, side: 'ask' }, { price: 100, qty: 2, side: 'bid' }], 0.05)]);
    const { ctx, rec } = makeCtx();
    fp.draw(ctx, r);
    expect(rec.count('fillText')).toBeGreaterThan(0);
  });
});
