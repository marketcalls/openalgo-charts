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

export interface PriceScaleOptions {
  /** Fraction of pane height kept empty at top/bottom (default 0.1 each). */
  marginTop: number;
  marginBottom: number;
  /** Instrument tick size (minMove), e.g. 0.05. 0 → infer from range. */
  minMove: number;
}

export const DEFAULT_PRICE_SCALE_OPTIONS: PriceScaleOptions = {
  marginTop: 0.1,
  marginBottom: 0.1,
  minMove: 0,
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

  /** Recompute the visible range from data extremes + configured margins. */
  public autoscale(low: number, high: number): void {
    this.setPriceRange(autoscaleRange(low, high, this._options.marginTop, this._options.marginBottom));
  }

  /** Price → y (media px). Higher price → smaller y (top of pane). */
  public priceToY(price: number): number {
    const span = this._max - this._min;
    if (span <= 0) return this._height / 2;
    return this._height * (1 - (price - this._min) / span);
  }

  /** y (media px) → price. */
  public yToPrice(y: number): number {
    const span = this._max - this._min;
    return this._min + (1 - y / this._height) * span;
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
