import { describe, it, expect } from 'vitest';
import { PriceScale } from '../src/scale/price-scale';
import { Chart } from '../src/core/chart';
import { RecordingContext } from './helpers/fake-ctx';
import type { Bar } from '../src/model/bar';

const bar = (time: number, c: number): Bar => ({ time, open: c, high: c + 2, low: c - 2, close: c, volume: 100 });

function recordingDoc(): Document {
  const make = (tag: string): Record<string, unknown> => {
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(), style: {}, children: [],
      appendChild(c: unknown) { (el.children as unknown[]).push(c); return c; },
      remove() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener() {}, removeEventListener() {},
      setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
    };
    if (tag === 'canvas') {
      el.width = 0; el.height = 0;
      const rec = new RecordingContext();
      el.__rec = rec;
      el.getContext = () => rec as unknown as CanvasRenderingContext2D;
    }
    return el;
  };
  return { createElement: (t: string) => make(t) } as unknown as Document;
}

function makeChart(opts: Record<string, unknown> = {}): Chart {
  const doc = recordingDoc();
  const container = doc.createElement('div') as unknown as Record<string, unknown>;
  container.clientWidth = 800; container.clientHeight = 600;
  return new Chart(container as unknown as HTMLElement, {
    document: doc, pixelRatio: () => 1, raf: { schedule: () => 0, cancel: () => {} }, ...opts,
  });
}

describe('PriceScale custom formatter', () => {
  it('uses toFixed(precision) by default', () => {
    const ps = new PriceScale({ minMove: 0.01 });
    expect(ps.format(123.456)).toBe('123.46');
  });

  it('routes through a custom formatter when set, and null restores default', () => {
    const ps = new PriceScale({ minMove: 0.01 });
    ps.setPriceFormatter((p) => '$' + p.toFixed(2));
    expect(ps.format(123.456)).toBe('$123.46');
    ps.setPriceFormatter(null);
    expect(ps.format(123.456)).toBe('123.46');
  });
});

describe('Chart.priceFormatter option', () => {
  it('applies the formatter to the pane price scale from options', () => {
    const chart = makeChart({ priceFormatter: (p: number) => '$' + p.toFixed(1) });
    chart.addSeries('candlestick').setData([bar(1000, 90), bar(1060, 100)]);
    const ps = chart.panes()[0].priceScale;
    expect(ps.format(100)).toBe('$100.0');
  });

  it('setPriceFormatter updates every pane at runtime and clears with null', () => {
    const chart = makeChart();
    chart.addSeries('candlestick').setData([bar(1000, 90), bar(1060, 100)]);
    chart.addSeries('histogram', { paneIndex: 1 }).setData([{ time: 1000, open: 0, high: 5, low: 0, close: 5 }]);
    chart.setPriceFormatter((p) => p.toFixed(0) + ' pts');
    for (const pane of chart.panes()) expect(pane.priceScale.format(50)).toBe('50 pts');
    chart.setPriceFormatter(null);
    expect(chart.panes()[0].priceScale.format(50)).not.toContain('pts');
  });
});
