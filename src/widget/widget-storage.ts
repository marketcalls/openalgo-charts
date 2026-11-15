/**
 * The widget's persisted preferences: `WidgetStorage`, namespaced JSON over
 * a synchronous store (`localStorage`) or an asynchronous one (IndexedDB)
 * that never throws, with the journal that keeps an asynchronous store's
 * pending writes when a page goes away. The IndexedDB store itself is
 * storage.ts.
 */
import { isRecord } from '../helpers/validate';

// ── storage ────────────────────────────────────────────────────────────

/** The three calls the widget makes on a synchronous store. `localStorage` satisfies it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * A store whose calls settle later, as IndexedDB's do. The widget reads a
 * namespace from it once (`entries`) and answers every later read from that
 * copy, so its own reads stay synchronous; writes follow behind. Having an
 * `entries` method is what marks a store as asynchronous.
 */
export interface AsyncStorageLike {
  /** Every stored key that starts with `prefix`, with its value. */
  entries(prefix: string): Promise<ReadonlyArray<readonly [key: string, value: string]>>;
  /**
   * What the store holds under one key now, or null. Optional: without it
   * the widget reads that key through `entries`. The widget reads a key
   * again just before it writes a value another tab may be changing too
   * (each instrument's drawings), to merge its change into what is there.
   * Since 2.7.3.
   */
  getItem?(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /**
   * A synchronous store the writes still pending are copied to when the page
   * goes away, and read back by the next `load`, because an asynchronous
   * write started as a page closes may never land. Without one, those writes
   * are lost with the page.
   */
  readonly journal?: StorageLike | null | undefined;
  /**
   * Hear each change other users of the store make once it has landed:
   * another tab on the same database, or another widget on the page. The
   * widget keeps its copy of the namespace current with it, as a synchronous
   * store's reads are, so an instrument whose drawings another tab changed
   * opens with them rather than overwriting them with an older copy. A null
   * value is a removal. Returns the call that stops listening. Without it,
   * the copy knows only what it read at load and what it wrote itself.
   */
  subscribe?(listener: (key: string, value: string | null) => void): () => void;
}

/** A write or a read an asynchronous store refused, as `WidgetStorageOptions.onError` receives it. */
export interface WidgetStorageError {
  /**
   * `load` when the namespace could not be read, after which the session
   * keeps its changes in memory only, since writing could overwrite what was
   * never read; `write` or `remove` for one key, which is tried again with
   * the next change or `flush`.
   */
  operation: 'load' | 'write' | 'remove';
  /** The full key, or the namespace prefix for `load`. */
  key: string;
  error: unknown;
}

export interface WidgetStorageOptions {
  /** Called for each failure of an asynchronous store. The widget shows it on its status line. */
  onError?: (error: WidgetStorageError) => void;
}

/** Every key the widget writes sits under this prefix, so a host on the same origin cannot collide. */
export const STORAGE_PREFIX = 'oac-widget:';
/** The journal of a namespace sits under this prefix, outside `STORAGE_PREFIX` so no namespace can hold it. */
const JOURNAL_PREFIX = 'oac-widget-journal:';
/**
 * How long `load` waits for an asynchronous store. A store that never
 * answers (IndexedDB has been seen to hang on open) would otherwise keep the
 * widget from ever loading its chart. A merged write waits as long before it
 * lets the next writer of its key go.
 */
const LOAD_TIMEOUT_MS = 4000;
/** The lock a merged write holds on its key, the same name in every tab. */
const LOCK_PREFIX = 'oac-widget-write:';

/** One key's values merged: what this copy started from, what it has, and what the store holds. */
type WidgetStorageMerge = (base: unknown, ours: unknown, theirs: unknown) => unknown;

/** The merge each storage uses for the names it covers (`mergeOnCommit`). */
const MERGES = new WeakMap<WidgetStorage, (name: string) => WidgetStorageMerge | null>();

/**
 * Merge, rather than overwrite, the value of each name `merge` covers when
 * another writer (another tab, or another widget on the page) may change it
 * too. Each such write is read again from the store and merged into what it
 * holds as it goes out, with no other writer of that key in between, and so
 * is a journaled one the store moved past meanwhile. Set before `load`.
 * Internal: the widget's drawings and the chart grid's.
 */
export function mergeOnCommit(storage: WidgetStorage, merge: (name: string) => WidgetStorageMerge | null): void {
  MERGES.set(storage, merge);
}

/** What `flushLeaving` calls on each storage: its own `_leave`. */
const LEAVING = new WeakMap<WidgetStorage, () => void>();

/**
 * `flush` for a page or a widget going away: journaled the same way, and
 * then every change written in this call, merged names too, rather than
 * behind a wait for a lock and a fresh read that a page being torn down may
 * never finish. Internal: the widget's and the chart grid's pagehide,
 * hidden page and destroy.
 */
export function flushLeaving(storage: WidgetStorage): void {
  LEAVING.get(storage)?.();
}

/**
 * Namespaced JSON storage that never throws: a private window, a full quota
 * or a blocked store all read as "nothing saved" and write as "not kept".
 *
 * Over a synchronous store every call goes straight through. Over an
 * asynchronous one, `get`, `set` and `remove` work on a copy of the namespace
 * in memory: `load` fills it once, and each change is sent behind it, the
 * changes to one key made within one task coalesced into one write. A write
 * made before `load` settles waits for it and wins over the stored value,
 * because it is the newer of the two. A store that can say so (`subscribe`)
 * keeps the copy current with the writes other tabs land, as a synchronous
 * store's reads always were, until `close`. A name its owner merges
 * (`mergeOnCommit`) is merged into what the store holds as it is written,
 * rather than written over it.
 */
export class WidgetStorage {
  private readonly _store: StorageLike | null;
  private readonly _async: AsyncStorageLike | null;
  private readonly _ns: string;
  private readonly _journalKey: string;
  private readonly _onError: ((error: WidgetStorageError) => void) | undefined;
  /** The asynchronous namespace as last read or written, by full key, as JSON text. */
  private readonly _mirror = new Map<string, string>();
  /** Changes not sent yet, by full key: the text, or null for a remove. */
  private readonly _pending = new Map<string, string | null>();
  /** Changes sent and not settled yet. */
  private readonly _sending = new Map<string, string | null>();
  /** Changes the store refused, sent again with the next change or flush. */
  private readonly _refused = new Map<string, string | null>();
  /**
   * For each key with a change that has not landed, what the store held
   * before it as far as this copy knows (null for nothing): the base a merge
   * tells this copy's change from another writer's by, and what the journal
   * records, so the next page can tell whether the store moved on since.
   * Over a synchronous store, for a merged name, what this copy last read or
   * wrote.
   */
  private readonly _base = new Map<string, string | null>();
  /**
   * For a merged key with a change of this copy's out, what another writer
   * landed meanwhile, which reads do not answer with: a change written at
   * once as the page goes away is merged into it.
   */
  private readonly _theirs = new Map<string, string | null>();
  /** How many times each key was written at once since (`_leave`): a merged write waiting for its lock then writes nothing. */
  private readonly _overtaken = new Map<string, number>();
  private _loading: Promise<void> | null = null;
  private _loaded: boolean;
  private _memoryOnly = false;
  private _drain: Promise<void> | null = null;
  private _queued = false;
  private _journaled = false;
  /** Changes other users made, heard while the namespace was being read, applied over what it returned. */
  private readonly _heard = new Map<string, string | null>();
  private _unsubscribe: (() => void) | null = null;
  private _closed = false;
  private readonly _listeners = new Set<(name: string) => void>();
  /** Stops hearing the page's storage events, over a synchronous store someone subscribed to. */
  private _offPage: (() => void) | null = null;

