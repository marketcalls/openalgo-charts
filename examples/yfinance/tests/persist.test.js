import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeDom, fakeStorage } from './helpers.js';

// Restoring a layout reaches into the modules that own the comparisons, the
// volume flag, the zone and the chrome. None of them is under test here, and
// each keeps its own `app`, so they are stood in for and their calls read back.
vi.mock('../src/volume.js', () => ({ volumeShown: vi.fn(() => true), setVolumeShown: vi.fn() }));
vi.mock('../src/timezone.js', () => ({ DEFAULT_TZ: 'Asia/Kolkata', syncTimezoneFromChart: vi.fn() }));
vi.mock('../src/compare.js', () => ({ removeComparison: vi.fn(), syncComparisons: vi.fn() }));
vi.mock('../src/indicators.js', () => ({ renderIndicatorChips: vi.fn() }));
vi.mock('../src/toolbar.js', () => ({ renderToolbar: vi.fn() }));

import { CHART_STATE_VERSION } from '/dist/openalgo-charts.mjs';
import {
  LAYOUT_KEY, LEGACY_LAYOUT_KEY, QUARANTINE_PREFIX, QUARANTINE_KEEP, LAYOUT_SCHEMA, SAVE_DEBOUNCE_MS,
  LayoutError, MIGRATIONS, schemaOf, upgradeLayout, quarantine, quarantinedKeys, readLayout, writeLayout,
  storageDegraded, migrateStorage, layoutSnapshot, stripView, applyLayout, persistLayoutNow, autosave, flushAutosave,
  exportLayout, parseLayoutFile, importLayoutFile, initPersist, datasetKey,
} from '../src/persist.js';
import { setVolumeShown } from '../src/volume.js';
import { removeComparison, syncComparisons } from '../src/compare.js';

/** A storage the quarantine can enumerate: `fakeStorage` has no `length` or `key`. */
function storageWithKeys() {
  const store = fakeStorage();
  Object.defineProperty(globalThis.localStorage, 'length', { get: () => store.size, configurable: true });
  globalThis.localStorage.key = (i) => [...store.keys()][i] ?? null;
  return store;
}

/** A 1.x save: `getState()` spread flat, drawings as the old bare array with text in the style bag. */
const V1_DOC = {
  version: 1,
  timezone: 'Asia/Kolkata',
  viewport: { from: 10, to: 90 },
  barSpacing: 8,
  panes: [{ weight: 1, priceScale: { autoScale: false, range: { min: 1, max: 2 }, mode: 'normal' } }],
  indicators: [{ indicatorId: 'rsi', settings: { length: 14 }, paneIndex: 1 }],
  drawings: [
    { id: 'd1', tool: 'trend-line', points: [{ time: 1, price: 2 }, { time: 3, price: 4 }], style: { color: '#fff', text: 'hello', fontColor: '#abc', levels: [0.5] } },
    { tool: 'text', points: [] },   // no anchors: cannot be drawn, so it goes
  ],
  dataset: 'AAPL|1d|1y',
  comparisons: [{ symbol: 'MSFT', color: '#f00' }],
  compareMode: 'percentage',
  volume: false,
};

function fakeChart() {
  return {
    state: {
      version: CHART_STATE_VERSION, timezone: 'Asia/Kolkata', viewport: { from: 10, to: 90 }, barSpacing: 8,
      panes: [{ weight: 1, priceScale: { autoScale: false, range: { min: 1, max: 2 } } }],
      indicators: [{ indicatorId: 'rsi', settings: { length: 14 }, paneIndex: 1 }],
      drawings: { version: 2, drawings: [] },
    },
    getState() { return JSON.parse(JSON.stringify(this.state)); },
    restored: [],
    restoreState(s) { this.restored.push(s); return { applied: true, series: [], indicators: (s.indicators || []).length }; },
    indicators: () => [1],
    timezone: () => 'Asia/Kolkata',
  };
}

