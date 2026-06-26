// Transform tier (opt-in: "openalgo-charts/transform").
// Family B: price/movement-driven series. Run a transform over OHLC bars, then
// plot the result: Heikin Ashi / Renko / Range / Line Break render as a
// 'candlestick' series; Point & Figure → 'point-figure'; Kagi → 'kagi'.

import { registerChartType } from '../model/chart-type-registry';
import { drawPointFigure } from '../render/point-figure';
import { drawKagi } from '../render/kagi';

export const TRANSFORM_TIER = 'transform' as const;

// Register the Family-B custom renderers as a side effect of loading this tier.
// (Heikin Ashi / Renko / Range / Line Break render as a 'candlestick' series and
// need no new type.) Plotting P&F/Kagi requires their transform anyway, which
// lives here — so the renderer ships exactly when it is needed.
registerChartType('point-figure', {
  defaultStyle: {}, isPriceSeries: true,
  draw: (g, items, toY, bs, dpr, s) => drawPointFigure(g, items, toY, bs, dpr, s),
  extents: (bar) => ({ min: bar.low, max: bar.high }),
});
registerChartType('kagi', {
  defaultStyle: { thickColor: '#26a69a', thinColor: '#ef5350' }, isPriceSeries: true,
  draw: (g, items, toY, _bs, dpr, s) => drawKagi(g, items, toY, dpr, s),
  extents: (bar) => ({ min: bar.close, max: bar.close }),
});

export type { ISeriesTransform } from './transform';
export { runTransform, ensureIncreasingTimes } from './transform';
export { HeikinAshiTransform } from './heikin-ashi';
export { RenkoTransform, type RenkoOptions } from './renko';
export { RangeBarsTransform, type RangeOptions } from './range-bars';
export { LineBreakTransform, type LineBreakOptions } from './line-break';
export { PointFigureTransform, type PointFigureOptions } from './point-figure';
export { KagiTransform, type KagiOptions } from './kagi';