  public constructor(namespace: string, store: StorageLike | AsyncStorageLike | null, options: WidgetStorageOptions = {}) {
    this._ns = STORAGE_PREFIX + namespace + ':';
    this._journalKey = JOURNAL_PREFIX + namespace;
    const isAsync = store !== null && typeof (store as Partial<AsyncStorageLike>).entries === 'function';
    this._store = isAsync ? null : store as StorageLike | null;
    this._async = isAsync ? store as AsyncStorageLike : null;
    this._loaded = !isAsync;
    this._onError = options.onError;
    LEAVING.set(this, () => this._leave());
  }

  public key(name: string): string { return this._ns + name; }

  public get(name: string): unknown {
    if (this._async !== null) {
      const text = this._mirror.get(this.key(name));
      try { return text === undefined ? null : JSON.parse(text); } catch { return null; }
    }
    if (this._store === null) return null;
    try {
      const key = this.key(name), raw = this._store.getItem(key);
      // What a merged write of the name tells this copy's change from another writer's by.
      if (this._mergeFor(key) !== null) this._base.set(key, raw);
      return raw === null ? null : JSON.parse(raw);
    } catch { return null; }
  }

  /** True when the write landed; over an asynchronous store, when it was taken to be sent. */
  public set(name: string, value: unknown): boolean {
    if (this._async !== null) {
      let text: string | undefined;
      try { text = JSON.stringify(value); } catch { return false; }
      this._queue(this.key(name), text ?? null);
      return true;
    }
    if (this._store === null) return false;
    try { this._write(this._store, this.key(name), JSON.stringify(value)); return true; } catch { return false; }
  }

