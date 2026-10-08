import { WidgetStorage, type StorageLike, type AsyncStorageLike, type WidgetStorageError } from '../widget-storage';
import { defaultWidgetStore } from '../storage';

/** Docking uses the same mirror, journal, retry and subscription semantics as the grid. */
export class TerminalStorage {
  readonly shared: WidgetStorage;
  private readonly legacy: StorageLike | null;

  constructor(private readonly key: string, store: StorageLike | AsyncStorageLike | null | undefined,
    persist: boolean, onError?: (error: WidgetStorageError) => void) {
    const backend = persist ? (store === undefined ? defaultWidgetStore() : store) : null;
    this.legacy = backend === null ? null : 'entries' in backend ? backend.journal ?? null : backend;
    this.shared = new WidgetStorage(`terminal:${key}`, backend, onError === undefined ? {} : { onError });
  }

  get(): unknown {
    const current = this.shared.getRaw('layout');
    if (current !== null) return current;
    try { return this.legacy?.getItem(this.key) ?? null; } catch { return null; }
  }

  set(value: unknown): boolean { return this.shared.set('layout', value); }

  clear(): void {
    this.shared.remove('layout');
    try { this.legacy?.removeItem(this.key); } catch { /* Shared errors are reported through WidgetStorage. */ }
  }
}
