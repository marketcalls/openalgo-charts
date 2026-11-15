/**
 * The storage layer under failures it used to hide (2.7.3): a recovery
 * journal that could not be removed, a synchronous removal the store
 * refused, and an IndexedDB open that failed on a page whose layouts live
 * in IndexedDB.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BarsRequest, DataFeed } from '../src/index';
import type { DrawingDocumentStore } from '../src/draw/index';
import { createWidget, WidgetStorage, type StorageLike, type Widget, type WidgetOptions, type WidgetStorageError } from '../src/widget/index';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument, type FakeElement } from './helpers/fake-dom-widget';
import { FakeAsyncStore, settle } from './helpers/fake-async-store';
import { FakeIndexedDb } from './helpers/fake-indexeddb';
import { walk } from './widget-grid-harness';

beforeAll(ensureWindowGlobal);

/** A synchronous store whose removals can be refused, as a custom store or a blocked page storage refuses them. */
class Store implements StorageLike {
  public readonly map = new Map<string, string>();
  public failRemove = false;
  public getItem(k: string): string | null { return this.map.get(k) ?? null; }
  public setItem(k: string, v: string): void { this.map.set(k, v); }
  public removeItem(k: string): void {
    if (this.failRemove) throw new Error('remove unavailable');
    this.map.delete(k);
  }
}

class PageStorage extends Store {
  public get length(): number { return this.map.size; }
  public key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  public clear(): void { this.map.clear(); }
}

const widgets: Widget[] = [];
afterEach(() => { for (const w of widgets.splice(0)) if (!w.isDestroyed) w.destroy(); });

function make(opts: WidgetOptions): Widget {
  const doc = fakeWidgetDocument();
  const w = createWidget(fakeContainer(doc, 800, 600) as unknown as HTMLElement, {
    document: doc as unknown as Document, pixelRatio: () => 1, panels: false, mobile: 'never',
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} }, ...opts,
  });
  w.chart.applySize(800, 600);
  widgets.push(w);
  return w;
}
const feed = (): DataFeed => { const bars = walk(240, 11); return { getBars: async (_r: BarsRequest) => bars }; };
const line = (w: Widget, price: number) => {
  const bars = w.series.getData();
  return w.draw.add({ tool: 'horizontal-line', paneIndex: 0, style: {}, points: [{ time: bars[50]?.time ?? 1_700_000_000, price }] });
};
const prices = (w: Widget): number[] => w.draw.drawings().map(d => d.points[0]!.price);

describe('the recovery journal', () => {
  it('never replays an older value over a newer one that landed after its cleanup failed', async () => {
    const store = new FakeAsyncStore();
    const journal = new Store();
    journal.failRemove = true;
    store.journal = journal;
    const errors: WidgetStorageError[] = [];
    const a = new WidgetStorage('n02', store, { onError: e => errors.push(e) });
    await a.load();
    a.set('state', { revision: 1 });
    await a.flush();
    a.set('state', { revision: 2 });
    await settle();
    await a.flush();
    expect(JSON.parse(store.map.get(a.key('state'))!)).toEqual({ revision: 2 });
    a.close();
    journal.failRemove = false;
    const b = new WidgetStorage('n02', store);
    await b.load();
    await b.flush();
    expect(b.get('state')).toEqual({ revision: 2 });
    expect(JSON.parse(store.map.get(b.key('state'))!)).toEqual({ revision: 2 });
    // The emptied journal goes once the next page has read it.
    expect(journal.map.has('oac-widget-journal:n02')).toBe(false);
    expect(errors).toEqual([]);
    b.close();
  });
});

