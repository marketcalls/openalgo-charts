/**
 * The chart grid's persisted desk across reloads and tabs (2.7.3): reopening
 * the saved layout keeps the drawings of the instruments the charts are not
 * showing, and a tab that is behind another on the same desk neither writes
 * its older desk over the newer one nor loses the other tab's drawings.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { BarsRequest, DataFeed } from '../src/index';
import '../src/indicators/index';
import { WorkspaceRepository, createMemoryWorkspaceStorage } from '../src/workspace/index';
import { SAVE_DEBOUNCE_MS, type ChartGrid, type ChartGridOptions } from '../src/widget/index';
import { ensureWindowGlobal, fire, fireKey, type FakeDocument, type FakeElement } from './helpers/fake-dom-widget';
import { FakeAsyncStore, settle as microtasks } from './helpers/fake-async-store';
import { MemoryStorage, makeGrid, walk } from './widget-grid-harness';

beforeAll(ensureWindowGlobal);

const feed: DataFeed = { getBars: async (request: BarsRequest) => walk(120, 100 + request.symbol.charCodeAt(0)) };
const settle = async (): Promise<void> => {
  for (let r = 0; r < 4; r++) { await microtasks(); await new Promise(resolve => setTimeout(resolve, 5)); }
};
const quiet = async (): Promise<void> => { await settle(); await new Promise(resolve => setTimeout(resolve, SAVE_DEBOUNCE_MS + 50)); await settle(); };
const measure = (grid: ChartGrid): void => { for (const cell of grid.cells()) cell.widget.chart.applySize(600, 400); };
const line = (grid: ChartGrid, i: number, price: number): void => {
  const w = grid.cells()[i].widget;
  w.draw.add({ tool: 'horizontal-line', paneIndex: 0, style: {}, points: [{ time: w.series.getData()[50].time, price }] });
};
const prices = (grid: ChartGrid, i: number): number[] => grid.cells()[i].widget.draw.drawings().map(d => d.points[0].price);
/** The stored drawings, by chart and instrument, as the prices of their lines. */
const stored = (map: Map<string, string>, ns = 'desk'): Record<string, Record<string, number[]>> => {
  const v = JSON.parse(map.get(`oac-widget:${ns}:grid-drawings`) ?? '{"charts":{}}');
  return Object.fromEntries(Object.entries(v.charts).map(([cell, docs]: [string, any]) =>
    [cell, Object.fromEntries(Object.entries(docs).map(([k, d]: [string, any]) => [k, d.drawings.map((x: any) => x.points[0].price)]))]));
};
const studies = (map: Map<string, string>): number[] =>
  JSON.parse(map.get('oac-widget:desk:grid')!).panes.map((p: any) => (p.chart.indicators ?? []).length);

describe('the saved layout reopened at page load', () => {
  const control = (root: FakeElement): FakeElement => root.querySelector('.oac-grid__bar .oac-grid__saved')!;
  const must = (root: FakeElement, selector: string): FakeElement => {
    const found = root.querySelector(selector);
    if (found === null) throw new Error(`nothing matches ${selector}`);
    return found;
  };
  async function saveAs(root: FakeElement, name: string): Promise<void> {
    control(root).click();
    await settle();
    const menu = must(root, '.oac-grid__overlay .oac-layouts');
    must(menu, '[data-action="save-as"]').click();
    must(menu, '.oac-layouts__input').value = name;
    must(menu, '[data-action="submit-name"]').click();
    await settle();
    fireKey(menu, 'Escape');
  }

  it('keeps the drawings of the instruments a chart is not showing', async () => {
    const storage = new MemoryStorage();
    const account = createMemoryWorkspaceStorage();
    let n = 0;
    const repo = () => new WorkspaceRepository(account, 'desk', { id: () => `layout-${++n}`, now: () => 1000 + n });
    const options: ChartGridOptions = { feed, preset: '1x2', toolbar: true, persist: 'desk', storage };
    const first = makeGrid({ ...options, workspaces: repo() }).grid;
    await first.ready;
    await settle();
    measure(first);
    line(first, 0, 111);
    line(first, 0, 112);
    first.cells()[0].widget.setSymbol('CCC');
    await settle();
    line(first, 0, 333);
    await saveAs(first.root as unknown as FakeElement, 'Desk');
    await quiet();
    first.destroy();
    expect(stored(storage.map)).toEqual({ p0: { 'NSE:AAA': [111, 112], 'NSE:CCC': [333] } });

    const second = makeGrid({ ...options, workspaces: repo() }).grid;
    await second.ready;
    await quiet();
    measure(second);
    expect(second.cells()[0].widget.symbol()).toBe('CCC');
    expect(stored(storage.map)).toEqual({ p0: { 'NSE:AAA': [111, 112], 'NSE:CCC': [333] } });
    second.cells()[0].widget.setSymbol('AAA');
    await settle();
    expect(prices(second, 0)).toEqual([111, 112]);
  });
});

