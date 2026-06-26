/**
 * Pre-trade validation (ARCHITECTURE.md §9.5). Pure guards run client-side so a
 * bad order is blocked and explained rather than round-tripping to a broker
 * rejection. Tick-size rounding, price-band, and freeze-quantity checks.
 */
import { roundToTick } from '../helpers/math';

export interface PriceBand {
  lower: number;
  upper: number;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  /** Price after tick-size snapping (when applicable). */
  price?: number;
}

export interface OrderConstraints {
  tickSize: number;
  priceBand?: PriceBand;
  /** Max quantity per single order (exchange freeze limit). */
  freezeQty?: number;
}

/** True if `price` lies within the inclusive band. */
export function withinPriceBand(price: number, band: PriceBand): boolean {
  return price >= band.lower && price <= band.upper;
}

/**
 * Validate a price + qty against constraints. Snaps price to the tick size and
 * returns the snapped value; rejects out-of-band prices and over-freeze qty.
 */
export function validateOrder(price: number, qty: number, c: OrderConstraints): ValidationResult {
  if (qty <= 0) return { ok: false, reason: 'quantity must be positive' };
  if (c.freezeQty !== undefined && qty > c.freezeQty) {
    return { ok: false, reason: `quantity ${qty} exceeds freeze limit ${c.freezeQty}` };
  }
  const snapped = roundToTick(price, c.tickSize);
  if (c.priceBand && !withinPriceBand(snapped, c.priceBand)) {
    return { ok: false, reason: `price ${snapped} outside band ${c.priceBand.lower}–${c.priceBand.upper}` };
  }
  return { ok: true, price: snapped };
}
