import { describe, it, expect } from 'vitest';
import { MarketProfile } from '../src/profile/market-profile-primitive';
import { computeMarketProfile } from '../src/profile/market-profile';
import { istStringToUtcSeconds } from '../src/feed/time';
import type { Bar } from '../src/model/bar';
import type { PrimitiveRenderContext } from '../src/primitives/primitive';

const bar = (time: number, low: number, high: number, volume = 100): Bar => ({
  time, open: low, high, low, close: high, volume,
});

function makeResult() {
  const t0 = istStringToUtcSeconds('2024-01-15 09:15:00');
  const bars = [bar(t0, 100, 110), bar(t0 + 1800, 105, 110)];
  return { result: computeMarketProfile(bars, { tickSize: 1, session: 'day', blockMinutes: 30 }), t0, bars };
}

function recorder() {
  const calls = { fillText: 0, fillRect: 0, stroke: 0, drawImage: 0 };
  const ctx = {
    canvas: {},
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {},
    beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { calls.stroke++; },
    fillRect() { calls.fillRect++; },
    fillText() { calls.fillText++; },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function makeRc(startTime: number, endTime: number): PrimitiveRenderContext {
  return {
    dpr: 2,
    plotWidth: 600, plotHeight: 300, priceAxisWidth: 60,
    timeScale: { indexToX: (i: number) => 100 + i * 40 },
    priceScale: { priceToY: (p: number) => 400 - p, format: (p: number) => p.toFixed(2) },
    dataLayer: { timeToIndex: (t: number) => (t === startTime ? 0 : t === endTime ? 5 : 5) },
    theme: {},
  } as unknown as PrimitiveRenderContext;
}

describe('MarketProfile primitive', () => {
  it('renders letters and POC/VA lines without throwing', () => {
    const { result, t0 } = makeResult();
    const mp = new MarketProfile(result);
    const { ctx, calls } = recorder();
    mp.draw(ctx, makeRc(t0, t0 + 1800));
    expect(calls.fillText).toBeGreaterThan(0); // TPO letters + labels
    expect(calls.stroke).toBeGreaterThan(0);   // POC / VA / IB lines
  });

  it('draws solid blocks when letters are disabled', () => {
    const { result, t0 } = makeResult();
    const mp = new MarketProfile(result, { showLetters: false, showValueAreaLabels: false, showPocLabel: false });
    const { ctx, calls } = recorder();
    mp.draw(ctx, makeRc(t0, t0 + 1800));
    expect(calls.fillRect).toBeGreaterThan(0);
  });

  it('reports its price extent via autoscaleInfo', () => {
    const { result } = makeResult();
    const mp = new MarketProfile(result);
    expect(mp.autoscaleInfo()).toEqual({ min: 100, max: 110 });
  });

  it('is a no-op with no data', () => {
    const mp = new MarketProfile(null);
    const { ctx, calls } = recorder();
    mp.draw(ctx, makeRc(0, 1));
    expect(calls.fillText + calls.fillRect + calls.stroke).toBe(0);
    expect(mp.autoscaleInfo()).toBeNull();
  });
});
