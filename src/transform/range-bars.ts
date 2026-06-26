/**
 * Range bars (ARCHITECTURE.md §6A). A new bar completes when its high−low
 * reaches the configured range. Built from the close sequence; renders with the
 * candlestick renderer. Incremental: the in-progress bar is emitted by flush().
 */
import type { Bar } from '../model/bar';
import type { ISeriesTransform } from './transform';

export interface RangeOptions {
  range: number;
}

export class RangeBarsTransform implements ISeriesTransform {
  private readonly _range: number;
  private _cur: Bar | null = null;

  public constructor(options: RangeOptions) {
    if (options.range <= 0) throw new Error('openalgo-charts: range must be > 0');
    this._range = options.range;
  }

  public reset(): void {
    this._cur = null;
  }

  public push(bar: Bar): Bar[] {
    const p = bar.close;
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
    return out;
  }

  public flush(): Bar[] {
    if (this._cur === null) return [];
    const c = this._cur;
    this._cur = null;
    return [c];
  }
}
