/**
 * Profile renderers (ARCHITECTURE.md §6A). HorizontalProfile draws volume-at-
 * price / TPO-count bars sideways with POC + Value-Area lines; Footprint draws
 * per-candle bid×ask cells colored by delta. Both are pane primitives (drawn
 * behind/over the candles) — profiles overlay the existing price range, so they
 * do not drive autoscale.
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, ZOrder } from '../primitives/primitive';
import type { FootprintBar } from './profile-model';

export interface ProfileLevel { price: number; value: number; }

export interface HorizontalProfileOptions {
  buckets: ProfileLevel[];
  poc: number;
  vah: number;
  val: number;
  /** Strip width in media px. */
  width: number;
  side: 'left' | 'right';
  barColor: string;
  vaColor: string;
}

export class HorizontalProfile implements IPrimitive {
  private _opts: HorizontalProfileOptions;
  private _host: PrimitiveHost | null = null;

  public constructor(opts: HorizontalProfileOptions) {
    this._opts = opts;
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'bottom'; }
  public autoscaleInfo(): null { return null; } // overlays existing range

  public setData(opts: HorizontalProfileOptions): void {
    this._opts = opts;
    this._host?.requestUpdate();
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    const o = this._opts;
    if (o.buckets.length === 0) return;
    const dpr = rc.dpr;
    const maxVal = o.buckets.reduce((m, b) => Math.max(m, b.value), 0) || 1;
    const stripW = o.width * dpr;
    const baseX = o.side === 'left' ? 0 : rc.plotWidth * dpr;
    const rowH = Math.max(2 * dpr, ((rc.plotHeight * dpr) / Math.max(1, o.buckets.length)) - dpr);

    ctx.save();
    for (const b of o.buckets) {
      const y = rc.priceScale.priceToY(b.price) * dpr;
      const w = stripW * (b.value / maxVal);
      const inVa = b.price <= o.vah && b.price >= o.val;
      ctx.fillStyle = b.price === o.poc ? '#f0a020' : (inVa ? o.vaColor : o.barColor);
      const x = o.side === 'left' ? baseX : baseX - w;
      ctx.fillRect(x, y - rowH / 2, w, rowH);
    }
    // POC + VA lines across the plot
    for (const [price, color] of [[o.poc, '#f0a020'], [o.vah, '#5a6b8c'], [o.val, '#5a6b8c']] as const) {
      const y = Math.round(rc.priceScale.priceToY(price) * dpr) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(rc.plotWidth * dpr, y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export interface FootprintOptions {
  cellWidth: number;
  imbalanceRatio: number;
}

export class Footprint implements IPrimitive {
  private _bars: FootprintBar[] = [];
  private _opts: FootprintOptions;
  private _host: PrimitiveHost | null = null;

  public constructor(opts: Partial<FootprintOptions> = {}) {
    this._opts = { cellWidth: 46, imbalanceRatio: 3, ...opts };
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'normal'; }
  public autoscaleInfo(): null { return null; }

  public setBars(bars: FootprintBar[]): void {
    this._bars = bars;
    this._host?.requestUpdate();
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    if (this._bars.length === 0) return;
    const dpr = rc.dpr;
    const range = rc.timeScale.visibleRange();
    ctx.save();
    ctx.font = `${9 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const fb of this._bars) {
      const index = rc.dataLayer.timeToIndex(fb.time);
      if (index === undefined || index < range.from - 1 || index > range.to + 1) continue;
      const cx = rc.timeScale.indexToX(index) * dpr;
      const half = (this._opts.cellWidth * dpr) / 2;
      for (const cell of fb.cells) {
        const y = rc.priceScale.priceToY(cell.price) * dpr;
        // bid (left) and ask (right) volumes
        ctx.fillStyle = '#bfeee8'; ctx.textAlign = 'right';
        ctx.fillText(String(cell.bidVol), cx - 2 * dpr, y);
        ctx.fillStyle = '#f6c9c8'; ctx.textAlign = 'left';
        ctx.fillText(String(cell.askVol), cx + 2 * dpr, y);
        // imbalance tint
        if (cell.askVol >= this._opts.imbalanceRatio * Math.max(1, cell.bidVol)) {
          ctx.fillStyle = 'rgba(38,166,154,0.18)';
          ctx.fillRect(cx, y - 5 * dpr, half, 10 * dpr);
        } else if (cell.bidVol >= this._opts.imbalanceRatio * Math.max(1, cell.askVol)) {
          ctx.fillStyle = 'rgba(239,83,80,0.18)';
          ctx.fillRect(cx - half, y - 5 * dpr, half, 10 * dpr);
        }
      }
    }
    ctx.restore();
  }
}