function freshApp() {
  return {
    chart: fakeChart(), req: { symbol: 'AAPL', interval: '1d', period: '1y' },
    comparisons: [], cmpMode: 'percentage', activeIndicators: [], draw: { fromJSON: vi.fn() }, replay: null,
  };
}

const toastsShown = (dom) => dom.get('toasts').children.map((n) => n.textContent);

describe('the layout schema', () => {
  it('upgrades a 1.x document, drawings included, and is idempotent', () => {
    expect(schemaOf(V1_DOC)).toBe(1);
    const v2 = upgradeLayout(V1_DOC);
    expect(v2.schema).toBe(LAYOUT_SCHEMA);
    expect(v2.version).toBe(1);
    expect(v2.dataset).toBe('AAPL|1d|1y');
    expect(v2.drawings.version).toBe(2);
    expect(v2.drawings.drawings).toHaveLength(1);
    const d = v2.drawings.drawings[0];
    expect(d.id).toBe('d1');
    expect(d.text).toEqual({ value: 'hello', color: '#abc' });
    expect(d.style.text).toBeUndefined();
    expect(d.style.levels[0].ratio).toBe(0.5);
    expect(typeof d.style.levels[0].color).toBe('string');
    // The input is left alone, and a second pass changes nothing.
    expect(Array.isArray(V1_DOC.drawings)).toBe(true);
    expect(upgradeLayout(v2)).toEqual(v2);
    expect(Object.keys(MIGRATIONS)).toEqual(['1']);
  });

  it('stamps a version on a document that had none', () => {
    const { version, ...noVersion } = V1_DOC;
    expect(version).toBe(1);
    expect(upgradeLayout(noVersion).version).toBe(1);
  });

  it('refuses what it cannot read, with a reason', () => {
    expect(() => upgradeLayout(null)).toThrow(LayoutError);
    expect(() => upgradeLayout([])).toThrow(LayoutError);
    expect(() => upgradeLayout({ schema: 99 })).toThrow(/newer demo/);
    expect(() => upgradeLayout({ schema: 0 })).toThrow(LayoutError);
    expect(() => upgradeLayout({ schema: 'two' })).toThrow(LayoutError);
    expect(() => upgradeLayout({ schema: 2, version: CHART_STATE_VERSION + 1 })).toThrow(/newer than this engine/);
  });
});

