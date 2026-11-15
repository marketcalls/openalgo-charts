/**
 * Saved work the 2.7.3 re-audit still found lost or misplaced after the first
 * round of fixes: two writers that both change one instrument's drawings
 * before either write lands (D2), the last drawing deleted and then brought
 * back by a layout saved before the deletion (D3), a drawing put on another
 * study's pane after a study is replaced off screen or the panes are put in
 * another order (D5), and a journal that could be neither removed nor
 * emptied replayed over the newer value the store took since (N02). Runs
 * against the fake DOM with measured charts and a synchronous raf, over the
 * asynchronous test store that announces each write that lands, and over
 * the in-memory IndexedDB, whose two stores stand for two tabs.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import '../src/indicators/index';
import { InstrumentDrawings } from '../src/draw/index';
import {
  createIndexedDbWidgetStorage, createWidget, SAVE_DEBOUNCE_MS, WidgetStorage, type Widget, type WidgetOptions,
} from '../src/widget/index';
import { flushLeaving, mergeOnCommit } from '../src/widget/widget-storage';
import { WorkspaceRepository, createMemoryWorkspaceStorage } from '../src/workspace/index';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument } from './helpers/fake-dom-widget';
import { FakeAsyncStore, settle } from './helpers/fake-async-store';
import { FakeIndexedDb } from './helpers/fake-indexeddb';
import { MemoryStorage, makeGrid, walk } from './widget-grid-harness';

beforeAll(ensureWindowGlobal);
const live: Widget[] = [];
afterEach(async () => { for (const w of live.splice(0)) if (!w.isDestroyed) w.destroy(); await settle(); });

const bars = walk(120, 100);
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const quiet = async (): Promise<void> => { await settle(); await wait(SAVE_DEBOUNCE_MS + 100); await settle(); };
const prices = (w: Widget): number[] => w.draw.drawings().map(d => d.points[0].price).sort((a, b) => a - b);
const add = (w: Widget, price: number, paneIndex = 0): { id: string } => w.draw.add({
  tool: 'horizontal-line', paneIndex, style: {}, points: [{ time: bars[50].time, price }],
});
const onPanes = (w: Widget): Array<{ price: number; pane: number }> =>
  w.draw.drawings().map(d => ({ price: d.points[0].price, pane: d.paneIndex })).sort((a, b) => a.price - b.price);

function make(opts: WidgetOptions = {}, build: typeof createWidget = createWidget): Widget {
  const doc = fakeWidgetDocument();
  const w = build(fakeContainer(doc, 800, 600) as unknown as HTMLElement, {
    document: doc as unknown as Document, pixelRatio: () => 1, panels: false, mobile: 'never',
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
    symbol: 'AAA', exchange: 'NSE', ...opts,
  });
  live.push(w);
  w.chart.applySize(800, 600);
  w.series.setData(bars);
  return w;
}
const show = (w: Widget, symbol: string): void => { w.setSymbol(symbol); w.series.setData(bars); };
const savedPrices = (store: { map: Map<string, string> }, namespace: string): number[] =>
  (JSON.parse(store.map.get(`oac-widget:${namespace}:drawings:NSE:AAA`) ?? '{"drawings":[]}') as { drawings: Array<{ points: Array<{ price: number }> }> })
    .drawings.map(d => d.points[0].price).sort((a, b) => a - b);

/** As storage-idb.ts does: each write that lands is announced to every listener, this page's and other tabs'. */
class AnnouncingStore extends FakeAsyncStore {
  public override setItem(key: string, value: string): Promise<void> {
    return super.setItem(key, value).then(() => { for (const l of [...this.listeners]) l(key, value); });
  }
  public override removeItem(key: string): Promise<void> {
    return super.removeItem(key).then(() => { for (const l of [...this.listeners]) l(key, null); });
  }
}

/**
 * Web Locks as a browser keeps them: one queue per name for the whole origin,
 * so a request from any tab waits for the one before it. Two pages that do not
 * share a module only take turns through these; Node 20, which CI runs, has no
 * `navigator.locks` of its own.
 */
function originLocks(): { locks: { request(name: string, options: object, callback: () => Promise<unknown>): Promise<unknown> } } {
  const queues = new Map<string, Promise<unknown>>();
  return { locks: { request(name, _options, callback) {
    const held = (queues.get(name) ?? Promise.resolve()).then(() => callback());
    queues.set(name, held.catch(() => undefined));
    return held;
  } } };
}