  /**
   * True when the removal landed; over an asynchronous store, when it was
   * taken to be sent. A refused removal reads as false, as a refused write
   * does, so the caller can keep what it deleted rather than see it return.
   */
  public remove(name: string): boolean {
    if (this._async !== null) { this._queue(this.key(name), null); return true; }
    if (this._store === null) return false;
    try { this._store.removeItem(this.key(name)); return true; } catch { return false; }
  }

  /** Whether writes can land at all. */
  public get enabled(): boolean { return this._store !== null || this._async !== null; }

  /** Whether reads answer from what is stored: always over a synchronous store, once `load` has settled over an asynchronous one. */
  public get loaded(): boolean { return this._loaded; }

  /**
   * Read the namespace from an asynchronous store, once; later calls return
   * the same promise. Settles at once over a synchronous store. Never
   * rejects: a store that fails or does not answer within a few seconds is
   * reported through `onError`, and the session then runs on memory.
   */
  public load(): Promise<void> {
    if (this._loading === null) this._loading = this._async === null ? Promise.resolve() : this._read(this._async);
    return this._loading;
  }

  /**
   * Stop following the changes other users of an asynchronous store make.
   * Changes already taken are still sent. The widget calls it when it is
   * destroyed; a copy nobody reads again need not follow the store.
   */
  public close(): void {
    this._closed = true;
    this._listeners.clear();
    this._offPage?.();
    this._offPage = null;
    const off = this._unsubscribe;
    this._unsubscribe = null;
    try { off?.(); } catch { /* a store that fails to let go holds only a listener that now does nothing */ }
  }

  /**
   * Hear each change another user of the store makes to a key of this
   * namespace, by the key's name, once reads answer with it, for a caller
   * that keeps a state of its own read from the store: what the copy of an
   * asynchronous store follows (`AsyncStorageLike.subscribe`), or the storage
   * event the page fires when its own `localStorage` is the store. A key this
   * copy has changed and not seen land is not heard, since its own value goes
   * out after. Returns the call that stops listening; `close` stops every
   * listener. Since 2.7.3.
   */
  public subscribe(listener: (name: string) => void): () => void {
    this._listeners.add(listener);
    if (this._store !== null && this._offPage === null && !this._closed) this._offPage = storageEvents(this._store, this._ns, key => this._tell(key));
    return () => { this._listeners.delete(listener); };
  }

  /**
   * Send every change made so far now, and settle once each has landed or
   * failed. Before the sends it copies them to the store's journal, which
   * keeps them for the next page when this one goes before they land. Never
   * rejects. A merged name (`mergeOnCommit`) waits for its key's lock and a
   * fresh read; the widget's own leaving sends everything at once instead.
   */
  public async flush(): Promise<void> {
    if (this._async === null) return;
    this._writeJournal(this._async.journal);
    this._requeue();
    do await this._send(); while (this._pending.size > 0 && !this._memoryOnly);
  }

  /**
   * `text` into a synchronous store: for a merged name another writer
   * changed since this copy last read or wrote it, merged into what it holds,
   * and then told as another writer's change is, so a caller that keeps a
   * state of its own takes the other writer's part.
   */
  private _write(store: StorageLike, key: string, text: string): void {
    const merge = this._mergeFor(key);
    if (merge === null) { store.setItem(key, text); return; }
    const stored = store.getItem(key), base = this._base.get(key) ?? null;
    const next = stored === base ? text : merged(merge, base, text, stored) ?? text;
    store.setItem(key, next);
    this._base.set(key, next);
    if (next !== text) this._tell(key);
  }