describe('storage', () => {
  let dom;
  let store;
  beforeEach(() => {
    dom = fakeDom();
    store = storageWithKeys();
    vi.useFakeTimers({ now: Date.UTC(2024, 0, 10, 12) });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('quarantines a corrupt entry instead of throwing on it', () => {
    store.set(LAYOUT_KEY, '{not json');
    expect(readLayout()).toBeNull();
    expect(store.has(LAYOUT_KEY)).toBe(false);
    const keys = quarantinedKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(QUARANTINE_PREFIX + 'layout:')).toBe(true);
    expect(store.get(keys[0])).toBe('{not json');
    expect(toastsShown(dom)).toHaveLength(1);
    expect(toastsShown(dom)[0]).toContain('set aside');
    expect(toastsShown(dom)[0]).toContain(keys[0]);
    // A document from a newer demo is set aside the same way.
    store.set(LAYOUT_KEY, JSON.stringify({ schema: 99 }));
    expect(readLayout()).toBeNull();
    expect(quarantinedKeys()).toHaveLength(2);
    expect(toastsShown(dom)[1]).toContain('newer demo');
  });

  it('keeps only the newest set-aside copies', () => {
    for (let i = 0; i < QUARANTINE_KEEP + 3; i++) {
      vi.setSystemTime(Date.UTC(2024, 0, 10, 12, 0, i));
      quarantine(LAYOUT_KEY, `copy ${i}`, 'test');
    }
    const keys = quarantinedKeys();
    expect(keys).toHaveLength(QUARANTINE_KEEP);
    expect(store.get(keys[keys.length - 1])).toBe(`copy ${QUARANTINE_KEEP + 2}`);
    expect(store.get(keys[0])).toBe('copy 3');
  });

  it('moves a 1.x layout to the namespaced key at start-up', () => {
    store.set(LEGACY_LAYOUT_KEY, JSON.stringify(V1_DOC));
    initPersist(freshApp());
    expect(store.has(LEGACY_LAYOUT_KEY)).toBe(false);
    const moved = JSON.parse(store.get(LAYOUT_KEY));
    expect(moved.schema).toBe(LAYOUT_SCHEMA);
    expect(moved.drawings.version).toBe(2);
    expect(readLayout()).toEqual(moved);
    // A second boot has nothing to move.
    expect(migrateStorage()).toBe(false);
  });

  it('sets a corrupt entry aside at start-up, before anything reads it', () => {
    store.set(LAYOUT_KEY, '{corrupt');
    initPersist(freshApp());
    expect(store.has(LAYOUT_KEY)).toBe(false);
    expect(quarantinedKeys()).toHaveLength(1);
    expect(toastsShown(dom)[0]).toContain('set aside');
    // The baseline is then "nothing stored", so the next autosave writes.
    autosave();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(store.has(LAYOUT_KEY)).toBe(true);
  });

  it('does not let a legacy copy overwrite a current one', () => {
    store.set(LAYOUT_KEY, JSON.stringify({ schema: 2, version: 1, dataset: 'current' }));
    store.set(LEGACY_LAYOUT_KEY, JSON.stringify(V1_DOC));
    expect(migrateStorage()).toBe(true);
    expect(JSON.parse(store.get(LAYOUT_KEY)).dataset).toBe('current');
    expect(store.has(LEGACY_LAYOUT_KEY)).toBe(false);
  });

  it('quarantines a corrupt legacy copy rather than carrying it over', () => {
    store.set(LEGACY_LAYOUT_KEY, 'garbage');
    expect(migrateStorage()).toBe(false);
    expect(store.has(LEGACY_LAYOUT_KEY)).toBe(false);
    expect(store.has(LAYOUT_KEY)).toBe(false);
    const keys = quarantinedKeys();
    expect(keys).toHaveLength(1);
    expect(store.get(keys[0])).toBe('garbage');
    expect(toastsShown(dom)[0]).toContain('set aside');
  });

  it('debounces the autosave and writes only when something changed', () => {
    const app = freshApp();
    initPersist(app);
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');
    autosave();
    autosave();
    autosave();
    expect(setItem).not.toHaveBeenCalled();
    // Nothing lands until the window has passed in full.
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem.mock.calls[0][0]).toBe(LAYOUT_KEY);
    const stored = JSON.parse(store.get(LAYOUT_KEY));
    expect(stored.schema).toBe(LAYOUT_SCHEMA);
    expect(stored.dataset).toBe(datasetKey(app.req));
    expect(stored.volume).toBe(true);
    // Nothing changed: nothing written.
    autosave();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(setItem).toHaveBeenCalledTimes(1);
    app.chart.state.viewport = { from: 20, to: 100 };
    autosave();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(setItem).toHaveBeenCalledTimes(2);
    // Not while replaying: the chart is showing a prefix of the session.
    app.chart.state.viewport = { from: 30, to: 110 };
    app.replay = {};
    autosave();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('starts from what is stored, so a reload does not rewrite an identical document', () => {
    const app = freshApp();
    store.set(LAYOUT_KEY, JSON.stringify(layoutSnapshotFor(app)));
    initPersist(app);
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');
    autosave();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('flushes a pending save when the page goes away', () => {
    const app = freshApp();
    initPersist(app);
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');
    autosave();
    flushAutosave();
    expect(setItem).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(setItem).toHaveBeenCalledTimes(1);
    flushAutosave();
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it('degrades to memory when storage refuses, says so once, and recovers on Save', () => {
    const app = freshApp();
    initPersist(app);
    const real = globalThis.localStorage.setItem;
    globalThis.localStorage.setItem = () => { throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); };
    expect(persistLayoutNow()).toBe('memory');
    expect(storageDegraded()).toBe(true);
    expect(toastsShown(dom)).toHaveLength(1);
    expect(toastsShown(dom)[0]).toContain('storage is full');
    // The session keeps working out of memory, quietly.
    expect(readLayout().dataset).toBe(datasetKey(app.req));
    app.chart.state.viewport = { from: 1, to: 2 };
    expect(persistLayoutNow()).toBe('memory');
    expect(readLayout().viewport).toEqual({ from: 1, to: 2 });
    expect(toastsShown(dom)).toHaveLength(1);
    autosave();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(store.has(LAYOUT_KEY)).toBe(false);
    // Save tries storage again; with room back, the document lands and memory is let go.
    globalThis.localStorage.setItem = real;
    expect(persistLayoutNow({ retryStorage: true })).toBe('stored');
    expect(storageDegraded()).toBe(false);
    expect(JSON.parse(store.get(LAYOUT_KEY)).viewport).toEqual({ from: 1, to: 2 });
    expect(toastsShown(dom)[1]).toContain('back');
    expect(writeLayout({ schema: 2, version: 1, other: true })).toBe('stored');
  });
});

/** The document `layoutSnapshot()` would produce for `app`, without going through the module's `app`. */
function layoutSnapshotFor(app) {
  return {
    schema: LAYOUT_SCHEMA, ...app.chart.getState(), dataset: datasetKey(app.req),
    comparisons: [], compareMode: app.cmpMode, volume: true,
  };
}

describe('applying a layout', () => {
  let dom;
  let app;
  beforeEach(() => {
    dom = fakeDom();
    storageWithKeys();
    app = freshApp();
    initPersist(app);
    vi.clearAllMocks();
  });

  it('captures what the engine does not own alongside its state', () => {
    app.comparisons = [{ symbol: 'MSFT', color: '#f00', bars: [1] }];
    app.cmpMode = 'indexed';
    const snap = layoutSnapshot();
    expect(snap.schema).toBe(LAYOUT_SCHEMA);
    expect(snap.version).toBe(CHART_STATE_VERSION);
    expect(snap.comparisons).toEqual([{ symbol: 'MSFT', color: '#f00' }]);
    expect(snap.compareMode).toBe('indexed');
    expect(snap.dataset).toBe('AAPL|1d|1y');
  });

  it('drops the view, and only the view, for another dataset', () => {
    const doc = upgradeLayout(V1_DOC);
    const stripped = stripView(doc);
    expect(stripped.viewport).toBeUndefined();
    expect(stripped.barSpacing).toBeUndefined();
    expect(stripped.panes[0].priceScale).toEqual({ autoScale: true, mode: 'normal' });
    expect(stripped.indicators).toEqual(doc.indicators);
    expect(stripped.drawings).toBe(doc.drawings);
    // A copy: the document that was read is untouched.
    expect(doc.viewport).toEqual({ from: 10, to: 90 });
    expect(doc.panes[0].priceScale.range).toEqual({ min: 1, max: 2 });
  });

  it('hands the chart, the drawings and the demo-owned state their parts', () => {
    const doc = upgradeLayout(V1_DOC);
    const live = { symbol: 'GOOGL', color: '#0f0', bars: [] };
    app.comparisons = [live];
    const report = applyLayout(doc, { keepView: false });
    expect(report.applied).toBe(true);
    expect(app.chart.restored).toHaveLength(1);
    expect(app.chart.restored[0].viewport).toBeUndefined();
    expect(app.activeIndicators).toEqual([{ indicatorId: 'rsi', settings: { length: 14 } }]);
    expect(app.draw.fromJSON).toHaveBeenCalledWith(doc.drawings);
    expect(setVolumeShown).toHaveBeenCalledWith(false);
    expect(removeComparison).toHaveBeenCalledWith(live);
    expect(app.comparisons).toEqual([{ symbol: 'MSFT', color: '#f00', bars: [] }]);
    expect(syncComparisons).toHaveBeenCalledTimes(1);
  });

  it('keeps the view on the same dataset and adopts comparisons only onto an empty chart', () => {
    const doc = upgradeLayout(V1_DOC);
    const live = { symbol: 'GOOGL', color: '#0f0', bars: [] };
    app.comparisons = [live];
    applyLayout(doc, { keepView: true, replaceComparisons: false });
    expect(app.chart.restored[0].viewport).toEqual({ from: 10, to: 90 });
    expect(app.comparisons).toEqual([live]);
    expect(removeComparison).not.toHaveBeenCalled();
    expect(syncComparisons).not.toHaveBeenCalled();
    app.comparisons = [];
    applyLayout(doc, { keepView: true, replaceComparisons: false });
    expect(app.comparisons).toEqual([{ symbol: 'MSFT', color: '#f00', bars: [] }]);
    expect(syncComparisons).not.toHaveBeenCalled();
  });

  it('reports a refused state through the toast and leaves the rest alone', () => {
    app.chart.restoreState = () => ({ applied: false, series: [], indicators: 0, reason: 'nope' });
    const report = applyLayout(upgradeLayout(V1_DOC));
    expect(report.applied).toBe(false);
    expect(app.draw.fromJSON).not.toHaveBeenCalled();
    expect(toastsShown(dom)[0]).toContain('nope');
    app.chart = null;
    expect(applyLayout(upgradeLayout(V1_DOC)).reason).toBe('no chart');
  });
});

describe('layout files', () => {
  let dom;
  let app;
  let store;
  beforeEach(() => {
    dom = fakeDom();
    store = storageWithKeys();
    app = freshApp();
    initPersist(app);
    vi.clearAllMocks();
  });

  it('exports the document in a named wrapper the importer accepts either way', () => {
    const { filename, text } = exportLayout();
    expect(filename).toMatch(/^openalgo-charts-layout-AAPL_1d_1y-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
    const parsed = JSON.parse(text);
    expect(parsed.app).toContain('openalgo-charts');
    expect(parsed.layout.schema).toBe(LAYOUT_SCHEMA);
    expect(parseLayoutFile(text)).toEqual(parsed.layout);
    expect(parseLayoutFile(JSON.stringify(parsed.layout))).toEqual(parsed.layout);
    // A 1.x file is upgraded on the way in, like a 1.x storage entry.
    expect(parseLayoutFile(JSON.stringify(V1_DOC)).drawings.version).toBe(2);
    expect(() => parseLayoutFile('nope')).toThrow(LayoutError);
    expect(() => parseLayoutFile('[1,2]')).toThrow(LayoutError);
    expect(() => parseLayoutFile(JSON.stringify({ layout: { schema: 99 } }))).toThrow(/newer demo/);
  });

  it('imports a file, applies it and keeps it', async () => {
    const doc = { ...upgradeLayout(V1_DOC), dataset: 'MSFT|1h|1mo' };
    expect(await importLayoutFile(JSON.stringify({ layout: doc }))).toBe(true);
    // Captured on another dataset: the workspace comes over, the view does not.
    expect(app.chart.restored[0].viewport).toBeUndefined();
    expect(app.draw.fromJSON).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get(LAYOUT_KEY)).schema).toBe(LAYOUT_SCHEMA);
    expect(toastsShown(dom).pop()).toContain('imported');
    // Garbage is reported, not thrown, and changes nothing.
    expect(await importLayoutFile('{oops')).toBe(false);
    expect(app.chart.restored).toHaveLength(1);
    expect(toastsShown(dom).pop()).toContain('not a layout');
  });
});
