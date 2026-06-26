/**
 * Background grid (ARCHITECTURE.md §6). Phase 1 draws an evenly-spaced grid;
 * Phase 2 will drive line positions from the time/price scale tick marks.
 */
import { snapToDevicePixel } from '../core/canvas';

export interface GridLines {
  /** Vertical line x-positions in media (CSS) px. */
  verticals: number[];
  /** Horizontal line y-positions in media (CSS) px. */
  horizontals: number[];
}

export interface GridOptions {
  /** Target spacing between grid lines, in media px. */
  spacing: number;
}

/**
 * Pure: compute evenly-spaced grid line positions for a pane of the given
 * media size. Lines start one `spacing` in from the top-left and never sit on
 * the 0 edge (which the axis border owns).
 */
export function computeGridLines(width: number, height: number, opts: GridOptions): GridLines {
  const spacing = Math.max(1, opts.spacing);
  const verticals: number[] = [];
  for (let x = spacing; x < width; x += spacing) verticals.push(x);
  const horizontals: number[] = [];
  for (let y = spacing; y < height; y += spacing) horizontals.push(y);
  return { verticals, horizontals };
}

export interface GridStyle {
  color: string;
  lineWidth: number;
}

/**
 * Draw the grid onto a bitmap-scope context (device px). Coordinates are given
 * in media px and snapped to crisp device-pixel edges.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  lines: GridLines,
  mediaWidth: number,
  mediaHeight: number,
  dpr: number,
  style: GridStyle,
): void {
  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = Math.max(1, Math.round(style.lineWidth * dpr));
  ctx.beginPath();
  const w = Math.round(mediaWidth * dpr);
  const h = Math.round(mediaHeight * dpr);
  for (const x of lines.verticals) {
    const px = Math.round(snapToDevicePixel(x, dpr) * dpr) + 0.0;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  for (const y of lines.horizontals) {
    const py = Math.round(snapToDevicePixel(y, dpr) * dpr) + 0.0;
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
  }
  ctx.stroke();
  ctx.restore();
}
