/** Clamp `value` into the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation between `a` and `b` by fraction `t` (0..1). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Round `value` to the nearest multiple of `step` (the instrument tick size).
 * Used for snapping dragged order/SL/TP prices to a valid tick. Returns
 * `value` unchanged when `step <= 0`.
 */
export function roundToTick(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}
