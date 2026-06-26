/**
 * Tick aggregation (ARCHITECTURE.md §10.2). Aggregates raw trade ticks into
 * bars on a chosen timeframe — clock interval, tick count, or traded volume.
 * Incremental and deterministic, so it works live and is unit-testable.
 *
 * This is the foundation for tick / volume timeframes and (with classified
 * bid/ask ticks) for the footprint aggregator. Tick-count and volume bars need
 * real trade ticks — OHLCV alone can't produce them.
 */
import type { Bar } from '../model/bar';

export type TickTimeframe =
  | { mode: 'interval'; seconds: number; anchorSec?: number }
  | { mode: 'ticks'; count: number }
  | { mode: 'volume'; perBar: number };

export interface AggTick {
  time: number;
  price: number;
  qty: number;
}

export interface BarUpdate {
  bar: Bar;
  isNew: boolean;
}

/** Decide the bucket key + whether a new tick opens a new bar for the timeframe. */
function bucketKey(tf: TickTimeframe, time: number): number {
  if (tf.mode === 'interval') {
    const a = tf.anchorSec ?? 0;
    return a + Math.floor((time - a) / tf.seconds) * tf.seconds;
  }
  return 0; // ticks/volume bars are boundary-driven, not time-keyed
}

export class TickBarAggregator {
  private readonly _tf: TickTimeframe;
  private _cur: Bar | null = null;
  private _count = 0;

  public constructor(tf: TickTimeframe) {
    this._tf = tf;
  }

  public current(): Bar | null {
    return this._cur === null ? null : { ...this._cur };
  }

  public onTick(tick: AggTick): BarUpdate {
    const open = this._cur === null;
    let startNew = open;

    if (!open && this._cur !== null) {
      if (this._tf.mode === 'interval') {
        startNew = bucketKey(this._tf, tick.time) !== this._cur.time;
      } else if (this._tf.mode === 'ticks') {
        startNew = this._count >= this._tf.count;
      } else {
        startNew = (this._cur.volume ?? 0) >= this._tf.perBar;
      }
    }

    if (startNew) {
      const time = this._tf.mode === 'interval' ? bucketKey(this._tf, tick.time) : tick.time;
      this._cur = { time, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: tick.qty };
      this._count = 1;
      return { bar: { ...this._cur }, isNew: true };
    }

    const c = this._cur as Bar;
    if (tick.price > c.high) c.high = tick.price;
    if (tick.price < c.low) c.low = tick.price;
    c.close = tick.price;
    c.volume = (c.volume ?? 0) + tick.qty;
    this._count += 1;
    return { bar: { ...c }, isNew: false };
  }
}
