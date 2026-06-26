import { describe, it, expect } from 'vitest';
import { DataLayer } from '../src/model/data-layer';
import type { Bar } from '../src/model/bar';

const bar = (time: number, close: number): Bar => ({ time, open: close, high: close + 1, low: close - 1, close });

describe('DataLayer.update (live hot path)', () => {
  it('mutates the last bar in place when time matches (intra-bar tick)', () => {
    const dl = new DataLayer();
    const id = dl.createSeries();
    dl.setSeriesData(id, [bar(100, 1), bar(200, 2)]);
    const grew = dl.update(id, { time: 200, open: 2, high: 5, low: 2, close: 4 });
    expect(grew).toBe(false);
    expect(dl.length).toBe(2);
    const last = dl.indexedBars(id)[1].bar;
    expect(last).toMatchObject({ high: 5, close: 4 });
  });

  it('appends and advances baseIndex when time is newer', () => {
    const dl = new DataLayer();
    const id = dl.createSeries();
    dl.setSeriesData(id, [bar(100, 1), bar(200, 2)]);
    const grew = dl.update(id, bar(300, 3));
    expect(grew).toBe(true);
    expect(dl.length).toBe(3);
    expect(dl.baseIndex).toBe(2);
    expect(dl.timeToIndex(300)).toBe(2);
  });

  it('upserts out-of-order ticks by time, keeping order', () => {
    const dl = new DataLayer();
    const id = dl.createSeries();
    dl.setSeriesData(id, [bar(100, 1), bar(300, 3)]);
    dl.update(id, bar(200, 2)); // older than last (300) → inserted between
    expect(dl.length).toBe(3);
    expect(dl.indexedBars(id).map((b) => b.bar.time)).toEqual([100, 200, 300]);
  });
});
