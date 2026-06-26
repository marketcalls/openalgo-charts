/**
 * Series records (ARCHITECTURE.md §4.3). A series references its rows in the
 * shared DataLayer by id and carries its render style. Phase 2 added
 * candlesticks; Phase 4 adds histogram (volume). The chart-type registry (§6A)
 * generalises this in Phase 5.
 */
import type { SeriesId } from './data-layer';
import type { CandleStyle } from '../render/candles';
import { DEFAULT_CANDLE_STYLE } from '../render/candles';
import type { HistogramStyle } from '../render/histogram';
import { DEFAULT_HISTOGRAM_STYLE } from '../render/histogram';
import type { Bar } from './bar';

export type SeriesType = 'candlestick' | 'histogram';

export type SeriesRecord =
  | { dataId: SeriesId; type: 'candlestick'; style: CandleStyle }
  | { dataId: SeriesId; type: 'histogram'; style: HistogramStyle };

/** Public handle returned by `chart.addSeries(...)`. */
export interface SeriesApi {
  /** Bulk-load (replace) this series' data. */
  setData(bars: readonly Bar[]): void;
  /** Merge older bars at the front (history paging); preserves the viewport. */
  prependData(bars: readonly Bar[]): void;
  /** Apply one live bar (mutate last / append / out-of-order upsert). */
  update(bar: Bar): void;
}

export function createCandlestickRecord(dataId: SeriesId, style?: Partial<CandleStyle>): SeriesRecord {
  return { dataId, type: 'candlestick', style: { ...DEFAULT_CANDLE_STYLE, ...style } };
}

export function createHistogramRecord(dataId: SeriesId, style?: Partial<HistogramStyle>): SeriesRecord {
  return { dataId, type: 'histogram', style: { ...DEFAULT_HISTOGRAM_STYLE, ...style } };
}
