/**
 * HiDPI canvas handling (ARCHITECTURE.md §3.1).
 *
 * Each canvas has two coordinate systems: **media** (CSS px, what you reason
 * about) and **bitmap** (device px = media × devicePixelRatio, the backing
 * buffer). Drawing 1px lines in the bitmap scope with integer snapping keeps
 * them crisp on retina/HiDPI displays.
 */

export interface Size {
  width: number;
  height: number;
}

/** Pure: compute the integer device-pixel backing-buffer size for a canvas. */
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

/**
 * Pure: move every boundary between stacked boxes onto a device-pixel edge,
 * so each box is a whole number of device pixels tall.
 *
 * Shared by weight, three panes in 517 px are 310.2 px and 103.4 px tall, and
 * at a device pixel ratio of 1.5 their boundaries fall inside a device pixel.
 * A canvas sized to such a box has a backing store the browser has to stretch
 * by a fraction of a pixel to cover it, which blurs every line on it, and the
 * separator lands on a row the two panes share. Rounding the running
 * total, rather than each height, keeps the error at half a device pixel per
 * boundary instead of letting it accumulate down the stack, and leaves the
 * outer edge where the caller put it: the container's own box is the browser's.
 */
export function alignToDevicePixels(
  boxes: readonly { top: number; height: number }[],
  dpr: number,
): { top: number; height: number }[] {
  const last = boxes[boxes.length - 1];
  if (!(dpr > 0) || !Number.isFinite(dpr) || last === undefined) return boxes.map(box => ({ ...box }));
  const end = last.top + last.height;
  let top = boxes[0].top;
  return boxes.map((box, i) => {
    const bottom = i === boxes.length - 1 ? end : Math.round((box.top + box.height) * dpr) / dpr;
    const out = { top, height: Math.max(0, bottom - top) };
    top = Math.max(top, bottom);
    return out;
  });
}

/**
 * Pure: the height in CSS px of a rule that covers whole device pixels, at
 * least one. At ratios 1, 2 and 3 that is the 1 px it has always been; at 1.25
 * and 1.5 it is one device pixel, where 1 px would end part way into the next.
 */
export function hairlineHeight(dpr: number): number {
  if (!(dpr > 0) || !Number.isFinite(dpr)) return 1;
  return Math.max(1, Math.floor(dpr)) / dpr;
}

/**
 * A single `<canvas>` element with media/bitmap sizing. Constructed only in a
 * browser; the size math above is the part exercised by unit tests.
 */
export class CanvasLayer {
  public readonly element: HTMLCanvasElement;
  public readonly ctx: CanvasRenderingContext2D;
  private _mediaWidth = 0;
  private _mediaHeight = 0;
  private _dpr = 1;

  public constructor(doc: Document, zIndex: number) {
    this.element = doc.createElement('canvas');
    const ctx = this.element.getContext('2d');
    if (ctx === null) {
      throw new Error('openalgo-charts: 2D canvas context is not available');
    }
    this.ctx = ctx;
    const s = this.element.style;
    s.position = 'absolute';
    s.top = '0';
    s.left = '0';
    s.width = '100%';
    s.height = '100%';
    s.zIndex = String(zIndex);
  }

  public get mediaWidth(): number {
    return this._mediaWidth;
  }

  public get mediaHeight(): number {
    return this._mediaHeight;
  }

  public get pixelRatio(): number {
    return this._dpr;
  }

  /** Resize backing buffer + CSS box. No-op if nothing changed. */
  public resize(mediaWidth: number, mediaHeight: number, dpr: number): void {
    if (mediaWidth === this._mediaWidth && mediaHeight === this._mediaHeight && dpr === this._dpr) {
      return;
    }
    this._mediaWidth = mediaWidth;
    this._mediaHeight = mediaHeight;
    this._dpr = dpr;
    const bmp = bitmapSize(mediaWidth, mediaHeight, dpr);
    this.element.width = bmp.width;
    this.element.height = bmp.height;
    this.element.style.width = `${mediaWidth}px`;
    this.element.style.height = `${mediaHeight}px`;
  }

  /**
   * Size the backing store to the device pixels the browser reports the box
   * covers (`devicePixelContentBoxSize`). `media x dpr` is only an estimate:
   * a box that starts part way into a device pixel is snapped by the browser
   * to one pixel more or fewer, and a backing store one pixel off is stretched
   * across the box, blurring everything on it. The media size and the ratio
   * are unchanged, so drawing code keeps scaling by `dpr`.
   *
   * A report more than a pixel away from `media x dpr` is not a snapped box
   * but a different scale, and is refused: an emulated device scale reports
   * the box at the host's real ratio while `devicePixelRatio` says another,
   * and a store sized to it would crop the chart.
   *
   * Returns true when the bitmap changed, which clears it: the caller repaints.
   */
  public setDeviceSize(width: number, height: number): boolean {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false;
    if (Math.abs(width - this._mediaWidth * this._dpr) > 1 || Math.abs(height - this._mediaHeight * this._dpr) > 1) return false;
    if (this.element.width === width && this.element.height === height) return false;
    this.element.width = width;
    this.element.height = height;
    return true;
  }

  /** Clear the whole bitmap and reset the transform to bitmap (device-px) scope. */
  public clearBitmap(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.element.width, this.element.height);
  }
}
