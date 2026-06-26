/**
 * Event markers (ARCHITECTURE.md §8.2): Earnings / Dividend / Split badges in a
 * strip near the bottom of the plot. Time-anchored only (no price). Hover/click
 * carry an external id for tooltip wiring. Data source is an integration concern
 * (OpenAlgo has no corporate-actions calendar) — the renderer ships regardless.
 */
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from './primitive';

export interface ChartEvent {
  time: number;
  type: 'earnings' | 'dividend' | 'split' | 'news' | string;
  label: string;
  color?: string;
  id?: string;
}

const TYPE_COLOR: Record<string, string> = {
  earnings: '#f0a020',
  dividend: '#26a69a',
  split: '#4f8cff',
  news: '#9aa0b4',
};

export class EventMarkers implements IPrimitive {
  private _events: ChartEvent[] = [];
  private _host: PrimitiveHost | null = null;
  private _positions: { id: string; x: number; y: number; r: number }[] = [];

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; }
  public zOrder(): ZOrder { return 'normal'; }

  public setEvents(events: readonly ChartEvent[]): void {
    this._events = events.slice().sort((a, b) => a.time - b.time);
    this._host?.requestUpdate();
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    this._positions = [];
    if (this._events.length === 0) return;
    const range = rc.timeScale.visibleRange();
    const r = 8 * rc.dpr;
    const cy = rc.plotHeight * rc.dpr - r - 4 * rc.dpr;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${10 * rc.dpr}px system-ui, sans-serif`;
    for (const ev of this._events) {
      const index = rc.dataLayer.timeToIndex(ev.time);
      if (index === undefined || index < range.from - 1 || index > range.to + 1) continue;
      const x = rc.timeScale.indexToX(index) * rc.dpr;
      const color = ev.color ?? TYPE_COLOR[ev.type] ?? '#9aa0b4';
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0d0e12';
      ctx.fillText(ev.label.slice(0, 2), x, cy);
      if (ev.id !== undefined) this._positions.push({ id: ev.id, x: x / rc.dpr, y: cy / rc.dpr, r: r / rc.dpr });
    }
    ctx.restore();
  }

  public hitTest(x: number, y: number): PrimitiveHit | null {
    let best: PrimitiveHit | null = null;
    for (const p of this._positions) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= p.r && (best === null || d < best.distance)) {
        best = { externalId: p.id, zOrder: 'normal', distance: d, cursor: 'pointer' };
      }
    }
    return best;
  }
}
