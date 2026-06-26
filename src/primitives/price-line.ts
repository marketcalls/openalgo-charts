/**
 * Horizontal price line primitive (ARCHITECTURE.md §8). The reusable base for
 * order/SL/TP/alert/indicator-level lines: a line across the plot plus a fixed
 * right-axis price tag. Drag handling is added by the trade layer in Phase 9.
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from './primitive';

export interface PriceLineOptions {
  price: number;
  color: string;
  lineWidth: number;
  dashed: boolean;
  label?: string;
  /** Stable id returned by hit-test (for click/drag routing). */
  id: string;
  /** Cursor hint when hovered (e.g. 'ns-resize' for draggable lines). */
  cursor?: string;
}

export class PriceLine implements IPrimitive {
  private _opts: PriceLineOptions;
  private _host: PrimitiveHost | null = null;

  public constructor(opts: PriceLineOptions) {
    this._opts = opts;
  }

  public attached(host: PrimitiveHost): void {
    this._host = host;
  }

  public detached(): void {
    this._host = null;
  }

  public get price(): number {
    return this._opts.price;
  }

  /** Move the line; schedules a repaint via the host. */
  public setPrice(price: number): void {
    this._opts.price = price;
    this._host?.requestUpdate();
  }

  public options(): Readonly<PriceLineOptions> {
    return this._opts;
  }

  public zOrder(): ZOrder {
    return 'normal';
  }

  public autoscaleInfo(): { min: number; max: number } | null {
    return { min: this._opts.price, max: this._opts.price };
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const y = Math.round(rc.priceScale.priceToY(this._opts.price) * rc.dpr) + 0.5;
    if (y < 0 || y > rc.plotHeight * rc.dpr) return;
    const xEnd = Math.round(rc.plotWidth * rc.dpr);

    ctx.save();
    ctx.strokeStyle = this._opts.color;
    ctx.lineWidth = Math.max(1, Math.round(this._opts.lineWidth * rc.dpr));
    if (this._opts.dashed) ctx.setLineDash([4 * rc.dpr, 4 * rc.dpr]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(xEnd, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const label = this._opts.label ?? rc.priceScale.format(this._opts.price);
    ctx.font = `${11 * rc.dpr}px system-ui, sans-serif`;
    const padX = 6 * rc.dpr;
    const boxH = 16 * rc.dpr;
    const textW = ctx.measureText(label).width;
    ctx.fillStyle = this._opts.color;
    ctx.fillRect(xEnd + 1, y - boxH / 2, textW + padX * 2, boxH);
    ctx.fillStyle = '#0d0e12';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, xEnd + 1 + padX, y);
    ctx.restore();
  }

  public hitTest(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null {
    if (x < 0 || x > rc.plotWidth) return null;
    const lineY = rc.priceScale.priceToY(this._opts.price);
    const distance = Math.abs(y - lineY);
    if (distance > 4) return null;
    return { externalId: this._opts.id, zOrder: 'normal', distance, cursor: this._opts.cursor };
  }
}
