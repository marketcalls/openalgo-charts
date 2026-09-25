import type { InstrumentKey } from 'openalgo-charts';
import { list, number, readJson, record, string, WorkspaceDocumentError, type Json } from './json';
import { createIndexedDbCatalogStorage, type IndexedDbCatalogStorage } from './indexed-db';

/** Lists per namespace and entries per list. A watchlist is a shortlist, not a symbol master. */
const MAX_LISTS = 100;
const MAX_ENTRIES = 500;

/** One saved instrument. Both parts are opaque: never case-folded or parsed. */
export type WatchlistEntry = InstrumentKey;

export interface Watchlist {
  id: string;
  name: string;
  entries: WatchlistEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface WatchlistCatalog {
  version: 1;
  revision: number;
  lists: Watchlist[];
  activeListId: string | null;
}

export interface WatchlistOperationOptions {
  /** Cancellation is effective until the storage transaction commits. */
  signal?: AbortSignal;
  /**
   * Refuse the change when the catalog has moved past this revision. Pass the
   * revision a position-based edit (a move) was computed from, so it cannot
   * land on a list another session has reordered.
   */
  expectedRevision?: number;
}

/** The host must atomically reject writes whose expectedRevision is stale. */
export interface WatchlistStorage {
  read(namespace: string): Promise<unknown | null>;
  write(namespace: string, catalog: WatchlistCatalog, expectedRevision: number, options?: WatchlistOperationOptions): Promise<void>;
}

export interface WatchlistRepositoryOptions { now?: () => number; id?: () => string }

/**
 * What a watchlist panel calls. `WatchlistRepository` implements it; a host
 * with its own server-side lists can implement it directly instead.
 */
export interface WatchlistStore {
  load(): Promise<WatchlistCatalog>;
  /**
   * Called after each change this store commits, before that change's promise
   * resolves, as `WatchlistRepository` does: the panel computes a following
   * move from the catalog delivered here. Returns the unsubscribe.
   */
  subscribe(listener: (catalog: WatchlistCatalog) => void): () => void;
  createList(name: string, entries?: readonly WatchlistEntry[], options?: WatchlistOperationOptions): Promise<Watchlist>;
  renameList(id: string, name: string, options?: WatchlistOperationOptions): Promise<Watchlist>;
  duplicateList(id: string, name: string, options?: WatchlistOperationOptions): Promise<Watchlist>;
  removeList(id: string, options?: WatchlistOperationOptions): Promise<void>;
  setActiveList(id: string | null, options?: WatchlistOperationOptions): Promise<void>;
  addEntry(id: string, entry: WatchlistEntry, options?: WatchlistOperationOptions & { index?: number }): Promise<Watchlist>;
  removeEntry(id: string, entry: WatchlistEntry, options?: WatchlistOperationOptions): Promise<Watchlist>;
  moveEntry(id: string, entry: WatchlistEntry, index: number, options?: WatchlistOperationOptions): Promise<Watchlist>;
}

export class WatchlistConflictError extends Error {
  constructor() { super('The saved watchlists changed in another session. Reload and retry.'); this.name = 'WatchlistConflictError'; }
}

/**
 * The identity of an entry as one string. JSON of the pair rather than a
 * joined "exchange:symbol", because an opaque symbol may itself contain the
 * separator and two different instruments would then share a key.
 */
export function watchlistKey(entry: InstrumentKey): string {
  return JSON.stringify([entry.symbol, entry.exchange]);
}

function parseEntry(input: Json): WatchlistEntry {
  const source = record(input, 'watchlist entry');
  return { symbol: string(source.symbol, 'symbol', 64), exchange: string(source.exchange, 'exchange', 32, true) };
}

function parseEntries(input: Json | undefined): WatchlistEntry[] {
  const entries = list(input, 'watchlist entries', MAX_ENTRIES).map(parseEntry);
  if (new Set(entries.map(watchlistKey)).size !== entries.length) throw new WorkspaceDocumentError('Duplicate watchlist entry');
  return entries;
}

function parseList(input: Json): Watchlist {
  const source = record(input, 'watchlist');
  const createdAt = number(source.createdAt, 'createdAt', 0);
  return {
    id: string(source.id, 'watchlist ID', 100), name: string(source.name, 'name', 120), entries: parseEntries(source.entries),
    createdAt, updatedAt: number(source.updatedAt, 'updatedAt', createdAt),
  };
}

/** Parse the complete catalog before any mutation; corrupt storage is never replaced. */
export function parseWatchlistCatalog(input: unknown): WatchlistCatalog {
  const source = record(readJson(input), 'watchlist catalog');
  if (source.version !== 1) throw new WorkspaceDocumentError('Unsupported watchlist catalog version');
  const lists = list(source.lists, 'watchlists', MAX_LISTS).map(parseList);
  const ids = new Set(lists.map(item => item.id));
  if (ids.size !== lists.length) throw new WorkspaceDocumentError('Duplicate watchlist ID');
  const activeListId = source.activeListId === null ? null : string(source.activeListId, 'active watchlist ID', 100);
  if (activeListId !== null && !ids.has(activeListId)) throw new WorkspaceDocumentError('Active watchlist is missing');
  return { version: 1, revision: number(source.revision, 'catalog revision', 0, Number.MAX_SAFE_INTEGER, true), lists, activeListId };
}

const emptyCatalog = (): WatchlistCatalog => ({ version: 1, revision: 0, lists: [], activeListId: null });
const describe = (entry: WatchlistEntry): string => entry.exchange === '' ? entry.symbol : `${entry.symbol} on ${entry.exchange}`;
const copy = <T>(value: T): T => readJson(value) as T;

/**
 * Named symbol lists with serialized, revision-checked writes. Each change is
 * applied to the catalog as stored at that moment, so an edit made in another
 * session survives; only a write racing it is refused, as a conflict. Create a
 * new repository when the account changes.
 */
export class WatchlistRepository implements WatchlistStore {
  private readonly _storage: WatchlistStorage;
  private readonly _namespace: string;
  private readonly _now: () => number;
  private readonly _id: () => string;
  private readonly _listeners = new Set<(catalog: WatchlistCatalog) => void>();
  private _queue: Promise<void> = Promise.resolve();

