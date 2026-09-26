/**
 * The chart on a screen whose pixel ratio is not 1, or changes.
 *
 * Three things are checked without a browser, with a fake window standing in
 * for the parts the chart asks for:
 *
 * - the pane boxes, their canvases and the rule between them sit on whole
 *   device pixels, so no canvas is stretched by a fraction of a pixel;
 * - a change of ratio re-sizes the canvases, heard through a resolution query
 *   that is made again for each new ratio, or through the window's `resize`;
 * - a resize observed after the frame's animation callbacks, and the one
 *   re-measure after construction, paint before the browser shows the frame
 *   rather than leaving it the cleared canvases for one.
 *
 * The browser half, a real device scale change and real frames during a
 * resize, is in tests/e2e/device-pixels.spec.ts and resize-frames.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/indicators/index';
import { Chart } from '../src/core/chart';
import { darkTheme, lightTheme } from '../src/theme';
import type { Bar } from '../src/model/bar';
import { fakeDocument } from './helpers/fake-dom';

const bars = (n: number): Bar[] => Array.from({ length: n }, (_, i) => {
  const c = 100 + Math.sin(i / 4) * 5;
  return { time: 1_700_000_000 + i * 60, open: c, high: c + 1, low: c - 1, close: c, volume: 10 + i };
});

interface FakeQuery { media: string; listeners: Set<() => void>; addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void }

/** A window with a ratio, resolution queries whose change the test fires, and a `resize` the test fires. */
function fakeView(ratio: number) {
  const queries: FakeQuery[] = [];
  const resize = new Set<() => void>();
  const view = {
    devicePixelRatio: ratio,
    matchMedia(media: string): FakeQuery {
      const query: FakeQuery = {
        media, listeners: new Set(),
        addEventListener(type, fn) { if (type === 'change') this.listeners.add(fn); },
        removeEventListener(type, fn) { if (type === 'change') this.listeners.delete(fn); },
      };
      queries.push(query);
      return query;
    },
    addEventListener(type: string, fn: () => void) { if (type === 'resize') resize.add(fn); },
    removeEventListener(type: string, fn: () => void) { if (type === 'resize') resize.delete(fn); },
  };
  const latest = (): FakeQuery => queries[queries.length - 1];
  const change = (next: number): void => { view.devicePixelRatio = next; for (const fn of [...latest().listeners]) fn(); };
  const resized = (): void => { for (const fn of [...resize]) fn(); };
  return { view, queries, resize, latest, change, resized };
}

/** A frame scheduler the test runs by hand, so "painted now" and "painted next frame" differ. */
function manualFrames() {
  const queue: (() => void)[] = [];
  return {
    raf: { schedule: (cb: () => void) => { queue.push(cb); return queue.length; }, cancel: () => {} },
    run: (): void => { while (queue.length) queue.shift()!(); },
    queue,
  };
}

function chartIn(opts: { ratio?: () => number; view?: object; width?: number; height?: number } = {}) {
  const doc = Object.assign(fakeDocument(), opts.view ? { defaultView: opts.view } : {});
  const el = doc.createElement('div') as unknown as HTMLElement & { clientWidth: number; clientHeight: number };
  el.clientWidth = opts.width ?? 800;
  el.clientHeight = opts.height ?? 600;
  const frames = manualFrames();
  const chart = new Chart(el, { document: doc, pixelRatio: opts.ratio ?? (() => 1), shortcuts: false, raf: frames.raf });
  frames.run();
  return { chart, el, frames };
}

/** The pane heights the DOM boxes are given. */
const heights = (chart: Chart): number[] => chart.panes().map(pane => parseFloat(pane.element.style.flex.split(' ')[2]));
const separator = (chart: Chart, i: number): Record<string, string> =>
  (chart.panes()[i] as unknown as { _separator: { style: Record<string, string> } })._separator.style;
const whole = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-9;

