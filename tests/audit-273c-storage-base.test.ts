/**
 * One copy changes an instrument's drawings again while its first merged
 * write is still out (the lock, the read and the write). The second change
 * was made from the first, so once the first lands it is the base the second
 * merges against. Merged against the base from before the first instead, a
 * drawing the second change deleted came back: in the store, through the
 * write made as the page goes, and on the next page through the journal.
 * Found by review of the 2.7.3 second round.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import '../src/indicators/index';
import { InstrumentDrawings } from '../src/draw/index';
import { createWidget, SAVE_DEBOUNCE_MS, WidgetStorage, type Widget, type WidgetOptions } from '../src/widget/index';
import { flushLeaving, mergeOnCommit } from '../src/widget/widget-storage';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument } from './helpers/fake-dom-widget';
import { FakeAsyncStore, settle } from './helpers/fake-async-store';
import { walk } from './widget-grid-harness';

beforeAll(ensureWindowGlobal);
const live: Widget[] = [];
afterEach(async () => { for (const w of live.splice(0)) if (!w.isDestroyed) w.destroy(); await settle(); });

const bars = walk(120, 100);
const line = (id: string, price: number): unknown => ({ id, tool: 'horizontal-line', paneIndex: 0, style: {}, zIndex: 0, points: [{ time: 1, price }] });
const ids = (text: string | undefined): string[] => (JSON.parse(text ?? '{"drawings":[]}') as { drawings: Array<{ id: string }> }).drawings.map(d => d.id).sort();
const drain = async (store: FakeAsyncStore): Promise<void> => { for (let i = 0; i < 8; i++) { store.release(); await settle(); } };
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const quiet = async (): Promise<void> => { await settle(); await wait(SAVE_DEBOUNCE_MS + 100); await settle(); };
const prices = (w: Widget): number[] => w.draw.drawings().map(d => d.points[0].price).sort((a, b) => a - b);

/** Announces landed writes to every listener, the writer's own included, as storage-idb.ts does. */
class AnnouncingStore extends FakeAsyncStore {
  public override setItem(key: string, value: string): Promise<void> {
    return super.setItem(key, value).then(() => { for (const l of [...this.listeners]) l(key, value); });
  }
}

function merging(namespace: string, store: FakeAsyncStore): WidgetStorage {
  const storage = new WidgetStorage(namespace, store);
  mergeOnCommit(storage, name => (name.startsWith('drawings:') ? InstrumentDrawings.merge : null));
  return storage;
}

function make(opts: WidgetOptions = {}): Widget {
  const doc = fakeWidgetDocument();
  const w = createWidget(fakeContainer(doc, 800, 600) as unknown as HTMLElement, {
    document: doc as unknown as Document, pixelRatio: () => 1, panels: false, mobile: 'never',
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
    symbol: 'AAA', exchange: 'NSE', ...opts,
  });
  live.push(w);
  w.chart.applySize(800, 600);
  w.series.setData(bars);
  return w;
}

