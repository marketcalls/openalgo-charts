/**
 * Chart-type registry (ARCHITECTURE.md §6A). Every series type registers a
 * descriptor: how to draw it and how it contributes to autoscale. The core
 * iterates descriptors, so adding a style is one registration — no core change.
 * Phase 5 fills the Family-A (time-indexed) types; Families B/C plug in later.
 */
import type { Bar } from './bar';
import type { SeriesStyle } from '../render/series-style';
import type { ChartTheme } from '../theme';
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
  theme: ChartTheme;
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

function candleStyle(s: SeriesStyle, theme: ChartTheme, extra: Partial<CandleStyle> = {}): CandleStyle {
  return {
    ...DEFAULT_CANDLE_STYLE,
    upColor: s.upColor ?? theme.upColor,
    downColor: s.downColor ?? theme.downColor,
    borderUpColor: s.borderUpColor ?? theme.upColor,
    borderDownColor: s.borderDownColor ?? theme.downColor,
    wickUpColor: s.wickUpColor ?? theme.wickUpColor,
    wickDownColor: s.wickDownColor ?? theme.wickDownColor,
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

const registry = new Map<string, RendererEntry>();

/** Series types that live in the lazy transform tier (registered on its import). */
const TRANSFORM_TIER_TYPES: ReadonlySet<string> = new Set(['point-figure', 'kagi']);

/** Register a chart type. `type` accepts a built-in `SeriesType` or any custom string. */
export function registerChartType(type: SeriesType | (string & {}), entry: RendererEntry): void {
  registry.set(type, entry);
}

export function getChartType(type: SeriesType | (string & {})): RendererEntry {
  const e = registry.get(type);
  if (e === undefined) {
    if (TRANSFORM_TIER_TYPES.has(type)) {
      throw new Error(`openalgo-charts: series type "${type}" needs the transform tier — import 'openalgo-charts/transform' first`);
    }
    throw new Error(`openalgo-charts: unknown series type "${type}"`);
  }
  return e;
}

export function registeredChartTypes(): string[] {
  return Array.from(registry.keys());
}

// ── Family A registrations ────────────────────────────────────────────────

// Fill common up/down color defaults from the theme.
const ud = (s: SeriesStyle, t: ChartTheme): SeriesStyle => ({
  ...s, upColor: s.upColor ?? t.upColor, downColor: s.downColor ?? t.downColor,
});

registerChartType('candlestick', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s, rc) => drawCandles(g, items, toY, bs, dpr, candleStyle(s, rc.theme)),
  extents: hiLo,
});

registerChartType('hollow-candle', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s, rc) => drawCandles(g, items, toY, bs, dpr, candleStyle(s, rc.theme, { hollow: true })),
  extents: hiLo,
});

registerChartType('volume-candle', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s, rc) => {
    const max = rc.maxVolume;
    const scaled = candleStyle(s, rc.theme, { widthScale: (b) => (max > 0 ? (b.volume ?? 0) / max : 1) });
    drawCandles(g, items, toY, bs, dpr, scaled);
  },
  extents: hiLo,
});

registerChartType('bar', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s, rc) => drawBars(g, items, toY, bs, dpr, ud(s, rc.theme)),
  extents: hiLo,
});

registerChartType('high-low', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s, rc) => drawBars(g, items, toY, bs, dpr, ud(s, rc.theme), true),
  extents: hiLo,
});

registerChartType('line', {
  defaultStyle: { lineWidth: 1.5 }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s, rc) => drawLine(g, items, toY, dpr, { ...s, color: s.color ?? rc.theme.lineColor }),
  extents: closeOnly,
});

registerChartType('line-markers', {
  defaultStyle: { lineWidth: 1.5, markers: true }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s, rc) => drawLine(g, items, toY, dpr, { ...s, color: s.color ?? rc.theme.lineColor, markers: true }),
  extents: closeOnly,
});

registerChartType('step', {
  defaultStyle: { lineWidth: 1.5, step: true }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s, rc) => drawLine(g, items, toY, dpr, { ...s, color: s.color ?? rc.theme.lineColor, step: true }),
  extents: closeOnly,
});

registerChartType('area', {
  defaultStyle: { lineWidth: 1.5 }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s, rc) => drawArea(g, items, toY, dpr, rc.plotHeight, {
    ...s,
    color: s.color ?? rc.theme.lineColor,
    areaTopColor: s.areaTopColor ?? rc.theme.areaTopColor,
    areaBottomColor: s.areaBottomColor ?? rc.theme.areaBottomColor,
  }),
  extents: closeOnly,
});

registerChartType('hlc-area', {
  defaultStyle: { lineWidth: 1.5 }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s, rc) => drawHlcArea(g, items, toY, dpr, { ...s, closeColor: s.closeColor ?? rc.theme.lineColor }),
  extents: hiLo,
});

registerChartType('baseline', {
  defaultStyle: { baseValue: 0, lineWidth: 1.5 }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s, rc) => drawBaseline(g, items, toY, dpr, {
    ...s,
    topColor: s.topColor ?? rc.theme.baselineTopLine,
    bottomColor: s.bottomColor ?? rc.theme.baselineBottomLine,
    areaTopColor: s.areaTopColor ?? rc.theme.baselineTopFill,
    areaBottomColor: s.areaBottomColor ?? rc.theme.baselineBottomFill,
  }),
  extents: (bar, s) => {
    const base = s.baseValue ?? 0;
    return { min: Math.min(base, bar.close), max: Math.max(base, bar.close) };
  },
});

registerChartType('column', {
  defaultStyle: { base: 0 }, isPriceSeries: false,
  draw: (g, items, toY, bs, dpr, s, rc) => drawColumns(g, items, toY, bs, dpr, ud(s, rc.theme)),
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
