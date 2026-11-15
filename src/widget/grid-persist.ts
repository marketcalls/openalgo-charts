/**
 * The chart grid's persisted desk: the store behind `persist`, the debounced
 * and the prompt write after a change, the flush when the page goes away, the
 * user's chords shared by every chart, and reading the stored desk back when
 * the grid is built.
 *
 * Its own module so grid.ts carries the layout and the charts. Each function
 * takes the grid's state (`GridState`, grid.ts) and reads or writes only its
 * persistence fields besides what it names.
 */
import type { WorkspacePayload } from 'openalgo-charts/workspace';
import { InstrumentDrawings, type DrawingsDocument } from 'openalgo-charts/draw';
import { WidgetStorage } from './context';
import { flushLeaving, mergeOnCommit } from './widget-storage';
import { defaultWidgetStore } from './storage';
import { errorText, widgetText } from './localization';
import { SAVE_DEBOUNCE_MS } from './widget';
import { readChartDrawings, type ChartDrawings } from './grid-payload';
import { KEYMAP_KEY } from './keymap';
import type { Cell, ChartGridApplyReport, GridState } from './grid';

const STATE_KEY = 'grid';
/** The drawings of each chart, per instrument, beside the workspace. */
const DRAWINGS_KEY = 'grid-drawings';

/**
 * The store behind `persist`, or none. Its failures are said on the active
 * chart, and the desk follows what another tab on it saves (`heard`).
 */
