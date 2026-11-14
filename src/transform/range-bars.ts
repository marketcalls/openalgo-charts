/**
 * Range bars (ARCHITECTURE.md §6A). A new bar completes when its high−low
 * reaches the configured range. Built from the close sequence; renders with the
 * candlestick renderer. Incremental: the in-progress bar is emitted by flush().
 * The range is a threshold, not a fixed span: a close that jumps past it
 * completes one bar covering the whole jump, never invented bars inside it.
 */
import type { Bar } from '../model/bar';
import { addVolume, copyState, isPriced, settleVolume, withVolume, type ISeriesTransform } from './transform';

export interface RangeOptions {
  /** High-to-low span that closes a bar. The constructor throws unless it is above 0. */
  range: number;
}

export class RangeBarsTransform implements ISeriesTransform {
  private readonly _range: number;
  private _cur: Bar | null = null;
  /** Volume of the bars in the bar in progress (transform.ts addVolume). */
  private _volume = NaN;

  public constructor(options: RangeOptions) {
    if (options.range <= 0) throw new Error('openalgo-charts: range must be > 0');
    this._range = options.range;
  }

  public reset(): void {
    this._cur = null;
    this._volume = NaN;
  }

  public clone(): RangeBarsTransform {
    const copy = copyState(this);
    // The bar in progress is extended in place, so the copy needs its own.
    copy._cur = this._cur === null ? null : { ...this._cur };
    return copy;
  }

  public push(bar: Bar): Bar[] {
    if (!isPriced(bar)) return [];
    const p = bar.close;
    this._volume = addVolume(this._volume, bar);
    const out: Bar[] = [];
    if (this._cur === null) {
      this._cur = { time: bar.time, open: p, high: p, low: p, close: p };
    } else {
      this._cur.high = Math.max(this._cur.high, p);
      this._cur.low = Math.min(this._cur.low, p);
      this._cur.close = p;
      this._cur.time = bar.time;
    }
    if (this._cur.high - this._cur.low >= this._range) {
      out.push(this._cur);
      this._cur = null;
    }
    this._volume = settleVolume(out, this._volume);
    return out;
  }

  public flush(): Bar[] {
    if (this._cur === null) return [];
    const c = withVolume(this._cur, this._volume);
    this._cur = null;
    this._volume = NaN;
    return [c];
  }
}
