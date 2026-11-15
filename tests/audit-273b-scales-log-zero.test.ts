/**
 * C2 remainder: one bar in view with a low of 0 on a logarithmic axis. The
 * axis cannot place zero, so it has to fit the prices it can place; fitted
 * to [0, 200] in price units it put twelve decades under the data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chart } from '../src/core/chart';
import type { PriceScale } from '../src/scale/price-scale';
import { fakeDocument } from './helpers/fake-dom';

afterEach(() => vi.unstubAllGlobals());

function mount(mode: 'linear' | 'logarithmic', type: 'candlestick' | 'histogram' = 'candlestick'): { chart: Chart; scale: PriceScale } {
  vi.stubGlobal('window', {});
  const doc = fakeDocument();
  const chart = new Chart(doc.createElement('div'), {
    document: doc, pixelRatio: () => 1, shortcuts: false,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
  });
  chart.applySize(800, 600);
  const series = chart.addSeries(type);
  if (type === 'histogram') series.setData(Array.from({ length: 40 }, (_, i) => ({ time: 1_700_000_000 + i * 60, value: 1000 + 100 * i })));
  else series.setData(Array.from({ length: 40 }, (_, i) => {
    const p = 100 + (100 * i) / 39;
    // One print at zero, in view: a bad tick, or a feed's empty bar.
    return { time: 1_700_000_000 + i * 60, open: p, high: p * 1.005, low: i === 20 ? 0 : p * 0.995, close: p };
  }));
  chart.setPriceScaleOptions({ mode });
  return { chart, scale: chart.panes()[0]!.priceScale };
}

describe('a logarithmic axis with a visible low of 0', () => {
  it('fits the lowest positive price in view instead of twelve empty decades', () => {
    const { chart, scale } = mount('logarithmic');
    expect(scale.priceRange().min).toBeGreaterThan(50);
    // The prices that can be placed fill the pane between its margins.
    expect(scale.priceToY(100 * 0.995) - scale.priceToY(200 * 1.005)).toBeGreaterThan(0.75 * scale.height);
    chart.destroy();
  });

  it('fits a histogram standing on zero to its columns', () => {
    const { chart, scale } = mount('logarithmic', 'histogram');
    expect(scale.priceRange().min).toBeGreaterThan(500);
    chart.destroy();
  });

  it('leaves the linear axis fitting the zero as it always did', () => {
    const { chart, scale } = mount('linear');
    expect(scale.priceRange().min).toBeLessThan(0);
    chart.destroy();
  });
});
