/**
 * A logarithmic price axis, driven the way a user drives it. In 2.7.2:
 *
 *  - Dragging the price axis scaled the range around its centre in price
 *    units. On a log scale over 100 to 1000 a 40 px drag sent the minimum
 *    below zero, the log clamp turned that into twelve empty decades, and the
 *    whole chart sat in the top 44 px of a 578 px plot.
 *  - The ladder was the linear one: over 2 to 3000 every label landed in the
 *    top 178 px of 600, the bottom three decades unlabelled.
 *  - The decimals came from the linear span, so a crosshair at 2.35 read "2".
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Chart } from '../src/core/chart';
import { PriceScale } from '../src/scale/price-scale';
import { priceTickCount, AXIS_TAG_HEIGHT } from '../src/render/axis';
import { fakeDocument, pointer, type FakeElement } from './helpers/fake-dom';

afterEach(() => vi.unstubAllGlobals());

/** A measured chart whose container can be driven through its real listeners. */
function mount(mode: 'linear' | 'logarithmic'): { chart: Chart; el: FakeElement; scale: PriceScale } {
  vi.stubGlobal('window', {}); // _attachInput bails when window is undefined
  const doc = fakeDocument();
  const el = doc.createElement('div') as unknown as FakeElement;
  const chart = new Chart(el, {
    document: doc, pixelRatio: () => 1, shortcuts: false,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
  });
  chart.applySize(800, 600);
  // A decade of prices, the reason to use a log scale: 100 rising to 1000.
  chart.addSeries('candlestick').setData(Array.from({ length: 80 }, (_, i) => {
    const p = 100 * Math.pow(10, i / 79);
    return { time: 1_700_000_000 + i * 86400, open: p, high: p * 1.01, low: p * 0.99, close: p };
  }));
  chart.setPriceScaleOptions({ mode });
  return { chart, el, scale: chart.panes()[0]!.priceScale };
}

/** Press on the right price axis, move by `dy`, release. */
function dragAxis(el: FakeElement, dy: number): void {
  el.dispatch('pointerdown', pointer('down', 780, 300));
  el.dispatch('pointermove', pointer('move', 780, 300 + dy));
  el.dispatch('pointerup', pointer('up', 780, 300 + dy));
}

describe('dragging a logarithmic price axis', () => {
  it('scales the decades on screen, the way the linear axis scales its prices', () => {
    const { chart, el, scale } = mount('logarithmic');
    const y0 = [scale.priceToY(100), scale.priceToY(1000)] as const;
    dragAxis(el, 40);
    const y1 = [scale.priceToY(100), scale.priceToY(1000)] as const;
    // Drag down 40 px compresses by exp(40 * 0.005), around the pane's centre.
    // To a twentieth of a pixel: the autoscale glide may still be settling at the press.
    const factor = Math.exp(40 * 0.005);
    expect(y1[0] - y1[1]).toBeCloseTo((y0[0] - y0[1]) / factor, 1);
    expect((y1[0] + y1[1]) / 2).toBeCloseTo((y0[0] + y0[1]) / 2, 1);
    expect(scale.priceRange().min).toBeGreaterThan(0);
    chart.destroy();
  });

  it('never takes the minimum to zero or below, however far it is dragged', () => {
    const { chart, el, scale } = mount('logarithmic');
    for (const dy of [80, 200, 400]) {
      dragAxis(el, dy);
      const { min, max } = scale.priceRange();
      expect(min, `dy ${dy}`).toBeGreaterThan(0);
      expect(Number.isFinite(max) && max > min, `dy ${dy}`).toBe(true);
      // The data stays on the plot: what the user is looking at is shrunk, not thrown away.
      expect(scale.priceToY(100), `dy ${dy}`).toBeLessThan(scale.height);
      expect(scale.priceToY(1000), `dy ${dy}`).toBeGreaterThan(0);
      for (const p of scale.ticks(priceTickCount(scale.height))) expect(p, `dy ${dy}`).toBeGreaterThan(0);
    }
    chart.destroy();
  });

  it('leaves the linear drag where it was', () => {
    const { chart, el, scale } = mount('linear');
    const { min, max } = scale.priceRange();
    dragAxis(el, 40);
    const centre = (min + max) / 2, half = ((max - min) / 2) * Math.exp(40 * 0.005);
    expect(scale.priceRange()).toEqual({ min: centre - half, max: centre + half });
    expect(scale.autoScale).toBe(false);
    chart.destroy();
  });

  it('scales a log range around its centre in log space when asked directly', () => {
    const s = new PriceScale({ mode: 'logarithmic' });
    s.setHeight(400);
    s.setPriceRange({ min: 100, max: 1000 });
    s.scaleAroundCenter(Math.exp(0.2));
    const { min, max } = s.priceRange();
    expect(min).toBeGreaterThan(0);
    expect(Math.log10(min) + Math.log10(max)).toBeCloseTo(5, 9);
    expect(Math.log10(max) - Math.log10(min)).toBeCloseTo(Math.exp(0.2), 9);
  });
});

