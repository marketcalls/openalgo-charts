/**
 * Saved work the widget keeps beside its chart: the per-instrument drawing
 * documents, the persisted layout and the drawings a link group shares. Each
 * case is a way that work was lost or misplaced in 2.7.2: a second tab on
 * the same instrument writing its drawings whole, an older layout replacing
 * newer drawings, a refused layout overwritten by the next autosave, a study
 * pane removed while another instrument was on screen, and a link member
 * added without a context source forgetting its instrument on `symbol`.
 * Runs against the fake DOM with measured charts and a synchronous raf.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerIndicator, type Bar } from '../src/index';
import { createDrawingLinkGroup, type DrawingInput } from '../src/draw/index';
import { WorkspaceRepository, createMemoryWorkspaceStorage } from '../src/workspace/index';
import {
  createWidget, DRAWINGS_KEY_PREFIX, SAVE_DEBOUNCE_MS, STATE_KEY, STORAGE_PREFIX,
  type StorageLike, type Widget, type WidgetOptions,
} from '../src/widget/index';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument, type FakeElement } from './helpers/fake-dom-widget';
import { FakeAsyncStore, settle } from './helpers/fake-async-store';

beforeAll(ensureWindowGlobal);
beforeAll(() => {
  for (const id of ['saved-osc', 'saved-osc-b']) {
    registerIndicator({
      id, name: 'Saved oscillator', placement: 'pane',
      inputs: [{ key: 'length', type: 'number', label: 'Length', default: 5 }],
      plots: [{ key: 'v', title: 'Value', type: 'line' }],
      calc: b => ({ v: b.map(x => x.close - x.open) }),
    });
  }
});

const T0 = 1_700_000_000;
const bars = (n = 40): Bar[] => Array.from({ length: n }, (_, i) => {
  const c = 100 + Math.sin(i / 4) * 5;
  return { time: T0 + i * 60, open: c - 1, high: c + 2, low: c - 2, close: c };
});
const line = (price: number, extra: Partial<DrawingInput> = {}): DrawingInput => ({
  tool: 'horizontal-line', paneIndex: 0, style: {}, points: [{ time: T0 + 10 * 60, price }], ...extra,
});
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

class MemoryStorage implements StorageLike {
  public readonly map = new Map<string, string>();
  public getItem(k: string): string | null { return this.map.get(k) ?? null; }
  public setItem(k: string, v: string): void { this.map.set(k, v); }
  public removeItem(k: string): void { this.map.delete(k); }
}

/** As storage-idb.ts does: each write that lands is announced to every listener, this page's and other tabs'. */
class AnnouncingStore extends FakeAsyncStore {
  public override setItem(key: string, value: string): Promise<void> {
    return super.setItem(key, value).then(() => { for (const l of [...this.listeners]) l(key, value); });
  }
  public override removeItem(key: string): Promise<void> {
    return super.removeItem(key).then(() => { for (const l of [...this.listeners]) l(key, null); });
  }
}

const widgets: Widget[] = [];
afterEach(() => { for (const w of widgets.splice(0)) if (!w.isDestroyed) w.destroy(); });

function make(opts: WidgetOptions = {}): Widget {
  const doc = fakeWidgetDocument();
  const w = createWidget(fakeContainer(doc, 800, 600) as unknown as HTMLElement, {
    document: doc as unknown as Document, pixelRatio: () => 1, panels: false, mobile: 'never',
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
    symbol: 'AAA', exchange: 'NSE', ...opts,
  });
  w.chart.applySize(800, 600);
  w.series.setData(bars());
  widgets.push(w);
  return w;
}

function show(w: Widget, symbol: string): void {
  w.setSymbol(symbol);
  w.series.setData(bars());
}

const prices = (w: Widget): number[] => w.draw.drawings().map(d => d.points[0].price);
const storedDoc = (store: { map: Map<string, string> }, ns: string, key: string): { drawings: Array<{ id: string; paneIndex: number; points: Array<{ price: number }> }> } | null => {
  const text = store.map.get(`${STORAGE_PREFIX}${ns}:${DRAWINGS_KEY_PREFIX}${key}`);
  return text === undefined ? null : JSON.parse(text);
};
const storedPrices = (store: { map: Map<string, string> }, ns: string, key: string): number[] =>
  (storedDoc(store, ns, key)?.drawings ?? []).map(d => d.points[0].price);
const where = (w: Widget): string[] => w.draw.drawings().map(d => `${d.id}@${d.paneIndex}`).sort();

