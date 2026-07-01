import { describe, it, expect } from 'vitest';
import { DataLayer } from '../src/model/data-layer';
import type { Bar } from '../src/model/bar';

const bar = (time: number, close: number): Bar => ({ time, open: close, high: close + 1, low: close - 1, close });

describe('DataLayer.update (live hot path)', () => {
  it('mutates the last bar in place when time matches (intra-bar tick)', () => {
    const dl = new DataLayer();
    const id = dl.createSeries();
    dl.setSeriesData(id, [bar(100, 1), bar(200, 2)]);
    const kind = dl.update(id, { time: 200, open: 2, high: 5, low: 2, close: 4 });
    expect(kind).toBe('replace');
    expect(dl.length).toBe(2);
    const last = dl.indexedBars(id)[1].bar;
    expect(last).toMatchObject({ high: 5, close: 4 });
  });

  it('appends and advances baseIndex when time is newer', () => {
    const dl = new DataLayer();
    const id = dl.createSeries();
    dl.setSeriesData(id, [bar(100, 1), bar(200, 2)]);
    const kind = dl.update(id, bar(300, 3));
    expect(kind).toBe('append');
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

  it('keeps the global time axis sorted when a series-local append is not a global append', () => {
    const dl = new DataLayer();
    const a = dl.createSeries();
    const b = dl.createSeries();
    dl.setSeriesData(a, [bar(100, 1)]);
    dl.setSeriesData(b, [bar(200, 2)]);
    // 150 is newer than series A's last (100) but older than the global last (200).
    const kind = dl.update(a, bar(150, 1.5));
    expect(kind).toBe('insert'); // not a global right-edge append
    expect(dl.length).toBe(3);
    // The shared axis must stay sorted: 100 < 150 < 200.
    expect([dl.indexToTime(0), dl.indexToTime(1), dl.indexToTime(2)]).toEqual([100, 150, 200]);
    expect(dl.timeToIndex(150)).toBe(1);
    expect(dl.timeToIndex(200)).toBe(2);
  });

  it('treats a series-local append onto an existing global time as a replace', () => {
    const dl = new DataLayer();
    const a = dl.createSeries();
    const b = dl.createSeries();
    dl.setSeriesData(a, [bar(100, 1)]);
    dl.setSeriesData(b, [bar(100, 9), bar(200, 8)]);
    // 200 already exists globally (series B); for series A it is a local append.
    const kind = dl.update(a, bar(200, 2));
    expect(kind).toBe('replace');
    expect(dl.length).toBe(2); // no new global index
    expect(dl.indexedBars(a).map((x) => x.bar.time)).toEqual([100, 200]);
  });
});
