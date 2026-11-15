/**
 * The snapshot a native context menu leaves on the clicked pane.
 *
 * With no app menu, a right click composites the pane's base under its overlay
 * and stops overlay repaints, so the browser's "Save image" captures the chart
 * rather than a transparent layer. In 2.7.2 only input reaching the chart
 * itself released it. A menu dismissed by Escape with the pointer left still,
 * or by a click outside the chart, left that pane showing the candles, the
 * last-price tag and the order prices of the right click while ticks went on
 * arriving underneath.
 *
 * What a real browser sends when its menu closes cannot be reproduced here;
 * these drive the release paths the chart owns.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Chart } from '../src/core/chart';
import { fakeDocument, type FakeElement } from './helpers/fake-dom';
import type { Bar } from '../src/model/bar';

type Listener = (e: unknown) => void;

/** A document that records its listeners, as the chart's `document` option. */
function listeningDocument(): Document & { listeners: Map<string, Set<Listener>>; fire(type: string): void } {
  const doc = fakeDocument() as Document & { listeners: Map<string, Set<Listener>>; fire(type: string): void };
  doc.listeners = new Map();
  (doc as unknown as Record<string, unknown>).addEventListener = (type: string, fn: Listener): void => {
    if (!doc.listeners.has(type)) doc.listeners.set(type, new Set());
    doc.listeners.get(type)!.add(fn);
  };
  (doc as unknown as Record<string, unknown>).removeEventListener = (type: string, fn: Listener): void => {
    doc.listeners.get(type)?.delete(fn);
  };
  doc.fire = (type) => { for (const fn of [...doc.listeners.get(type) ?? []]) fn({ type, clientX: 900, clientY: 900 }); };
  return doc;
}

const bars: Bar[] = Array.from({ length: 200 }, (_, i) => ({
  time: 1_700_000_000 + i * 60, open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1, close: 100.05 + i * 0.1,
}));

function mount() {
  vi.stubGlobal('window', {}); // _attachInput bails when window is undefined
  const doc = listeningDocument();
  const el = doc.createElement('div') as unknown as FakeElement;
  const chart = new Chart(el, {
    document: doc, pixelRatio: () => 1, shortcuts: false,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
  });
  chart.applySize(800, 600);
  const series = chart.addSeries('candlestick');
  series.setData(bars);
  const pane = chart.panes()[0]! as unknown as { paintTop: (...a: unknown[]) => void };
  const counts = { top: 0 };
  const paintTop = pane.paintTop.bind(pane);
  pane.paintTop = (...a: unknown[]) => { counts.top++; paintTop(...a); };
  const last = bars[bars.length - 1]!;
  let n = 0;
  /** One live tick on the forming bar. */
  const tick = (): void => { n++; series.update({ ...last, close: last.close + n, high: last.high + n }); };
  /** A right click the chart leaves to the browser, then the pointer leaving for the menu. */
  const rightClick = (): void => {
    el.dispatch('contextmenu', { clientX: 300, clientY: 200, defaultPrevented: false, preventDefault(): void {} });
    el.dispatch('pointerleave', {});
  };
  return { chart, doc, counts, tick, rightClick };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the native context menu snapshot', () => {
  it('holds while the menu can still be open, so Save image captures the chart', () => {
    const m = mount();
    m.rightClick();
    m.counts.top = 0;
    m.tick();
    m.tick();
    expect(m.counts.top).toBe(0);
    m.chart.destroy();
  });

  it('lets go after a bounded time even if nothing reaches the page', () => {
    // Escape with the pointer left still: the menu sends the page nothing.
    const m = mount();
    m.rightClick();
    vi.advanceTimersByTime(10_000);
    m.counts.top = 0;
    m.tick();
    expect(m.counts.top).toBeGreaterThan(0);
    m.chart.destroy();
  });

  it('lets go on the first pointer anywhere on the page', () => {
    // Dismissed by a click outside the chart: the pointer then moves elsewhere.
    for (const type of ['pointermove', 'pointerdown']) {
      const m = mount();
      m.rightClick();
      m.doc.fire(type);
      m.counts.top = 0;
      m.tick();
      expect(m.counts.top, type).toBeGreaterThan(0);
      m.chart.destroy();
    }
  });

  it('lets go when the page is hidden', () => {
    const m = mount();
    m.rightClick();
    m.doc.fire('visibilitychange');
    m.counts.top = 0;
    m.tick();
    expect(m.counts.top).toBeGreaterThan(0);
    m.chart.destroy();
  });

  it('lets go when the pointer comes back over the chart', () => {
    const m = mount();
    m.rightClick();
    (m.chart as unknown as { _onPointerEnter(): void })._onPointerEnter();
    m.counts.top = 0;
    m.tick();
    expect(m.counts.top).toBeGreaterThan(0);
    m.chart.destroy();
  });

  it('leaves no listener and no timer behind', () => {
    const m = mount();
    const before = [...m.doc.listeners.values()].reduce((n, set) => n + set.size, 0);
    m.rightClick();
    m.doc.fire('pointermove');
    expect([...m.doc.listeners.values()].reduce((n, set) => n + set.size, 0)).toBe(before);
    m.rightClick();
    m.chart.destroy();
    const keydown = m.doc.listeners.get('keydown')?.size ?? 0;
    expect([...m.doc.listeners.values()].reduce((n, set) => n + set.size, 0)).toBe(keydown);
    expect(vi.getTimerCount()).toBe(0);
  });
});
