/**
 * Heikin Ashi (ARCHITECTURE.md §6A). 1:1 with input bars (keeps real times);
 * renders with the candlestick renderer.
 *   haClose = (o+h+l+c)/4
 *   haOpen  = first: (o+c)/2 ; else (prevHaOpen + prevHaClose)/2
 *   haHigh  = max(h, haOpen, haClose) ; haLow = min(l, haOpen, haClose)
 */
import type { Bar } from '../model/bar';
import type { ISeriesTransform } from './transform';

export class HeikinAshiTransform implements ISeriesTransform {
  private _prevOpen = NaN;
  private _prevClose = NaN;

  public reset(): void {
    this._prevOpen = NaN;
    this._prevClose = NaN;
  }

  public push(bar: Bar): Bar[] {
    const haClose = (bar.open + bar.high + bar.low + bar.close) / 4;
    const haOpen = Number.isNaN(this._prevOpen)
      ? (bar.open + bar.close) / 2
      : (this._prevOpen + this._prevClose) / 2;
    const haHigh = Math.max(bar.high, haOpen, haClose);
    const haLow = Math.min(bar.low, haOpen, haClose);
    this._prevOpen = haOpen;
    this._prevClose = haClose;
    return [{ time: bar.time, open: haOpen, high: haHigh, low: haLow, close: haClose, volume: bar.volume }];
  }
}
