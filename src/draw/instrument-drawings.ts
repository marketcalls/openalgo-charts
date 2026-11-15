/**
 * Drawings per instrument: one drawing document for each instrument a chart
 * shows, kept in a store the host chooses, and swapped as the chart moves
 * from one instrument to another.
 *
 * A trader's levels belong to the symbol they were drawn on. The controller
 * holds one document and knows nothing of instruments (the engine has no
 * instrument concept), so without this a trend line drawn on one symbol stays
 * on screen for every symbol loaded after it, and deleting it anywhere
 * deletes it everywhere.
 *
 * The rules this keeps, each of which a host would otherwise have to get right
 * on its own:
 *
 * - **The instrument comes from the chart's data context.** A `data:context`
 *   naming another symbol or exchange saves the outgoing document and loads
 *   the incoming one, in the same turn, so nothing that listens after it (an
 *   alert, a link group) ever sees one instrument's drawings under another's
 *   name. An interval or a data variant is the same instrument, and a context
 *   that names no instrument changes nothing.
 * - **A swap is not an edit.** It records no undo step, and it clears the
 *   drawing undo history the way any `fromJSON` does: a step taken on one
 *   instrument describes that instrument's drawings, and taking it back on
 *   another would put one of them there. A drag in progress is put back first
 *   and a shape half placed is dropped, with the tool left armed.
 * - **The whole document swaps**, drawings pinned to the viewport included: a
 *   group or a stacking order can span both spaces, and a note pinned to the
 *   screen is nearly always about the instrument on it. Transient drawings
 *   (`policy.persistent` false) are the host's and are not saved; a host
 *   keeping one per instrument places it again after the swap.
 * - **Every committed change is written at once**, only when the saved
 *   document actually changed, so a reload loses nothing and a stream of
 *   updates to transient drawings writes nothing. An instrument left with no
 *   drawings has its entry removed rather than an empty one kept.
 * - **A write keeps what another writer stored.** Two pages on one store and
 *   one instrument each hold the document they last read. Before writing,
 *   the stored document is read again: what this chart added, changed or
 *   deleted since it last read or wrote it goes in as it has it, and every
 *   other drawing stays as the store has it, so the later writer erases
 *   neither the other's drawings nor its deletions. A store whose writes
 *   land later does the same once more as each write lands
 *   (`InstrumentDrawings.merge`), since two writes can be made before either
 *   has landed.
 * - **A drawing stays on its pane.** Panes are slots, and a study removed or
 *   moved while an instrument is off screen shifts them under its document.
 *   Each document is written with the panes it was drawn on (`panes`: the
 *   price pane as null, any other by its studies, each by id and kind), and
 *   is put back on those panes wherever they stand now when it is read,
 *   which a chart that reports its panes and studies allows. A pane whose
 *   studies have all gone takes its drawings with it, unless a pane of the
 *   same kinds of study stands where it was (the same template applied
 *   again): another study put in its place is not given them. A layout
 *   restored over drawings that carry their panes, as `document` returns
 *   them, puts them on the panes their studies hold once it has landed.
 * - **A store that fails loses nothing for the session.** A refused write is
 *   reported through `onError` and the document is held in memory, read back
 *   from there, and written again with the next change.
 * - **Anything else that replaces the whole document** (a host's `fromJSON`,
 *   a chart layout restored) is the current instrument's new document, and is
 *   written as such.
 * - **A stored document of an earlier version is read through the migration**
 *   and written back only when something in it changes, in the version that
 *   holds it then: a version 2 document stays version 2 until a drawing in it
 *   is given an interval range, and a version 3 one keeps its ranges.
 *
 * The store is synchronous on purpose: a swap happens inside the context
 * change, and an answer arriving later would land one instrument's drawings
 * on whatever the chart shows by then. A host whose drawings live on a
 * server keeps a synchronous copy here and syncs it in the background.
 */
