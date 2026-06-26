/**
 * Line Break (ARCHITECTURE.md §6A). A new line forms only when the close breaks
 * beyond the extreme of the prior N lines (default 3). Renders with the
 * candlestick renderer (each line = a body). Incremental.
 */
import type { Bar } from '../model/bar';
import type { ISeriesTransform } from './transform';

export interface LineBreakOptions {
  lines: number;
}

interface LineBox {
  open: number;
  close: number;
}

export class LineBreakTransform implements ISeriesTransform {
  private readonly _n: number;
  private _lines: LineBox[] = [];

  public constructor(options: LineBreakOptions = { lines: 3 }) {
    this._n = Math.max(1, options.lines);
  }

  public reset(): void {
    this._lines = [];
  }

  public push(bar: Bar): Bar[] {
    const p = bar.close;
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
    const last = this._lines[this._lines.length - 1];
    let box: LineBox | null = null;
    if (p > maxHigh) box = { open: last.close, close: p };
    else if (p < minLow) box = { open: last.close, close: p };
    if (box === null) return [];
    this._lines.push(box);
    return [{ time: bar.time, open: box.open, high: Math.max(box.open, box.close), low: Math.min(box.open, box.close), close: box.close }];
  }
}
