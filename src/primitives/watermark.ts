/**
 * Logo / brand watermark (ARCHITECTURE.md §8). Draws a small image (or an
 * already-decoded bitmap) faintly in a corner of the plot — the way charting
 * apps stamp a product/brand mark. Because it draws on the canvas it is captured
 * by `chart.takeScreenshot()`, and an optional `tint` recolors the opaque pixels
 * so a single-color logo reads on both dark and light themes.
 *
 * Source-agnostic: pass a `src` (URL or data URI) or a preloaded `image`. The
 * library ships no logo of its own, keeping the bundle lean.
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, ZOrder } from './primitive';

export type WatermarkPosition =
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';

export interface LogoWatermarkOptions {
  /** Image URL or data URI. Ignored when `image` is provided. */
  src?: string;
  /** A preloaded image/bitmap to draw (skips loading). */
  image?: CanvasImageSource & { width: number; height: number };
  /** Corner (or center) to anchor to. Default `bottom-right`. */
  position?: WatermarkPosition;
  /** Gap from the plot edges in px. Default `12`. */
  margin?: number;
  /** Rendered logo height in px; width follows the source aspect. Default `28`. */
  height?: number;
  /** 0..1. Default `0.7`. */
  opacity?: number;
  /** Recolor the opaque pixels to this color (e.g. a faint theme gray). */
  tint?: string;
  /** Layer order vs the series. Default `top`. */
  zOrder?: ZOrder;
}

interface ImageLike { width: number; height: number; naturalWidth?: number; naturalHeight?: number; complete?: boolean; }

/** Top-left placement (in media px) of a `w x h` logo within a `plotW x plotH` plot. */
export function watermarkRect(
  position: WatermarkPosition, margin: number, w: number, h: number, plotW: number, plotH: number,
): { x: number; y: number; w: number; h: number } {
  const right = plotW - margin - w;
  const bottom = plotH - margin - h;
  switch (position) {
    case 'top-left': return { x: margin, y: margin, w, h };
    case 'top-right': return { x: right, y: margin, w, h };
    case 'bottom-left': return { x: margin, y: bottom, w, h };
    case 'center': return { x: (plotW - w) / 2, y: (plotH - h) / 2, w, h };
    case 'bottom-right':
    default: return { x: right, y: bottom, w, h };
  }
}

export class LogoWatermark implements IPrimitive {
  private _opts: Required<Omit<LogoWatermarkOptions, 'src' | 'image' | 'tint'>> & Pick<LogoWatermarkOptions, 'src' | 'image' | 'tint'>;
  private _host: PrimitiveHost | null = null;
  private _img: (CanvasImageSource & ImageLike) | null = null;
  private _ready = false;
  private _tintCanvas: (CanvasImageSource & { width: number; height: number }) | null = null;
  private _tintKey = '';

  public constructor(opts: LogoWatermarkOptions = {}) {
    this._opts = {
      position: opts.position ?? 'bottom-right',
      margin: opts.margin ?? 12,
      height: opts.height ?? 28,
      opacity: opts.opacity ?? 0.7,
      zOrder: opts.zOrder ?? 'top',
      src: opts.src,
      image: opts.image,
      tint: opts.tint,
    };
    if (opts.image) { this._img = opts.image as CanvasImageSource & ImageLike; this._ready = true; }
  }

  public attached(host: PrimitiveHost): void {
    this._host = host;
    if (!this._ready && this._opts.src && typeof Image !== 'undefined') {
      const img = new Image();
      img.onload = (): void => { this._img = img; this._ready = true; this._host?.requestUpdate(); };
      img.decoding = 'async';
      img.src = this._opts.src;
    }
  }

  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return this._opts.zOrder; }
  public autoscaleInfo(): null { return null; }

  /** Live restyle. Pass a new `src`/`image` to swap the logo. */
  public setOptions(patch: Partial<LogoWatermarkOptions>): void {
    this._opts = { ...this._opts, ...patch };
    this._tintCanvas = null;
    if (patch.image) { this._img = patch.image as CanvasImageSource & ImageLike; this._ready = true; }
    else if (patch.src !== undefined) { this._ready = false; this._img = null; this.attached(this._host as PrimitiveHost); }
    this._host?.requestUpdate();
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    if (!this._ready || this._img === null) return;
    const o = this._opts;
    const iw = this._img.naturalWidth ?? this._img.width;
    const ih = this._img.naturalHeight ?? this._img.height;
    if (!iw || !ih) return;
    const h = o.height;
    const w = h * (iw / ih);
    const r = watermarkRect(o.position, o.margin, w, h, rc.plotWidth, rc.plotHeight);
    const dpr = rc.dpr;
    const dx = Math.round(r.x * dpr);
    const dy = Math.round(r.y * dpr);
    const dw = Math.round(w * dpr);
    const dh = Math.round(h * dpr);

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, o.opacity));
    const src = o.tint ? this._tinted(ctx, dw, dh, o.tint) : this._img;
    if (o.tint && src) ctx.drawImage(src, dx, dy);
    else ctx.drawImage(this._img, dx, dy, dw, dh);
    ctx.restore();
  }

  /** Recolor the opaque logo pixels to `color` at (dw x dh) device px, cached. */
  private _tinted(ctx: CanvasRenderingContext2D, dw: number, dh: number, color: string): CanvasImageSource & { width: number; height: number } | null {
    const key = `${dw}x${dh}:${color}`;
    if (this._tintCanvas && this._tintKey === key) return this._tintCanvas;
    const doc = (ctx.canvas as HTMLCanvasElement).ownerDocument as Document | undefined;
    let off: HTMLCanvasElement | null = null;
    if (doc && typeof doc.createElement === 'function') off = doc.createElement('canvas');
    if (!off) return null;
    off.width = dw; off.height = dh;
    const g = off.getContext('2d');
    if (!g || this._img === null) return null;
    g.clearRect(0, 0, dw, dh);
    g.drawImage(this._img, 0, 0, dw, dh);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, dw, dh);
    this._tintCanvas = off;
    this._tintKey = key;
    return off;
  }
}
