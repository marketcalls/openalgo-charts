/**
 * Time scale (ARCHITECTURE.md §5.1, §5.3). Maps the shared **logical index**
 * ↔ x. Because x is `index × barSpacing` (not timestamp-proportional),
 * non-trading gaps collapse automatically — weekends/holidays/session breaks
 * have no logical index, so there is no blank space to draw.
 */
import { clamp } from '../helpers/math';

export interface LogicalRange {
  from: number;
  to: number;
}

export interface TimeScaleOptions {
  barSpacing: number;
  minBarSpacing: number;
  maxBarSpacing: number;
  /** Empty bars of space kept to the right of the latest bar. */
  rightOffset: number;
}

export const DEFAULT_TIME_SCALE_OPTIONS: TimeScaleOptions = {
  barSpacing: 8,
  minBarSpacing: 1,
  maxBarSpacing: 80,
  rightOffset: 4,
};

export class TimeScale {
  private _barSpacing: number;
  private _rightOffset: number;
  private readonly _minBarSpacing: number;
  private readonly _maxBarSpacing: number;
  private _width = 0;
  private _baseIndex = 0;

  public constructor(options: Partial<TimeScaleOptions> = {}) {
    const o = { ...DEFAULT_TIME_SCALE_OPTIONS, ...options };
    this._barSpacing = o.barSpacing;
    this._rightOffset = o.rightOffset;
    this._minBarSpacing = o.minBarSpacing;
    this._maxBarSpacing = o.maxBarSpacing;
  }

  public setWidth(width: number): void {
    this._width = width;
  }

  public get width(): number {
    return this._width;
  }

  public get barSpacing(): number {
    return this._barSpacing;
  }

  public setBarSpacing(value: number): void {
    this._barSpacing = clamp(value, this._minBarSpacing, this._maxBarSpacing);
  }

  public get rightOffset(): number {
    return this._rightOffset;
  }

  public setRightOffset(value: number): void {
    this._rightOffset = value;
  }

  /** Logical index of the latest bar; the right edge anchors to baseIndex+rightOffset. */
  public setBaseIndex(index: number): void {
    this._baseIndex = index;
  }

  private _rightEdgeIndex(): number {
    return this._baseIndex + this._rightOffset;
  }

  /** Logical index → x (media px), bar center. */
  public indexToX(index: number): number {
    return this._width - (this._rightEdgeIndex() - index) * this._barSpacing;
  }

  /** x (media px) → fractional logical index. */
  public xToIndex(x: number): number {
    return this._rightEdgeIndex() - (this._width - x) / this._barSpacing;
  }

  /** Currently visible logical index range (fractional, unclamped to data). */
  public visibleRange(): LogicalRange {
    const to = this._rightEdgeIndex();
    const from = to - this._width / this._barSpacing;
    return { from, to };
  }

  /** Pan by a pixel delta (positive dx scrolls toward older bars). */
  public scrollByPixels(dx: number): void {
    this._rightOffset += dx / this._barSpacing;
  }

  /** Choose bar spacing so `barCount` bars fit the width, anchored at the right edge. */
  public fitContent(barCount: number): void {
    if (barCount <= 0 || this._width <= 0) return;
    this._baseIndex = barCount - 1;
    this._rightOffset = DEFAULT_TIME_SCALE_OPTIONS.rightOffset;
    const usable = this._width / (barCount + this._rightOffset);
    this.setBarSpacing(usable);
  }
}
