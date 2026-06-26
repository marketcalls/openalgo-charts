/**
 * Chart-type registry (ARCHITECTURE.md §6A). Every series type registers a
 * descriptor: how to draw it and how it contributes to autoscale. The core
 * iterates descriptors, so adding a style is one registration — no core change.
 * Phase 5 fills the Family-A (time-indexed) types; Families B/C plug in later.
 */
import type { Bar } from './bar';
import type { SeriesStyle } from '../render/series-style';
import { drawCandles, DEFAULT_CANDLE_STYLE, type CandleStyle } from '../render/candles';
import { drawBars, drawColumns } from '../render/bars';
import { drawLine, drawArea, drawBaseline, drawHlcArea } from '../render/line';
import { drawHistogram, type HistogramStyle } from '../render/histogram';

export type SeriesType =
  | 'candlestick'
  | 'hollow-candle'
  | 'volume-candle'
  | 'bar'
  | 'high-low'
  | 'line'
  | 'line-markers'
  | 'step'
  | 'area'
  | 'hlc-area'
  | 'baseline'
  | 'column'
  | 'histogram'
  | 'point-figure'
  | 'kagi';

export interface DrawItem {
  x: number; // bar center, media px
  bar: Bar;
}

export interface SeriesRenderContext {
  plotHeight: number;
  maxVolume: number;
}

export interface RendererEntry {
  defaultStyle: SeriesStyle;
  /** True for the price series whose last close drives the last-price line. */
  isPriceSeries: boolean;
  draw(
    ctx: CanvasRenderingContext2D,
    items: readonly DrawItem[],
    toY: (v: number) => number,
    barSpacing: number,
    dpr: number,
    style: SeriesStyle,
    rc: SeriesRenderContext,
  ): void;
  /** Min/max price contribution of one bar to autoscale. */
  extents(bar: Bar, style: SeriesStyle): { min: number; max: number };
}

function candleStyle(s: SeriesStyle, extra: Partial<CandleStyle> = {}): CandleStyle {
  return {
    ...DEFAULT_CANDLE_STYLE,
    upColor: s.upColor ?? DEFAULT_CANDLE_STYLE.upColor,
    downColor: s.downColor ?? DEFAULT_CANDLE_STYLE.downColor,
    borderUpColor: s.borderUpColor ?? DEFAULT_CANDLE_STYLE.borderUpColor,
    borderDownColor: s.borderDownColor ?? DEFAULT_CANDLE_STYLE.borderDownColor,
    wickUpColor: s.wickUpColor ?? DEFAULT_CANDLE_STYLE.wickUpColor,
    wickDownColor: s.wickDownColor ?? DEFAULT_CANDLE_STYLE.wickDownColor,
    borderVisible: s.borderVisible ?? DEFAULT_CANDLE_STYLE.borderVisible,
    wickVisible: s.wickVisible ?? DEFAULT_CANDLE_STYLE.wickVisible,
    ...extra,
  };
}

const hiLo = (bar: Bar): { min: number; max: number } => ({ min: bar.low, max: bar.high });
const closeOnly = (bar: Bar): { min: number; max: number } => ({ min: bar.close, max: bar.close });
const fromBase = (bar: Bar, s: SeriesStyle): { min: number; max: number } => {
  const base = s.base ?? 0;
  return { min: Math.min(base, bar.close), max: Math.max(base, bar.close) };
};

const registry = new Map<SeriesType, RendererEntry>();

export function registerChartType(type: SeriesType, entry: RendererEntry): void {
  registry.set(type, entry);
}

export function getChartType(type: SeriesType): RendererEntry {
  const e = registry.get(type);
  if (e === undefined) throw new Error(`openalgo-charts: unknown series type "${type}"`);
  return e;
}

export function registeredChartTypes(): SeriesType[] {
  return Array.from(registry.keys());
}

// ── Family A registrations ────────────────────────────────────────────────

registerChartType('candlestick', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s) => drawCandles(g, items, toY, bs, dpr, candleStyle(s)),
  extents: hiLo,
});

registerChartType('hollow-candle', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s) => drawCandles(g, items, toY, bs, dpr, candleStyle(s, { hollow: true })),
  extents: hiLo,
});

registerChartType('volume-candle', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s, rc) => {
    const max = rc.maxVolume;
    const scaled = candleStyle(s, { widthScale: (b) => (max > 0 ? (b.volume ?? 0) / max : 1) });
    drawCandles(g, items, toY, bs, dpr, scaled);
  },
  extents: hiLo,
});

registerChartType('bar', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s) => drawBars(g, items, toY, bs, dpr, s),
  extents: hiLo,
});

registerChartType('high-low', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s) => drawBars(g, items, toY, bs, dpr, s, true),
  extents: hiLo,
});

registerChartType('line', {
  defaultStyle: { color: '#4f8cff', lineWidth: 1.5 }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s) => drawLine(g, items, toY, dpr, s),
  extents: closeOnly,
});

registerChartType('line-markers', {
  defaultStyle: { color: '#4f8cff', lineWidth: 1.5, markers: true }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s) => drawLine(g, items, toY, dpr, { ...s, markers: true }),
  extents: closeOnly,
});

registerChartType('step', {
  defaultStyle: { color: '#4f8cff', lineWidth: 1.5, step: true }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s) => drawLine(g, items, toY, dpr, { ...s, step: true }),
  extents: closeOnly,
});

registerChartType('area', {
  defaultStyle: { color: '#4f8cff', lineWidth: 1.5 }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s, rc) => drawArea(g, items, toY, dpr, rc.plotHeight, s),
  extents: closeOnly,
});

registerChartType('hlc-area', {
  defaultStyle: { lineWidth: 1.5 }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s) => drawHlcArea(g, items, toY, dpr, s),
  extents: hiLo,
});

registerChartType('baseline', {
  defaultStyle: { baseValue: 0, topColor: '#26a69a', bottomColor: '#ef5350', lineWidth: 1.5 }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s) => drawBaseline(g, items, toY, dpr, s),
  extents: (bar, s) => {
    const base = s.baseValue ?? 0;
    return { min: Math.min(base, bar.close), max: Math.max(base, bar.close) };
  },
});

registerChartType('column', {
  defaultStyle: { base: 0 }, isPriceSeries: false,
  draw: (g, items, toY, bs, dpr, s) => drawColumns(g, items, toY, bs, dpr, s),
  extents: fromBase,
});

registerChartType('histogram', {
  defaultStyle: { base: 0, color: '#3a4666' }, isPriceSeries: false,
  draw: (g, items, toY, bs, dpr, s) => {
    const hs: HistogramStyle = { color: s.color ?? '#3a4666', base: s.base ?? 0 };
    drawHistogram(g, items, toY, bs, dpr, hs);
  },
  extents: fromBase,
});

// NOTE: 'point-figure' and 'kagi' are registered by the transform tier
// (src/transform/index.ts) so their renderers stay out of the base bundle.
// They are valid SeriesType names but only resolve once that tier is loaded.
