/**
 * Axis label rendering (ARCHITECTURE.md §6, §5.3). Price axis (right strip) and
 * time axis (bottom strip). Time labels switch from clock to date at IST day
 * boundaries; gaps are already collapsed by the logical-index time scale.
 */
import type { PriceScale } from '../scale/price-scale';
import type { TimeScale } from '../scale/time-scale';
import type { DataLayer } from '../model/data-layer';
import { niceTicks } from '../scale/ticks';
import { formatIstTime, formatIstDate, isNewIstDay } from '../feed/time';

export interface AxisStyle {
  textColor: string;
  lineColor: string;
  font: string; // CSS font at dpr=1; scaled by dpr at draw time
}

export const DEFAULT_AXIS_STYLE: AxisStyle = {
  textColor: '#8b91a7',
  lineColor: '#2a3046',
  font: '11px system-ui, sans-serif',
};

export interface PlotLayout {
  plotWidth: number;
  plotHeight: number;
  priceAxisWidth: number;
  timeAxisHeight: number;
}

/** Draw price tick labels in the right axis strip (bitmap scope). */
export function drawPriceAxis(
  ctx: CanvasRenderingContext2D,
  priceScale: PriceScale,
  layout: PlotLayout,
  dpr: number,
  style: AxisStyle = DEFAULT_AXIS_STYLE,
): void {
  const range = priceScale.priceRange();
  const ticks = niceTicks(range.min, range.max, 6);
  const xStart = Math.round(layout.plotWidth * dpr);

  ctx.save();
  ctx.strokeStyle = style.lineColor;
  ctx.fillStyle = style.textColor;
  ctx.font = scaleFont(style.font, dpr);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;

  // axis separator
  ctx.beginPath();
  ctx.moveTo(xStart + 0.5, 0);
  ctx.lineTo(xStart + 0.5, Math.round(layout.plotHeight * dpr));
  ctx.stroke();

  for (const price of ticks) {
    const y = Math.round(priceScale.priceToY(price) * dpr);
    if (y < 0 || y > layout.plotHeight * dpr) continue;
    ctx.fillText(priceScale.format(price), xStart + 6 * dpr, y);
  }
  ctx.restore();
}

/** Draw time tick labels along the bottom axis strip (bitmap scope). */
export function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  timeScale: TimeScale,
  dataLayer: DataLayer,
  layout: PlotLayout,
  dpr: number,
  style: AxisStyle = DEFAULT_AXIS_STYLE,
): void {
  const range = timeScale.visibleRange();
  const from = Math.max(0, Math.floor(range.from));
  const to = Math.min(dataLayer.baseIndex, Math.ceil(range.to));
  if (to < from) return;

  // Label roughly every ~80px to avoid crowding.
  const stride = Math.max(1, Math.round(80 / Math.max(1, timeScale.barSpacing)));
  const yBase = Math.round(layout.plotHeight * dpr);

  ctx.save();
  ctx.fillStyle = style.textColor;
  ctx.strokeStyle = style.lineColor;
  ctx.font = scaleFont(style.font, dpr);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, yBase + 0.5);
  ctx.lineTo(Math.round(layout.plotWidth * dpr), yBase + 0.5);
  ctx.stroke();

  let prevTime: number | undefined;
  for (let i = from; i <= to; i += stride) {
    const time = dataLayer.indexToTime(i);
    if (time === undefined) continue;
    const x = Math.round(timeScale.indexToX(i) * dpr);
    if (x < 0 || x > layout.plotWidth * dpr) {
      prevTime = time;
      continue;
    }
    const label = prevTime === undefined || isNewIstDay(prevTime, time)
      ? formatIstDate(time)
      : formatIstTime(time);
    ctx.fillText(label, x, yBase + 4 * dpr);
    prevTime = time;
  }
  ctx.restore();
}

/**
 * Draw the last-price line (dashed, across the plot) plus a filled price tag on
 * the right axis, colored up/down. Updates cheaply with every live tick.
 */
export interface LastPriceColors {
  up: string;
  down: string;
  text: string;
}

export function drawLastPriceLabel(
  ctx: CanvasRenderingContext2D,
  priceScale: PriceScale,
  price: number,
  up: boolean,
  layout: PlotLayout,
  dpr: number,
  style: AxisStyle = DEFAULT_AXIS_STYLE,
  colors: LastPriceColors = { up: '#26a69a', down: '#ef5350', text: '#0d0e12' },
): void {
  const y = Math.round(priceScale.priceToY(price) * dpr);
  if (y < 0 || y > layout.plotHeight * dpr) return;
  const color = up ? colors.up : colors.down;
  const xStart = Math.round(layout.plotWidth * dpr);

  ctx.save();
  // dashed line across the plot
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, Math.round(dpr));
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.beginPath();
  ctx.moveTo(0, y + 0.5);
  ctx.lineTo(xStart, y + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  // filled price tag on the right axis
  const label = priceScale.format(price);
  ctx.font = scaleFont(style.font, dpr);
  const padX = 6 * dpr;
  const boxH = 16 * dpr;
  const textW = ctx.measureText(label).width;
  ctx.fillStyle = color;
  ctx.fillRect(xStart + 1, y - boxH / 2, textW + padX * 2, boxH);
  ctx.fillStyle = colors.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, xStart + 1 + padX, y);
  ctx.restore();
}

function scaleFont(font: string, dpr: number): string {
  // Multiply the leading "<n>px" by dpr; leave the rest of the font string intact.
  return font.replace(/(\d+(?:\.\d+)?)px/, (_, px: string) => `${Number(px) * dpr}px`);
}