import type { DrawingController } from './controller';
import type { Drawing, DrawingsDocument } from './types';
import { migrateDrawings, migrateGroups } from './migrate';
import { drawingsDocumentVersion } from './intervals';

/** An instrument as a chart's data context names it. */
export interface DrawingInstrument {
  symbol?: string;
  exchange?: string;
}

/**
 * Where the documents live, one per instrument key. The host's choice:
 * `memoryDrawingStore` (the default), `webStorageDrawingStore` over a web
 * storage the host hands it, or its own. Synchronous; a throw from any
 * method, or `set` returning false, is a failure the helper reports.
 */
export interface DrawingDocumentStore {
  /** The document stored under `key`, or null (or undefined) when there is none. */
  get(key: string): unknown;
  /** Store `document` under `key`. False, or a throw, when the write did not land. */
  set(key: string, document: DrawingsDocument): boolean | void;
  /** Forget whatever is stored under `key`. */
  remove(key: string): void;
}

/** The three members of a web storage `webStorageDrawingStore` uses. */
export interface DrawingTextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The slice of the chart `InstrumentDrawings` needs. */
export interface InstrumentDrawingsChart {
  readonly isDestroyed?: boolean;
  on(event: string, handler: (payload: unknown) => void): () => void;
  getDataContext?(): Readonly<DrawingInstrument> | undefined;
  /**
   * Optional, the first two together: the panes, the studies on them and
   * the slot of the price pane. With them each document is saved with the
   * panes its drawings are on, and read back onto those panes where they
   * stand now; without them a drawing keeps its slot.
   */
  panes?(): readonly unknown[];
  /** `indicatorId`, the kind of study, lets a pane rebuilt with new ids (a template applied again) keep its drawings. */
  indicators?(): readonly { readonly id: string; readonly paneIndex: number; readonly indicatorId?: string }[];
  primaryPaneIndex?(): number;
}

/** A store operation that failed, as `InstrumentDrawingsOptions.onError` receives it. */
export interface InstrumentDrawingsError {
  operation: 'read' | 'write' | 'remove';
  key: string;
  error: unknown;
}

export interface InstrumentDrawingsOptions {
  /** Where the documents live. Default: `memoryDrawingStore()`, for the life of the page. */
  store?: DrawingDocumentStore;
  /**
   * The key an instrument's document is stored under, or null for a context
   * that names no instrument. Default `instrumentDrawingsKey`. A host that
   * wants drawings per data variant too, or one namespace per chart, says so here.
   */
  key?: (instrument: DrawingInstrument) => string | null;
  /**
   * Which document wins when the helper starts on an instrument the store
   * already holds one for while the controller holds another. `'stored'`
   * (default) loads the stored one, which is right for a chart built fresh.
   * `'live'` keeps the controller's, even an empty one, and writes it to the
   * store, for a host that has just loaded that instrument's drawings itself
   * (a layout, a chart rebuilt from the one it replaces). Either way, drawings the
   * controller holds for an instrument the store has nothing for are kept as
   * that instrument's: that is how a document saved before drawings were per
   * instrument is attached to the instrument it was drawn on.
   */
  prefer?: 'stored' | 'live';
  /** Called for every store operation that failed. The document stays in memory for the session. */
  onError?: (error: InstrumentDrawingsError) => void;
}

/** As the controller writes an empty chart, so a swap to an instrument with nothing stored compares equal. */
const EMPTY: DrawingsDocument = { version: drawingsDocumentVersion([]), drawings: [] };

/** A document with nothing in it, which is stored as no entry at all. */
const isEmpty = (document: DrawingsDocument): boolean => document.drawings.length === 0 && !document.groups?.length;

/** A study as a document's panes name it: its id, and its kind when the chart says. */
interface PaneStudy { readonly id: string; readonly indicatorId?: string }

/**
 * The panes a document was drawn on, slot by slot: null for the price pane,
 * and for any other the studies on it (none for a bare pane).
 */
