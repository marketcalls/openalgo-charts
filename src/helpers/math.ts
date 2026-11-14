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

/**
 * `x`, or the whole number it is within float noise of. A price divided by a
 * decimal step is seldom whole in binary when it is in decimal (100.3 / 0.1 is
 * 1002.9999999999999), so a count read through this reaches the level a price
 * touches exactly. Shared by the transforms' boxes and the profiles' rows.
 */
export function nearWhole(x: number): number {
  const whole = Math.round(x);
  return Math.abs(x - whole) <= 8 * Number.EPSILON * Math.max(1, Math.abs(x)) ? whole : x;
}

/** Powers of ten a level on a grid of `step` is rounded to: eight decimals, or enough more to keep levels finer than 1e-8 apart. */
export function gridScale(step: number): number {
  return 10 ** Math.max(8, Math.ceil(-Math.log10(step)) + 3);
}

/**
 * Level `index` of a grid of `step` as a price, rounded so a level is one
 * number however it was reached: Renko edges added box by box drifted, 100
 * bricks of 0.1 from 100 closing at 109.99999999999943.
 */
export function gridPrice(index: number, step: number, scale = gridScale(step)): number {
  return Math.round(index * step * scale) / scale;
}

/** A canvas size: media px, or device px for a backing buffer. */
export interface Size {
  width: number;
  height: number;
}

/**
 * Pure: compute the integer device-pixel backing-buffer size for a canvas.
 * Here rather than in core/canvas.ts so a renderer can take it by path without
 * reaching back into the core.
 */
export function bitmapSize(mediaWidth: number, mediaHeight: number, dpr: number): Size {
  return {
    width: Math.round(mediaWidth * dpr),
    height: Math.round(mediaHeight * dpr),
  };
}

/** Pure: snap a media-space coordinate to a crisp device-pixel edge. */
export function snapToDevicePixel(mediaCoord: number, dpr: number): number {
  return Math.round(mediaCoord * dpr) / dpr;
}
