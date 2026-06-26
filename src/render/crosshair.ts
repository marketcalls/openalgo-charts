/**
 * Crosshair renderer (ARCHITECTURE.md §3.1, §6). Drawn on the pane's *top*
 * canvas so a cursor move only repaints the cheap overlay, never the series.
 */
export interface CrosshairStyle {
  color: string;
  lineWidth: number;
  dash: [number, number];
}

export const DEFAULT_CROSSHAIR_STYLE: CrosshairStyle = {
  color: '#6b7280',
  lineWidth: 1,
  dash: [4, 4],
};

/** Draw the crosshair lines within the plot area (bitmap scope). */
export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  plotWidth: number,
  plotHeight: number,
  dpr: number,
  style: CrosshairStyle = DEFAULT_CROSSHAIR_STYLE,
): void {
  const px = Math.round(x * dpr) + 0.5;
  const py = Math.round(y * dpr) + 0.5;
  const w = Math.round(plotWidth * dpr);
  const h = Math.round(plotHeight * dpr);
  if (x < 0 || x > plotWidth || y < 0 || y > plotHeight) return;

  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = Math.max(1, Math.round(style.lineWidth * dpr));
  ctx.setLineDash([style.dash[0] * dpr, style.dash[1] * dpr]);
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.moveTo(0, py);
  ctx.lineTo(w, py);
  ctx.stroke();
  ctx.restore();
}