  private _queue(key: string, text: string | null): void {
    // Not before the namespace is read: nothing is known of what it holds yet.
    if (this._loaded && !this._base.has(key)) this._base.set(key, this._mirror.get(key) ?? null);
    if (text === null) this._mirror.delete(key);
    else this._mirror.set(key, text);
    this._refused.delete(key);
    this._pending.set(key, text);
    if (this._queued) return;
    this._queued = true;
    queueMicrotask(() => { this._queued = false; void this._send(); });
  }

  private _requeue(): void {
    for (const [key, text] of this._refused) if (!this._pending.has(key)) this._pending.set(key, text);
    this._refused.clear();
  }

  private async _read(store: AsyncStorageLike): Promise<void> {
    // Before the read goes out, so a change landing while it runs is heard.
    if (!this._closed && typeof store.subscribe === 'function') {
      try { this._unsubscribe = store.subscribe((key, text) => this._hear(key, text)); } catch { /* the copy then knows what it read */ }
    }
    let rows: ReadonlyArray<readonly [string, string]> = [];
    try {
      rows = await within(Promise.resolve().then(() => store.entries(this._ns)), LOAD_TIMEOUT_MS);
    } catch (error) {
      this._memoryOnly = true;
      this._report('load', this._ns, error);
    }
    if (!this._memoryOnly) {
      const stored = new Map<string, string>();
      for (const row of Array.isArray(rows) ? rows : []) {
        const [key, text] = row;
        if (typeof key === 'string' && key.startsWith(this._ns) && typeof text === 'string') stored.set(key, text);
      }
      // Newest first: a change made in this session, then the journal the
      // last page left, then what the store holds.
      const journal = readJournal(store.journal, this._journalKey, this._ns);
      if (journal !== null) {
        this._journaled = true;
        for (const [key, journaled, was] of journal) {
          if (this._pending.has(key)) continue;
          // A journal that says what the store held before (2.7.3 on) is
          // replayed over that alone; one the store moved past, merged or not at all.
          const row = stored.get(key) ?? null;
          const text = was === undefined || was.includes(row) ? journaled : this._replayOver(key, was[0] ?? null, journaled, row);
          if (text === undefined) continue;
          if (text === null) this._mirror.delete(key);
          else this._mirror.set(key, text);
          this._pending.set(key, text);
        }
      }
      for (const [key, text] of stored) if (!this._pending.has(key)) this._mirror.set(key, text);
      // What a change made before the read, or replayed, goes over.
      for (const key of this._pending.keys()) if (!this._base.has(key)) this._base.set(key, stored.get(key) ?? null);
      // Heard while the read ran, so at least as new as what it returned.
      for (const [key, text] of this._heard) {
        if (this._pending.has(key)) continue;
        if (text === null) this._mirror.delete(key);
        else this._mirror.set(key, text);
      }
    }
    this._heard.clear();
    this._loaded = true;
    if (!this._memoryOnly && (this._pending.size > 0 || this._journaled)) void this._send();
  }

  /**
   * One sender at a time, in batches: a key is not sent again while its last
   * write is out, so a newer value always lands after an older one. The
   * journal goes once everything it held has landed.
   */
  private _send(): Promise<void> {
    const store = this._async;
    if (this._drain !== null || store === null) return this._drain ?? Promise.resolve();
    const drain = (async (): Promise<void> => {
      await this.load();
      while (this._pending.size > 0 && !this._memoryOnly) {
        const batch = [...this._pending];
        this._pending.clear();
        for (const [key, text] of batch) this._sending.set(key, text);
        this._settled(batch, await Promise.allSettled(batch.map(([key, text]) => Promise.resolve().then(() => this._commit(store, key, text)))));
      }
      if (this._journaled && !this._memoryOnly && this._pending.size === 0 && this._sending.size === 0 && this._refused.size === 0) {
        this._dropJournal(store.journal);
      }
    })();
    this._drain = drain;
    void drain.finally(() => {
      this._drain = null;
      // A change made as the last batch settled found this sender still busy.
      if (this._pending.size > 0 && !this._memoryOnly) void this._send();
    });
    return drain;
  }