describe('D2: two writers change one instrument before either write lands', () => {
  it('keeps both widgets\' drawings', async () => {
    const store = new AnnouncingStore();
    const a = make({ persist: 'overlap', storage: store });
    const b = make({ persist: 'overlap', storage: store });
    await a.ready; await b.ready; await quiet();
    a.series.setData(bars); b.series.setData(bars);
    // Both copies are read before either deferred write can land.
    add(a, 111); add(b, 222);
    await Promise.all([a.context.storage.flush(), b.context.storage.flush()]); await settle();
    expect(savedPrices(store, 'overlap')).toEqual([111, 222]);
    // Each widget reads what landed, so its next change keeps both as well.
    add(a, 333);
    await a.context.storage.flush(); await settle();
    expect(savedPrices(store, 'overlap')).toEqual([111, 222, 333]);
  });

  it('keeps both when two pages, each minting its own ids, add to one instrument', async () => {
    const store = new AnnouncingStore();
    store.map.set('oac-widget:pages:drawings:NSE:AAA', JSON.stringify({ version: 2, drawings: [
      { id: 'seed', tool: 'horizontal-line', paneIndex: 0, style: {}, zIndex: 0, points: [{ time: bars[50].time, price: 100 }] }] }));
    // Each page its own copy of every module, so its own id counter from the start.
    const page = async (): Promise<Widget> => {
      vi.resetModules();
      const fresh = await import('../src/widget/index');
      return make({ persist: 'pages', storage: store }, fresh.createWidget as unknown as typeof createWidget);
    };
    vi.stubGlobal('navigator', originLocks());
    try {
      const a = await page(), b = await page();
      await a.ready; await b.ready; await quiet();
      a.series.setData(bars); b.series.setData(bars);
      const [mine, theirs] = [add(a, 111), add(b, 222)];
      expect(mine.id).not.toBe(theirs.id);
      await Promise.all([a.context.storage.flush(), b.context.storage.flush()]); await settle();
      expect(savedPrices(store, 'pages')).toEqual([100, 111, 222]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps both grids\' drawings on one desk', async () => {
    const store = new AnnouncingStore();
    const options = { persist: 'overlap-grid', storage: store, preset: '1x2' as const, feed: { getBars: async () => bars } };
    const a = makeGrid(options).grid; await a.ready; await quiet();
    const b = makeGrid(options).grid; await b.ready; await quiet();
    for (const g of [a, b]) for (const c of g.cells()) c.widget.chart.applySize(600, 400);
    await quiet();
    add(a.cells()[0].widget, 111);
    add(b.cells()[0].widget, 222);
    await quiet(); await quiet();
    const stored = JSON.parse(store.map.get('oac-widget:overlap-grid:grid-drawings')!) as
      { charts: Record<string, Record<string, { drawings: Array<{ points: Array<{ price: number }> }> }>> };
    expect(stored.charts.p0['NSE:AAA'].drawings.map(d => d.points[0].price).sort((x, y) => x - y)).toEqual([111, 222]);
    // Each grid shows what landed on the chart it drew on.
    expect(prices(a.cells()[0].widget)).toEqual([111, 222]);
    expect(prices(b.cells()[0].widget)).toEqual([111, 222]);
  });

  it('keeps both over IndexedDB, two stores standing for two tabs, and reads the key past the page storage copy', async () => {
    const fake = new FakeIndexedDb();
    // The namespace was copied from the page's storage on an earlier visit,
    // and the copy's line was deleted here since. Its old entry is still in
    // the page's storage: a write that read its key through `entries` would
    // copy it back in.
    fake.databases.set('tabs-db', { version: 1, stores: new Map([['entries', new Map<string, unknown>([['copied:oac-widget:tabs:', 'earlier']])]]) });
    const legacy = new MemoryStorage();
    legacy.setItem('oac-widget:tabs:drawings:NSE:AAA', JSON.stringify({ version: 2, drawings: [
      { id: 'old', tool: 'horizontal-line', paneIndex: 0, style: {}, zIndex: 0, points: [{ time: bars[50].time, price: 999 }] }] }));
    const page = Object.assign(legacy, { get length() { return legacy.map.size; }, key: (i: number) => [...legacy.map.keys()][i] ?? null }) as unknown as Storage;
    const db = fake as unknown as IDBFactory;
    const tab = (): Widget => make({ persist: 'tabs', storage: createIndexedDbWidgetStorage(db, 'tabs-db', { journal: null, migrateFrom: page }) });
    const a = tab(), b = tab();
    await a.ready; await b.ready; await quiet();
    a.series.setData(bars); b.series.setData(bars);
    add(a, 111); add(b, 222);
    await Promise.all([a.context.storage.flush(), b.context.storage.flush()]); await settle();
    const reader = tab();
    await reader.ready; await quiet();
    reader.series.setData(bars);
    expect(prices(reader)).toEqual([111, 222]);
  });

  it.each([
    ['without Web Locks', {}],
    ['whose locks are refused, as in a sandboxed frame', { locks: { request: () => Promise.reject(new Error('SecurityError')) } }],
  ])('keeps both on a page %s, the widgets on it taking turns', async (_, navigator) => {
    vi.stubGlobal('navigator', navigator);
    try {
      const store = new AnnouncingStore();
      const a = make({ persist: 'no-locks', storage: store });
      const b = make({ persist: 'no-locks', storage: store });
      await a.ready; await b.ready; await quiet();
      a.series.setData(bars); b.series.setData(bars);
      add(a, 111); add(b, 222);
      await Promise.all([a.context.storage.flush(), b.context.storage.flush()]); await settle();
      expect(savedPrices(store, 'no-locks')).toEqual([111, 222]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps both grids\' drawings on one desk over a synchronous store, on one page', async () => {
    const store = new MemoryStorage();
    const options = { persist: 'sync-grid', storage: store, preset: '1x2' as const, feed: { getBars: async () => bars } };
    const a = makeGrid(options).grid; await a.ready; await quiet();
    const b = makeGrid(options).grid; await b.ready; await quiet();
    for (const g of [a, b]) for (const c of g.cells()) c.widget.chart.applySize(600, 400);
    await quiet();
    add(a.cells()[0].widget, 111);
    add(b.cells()[0].widget, 222);
    await quiet();
    add(a.cells()[0].widget, 333);
    await quiet();
    const stored = JSON.parse(store.map.get('oac-widget:sync-grid:grid-drawings')!) as
      { charts: Record<string, Record<string, { drawings: Array<{ points: Array<{ price: number }> }> }>> };
    expect(stored.charts.p0['NSE:AAA'].drawings.map(d => d.points[0].price).sort((x, y) => x - y)).toEqual([111, 222, 333]);
  });

  it('merges a journaled change the store moved past into what it holds, rather than drop either', async () => {
    const line = (id: string, price: number): unknown => ({ id, tool: 'horizontal-line', paneIndex: 0, style: {}, zIndex: 0, points: [{ time: bars[50].time, price }] });
    const key = 'oac-widget:replay:drawings:NSE:AAA';
    const journal = new MemoryStorage();
    // The page that goes away: its store takes the change and never answers again.
    const closingStore = new FakeAsyncStore();
    closingStore.journal = journal;
    closingStore.map.set(key, JSON.stringify({ version: 2, drawings: [line('a', 100)] }));
    const closing = new WidgetStorage('replay', closingStore);
    await closing.load();
    closingStore.silent = true;
    closing.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100), line('b', 111)] });
    void closing.flush();
    closing.close();
    // The next page finds another tab's line landed meanwhile.
    const store = new FakeAsyncStore();
    store.journal = journal;
    store.map.set(key, JSON.stringify({ version: 2, drawings: [line('a', 100), line('c', 222)] }));
    const next = new WidgetStorage('replay', store);
    mergeOnCommit(next, name => (name.startsWith('drawings:') ? InstrumentDrawings.merge : null));
    await next.load(); await next.flush(); await settle();
    const ids = (JSON.parse(store.map.get(key)!) as { drawings: Array<{ id: string }> }).drawings.map(d => d.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
    next.close();
  });
});

describe('D3: the last drawing deleted, then a layout saved before the deletion opened', () => {
  it('stays deleted, and after a reload too', async () => {
    const store = new MemoryStorage();
    const account = createMemoryWorkspaceStorage();
    const w = make({ persist: 'tombstone', storage: store, workspaces: new WorkspaceRepository(account, 'tombstone') });
    await w.ready; await wait(20);
    const line = add(w, 111);
    await w.layouts!.saveAs('Before deletion');
    const saved = (await new WorkspaceRepository(account, 'tombstone').load()).workspaces[0]!;
    w.draw.remove(line.id);
    expect(prices(w)).toEqual([]);
    expect(savedPrices(store, 'tombstone')).toEqual([]);
    expect((await w.layouts!.open(saved.id)).applied).toBe(true);
    expect(prices(w)).toEqual([]);
    expect(savedPrices(store, 'tombstone')).toEqual([]);
    w.destroy();

    const again = make({ persist: 'tombstone', storage: store, workspaces: new WorkspaceRepository(account, 'tombstone') });
    await again.ready; await wait(20);
    expect((await again.layouts!.open(saved.id)).applied).toBe(true);
    again.series.setData(bars);
    expect(prices(again)).toEqual([]);
    expect(savedPrices(store, 'tombstone')).toEqual([]);
  });
});

describe('D5: a drawing keeps its study, not its slot', () => {
  it('is not given to a study put in the slot of the one removed while its instrument was off screen', async () => {
    const w = make({ persist: 'pane-replace', storage: new MemoryStorage() });
    w.chart.addIndicator('rsi');
    const old = w.chart.addIndicator('macd');
    await settle();
    add(w, 123, old.paneIndex);
    show(w, 'BBB');
    w.chart.removeIndicator(old.id);
    const replacement = w.chart.addIndicator('cci');
    await settle();
    expect(replacement.paneIndex).toBe(old.paneIndex);
    show(w, 'AAA');
    expect(onPanes(w)).toEqual([]);
  });

  it('goes back on a study of the same kind made again with a new id, as a template applied again does', async () => {
    const w = make({ persist: 'pane-again', storage: new MemoryStorage() });
    const old = w.chart.addIndicator('rsi');
    await settle();
    add(w, 70, old.paneIndex);
    show(w, 'BBB');
    w.chart.removeIndicator(old.id);
    const again = w.chart.addIndicator('rsi');
    await settle();
    show(w, 'AAA');
    expect(onPanes(w)).toEqual([{ price: 70, pane: again.paneIndex }]);
  });

  it('lands on its own study when a same-instrument layout restores the panes in another order', () => {
    const w = make();
    const rsi = w.chart.addIndicator('rsi');
    const macd = w.chart.addIndicator('macd');
    add(w, 70, rsi.paneIndex); add(w, 0, macd.paneIndex);
    const earlier = w.getState();
    expect(w.chart.movePane(2, -1)).toBe(true);
    expect(onPanes(w)).toEqual([{ price: 0, pane: 1 }, { price: 70, pane: 2 }]);
    expect(w.restoreState(earlier).applied).toBe(true);
    expect(w.chart.indicators().map(i => [i.indicatorId, i.paneIndex])).toEqual([['rsi', 1], ['macd', 2]]);
    expect(onPanes(w)).toEqual([{ price: 0, pane: 2 }, { price: 70, pane: 1 }]);
  });
});

describe('N02: a journal that could be neither removed nor emptied', () => {
  it('is not replayed over a later commit by the next reader', async () => {
    class Journal extends MemoryStorage {
      public blocked = false;
      public override removeItem(k: string): void { if (this.blocked) throw new Error('journal read-only'); super.removeItem(k); }
      public override setItem(k: string, v: string): void { if (this.blocked) throw new Error('journal read-only'); super.setItem(k, v); }
    }
    const store = new FakeAsyncStore();
    const journal = new Journal();
    store.journal = journal;
    const a = new WidgetStorage('both-cleanup-fail', store);
    await a.load();
    a.set('state', { revision: 1 });
    const flushed = a.flush();
    journal.blocked = true;
    await flushed;
    a.set('state', { revision: 2 }); await settle(); await a.flush();
    expect(JSON.parse(store.map.get(a.key('state'))!)).toEqual({ revision: 2 });
    a.close(); journal.blocked = false;
    const b = new WidgetStorage('both-cleanup-fail', store);
    await b.load(); await b.flush();
    expect(b.get('state')).toEqual({ revision: 2 });
    expect(JSON.parse(store.map.get(b.key('state'))!)).toEqual({ revision: 2 });
    // The stale journal goes once the reader has nothing left to send.
    expect(journal.map.has('oac-widget-journal:both-cleanup-fail')).toBe(false);
    b.close();
  });

  it('still replays a journaled change that never landed', async () => {
    const journal = new MemoryStorage();
    const closingStore = new FakeAsyncStore();
    closingStore.journal = journal;
    closingStore.map.set('oac-widget:lost:state', JSON.stringify({ revision: 1 }));
    const a = new WidgetStorage('lost', closingStore);
    await a.load();
    closingStore.silent = true;
    a.set('state', { revision: 2 });
    void a.flush();
    a.close();
    const store = new FakeAsyncStore();
    store.journal = journal;
    store.map.set('oac-widget:lost:state', JSON.stringify({ revision: 1 }));
    const b = new WidgetStorage('lost', store);
    await b.load(); await b.flush(); await settle();
    expect(JSON.parse(store.map.get('oac-widget:lost:state')!)).toEqual({ revision: 2 });
    b.close();
  });

  it('replays the last change of a page whose earlier write of the key landed while the last was still out', async () => {
    // A desk switched AAA then BBB: the AAA write lands, the BBB one is out
    // as the page reloads. The store then holds this page's own AAA, which
    // is not another writer moving it on.
    const key = 'oac-widget:several:grid';
    const journal = new MemoryStorage();
    const closingStore = new FakeAsyncStore();
    closingStore.journal = journal;
    closingStore.map.set(key, JSON.stringify({ symbol: 'START' }));
    const a = new WidgetStorage('several', closingStore);
    await a.load();
    closingStore.hold = true;
    a.set('grid', { symbol: 'AAA' }); await settle();
    a.set('grid', { symbol: 'BBB' });
    closingStore.release(); await settle();
    expect(closingStore.map.get(key)).toBe('{"symbol":"AAA"}');
    flushLeaving(a);
    a.close();
    const store = new FakeAsyncStore();
    store.journal = journal;
    store.map.set(key, '{"symbol":"AAA"}');
    const b = new WidgetStorage('several', store);
    await b.load(); await b.flush(); await settle();
    expect(b.get('grid')).toEqual({ symbol: 'BBB' });
    expect(store.map.get(key)).toBe('{"symbol":"BBB"}');
    b.close();
  });
});

describe('a page or a widget going away', () => {
  it('writes every change in the call, merged names too, and an older merged write still waiting writes nothing after it', async () => {
    const store = new FakeAsyncStore();
    store.journal = new MemoryStorage();
    const storage = new WidgetStorage('leave', store);
    mergeOnCommit(storage, name => (name === 'doc' ? (_base, ours) => ours : null));
    await storage.load();
    store.hold = true;
    // This one's commit waits for its read of the store.
    storage.set('doc', { v: 1 }); await settle();
    storage.set('doc', { v: 2 });
    storage.set('state', { n: 1 });
    flushLeaving(storage);
    const issued = ['set oac-widget:leave:doc {"v":2}', 'set oac-widget:leave:state {"n":1}'];
    expect(store.writes()).toEqual(issued);
    expect(JSON.parse(store.journal.getItem('oac-widget-journal:leave')!).entries).toEqual({
      'oac-widget:leave:doc': '{"v":2}', 'oac-widget:leave:state': '{"n":1}',
    });
    store.release(); await settle(); store.release(); await settle();
    expect(store.writes()).toEqual(issued);
    expect(store.map.get('oac-widget:leave:doc')).toBe('{"v":2}');
    expect(storage.get('doc')).toEqual({ v: 2 });
    storage.close();
  });

  it('merges a change written at once into what another writer was heard to land meanwhile', async () => {
    const line = (id: string, price: number): unknown => ({ id, tool: 'horizontal-line', paneIndex: 0, style: {}, zIndex: 0, points: [{ time: bars[50].time, price }] });
    const key = 'oac-widget:heard:drawings:NSE:AAA';
    const store = new FakeAsyncStore();
    store.map.set(key, JSON.stringify({ version: 2, drawings: [line('a', 100)] }));
    const storage = new WidgetStorage('heard', store);
    mergeOnCommit(storage, name => (name.startsWith('drawings:') ? InstrumentDrawings.merge : null));
    await storage.load();
    store.hold = true;
    storage.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100), line('b', 111)] }); await settle();
    // Another tab's line lands while this copy's change is out.
    store.external(key, JSON.stringify({ version: 2, drawings: [line('a', 100), line('c', 222)] }));
    storage.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100), line('b', 112)] });
    flushLeaving(storage);
    // A page only hidden goes on reading what it wrote.
    expect((storage.get('drawings:NSE:AAA') as { drawings: Array<{ id: string }> }).drawings.map(d => d.id).sort()).toEqual(['a', 'b', 'c']);
    store.release(); await settle(); store.release(); await settle();
    const ids = (JSON.parse(store.map.get(key)!) as { drawings: Array<{ id: string }> }).drawings.map(d => d.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
    storage.close();
  });
});
