import { normalizeDataVariant, type DataVariant } from 'openalgo-charts';

/**
 * The part of a chart's data variant that a request for another instrument
 * inherits: the session and the adjustment, which say how bars are observed,
 * so a benchmark or a comparison lines up with the chart bar for bar. The
 * currency and the unit belong to the instrument that was asked for, so they
 * stay behind. Undefined when nothing is inherited. Throws a TypeError for a
 * malformed variant, like `normalizeDataVariant`.
 */
export function inheritedDataVariant(variant?: DataVariant): Readonly<DataVariant> | undefined {
  const v = normalizeDataVariant(variant);
  return normalizeDataVariant(v && { session: v.session, adjustment: v.adjustment });
}
