/**
 * Renko bricks (ARCHITECTURE.md §6A). Each fixed box-size move of the close
 * emits one brick. Renders with the candlestick renderer (brick = a body).
 * Simplified single-box step (no 2× reversal rule) — deterministic and
 * incremental for live updates.
 */
import type { Bar } from '../model/bar';
import type { ISeriesTransform } from './transform';

export interface RenkoOptions {
  boxSize: number;
}

export class RenkoTransform implements ISeriesTransform {
  private readonly _box: number;
  private _edge = NaN; // price level of the last brick's far edge

  public constructor(options: RenkoOptions) {
    if (options.boxSize <= 0) throw new Error('openalgo-charts: Renko boxSize must be > 0');
    this._box = options.boxSize;
  }

  public reset(): void {
    this._edge = NaN;
  }

  public push(bar: Bar): Bar[] {
    const p = bar.close;
    const out: Bar[] = [];
    if (Number.isNaN(this._edge)) {
      this._edge = Math.floor(p / this._box) * this._box; // anchor, no brick yet
      return out;
    }
    while (p >= this._edge + this._box) {
      const lo = this._edge;
      const hi = this._edge + this._box;
      out.push({ time: bar.time, open: lo, high: hi, low: lo, close: hi }); // up brick (close>open)
      this._edge = hi;
    }
    while (p <= this._edge - this._box) {
      const hi = this._edge;
      const lo = this._edge - this._box;
      out.push({ time: bar.time, open: hi, high: hi, low: lo, close: lo }); // down brick (close<open)
      this._edge = lo;
    }
    return out;
  }
}