export function gridStorage(s: GridState): WidgetStorage {
  const { options, text } = s;
  const store = options.persist ? (options.storage === undefined ? defaultWidgetStore() : options.storage) : null;
  const storage = new WidgetStorage(typeof options.persist === 'string' ? options.persist : 'default', store, {
    // The grid has no status line of its own; the active chart's says it. A
    // read that failed is a toast as well, as in one widget: the charts'
    // first loads take the status line over at once.
    onError: failure => {
      if (s.destroyed || s.active === null) return;
      const error = errorText(text, failure.error);
      const context = s.active.widget.context;
      if (failure.operation !== 'load') {
        context.status(widgetText(text, 'Saved chart settings could not be written: {error}', { error }), 'error');
        return;
      }
      const message = widgetText(text, 'Saved chart settings could not be read, so changes are kept for this session only: {error}', { error });
      context.status(message, 'error');
      context.toast(message, 'error');
    },
  });
  // Two tabs on one desk can each change a chart's drawings before either
  // write has landed: each goes in merged into what the other stored.
  mergeOnCommit(storage, name => (name === DRAWINGS_KEY ? mergeDrawings : null));
  // Closed with the grid, which lets go of this listener with it.
  storage.subscribe(name => heard(s, name));
  return storage;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The desk's drawings record as this tab (`ours`) and another (`theirs`)
 * changed it since `base`: a document only one of them changed as that one
 * has it, one both changed merged drawing by drawing (`InstrumentDrawings.merge`).
 */
function mergeDrawings(base: unknown, ours: unknown, theirs: unknown): unknown {
  const was = readChartDrawings(base), mine = readChartDrawings(ours), other = readChartDrawings(theirs);
  const charts: Record<string, Record<string, DrawingsDocument>> = {};
  for (const id of new Set([...was.keys(), ...mine.keys(), ...other.keys()])) {
    const docs: Record<string, DrawingsDocument> = {};
    for (const key of new Set([...(was.get(id)?.keys() ?? []), ...(mine.get(id)?.keys() ?? []), ...(other.get(id)?.keys() ?? [])])) {
      const b = was.get(id)?.get(key), o = mine.get(id)?.get(key), t = other.get(id)?.get(key);
      const doc = same(o, b) ? t : same(t, b) ? o : InstrumentDrawings.merge(b, o, t);
      if (doc !== undefined) docs[key] = doc;
    }
    if (Object.keys(docs).length > 0) charts[id] = docs;
  }
  return { version: 1, charts };
}

/** The key under which a cell's document is marked as changed here (`GridState.changed`). */
const changeKey = (cell: string, key: string): string => `${cell}\n${key}`;

/**
 * What a cell's drawing store calls for each document the chart writes:
 * changed here, from the document it replaced, unless the grid is following
 * the store. A document changed again keeps the first: the change to save is
 * everything since.
 */
export const markChanged = (s: GridState, cell: string) => (key: string, before: DrawingsDocument | undefined): void => {
  const changed = changeKey(cell, key);
  if (!s.following && !s.changed.has(changed)) s.changed.set(changed, before);
};

/**
 * Another tab saved part of the desk. Its drawings are taken at once, as
 * they are only documents; its desk waits until this page is shown again
 * (`catchUp`), since opening it rebuilds every chart. The desk this grid
 * shows already, as a tab opened on it writes it back, is nothing to open.
 */
function heard(s: GridState, name: string): void {
  if (s.destroyed || s.restoring) return;
  if (name === DRAWINGS_KEY) followDrawings(s);
  else if (name === STATE_KEY && JSON.stringify(s.storage.get(STATE_KEY)) !== JSON.stringify(s.grid.getWorkspace())) s.behind = true;
}

/**
 * Each chart takes the documents another tab saved, and shows its own
 * instrument's newer one: the next save, or an edit here, then never writes
 * the older copy back. One it has changed itself since its last save takes
 * theirs under its own change, which stays to be saved; the chart shows it
 * once it shows that instrument again.
 */
function followDrawings(s: GridState): void {
  const theirs = readChartDrawings(s.storage.get(DRAWINGS_KEY));
  s.following = true;
  try {
    for (const cell of s.cells) {
      const mine = s.drawings.get(cell.id) ?? new Map<string, DrawingsDocument>();
      s.drawings.set(cell.id, mine);
      const next = theirs.get(cell.id);
      const shown = cell.widget.instrumentDrawings?.key() ?? null;
      let reload = false;
      for (const key of new Set([...mine.keys(), ...(next?.keys() ?? [])])) {
        const document = next?.get(key), changed = changeKey(cell.id, key);
        if (same(document, mine.get(key))) continue;
        if (s.changed.has(changed)) {
          mine.set(key, InstrumentDrawings.merge(s.changed.get(changed), mine.get(key), document));
          s.changed.set(changed, document);
          continue;
        }
        if (document === undefined) mine.delete(key);
        else mine.set(key, document);
        reload ||= key === shown;
      }
      // The chart writes what it shows into `mine` with every change, so a
      // document changed there is newer than the one on the chart.
      if (reload) cell.widget.instrumentDrawings?.setDocument({ symbol: cell.widget.symbol(), exchange: cell.widget.exchange() }, mine.get(shown as string) ?? []);
    }
  } finally { s.following = false; }
}

/**
 * The page is shown again after another tab saved the desk. With nothing of
 * its own to save, the grid opens that desk as a reload would, and holds it
 * (`held`) until the user changes something, so two tabs taking turns never
 * write one desk back and forth.
 */
export function catchUp(s: GridState, apply: Apply): void {
  if (!s.behind || s.destroyed || s.restoring || s.saveTimer !== 0 || s.saveQueued || s.changed.size > 0) return;
  s.behind = false;
  const stored = s.storage.get(STATE_KEY);
  if (stored === null) return;
  s.following = true;
  let report: ChartGridApplyReport;
  try { report = apply(stored as WorkspacePayload, readChartDrawings(s.storage.get(DRAWINGS_KEY))); } finally { s.following = false; }
  if (report.applied) s.held = true;
}

/** A stream of changes (a pan, a zoom, a drag) settles before it is written. */
export function scheduleSave(s: GridState): void {
  if (s.following) return;
  s.held = false;
  if (!s.storage.enabled || s.destroyed) return;
  if (s.saveTimer !== 0) clearTimeout(s.saveTimer);
  s.saveTimer = setTimeout(() => saveNow(s), SAVE_DEBOUNCE_MS);
}

/**
 * A discrete change (a preset, a link, an instrument) is written before the
 * task ends. A write left to a timer or to the unload flush can be lost when
 * the page reloads at once: one browser engine was seen to drop storage
 * writes made while the page unloads.
 */
export function saveSoon(s: GridState): void {
  if (s.following) return;
  s.held = false;
  if (!s.storage.enabled || s.destroyed || s.saveQueued) return;
  s.saveQueued = true;
  queueMicrotask(() => { s.saveQueued = false; saveNow(s); });
}

export function saveNow(s: GridState): void {
  if (s.saveTimer !== 0) { clearTimeout(s.saveTimer); s.saveTimer = 0; }
  if (!s.storage.enabled || s.destroyed || s.held || s.restoring || s.active === null) return;
  const desk = s.storage.set(STATE_KEY, s.grid.getWorkspace());
  // Only the charts on the grid: a chart the grid dropped takes its drawings with it.
  const charts: Record<string, Record<string, DrawingsDocument>> = {};
  for (const cell of s.cells) {
    const mine = s.drawings.get(cell.id);
    if (mine !== undefined && mine.size > 0) charts[cell.id] = Object.fromEntries(mine);
  }
  const drawn = s.storage.set(DRAWINGS_KEY, { version: 1, charts });
  if (desk) s.behind = false;
  if (drawn) s.changed.clear();
  // A synchronous store refuses a write it has no room for by returning
  // false, with no error to report, so it is said here, as one widget says
  // it: once per run of refusals, not at every debounce while the store is full.
  const refused = !desk || !drawn;
  if (refused && !s.saveRefused) s.active.widget.context.status(widgetText(s.text, 'The chart layout could not be saved'), 'error');
  s.saveRefused = refused;
}

/**
 * The user's chords belong to the desk, not to one chart: one record in the
 * grid's storage, applied to every chart and passed on when a chart changes it.
 */
export function followChords(s: GridState, cell: Cell): void {
  if (s.options.shortcutsEditor === false) return;
  const km = cell.widget.context.keymap;
  km.applyOverrides(s.chords);
  cell.offs.push(km.onChange(() => {
    if (s.sharing) return;
    s.sharing = true;
    try {
      const next = km.overrides();
      s.chords = next;
      for (const other of s.cells) if (other !== cell) other.widget.context.keymap.applyOverrides(next);
      if (Object.keys(next).length === 0) s.storage.remove(KEYMAP_KEY); else s.storage.set(KEYMAP_KEY, next);
    } finally { s.sharing = false; }
  }));
}

/** The desk's chords on every chart built before the store answered. */
function shareChords(s: GridState): void {
  if (s.options.shortcutsEditor === false) return;
  s.sharing = true;
  try { for (const cell of s.cells) cell.widget.context.keymap.applyOverrides(s.chords); } finally { s.sharing = false; }
}

/**
 * A debounced save still pending when the tab closes or hides is the user's
 * last change, and so is a layout's inside autosave's quiet period; an
 * asynchronous store journals what may not land in time. Only a save still
 * pending, or one the store refused, is written: a tab left for another on
 * the same desk, or closed after it, would otherwise write its older desk
 * over the one saved there.
 */
export function leaving(s: GridState): void {
  if (s.saveTimer !== 0 || s.saveRefused) saveNow(s);
  flushLeaving(s.storage);
  s.saved?.flush();
}

type Apply = (payload: WorkspacePayload, docs: ChartDrawings) => ChartGridApplyReport;

/** The stored desk, or the preset when none can be applied. `late`: the preset was built while the store was read. */
function restore(s: GridState, late: boolean, apply: Apply): void {
  const { storage, options } = s;
  s.chords = storage.get(KEYMAP_KEY);
  // Written now, since nothing was while the store was read; the stored desk is older.
  if (s.given) { shareChords(s); saveSoon(s); return; }
  const stored = storage.get(STATE_KEY);
  s.restored = stored === null ? null : apply(stored as WorkspacePayload, readChartDrawings(storage.get(DRAWINGS_KEY)));
  // The desk just read is what the store holds: written back before the
  // user changes it, it would go over whatever another tab saved meanwhile.
  if (s.restored?.applied === true) { s.held = true; return; }
  if (!late) s.grid.setPreset(options.preset ?? '1x1');
  else {
    shareChords(s);
    // Built with no instrument, so none asked the feed for one; they load it
    // now. Before `held` is set: a symbol change clears it.
    if (options.symbol !== undefined) for (const cell of s.cells) cell.widget.setSymbol(options.symbol, options.exchange);
  }
  if (s.restored !== null) {
    // The stored desk may only be waiting for a study or chart type the page
    // registers later, so it is kept, not overwritten by this fallback.
    s.held = true;
    s.grid.active().widget.context.toast(widgetText(s.text, 'The saved layout could not be restored: {error}', { error: s.restored.reason ?? '' }), 'error');
  }
}

/** Open the stored desk now over a synchronous store, or once an asynchronous one has answered. */
export function openStoredDesk(s: GridState, apply: Apply): void {
  if (!s.restoring) { restore(s, false, apply); return; }
  s.grid.setPreset(s.options.preset ?? '1x1');
  s.root.style.visibility = 'hidden';
  s.ready = s.storage.load().then(() => {
    if (s.destroyed) return;
    s.timeframePreferences.reload();
    s.restoring = false;
    // `ready` never rejects: a desk that cannot be applied is reported, as the widget reports its own.
    try { restore(s, true, apply); } catch (error) {
      s.grid.active().widget.context.toast(widgetText(s.text, 'The saved layout could not be restored: {error}', { error: errorText(s.text, error) }), 'error');
    } finally { s.root.style.visibility = ''; }
  });
}