type PaneKeys = ReadonlyArray<readonly PaneStudy[] | null>;

/** A document as it is stored: its drawings and the panes they were drawn on. */
type StoredDocument = DrawingsDocument & { panes?: PaneKeys };

/** `drawings` as a document, with `groups` narrowed to them. */
function documentOf(drawings: Drawing[], groups: unknown): DrawingsDocument {
  const kept = migrateGroups(groups, drawings);
  return { version: drawingsDocumentVersion(drawings), drawings, ...(kept.length ? { groups: kept } : {}) };
}

/** A study a stored pane names, or null. A document written before kinds were kept names it by its id alone. */
function paneStudy(value: unknown): PaneStudy | null {
  if (typeof value === 'string') return { id: value };
  const { id, indicatorId } = (value ?? {}) as { id?: unknown; indicatorId?: unknown };
  return typeof id !== 'string' ? null : typeof indicatorId === 'string' ? { id, indicatorId } : { id };
}

/** The panes a stored value names, or null when it names none this build reads. */
function paneKeysOf(value: unknown): PaneKeys | null {
  const panes = (value as { panes?: unknown } | null)?.panes;
  if (!Array.isArray(panes)) return null;
  const keys = panes.map(key => key === null ? null : Array.isArray(key) ? key.map(paneStudy) : undefined);
  return keys.every(key => key === null || (key !== undefined && key.every(study => study !== null))) ? keys as PaneKeys : null;
}

/** The kinds of study on a pane, in one order, or null when one of them is not known. */
function kindsOf(key: readonly PaneStudy[]): string | null {
  const kinds = key.map(study => study.indicatorId);
  return kinds.every(kind => kind !== undefined) ? kinds.sort().join('\n') : null;
}

/**
 * Where each pane of `from` stands in `to`, or -1: the price pane; else the
 * pane holding any of its studies; else, for one whose studies have all
 * gone, a pane of the same kinds no pane of `from` has claimed, its own slot
 * first, as when a template is applied again with new ids. Another kind of
 * study put in its place is not its pane. Without the kinds (a chart that
 * does not report them), a pane keeps its slot while no other claimed it.
 */
function slotsIn(from: PaneKeys, to: PaneKeys): number[] {
  const slots = from.map(key => key === null ? to.indexOf(null)
    : to.findIndex(other => other !== null && other.some(study => key.some(mine => mine.id === study.id))));
  const taken = new Set(slots);
  return slots.map((slot, i) => {
    const key = from[i];
    if (slot >= 0 || key === null || key === undefined) return slot;
    const kinds = kindsOf(key);
    const fits = (j: number): boolean => {
      const other = to[j];
      return other !== null && other !== undefined && !taken.has(j) && (kinds === null || kindsOf(other) === kinds);
    };
    const found = fits(i) ? i : kinds === null ? -1 : to.findIndex((_, j) => fits(j));
    if (found >= 0) taken.add(found);
    return found;
  });
}

/**
 * `document`, drawn on the panes `from`, put on the panes `to`: each drawing
 * on the slot its pane holds now, or gone with its pane, as a pane removed on
 * screen takes its drawings. One on a slot `from` does not name keeps it
 * while `to` has it and no pane of `from` moved onto it.
 */
function onPanes(document: DrawingsDocument, from: PaneKeys, to: PaneKeys): DrawingsDocument {
  const slots = slotsIn(from, to);
  const taken = new Set(slots);
  return documentOf(document.drawings.flatMap(d => {
    const slot = d.paneIndex < from.length ? slots[d.paneIndex]! : d.paneIndex < to.length && !taken.has(d.paneIndex) ? d.paneIndex : -1;
    return slot < 0 ? [] : [slot === d.paneIndex ? d : { ...d, paneIndex: slot }];
  }), document.groups);
}