describe('panes on device pixels', () => {
  it('gives every pane box and canvas a whole number of device pixels, and the rule one device pixel', () => {
    const { chart, frames } = chartIn({ ratio: () => 1.5, height: 344 });
    chart.addSeries('candlestick').setData(bars(80));
    chart.addIndicator('rsi');
    chart.addIndicator('macd');
    frames.run();
    const h = heights(chart);
    expect(h).toHaveLength(3);
    // 344 px shared 1 : 0.32 : 0.32 falls inside device pixels at 1.5 everywhere.
    let top = 0;
    for (const [i, height] of h.entries()) {
      expect(whole(top * 1.5), `pane ${i} top ${top}`).toBe(true);
      expect(whole(height * 1.5), `pane ${i} height ${height}`).toBe(true);
      expect(chart.panes()[i].base.element.height).toBe(Math.round(height * 1.5));
      top += height;
    }
    expect(separator(chart, 0).display).toBe('none');
    for (const i of [1, 2]) {
      expect(separator(chart, i).display).toBe('');
      expect(parseFloat(separator(chart, i).height) * 1.5).toBeCloseTo(1, 9);
    }
    // Hit testing reads the same boxes: a price read back at a pane's
    // coordinate is the price that coordinate was made from.
    const y = chart.priceToCoordinate(100, 0)!;
    expect(chart.coordinateToPrice(y, 0)).toBeCloseTo(100, 6);
  });

  it('recolours the rule with the theme, which a frame alone never did', () => {
    const { chart, frames } = chartIn();
    chart.setTheme(darkTheme);
    chart.addSeries('candlestick').setData(bars(40));
    chart.addIndicator('rsi');
    frames.run();
    expect(separator(chart, 1).background).toBe(darkTheme.paneSeparator);
    chart.setTheme(lightTheme);
    expect(separator(chart, 1).background).toBe(lightTheme.paneSeparator);
  });
});

describe('a device pixel ratio that changes', () => {
  it('makes the resolution query again on every change and re-sizes the canvases at the new ratio', () => {
    const w = fakeView(1);
    const { chart, frames } = chartIn({ view: w.view, ratio: () => w.view.devicePixelRatio });
    chart.addSeries('candlestick').setData(bars(40));
    frames.run();
    const pane = chart.panes()[0];
    expect(w.latest().media).toBe('(resolution: 1dppx)');
    expect(pane.base.element.width).toBe(800);
    const paint = vi.spyOn(pane, 'paintBase');

    const first = w.latest();
    w.change(2);
    expect([pane.base.element.width, pane.base.element.height, pane.top.element.width]).toEqual([1600, 1200, 1600]);
    expect(pane.base.pixelRatio).toBe(2);
    // Painted in the change callback, not left cleared until a frame.
    expect(paint).toHaveBeenCalledTimes(1);
    expect(w.latest().media).toBe('(resolution: 2dppx)');
    expect(w.latest().listeners.size).toBe(1);
    expect(first.listeners.size).toBe(0);

    w.change(1.5);
    expect(pane.base.element.width).toBe(1200);
    expect(w.latest().media).toBe('(resolution: 1.5dppx)');
  });

  it('catches a new ratio on the window resize that a zoom fires', () => {
    const w = fakeView(1);
    const { chart, frames } = chartIn({ view: w.view, ratio: () => w.view.devicePixelRatio });
    frames.run();
    const pane = chart.panes()[0];
    const resize = vi.spyOn(pane, 'resize');
    // A resize with the ratio unchanged is the size observer's business, not this one's.
    w.resized();
    expect(resize).not.toHaveBeenCalled();
    w.view.devicePixelRatio = 1.25;
    w.resized();
    expect(pane.base.element.width).toBe(1000);
  });

  it('lets go of the window and the query when destroyed', () => {
    const w = fakeView(1);
    const { chart } = chartIn({ view: w.view, ratio: () => w.view.devicePixelRatio });
    expect(w.resize.size).toBe(1);
    chart.destroy();
    expect(w.resize.size).toBe(0);
    expect(w.latest().listeners.size).toBe(0);
  });
});

