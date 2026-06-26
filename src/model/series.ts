/**
 * Series records (ARCHITECTURE.md §4.3). A series references its rows in the
 * shared DataLayer by id and carries its render style. Phase 2 ships
 * candlesticks; the chart-type registry (§6A) generalises this in Phase 5.
 */
import type { SeriesId } from './data-layer';
import type { CandleStyle } from '../render/candles';
import { DEFAULT_CANDLE_STYLE } from '../render/candles';
import type { Bar } from './bar';

export type SeriesType = 'candlestick';

export interface SeriesRecord {
  dataId: SeriesId;
  type: SeriesType;
  style: CandleStyle;
}

/** Public handle returned by `chart.addSeries(...)`. */
export interface SeriesApi {
  /** Bulk-load (replace) this series' data. */
  setData(bars: readonly Bar[]): void;
  /** Merge older bars at the front (history paging); preserves the viewport. */
  prependData(bars: readonly Bar[]): void;
}

export function createCandlestickRecord(dataId: SeriesId, style?: Partial<CandleStyle>): SeriesRecord {
  return {
    dataId,
    type: 'candlestick',
    style: { ...DEFAULT_CANDLE_STYLE, ...style },
  };
}