/** A stored value as a document, on the panes `onto` when both name theirs, or the empty document for none. */
function readOnto(value: unknown, onto: PaneKeys | null): DrawingsDocument {
  if (value === null || value === undefined) return EMPTY;
  const from = onto === null ? null : paneKeysOf(value);
  const migrated = migrateDrawings(value);
  return from === null || onto === null ? migrated : onPanes(migrated, from, onto);
}

/**
 * `ours`, with what another writer stored since `base` (`theirs`): a drawing
 * this chart made, changed or deleted since `base` as `ours` has it, any
 * other as `theirs` has it, and theirs' new drawings after ours.
 */
function withTheirs(base: DrawingsDocument, ours: DrawingsDocument, theirs: DrawingsDocument): DrawingsDocument {
  const was = new Map(base.drawings.map(d => [d.id, JSON.stringify(d)]));
  const now = new Map(theirs.drawings.map(d => [d.id, d]));
  const drawings = ours.drawings.flatMap(d => {
    const before = was.get(d.id);
    if (before !== JSON.stringify(d)) return [d];
    const other = now.get(d.id);
    return other === undefined ? [] : [JSON.stringify(other) === before ? d : other];
  });
  const have = new Set(drawings.map(d => d.id));
  for (const d of theirs.drawings) if (!have.has(d.id) && !was.has(d.id)) drawings.push(d);
  return documentOf(drawings, [...ours.groups ?? [], ...theirs.groups ?? []]);
}

/**
 * The default key: the exchange and the symbol, `NSE:INFY`, or the symbol
 * alone when there is no exchange. Each part is URI-encoded, so a colon
 * inside a symbol cannot make two instruments one key. Null when the symbol
 * is missing or blank. Case is kept: the host decides whether `infy` and
 * `INFY` are one instrument, and the widget uppercases symbols itself.
 */
export function instrumentDrawingsKey(instrument: DrawingInstrument | null | undefined): string | null {
  const symbol = typeof instrument?.symbol === 'string' ? instrument.symbol.trim() : '';
  if (symbol === '') return null;
  const exchange = typeof instrument?.exchange === 'string' ? instrument.exchange.trim() : '';
  return exchange === '' ? encodeURIComponent(symbol) : `${encodeURIComponent(exchange)}:${encodeURIComponent(symbol)}`;
}

/** A store in memory, for the life of the page. Each document is kept as text, so no caller shares an object with it. */
export function memoryDrawingStore(): DrawingDocumentStore {
  const entries = new Map<string, string>();
  return {
    get: key => { const text = entries.get(key); return text === undefined ? null : JSON.parse(text) as unknown; },
    set: (key, document) => { entries.set(key, JSON.stringify(document)); return true; },
    remove: key => { entries.delete(key); },
  };
}

/**
 * A store over a web storage the host hands it (the page's `localStorage`,
 * or anything with the same three members), one JSON entry per instrument
 * under `prefix`. A text that does not parse throws from `get`, which the
 * helper reports and treats as no drawings.
 */
export function webStorageDrawingStore(storage: DrawingTextStorage, prefix: string): DrawingDocumentStore {
  return {
    get: key => { const text = storage.getItem(prefix + key); return text === null ? null : JSON.parse(text) as unknown; },
    set: (key, document) => { storage.setItem(prefix + key, JSON.stringify(document)); },
    remove: key => { storage.removeItem(prefix + key); },
  };
}

/**
 * Attach a document saved before drawings were kept per instrument (one set
 * for the whole chart) to the instrument it was saved with, so no one loses
 * the drawings they already have. It is written only when the store holds
 * nothing for that instrument yet and the document has something in it; an
 * instrument that already has its own keeps it. True when it was written.
 */
export function migrateUnscopedDrawings(store: DrawingDocumentStore, key: string | null, document: unknown): boolean {
  if (key === null) return false;
  const migrated = migrateDrawings(document);
  if (isEmpty(migrated)) return false;
  let existing: unknown;
  // A store that cannot say what it holds is not written over.
  try { existing = store.get(key); } catch { return false; }
  if (existing !== null && existing !== undefined) return false;
  try { return store.set(key, migrated) !== false; } catch { return false; }
}

