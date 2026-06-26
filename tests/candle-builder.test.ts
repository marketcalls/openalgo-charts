import { describe, it, expect } from 'vitest';
import { CandleBuilder } from '../src/feed/candle-builder';

describe('CandleBuilder bucketing', () => {
  it('opens a new bar at each interval boundary and updates within', () => {
    const cb = new CandleBuilder({ intervalSec: 60, volumeMode: 'ltq-sum' });
    const a = cb.onTick({ time: 0, price: 10, ltq: 5 })!; // bucket 0
    expect(a.isNew).toBe(true);
    expect(a.bar).toMatchObject({ time: 0, open: 10, high: 10, low: 10, close: 10, volume: 5 });

    const b = cb.onTick({ time: 30, price: 12, ltq: 3 })!; // still bucket 0
    expect(b.isNew).toBe(false);
    expect(b.bar).toMatchObject({ open: 10, high: 12, low: 10, close: 12, volume: 8 });

    const c = cb.onTick({ time: 60, price: 9, ltq: 2 })!; // bucket 60 → new bar
    expect(c.isNew).toBe(true);
    expect(c.bar).toMatchObject({ time: 60, open: 9, high: 9, low: 9, close: 9, volume: 2 });
  });

  it('aligns buckets to a session anchor (e.g. 09:15 open)', () => {
    const anchor = 555; // arbitrary session-open second
    const cb = new CandleBuilder({ intervalSec: 300, sessionAnchorSec: anchor });
    expect(cb.bucketStart(anchor)).toBe(anchor);
    expect(cb.bucketStart(anchor + 299)).toBe(anchor);
    expect(cb.bucketStart(anchor + 300)).toBe(anchor + 300);
  });
});

describe('CandleBuilder volume modes', () => {
  it('ltq-sum accumulates last-traded quantity', () => {
    const cb = new CandleBuilder({ intervalSec: 60, volumeMode: 'ltq-sum' });
    cb.onTick({ time: 0, price: 1, ltq: 10 });
    const u = cb.onTick({ time: 30, price: 1, ltq: 15 })!;
    expect(u.bar.volume).toBe(25);
  });

  it('day-delta diffs cumulative day volume (not the raw cumulative)', () => {
    const cb = new CandleBuilder({ intervalSec: 60, volumeMode: 'day-delta' });
    cb.onTick({ time: 0, price: 1, cumDayVolume: 1000 }); // first bar
    const same = cb.onTick({ time: 30, price: 1, cumDayVolume: 1250 })!;
    expect(same.bar.volume).toBe(250); // 1250 - 1000
    const next = cb.onTick({ time: 60, price: 1, cumDayVolume: 1400 })!;
    expect(next.isNew).toBe(true);
    expect(next.bar.volume).toBe(150); // 1400 - 1250 (new bar starts from prior cum)
  });

  it('day-delta handles the daily cumulative reset gracefully', () => {
    const cb = new CandleBuilder({ intervalSec: 60, volumeMode: 'day-delta' });
    cb.onTick({ time: 0, price: 1, cumDayVolume: 5000 });
    const afterReset = cb.onTick({ time: 60, price: 1, cumDayVolume: 80 })!; // new day, cum reset
    expect(afterReset.bar.volume).toBe(80); // not negative
  });
});

describe('CandleBuilder late ticks & seam', () => {
  it('drops ticks older than the current bar when policy is dropOlderThanPrevBar', () => {
    const cb = new CandleBuilder({ intervalSec: 60, lateTickPolicy: 'dropOlderThanPrevBar' });
    cb.onTick({ time: 600, price: 10, ltq: 1 }); // bucket 600
    const late = cb.onTick({ time: 500, price: 99, ltq: 1 }); // older bucket 480 < 600
    expect(late).toBeNull();
    expect(cb.current()!.close).toBe(10); // unaffected
  });

  it('folds late ticks into the current bar when policy is foldIntoBar', () => {
    const cb = new CandleBuilder({ intervalSec: 60, lateTickPolicy: 'foldIntoBar' });
    cb.onTick({ time: 600, price: 10, ltq: 1 });
    const folded = cb.onTick({ time: 500, price: 15, ltq: 1 })!;
    expect(folded.isNew).toBe(false);
    expect(folded.bar.high).toBe(15); // extended by the late high
  });

  it('seeds from the last historical bar so the first tick continues it', () => {
    const cb = new CandleBuilder({ intervalSec: 60, volumeMode: 'ltq-sum' });
    cb.seed({ time: 600, open: 10, high: 12, low: 9, close: 11, volume: 100 });
    const u = cb.onTick({ time: 630, price: 13, ltq: 5 })!; // same bucket 600
    expect(u.isNew).toBe(false);
    expect(u.bar).toMatchObject({ open: 10, high: 13, close: 13, volume: 105 });
  });
});
