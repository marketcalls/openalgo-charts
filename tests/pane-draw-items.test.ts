/**
 * The series pass allocates nothing per bar (src/render/draw-items.ts): every
 * frame of a pan used to build a `{ index, bar }` pair and a `{ x, bar }` item
 * for each visible bar of each series, all of it garbage by the next frame.
 *
 * What is pinned here: the items a backend receives are the same array and the
 * same objects from one frame to the next, rewritten in place; the in-place
 * walk finds exactly the bars `DataLayer.visibleBars` returns; and the one
 * per-frame field that is set only sometimes (`prevClose`) never survives into
 * a frame that did not set it.
 */
import { describe, expect, it } from 'vitest';
import { Chart } from '../src/core/chart';
import { InvalidationLevel } from '../src/core/invalidate-mask';
import { Canvas2dBackend } from '../src/render/canvas2d-backend';
import type { IRenderBackend } from '../src/render/backend';
import type { DrawItem, RendererEntry, SeriesRenderContext } from '../src/model/chart-type-registry';
import type { SeriesStyle } from '../src/render/series-style';
import { DataLayer } from '../src/model/data-layer';
import { visibleSpan, type VisibleSpan } from '../src/render/draw-items';
import type { Bar } from '../src/model/bar';
import { isNewIstDayCount } from '../src/render/axis';
import { isNewIstDay } from '../src/feed/time';
import { fakeDocument } from './helpers/fake-dom';

/** The 2D backend, holding on to exactly what each series pass was handed. */
class Holder implements IRenderBackend {
  public readonly kind = 'canvas2d' as const;
  public frames: { items: readonly DrawItem[]; objects: DrawItem[]; xs: number[]; bars: Bar[] }[] = [];
  private readonly _inner = new Canvas2dBackend();
  public mount(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D | null): void { this._inner.mount(canvas, ctx); }
  public resize(w: number, h: number, dpr: number): void { this._inner.resize(w, h, dpr); }
  public beginFrame(clear: boolean): void { this._inner.beginFrame(clear); }
  public drawSeries(
    entry: RendererEntry, items: readonly DrawItem[], priceToY: (p: number) => number,
    barSpacing: number, dpr: number, style: SeriesStyle, rc: SeriesRenderContext,
  ): void {
    this.frames.push({ items, objects: [...items], xs: items.map((it) => it.x), bars: items.map((it) => it.bar) });
    this._inner.drawSeries(entry, items, priceToY, barSpacing, dpr, style, rc);
  }
  public endFrame(): void { this._inner.endFrame(); }
  public overlay2d(): CanvasRenderingContext2D | null { return this._inner.overlay2d(); }
  public destroy(): void { this._inner.destroy(); }
}

const bars = (count: number): Bar[] => Array.from({ length: count }, (_, i) => {
  const c = 100 + Math.sin(i / 7) * 5;
  return { time: 1_700_000_000 + i * 60, open: c - 0.4, high: c + 1, low: c - 1, close: c, volume: 100 + i };
});

function rig(options: { minBarSpacing?: number } = {}): { chart: Chart; holder: () => Holder; paint: () => void } {
  const doc = fakeDocument();
  const holders: Holder[] = [];
  const chart = new Chart(doc.createElement('div'), {
    document: doc, pixelRatio: () => 1, shortcuts: false, timeNavigator: false,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
    renderBackend: () => { const h = new Holder(); holders.push(h); return h; },
    ...(options.minBarSpacing === undefined ? {} : { timeScale: { minBarSpacing: options.minBarSpacing } }),
  });
  chart.applySize(800, 500);
  return { chart, holder: () => holders[0], paint: () => chart.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full)) };
}