/**
 * Keeps a drawing controller's document per instrument. Build it once the
 * controller exists; it follows the chart's data context from then on.
 *
 * ```ts
 * const scoped = new InstrumentDrawings(chart, draw, {
 *   store: webStorageDrawingStore(localStorage, 'my-app:drawings:'),
 * });
 * chart.setDataContext({ symbol: 'INFY', exchange: 'NSE', interval: '5m' });
 * ```
 */
export class InstrumentDrawings {
  private readonly _chart: InstrumentDrawingsChart;
  private readonly _draw: DrawingController;
  private readonly _store: DrawingDocumentStore;
  private readonly _keyOf: (instrument: DrawingInstrument) => string | null;
  private readonly _onError: ((error: InstrumentDrawingsError) => void) | undefined;
  private _key: string | null = null;
  /**
   * The current instrument's document as this chart last read or wrote it:
   * a write that changes nothing is skipped, and what another writer stored
   * since is told apart from this chart's own changes against it.
   */
  private _text: string | null = null;
  /**
   * The panes the drawings on the chart were read with, while the chart may
   * not have them yet: a document read as a widget starts, before its layout
   * lands. `text` is the document as read, `stamp` its panes as stored, and
   * `panes` those after every pane moved or removed since. Null once the
   * drawings are on the panes standing now.
   */
  private _pending: { text: string; stamp: PaneKeys; panes: Array<readonly PaneStudy[] | null> } | null = null;
  /** Documents whose write failed, by key: what the store should hold, kept for the session. */
  private readonly _held = new Map<string, string>();
  private _swapping = false;
  private _destroyed = false;
  private readonly _off: (() => void)[] = [];

  public constructor(chart: InstrumentDrawingsChart, controller: DrawingController, options: InstrumentDrawingsOptions = {}) {
    this._chart = chart;
    this._draw = controller;
    this._store = options.store ?? memoryDrawingStore();
    this._keyOf = options.key ?? instrumentDrawingsKey;
    this._onError = options.onError;
    if (chart.isDestroyed === true || controller.isDestroyed) { this._destroyed = true; return; }
    this._off.push(
      chart.on('data:context', context => this._follow(context as DrawingInstrument | undefined)),
      chart.on('drawing:change', payload => this._changed(payload)),
      chart.on('draw:restore', () => this._restored()),
      // After the controller's own listener has put the document on.
      chart.on('drawings:restore', document => this._restoredOnPanes(document)),
      chart.on('paneRemoved', value => { this._pending?.panes.splice((value as { paneIndex: number }).paneIndex, 1); }),
      chart.on('paneMoved', value => {
        const panes = this._pending?.panes, { from, to } = value as { from: number; to: number };
        if (panes !== undefined && from < panes.length && to < panes.length) [panes[from], panes[to]] = [panes[to]!, panes[from]!];
      }),
      chart.on('state:restore:end', () => this._settle()),
      chart.on('draw:destroy', payload => {
        if ((payload as { controller?: unknown } | null)?.controller === controller) this.destroy();
      }),
      chart.on('destroy', () => this.destroy()),
    );
    const key = this._keyFor(chart.getDataContext?.());
    if (key !== null) this._start(key, options.prefer ?? 'stored');
  }

  public get isDestroyed(): boolean { return this._destroyed; }

  /** The key of the instrument whose drawings are on the chart, or null before the chart has named one. */
  public key(): string | null { return this._key; }

  /**
   * Move to another instrument now, without waiting for the chart's data
   * context: for a host that does not publish one, or that switches its
   * drawings ahead of its data. A later context naming the same instrument
   * changes nothing. Null, or an instrument with no key, changes nothing.
   */
  public setInstrument(instrument: DrawingInstrument | null): void {
    if (this._destroyed || instrument === null) return;
    this._follow(instrument);
  }