describe('D2: two writers on one instrument', () => {
  it('keeps the drawing another tab saved when this one saves its own, over a synchronous store', () => {
    const store = new MemoryStorage();
    const a = make({ persist: 'desk', storage: store });
    const b = make({ persist: 'desk', storage: store });
    a.draw.add(line(101));
    b.draw.add(line(202));
    expect(storedPrices(store, 'desk', 'NSE:AAA').sort()).toEqual([101, 202]);
    const fresh = make({ persist: 'desk', storage: store });
    expect(prices(fresh).sort()).toEqual([101, 202]);
  });

  it('keeps the drawing another tab saved when this one saves its own, over a store that announces writes', async () => {
    const store = new AnnouncingStore();
    const a = make({ persist: 'desk', storage: store });
    const b = make({ persist: 'desk', storage: store });
    await a.ready; await b.ready; await settle();
    a.series.setData(bars()); b.series.setData(bars());
    a.draw.add(line(101));
    await a.context.storage.flush(); await settle();
    b.draw.add(line(202));
    await b.context.storage.flush(); await settle();
    expect(JSON.parse(store.map.get('oac-widget:desk:drawings:NSE:AAA')!).drawings.map((d: { points: Array<{ price: number }> }) => d.points[0].price).sort())
      .toEqual([101, 202]);
  });

  it('keeps the deletion another tab made when this one edits after it', () => {
    const store = new MemoryStorage();
    const a = make({ persist: 'desk', storage: store });
    const kept = a.draw.add(line(101));
    const b = make({ persist: 'desk', storage: store });
    expect(prices(b)).toEqual([101]);
    a.draw.remove(kept.id);
    expect(storedDoc(store, 'desk', 'NSE:AAA')).toBeNull();
    b.draw.add(line(202));
    expect(storedPrices(store, 'desk', 'NSE:AAA')).toEqual([202]);
  });

  /** A widget on a document with a window, and the page going away. */
  function leaving(store: StorageLike): { w: Widget; pagehide: () => void } {
    const doc = fakeWidgetDocument();
    const listeners = new Map<string, Set<() => void>>();
    (doc as unknown as { defaultView: unknown }).defaultView = {
      addEventListener: (type: string, fn: () => void) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)); },
      removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
    };
    const w = createWidget(fakeContainer(doc, 800, 600) as unknown as HTMLElement, {
      document: doc as unknown as Document, pixelRatio: () => 1, panels: false, mobile: 'never',
      raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} }, persist: 'desk', storage: store,
      symbol: 'AAA', exchange: 'NSE',
    });
    w.chart.applySize(800, 600);
    w.series.setData(bars());
    widgets.push(w);
    return { w, pagehide: () => { for (const fn of [...(listeners.get('pagehide') ?? [])]) fn(); } };
  }
  const layoutKey = `${STORAGE_PREFIX}desk:${STATE_KEY}`;

  it('does not write its older layout over a newer one when the page goes away with nothing pending', async () => {
    const store = new MemoryStorage();
    const { w: stale, pagehide } = leaving(store);
    await wait(SAVE_DEBOUNCE_MS * 2);
    // Another tab on the same namespace saves a layout with a study.
    const other = make({ persist: 'desk', storage: store });
    other.chart.addIndicator('saved-osc');
    other.destroy();
    expect(JSON.parse(store.map.get(layoutKey)!).chart.indicators).toHaveLength(1);
    pagehide();
    expect(JSON.parse(store.map.get(layoutKey)!).chart.indicators).toHaveLength(1);
    stale.destroy();
    expect(JSON.parse(store.map.get(layoutKey)!).chart.indicators).toHaveLength(1);
  });

  it('still writes its view when the page goes away and no other tab has stored a layout since', async () => {
    const store = new MemoryStorage();
    const { w, pagehide } = leaving(store);
    w.chart.addIndicator('saved-osc');
    await wait(SAVE_DEBOUNCE_MS * 2);
    const before = JSON.parse(store.map.get(layoutKey)!).chart.viewport;
    // A scroll schedules no save of its own.
    w.chart.setVisibleLogicalRange({ from: 5, to: 25 });
    expect(w.getState().chart.viewport).not.toEqual(before);
    pagehide();
    expect(JSON.parse(store.map.get(layoutKey)!).chart.viewport).toEqual(w.getState().chart.viewport);
  });
});

