/**
 * Candlestick renderer (ARCHITECTURE.md §6). Pure geometry helpers are split
 * out for unit testing; drawing happens in the bitmap (device-px) scope.
 */
import type { Bar } from '../model/bar';

export interface CandleStyle {
  upColor: string;
  downColor: string;
  borderUpColor: string;
  borderDownColor: string;
  wickUpColor: string;
  wickDownColor: string;
  borderVisible: boolean;
  wickVisible: boolean;
  /** Draw up-candle bodies as outlines only (hollow candles). */
  hollow?: boolean;
  /** Per-bar body-width scale 0..1 (volume candles); 1 = full width. */
  widthScale?: (bar: Bar) => number;
}

export const DEFAULT_CANDLE_STYLE: CandleStyle = {
  upColor: '#26a69a',
  downColor: '#ef5350',
  borderUpColor: '#26a69a',
  borderDownColor: '#ef5350',
  wickUpColor: '#26a69a',
  wickDownColor: '#ef5350',
  borderVisible: true,
  wickVisible: true,
};

/**
 * Pure: optimal candle body width in device px for a given bar spacing. Leaves
 * a ~1px gap between candles, keeps a minimum of 1px, and matches odd/even
 * parity with the wick so the body stays symmetric about the (1px) wick.
 */
export function optimalBarWidth(barSpacing: number, dpr: number): number {
  const raw = Math.floor(barSpacing * dpr * 0.8);
  let w = Math.max(1, raw);
  if (w >= 2) {
    const wick = Math.max(1, Math.floor(dpr));
    if (w % 2 !== wick % 2) w -= 1;
  }
  return Math.max(1, w);
}

export interface CandleDrawItem {
  /** Bar center x, media px. */
  x: number;
  bar: Bar;
}

/**
 * Draw candles onto a bitmap-scope context. `priceToY` and `x` are media-px;
 * everything is multiplied by `dpr` and snapped to device pixels here.
 */
export function drawCandles(
  ctx: CanvasRenderingContext2D,
  items: readonly CandleDrawItem[],
  priceToY: (price: number) => number,
  barSpacing: number,
  dpr: number,
  style: CandleStyle = DEFAULT_CANDLE_STYLE,
): void {
  const bodyW = optimalBarWidth(barSpacing, dpr);
  const wickW = Math.max(1, Math.floor(dpr));

  for (const { x, bar } of items) {
    const up = bar.close >= bar.open;
    const cx = Math.round(x * dpr);
    const yOpen = Math.round(priceToY(bar.open) * dpr);
    const yClose = Math.round(priceToY(bar.close) * dpr);
    const yHigh = Math.round(priceToY(bar.high) * dpr);
    const yLow = Math.round(priceToY(bar.low) * dpr);

    // Per-bar width (volume candles scale the body by relative volume).
    const scale = style.widthScale ? Math.max(0.05, Math.min(1, style.widthScale(bar))) : 1;
    const w = scale === 1 ? bodyW : Math.max(1, Math.round(bodyW * scale));
    const halfW = Math.floor(w / 2);

    if (style.wickVisible) {
      ctx.fillStyle = up ? style.wickUpColor : style.wickDownColor;
      ctx.fillRect(cx - Math.floor(wickW / 2), yHigh, wickW, Math.max(1, yLow - yHigh));
    }

    const top = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    const color = up ? style.upColor : style.downColor;

    if (style.hollow && up) {
      // hollow up candle: outline only
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, wickW);
      ctx.strokeRect(cx - halfW + 0.5, top + 0.5, w - 1, bodyH - 1);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(cx - halfW, top, w, bodyH);
      if (style.borderVisible && w >= 3 && !style.hollow) {
        ctx.strokeStyle = up ? style.borderUpColor : style.borderDownColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx - halfW + 0.5, top + 0.5, w - 1, bodyH - 1);
      }
    }
  }
}