describe('a removal a synchronous store refuses', () => {
  it('reads as not landed, as a refused write does', () => {
    const store = new Store();
    const storage = new WidgetStorage('n03', store);
    storage.set('a', 1);
    store.failRemove = true;
    expect(storage.remove('a')).toBe(false);
    expect(storage.get('a')).toBe(1);
    store.failRemove = false;
    expect(storage.remove('a')).toBe(true);
    expect(storage.get('a')).toBeNull();
    expect(new WidgetStorage('n03', null).remove('a')).toBe(false);
  });

  it('is held and said, so a deleted line does not come back after a symbol round trip', async () => {
    const store = new Store();
    // The widget's drawing adapter, as it reads once a refused removal throws (widget-persist.ts storedDrawings).
    const storage = new WidgetStorage('n03', store);
    const drawingStore: DrawingDocumentStore = {
      get: key => storage.get('drawings:' + key),
      set: (key, document) => storage.set('drawings:' + key, document),
      remove: key => { if (storage.remove('drawings:' + key) === false) throw new Error('The drawing store refused the removal'); },
    };
    const w = make({ symbol: 'AAA', exchange: 'NSE', persist: 'n03', storage: store, drawingStore });
    const errors: string[] = [];
    w.on('status', e => { if (e.kind === 'error') errors.push(e.text); });
    const drawn = line(w, 111);
    expect(store.map.has('oac-widget:n03:drawings:NSE:AAA')).toBe(true);
    store.failRemove = true;
    w.draw.remove(drawn.id);
    expect(w.draw.drawings()).toHaveLength(0);
    await w.setSymbol('BBB', 'NSE');
    store.failRemove = false;
    await w.setSymbol('AAA', 'NSE');
    expect(prices(w)).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('the default store when IndexedDB fails to open', () => {
  const g = globalThis as { indexedDB?: unknown; localStorage?: unknown };
  afterEach(() => { delete g.indexedDB; delete g.localStorage; });
  /** The next page load: a new connection over the same records. */
  const nextPage = (db: FakeIndexedDb): FakeIndexedDb => {
    const next = new FakeIndexedDb();
    for (const [k, v] of db.databases) next.databases.set(k, v);
    return next;
  };
  const errorsOf = (w: Widget): string[] => {
    const out: string[] = [];
    w.on('status', e => { if (e.kind === 'error') out.push(e.text); });
    return out;
  };

  async function firstSession(page: PageStorage): Promise<FakeIndexedDb> {
    const db = new FakeIndexedDb();
    g.localStorage = page;
    g.indexedDB = db;
    const a = make({ persist: 'desk', symbol: 'INFY', exchange: 'NSE', feed: feed() });
    await a.ready;
    await settle();
    line(a, 111);
    await a.context.storage.flush();
    a.destroy();
    await settle();
    return db;
  }

  it('says so and keeps the session in memory, rather than split it into the page storage', async () => {
    const page = new PageStorage();
    const db = await firstSession(page);
    const failing = nextPage(db);
    failing.failOpen = new Error('UnknownError: Internal error opening backing store');
    g.indexedDB = failing;
    const b = make({ persist: 'desk', symbol: 'INFY', exchange: 'NSE', feed: feed() });
    const errors = errorsOf(b);
    await b.ready;
    await settle();
    expect((b.root as unknown as FakeElement).querySelector('.oac-toast__msg')?.textContent)
      .toBe('Saved chart settings could not be read, so changes are kept for this session only: UnknownError: Internal error opening backing store');
    expect(errors.length).toBeGreaterThan(0);
    line(b, 222);
    await b.context.storage.flush();
    b.destroy();
    await settle();
    expect([...page.map.keys()].filter(k => k.startsWith('oac-widget:desk:'))).toEqual([]);
    // The next session reads the database again, and finds what the first one saved.
    g.indexedDB = nextPage(db);
    const c = make({ persist: 'desk', symbol: 'INFY', exchange: 'NSE', feed: feed() });
    await c.ready;
    await settle();
    expect(prices(c)).toEqual([111]);
  });

  it('opens the database again once before giving up on it', async () => {
    const page = new PageStorage();
    const db = await firstSession(page);
    const flaky = nextPage(db);
    let failures = 1;
    Object.defineProperty(flaky, 'failOpen', { get: () => (failures-- > 0 ? new Error('UnknownError: busy') : null) });
    g.indexedDB = flaky;
    const b = make({ persist: 'desk', symbol: 'INFY', exchange: 'NSE', feed: feed() });
    const errors = errorsOf(b);
    await b.ready;
    await settle();
    expect(prices(b)).toEqual([111]);
    expect(errors).toEqual([]);
    expect([...page.map.keys()].filter(k => k.startsWith('oac-widget:desk:'))).toEqual([]);
  });
});
