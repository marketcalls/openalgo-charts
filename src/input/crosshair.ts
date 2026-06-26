/**
 * Crosshair state + magnet snapping (ARCHITECTURE.md §6). Pure helpers so the
 * snap logic is unit-testable; drawing lives in render/crosshair.ts.
 */
import type { Bar } from '../model/bar';

export type CrosshairMode = 'normal' | 'magnet';

export interface CrosshairState {
  visible: boolean;
  /** Media-px position on the plot. */
  x: number;
  y: number;
  /** Logical index under the cursor (rounded). */
  index: number;
  /** Price under the cursor (after any magnet snap). */
  price: number;
}

export const HIDDEN_CROSSHAIR: CrosshairState = {
  visible: false, x: 0, y: 0, index: 0, price: 0,
};

/** Return whichever of the bar's O/H/L/C values is closest to `price`. */
export function magnetSnapPrice(price: number, bar: Bar): number {
  const candidates = [bar.open, bar.high, bar.low, bar.close];
  let best = candidates[0];
  let bestDist = Math.abs(price - best);
  for (let i = 1; i < candidates.length; i++) {
    const d = Math.abs(price - candidates[i]);
    if (d < bestDist) {
      bestDist = d;
      best = candidates[i];
    }
  }
  return best;
}
