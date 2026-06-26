/**
 * Point & Figure renderer (ARCHITECTURE.md §6A). Each column Bar (from the P&F
 * transform) is drawn as stacked X (up) or O (down) glyphs over its price range,
 * using `boxSize` from the style to size the stack.
 */
import type { DrawItem } from '../model/chart-type-registry';
import type { SeriesStyle } from './series-style';

export function drawPointFigure(
  ctx: CanvasRenderingContext2D,
  items: readonly DrawItem[],
  toY: (v: number) => number,
  barSpacing: number,
  dpr: number,
  style: SeriesStyle,
): void {
  const box = style.boxSize ?? 0;
  if (box <= 0) return;
  const cellW = Math.max(3, Math.floor(barSpacing * dpr * 0.7));
  const r = cellW / 2;
  ctx.save();
  ctx.lineWidth = Math.max(1, Math.floor(dpr));
  for (const { x, bar } of items) {
    const up = bar.close >= bar.open;
    ctx.strokeStyle = up ? (style.upColor ?? '#26a69a') : (style.downColor ?? '#ef5350');
    const cx = x * dpr;
    for (let level = bar.low; level < bar.high - 1e-9; level += box) {
      const yTop = toY(level + box) * dpr;
      const yBot = toY(level) * dpr;
      const cy = (yTop + yBot) / 2;
      ctx.beginPath();
      if (up) {
        // X glyph
        ctx.moveTo(cx - r, yTop); ctx.lineTo(cx + r, yBot);
        ctx.moveTo(cx + r, yTop); ctx.lineTo(cx - r, yBot);
      } else {
        // O glyph
        ctx.ellipse(cx, cy, r, Math.abs(yBot - yTop) / 2, 0, 0, Math.PI * 2);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}