describe('D3: a saved layout and the newer drawings of its instrument', () => {
  it('keeps the drawings drawn since a layout was saved when that layout opens again', async () => {
    const storage = new MemoryStorage();
    let n = 0;
    const repo = new WorkspaceRepository(createMemoryWorkspaceStorage(), 'acct', { id: () => `layout-${++n}`, now: () => 1000 + n });
    await repo.setAutosave(true);
    const w = make({ persist: 'w', storage, workspaces: repo, symbol: 'NIFTY' });
    await wait(10);
    const layouts = w.layouts!;
    w.draw.add(line(100));
    await layouts.saveAs('Swing');
    await layouts.saveAs('Intraday');
    w.draw.add(line(101)); w.draw.add(line(102)); w.draw.add(line(103));
    await layouts.flush();
    show(w, 'BANKNIFTY');
    w.draw.add(line(500));
    await layouts.flush();
    const swing = (await repo.load()).workspaces.find(x => x.name === 'Swing')!;
    expect((await layouts.open(swing.id)).applied).toBe(true);
    w.series.setData(bars());
    expect(w.symbol()).toBe('NIFTY');
    expect(prices(w)).toEqual([100, 101, 102, 103]);
    expect(storedPrices(storage, 'w', 'NSE:NIFTY')).toEqual([100, 101, 102, 103]);
    expect(storedPrices(storage, 'w', 'NSE:BANKNIFTY')).toEqual([500]);
  });

  it('keeps the drawings drawn since the last save when the active layout reopens on a reload', async () => {
    const storage = new MemoryStorage();
    const account = createMemoryWorkspaceStorage();
    let n = 0;
    const repo = (): WorkspaceRepository => new WorkspaceRepository(account, 'acct', { id: () => `layout-${++n}`, now: () => 1000 + n });
    const w = make({ persist: 'w', storage, workspaces: repo(), symbol: 'NIFTY' });
    await wait(10);
    w.draw.add(line(100));
    await w.layouts!.saveAs('Swing');
    w.draw.add(line(101)); w.draw.add(line(102));
    w.destroy();
    const again = make({ persist: 'w', storage, workspaces: repo(), symbol: 'NIFTY' });
    await wait(10); await wait(10);
    again.series.setData(bars());
    expect(prices(again)).toEqual([100, 101, 102]);
    expect(storedPrices(storage, 'w', 'NSE:NIFTY')).toEqual([100, 101, 102]);
  });

  it('seeds an instrument with nothing stored from the layout, and deletes nothing for a state with no drawings', () => {
    const w = make();
    w.draw.add(line(101));
    show(w, 'BBB');
    const state = w.getState();
    // A layout for AAA with no drawings field: AAA keeps its own.
    const bare = { ...state, symbol: 'AAA', chart: { ...state.chart } } as Record<string, unknown> & { chart: Record<string, unknown> };
    delete bare.chart.drawings;
    expect(w.restoreState(bare).applied).toBe(true);
    w.series.setData(bars());
    expect(prices(w)).toEqual([101]);
    // A layout for CCC, which has nothing stored, brings its drawings there.
    const seeded = { ...state, symbol: 'CCC', chart: { ...state.chart, drawings: { version: 2, drawings: [{ ...line(303), id: 'seed', zIndex: 0 }] } } };
    expect(w.restoreState(seeded).applied).toBe(true);
    w.series.setData(bars());
    expect(prices(w)).toEqual([303]);
  });
});

describe('D4: a persisted layout this page cannot restore in full', () => {
  it('keeps a stored layout whose study is not registered, idle and after a change', async () => {
    const store = new MemoryStorage();
    const first = make({ persist: 'p', storage: store });
    first.chart.addIndicator('saved-osc', { length: 9 });
    first.destroy();
    const key = `${STORAGE_PREFIX}p:${STATE_KEY}`;
    store.map.set(key, store.map.get(key)!.replace(/saved-osc/g, 'saved-osc-later'));
    const studies = (): string[] => JSON.parse(store.map.get(key)!).chart.indicators.map((i: { indicatorId: string }) => i.indicatorId);
    const second = make({ persist: 'p', storage: store });
    const toast = (second.root as unknown as FakeElement).querySelector('.oac-toast__msg')?.textContent;
    expect(toast).toMatch(/saved-osc-later/);
    await wait(SAVE_DEBOUNCE_MS + 100);
    expect(studies()).toEqual(['saved-osc-later']);
    second.setInterval('5m');
    await wait(SAVE_DEBOUNCE_MS + 100);
    second.destroy();
    expect(studies()).toEqual(['saved-osc-later']);
  });

  it('keeps a stored layout it refused over an asynchronous store after a change', async () => {
    const sync = new MemoryStorage();
    const first = make({ persist: 'p', storage: sync });
    first.chart.addIndicator('saved-osc');
    first.destroy();
    const key = `${STORAGE_PREFIX}p:${STATE_KEY}`;
    const refused = JSON.stringify({ ...JSON.parse(sync.map.get(key)!), chart: { version: 99 } });
    const store = new FakeAsyncStore();
    store.map.set(key, refused);
    const second = make({ persist: 'p', storage: store });
    await second.ready; await settle();
    second.setInterval('5m');
    await wait(SAVE_DEBOUNCE_MS + 100);
    await second.context.storage.flush(); await settle();
    expect(store.map.get(key)).toBe(refused);
  });

  it('saves again once the host restores a layout of its own', async () => {
    const store = new MemoryStorage();
    const key = `${STORAGE_PREFIX}p:${STATE_KEY}`;
    store.map.set(key, JSON.stringify({ version: 1, symbol: 'AAA', exchange: 'NSE', interval: '1d', chartType: 'candlestick',
      theme: 'dark', rail: null, chart: { version: 99 } }));
    const w = make({ persist: 'p', storage: store });
    const fresh = make();
    expect(w.restoreState(fresh.getState()).applied).toBe(true);
    w.setInterval('5m');
    await wait(SAVE_DEBOUNCE_MS + 100);
    expect(JSON.parse(store.map.get(key)!).interval).toBe('5m');
  });
});