  /**
   * Send one change, settling with the text written. A name another writer
   * may change too (`mergeOnCommit`) is read again and this copy's change
   * merged into what the store holds, holding the key's lock from the read
   * to the write, so a second writer reads what the first wrote: two changes
   * made before either landed both stay. Once the write has landed it is no
   * longer out: another writer's heard from then on is the newer (`_hear`).
   */
  private async _commit(store: AsyncStorageLike, key: string, text: string | null): Promise<string | null> {
    const merge = text === null ? null : this._mergeFor(key);
    if (text === null || merge === null) {
      await (text === null ? store.removeItem(key) : store.setItem(key, text));
      // A newer change of the key goes over this one: the store holds this one until then.
      if (this._base.has(key)) this._base.set(key, text);
      this._out(key, text);
      return text;
    }
    const overtaken = this._overtaken.get(key);
    return exclusive(LOCK_PREFIX + key, async () => {
      const base = this._base.get(key) ?? null;
      const stored = await storedText(store, key);
      // Written at once since, as the page went: this older change would land after it.
      if (this._overtaken.get(key) !== overtaken) return text;
      const next = stored === base ? text : merged(merge, base, text, stored) ?? text;
      await store.setItem(key, next);
      this._out(key, text);
      return next;
    });
  }

  /** `text` of `key` has landed: no longer out, unless a newer change of it is (`_hear`). */
  private _out(key: string, text: string | null): void {
    if (this._sending.get(key) === text) this._sending.delete(key);
  }

  /** The changes `batch` sent, settled: landed, or refused and kept to send again. */
  private _settled(batch: ReadonlyArray<readonly [string, string | null]>, results: ReadonlyArray<PromiseSettledResult<string | null>>): void {
    results.forEach((result, i) => {
      const [key, text] = batch[i]!; // one settled result per batch entry, in order
      this._out(key, text);
      if (result.status === 'fulfilled') { this._landed(key, text, result.value); return; }
      if (!this._pending.has(key)) this._refused.set(key, text);
      this._report(text === null ? 'remove' : 'write', key, result.reason);
    });
  }

  /**
   * Everything not landed, journaled, then written in this call (`flushLeaving`):
   * a merged name into what another writer was heard to land meanwhile
   * (`_theirs`), since there is no time to read the store again. A merged
   * write still waiting for its lock then writes nothing, so an older value
   * never lands over this one. Before the namespace is read nothing is sent,
   * and the journal keeps it.
   */
  private _leave(): void {
    const store = this._async;
    if (store === null || this._memoryOnly) return;
    this._writeJournal(store.journal);
    this._requeue();
    if (!this._loaded || this._pending.size === 0) return;
    const batch = [...this._pending].map(([key, text]): [string, string | null] => {
      const merge = text === null ? null : this._mergeFor(key), theirs = this._theirs.get(key);
      const next = merge === null || text === null || theirs === undefined ? text : merged(merge, this._base.get(key) ?? null, text, theirs) ?? text;
      // A hidden page goes on: its reads answer with what it wrote, theirs included.
      if (next !== text && next !== null) { this._mirror.set(key, next); this._tell(key); }
      return [key, next];
    });
    this._pending.clear();
    const sends = batch.map(([key, text]) => {
      this._sending.set(key, text);
      this._overtaken.set(key, (this._overtaken.get(key) ?? 0) + 1);
      // Issued in this call, not on a later turn the page may not reach.
      let sent: Promise<void>;
      try { sent = text === null ? store.removeItem(key) : store.setItem(key, text); } catch (error) { sent = Promise.reject(error); }
      return Promise.resolve(sent).then(() => text);
    });
    void Promise.allSettled(sends).then(results => { this._settled(batch, results); void this._send(); });
  }

  /**
   * A change landed as `written`. With nothing newer to send, the key's base
   * goes, and a merge that brought another writer's changes in is what reads
   * answer from now, and is told as theirs is, unless a newer write another
   * writer landed since has taken its place already.
   */
  private _landed(key: string, sent: string | null, written: string | null): void {
    if (this._pending.has(key) || this._refused.has(key) || this._sending.has(key)) return;
    this._base.delete(key);
    this._theirs.delete(key);
    if (written === sent || this._mirror.get(key) !== sent) return;
    if (written === null) this._mirror.delete(key);
    else this._mirror.set(key, written);
    this._tell(key);
  }

