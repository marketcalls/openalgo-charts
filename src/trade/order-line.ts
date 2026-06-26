/**
 * Working-order line (ARCHITECTURE.md §9.1). A horizontal line at the order
 * price, colored by side, labelled with side/qty/distance-from-LTP. Phase 8 is
 * read-only; drag-to-modify and the ✕ cancel hit-zone arrive in Phase 9 (the
 * hit-test already returns the order id + an ns-resize cursor for that).
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from '../primitives/primitive';
import type { Order } from './types';

export class WorkingOrderLine implements IPrimitive {
  private _order: Order;
  private _ltp = NaN;
  private _host: PrimitiveHost | null = null;

  public constructor(order: Order) {
    this._order = order;
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'normal'; }

  public get order(): Order { return this._order; }

  public update(order: Order): void {
    this._order = order;
    this._host?.requestUpdate();
  }

  public setLtp(ltp: number): void {
    this._ltp = ltp;
  }

  public autoscaleInfo(): { min: number; max: number } {
    const p = this._order.triggerPrice ?? this._order.price;
    return { min: p, max: p };
  }

  private _price(): number {
    return this._order.triggerPrice ?? this._order.price;
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const price = this._price();
    const y = Math.round(rc.priceScale.priceToY(price) * rc.dpr) + 0.5;
    if (y < 0 || y > rc.plotHeight * rc.dpr) return;
    const color = this._order.side === 'BUY' ? rc.theme.buy : rc.theme.sell;
    const xEnd = Math.round(rc.plotWidth * rc.dpr);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, Math.round(rc.dpr));
    ctx.setLineDash([6 * rc.dpr, 4 * rc.dpr]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(xEnd, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const remaining = this._order.qty - this._order.filledQty;
    let label = `${this._order.side} ${remaining} ${this._order.type} ${rc.priceScale.format(price)}`;
    if (!Number.isNaN(this._ltp)) {
      const diff = price - this._ltp;
      label += `  ${diff >= 0 ? '+' : ''}${rc.priceScale.format(diff)}`;
    }
    ctx.font = `${11 * rc.dpr}px system-ui, sans-serif`;
    const padX = 6 * rc.dpr;
    const boxH = 16 * rc.dpr;
    const textW = ctx.measureText(label).width;
    ctx.fillStyle = color;
    ctx.fillRect(xEnd + 1, y - boxH / 2, textW + padX * 2, boxH);
    ctx.fillStyle = '#0d0e12';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, xEnd + 1 + padX, y);
    ctx.restore();
  }

  public hitTest(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null {
    if (x < 0 || x > rc.plotWidth) return null;
    const lineY = rc.priceScale.priceToY(this._price());
    const distance = Math.abs(y - lineY);
    if (distance > 4) return null;
    return { externalId: `order:${this._order.id}`, zOrder: 'normal', distance, cursor: 'ns-resize' };
  }
}
