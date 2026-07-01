/**
 * Internal time is always **UTC seconds** (integer). Feed adapters convert
 * broker formats (IST strings, epoch ms) to this at the edge; see ARCHITECTURE.md §4.0.
 */
export type UTCSeconds = number;

/** The original, caller-supplied time value, echoed back untouched in callbacks. */
export type OriginalTime = number | string;

/** A single OHLC(V) bar. `volume` is optional (not all feeds carry it). */
export interface Bar {
  time: UTCSeconds;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** A single value point (for line/area/baseline series). */
export interface LinePoint {
  time: UTCSeconds;
  value: number;
}

/** A whitespace point: occupies a logical index for alignment but draws nothing. */
export interface Whitespace {
  time: UTCSeconds;
}

export function isWhitespace(p: Bar | LinePoint | Whitespace): p is Whitespace {
  return !('open' in p) && !('value' in p);
}

/** Any item a series accepts: an OHLC bar, a value point, or a whitespace gap. */
export type SeriesDataItem = Bar | LinePoint | Whitespace;

/**
 * Normalize any series data item into an internal OHLC bar:
 * - a `Bar` passes through untouched;
 * - a `LinePoint` `{ time, value }` becomes a flat OHLC bar (open=high=low=close=value);
 * - a `Whitespace` `{ time }` becomes a NaN bar, which the line renderer draws as a
 *   gap and autoscale skips.
 */
export function toBar(item: SeriesDataItem): Bar {
  if ('open' in item) return item;
  if ('value' in item) {
    const v = item.value;
    return { time: item.time, open: v, high: v, low: v, close: v };
  }
  return { time: item.time, open: NaN, high: NaN, low: NaN, close: NaN };
}