/** A log scale over `lo..hi` on a `height` px pane, autoscaled as a pane does it. */
function logScale(lo: number, hi: number, height = 600, minMove = 0): PriceScale {
  const s = new PriceScale({ mode: 'logarithmic', minMove });
  s.setHeight(height);
  s.autoscale(lo, hi);
  return s;
}

describe('the logarithmic ladder', () => {
  it('spreads its rungs through every decade on screen', () => {
    const s = logScale(2, 3000);
    const rungs = s.ticks(priceTickCount(600));
    for (const decade of [1, 10, 100, 1000]) {
      expect(rungs.some((p) => p >= decade && p < decade * 10), `${decade}: ${rungs.join(' ')}`).toBe(true);
    }
    // The bottom of the pane is labelled too, not only the top quarter.
    expect(Math.max(...rungs.map((p) => s.priceToY(p)))).toBeGreaterThan(450);
  });

  it('keeps its labels apart where a linear ladder crowds them', () => {
    for (const [lo, hi] of [[2, 3000], [100, 1000], [100, 300], [0.5, 4000]] as const) {
      const s = logScale(lo, hi);
      const ys = s.ticks(priceTickCount(600)).map((p) => s.priceToY(p)).sort((a, b) => a - b);
      expect(ys.length, `${lo}..${hi}`).toBeGreaterThan(2);
      for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!, `${lo}..${hi}`).toBeGreaterThanOrEqual(AXIS_TAG_HEIGHT);
    }
  });

  it('labels every rung with its own price', () => {
    for (const [lo, hi] of [[2, 3000], [100, 1000], [95, 105]] as const) {
      const s = logScale(lo, hi);
      const rungs = s.ticks(priceTickCount(600));
      const labels = rungs.map((p) => s.format(p));
      expect(new Set(labels).size).toBe(labels.length);
      rungs.forEach((p, i) => expect(Number(labels[i])).toBeCloseTo(p, 9));
    }
  });

  it('keeps every rung on a declared tick', () => {
    const s = logScale(2, 3000, 600, 0.05);
    for (const p of s.ticks(priceTickCount(600))) {
      expect(Math.abs(p / 0.05 - Math.round(p / 0.05))).toBeLessThan(1e-6);
      expect(Number(s.format(p))).toBeCloseTo(p, 9);
    }
  });

  it('returns on ranges a slot cannot resolve, a tick wider than the range included', () => {
    // A rung rounded to nothing once left a zero-width window, and the search
    // for its roundest price never ended: the frame would have hung.
    const cases: [number, number, number, number][] = [
      [1e-9, 2e-9, 90, 1], [1e-9, 2e-9, 600, 0.05], [1e-320, 1e-300, 600, 0], [1e300, 1.7e308, 600, 0], [5, 5.000001, 600, 1],
    ];
    for (const [lo, hi, h, tick] of cases) {
      const s = new PriceScale({ mode: 'logarithmic', minMove: tick });
      s.setHeight(h);
      s.setPriceRange({ min: lo, max: hi });
      const rungs = s.ticks(priceTickCount(h));
      expect(rungs.length, `${lo}..${hi}`).toBeLessThanOrEqual(priceTickCount(h));
      for (const p of rungs) expect(p > 0 && Number.isFinite(p), `${lo}..${hi}: ${p}`).toBe(true);
    }
  });

  it('prints the low end with the decimals it needs', () => {
    expect(logScale(2, 3000).format(2.35)).toBe('2.35');
  });

  it('keeps a narrow log range on the ladder a linear axis gives it', () => {
    // A tenth of a decade is close to linear, so the round ladder carries over.
    const lin = new PriceScale();
    lin.setHeight(400);
    lin.setPriceRange({ min: 90, max: 110 });
    const log = new PriceScale({ mode: 'logarithmic' });
    log.setHeight(400);
    log.setPriceRange({ min: 90, max: 110 });
    expect(log.ticks(6)).toEqual(lin.ticks(6));
    expect(log.format(100.05)).toBe(lin.format(100.05));
  });
});
