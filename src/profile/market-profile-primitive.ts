/**
 * Market Profile / TPO renderer (ARCHITECTURE.md §8, §6A). Draws the output of
 * `computeMarketProfile` on-chart: per-session TPO letter columns (packed to the
 * left of each session), the Point of Control / Value Area lines with labels and
 * an optional value-area fill, the Initial Balance bracket, single-print marks,
 * and an optional volume sub-profile. A pane primitive — it overlays the price
 * range rather than driving it (though `autoscaleInfo` reports its extent so a
 * profile-only chart still frames correctly).
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, ZOrder } from '../primitives/primitive';
import type { MarketProfileResult, MarketProfileSessionResult } from './market-profile';

export type MpColorMode = 'uniform' | 'valueArea' | 'heat';

export interface MarketProfilePrimitiveOptions {
  /** Draw TPO letters (else solid blocks the width of the row's TPO count). */
  showLetters: boolean;
  /** Width of one TPO column in media px. */
  letterWidth: number;
  /** Letter font size in media px. */
  font: number;
  /** `uniform` one color, `valueArea` VA vs outside, `heat` opacity by TPO count. */
  colorMode: MpColorMode;
  color: string;
  vaColor: string;
  opacity: number;
  zOrder: ZOrder;
  showPoc: boolean;
  pocColor: string;
  showPocLabel: boolean;
  showValueArea: boolean;
  vahColor: string;
  valColor: string;
  showValueAreaLabels: boolean;
  fillValueArea: boolean;
  valueAreaFillColor: string;
  valueAreaFillOpacity: number;
  showInitialBalance: boolean;
  ibColor: string;
  showSinglePrints: boolean;
  singlePrintColor: string;
  showVolumeProfile: boolean;
  volumeProfileWidth: number;
  volumeColor: string;
}

export const DEFAULT_MARKET_PROFILE_PRIMITIVE_OPTIONS: MarketProfilePrimitiveOptions = {
  showLetters: true,
  letterWidth: 8,
  font: 10,
  colorMode: 'valueArea',
  color: '#5a6b8c',
  vaColor: '#4a8f7a',
  opacity: 0.9,
  zOrder: 'top',
  showPoc: true,
  pocColor: '#f0a020',
  showPocLabel: true,
  showValueArea: true,
  vahColor: '#8892a6',
  valColor: '#8892a6',
  showValueAreaLabels: true,
  fillValueArea: true,
  valueAreaFillColor: '#4a8f7a',
  valueAreaFillOpacity: 0.08,
  showInitialBalance: true,
  ibColor: '#c8853a',
  showSinglePrints: true,
  singlePrintColor: '#e0556b',
  showVolumeProfile: false,
  volumeProfileWidth: 60,
  volumeColor: '#3b5168',
};

export class MarketProfile implements IPrimitive {
  private _result: MarketProfileResult | null;
  private _opts: MarketProfilePrimitiveOptions;
  private _host: PrimitiveHost | null = null;

  public constructor(result: MarketProfileResult | null = null, opts: Partial<MarketProfilePrimitiveOptions> = {}) {
    this._result = result;
    this._opts = { ...DEFAULT_MARKET_PROFILE_PRIMITIVE_OPTIONS, ...opts };
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return this._opts.zOrder; }