describe('a merged key changed again while its first write is out', () => {
  it('add then delete: the deleted drawing stays deleted', async () => {
    const key = 'oac-widget:twice:drawings:NSE:AAA';
    const store = new FakeAsyncStore();
    store.map.set(key, JSON.stringify({ version: 2, drawings: [line('a', 100)] }));
    const storage = merging('twice', store);
    await storage.load();
    store.hold = true;
    storage.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100), line('b', 111)] });
    await settle();
    // The user deletes b (or undoes adding it) before the first write lands.
    storage.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100)] });
    await drain(store);
    expect(ids(store.map.get(key))).toEqual(['a']);
    storage.close();
  });

  it('delete then undo: the restored drawing stays', async () => {
    const key = 'oac-widget:undo:drawings:NSE:AAA';
    const store = new FakeAsyncStore();
    store.map.set(key, JSON.stringify({ version: 2, drawings: [line('a', 100), line('b', 111)] }));
    const storage = merging('undo', store);
    await storage.load();
    store.hold = true;
    storage.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100)] });
    await settle();
    storage.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100), line('b', 111)] });
    await drain(store);
    expect(ids(store.map.get(key))).toEqual(['a', 'b']);
    storage.close();
  });

  it('leave after the first write landed: the deleted drawing stays deleted', async () => {
    const key = 'oac-widget:leave2:drawings:NSE:AAA';
    const store = new AnnouncingStore();
    store.map.set(key, JSON.stringify({ version: 2, drawings: [line('a', 100)] }));
    const storage = merging('leave2', store);
    await storage.load();
    store.hold = true;
    storage.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100), line('b', 111)] });
    await settle();
    storage.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100)] });
    // The first commit's read is answered, then its write lands and is announced to this copy.
    store.release(); await settle();
    store.release(); await settle();
    // The second commit waits on its read as the page goes.
    flushLeaving(storage);
    await drain(store);
    expect(ids(store.map.get(key))).toEqual(['a']);
    storage.close();
  });

  it('the page closes after the first write landed: the next page replays the deletion, not the add', async () => {
    const key = 'oac-widget:reload:drawings:NSE:AAA';
    const journal = new Map<string, string>();
    const journalStore = { getItem: (k: string) => journal.get(k) ?? null, setItem: (k: string, v: string) => { journal.set(k, v); }, removeItem: (k: string) => { journal.delete(k); } };
    const closing = new FakeAsyncStore();
    closing.journal = journalStore;
    closing.map.set(key, JSON.stringify({ version: 2, drawings: [line('a', 100)] }));
    const a = merging('reload', closing);
    await a.load();
    closing.hold = true;
    a.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100), line('b', 111)] });
    await settle();
    a.set('drawings:NSE:AAA', { version: 2, drawings: [line('a', 100)] });
    closing.release(); await settle();
    closing.release(); await settle();
    // The add landed; the deletion is still out as the page goes, and never lands.
    expect(ids(closing.map.get(key))).toEqual(['a', 'b']);
    flushLeaving(a);
    a.close();
    const held = closing.map.get(key)!;
    // A closed tab frees its locks: let the old page's held calls go without landing.
    closing.silent = true; closing.release(); await settle();
    const next = new FakeAsyncStore();
    next.journal = journalStore;
    next.map.set(key, held);
    const b = merging('reload', next);
    await b.load(); await b.flush(); await settle();
    expect(ids(next.map.get(key))).toEqual(['a']);
    b.close();
  });

  it('a widget line added and deleted before its write lands stays deleted after a reload', async () => {
    const store = new FakeAsyncStore();
    const w = make({ persist: 'resurrect', storage: store });
    await w.ready; await quiet();
    w.series.setData(bars);
    w.draw.add({ tool: 'horizontal-line', paneIndex: 0, style: {}, points: [{ time: bars[50].time, price: 100 }] });
    await quiet();
    store.hold = true;
    const added = w.draw.add({ tool: 'horizontal-line', paneIndex: 0, style: {}, points: [{ time: bars[50].time, price: 111 }] });
    await settle();
    w.draw.remove(added.id);
    expect(prices(w)).toEqual([100]);
    for (let i = 0; i < 10; i++) { store.release(); await settle(); }
    store.hold = false;
    await quiet();
    const stored = JSON.parse(store.map.get('oac-widget:resurrect:drawings:NSE:AAA') ?? '{"drawings":[]}') as { drawings: Array<{ points: Array<{ price: number }> }> };
    const storedPrices = stored.drawings.map(d => d.points[0].price).sort((x, y) => x - y);
    w.destroy(); await settle();
    const again = make({ persist: 'resurrect', storage: store });
    await again.ready; await quiet();
    again.series.setData(bars);
    expect({ storedPrices, reloaded: prices(again) }).toEqual({ storedPrices: [100], reloaded: [100] });
  });
});
