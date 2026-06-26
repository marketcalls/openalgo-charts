/**
 * Bracket group (ARCHITECTURE.md §9.1). SL + Target lines tied to a position,
 * with shaded risk (red) and reward (green) zones and an R:R label — the core
 * advanced-trade-management visualisation. Phase 8 is read-only; Phase 9 makes
 * the SL/TP lines draggable (OCO modify).
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from '../primitives/primitive';
import type { OrderSide } from './types';
import { riskReward } from './pnl';

export interface BracketState {
  symbol: string;
  side: OrderSide;
  entry: number;
  stop: number;
  target: number;
}

export class BracketGroup implements IPrimitive {
  private _state: BracketState;
  private _host: PrimitiveHost | null = null;

  public constructor(state: BracketState) {
    this._state = state;
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'bottom'; } // zones behind the candles

  public get state(): BracketState { return this._state; }

  public update(state: BracketState): void {
    this._state = state;
    this._host?.requestUpdate();
  }

  public autoscaleInfo(): { min: number; max: number } {
    return {
      min: Math.min(this._state.stop, this._state.target, this._state.entry),
      max: Math.max(this._state.stop, this._state.target, this._state.entry),
    };
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const { entry, stop, target } = this._state;
    const xEnd = Math.round(rc.plotWidth * rc.dpr);
    const yEntry = rc.priceScale.priceToY(entry) * rc.dpr;
    const yStop = rc.priceScale.priceToY(stop) * rc.dpr;
    const yTarget = rc.priceScale.priceToY(target) * rc.dpr;

    ctx.save();
    // risk zone (entry ↔ stop)
    ctx.fillStyle = 'rgba(239,83,80,0.10)';
    ctx.fillRect(0, Math.min(yEntry, yStop), xEnd, Math.abs(yStop - yEntry));
    // reward zone (entry ↔ target)
    ctx.fillStyle = 'rgba(38,166,154,0.10)';
    ctx.fillRect(0, Math.min(yEntry, yTarget), xEnd, Math.abs(yTarget - yEntry));

    // SL and TP lines
    for (const [y, color, tag] of [[yStop, rc.theme.loss, 'SL'], [yTarget, rc.theme.profit, 'TP']] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, Math.round(rc.dpr));
      ctx.setLineDash([4 * rc.dpr, 4 * rc.dpr]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(xEnd, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = `${10 * rc.dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(tag, 4 * rc.dpr, Math.round(y));
    }

    // R:R label near entry
    const rr = riskReward(entry, stop, target);
    if (rr !== null) {
      ctx.fillStyle = '#c7ccd8';
      ctx.font = `${10 * rc.dpr}px system-ui, sans-serif`;
      ctx.fillText(`R:R ${rr.toFixed(2)}`, 4 * rc.dpr, Math.round(yEntry) - 8 * rc.dpr);
    }
    ctx.restore();
  }

  public hitTest(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null {
    if (x < 0 || x > rc.plotWidth) return null;
    const yStop = rc.priceScale.priceToY(this._state.stop);
    const yTarget = rc.priceScale.priceToY(this._state.target);
    const dStop = Math.abs(y - yStop);
    const dTarget = Math.abs(y - yTarget);
    if (dStop <= 4) return { externalId: `bracket-sl:${this._state.symbol}`, zOrder: 'bottom', distance: dStop, cursor: 'ns-resize' };
    if (dTarget <= 4) return { externalId: `bracket-tp:${this._state.symbol}`, zOrder: 'bottom', distance: dTarget, cursor: 'ns-resize' };
    return null;
  }
}