describe('the draw items a series hands its renderer', () => {
  it('are the same array and the same objects every frame, rewritten in place', () => {
    const { chart, holder, paint } = rig();
    const series = chart.addSeries('candlestick');
    const data = bars(2000);
    series.setData(data);
    chart.timeScale.setBarSpacing(6);
    paint();
    const first = holder().frames[holder().frames.length - 1];
    expect(first.items.length).toBeGreaterThan(50);
    // Pan by five bars: the same bars no longer sit at the same place.
    chart.timeScale.setRightOffset(chart.timeScale.rightOffset - 5);
    paint();
    const second = holder().frames[holder().frames.length - 1];
    expect(second.items).toBe(first.items);
    const shared = Math.min(first.objects.length, second.objects.length);
    for (let i = 0; i < shared; i++) expect(second.objects[i]).toBe(first.objects[i]);
    // The contents did change, and match what a fresh build would hold.
    expect(second.bars).not.toEqual(first.bars);
    for (let i = 0; i < second.items.length; i++) {
      const index = chart.dataLayer.timeToIndex(second.bars[i].time) as number;
      expect(second.xs[i]).toBeCloseTo(chart.timeScale.indexToX(index), 9);
    }
    chart.destroy();
  });

  it('reuses the merged sticks too, below the level-of-detail threshold', () => {
    const { chart, holder, paint } = rig({ minBarSpacing: 0.01 });
    chart.addSeries('candlestick').setData(bars(20_000));
    chart.timeScale.setBarSpacing(0.25);
    paint();
    const first = holder().frames[holder().frames.length - 1];
    chart.timeScale.setRightOffset(chart.timeScale.rightOffset - 40);
    paint();
    const second = holder().frames[holder().frames.length - 1];
    expect(second.items).toBe(first.items);
    expect(second.items.length).toBeGreaterThan(100);
    const shared = Math.min(first.bars.length, second.bars.length);
    for (let i = 0; i < shared; i++) expect(second.bars[i]).toBe(first.bars[i]);
    chart.destroy();
  });

  it('shrinks with the view and lets go of the bars it no longer shows', () => {
    const { chart, holder, paint } = rig();
    chart.addSeries('candlestick').setData(bars(2000));
    chart.timeScale.setBarSpacing(2);
    paint();
    const wide = holder().frames[holder().frames.length - 1];
    const dropped = wide.objects[wide.objects.length - 1];
    chart.timeScale.setBarSpacing(20);
    paint();
    const narrow = holder().frames[holder().frames.length - 1];
    expect(narrow.items).toBe(wide.items);
    expect(narrow.items.length).toBeLessThan(wide.objects.length / 5);
    // The item past the end no longer holds a bar of the series.
    expect(Number.isNaN(dropped.bar.close)).toBe(true);
    chart.destroy();
  });

  it('carries the previous close only on a frame that asked for it', () => {
    const { chart, holder, paint } = rig();
    const series = chart.addSeries('candlestick', { style: { colorByPreviousClose: true } });
    const data = bars(500);
    series.setData(data);
    chart.timeScale.setBarSpacing(8);
    chart.timeScale.setRightOffset(-100);
    paint();
    const on = holder().frames[holder().frames.length - 1];
    const firstTime = on.bars[0].time;
    const before = data[data.findIndex((b) => b.time === firstTime) - 1];
    expect(on.objects[0].prevClose).toBe(before.close);
    series.applyOptions({ colorByPreviousClose: false });
    paint();
    const off = holder().frames[holder().frames.length - 1];
    expect(off.objects[0]).toBe(on.objects[0]);
    expect(off.objects[0].prevClose).toBeUndefined();
    chart.destroy();
  });
});

describe('visibleSpan', () => {
  /** Walk the span the way the pane does and return what `visibleBars` would. */
  function walk(layer: DataLayer, id: number, from: number, to: number): { index: number; bar: Bar }[] {
    const series = layer.seriesBars(id);
    const span: VisibleSpan = { start: 0, lastTime: 0 };
    const out: { index: number; bar: Bar }[] = [];
    if (!visibleSpan(layer, series, from, to, span)) return out;
    for (let i = span.start; i < series.length; i++) {
      if (series[i].time > span.lastTime) break;
      const index = layer.timeToIndex(series[i].time);
      if (index !== undefined) out.push({ index, bar: series[i] });
    }
    return out;
  }

  it('finds exactly the bars visibleBars returns, for sparse and gapped series at any range', () => {
    let s = 99;
    const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296);
    const layer = new DataLayer();
    const dense = layer.createSeries();
    const sparse = layer.createSeries();
    const gapped = layer.createSeries();
    const empty = layer.createSeries();
    const all = bars(600);
    layer.setSeriesData(dense, all);
    layer.setSeriesData(sparse, all.filter((_, i) => i % 7 === 3 || i > 590));
    layer.setSeriesData(gapped, all.map((b, i) => (i % 11 < 3 ? { ...b, open: NaN, high: NaN, low: NaN, close: NaN } : b)));
    layer.setSeriesData(empty, []);
    for (let trial = 0; trial < 400; trial++) {
      const from = rnd() * 700 - 50;
      const to = from + rnd() * 300 - 20;
      for (const id of [dense, sparse, gapped, empty]) {
        expect(walk(layer, id, from, to), `series ${id} [${from}, ${to}]`).toEqual(layer.visibleBars(id, from, to));
      }
    }
  });
});

/**
 * The time axis asks whether a day turned over between every pair of bars in
 * view, every frame; it answers by day count now rather than through two
 * dates and two part objects per call, and must answer the same.
 */
describe('the time axis day test', () => {
  it('agrees with isNewIstDay at every instant, midnights and the far past included', () => {
    let s = 5;
    const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296);
    const istMidnight = 1_700_000_000 - ((1_700_000_000 + 19_800) % 86_400);
    const cases: [number, number][] = [
      [istMidnight - 1, istMidnight], [istMidnight, istMidnight + 1], [istMidnight - 0.5, istMidnight + 0.25],
      [-86_400 * 3 - 19_800 - 1, -86_400 * 3 - 19_800], [-1, 0], [0, 1], [NaN, 5], [5, NaN],
    ];
    for (let i = 0; i < 20_000; i++) {
      const a = (rnd() - 0.3) * 4e9;
      cases.push([a, a + Math.floor(rnd() * 200_000)]);
    }
    for (const [a, b] of cases) expect(isNewIstDayCount(a, b), `${a} -> ${b}`).toBe(isNewIstDay(a, b));
  });
});
