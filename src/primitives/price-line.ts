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
  /** Right-axis tag text. Defaults to the formatted price. */
  label?: string;
  /** Optional tag drawn at the LEFT end of the line (NinjaTrader-style order tag). */
  leftLabel?: string;
  /**
   * Fraction of the plot width the line spans, measured from the right (price)
   * axis. 1 = full width (default); 0.3 = only the rightmost 30% — like a
   * NinjaTrader order line. The right-axis tag is always drawn.
   */
  extentFromRight?: number;
  /** Draw a small cancel (cross) box at the right end; hit-tests as `${id}::close`. */
  closeButton?: boolean;
  /** Stable id returned by hit-test (for click/drag routing). */
  id: string;
  /** Cursor hint when hovered (e.g. 'ns-resize' for draggable lines). */
  cursor?: string;
}

/** Width/height of the cancel (cross) box, in media px (shared by draw + hit-test). */
const CLOSE_BOX = 14;

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

  /** Update the left-end tag text (e.g. live position P&L); repaints. */
  public setLeftLabel(text: string): void {
    this._opts.leftLabel = text;
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
    const extent = Math.max(0, Math.min(1, this._opts.extentFromRight ?? 1));
    const xStart = Math.round(rc.plotWidth * (1 - extent) * rc.dpr);

    ctx.save();
    ctx.strokeStyle = this._opts.color;
    ctx.lineWidth = Math.max(1, Math.round(this._opts.lineWidth * rc.dpr));
    if (this._opts.dashed) ctx.setLineDash([4 * rc.dpr, 4 * rc.dpr]);
    ctx.beginPath();
    ctx.moveTo(xStart, y);
    ctx.lineTo(xEnd, y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = `${11 * rc.dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const padX = 6 * rc.dpr;
    const boxH = 16 * rc.dpr;

    // right-axis price tag
    const label = this._opts.label ?? rc.priceScale.format(this._opts.price);
    const textW = ctx.measureText(label).width;
    ctx.fillStyle = this._opts.color;
    ctx.fillRect(xEnd + 1, y - boxH / 2, textW + padX * 2, boxH);
    ctx.fillStyle = '#0d0e12';
    ctx.textAlign = 'left';
    ctx.fillText(label, xEnd + 1 + padX, y);

    // optional left-end order tag (e.g. "BUY 100 LIMIT")
    if (this._opts.leftLabel) {
      const lw = ctx.measureText(this._opts.leftLabel).width;
      ctx.fillStyle = this._opts.color;
      ctx.fillRect(xStart, y - boxH / 2, lw + padX * 2, boxH);
      ctx.fillStyle = '#0d0e12';
      ctx.fillText(this._opts.leftLabel, xStart + padX, y);
    }

    // optional cancel box at the right end of the line (cross drawn geometrically)
    if (this._opts.closeButton) {
      const s = CLOSE_BOX * rc.dpr;
      const bx = xEnd - s;
      const by = y - s / 2;
      ctx.fillStyle = this._opts.color;
      ctx.fillRect(bx, by, s, s);
      ctx.strokeStyle = '#0d0e12';
      ctx.lineWidth = Math.max(1, Math.round(1.5 * rc.dpr));
      const p = 4 * rc.dpr;
      ctx.beginPath();
      ctx.moveTo(bx + p, by + p); ctx.lineTo(bx + s - p, by + s - p);
      ctx.moveTo(bx + s - p, by + p); ctx.lineTo(bx + p, by + s - p);
      ctx.stroke();
    }
    ctx.restore();
  }

  public hitTest(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null {
    if (x < 0 || x > rc.plotWidth) return null;
    const lineY = rc.priceScale.priceToY(this._opts.price);
    const distance = Math.abs(y - lineY);
    // Cancel box at the right end takes priority and routes as a click (not a drag).
    if (this._opts.closeButton && x >= rc.plotWidth - CLOSE_BOX && distance <= CLOSE_BOX / 2 + 1) {
      return { externalId: `${this._opts.id}::close`, zOrder: 'normal', distance, cursor: 'pointer' };
    }
    if (distance > 4) return null;
    return { externalId: this._opts.id, zOrder: 'normal', distance, cursor: this._opts.cursor };
  }
}