describe('sizes observed before the browser paints', () => {
  interface Observer { cb: (entries: unknown[]) => void; observed: Map<unknown, unknown>; disconnected: boolean }
  const observers: Observer[] = [];
  const g = globalThis as unknown as { ResizeObserver?: unknown; ResizeObserverEntry?: unknown };

  function stubObservers(devicePixels: boolean): void {
    observers.length = 0;
    g.ResizeObserver = class {
      private readonly o: Observer;
      constructor(cb: (entries: unknown[]) => void) { this.o = { cb, observed: new Map(), disconnected: false }; observers.push(this.o); }
      observe(target: unknown, options?: unknown): void { this.o.observed.set(target, options); }
      unobserve(target: unknown): void { this.o.observed.delete(target); }
      disconnect(): void { this.o.disconnected = true; this.o.observed.clear(); }
    };
    if (devicePixels) {
      const Entry = class {};
      Object.defineProperty(Entry.prototype, 'devicePixelContentBoxSize', { get: () => undefined });
      g.ResizeObserverEntry = Entry;
    } else delete g.ResizeObserverEntry;
  }

  afterEach(() => {
    delete g.ResizeObserver;
    delete g.ResizeObserverEntry;
  });

  it('paints a resize inside the observer callback, so the frame it lands in is not blank', () => {
    stubObservers(false);
    const { chart, frames } = chartIn();
    chart.addSeries('candlestick').setData(bars(60));
    frames.run();
    const pane = chart.panes()[0];
    const paint = vi.spyOn(pane, 'paintBase');
    observers[0].cb([{ contentRect: { width: 700, height: 500 } }]);
    // The resize cleared the canvas; it is painted again before any frame runs.
    expect(pane.base.element.width).toBe(700);
    expect(paint).toHaveBeenCalledTimes(1);
    // And the frame that was asked for then finds nothing left to do.
    frames.run();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('paints the re-measure after construction in the frame it runs in', () => {
    stubObservers(false);
    const doc = fakeDocument();
    const el = doc.createElement('div') as unknown as HTMLElement & { clientWidth: number; clientHeight: number };
    el.clientWidth = 800;
    el.clientHeight = 600;
    const f = manualFrames();
    const chart = new Chart(el, { document: doc, pixelRatio: () => 1, shortcuts: false, raf: f.raf });
    // Queued by the constructor: its first frame, then the re-measure.
    expect(f.queue).toHaveLength(2);
    f.queue.shift()!();
    // The layout settled after the chart was built.
    el.clientWidth = 900;
    const paint = vi.spyOn(chart.panes()[0], 'paintBase');
    f.queue.shift()!();
    expect(chart.panes()[0].base.element.width).toBe(900);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('sizes each canvas to the device-pixel box the browser reports, and repaints it at once', () => {
    stubObservers(true);
    const { chart, frames } = chartIn();
    chart.addSeries('candlestick').setData(bars(60));
    frames.run();
    const [container, device] = observers;
    expect(container.observed.has(chart.panes()[0].base.element)).toBe(false);
    const pane = chart.panes()[0];
    for (const layer of [pane.base, pane.top]) expect(device.observed.get(layer.element)).toEqual({ box: 'device-pixel-content-box' });

    const paint = vi.spyOn(pane, 'paintBase');
    const entry = (target: unknown, css: [number, number], px: [number, number]) => ({
      target,
      contentBoxSize: [{ inlineSize: css[0], blockSize: css[1] }],
      devicePixelContentBoxSize: [{ inlineSize: px[0], blockSize: px[1] }],
    });
    // Measured before a relayout in the same frame: a box the canvas no longer has.
    device.cb([entry(pane.base.element, [700, 600], [700, 600])]);
    expect(pane.base.element.width).toBe(800);
    expect(paint).not.toHaveBeenCalled();
    // A box the browser snapped a pixel narrower: the store follows it and the pane repaints now.
    device.cb([entry(pane.base.element, [800, 600], [799, 600])]);
    expect(pane.base.element.width).toBe(799);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('follows the panes: a new one is watched, a removed one let go, and all of them on destroy', () => {
    stubObservers(true);
    const { chart, frames } = chartIn();
    chart.addSeries('candlestick').setData(bars(60));
    chart.addIndicator('rsi');
    frames.run();
    const device = observers[1];
    const study = chart.panes()[1];
    expect(device.observed.has(study.base.element)).toBe(true);
    chart.removePane(1);
    expect(device.observed.has(study.base.element)).toBe(false);
    chart.destroy();
    expect(device.disconnected).toBe(true);
  });
});