  /**
   * The saved document of an instrument: the drawings on the chart for the
   * current one, the stored document for any other, on the panes standing
   * now, or null when it has none (or no key). A copy either way. The
   * current one's names the panes it is drawn on (`panes`), as it is stored,
   * so a layout restored with it puts each drawing on its study's pane.
   */
  public document(instrument: DrawingInstrument): DrawingsDocument | null {
    const key = this._keyFor(instrument);
    if (key === null) return null;
    const document = key === this._key && !this._destroyed
      ? this._stamped(this._draw.toJSON(), this._pending?.panes ?? this._panes()) : this._read(key, this._panes());
    return document === null || isEmpty(document) ? null : document;
  }

  /**
   * Replace one instrument's drawings, drawn on the panes standing now, or
   * on those it names (`panes`, as stored). On the current instrument that
   * is the controller's `fromJSON`, which clears its undo history; on any
   * other, the stored document, shown when the chart next moves there. For a
   * layout that brings the drawings of an instrument the chart is about to show.
   */
  public setDocument(instrument: DrawingInstrument, document: unknown): void {
    const key = this._keyFor(instrument);
    if (this._destroyed || key === null) return;
    const panes = key === this._key ? this._pending?.panes ?? this._panes() : this._panes();
    if (key === this._key) { this._draw.fromJSON(readOnto(document, panes)); return; }
    this._write(key, this._stamped(readOnto(document, panes), panes));
  }

  /**
   * The document to store when another writer may have stored one since
   * `base`, the stored document `ours` was made from: each drawing `ours`
   * added, changed or deleted since `base` as `ours` has it, every other as
   * `theirs` (what the store holds now) has it, on the panes `ours` names.
   * For a store whose writes land later than they are made, so that two
   * writes made before either landed keep both: the widget's own store
   * merges each write as it lands. Since 2.7.3.
   */
  public static merge(base: unknown, ours: unknown, theirs: unknown): DrawingsDocument {
    const panes = paneKeysOf(ours);
    const merged = withTheirs(readOnto(base, panes), migrateDrawings(ours), readOnto(theirs, panes));
    return panes === null ? merged : { ...merged, panes: [...panes] } as StoredDocument;
  }

  /** Write the current instrument's document now, and any the store refused before. False while one is still refused. */
  public save(): boolean {
    if (this._destroyed) return this._held.size === 0;
    for (const [key, text] of [...this._held]) if (key !== this._key) this._write(key, JSON.parse(text) as StoredDocument);
    if (this._key !== null) this._saveCurrent(true);
    return this._held.size === 0;
  }

  /** Stop following the chart. The documents stay where they are. */
  public destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    for (const off of this._off.splice(0)) off();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private _keyFor(instrument: DrawingInstrument | null | undefined): string | null {
    if (instrument === null || instrument === undefined) return null;
    try { return this._keyOf(instrument); } catch { return null; }
  }

  /** The drawings the controller would save, as text. */
  private _live(): string {
    return JSON.stringify(this._draw.toJSON());
  }

  /**
   * The panes standing now: null for the price pane, its studies by id and
   * kind for any other. Null for a chart that does not report them.
   */
  private _panes(): Array<readonly PaneStudy[] | null> | null {
    const chart = this._chart;
    if (chart.panes === undefined || chart.indicators === undefined) return null;
    const panes: Array<PaneStudy[] | null> = chart.panes().map(() => []);
    for (const { id, indicatorId, paneIndex } of chart.indicators()) panes[paneIndex]?.push(indicatorId === undefined ? { id } : { id, indicatorId });
    const price = chart.primaryPaneIndex?.() ?? 0;
    if (price < panes.length) panes[price] = null;
    return panes;
  }