  constructor(storage: WatchlistStorage, namespace: string, options: WatchlistRepositoryOptions = {}) {
    this._storage = storage;
    this._namespace = string(namespace, 'storage namespace');
    this._now = options.now ?? Date.now;
    this._id = options.id ?? (() => {
      if (!globalThis.crypto?.randomUUID) throw new WorkspaceDocumentError('Supply an ID factory when crypto.randomUUID is unavailable');
      return globalThis.crypto.randomUUID();
    });
  }

  get namespace(): string { return this._namespace; }

  async load(): Promise<WatchlistCatalog> {
    await this._queue;
    return this._read();
  }

  subscribe(listener: (catalog: WatchlistCatalog) => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  async createList(name: string, entries: readonly WatchlistEntry[] = [], options?: WatchlistOperationOptions): Promise<Watchlist> {
    const title = string(name, 'name', 120);
    const parsed = parseEntries(readJson(entries));
    return this._transact(catalog => {
      const now = this._now();
      const doc: Watchlist = { id: this._newId(catalog), name: title, entries: parsed, createdAt: now, updatedAt: now };
      catalog.lists.push(doc);
      return doc;
    }, options);
  }

  async renameList(id: string, name: string, options?: WatchlistOperationOptions): Promise<Watchlist> {
    const title = string(name, 'name', 120);
    return this._transact(catalog => this._touch(this._find(catalog, id), doc => { doc.name = title; }), options);
  }

  async duplicateList(id: string, name: string, options?: WatchlistOperationOptions): Promise<Watchlist> {
    const title = string(name, 'name', 120);
    return this._transact(catalog => {
      const source = this._find(catalog, id);
      const now = this._now();
      const doc: Watchlist = { id: this._newId(catalog), name: title, entries: source.entries.map(entry => ({ ...entry })), createdAt: now, updatedAt: now };
      catalog.lists.push(doc);
      return doc;
    }, options);
  }

  async removeList(id: string, options?: WatchlistOperationOptions): Promise<void> {
    return this._transact(catalog => {
      const doc = this._find(catalog, id);
      catalog.lists = catalog.lists.filter(item => item !== doc);
      if (catalog.activeListId === doc.id) catalog.activeListId = null;
    }, options);
  }

  async setActiveList(id: string | null, options?: WatchlistOperationOptions): Promise<void> {
    return this._transact(catalog => { catalog.activeListId = id === null ? null : this._find(catalog, id).id; }, options);
  }

  async addEntry(id: string, entry: WatchlistEntry, options: WatchlistOperationOptions & { index?: number } = {}): Promise<Watchlist> {
    const item = parseEntry(readJson(entry));
    return this._transact(catalog => this._touch(this._find(catalog, id), doc => {
      if (doc.entries.some(existing => watchlistKey(existing) === watchlistKey(item))) {
        throw new WorkspaceDocumentError(`${describe(item)} is already in this list`);
      }
      doc.entries.splice(this._index(options.index ?? doc.entries.length, doc.entries.length), 0, item);
    }), options);
  }

  async removeEntry(id: string, entry: WatchlistEntry, options?: WatchlistOperationOptions): Promise<Watchlist> {
    const item = parseEntry(readJson(entry));
    return this._transact(catalog => this._touch(this._find(catalog, id), doc => {
      doc.entries.splice(this._position(doc, item), 1);
    }), options);
  }

  async moveEntry(id: string, entry: WatchlistEntry, index: number, options?: WatchlistOperationOptions): Promise<Watchlist> {
    const item = parseEntry(readJson(entry));
    return this._transact(catalog => this._touch(this._find(catalog, id), doc => {
      const [moved] = doc.entries.splice(this._position(doc, item), 1);
      doc.entries.splice(this._index(index, doc.entries.length), 0, moved);
    }), options);
  }

  private async _read(): Promise<WatchlistCatalog> {
    const input = await this._storage.read(this._namespace);
    return input === null ? emptyCatalog() : parseWatchlistCatalog(input);
  }

  private _transact<T>(mutate: (catalog: WatchlistCatalog) => T, options: WatchlistOperationOptions = {}): Promise<T> {
    const { signal } = options;
    const expected = options.expectedRevision === undefined ? undefined
      : number(options.expectedRevision, 'expected revision', 0, Number.MAX_SAFE_INTEGER, true);
    const operation = this._queue.then(async () => {
      signal?.throwIfAborted();
      const catalog = await this._read();
      signal?.throwIfAborted();
      if (expected !== undefined && catalog.revision !== expected) throw new WatchlistConflictError();
      const revision = catalog.revision;
      const result = mutate(catalog);
      catalog.revision++;
      // Validate the entire candidate, including limits, before touching storage.
      const next = parseWatchlistCatalog(catalog);
      signal?.throwIfAborted();
      await this._storage.write(this._namespace, next, revision, { signal });
      for (const listener of Array.from(this._listeners)) {
        // A host listener failing is reported, but the write has committed and resolves.
        try { listener(copy(next)); } catch (error) { queueMicrotask(() => { throw error; }); }
      }
      return result === undefined ? result : copy(result);
    });
    this._queue = operation.then(() => {}, () => {});
    return operation;
  }

  private _find(catalog: WatchlistCatalog, id: string): Watchlist {
    const key = string(id, 'watchlist ID', 100);
    const doc = catalog.lists.find(item => item.id === key);
    if (!doc) throw new WorkspaceDocumentError('Saved watchlist does not exist');
    return doc;
  }

  private _touch(doc: Watchlist, change: (doc: Watchlist) => void): Watchlist {
    change(doc);
    doc.updatedAt = Math.max(doc.updatedAt, number(this._now(), 'current time', 0));
    return doc;
  }

  private _position(doc: Watchlist, entry: WatchlistEntry): number {
    const index = doc.entries.findIndex(existing => watchlistKey(existing) === watchlistKey(entry));
    if (index < 0) throw new WorkspaceDocumentError(`${describe(entry)} is not in this list`);
    return index;
  }

  private _index(index: number, length: number): number {
    return Math.max(0, Math.min(length, Math.trunc(number(index, 'entry index', -Number.MAX_SAFE_INTEGER))));
  }

  private _newId(catalog: WatchlistCatalog): string {
    const id = string(this._id(), 'generated watchlist ID', 100);
    if (catalog.lists.some(item => item.id === id)) throw new WorkspaceDocumentError('Generated watchlist ID collision');
    return id;
  }
}

/**
 * Revision-checked storage in memory: for tests, previews and hosts without
 * IndexedDB. Nothing outlives the page. `seed` maps namespaces to catalogs.
 */
export function createMemoryWatchlistStorage(seed: Readonly<Record<string, unknown>> = {}): WatchlistStorage {
  const values = new Map<string, unknown>(Object.entries(seed).map(([key, value]) => [key, copy(value)]));
  return {
    async read(namespace) {
      const value = values.get(string(namespace, 'storage namespace'));
      return value === undefined ? null : copy(value);
    },
    async write(namespace, catalog, expectedRevision, options) {
      options?.signal?.throwIfAborted();
      const key = string(namespace, 'storage namespace');
      const expected = number(expectedRevision, 'expected revision', 0, Number.MAX_SAFE_INTEGER, true);
      const next = parseWatchlistCatalog(catalog);
      if (next.revision !== expected + 1) throw new WorkspaceDocumentError('A write must advance the catalog revision by one');
      const previous = values.get(key);
      if ((previous === undefined ? 0 : parseWatchlistCatalog(previous).revision) !== expected) throw new WatchlistConflictError();
      values.set(key, next);
    },
  };
}

export type IndexedDbWatchlistStorage = IndexedDbCatalogStorage<WatchlistCatalog> & WatchlistStorage;

/**
 * Browser persistence with one atomic compare-and-write transaction per
 * catalog, the same contract the workspace adapter keeps. Pass the host's
 * indexedDB explicitly; importing this module needs no browser.
 */
export function createIndexedDbWatchlistStorage(factory: IDBFactory, databaseName = 'openalgo-chart-watchlists'): IndexedDbWatchlistStorage {
  return createIndexedDbCatalogStorage(factory, databaseName, 'Watchlist', parseWatchlistCatalog, () => new WatchlistConflictError());
}