/** An asynchronous store that announces each write once it has landed, as the IndexedDB store does to other tabs. */
class AnnouncingStore extends FakeAsyncStore {
  public override setItem(key: string, value: string): Promise<void> {
    return super.setItem(key, value).then(() => { for (const l of [...this.listeners]) l(key, value); });
  }
  public override removeItem(key: string): Promise<void> {
    return super.removeItem(key).then(() => { for (const l of [...this.listeners]) l(key, null); });
  }
}

describe('two tabs on one desk', () => {
  async function tabs(): Promise<{ store: AnnouncingStore; a: ChartGrid; b: ChartGrid; docB: FakeDocument }> {
    const store = new AnnouncingStore();
    const options: ChartGridOptions = { persist: 'desk', storage: store, feed, preset: '1x2' };
    const a = makeGrid(options).grid;
    await a.ready;
    await quiet();
    const { grid: b, doc: docB } = makeGrid(options);
    await b.ready;
    await quiet();
    measure(a);
    measure(b);
    // What measuring moved is written before either tab is used.
    await quiet();
    return { store, a, b, docB };
  }
  const show = (doc: FakeDocument, state: 'hidden' | 'visible'): void => {
    Object.assign(doc, { visibilityState: state });
    fire(doc, 'visibilitychange');
  };

  it('a tab closed with nothing of its own to save leaves the other tab drawings and studies', async () => {
    const { store, a, b } = await tabs();
    line(a, 0, 111);
    a.cells()[0].widget.chart.addIndicator('sma');
    await quiet();
    expect(stored(store.map)).toEqual({ p0: { 'NSE:AAA': [111] } });
    expect(studies(store.map)).toEqual([1, 0]);
    b.destroy();
    await quiet();
    expect(stored(store.map)).toEqual({ p0: { 'NSE:AAA': [111] } });
    expect(studies(store.map)).toEqual([1, 0]);
  });

  it('a tab that pans or draws elsewhere keeps the drawings another tab made, and shows them', async () => {
    const { store, a, b } = await tabs();
    line(a, 0, 111);
    await quiet();
    // The other tab's line reaches the same chart here.
    expect(prices(b, 0)).toEqual([111]);
    const chart = b.cells()[0].widget.chart;
    const r = chart.getVisibleLogicalRange();
    chart.setVisibleLogicalRange({ from: r.from - 5, to: r.to - 5 });
    chart.emit('pan', {} as never);
    await quiet();
    expect(stored(store.map)).toEqual({ p0: { 'NSE:AAA': [111] } });
    line(b, 1, 222);
    await quiet();
    expect(stored(store.map)).toEqual({ p0: { 'NSE:AAA': [111] }, p1: { 'NSE:AAA': [222] } });
    // And this tab's line reaches the first one.
    expect(prices(a, 1)).toEqual([222]);
    const fresh = makeGrid({ persist: 'desk', storage: store, feed, preset: '1x2' }).grid;
    await fresh.ready;
    await quiet();
    expect([prices(fresh, 0), prices(fresh, 1)]).toEqual([[111], [222]]);
  });

  it('a tab shown again opens the desk another tab saved meanwhile, and writes nothing until it is changed', async () => {
    const { store, a, b, docB } = await tabs();
    show(docB, 'hidden');
    a.setPreset('2x2');
    a.cells()[0].widget.chart.addIndicator('sma');
    line(a, 0, 111);
    await quiet();
    const written = store.writes().length;
    show(docB, 'visible');
    await quiet();
    measure(b);
    expect(b.cells()).toHaveLength(4);
    expect(b.cells()[0].widget.chart.indicators()).toHaveLength(1);
    expect(prices(b, 0)).toEqual([111]);
    expect(store.writes().length).toBe(written);
    const chart = b.cells()[0].widget.chart;
    const r = chart.getVisibleLogicalRange();
    chart.setVisibleLogicalRange({ from: r.from - 5, to: r.to - 5 });
    chart.emit('pan', {} as never);
    await quiet();
    expect(studies(store.map)).toEqual([1, 0, 0, 0]);
    expect(stored(store.map)).toEqual({ p0: { 'NSE:AAA': [111] } });
  });

  it('follows another tab over the page storage as well, from the storage events the page fires', async () => {
    const g = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
    const heard = new Set<(event: unknown) => void>();
    g.addEventListener = (type: string, fn: (event: unknown) => void) => { if (type === 'storage') heard.add(fn); };
    g.removeEventListener = (type: string, fn: (event: unknown) => void) => { if (type === 'storage') heard.delete(fn); };
    try {
      // One localStorage seen from two tabs: a write in one fires the storage event in the other.
      const map = new Map<string, string>();
      const tab = (other: () => unknown) => ({
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { map.set(k, v); for (const fn of [...heard]) fn({ storageArea: other(), key: k, newValue: v }); },
        removeItem: (k: string) => { map.delete(k); for (const fn of [...heard]) fn({ storageArea: other(), key: k, newValue: null }); },
      });
      const tabA: ReturnType<typeof tab> = tab(() => tabB), tabB: ReturnType<typeof tab> = tab(() => tabA);
      const a = makeGrid({ persist: 'desk', storage: tabA, feed, preset: '1x2' }).grid;
      const b = makeGrid({ persist: 'desk', storage: tabB, feed, preset: '1x2' }).grid;
      await quiet();
      measure(a);
      measure(b);
      await quiet();
      line(a, 0, 111);
      await quiet();
      expect(prices(b, 0)).toEqual([111]);
      line(b, 1, 222);
      await quiet();
      expect(stored(map)).toEqual({ p0: { 'NSE:AAA': [111] }, p1: { 'NSE:AAA': [222] } });
      b.destroy();
      a.destroy();
      expect(heard.size).toBe(0);
    } finally {
      delete g.addEventListener;
      delete g.removeEventListener;
    }
  });

  it('a tab opened on the desk writes nothing back until it is changed, so the first need not reopen it', async () => {
    const store = new AnnouncingStore();
    const options: ChartGridOptions = { persist: 'desk', storage: store, feed, preset: '1x2' };
    const { grid: a, doc: docA } = makeGrid(options);
    await a.ready;
    await quiet();
    measure(a);
    await quiet();
    show(docA, 'hidden');
    const before = store.writes().length;
    const b = makeGrid(options).grid;
    await b.ready;
    await quiet();
    measure(b);
    await quiet();
    expect(store.writes().length).toBe(before);
    const chart = a.cells()[0].widget;
    show(docA, 'visible');
    await quiet();
    expect(a.cells()[0].widget).toBe(chart);
  });

  it('still tries a save the store refused once more when the grid goes', async () => {
    class FullStorage extends MemoryStorage {
      public full = false;
      public override setItem(k: string, v: string): void {
        if (this.full) throw new Error('QuotaExceededError');
        super.setItem(k, v);
      }
    }
    const store = new FullStorage();
    const grid = makeGrid({ persist: 'desk', storage: store, feed, preset: '1x2' }).grid;
    await quiet();
    store.full = true;
    grid.cells()[0].widget.setSymbol('CCC');
    await quiet();
    store.full = false;
    grid.destroy();
    expect(JSON.parse(store.map.get('oac-widget:desk:grid')!).panes[0].symbol).toBe('CCC');
  });

  it('a tab behind another writes no window its own bars moved', async () => {
    const { store, a, b, docB } = await tabs();
    show(docB, 'hidden');
    a.cells()[0].widget.chart.addIndicator('sma');
    await quiet();
    const written = store.writes().length;
    // Bars arriving in the hidden tab move its view: that is no change of the user's.
    const chart = b.cells()[0].widget.chart;
    chart.emit('data:update', {} as never);
    chart.emit('pan', {} as never);
    await quiet();
    expect(store.writes().length).toBe(written);
    expect(studies(store.map)).toEqual([1, 0]);
  });
});