  private _mergeFor(key: string): WidgetStorageMerge | null {
    try { return MERGES.get(this)?.(key.slice(this._ns.length)) ?? null; } catch { return null; }
  }

  /**
   * A journaled change the store moved past since the journal was written:
   * the store already holds it, or another writer's newer value, which
   * stays, or for a merged name both, merged. Undefined for nothing to replay.
   */
  private _replayOver(key: string, was: string | null, journaled: string | null, row: string | null): string | undefined {
    const merge = journaled === null || row === journaled ? null : this._mergeFor(key);
    return merge === null || journaled === null ? undefined : merged(merge, was, journaled, row);
  }

  /**
   * A change another user of the store made, once it landed. A key this copy
   * has changed and not seen land keeps its own value: that write goes out
   * after, so it is the one the store keeps, or for a merged name the one
   * merged into it.
   */
  private _hear(key: unknown, text: unknown): void {
    if (this._closed || this._memoryOnly || typeof key !== 'string' || !key.startsWith(this._ns)) return;
    if (text !== null && typeof text !== 'string') return;
    if (this._pending.has(key) || this._sending.has(key) || this._refused.has(key)) {
      if (this._mergeFor(key) !== null) this._theirs.set(key, text);
      return;
    }
    if (!this._loaded) { this._heard.set(key, text); return; }
    if (text === null) this._mirror.delete(key);
    else this._mirror.set(key, text);
    this._tell(key);
  }

  private _tell(key: string): void {
    for (const listener of [...this._listeners]) {
      try { listener(key.slice(this._ns.length)); } catch { /* one listener's failure is not the copy's */ }
    }
  }

  /**
   * Each change with what the store may hold without another writer having
   * moved it on (`was`), where this copy knows: what it held before, and each
   * value of this copy's that is out. A journal whose writes landed, and that
   * could be neither removed nor emptied after, is then not replayed over the
   * newer values another writer stored since (`_replayOver`).
   */
  private _writeJournal(journal: StorageLike | null | undefined): void {
    if (journal === null || journal === undefined || this._memoryOnly) return;
    const entries: Record<string, string | null> = {};
    const was: Record<string, Array<string | null>> = {};
    let any = false;
    // Oldest first, so the newest change to a key is the one kept. A journal
    // the last page left and this one has not read yet is kept under them.
    for (const [key, text, before] of this._loaded ? [] : readJournal(journal, this._journalKey, this._ns) ?? []) {
      entries[key] = text;
      if (before !== undefined) was[key] = before;
      any = true;
    }
    for (const map of [this._refused, this._sending, this._pending]) for (const [key, text] of map) {
      entries[key] = text;
      if (this._base.has(key)) was[key] = [this._base.get(key) ?? null, ...[this._refused, this._sending, this._pending].flatMap(out => out.has(key) ? [out.get(key) ?? null] : [])];
      any = true;
    }
    if (!any) return;
    try {
      journal.setItem(this._journalKey, JSON.stringify({ version: 1, entries, was }));
      this._journaled = true;
    } catch { /* a full or blocked journal leaves the writes to land or not */ }
  }

  /**
   * Everything the journal held has landed. One that cannot be removed is
   * emptied instead: left whole, the next page would replay its values over
   * every newer write that landed since. One that can be neither is tried
   * again when the next send settles.
   */
  private _dropJournal(journal: StorageLike | null | undefined): void {
    try { journal?.removeItem(this._journalKey); } catch {
      try { journal?.setItem(this._journalKey, JSON.stringify({ version: 1, entries: {} })); } catch { return; }
    }
    this._journaled = false;
  }

