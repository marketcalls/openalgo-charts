/**
 * Position marker (ARCHITECTURE.md §9.1). A line at the average entry price with
 * a live unrealized-P&L tag (₹ and %), colored by P&L sign, plus a breakeven
 * reference. Updates cheaply on every LTP tick (overlay-only repaint).
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from '../primitives/primitive';
import type { Position } from './types';
import { unrealizedPnl, unrealizedPnlPercent } from './pnl';

export class PositionMarker implements IPrimitive {
  private _position: Position;
  private _ltp = NaN;
  private _host: PrimitiveHost | null = null;

  public constructor(position: Position) {
    this._position = position;
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'normal'; }

  public get position(): Position { return this._position; }

  public update(position: Position): void {
    this._position = position;
    this._host?.requestUpdate();
  }

  public setLtp(ltp: number): void {
    this._ltp = ltp;
    this._host?.requestUpdate();
  }

  public autoscaleInfo(): { min: number; max: number } {
    return { min: this._position.avgPrice, max: this._position.avgPrice };
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    if (this._position.netQty === 0) return;
    const entryY = Math.round(rc.priceScale.priceToY(this._position.avgPrice) * rc.dpr) + 0.5;
    const xEnd = Math.round(rc.plotWidth * rc.dpr);
    const pnl = Number.isNaN(this._ltp) ? 0 : unrealizedPnl(this._position, this._ltp);
    const color = pnl >= 0 ? '#26a69a' : '#ef5350';

    ctx.save();
    // entry line (solid)
    ctx.strokeStyle = '#c7ccd8';
    ctx.lineWidth = Math.max(1, Math.round(rc.dpr));
    ctx.beginPath();
    ctx.moveTo(0, entryY);
    ctx.lineTo(xEnd, entryY);
    ctx.stroke();

    // shaded band from entry to LTP, colored by P&L
    if (!Number.isNaN(this._ltp)) {
      const ltpY = Math.round(rc.priceScale.priceToY(this._ltp) * rc.dpr);
      ctx.fillStyle = pnl >= 0 ? 'rgba(38,166,154,0.12)' : 'rgba(239,83,80,0.12)';
      ctx.fillRect(0, Math.min(entryY, ltpY), xEnd, Math.abs(ltpY - entryY));
    }

    // P&L tag on the right axis
    const dir = this._position.netQty > 0 ? 'LONG' : 'SHORT';
    const pct = Number.isNaN(this._ltp) ? 0 : unrealizedPnlPercent(this._position, this._ltp);
    const label = `${dir} ${Math.abs(this._position.netQty)} | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
    ctx.font = `${11 * rc.dpr}px system-ui, sans-serif`;
    const padX = 6 * rc.dpr;
    const boxH = 16 * rc.dpr;
    const textW = ctx.measureText(label).width;
    ctx.fillStyle = color;
    ctx.fillRect(xEnd + 1, entryY - boxH / 2, textW + padX * 2, boxH);
    ctx.fillStyle = '#0d0e12';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, xEnd + 1 + padX, entryY);
    ctx.restore();
  }

  public hitTest(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null {
    if (this._position.netQty === 0 || x < 0 || x > rc.plotWidth) return null;
    const lineY = rc.priceScale.priceToY(this._position.avgPrice);
    const distance = Math.abs(y - lineY);
    if (distance > 4) return null;
    return { externalId: `position:${this._position.symbol}`, zOrder: 'normal', distance, cursor: 'pointer' };
  }
}
