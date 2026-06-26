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

  /** Clear the whole bitmap and reset the transform to bitmap (device-px) scope. */
  public clearBitmap(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.element.width, this.element.height);
  }
}
