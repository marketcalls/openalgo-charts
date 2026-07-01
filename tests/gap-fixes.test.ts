import { describe, it, expect } from 'vitest';
import { FakeDataFeed } from '../src/feed/fake-feed';
import { Chart } from '../src/core/chart';
import { RecordingContext } from './helpers/fake-ctx';
import type { Bar } from '../src/model/bar';

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
      el.getContext = () => new RecordingContext() as unknown as CanvasRenderingContext2D;
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
const bar = (time: number, c: number): Bar => ({ time, open: c, high: c + 2, low: c - 2, close: c, volume: 100 });

describe('FakeDataFeed.subscribeBars streams (not a silent no-op)', () => {
  it('emits deterministic advancing bars on the injected scheduler and stops on unsubscribe', () => {
    let fire: (() => void) | null = null;
    let cleared = false;
    const scheduler = (cb: () => void): (() => void) => { fire = cb; return () => { cleared = true; fire = null; }; };
    const feed = new FakeDataFeed(60, scheduler);
    const bars: Bar[] = [];
    const off = feed.subscribeBars!({ symbol: 'X', exchange: 'NSE', interval: '1m', from: 1000 }, (b) => bars.push(b));
    fire!(); fire!(); fire!();
    expect(bars).toHaveLength(3);
    expect(bars[1].time - bars[0].time).toBe(60); // advances by the interval
    expect(bars.every((b) => b.high >= b.close && b.low <= b.close)).toBe(true);
    off();
    expect(cleared).toBe(true);
  });
});

describe('ChartOptions.priceScale applies per pane', () => {
  it('seeds every pane price scale with the given options', () => {
    const chart = makeChart({ priceScale: { mode: 'logarithmic', inverted: true, minMove: 0.05 } });
    chart.addSeries('candlestick').setData([bar(1000, 90), bar(1060, 100)]);
    chart.addSeries('histogram', { paneIndex: 1 }).setData([{ time: 1000, open: 0, high: 5, low: 0, close: 5 }]);
    for (const pane of chart.panes()) {
      expect(pane.priceScale.options.mode).toBe('logarithmic');
      expect(pane.priceScale.options.inverted).toBe(true);
      expect(pane.priceScale.options.minMove).toBe(0.05);
    }
  });
});