  /**
   * `document` as it is stored: with the panes it is drawn on, when they are
   * known and there is more than the price pane. A document stored without
   * them keeps its slots when read, which on one pane is all there is.
   */
  private _stamped(document: DrawingsDocument, panes: PaneKeys | null): StoredDocument {
    return panes === null || (panes.length === 1 && panes[0] === null) ? document : { ...document, panes: [...panes] };
  }

  /** Take `key` as the current instrument, with the drawings `prefer` picks. */
  private _start(key: string, prefer: 'stored' | 'live'): void {
    this._key = key;
    const value = this._raw(key);
    let stored = this._read(key, null, value);
    const live = this._live();
    if (stored !== null && prefer === 'stored') {
      // Onto the panes standing now when every one it is drawn on is there.
      // Otherwise the chart may not have its layout yet (a widget reads its
      // drawings first): they stay as drawn until one lands (`_settle`).
      const stamp = paneKeysOf(value), panes = this._panes();
      if (stamp !== null && panes !== null) {
        const slots = slotsIn(stamp, panes);
        if (stored.drawings.every(d => (slots[d.paneIndex] ?? -1) >= 0)) stored = onPanes(stored, stamp, panes);
        else this._pending = { text: '', stamp, panes: [...stamp] };
      }
      if (JSON.stringify(stored) !== live) this._load(stored);
      this._text = this._live();
      if (this._pending !== null) this._pending.text = this._text;
      return;
    }
    // Nothing stored for it and nothing on the chart: nothing to write.
    if (stored === null && isEmpty(JSON.parse(live) as DrawingsDocument)) { this._text = live; return; }
    // The drawings on the chart are this instrument's: a document saved
    // before there were instruments, or the one the host has just loaded.
    this._text = null;
    this._saveCurrent(false);
  }

  private _follow(context: DrawingInstrument | undefined): void {
    if (this._destroyed || this._draw.isDestroyed) return;
    const key = this._keyFor(context);
    // A context naming no instrument leaves the drawings with the last one.
    if (key === null || key === this._key) return;
    if (this._key === null) { this._start(key, 'stored'); return; }
    this._swap(key);
  }

  private _swap(next: string): void {
    const draw = this._draw;
    // The outgoing document as it stood before the gesture, which a context
    // change abandons; a shape half placed goes with it, the tool stays armed.
    draw.cancelDrag();
    const tool = draw.activeTool();
    if (tool !== null) draw.setTool(tool, { space: draw.activeToolSpace() });
    this._saveCurrent(false);
    this._key = next;
    this._pending = null;
    const stored = this._read(next, this._panes());
    this._load(stored ?? EMPTY);
    // A listener on the load (a link group bringing a peer's newer copy) can
    // have changed what is on the chart: that is this instrument's too.
    const live = this._live();
    this._text = stored === null ? JSON.stringify(EMPTY) : JSON.stringify(stored);
    if (live !== this._text) this._saveCurrent(false);
  }

  /** Put `document` on the controller without the change it announces being written back. */
  private _load(document: DrawingsDocument): void {
    this._swapping = true;
    try { this._draw.fromJSON(document); }
    finally { this._swapping = false; }
  }

  private _changed(payload: unknown): void {
    if (this._swapping || this._destroyed || this._key === null || this._draw.isDestroyed) return;
    // An edit is made on the panes standing now, and the document is theirs from then on.
    if ((payload as { step?: unknown } | null)?.step !== undefined) this._pending = null;
    this._saveCurrent(false);
  }

  /**
   * The whole document was replaced. When it is the one read (a layout
   * restored over it), it is still on the panes it was read with; anything
   * else is drawn on the panes standing now.
   */
  private _restored(): void {
    const pending = this._pending;
    if (this._swapping || pending === null) return;
    if (this._live() === pending.text) pending.panes = [...pending.stamp];
    else this._pending = null;
  }

