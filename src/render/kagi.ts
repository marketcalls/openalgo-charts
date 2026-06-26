/**
 * Kagi renderer (ARCHITECTURE.md §6A). Connects kagi vertices (from the Kagi
 * transform) with a stepped line — horizontal connector then vertical move —
 * switching line width on the per-vertex thickness flag (bar.volume: 1 = thick
 * yang, 0 = thin yin).
 */
import type { DrawItem } from '../model/chart-type-registry';
import type { SeriesStyle } from './series-style';

export function drawKagi(
  ctx: CanvasRenderingContext2D,
  items: readonly DrawItem[],
  toY: (v: number) => number,
  dpr: number,
  style: SeriesStyle,
): void {
  if (items.length < 2) return;
  const thickColor = style.thickColor ?? '#26a69a';
  const thinColor = style.thinColor ?? '#ef5350';
  const thickW = Math.max(2, Math.round(2.5 * dpr));
  const thinW = Math.max(1, Math.round(dpr));

  ctx.save();
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    const thick = (cur.bar.volume ?? 0) >= 1;
    ctx.strokeStyle = thick ? thickColor : thinColor;
    ctx.lineWidth = thick ? thickW : thinW;
    const px = prev.x * dpr;
    const cx = cur.x * dpr;
    const py = toY(prev.bar.close) * dpr;
    const cy = toY(cur.bar.close) * dpr;
    ctx.beginPath();
    ctx.moveTo(px, py); // horizontal connector at the prior level
    ctx.lineTo(cx, py);
    ctx.lineTo(cx, cy); // vertical move to the new level
    ctx.stroke();
  }
  ctx.restore();
}
