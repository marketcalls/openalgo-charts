/**
 * Series markers (ARCHITECTURE.md §8.1): buy/sell signals and shapes anchored
 * to bars. Visible-range culled, per-bar stacked, four discrete sizes.
 */
import type { Bar } from '../model/bar';
import type { SeriesId } from '../model/data-layer';
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from './primitive';

export type MarkerShape =
  | 'arrowUp' | 'arrowDown' | 'circle' | 'square'
  | 'triangleUp' | 'triangleDown' | 'diamond' | 'flag' | 'text';
export type MarkerPosition = 'aboveBar' | 'belowBar' | 'inBar' | 'atPrice';
export type MarkerSize = 'tiny' | 'small' | 'medium' | 'big';

export interface SeriesMarker {
  time: number;
  position: MarkerPosition;
  price?: number;
  shape: MarkerShape;
  size: MarkerSize;
  color: string;
  text?: string;
  id?: string;
}

const SIZE_PX: Record<MarkerSize, number> = { tiny: 6, small: 9, medium: 12, big: 16 };

/** Base glyph size in CSS px for a marker size preset. */
export function markerSizePx(size: MarkerSize): number {
  return SIZE_PX[size];
}

/** Effective glyph px, clamped so it never exceeds the current bar spacing. */
export function effectiveMarkerPx(size: MarkerSize, barSpacing: number): number {
  return Math.max(4, Math.min(SIZE_PX[size], Math.floor(barSpacing)));
}

export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: MarkerShape,
  cx: number,
  cy: number,
  px: number,
  color: string,
): void {
  const r = px / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.beginPath();
  switch (shape) {
    case 'arrowUp':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath(); ctx.fill();
      break;
    case 'triangleUp':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath(); ctx.fill();
      break;
    case 'arrowDown':
      ctx.moveTo(cx, cy + r); ctx.lineTo(cx + r, cy - r); ctx.lineTo(cx - r, cy - r); ctx.closePath(); ctx.fill();
      break;
    case 'triangleDown':
      ctx.moveTo(cx, cy + r); ctx.lineTo(cx + r, cy - r); ctx.lineTo(cx - r, cy - r); ctx.closePath(); ctx.fill();
      break;
    case 'circle':
      ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      break;
    case 'square':
      ctx.fillRect(cx - r, cy - r, px, px);
      break;
    case 'diamond':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); ctx.fill();
      break;
    case 'flag':
      ctx.fillRect(cx - 1, cy - r, Math.max(1, px / 8), px); // pole
      ctx.fillRect(cx, cy - r, r, r * 0.8); // flag
      break;
    case 'text':
      // text-only marker: nothing drawn here; label handled by caller
      break;
  }
}

export class SeriesMarkers implements IPrimitive {
  private readonly _seriesId: SeriesId;
  private _markers: SeriesMarker[] = [];
  private _host: PrimitiveHost | null = null;
  private _lastPositions: { id: string; x: number; y: number }[] = [];

  public constructor(seriesId: SeriesId) {
    this._seriesId = seriesId;
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'normal'; }

  public setMarkers(markers: readonly SeriesMarker[]): void {
    this._markers = markers.slice().sort((a, b) => a.time - b.time);
    this._host?.requestUpdate();
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    this._lastPositions = [];
    if (this._markers.length === 0) return;
    const barByTime = new Map<number, Bar>();
    for (const ib of rc.dataLayer.indexedBars(this._seriesId)) barByTime.set(ib.bar.time, ib.bar);
    const range = rc.timeScale.visibleRange();
    const stackByTime = new Map<number, number>();

    ctx.save();
    for (const m of this._markers) {
      const index = rc.dataLayer.timeToIndex(m.time);
      if (index === undefined || index < range.from - 1 || index > range.to + 1) continue;
      const bar = barByTime.get(m.time);
      const px = effectiveMarkerPx(m.size, rc.timeScale.barSpacing) * rc.dpr;
      const x = rc.timeScale.indexToX(index) * rc.dpr;
      const stack = stackByTime.get(m.time) ?? 0;
      const gap = (px + 4 * rc.dpr) * stack;
      let y: number;
      if (m.position === 'atPrice' && m.price !== undefined) {
        y = rc.priceScale.priceToY(m.price) * rc.dpr;
      } else if (bar !== undefined && m.position === 'aboveBar') {
        y = rc.priceScale.priceToY(bar.high) * rc.dpr - px - gap;
      } else if (bar !== undefined && m.position === 'belowBar') {
        y = rc.priceScale.priceToY(bar.low) * rc.dpr + px + gap;
      } else if (bar !== undefined) {
        y = rc.priceScale.priceToY((bar.open + bar.close) / 2) * rc.dpr;
      } else {
        continue;
      }
      stackByTime.set(m.time, stack + 1);
      drawShape(ctx, m.shape, x, y, px, m.color);
      if (m.text !== undefined) {
        ctx.fillStyle = m.color;
        ctx.font = `${Math.max(9, markerSizePx(m.size)) * rc.dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = m.position === 'belowBar' ? 'top' : 'bottom';
        const ty = m.position === 'belowBar' ? y + px : y - px;
        ctx.fillText(m.text, x, ty);
      }
      if (m.id !== undefined) this._lastPositions.push({ id: m.id, x: x / rc.dpr, y: y / rc.dpr });
    }
    ctx.restore();
  }

  public hitTest(x: number, y: number): PrimitiveHit | null {
    let best: PrimitiveHit | null = null;
    for (const p of this._lastPositions) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= 8 && (best === null || d < best.distance)) {
        best = { externalId: p.id, zOrder: 'normal', distance: d, cursor: 'pointer' };
      }
    }
    return best;
  }
}
