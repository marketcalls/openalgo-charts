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