  public autoscaleInfo(): { min: number; max: number } | null {
    if (this._result === null) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const s of this._result.sessions) {
      if (s.levels.length === 0) continue;
      max = Math.max(max, s.levels[0].price);
      min = Math.min(min, s.levels[s.levels.length - 1].price);
    }
    return Number.isFinite(min) ? { min, max } : null;
  }

  public setData(result: MarketProfileResult): void {
    this._result = result;
    this._host?.requestUpdate();
  }

  public setOptions(patch: Partial<MarketProfilePrimitiveOptions>): void {
    this._opts = { ...this._opts, ...patch };
    this._host?.requestUpdate();
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    if (this._result === null || this._result.sessions.length === 0) return;
    const tick = this._result.options.tickSize;
    for (const s of this._result.sessions) this._drawSession(ctx, rc, s, tick);
  }

  private _drawSession(
    ctx: CanvasRenderingContext2D,
    rc: PrimitiveRenderContext,
    s: MarketProfileSessionResult,
    tick: number,
  ): void {
    const o = this._opts;
    const dpr = rc.dpr;
    const i0 = rc.dataLayer.timeToIndex(s.startTime);
    const i1 = rc.dataLayer.timeToIndex(s.endTime);
    if (i0 === undefined || i1 === undefined) return;
    const x0 = Math.round(rc.timeScale.indexToX(i0) * dpr);
    const x1 = Math.max(x0 + 1, Math.round(rc.timeScale.indexToX(i1) * dpr));
    const yOf = (p: number): number => rc.priceScale.priceToY(p) * dpr;
    const rowH = Math.max(1, Math.abs(rc.priceScale.priceToY(s.poc) - rc.priceScale.priceToY(s.poc + tick)) * dpr);
    const lw = o.letterWidth * dpr;

    ctx.save();

    // value-area fill
    if (o.fillValueArea) {
      const yTop = yOf(s.vah) - rowH / 2;
      const yBot = yOf(s.val) + rowH / 2;
      ctx.globalAlpha = o.valueAreaFillOpacity;
      ctx.fillStyle = o.valueAreaFillColor;
      ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
      ctx.globalAlpha = 1;
    }

    // optional volume sub-profile, anchored at the session's right edge
    if (o.showVolumeProfile) {
      let maxV = 0;
      for (const l of s.levels) if (l.volume > maxV) maxV = l.volume;
      if (maxV > 0) {
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = o.volumeColor;
        const w = o.volumeProfileWidth * dpr;
        for (const l of s.levels) {
          const bw = w * (l.volume / maxV);
          ctx.fillRect(x1 - bw, yOf(l.price) - rowH / 2, bw, Math.max(1, rowH - 1));
        }
        ctx.globalAlpha = 1;
      }
    }

    // TPO letters / blocks
    let maxCount = 1;
    for (const l of s.levels) if (l.count > maxCount) maxCount = l.count;
    if (o.showLetters) {
      ctx.font = `${o.font * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
    }
    for (const l of s.levels) {
      const inVa = l.price <= s.vah && l.price >= s.val;
      const color = o.colorMode === 'valueArea' ? (inVa ? o.vaColor : o.color) : o.color;
      const alpha = o.colorMode === 'heat' ? o.opacity * (0.35 + 0.65 * (l.count / maxCount)) : o.opacity;
      const y = yOf(l.price);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      if (o.showLetters) {
        for (let j = 0; j < l.letters.length; j++) ctx.fillText(l.letters[j], x0 + j * lw + 1, y);
      } else {
        ctx.fillRect(x0, y - rowH / 2, l.count * lw, Math.max(1, rowH - 1));
      }
    }
    ctx.globalAlpha = 1;

    // single prints (short marks at the left)
    if (o.showSinglePrints && s.singlePrints.length > 0) {
      ctx.strokeStyle = o.singlePrintColor;
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      for (const price of s.singlePrints) {
        const y = Math.round(yOf(price)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + 6 * dpr, y);
        ctx.stroke();
      }
    }

    // initial-balance bracket
    if (o.showInitialBalance && Number.isFinite(s.initialBalance.high)) {
      const yH = yOf(s.initialBalance.high);
      const yL = yOf(s.initialBalance.low);
      const xb = x0 - 2 * dpr;
      ctx.strokeStyle = o.ibColor;
      ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
      ctx.beginPath();
      ctx.moveTo(xb, yH); ctx.lineTo(xb, yL);
      ctx.moveTo(xb, yH); ctx.lineTo(xb + 5 * dpr, yH);
      ctx.moveTo(xb, yL); ctx.lineTo(xb + 5 * dpr, yL);
      ctx.stroke();
    }

    // POC / VAH / VAL lines + labels across the session
    const hline = (price: number, color: string, label: string): void => {
      const y = Math.round(yOf(price)) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      if (label !== '') {
        ctx.font = `${(o.font - 1) * dpr}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = color;
        ctx.fillText(label, x1 + 3 * dpr, y);
      }
    };
    if (o.showValueArea) {
      hline(s.vah, o.vahColor, o.showValueAreaLabels ? `VAH ${rc.priceScale.format(s.vah)}` : '');
      hline(s.val, o.valColor, o.showValueAreaLabels ? `VAL ${rc.priceScale.format(s.val)}` : '');
    }
    if (o.showPoc) hline(s.poc, o.pocColor, o.showPocLabel ? `POC ${rc.priceScale.format(s.poc)}` : '');

    ctx.restore();
  }
}
