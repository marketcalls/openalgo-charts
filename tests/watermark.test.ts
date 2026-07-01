import { describe, it, expect } from 'vitest';
import { LogoWatermark, watermarkRect } from '../src/primitives/watermark';
import type { PrimitiveRenderContext } from '../src/primitives/primitive';

describe('watermarkRect', () => {
  it('anchors to each corner and center', () => {
    const plotW = 800, plotH = 400, m = 10, w = 40, h = 20;
    expect(watermarkRect('top-left', m, w, h, plotW, plotH)).toMatchObject({ x: 10, y: 10 });
    expect(watermarkRect('top-right', m, w, h, plotW, plotH)).toMatchObject({ x: 750, y: 10 });
    expect(watermarkRect('bottom-left', m, w, h, plotW, plotH)).toMatchObject({ x: 10, y: 370 });
    expect(watermarkRect('bottom-right', m, w, h, plotW, plotH)).toMatchObject({ x: 750, y: 370 });
    expect(watermarkRect('center', m, w, h, plotW, plotH)).toMatchObject({ x: 380, y: 190 });
  });
});

describe('LogoWatermark', () => {
  const fakeImage = { width: 100, height: 50 } as unknown as CanvasImageSource & { width: number; height: number };

  function recorder() {
    const calls: Array<{ args: unknown[] }> = [];
    const ctx = {
      canvas: { ownerDocument: undefined },
      globalAlpha: 1,
      save() {}, restore() {},
      drawImage(...args: unknown[]) { calls.push({ args }); },
    } as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  }

  const rc = (dpr: number): PrimitiveRenderContext => ({
    plotWidth: 600, plotHeight: 300, priceAxisWidth: 0, dpr,
    // scales/dataLayer/theme are unused by the watermark
  } as unknown as PrimitiveRenderContext);

  it('draws a preloaded image at the bottom-right, scaled by dpr', () => {
    const wm = new LogoWatermark({ image: fakeImage, position: 'bottom-right', margin: 12, height: 30, opacity: 0.5 });
    const { ctx, calls } = recorder();
    wm.draw(ctx, rc(2));
    expect(calls).toHaveLength(1);
    // aspect 100/50 = 2 -> w = 60, h = 30; device px = *2
    const [img, dx, dy, dw, dh] = calls[0].args as [unknown, number, number, number, number];
    expect(img).toBe(fakeImage);
    expect(dw).toBe(120); // 60 * 2
    expect(dh).toBe(60);  // 30 * 2
    // bottom-right: x = 600 - 12 - 60 = 528 -> *2 = 1056 ; y = 300 - 12 - 30 = 258 -> *2 = 516
    expect(dx).toBe(1056);
    expect(dy).toBe(516);
  });

  it('does nothing until an image is ready', () => {
    const wm = new LogoWatermark({ src: 'about:blank' });
    const { ctx, calls } = recorder();
    wm.draw(ctx, rc(1));
    expect(calls).toHaveLength(0);
  });
});
