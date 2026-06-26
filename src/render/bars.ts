/**
 * Bar-family renderers (ARCHITECTURE.md §6A): OHLC bars, high-low bars, and
 * columns. Pure geometry helpers are split out for unit testing.
 */
import type { Bar } from '../model/bar';
import type { SeriesStyle } from './series-style';
import { optimalBarWidth } from './candles';

export interface BarDrawItem {
  x: number; // bar center, media px
  bar: Bar;
}

export interface BarGeometry {
  cx: number;
  yOpen: number;
  yClose: number;
  yHigh: number;
  yLow: number;
  up: boolean;
}

/** Pure: device-pixel geometry for one OHLC bar. */
export function barGeometry(item: BarDrawItem, toY: (v: number) => number, dpr: number): BarGeometry {
  const b = item.bar;
  return {
    cx: Math.round(item.x * dpr),
    yOpen: Math.round(toY(b.open) * dpr),
    yClose: Math.round(toY(b.close) * dpr),
    yHigh: Math.round(toY(b.high) * dpr),
    yLow: Math.round(toY(b.low) * dpr),
    up: b.close >= b.open,
  };
}

/** OHLC bars: vertical high→low, left tick = open, right tick = close. */
export function drawBars(
  ctx: CanvasRenderingContext2D,
  items: readonly BarDrawItem[],
  toY: (v: number) => number,
  barSpacing: number,
  dpr: number,
  style: SeriesStyle,
  highLowOnly = false,
): void {
  const tick = Math.max(1, Math.floor(optimalBarWidth(barSpacing, dpr) / 2));
  const lw = Math.max(1, Math.floor(dpr));
  ctx.save();
  for (const item of items) {
    const g = barGeometry(item, toY, dpr);
    ctx.fillStyle = g.up ? (style.upColor ?? '#26a69a') : (style.downColor ?? '#ef5350');
    ctx.fillRect(g.cx - Math.floor(lw / 2), g.yHigh, lw, Math.max(1, g.yLow - g.yHigh));
    if (!highLowOnly) {
      ctx.fillRect(g.cx - tick, g.yOpen, tick, lw); // open tick (left)
      ctx.fillRect(g.cx, g.yClose, tick, lw); // close tick (right)
    }
  }
  ctx.restore();
}

/** Columns: filled bars from a base value up to each bar's close. */
export function drawColumns(
  ctx: CanvasRenderingContext2D,
  items: readonly BarDrawItem[],
  toY: (v: number) => number,
  barSpacing: number,
  dpr: number,
  style: SeriesStyle,
): void {
  const w = optimalBarWidth(barSpacing, dpr);
  const half = Math.floor(w / 2);
  const baseY = Math.round(toY(style.base ?? 0) * dpr);
  ctx.save();
  for (const item of items) {
    const g = barGeometry(item, toY, dpr);
    ctx.fillStyle = g.up ? (style.upColor ?? '#26a69a') : (style.downColor ?? '#ef5350');
    const top = Math.min(baseY, g.yClose);
    ctx.fillRect(g.cx - half, top, w, Math.max(1, Math.abs(baseY - g.yClose)));
  }
  ctx.restore();
}
