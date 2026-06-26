/**
 * Streaming footprint aggregator (ARCHITECTURE.md §6A, §9.4). Ingests classified
 * trade ticks (price, qty, bid/ask) and aggregates them into footprint bars on a
 * timeframe (interval / tick-count / volume) — the live orderflow pipeline.
 * Incremental: the current bar updates per tick; a new bar opens at the boundary.
 *
 * Requires classified bid/ask trade ticks. OpenAlgo doesn't store these by
 * default, so feed it from a live WS classifier or a tick-recorder backend.
 */
import type { FootprintBar, FootprintCell } from './profile-model';
import { bucketPrice } from './profile-model';
import type { ClassifiedTrade } from './footprint';
import type { TickTimeframe } from '../feed/tick-aggregator';

export interface FootprintTick extends ClassifiedTrade {
  time: number;
}

export interface FootprintUpdate {
  bar: FootprintBar;
  isNew: boolean;
}

export class FootprintAggregator {
  private readonly _tf: TickTimeframe;
  private readonly _tickSize: number;
  private _time = 0;
  private _cells = new Map<number, FootprintCell>();
  private _delta = 0;
  private _count = 0;
  private _volume = 0;
  private _open = false;

  public constructor(tf: TickTimeframe, tickSize: number) {
    this._tf = tf;
    this._tickSize = tickSize;
  }

  private _snapshot(): FootprintBar {
    const cells = Array.from(this._cells.values()).sort((a, b) => b.price - a.price);
    return { time: this._time, cells, delta: this._delta };
  }

  public current(): FootprintBar | null {
    return this._open ? this._snapshot() : null;
  }

  private _intervalKey(time: number): number {
    if (this._tf.mode !== 'interval') return 0;
    const a = this._tf.anchorSec ?? 0;
    return a + Math.floor((time - a) / this._tf.seconds) * this._tf.seconds;
  }

  public onTick(tick: FootprintTick): FootprintUpdate {
    let startNew = !this._open;
    if (this._open) {
      if (this._tf.mode === 'interval') startNew = this._intervalKey(tick.time) !== this._time;
      else if (this._tf.mode === 'ticks') startNew = this._count >= this._tf.count;
      else startNew = this._volume >= this._tf.perBar;
    }

    if (startNew) {
      this._cells = new Map();
      this._delta = 0;
      this._count = 0;
      this._volume = 0;
      this._open = true;
      this._time = this._tf.mode === 'interval' ? this._intervalKey(tick.time) : tick.time;
    }

    const price = bucketPrice(tick.price, this._tickSize);
    let cell = this._cells.get(price);
    if (cell === undefined) { cell = { price, bidVol: 0, askVol: 0 }; this._cells.set(price, cell); }
    if (tick.side === 'bid') { cell.bidVol += tick.qty; this._delta -= tick.qty; }
    else { cell.askVol += tick.qty; this._delta += tick.qty; }
    this._count += 1;
    this._volume += tick.qty;

    return { bar: this._snapshot(), isNew: startNew };
  }
}
