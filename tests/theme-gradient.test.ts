import { describe, it, expect } from 'vitest';
import { darkTheme, lightTheme, type ChartTheme } from '../src/theme';
import { getChartType, type DrawItem, type SeriesRenderContext } from '../src/model/chart-type-registry';
import { verticalGradient } from '../src/render/gradient';
import type { Bar } from '../src/model/bar';
import { makeCtx } from './helpers/fake-ctx';

const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ time: t, open: o, high: h, low: l, close: c, volume: 100 });
const data: DrawItem[] = [bar(0, 10, 12, 9, 11), bar(1, 11, 13, 10, 12)].map((b, i) => ({ x: 10 + i * 10, bar: b }));
const toY = (v: number): number => 1000 - v;
const rc = (theme: ChartTheme): SeriesRenderContext => ({ plotHeight: 1000, maxVolume: 100, theme });

describe('theme presets', () => {
  it('expose a complete palette', () => {
    const keys: (keyof ChartTheme)[] = ['background', 'grid', 'upColor', 'downColor', 'lineColor', 'areaTopColor', 'buy', 'sell', 'crosshair'];
    for (const k of keys) {
      expect(typeof darkTheme[k]).toBe('string');
      expect(typeof lightTheme[k]).toBe('string');
    }
    expect(darkTheme.background).not.toBe(lightTheme.background);
  });
});

describe('theme drives series colors', () => {
  it('candlestick uses the theme up color for an up candle body', () => {
    const customUp = '#123456';
    const theme: ChartTheme = { ...darkTheme, upColor: customUp };
    const { ctx, rec } = makeCtx();
    getChartType('candlestick').draw(ctx, [data[0]], toY, 8, 1, {}, rc(theme));
    // an up candle (close>open) → at least one fillRect uses the themed up color
    expect(rec.ops.some((o) => o.type === 'fillRect' && o.fillStyle === customUp)).toBe(true);
  });

  it('a per-series style overrides the theme', () => {
    const { ctx, rec } = makeCtx();
    getChartType('candlestick').draw(ctx, [data[0]], toY, 8, 1, { upColor: '#abcdef' }, rc(darkTheme));
    expect(rec.ops.some((o) => o.type === 'fillRect' && o.fillStyle === '#abcdef')).toBe(true);
  });
});

describe('gradient fills', () => {
  it('verticalGradient creates and caches a gradient per context', () => {
    const { ctx, rec } = makeCtx();
    const g1 = verticalGradient(ctx, 400, '#fff', '#0000');
    const g2 = verticalGradient(ctx, 400, '#fff', '#0000'); // same key → cached
    expect(g1).toBe(g2);
    expect(rec.count('createLinearGradient')).toBe(1); // only created once
  });

  it('area renderer fills with a linear gradient', () => {
    const { ctx, rec } = makeCtx();
    getChartType('area').draw(ctx, data, toY, 8, 1, {}, rc(darkTheme));
    expect(rec.count('createLinearGradient')).toBeGreaterThanOrEqual(1);
  });

  it('baseline renderer clips and fills two gradient regions', () => {
    const { ctx, rec } = makeCtx();
    getChartType('baseline').draw(ctx, data, toY, 8, 1, { baseValue: 11 }, rc(darkTheme));
    expect(rec.count('clip')).toBeGreaterThanOrEqual(2); // above + below base
  });
});
