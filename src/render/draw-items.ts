/**
 * The draw items one series hands its renderer each frame, built without
 * allocating per bar.
 *
 * The series pass runs on every frame of a pan, a zoom or a live tick, and it
 * used to build two fresh objects for every visible bar each time: the
 * data layer's `{ index, bar }` pair and the renderer's `{ x, bar }` item, and
 * the autoscale walk built the pairs again. Nothing kept any of it past the
 * frame; it was garbage for the collector at the rate of the frame times the
 * bars in view (scripts/bench-pane.mjs measures it). Here the visible bars are
 * walked in place and written into items owned by the series, reused from one
 * frame to the next.
 *
 * Contract for a renderer or a render backend: `items`, and the objects in it,
 * are valid until the same series is drawn again. Anything kept longer has to
 * be copied.
 */
import type { Bar } from '../model/bar';
import type { DrawItem } from '../model/chart-type-registry';
import type { DataLayer, SeriesId } from '../model/data-layer';
import type { TimeScale } from '../scale/time-scale';
import { createLodColumns, type LodKind } from '../model/conflation';

/** Where the visible bars of one series start, and the last time they may carry. */
export interface VisibleSpan {
  start: number;
  lastTime: number;
}

/**
 * Find the bars of `bars` whose logical index lies within [from, to], the way
 * `DataLayer.visibleBars` does, without building its list: `out.start` is the
 * first candidate and `out.lastTime` the time past which none is in view.
 * Returns false when nothing can be.
 *
 * A caller walks `bars` from `start` while `time <= lastTime` and keeps the
 * bars `timeToIndex` answers for, which is the list `visibleBars` returns,
 * in the same order.
 */
export function visibleSpan(layer: DataLayer, bars: readonly Bar[], from: number, to: number, out: VisibleSpan): boolean {
  const lo = Math.max(0, Math.floor(from));
  const hi = Math.min(layer.baseIndex, Math.ceil(to));
  if (hi < lo || bars.length === 0) return false;
  const loTime = layer.indexToTime(lo);
  const hiTime = layer.indexToTime(hi);
  if (loTime === undefined || hiTime === undefined) return false;
  let start = 0;
  let end = bars.length;
  while (start < end) {
    const mid = (start + end) >> 1;
    if (bars[mid].time < loTime) start = mid + 1;
    else end = mid;
  }
  out.start = start;
  out.lastTime = hiTime;
  return true;
}

/** The level of detail a frame asks for: the reduction, and the ratio and factor its columns follow. */
export interface LodRequest {
  kind: LodKind;
  dpr: number;
  factor: number;
}

/** Placeholder bar for a pooled item not in this frame; never drawn. */
const NO_BAR: Bar = { time: 0, open: NaN, high: NaN, low: NaN, close: NaN };

/** Items a series keeps however far the view zooms back in: a wide plot's worth. */
const POOL_KEEP = 4096;

/** Scratch for the visible walk: `build` runs start to end without yielding, so one serves every series. */
const SPAN: VisibleSpan = { start: 0, lastTime: 0 };

/** What maps a price to media-px y: a price scale. */
interface PriceMapper {
  priceToY(price: number): number;
}

export interface SeriesDrawItems {
  /** This frame's items, in drawing order. The same array every frame. */
  readonly items: DrawItem[];
  /**
   * Maps with the scale the last `build` was given. One function for the life
   * of the series, so the renderer's call to it keeps a single target and the
   * compiler can fold it in, rather than a new closure every frame.
   */
  readonly priceToY: (price: number) => number;
  /** Logical index of the first bar in view in the last `build`, or -1 when none was. */
  firstIndex(): number;
  /**
   * Fill `items` with the bars of series `id` whose logical index, shifted by
   * `shift`, lands in [from + shift, to + shift], each at the x its shifted
   * index maps to. With `lod`, the bars go through the level of detail on the
   * way and `items` holds its columns instead.
   */
  build(
    layer: DataLayer, id: SeriesId, from: number, to: number, shift: number, timeScale: TimeScale,
    scale: PriceMapper, lod: LodRequest | null,
  ): DrawItem[];
}

/**
 * One series' draw items. A closure rather than a class, for the same reason
 * as `createLodColumns`: its state costs the bundle a letter a name.
 */
export function createSeriesDrawItems(): SeriesDrawItems {
  const items: DrawItem[] = [];
  /** Item objects, reused: the first `count` of them are this frame's. */
  const pool: DrawItem[] = [];
  let count = 0, first = -1;
  let mapper: PriceMapper | null = null;
  const push = (x: number, bar: Bar): void => {
    const n = count++;
    let item = pool[n];
    if (item === undefined) {
      // `prevClose` is present from the start, so setting it on the first
      // item later never reshapes the object.
      item = { x: 0, bar: NO_BAR, prevClose: undefined };
      pool.push(item);
    }
    item.x = x;
    item.bar = bar;
    item.prevClose = undefined;
    items[n] = item;
  };
  const lodColumns = createLodColumns(push);
  return {
    items,
    priceToY: (price: number): number => (mapper as PriceMapper).priceToY(price),
    firstIndex: (): number => first,
    build(layer, id, from, to, shift, timeScale, scale, lod): DrawItem[] {
      mapper = scale;
      count = 0;
      first = -1;
      const bars = layer.seriesBars(id);
      if (visibleSpan(layer, bars, from, to, SPAN)) {
        const last = SPAN.lastTime;
        if (lod !== null) lodColumns.begin(lod.kind, lod.dpr, lod.factor);
        for (let i = SPAN.start; i < bars.length; i++) {
          const bar = bars[i];
          if (bar.time > last) break;
          const index = layer.timeToIndex(bar.time);
          if (index === undefined) continue;
          if (first < 0) first = index;
          const x = timeScale.indexToX(index + shift);
          if (lod !== null) lodColumns.push(x, bar);
          else push(x, bar);
        }
        if (lod !== null) lodColumns.end();
      }
      if (items.length !== count) {
        // Items this frame did not reach let go of their bars, so a pool sized
        // for yesterday's history does not keep that history alive.
        for (let i = count; i < items.length; i++) pool[i].bar = NO_BAR;
        items.length = count;
      }
      // A view zoomed back in from a very wide one gives the spare items back.
      if (pool.length > POOL_KEEP && count * 4 < pool.length) pool.length = Math.max(POOL_KEEP, count * 2);
      return items;
    },
  };
}
