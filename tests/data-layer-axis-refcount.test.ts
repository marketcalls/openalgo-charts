/**
 * The shared time axis kept in step with its series (src/model/data-layer.ts).
 *
 * Every series on a chart shares one logical-index axis, the union of their
 * times. It used to be rebuilt from scratch on every bulk load: every time of
 * every series collected and sorted again, so re-sending one series cost the
 * whole chart's history and re-sending each of a chart's series in turn cost
 * the square of it. A host that refreshes its panes, and an indicator that
 * re-merges its plots, sends the same times back almost every time. The axis
 * now tracks how many series hold each time and changes only where one comes
 * or goes.
 */
import { describe, it, expect } from 'vitest';
import { DataLayer } from '../src/model/data-layer';
import type { Bar } from '../src/model/bar';

const bar = (time: number, c = 100): Bar => ({ time, open: c, high: c + 1, low: c - 1, close: c });

/** The axis as the union of every series' times, computed the obvious way. */
function expectedAxis(series: Map<number, Bar[]>): number[] {
  const times = new Set<number>();
  for (const bars of series.values()) for (const b of bars) times.add(b.time);
  return Array.from(times).sort((a, b) => a - b);
}

function expectAxis(dl: DataLayer, series: Map<number, Bar[]>): void {
  const want = expectedAxis(series);
  expect(dl.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    expect(dl.indexToTime(i)).toBe(want[i]);
    expect(dl.timeToIndex(want[i])).toBe(i);
  }
  for (const [id, bars] of series) {
    expect(dl.seriesBars(id).map((b) => b.time)).toEqual(bars.map((b) => b.time));
  }
}

/** A small deterministic generator, so a failure replays exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('data layer time axis', () => {
  it('matches the union of its series through any sequence of edits', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = rng(seed);
      const pick = (n: number): number => Math.floor(r() * n);
      const dl = new DataLayer();
      // What each series should hold, mirrored with the layer's own rules:
      // sorted, one bar per time, the later bar winning.
      const mirror = new Map<number, Bar[]>();
      const upsert = (list: Bar[], add: Bar[]): Bar[] => {
        const byTime = new Map<number, Bar>();
        for (const b of list) byTime.set(b.time, b);
        for (const b of add) byTime.set(b.time, b);
        return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
      };
      const randomBars = (): Bar[] => {
        const out: Bar[] = [];
        const n = pick(30);
        for (let k = 0; k < n; k++) out.push(bar(pick(60) * 10));
        return out;
      };
      for (let step = 0; step < 400; step++) {
        const ids = Array.from(mirror.keys());
        const op = ids.length === 0 ? 0 : pick(6);
        if (op === 0) {
          const id = dl.createSeries();
          const bars = randomBars();
          dl.setSeriesData(id, bars);
          mirror.set(id, upsert([], bars));
        } else if (op === 1) {
          const id = ids[pick(ids.length)];
          // Often the same times again, the refresh this change is for.
          const bars = r() < 0.5 ? mirror.get(id)!.map((b) => bar(b.time, 101)) : randomBars();
          dl.setSeriesData(id, bars);
          mirror.set(id, upsert([], bars));
        } else if (op === 2) {
          const id = ids[pick(ids.length)];
          const bars = randomBars();
          dl.addBars(id, bars);
          mirror.set(id, upsert(mirror.get(id)!, bars));
        } else if (op === 3 || op === 4) {
          // A live bar: past the end, on the last bar, or into history.
          const id = ids[pick(ids.length)];
          const list = mirror.get(id)!;
          const last = list[list.length - 1]?.time ?? 0;
          const time = op === 3 ? last + pick(3) * 10 : pick(70) * 10;
          dl.update(id, bar(time));
          mirror.set(id, upsert(list, [bar(time)]));
        } else {
          const id = ids[pick(ids.length)];
          dl.removeSeries(id);
          mirror.delete(id);
        }
        expectAxis(dl, mirror);
      }
    }
  });

  it('re-sends one series without reading the others', () => {
    let reads = 0;
    const counted = (time: number): Bar => {
      const b = bar(time);
      Object.defineProperty(b, 'time', { get: () => { reads++; return time; }, enumerable: true });
      return b;
    };
    const n = 2_000;
    const dl = new DataLayer();
    const others: number[] = [];
    for (let s = 0; s < 6; s++) {
      const id = dl.createSeries();
      const bars: Bar[] = [];
      for (let i = 0; i < n; i++) bars.push(counted(i * 60));
      dl.setSeriesData(id, bars);
      others.push(id);
    }
    const id = dl.createSeries();
    const fresh = (): Bar[] => Array.from({ length: n }, (_, i) => bar(i * 60, 100 + i));
    dl.setSeriesData(id, fresh());

    reads = 0;
    dl.setSeriesData(id, fresh());

    // The series re-sent is plain; every read counted is another series' bar.
    expect(reads).toBe(0);
    expect(dl.length).toBe(n);
  });

  it('keeps indices before a change and drops a time no series holds', () => {
    const dl = new DataLayer();
    const a = dl.createSeries();
    const b = dl.createSeries();
    dl.setSeriesData(a, [bar(10), bar(20), bar(30)]);
    dl.setSeriesData(b, [bar(20), bar(40)]);
    expect([0, 1, 2, 3].map((i) => dl.indexToTime(i))).toEqual([10, 20, 30, 40]);

    // 40 is held only by b; 20 by both.
    dl.setSeriesData(b, [bar(20)]);
    expect(dl.length).toBe(3);
    expect(dl.timeToIndex(40)).toBeUndefined();
    expect(dl.timeToIndex(30)).toBe(2);

    dl.removeSeries(a);
    expect(dl.length).toBe(1);
    expect(dl.timeToIndex(20)).toBe(0);
    expect(dl.timeToIndex(10)).toBeUndefined();
  });
});
