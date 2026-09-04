import { describe, it, expect } from 'vitest';
import { applyTransform } from '../src/transforms.js';
import { fakeDom } from './helpers.js';

/** A gently trending session, so every transform has movement to work with. */
const bars = Array.from({ length: 60 }, (_, i) => {
  const base = 100 + i * (i % 3 === 0 ? -0.4 : 0.9);
  return { time: 1700000000 + i * 86400, open: base, high: base + 1.2, low: base - 1.1, close: base + 0.5, volume: 10 };
});

describe('applyTransform', () => {
  it('plots the candle-shaped transforms as candlesticks', () => {
    for (const kind of ['heikin-ashi', 'renko', 'range', 'line-break']) {
      const out = applyTransform(kind, bars);
      expect(out.type, kind).toBe('candlestick');
      expect(out.data.length, kind).toBeGreaterThan(0);
    }
    expect(applyTransform('heikin-ashi', bars).data).toHaveLength(bars.length);
  });

  it('hands kagi and point-and-figure to their own renderers', () => {
    expect(applyTransform('kagi', bars).type).toBe('kagi');
    fakeDom({ pfmode: 'atr' });
    const pf = applyTransform('point-figure', bars);
    expect(pf.type).toBe('point-figure');
    expect(pf.data.length).toBeGreaterThan(0);
  });

  it('passes an unknown kind and an empty session straight through', () => {
    expect(applyTransform('nope', bars)).toEqual({ type: 'candlestick', data: bars });
    expect(applyTransform('renko', [])).toEqual({ type: 'candlestick', data: [] });
  });
});
