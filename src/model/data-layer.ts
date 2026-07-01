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
   * Apply a single live bar (ARCHITECTURE.md §4.2 hot path). Returns the kind of
   * change so the chart auto-scrolls only on a genuine right-edge append:
   * - `'append'`  → newer than the last bar (advances baseIndex)
   * - `'replace'` → same time as the last bar (intra-bar tick) or an existing time
   * - `'insert'`  → an older time inserted into history (late / out-of-order)
   */
  public update(id: SeriesId, bar: Bar): 'append' | 'replace' | 'insert' {
    const entry = this._series.get(id);
    if (entry === undefined) throw new Error(`openalgo-charts: unknown series ${id}`);
    const bars = entry.bars;
    const last = bars[bars.length - 1];
    if (last === undefined || bar.time > last.time) {
      // Newer than THIS series' last bar, so pushing keeps the series sorted.
      bars.push(bar);
      const n = this._sortedTimes.length;
      const globalLast = n > 0 ? this._sortedTimes[n - 1] : undefined;
      if (globalLast === undefined || bar.time > globalLast) {
        this._appendTime(bar.time); // genuine global right-edge append
        return 'append';
      }
      // Series-local append but NOT the global newest: the time belongs mid-axis.
      // If it already exists globally (another series has it) no new index is
      // added; otherwise reindex so _sortedTimes stays ordered.
      if (this._indexByTime.has(bar.time)) return 'replace';
      this._rebuild();
      return 'insert';
    }
    if (bar.time === last.time) {
      bars[bars.length - 1] = bar; // mutate last
      return 'replace';
    }
    // older than the last bar: replace if the time exists, else insert into history
    const i = bars.findIndex((b) => b.time === bar.time);
    if (i >= 0) {
      bars[i] = bar;
      return 'replace';
    }
    this.addBars(id, [bar]);
    return 'insert';
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

  /**
   * Bars of a series whose logical index lies within [fromIndex, toIndex].
   * Binary-searches the (time-sorted) series into the visible time window instead
   * of scanning all bars, so a full repaint costs O(log n + visible) per series,
   * not O(total bars) - the hot path called for autoscale and drawing every frame.
   */
  public visibleBars(id: SeriesId, fromIndex: number, toIndex: number): IndexedBar[] {
    const entry = this._series.get(id);
    if (entry === undefined) return [];
    const bars = entry.bars;
    const lo = Math.max(0, Math.floor(fromIndex));
    const hi = Math.min(this.baseIndex, Math.ceil(toIndex));
    if (hi < lo || bars.length === 0) return [];
    const loTime = this._sortedTimes[lo];
    const hiTime = this._sortedTimes[hi];
    if (loTime === undefined || hiTime === undefined) return [];
    // First bar with time >= loTime (bars are sorted by time).
    let start = 0;
    let end = bars.length;
    while (start < end) {
      const mid = (start + end) >> 1;
      if (bars[mid].time < loTime) start = mid + 1;
      else end = mid;
    }
    const out: IndexedBar[] = [];
    for (let i = start; i < bars.length; i++) {
      const t = bars[i].time;
      if (t > hiTime) break;
      const index = this._indexByTime.get(t);
      if (index !== undefined) out.push({ index, bar: bars[i] });
    }
    return out;
  }

  /** The last bar of a series with its shared logical index, in O(1). */
  public lastIndexedBar(id: SeriesId): IndexedBar | null {
    const entry = this._series.get(id);
    if (entry === undefined || entry.bars.length === 0) return null;
    const bar = entry.bars[entry.bars.length - 1];
    const index = this._indexByTime.get(bar.time);
    return index === undefined ? null : { index, bar };
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
