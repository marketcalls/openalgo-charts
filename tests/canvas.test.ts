import { describe, it, expect } from 'vitest';
import { bitmapSize, snapToDevicePixel } from '../src/core/canvas';

describe('HiDPI bitmap sizing', () => {
  // Validates "renders correctly at DPR 1 / 1.5 / 2 / 3" at the math level
  // (actual pixel-diff rendering is covered by the browser harness in Phase 2-3).
  it('scales media → integer device pixels across DPRs', () => {
    expect(bitmapSize(800, 600, 1)).toEqual({ width: 800, height: 600 });
    expect(bitmapSize(800, 600, 2)).toEqual({ width: 1600, height: 1200 });
    expect(bitmapSize(800, 600, 3)).toEqual({ width: 2400, height: 1800 });
  });

  it('rounds fractional DPR to whole device pixels', () => {
    // 1.5x of an odd media size must not leave a fractional backing buffer.
    expect(bitmapSize(801, 601, 1.5)).toEqual({ width: 1202, height: 902 });
    expect(Number.isInteger(bitmapSize(123, 457, 1.25).width)).toBe(true);
    expect(Number.isInteger(bitmapSize(123, 457, 1.25).height)).toBe(true);
  });

  it('snaps coordinates to crisp device-pixel edges', () => {
    expect(snapToDevicePixel(10.4, 1)).toBe(10);
    expect(snapToDevicePixel(10.2, 2)).toBe(10); // 20.4 → 20 → /2
    expect(snapToDevicePixel(10.3, 2)).toBe(10.5); // 20.6 → 21 → /2
  });
});