describe('D5: study panes removed while another instrument is on screen', () => {
  async function seeded(store: MemoryStorage): Promise<Widget> {
    const w = make({ persist: 'w', storage: store });
    const first = w.chart.addIndicator('saved-osc');
    const second = w.chart.addIndicator('saved-osc-b');
    await settle();
    w.draw.add({ ...line(70), id: 'on-first', paneIndex: first.paneIndex });
    w.draw.add({ ...line(0), id: 'on-second', paneIndex: second.paneIndex });
    w.draw.add({ ...line(101), id: 'on-price' });
    show(w, 'BBB');
    await settle();
    w.chart.removeIndicator(first.id);
    await settle();
    expect(w.chart.panes()).toHaveLength(2);
    return w;
  }

  it('puts the drawings of the instrument shown next on the panes they were drawn on', async () => {
    const store = new MemoryStorage();
    const w = await seeded(store);
    show(w, 'AAA');
    await settle();
    expect(w.chart.panes()).toHaveLength(2);
    expect(where(w)).toEqual(['on-price@0', 'on-second@1']);
    expect(w.getState().chart.panes).toHaveLength(2);
  });

  it('does so after a reload that opens straight on that instrument', async () => {
    const store = new MemoryStorage();
    const w = await seeded(store);
    w.destroy();
    const again = make({ persist: 'w', storage: store, symbol: 'AAA' });
    await settle();
    expect(again.chart.panes()).toHaveLength(2);
    expect(where(again)).toEqual(['on-price@0', 'on-second@1']);
  });

  it('follows a study pane moved while another instrument is on screen', async () => {
    const store = new MemoryStorage();
    const w = make({ persist: 'w', storage: store });
    const first = w.chart.addIndicator('saved-osc');
    const second = w.chart.addIndicator('saved-osc-b');
    await settle();
    w.draw.add({ ...line(70), id: 'on-first', paneIndex: first.paneIndex });
    w.draw.add({ ...line(0), id: 'on-second', paneIndex: second.paneIndex });
    show(w, 'BBB');
    expect(w.chart.movePane(2, -1)).toBe(true);
    expect(w.chart.indicators().find(s => s.id === second.id)?.paneIndex).toBe(1);
    show(w, 'AAA');
    expect(where(w)).toEqual(['on-first@2', 'on-second@1']);
  });

  it('makes no pane for a drawing on a slot the chart does not have, and paints it once there is one', () => {
    const w = make();
    w.draw.fromJSON({ version: 2, drawings: [{ ...line(5), id: 'far', paneIndex: 2, zIndex: 0 }] });
    expect(w.chart.panes()).toHaveLength(1);
    expect(w.draw.get('far')?.paneIndex).toBe(2);
    const layers = (w.draw as unknown as { _layerSet: { _layers: Map<number, unknown> } })._layerSet._layers;
    expect(layers.has(2)).toBe(false);
    w.chart.addIndicator('saved-osc');
    w.chart.addIndicator('saved-osc-b');
    expect(w.chart.panes()).toHaveLength(3);
    expect(layers.has(2)).toBe(true);
  });
});

describe('D6: a link member added without a context source', () => {
  it('keeps sharing, and keeps what it received, across a symbol round trip', () => {
    const sa = new MemoryStorage(), sb = new MemoryStorage();
    const a = make({ persist: 'a', storage: sa });
    const b = make({ persist: 'b', storage: sb });
    const sharing = createDrawingLinkGroup({ enabled: true });
    sharing.add(a.chart, a.draw);
    sharing.add(b.chart, b.draw);
    a.draw.add(line(101));
    expect(prices(b)).toEqual([101]);
    show(b, 'BBB');
    expect(prices(b)).toEqual([]);
    show(b, 'AAA');
    expect(prices(b)).toEqual([101]);
    expect(storedPrices(sb, 'b', 'NSE:AAA')).toEqual([101]);
    a.draw.add(line(102));
    expect(prices(b)).toEqual([101, 102]);
  });
});
