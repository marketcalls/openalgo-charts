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
  /** Full bar width (bid half + ask half), media px. */
  cellWidth: number;
  /** Diagonal-imbalance ratio for the outline boxes. */
  imbalanceRatio: number;
  /** Price step → row height. Inferred from cell spacing when omitted. */
  tickSize?: number;
  /** Cell text size, media px (default 10). */
  font?: number;
  /** Draw the per-bar delta + volume footer band (default true). */
  footer?: boolean;
}

export class Footprint implements IPrimitive {
  private _bars: FootprintBar[] = [];
  private _opts: Required<Omit<FootprintOptions, 'tickSize'>> & { tickSize?: number };
  private _host: PrimitiveHost | null = null;

  public constructor(opts: Partial<FootprintOptions> = {}) {
    this._opts = { cellWidth: 46, imbalanceRatio: 3, font: 10, footer: true, ...opts };
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'normal'; }
  public autoscaleInfo(): null { return null; }

  public setBars(bars: FootprintBar[]): void {
    this._bars = bars;
    this._host?.requestUpdate();
  }

  /** Row height in device px from the tick size (option, else the min cell gap). */
  private _rowHeight(cells: FootprintBar['cells'], rc: PrimitiveRenderContext): number {
    let tick = this._opts.tickSize ?? 0;
    if (tick <= 0) {
      let min = Infinity;
      for (let i = 1; i < cells.length; i++) {
        const g = Math.abs(cells[i - 1].price - cells[i].price);
        if (g > 0) min = Math.min(min, g);
      }
      tick = Number.isFinite(min) ? min : 0;
    }
    const p0 = cells[0].price;
    const rh = tick > 0 ? Math.abs(rc.priceScale.priceToY(p0) - rc.priceScale.priceToY(p0 + tick)) * rc.dpr : 0;
    return Math.max(rh > 1 ? rh : 16 * rc.dpr, 9 * rc.dpr);
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    if (this._bars.length === 0) return;
    const dpr = rc.dpr;
    const range = rc.timeScale.visibleRange();
    const half = (this._opts.cellWidth * dpr) / 2;
    const ratio = this._opts.imbalanceRatio;
    const plotH = rc.plotHeight * dpr;
    const footerH = this._opts.footer ? 30 * dpr : 0;

    ctx.save();
    ctx.font = `${this._opts.font * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    for (const fb of this._bars) {
      if (fb.cells.length === 0) continue;
      const index = rc.dataLayer.timeToIndex(fb.time);
      if (index === undefined || index < range.from - 1 || index > range.to + 1) continue;
      const cx = Math.round(rc.timeScale.indexToX(index) * dpr);
      const rh = this._rowHeight(fb.cells, rc);

      // grading reference + bar stats
      let maxV = 1, totBid = 0, totAsk = 0, pocVol = -1, pocPrice = fb.cells[0].price;
      for (const c of fb.cells) {
        maxV = Math.max(maxV, c.bidVol, c.askVol);
        totBid += c.bidVol; totAsk += c.askVol;
        const tv = c.bidVol + c.askVol;
        if (tv > pocVol) { pocVol = tv; pocPrice = c.price; }
      }

      // thin range line (high → low) behind the cells
      const yHi = rc.priceScale.priceToY(fb.cells[0].price) * dpr;
      const yLo = rc.priceScale.priceToY(fb.cells[fb.cells.length - 1].price) * dpr;
      ctx.strokeStyle = '#46506b';
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.beginPath(); ctx.moveTo(cx + 0.5, yHi - rh / 2); ctx.lineTo(cx + 0.5, yLo + rh / 2); ctx.stroke();

      for (let i = 0; i < fb.cells.length; i++) {
        const c = fb.cells[i];
        const y = rc.priceScale.priceToY(c.price) * dpr;
        const top = Math.round(y - rh / 2);
        const h = Math.max(1, Math.round(rh) - 1);
        // color-graded cells: alpha scales with volume (more = darker/stronger)
        const aBid = 0.08 + 0.82 * (c.bidVol / maxV);
        const aAsk = 0.08 + 0.82 * (c.askVol / maxV);
        ctx.fillStyle = `rgba(239,83,80,${aBid.toFixed(3)})`;
        ctx.fillRect(cx - half, top, half - 1, h);
        ctx.fillStyle = `rgba(38,166,154,${aAsk.toFixed(3)})`;
        ctx.fillRect(cx + 1, top, half - 1, h);

        // diagonal-imbalance outline boxes (ask vs the bid one tick below; bid vs ask one tick above)
        const below = fb.cells[i + 1], above = fb.cells[i - 1];
        if (below && c.askVol >= ratio * Math.max(1, below.bidVol)) {
          ctx.strokeStyle = '#39d0b4'; ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
          ctx.strokeRect(cx + 1.5, top + 0.5, half - 2, h - 1);
        }
        if (above && c.bidVol >= ratio * Math.max(1, above.askVol)) {
          ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
          ctx.strokeRect(cx - half + 0.5, top + 0.5, half - 2, h - 1);
        }

        // numbers (light, with the center divider between bid|ask)
        ctx.fillStyle = '#eef1f6';
        ctx.textAlign = 'right'; ctx.fillText(String(c.bidVol), cx - 4 * dpr, y);
        ctx.textAlign = 'left'; ctx.fillText(String(c.askVol), cx + 4 * dpr, y);
      }

      // center divider
      ctx.strokeStyle = '#0d0e12'; ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.beginPath(); ctx.moveTo(cx + 0.5, yHi - rh / 2); ctx.lineTo(cx + 0.5, yLo + rh / 2); ctx.stroke();

      // POC marker (gold tick on the left edge)
      const yp = rc.priceScale.priceToY(pocPrice) * dpr;
      ctx.fillStyle = '#f0a020';
      ctx.fillRect(cx - half - 3 * dpr, Math.round(yp - rh / 2), 2 * dpr, Math.max(1, Math.round(rh) - 1));

      // per-bar footer: delta (colored by sign) over total volume
      if (this._opts.footer) {
        const delta = totAsk - totBid;
        const fTop = plotH - footerH;
        ctx.fillStyle = '#0d0e12';
        ctx.fillRect(cx - half, fTop, half * 2, footerH);
        ctx.fillStyle = delta >= 0 ? 'rgba(38,166,154,0.30)' : 'rgba(239,83,80,0.30)';
        ctx.fillRect(cx - half, fTop, half * 2, footerH / 2);
        ctx.textAlign = 'center';
        ctx.fillStyle = delta >= 0 ? '#7fe3d3' : '#ff9b9b';
        ctx.fillText(`${delta >= 0 ? '+' : ''}${delta}`, cx, fTop + footerH / 4);
        ctx.fillStyle = '#c7ccd8';
        ctx.fillText(String(totBid + totAsk), cx, fTop + (footerH * 3) / 4);
      }
    }
    ctx.restore();
  }
}
