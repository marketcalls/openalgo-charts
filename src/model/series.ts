/**
 * Series records (ARCHITECTURE.md §4.3). A series references its rows in the
 * shared DataLayer by id, names a registered chart type, and carries a style
 * bag. The chart-type registry (§6A) supplies the renderer + autoscale extents,
 * so the core never switches on type.
 */
import type { SeriesId } from './data-layer';
import type { SeriesType } from './chart-type-registry';
import { getChartType } from './chart-type-registry';
import type { SeriesStyle } from '../render/series-style';
import type { Bar } from './bar';
import type { SeriesMarkers } from '../primitives/markers';

export type { SeriesType };

export interface SeriesRecord {
  dataId: SeriesId;
  type: SeriesType;
  style: SeriesStyle;
}

/** Public handle returned by `chart.addSeries(...)`. */
export interface SeriesApi {
  setData(bars: readonly Bar[]): void;
  prependData(bars: readonly Bar[]): void;
  update(bar: Bar): void;
  /** Create a markers layer (buy/sell signals, shapes) bound to this series. */
  createMarkers(): SeriesMarkers;
}

export function createSeriesRecord(dataId: SeriesId, type: SeriesType, style?: SeriesStyle): SeriesRecord {
  const entry = getChartType(type);
  return { dataId, type, style: { ...entry.defaultStyle, ...style } };
}
