/**
 * Point & Figure (ARCHITECTURE.md §6A). Columns of X (up) / O (down); a new
 * column starts only after a reversal of `reversal` boxes. Each column is
 * encoded as a Bar spanning the column's price range, with up = close ≥ open
 * (X) and down = close < open (O). The point-figure renderer stacks the glyphs
 * using `boxSize` from the series style.
 */
import type { Bar } from '../model/bar';
import type { ISeriesTransform } from './transform';

export interface PointFigureOptions {
  boxSize: number;
  reversal: number;
}

export class PointFigureTransform implements ISeriesTransform {
  private readonly _box: number;
  private readonly _reversal: number;
  private _dir = 0; // +1 X, -1 O, 0 none
  private _topBox = NaN;
  private _botBox = NaN;
  private _time = 0;

  public constructor(options: PointFigureOptions) {
    if (options.boxSize <= 0) throw new Error('openalgo-charts: P&F boxSize must be > 0');
    this._box = options.boxSize;
    this._reversal = Math.max(1, options.reversal);
  }

  public reset(): void {
    this._dir = 0;
    this._topBox = NaN;
    this._botBox = NaN;
    this._time = 0;
  }

  private _column(): Bar {
    const top = this._topBox * this._box;
    const bot = this._botBox * this._box;
    const up = this._dir >= 0;
    return {
      time: this._time,
      open: up ? bot : top,
      close: up ? top : bot,
      high: top,
      low: bot,
    };
  }

  public push(bar: Bar): Bar[] {
    const b = Math.floor(bar.close / this._box);
    if (Number.isNaN(this._topBox)) {
      this._topBox = b;
      this._botBox = b;
      this._dir = 0;
      this._time = bar.time;
      return [];
    }
    const out: Bar[] = [];
    if (this._dir >= 0) {
      if (b > this._topBox) {
        this._topBox = b;
        this._dir = 1;
      } else if (this._topBox - b >= this._reversal) {
        out.push(this._column()); // completed X column
        this._dir = -1;
        this._topBox = this._topBox - 1;
        this._botBox = b;
        this._time = bar.time;
      }
    } else {
      if (b < this._botBox) {
        this._botBox = b;
      } else if (b - this._botBox >= this._reversal) {
        out.push(this._column()); // completed O column
        this._dir = 1;
        this._botBox = this._botBox + 1;
        this._topBox = b;
        this._time = bar.time;
      }
    }
    return out;
  }

  public flush(): Bar[] {
    if (Number.isNaN(this._topBox)) return [];
    return [this._column()];
  }
}
