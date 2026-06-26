/**
 * Shared data layer (ARCHITECTURE.md §4.1). One per chart. Merges all series by
 * time onto a single logical-index space (0..N-1) so price + volume + indicator
 * panes stay aligned, and so non-trading gaps collapse (an absent time simply
 * has no logical index). Per-series rows are addressable by that shared index.
 */
import type { Bar } from './bar';

export type SeriesId = number;

interface SeriesEntry {
  /** Bars sorted ascending by time. */
  bars: Bar[];
}

export interface IndexedBar {
  index: number;
  bar: Bar;
}

export class DataLayer {
  private readonly _series = new Map<SeriesId, SeriesEntry>();
  private _sortedTimes: number[] = [];
  private readonly _indexByTime = new Map<number, number>();
  private _nextId: SeriesId = 1;

  /** Register a new series; returns its id. */
  public createSeries(): SeriesId {
    const id = this._nextId++;
    this._series.set(id, { bars: [] });
    return id;
  }

  public removeSeries(id: SeriesId): void {
    this._series.delete(id);
    this._rebuild();
  }

  /** Bulk-load (full replace) one series' data, then re-merge the time axis. */
  public setSeriesData(id: SeriesId, bars: readonly Bar[]): void {
    const entry = this._series.get(id);
    if (entry === undefined) throw new Error(`openalgo-charts: unknown series ${id}`);
    entry.bars = bars.slice().sort((a, b) => a.time - b.time);
    this._rebuild();
  }

  /**
   * Upsert bars into a series by time (used for history paging / backfill /
   * out-of-order corrections — ARCHITECTURE.md §4.2). Existing times are
   * replaced; new times are inserted; the result stays time-sorted.
   *
   * Prepending older bars shifts every existing logical index up by the
   * inserted count — callers preserve the viewport by re-reading `baseIndex`
   * (the invariant `rightEdge − index` is unchanged, so visible bars don't move).
   */
  public addBars(id: SeriesId, bars: readonly Bar[]): void {
    const entry = this._series.get(id);
    if (entry === undefined) throw new Error(`openalgo-charts: unknown series ${id}`);
    if (bars.length === 0) return;
    const byTime = new Map<number, Bar>();
    for (const b of entry.bars) byTime.set(b.time, b);
    for (const b of bars) byTime.set(b.time, b);
    entry.bars = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    this._rebuild();
  }

  /**
   * Apply a single live bar (ARCHITECTURE.md §4.2 hot path).
   * - `time === lastTime` → mutate the last bar in place (intra-bar tick)
   * - `time > lastTime`   → append a new bar (advances baseIndex)
   * - `time < lastTime`   → out-of-order upsert by time
   * Returns true if a new time point was added (the index space grew).
   */
  public update(id: SeriesId, bar: Bar): boolean {
    const entry = this._series.get(id);
    if (entry === undefined) throw new Error(`openalgo-charts: unknown series ${id}`);
    const bars = entry.bars;
    const last = bars[bars.length - 1];
    if (last === undefined || bar.time > last.time) {
      bars.push(bar);
      this._appendTime(bar.time);
      return true;
    }
    if (bar.time === last.time) {
      bars[bars.length - 1] = bar; // mutate last
      return false;
    }
    // out-of-order: upsert by time, keep sorted
    const i = bars.findIndex((b) => b.time === bar.time);
    if (i >= 0) {
      bars[i] = bar;
      return false;
    }
    this.addBars(id, [bar]);
    return this._indexByTime.has(bar.time);
  }

  private _appendTime(time: number): void {
    if (!this._indexByTime.has(time)) {
      this._indexByTime.set(time, this._sortedTimes.length);
      this._sortedTimes.push(time);
    }
  }

  /** Number of logical indices (distinct time points across all series). */
  public get length(): number {
    return this._sortedTimes.length;
  }

  /** Logical index of the latest real bar (length - 1), or -1 if empty. */
  public get baseIndex(): number {
    return this._sortedTimes.length - 1;
  }

  public indexToTime(index: number): number | undefined {
    return this._sortedTimes[index];
  }

  public timeToIndex(time: number): number | undefined {
    return this._indexByTime.get(time);
  }

  /** All bars of a series paired with their shared logical index. */
  public indexedBars(id: SeriesId): IndexedBar[] {
    const entry = this._series.get(id);
    if (entry === undefined) return [];
    const out: IndexedBar[] = [];
    for (const bar of entry.bars) {
      const index = this._indexByTime.get(bar.time);
      if (index !== undefined) out.push({ index, bar });
    }
    return out;
  }

  /** Bars of a series whose logical index lies within [fromIndex, toIndex]. */
  public visibleBars(id: SeriesId, fromIndex: number, toIndex: number): IndexedBar[] {
    const lo = Math.max(0, Math.floor(fromIndex));
    const hi = Math.min(this.baseIndex, Math.ceil(toIndex));
    const out: IndexedBar[] = [];
    for (const ib of this.indexedBars(id)) {
      if (ib.index >= lo && ib.index <= hi) out.push(ib);
    }
    return out;
  }

  private _rebuild(): void {
    const times = new Set<number>();
    for (const entry of this._series.values()) {
      for (const bar of entry.bars) times.add(bar.time);
    }
    this._sortedTimes = Array.from(times).sort((a, b) => a - b);
    this._indexByTime.clear();
    for (let i = 0; i < this._sortedTimes.length; i++) {
      this._indexByTime.set(this._sortedTimes[i], i);
    }
  }
}