  private _report(operation: WidgetStorageError['operation'], key: string, error: unknown): void {
    try { this._onError?.({ operation, key, error }); } catch { /* a host's report cannot stop the storage */ }
  }
}

/** A text or null, as a journal and a store hold values; anything else is undefined. */
const textOrNull = (value: unknown): string | null | undefined => typeof value === 'string' || value === null ? value : undefined;

/**
 * The changes a journal holds for the namespace `prefix`, each with what the
 * store held before it when the journal says (2.7.3 on), or null when there
 * is no journal.
 */
function readJournal(journal: StorageLike | null | undefined, key: string, prefix: string): Array<[string, string | null, Array<string | null> | undefined]> | null {
  if (journal === null || journal === undefined) return null;
  let raw: string | null;
  try { raw = journal.getItem(key); } catch { return null; }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) return [];
    const was = isRecord(parsed.was) ? parsed.was : {};
    const before = (value: unknown): Array<string | null> | undefined => {
      const texts = Array.isArray(value) ? value.map(textOrNull) : [];
      return texts.length > 0 && texts.every(text => text !== undefined) ? texts as Array<string | null> : undefined;
    };
    return Object.entries(parsed.entries).flatMap(([name, value]) => {
      const text = textOrNull(value);
      return name.startsWith(prefix) && text !== undefined ? [[name, text, before(was[name])]] : [];
    });
  } catch { return []; }
}

/** `merge` over three stored texts, as a text; undefined when it fails or gives nothing to store. */
function merged(merge: WidgetStorageMerge, base: string | null, ours: string, theirs: string | null): string | undefined {
  const parse = (text: string | null): unknown => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };
  try { return JSON.stringify(merge(parse(base), parse(ours), parse(theirs))); } catch { return undefined; }
}

/** What `store` holds under `key` now, past any copy of it: null for nothing. */
async function storedText(store: AsyncStorageLike, key: string): Promise<string | null> {
  if (typeof store.getItem === 'function') return textOrNull(await store.getItem(key)) ?? null;
  const rows = await store.entries(key);
  const row = (Array.isArray(rows) ? rows : []).find(entry => entry?.[0] === key);
  return typeof row?.[1] === 'string' ? row[1] : null;
}

/** Holds the lock a page without Web Locks keeps per name: the promise of its last holder. */
const turns = new Map<string, Promise<unknown>>();

/**
 * `work` with no other holder of the lock `name` running: across every tab
 * of the origin where the page has Web Locks, among the widgets on this page
 * else, or where a lock is refused (a sandboxed frame) or not granted within
 * `LOAD_TIMEOUT_MS`. A holder that does not finish within as long lets the
 * next go.
 */
function exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
  const bounded = (): Promise<T> => within(work(), LOAD_TIMEOUT_MS);
  const onPage = (): Promise<T> => {
    const turn = (turns.get(name) ?? Promise.resolve()).then(bounded, bounded);
    turns.set(name, turn);
    const done = (): void => { if (turns.get(name) === turn) turns.delete(name); };
    turn.then(done, done);
    return turn;
  };
  let ran = false;
  try {
    type Locks = { request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> };
    const locks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;
    if (typeof locks?.request !== 'function') return onPage();
    // A lock another tab never lets go of (one frozen holding it) is given up on.
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(LOAD_TIMEOUT_MS) : undefined;
    return locks.request(name, signal === undefined ? {} : { signal }, () => { ran = true; return bounded(); }).catch((error: unknown) => {
      if (ran) throw error;
      return onPage();
    });
  } catch { return onPage(); }
}

/**
 * Another tab's change to `storage` under `prefix`, from the storage event
 * the page fires for it, which only the page's own web storage does: a
 * synchronous store has no other way to say so. Returns the call that stops
 * listening. Internal, shared with storage-idb.ts.
 */
export function storageEvents(storage: StorageLike, prefix: string, heard: (key: string, value: string | null) => void): () => void {
  const win = globalThis as { addEventListener?: Window['addEventListener']; removeEventListener?: Window['removeEventListener'] };
  const changed = (event: StorageEvent): void => {
    if (event.storageArea === storage && event.key?.startsWith(prefix) === true) heard(event.key, event.newValue);
  };
  try { win.addEventListener?.('storage', changed); } catch { /* no other tab to hear from */ }
  return () => {
    try { win.removeEventListener?.('storage', changed); } catch { /* never added */ }
  };
}

/** `work`, or a rejection after `ms`. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    work.then(value => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

/** The page's `localStorage` when it exists and works, else null. */
export function defaultStorage(): StorageLike | null {
  try {
    const g = globalThis as { localStorage?: StorageLike };
    return g.localStorage !== undefined && typeof g.localStorage.getItem === 'function' ? g.localStorage : null;
  } catch { return null; }
}
