/**
 * Primitive / plugin API (ARCHITECTURE.md §8). The extension point that keeps
 * the core small and powers markers, events, indicators, and the trade layer.
 * A primitive draws on a pane, optionally contributes to autoscale, and
 * optionally hit-tests for hover/drag.
 */
import type { TimeScale } from '../scale/time-scale';
import type { PriceScale } from '../scale/price-scale';
import type { DataLayer } from '../model/data-layer';
import type { Bar } from '../model/bar';
import type { ChartTheme } from '../theme';

export type ZOrder = 'bottom' | 'normal' | 'top';

export interface PrimitiveRenderContext {
  timeScale: TimeScale;
  /** Explicitly bound scale, or the pane's right scale for an unbound primitive. */
  priceScale: PriceScale;
  /** The pane's primary visible price series scale, including a moved left axis. */
  readoutPriceScale?: PriceScale;
  dataLayer: DataLayer;
  plotWidth: number;
  plotHeight: number;
  /** Width of the bound scale's axis column; zero for hidden scales. */
  priceAxisWidth: number;
  /** Axis placement for price labels. Absent retains the default right axis. */
  priceAxisSide?: 'left' | 'right' | 'hidden';
  /**
   * Plot-relative media-px x of the bound column's inner edge. Defaults to 0 on
   * the left and plotWidth on the right. An explicit offset confines axis tags
   * to this column without shifting the primitive's plot coordinates.
   */
  priceAxisOffset?: number;
  dpr: number;
  theme: ChartTheme;
  /**
   * The pane's primary price series, for a primitive that needs what price
   * actually did rather than just the scales — a forecast scoring itself, say.
   * Lazy, so nothing pays for it unless asked. Absent on synthetic contexts.
   */
  bars?: () => readonly Bar[];
  /** externalId of the primitive hit under the pointer (hover state), if any. */
  hoverId?: string | null;
  /** Optional subtarget identity; leaves the primitive's external click ID unchanged. */
  hoverKey?: string | null;
  /** externalId of the line being dragged (active state), if any. */
  dragId?: string | null;
}

export interface PrimitiveHit {
  externalId: string;
  /** Distinguishes hover regions which share one external click ID. Omission uses externalId. */
  hoverKey?: string;
  zOrder: ZOrder;
  /** Pixel distance from the cursor (smaller wins ties before z-order). */
  distance: number;
  cursor?: string;
  /** Coordinate scale for a bound primitive's drag prices. Unbound hits omit it. */
  priceScale?: PriceScale;
  /**
   * Arm a drag on press. Price lines set `cursor: 'ns-resize'` and move on one
   * axis; anything that moves on **both** (a drawing anchor, a whole shape)
   * declares it here, and the drag callbacks receive time as well as price.
   */
  draggable?: boolean;
  /** Opt into Escape cancellation without a release. Listen for `drag:cancel` to discard the preview. */
  cancelOnEscape?: boolean;
  /**
   * The primitive that paints what was hit, when it is not the one answering:
   * a drawing layer answers for the layers under it. The chart ranks the hit
   * by where that primitive paints, so a series painted over it takes the
   * context menu. Omission means the answering primitive painted it.
   */
  paintedBy?: IPrimitive;
}

/** Injected when a primitive is attached; lets it request a repaint. */
export interface PrimitiveHost {
  requestUpdate(): void;
}

/**
 * Where chart furniture lives, as distinct from pane furniture.
 *
 * A price line belongs to a pane. A brand mark, a corner clock or a session
 * badge belongs to the CHART: it should sit at an edge of the whole stack, and
 * follow that edge as indicator panes come and go. `chart-bottom` is the common
 * case, and it also survives maximize, which hides the other panes entirely and
 * would otherwise take a price-pane watermark with it.
 *
 * `primary-pane` is the third kind: furniture that describes the price, such
 * as a symbol badge, follows the primary price pane to whatever slot it is
 * moved to, and the pane maximized over it while it is hidden.
 */
export type PrimitiveAnchor = 'chart-top' | 'chart-bottom' | 'primary-pane';

/** Passed to `addPrimitive` instead of a pane index to anchor to the chart. */
export interface PrimitivePlacement {
  anchor: PrimitiveAnchor;
}

export interface IPrimitive {
  /** Layer order vs series: 'bottom' (behind), 'normal' (over), 'top' (overlay). */
  zOrder(): ZOrder;
  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void;
  /** Optional: expand the pane's autoscale range so this primitive isn't clipped. */
  autoscaleInfo?(): { min: number; max: number } | null;
  /**
   * Optional: run once per frame after every scale on the pane has been
   * measured, and before anything is painted.
   *
   * `draw` is too late for anything that has to change a scale, because the
   * price axis is painted near the top of `paintBase` while primitives draw
   * further down: a range corrected in `draw` labels its axis one frame late,
   * and on a static chart that frame never comes. A comparison overlay lining
   * its scale up with the pane's own is the case this exists for.
   */
  afterAutoscale?(): void;
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
