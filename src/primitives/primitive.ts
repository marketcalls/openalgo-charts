/**
 * Primitive / plugin API (ARCHITECTURE.md §8). The extension point that keeps
 * the core small and powers markers, events, indicators, and the trade layer.
 * A primitive draws on a pane, optionally contributes to autoscale, and
 * optionally hit-tests for hover/drag.
 */
import type { TimeScale } from '../scale/time-scale';
import type { PriceScale } from '../scale/price-scale';
import type { DataLayer } from '../model/data-layer';
import type { ChartTheme } from '../theme';

export type ZOrder = 'bottom' | 'normal' | 'top';

export interface PrimitiveRenderContext {
  timeScale: TimeScale;
  priceScale: PriceScale;
  dataLayer: DataLayer;
  plotWidth: number;
  plotHeight: number;
  priceAxisWidth: number;
  dpr: number;
  theme: ChartTheme;
}

export interface PrimitiveHit {
  externalId: string;
  zOrder: ZOrder;
  /** Pixel distance from the cursor (smaller wins ties before z-order). */
  distance: number;
  cursor?: string;
}

/** Injected when a primitive is attached; lets it request a repaint. */
export interface PrimitiveHost {
  requestUpdate(): void;
}

export interface IPrimitive {
  /** Layer order vs series: 'bottom' (behind), 'normal' (over), 'top' (overlay). */
  zOrder(): ZOrder;
  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void;
  /** Optional: expand the pane's autoscale range so this primitive isn't clipped. */
  autoscaleInfo?(): { min: number; max: number } | null;
  /** Optional: topmost hit under (x,y) in media px (relative to the pane plot). */
  hitTest?(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null;
  attached?(host: PrimitiveHost): void;
  detached?(): void;
}

/** Pick the best hit across primitives: nearest distance, then z-order priority. */
export function bestHit(hits: readonly (PrimitiveHit | null)[]): PrimitiveHit | null {
  const order: Record<ZOrder, number> = { top: 2, normal: 1, bottom: 0 };
  let best: PrimitiveHit | null = null;
  for (const h of hits) {
    if (h === null) continue;
    if (
      best === null ||
      h.distance < best.distance ||
      (h.distance === best.distance && order[h.zOrder] > order[best.zOrder])
    ) {
      best = h;
    }
  }
  return best;
}
