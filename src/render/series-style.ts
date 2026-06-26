/**
 * Unified style bag for all Family-A series types (ARCHITECTURE.md §6A). Each
 * renderer reads the fields it needs; per-type defaults are filled by the
 * chart-type registry. Keeping one optional-field interface avoids a sprawling
 * discriminated union at the rendering boundary.
 */
export interface SeriesStyle {
  // candle / bar family
  upColor?: string;
  downColor?: string;
  borderUpColor?: string;
  borderDownColor?: string;
  wickUpColor?: string;
  wickDownColor?: string;
  borderVisible?: boolean;
  wickVisible?: boolean;
  hollow?: boolean;
  /** Scale candle body width by volume / maxVisibleVolume (volume candles). */
  volumeScaled?: boolean;

  // line / area / baseline / hlc-area family
  color?: string;
  lineWidth?: number;
  step?: boolean;
  markers?: boolean;
  markerRadius?: number;
  areaTopColor?: string;
  areaBottomColor?: string;
  baseValue?: number;
  topColor?: string;
  bottomColor?: string;
  highColor?: string;
  lowColor?: string;
  closeColor?: string;

  // histogram / column family
  base?: number;
}
