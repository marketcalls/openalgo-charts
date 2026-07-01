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
import type { Bar, SeriesDataItem } from './bar';
import type { SeriesMarkers } from '../primitives/markers';

export type { SeriesType };

export interface SeriesRecord {
  dataId: SeriesId;
  type: SeriesType;
  style: SeriesStyle;
}

/** Public handle returned by `chart.addSeries(...)`. */
export interface SeriesApi {
  /** Replace all data. Accepts OHLC bars, `{ time, value }` points, or `{ time }` gaps. */
  setData(bars: readonly SeriesDataItem[]): void;
  /** Merge older data (history paging); same item shapes as `setData`. */
  prependData(bars: readonly SeriesDataItem[]): void;
  /** Live update: update the last item or append. Same item shapes as `setData`. */
  update(bar: SeriesDataItem): void;
  /** Current bars for this series (sorted old -> new, normalized to OHLC). Handy for computing the next live update. */
  getData(): Bar[];
  /** Merge a partial style into the series and repaint (recolor, `{ visible:false }` to hide, ...). */
  applyOptions(style: Partial<SeriesStyle>): void;
  /** Remove the series from its pane and free its data rows. */
  remove(): void;
  /** Create a markers layer (buy/sell signals, shapes) bound to this series. */
  createMarkers(): SeriesMarkers;
}

export function createSeriesRecord(dataId: SeriesId, type: SeriesType, style?: SeriesStyle): SeriesRecord {
  const entry = getChartType(type);
  return { dataId, type, style: { ...entry.defaultStyle, ...style } };
}
