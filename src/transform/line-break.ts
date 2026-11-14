/**
 * Line Break (ARCHITECTURE.md §6A). A new line forms only when the close breaks
 * beyond the extreme of the prior N lines (default 3). Renders with the
 * candlestick renderer (each line = a body). Incremental.
 */
import type { Bar } from '../model/bar';
import { addVolume, copyState, isPriced, withVolume, type ISeriesTransform } from './transform';

export interface LineBreakOptions {
  /** Prior lines a close must break to draw a new one. Below 1 counts as 1. */
  lines: number;
}

interface LineBox {
  open: number;
  close: number;
}

export class LineBreakTransform implements ISeriesTransform {
  private readonly _n: number;
  private _lines: LineBox[] = [];
  /** Volume of the bars pushed since the last line (transform.ts addVolume). */
  private _volume = NaN;

  public constructor(options: LineBreakOptions = { lines: 3 }) {
    this._n = Math.max(1, options.lines);
  }

  public reset(): void {
    this._lines = [];
    this._volume = NaN;
  }

  public clone(): LineBreakTransform {
    const copy = copyState(this);
    copy._lines = this._lines.slice(); // at most the lines a break is judged against
    return copy;
  }

  public push(bar: Bar): Bar[] {
    if (!isPriced(bar)) return [];
    const p = bar.close;
    this._volume = addVolume(this._volume, bar);
    if (this._lines.length === 0) {
      this._lines.push({ open: p, close: p });
      return [];
    }
    const recent = this._lines.slice(-this._n);
    let maxHigh = -Infinity;
    let minLow = Infinity;
    for (const l of recent) {
      maxHigh = Math.max(maxHigh, l.open, l.close);
      minLow = Math.min(minLow, l.open, l.close);
    }
    const last = this._lines[this._lines.length - 1]!; // never empty here: that case returned above
    let box: LineBox | null = null;
    if (p > maxHigh) box = { open: last.close, close: p };
    else if (p < minLow) box = { open: last.close, close: p };
    if (box === null) return [];
    this._lines.push(box);
    // Only the last N lines decide a break, so the rest are dropped: a copy per
    // live tick then costs N lines, not every line since the history began.
    if (this._lines.length > this._n) this._lines.splice(0, this._lines.length - this._n);
    const line = withVolume({ time: bar.time, open: box.open, high: Math.max(box.open, box.close), low: Math.min(box.open, box.close), close: box.close }, this._volume);
    this._volume = NaN;
    return [line];
  }
}