  /**
   * A layout restored with drawings that name their panes (`document`'s, as
   * the widget restores a state over the drawings on the chart): they are
   * on those panes, and go onto the panes their studies hold once the layout
   * has landed (`_settle`), wherever it puts them.
   */
  private _restoredOnPanes(document: unknown): void {
    const stamp = paneKeysOf(document);
    if (stamp === null || this._swapping || this._destroyed || this._key === null || this._pending !== null) return;
    this._pending = { text: this._live(), stamp, panes: [...stamp] };
  }

  /** A layout has landed: drawings read before it go onto its panes. */
  private _settle(): void {
    const pending = this._pending;
    if (pending === null) return;
    this._pending = null;
    const panes = this._panes();
    if (panes === null || this._key === null || this._destroyed) return;
    const live = this._draw.toJSON();
    const placed = onPanes(live, pending.panes, panes);
    if (JSON.stringify(placed) !== JSON.stringify(live)) this._load(placed);
    // A write made while panes moved under the document named the panes before the move.
    this._saveCurrent(JSON.stringify(pending.panes) !== JSON.stringify(pending.stamp));
  }

  /** Write the current document when it changed, or always when `force`. */
  private _saveCurrent(force: boolean): void {
    const key = this._key;
    if (key === null) return;
    const text = this._live();
    if (!force && text === this._text && !this._held.has(key)) return;
    if (this._write(key, this._outgoing(key, text))) this._text = text;
  }

  /**
   * What the current instrument's entry is to hold: the drawings on the
   * chart, with whatever another writer stored since this chart last read or
   * wrote it (see the module notes), and the panes they are drawn on. A store
   * that cannot say what it holds, or that refused this chart's last write
   * and so does not hold what it was read against, is written as this chart
   * has it.
   */
  private _outgoing(key: string, text: string): StoredDocument {
    const ours = JSON.parse(text) as DrawingsDocument;
    const panes = this._pending?.panes ?? this._panes();
    if (this._text === null || this._held.has(key)) return this._stamped(ours, panes);
    let value: unknown;
    try { value = this._store.get(key); } catch (error) { this._report('read', key, error); return this._stamped(ours, panes); }
    const theirs = this._read(key, panes, value) ?? EMPTY;
    return this._stamped(withTheirs(JSON.parse(this._text) as DrawingsDocument, ours, theirs), panes);
  }

  /** Store `document` under `key`; true when it landed. */
  private _write(key: string, document: StoredDocument): boolean {
    const operation = isEmpty(document) ? 'remove' : 'write';
    try {
      if (operation === 'remove') this._store.remove(key);
      else if (this._store.set(key, document) === false) throw new Error('The drawing store refused the write');
      this._held.delete(key);
      return true;
    } catch (error) {
      this._held.set(key, JSON.stringify(document));
      this._report(operation, key, error);
      return false;
    }
  }

  /** What the store holds for `key`, a held write first, or null. */
  private _raw(key: string): unknown {
    const held = this._held.get(key);
    if (held !== undefined) return JSON.parse(held) as unknown;
    try { return this._store.get(key); }
    catch (error) { this._report('read', key, error); return null; }
  }

  /**
   * The stored document for `key` (or the stored `value` given), migrated to
   * the current shape and put on the panes `onto` when given, or null.
   */
  private _read(key: string, onto: PaneKeys | null, value: unknown = this._raw(key)): DrawingsDocument | null {
    const document = readOnto(value, onto);
    return isEmpty(document) ? null : document;
  }

  private _report(operation: InstrumentDrawingsError['operation'], key: string, error: unknown): void {
    try { this._onError?.({ operation, key, error }); } catch { /* A host's report cannot undo the swap. */ }
  }
}

/** `new InstrumentDrawings(chart, controller, options)`, as a function. */
export function createInstrumentDrawings(chart: InstrumentDrawingsChart, controller: DrawingController,
  options: InstrumentDrawingsOptions = {}): InstrumentDrawings {
  return new InstrumentDrawings(chart, controller, options);
}
