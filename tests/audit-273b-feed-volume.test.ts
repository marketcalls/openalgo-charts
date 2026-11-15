/**
 * Bar volume on a stream that carries the last-traded quantity on some frames
 * and only the day's cumulative total on others. In `ltq-sum` a frame with a
 * quantity adds it, and a frame with only a total adds what the total says
 * traded since the previous one, so switching between them never takes back
 * what was already counted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CandleBuilder } from '../src/feed/candle-builder';
import { OpenAlgoLiveDataFeed } from '../src/feed/openalgo-live';
import type { SocketLike } from '../src/feed/openalgo-ws';
import type { Bar } from '../src/model/bar';

/** A minute boundary. */
const T = 1_700_000_040;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });

function volumes(builder: CandleBuilder, ticks: { time: number; ltq?: number; cumDayVolume?: number }[]): (number | undefined)[] {
  return ticks.map(tick => builder.onTick({ price: 100, ...tick })!.bar.volume);
}

describe('ltq-sum on frames that switch between a quantity and a day total', () => {
  it('keeps the quantity counted and adds the change in the total', () => {
    expect(volumes(new CandleBuilder({ intervalSec: 60 }), [
      { time: 600, ltq: 4, cumDayVolume: 1000 },
      { time: 610, cumDayVolume: 1002 },
    ])).toEqual([4, 6]);
  });

  it('goes on counting from wherever the last frame left the bar', () => {
    expect(volumes(new CandleBuilder({ intervalSec: 60 }), [
      { time: 600, cumDayVolume: 1000 },
      { time: 605, cumDayVolume: 1003 },
      // The quantity counts, not the total: what follows is measured from here.
      { time: 610, ltq: 4, cumDayVolume: 1009 },
      { time: 615, cumDayVolume: 1010 },
      { time: 620, ltq: 2, cumDayVolume: 1012 },
      // The next bar opens on a total: what traded since the last one is its own.
      { time: 660, cumDayVolume: 1015 },
      { time: 665, ltq: 1, cumDayVolume: 1016 },
      { time: 670, cumDayVolume: 1020 },
    ])).toEqual([0, 3, 7, 8, 10, 3, 4, 8]);
  });

  it('continues a seeded bar the same way', () => {
    const builder = new CandleBuilder({ intervalSec: 60 });
    builder.seed({ time: 600, open: 100, high: 100, low: 100, close: 100, volume: 50 });
    expect(volumes(builder, [
      { time: 610, ltq: 4, cumDayVolume: 9000 },
      { time: 620, cumDayVolume: 9005 },
    ])).toEqual([54, 59]);
  });

  it('never takes back a quantity a total that lags it has not caught up with', () => {
    expect(volumes(new CandleBuilder({ intervalSec: 60 }), [
      { time: 600, ltq: 4, cumDayVolume: 1000 },
      { time: 605, ltq: 2 },
      { time: 610, cumDayVolume: 1001 },
      { time: 615, cumDayVolume: 1003 },
    ])).toEqual([4, 6, 6, 7]);
  });

  it('leaves a stream with a quantity on every frame, and one with neither field, as they were', () => {
    expect(volumes(new CandleBuilder({ intervalSec: 60 }), [
      { time: 600, ltq: 4, cumDayVolume: 1000 },
      { time: 610, ltq: 3, cumDayVolume: 1010 },
      { time: 660, ltq: 2, cumDayVolume: 1020 },
    ])).toEqual([4, 7, 2]);
    expect(volumes(new CandleBuilder({ intervalSec: 60 }), [
      { time: 600 }, { time: 610 }, { time: 660 },
    ])).toEqual([0, 0, 0]);
  });

  it('leaves day-delta reading the total alone', () => {
    expect(volumes(new CandleBuilder({ intervalSec: 60, volumeMode: 'day-delta' }), [
      { time: 600, ltq: 4, cumDayVolume: 1000 },
      { time: 610, cumDayVolume: 1002 },
      { time: 620, ltq: 9, cumDayVolume: 1003 },
    ])).toEqual([0, 2, 3]);
  });
});

describe('the packaged OpenAlgo live feed on the same frames', () => {
  it('reports the counted quantity plus the change in the total', () => {
    let socket!: SocketLike;
    const feed = new OpenAlgoLiveDataFeed({ baseUrl: '', apiKey: 'fixture', wsUrl: 'ws://feed.test', heartbeat: { timeoutMs: 0 },
      socketFactory: () => (socket = { readyState: 1, send() {}, close() {}, onopen: null, onclose: null, onmessage: null }) });
    cleanup.push(() => feed.close());
    const bars: Bar[] = [];
    feed.subscribeBars({ symbol: 'X', exchange: 'NSE', interval: '1m', from: T }, value => bars.push(value));
    socket.onmessage?.({ data: JSON.stringify({ type: 'auth', status: 'success' }) });
    const frame = (time: number, extra: object): void => socket.onmessage?.({ data: JSON.stringify({
      type: 'market_data', mode: 1, topic: 'X.NSE', data: { ltp: 100, timestamp: time, ...extra } }) });
    frame(T, { ltq: 4, volume: 1000 });
    frame(T + 10, { volume: 1002 });
    frame(T + 20, { ltq: 1, volume: 1003 });
    frame(T + 30, { volume: 1006 });
    expect(bars.map(value => value.volume)).toEqual([4, 6, 7, 10]);
  });
});
