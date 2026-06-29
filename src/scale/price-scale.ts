/**
 * Price scale (ARCHITECTURE.md §5.2). Maps price ↔ y for a pane. Phase 2 ships
 * the linear mode plus tick-size-aware formatting; log/percentage/inverted and
 * overlay scales are structured for but added in later phases.
 */
import { clamp } from '../helpers/math';
import { precisionForStep } from './ticks';

export interface PriceRange {
  min: number;
  max: number;
}

/**
 * Price-scale mode. `linear` and `logarithmic` are full coordinate transforms;
 * `percentage`/`indexed-to-100` (rebase to a baseline) and overlay scales are
 * not yet implemented — see END_TO_END_AUDIT.md / README known limitations.
 */
export type PriceScaleMode = 'linear' | 'logarithmic';

export interface PriceScaleOptions {
  /** Fraction of pane height kept empty at top/bottom (default 0.1 each). */
  marginTop: number;
  marginBottom: number;
  /** Instrument tick size (minMove), e.g. 0.05. 0 → infer from range. */
  minMove: number;
  /** Linear or logarithmic price↔y mapping. */
  mode: PriceScaleMode;
  /** Flip the axis (price increases downward) — for spread/short views. */
  inverted: boolean;
}

export const DEFAULT_PRICE_SCALE_OPTIONS: PriceScaleOptions = {
  marginTop: 0.1,
  marginBottom: 0.1,
  minMove: 0,
  mode: 'linear',
  inverted: false,
};

/**
 * Pure: compute a price range from data extremes plus top/bottom margins.
 * Returns a padded [min,max]; widens a degenerate (flat) range so it's drawable.
 */
export function autoscaleRange(low: number, high: number, marginTop: number, marginBottom: number): PriceRange {
  if (!isFinite(low) || !isFinite(high)) return { min: 0, max: 1 };
  if (high <= low) {
    const pad = Math.abs(high) > 0 ? Math.abs(high) * 0.05 : 0.5;
    return { min: low - pad, max: high + pad };
  }
  const span = high - low;
  return { min: low - span * marginBottom, max: high + span * marginTop };
}

export class PriceScale {
  private _options: PriceScaleOptions;
  private _height = 0;
  private _min = 0;
  private _max = 1;
  private _autoScale = true;

  public constructor(options: Partial<PriceScaleOptions> = {}) {
    this._options = { ...DEFAULT_PRICE_SCALE_OPTIONS, ...options };
  }

  public get options(): PriceScaleOptions {
    return this._options;
  }

  public setHeight(height: number): void {
    this._height = height;
  }

  public get height(): number {
    return this._height;
  }

  public setPriceRange(range: PriceRange): void {
    this._min = range.min;
    this._max = range.max;
  }

  public priceRange(): PriceRange {
    return { min: this._min, max: this._max };
  }

  /** Whether the range tracks the data (true) or has been set manually (false). */
  public get autoScale(): boolean {
    return this._autoScale;
  }

  public setAutoScale(on: boolean): void {
    this._autoScale = on;
  }

  /**
   * Manually scale the visible range around its centre. `factor` > 1 widens the
   * range (compress / zoom out), < 1 narrows it (expand / zoom in). Switches the
   * scale to manual mode so autoscale stops overriding it.
   */
  public scaleAroundCenter(factor: number): void {
    const centre = (this._min + this._max) / 2;
    const half = ((this._max - this._min) / 2) * factor;
    this._min = centre - half;
    this._max = centre + half;
    this._autoScale = false;
  }

  /**
   * Pan the visible range vertically by `dy` media px (dragging the plot up/down).
   * Works in transformed space so it's correct for log scales, and respects
   * `inverted`. Switches to manual mode so autoscale stops overriding it.
   */
  public panByPixels(dy: number): void {
    if (this._height <= 0 || dy === 0) return;
    const lo = this._t(this._min);
    const hi = this._t(this._max);
    const span = hi - lo;
    if (!(span > 0)) return;
    // Drag down (dy>0) reveals higher prices → shift the range up; inverted flips it.
    const delta = span * ((this._options.inverted ? -dy : dy) / this._height);
    this._min = this._tInv(lo + delta);
    this._max = this._tInv(hi + delta);
    this._autoScale = false;
  }

  /** Recompute the visible range from data extremes + configured margins. */
  public autoscale(low: number, high: number): void {
    this.setPriceRange(autoscaleRange(low, high, this._options.marginTop, this._options.marginBottom));
  }

  /** Coordinate transform for the active mode (identity for linear, log10 for log). */
  private _t(v: number): number {
    return this._options.mode === 'logarithmic' ? Math.log10(Math.max(1e-10, v)) : v;
  }

  private _tInv(c: number): number {
    return this._options.mode === 'logarithmic' ? Math.pow(10, c) : c;
  }

  /** Price → y (media px). Higher price → smaller y (top of pane), unless inverted. */
  public priceToY(price: number): number {
    const lo = this._t(this._min);
    const span = this._t(this._max) - lo;
    if (span <= 0) return this._height / 2;
    const r = (this._t(price) - lo) / span; // 0 at min … 1 at max
    return this._options.inverted ? this._height * r : this._height * (1 - r);
  }

  /** y (media px) → price. */
  public yToPrice(y: number): number {
    const lo = this._t(this._min);
    const span = this._t(this._max) - lo;
    const r = this._options.inverted ? y / this._height : 1 - y / this._height;
    return this._tInv(lo + r * span);
  }

  /** Decimal precision implied by minMove (or the visible range if unset). */
  public precision(): number {
    if (this._options.minMove > 0) return precisionForStep(this._options.minMove);
    return precisionForStep((this._max - this._min) / 100);
  }

  /** Snap a price to the instrument tick size (no-op if minMove is 0). */
  public snapToTick(price: number): number {
    const step = this._options.minMove;
    if (step <= 0) return price;
    return Math.round(price / step) * step;
  }

  /** Format a price for axis/label display. */
  public format(price: number): string {
    return price.toFixed(this.precision());
  }

  /** Clamp a y to the pane (used by crosshair/order dragging). */
  public clampY(y: number): number {
    return clamp(y, 0, this._height);
  }
}
