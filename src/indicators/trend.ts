/**
 * Tier-1 trend indicators — computed from the chart's own OHLCV, no extra data.
 * Part of the lazy `openalgo-charts/indicators` tier.
 *
 * `ema`, `supertrend`, and the `sourceValues` helper come from the base bundle
 * (`../index`), not deep paths — see the note in `src/indicators/index.ts`.
 */
import {
  supertrend, atr, sourceValues,
  sessionStartFlags, calendarPeriodFlags, isNewZonedPeriod,
  utcSecondsToIstParts, IST_OFFSET_SECONDS,
  DEFAULT_TIMEZONE, isValidTimezone,
} from 'openalgo-charts';
import type { Bar, IndicatorDescriptor, IndicatorSource, IndicatorStudySource } from 'openalgo-charts';
import { sma, wma, stdev, highest, lowest, nulls, smaSeededEma } from './calc';
import type { NumericalWindowOptions } from './statistics';

const num = (s: Readonly<Record<string, unknown>>, k: string, d: number): number => {
  const v = s[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
};
const str = (s: Readonly<Record<string, unknown>>, k: string, d: string): string => {
  const v = s[k];
  return typeof v === 'string' && v !== '' ? v : d;
};
const src = (s: Readonly<Record<string, unknown>>, k = 'source'): IndicatorSource =>
  (s[k] as IndicatorSource) ?? 'close';

/**
 * The chart's configured zone, as it reaches an indicator.
 *
 * A `calc` is handed `(bars, settings, store)` and never the chart, so the zone
 * travels on the settings blob under the reserved `timezone` key. A blob without
 * one, which is every caller that predates the option, resolves to the shipped
 * default and computes exactly what 1.2.0 computed.
 *
 * An unrecognised name falls back rather than throwing: `chart.setTimezone`
 * already rejects a bad zone at the call site, and a `calc` that throws takes
 * the whole repaint down with it.
 */
const zoneOf = (s: Readonly<Record<string, unknown>>): string => {
  const v = s.timezone;
  if (typeof v !== 'string' || v === '' || v === DEFAULT_TIMEZONE) return DEFAULT_TIMEZONE;
  return isValidTimezone(v) ? v : DEFAULT_TIMEZONE;
};

/** A moving-average descriptor — the three MAs differ only in their kernel. */
function movingAverage(
  id: string,
  name: string,
  color: string,
  kernel: (values: readonly number[], period: number, options?: NumericalWindowOptions) => number[],
): IndicatorDescriptor {
  return {
    id,
    name,
    category: 'Trend',
    placement: 'onchart',
    inputs: [
      { key: 'length', type: 'number', label: 'Length', default: 9, min: 1, max: 1000, step: 1 },
      { key: 'source', type: 'source', label: 'Source', default: 'close', allowStudyOutputs: true },
      { key: 'color', type: 'color', label: 'Color', default: color },
    ],
    plots: [{ key: 'ma', type: 'line', title: name, colorKey: 'color', style: { color, lineWidth: 1.5 } }],
    calc: (bars, s, _store, context) => {
      const source = src(s) as IndicatorSource | IndicatorStudySource;
      const values = typeof source === 'string' ? sourceValues(bars, source)
        : sourceValues(bars, source, context).map(value => value ?? NaN);
      return { ma: nulls(kernel(values, num(s, 'length', 9),
        typeof source === 'string' ? undefined : { missing: 'propagate' })) };
    },
  };
}

export const SMA: IndicatorDescriptor = movingAverage('sma', 'SMA', '#4f8cff', sma);
export const WMA: IndicatorDescriptor = movingAverage('wma', 'WMA', '#ab47bc', wma);
// `smaSeededEma`, not the base bundle's `ema`: the plotted EMA has to open where
// the standard definition opens, on the simple mean of the first `length` values
// at index `length - 1`. The base `ema` seeds from bar 0 to match `openalgo.ta`
// and is public API in its own right, so it keeps that behaviour and this
// descriptor stops using it. Every other EMA in the tier already reads this way.
export const EMA: IndicatorDescriptor = movingAverage('ema', 'EMA', '#f5a623', smaSeededEma);

export const BOLLINGER: IndicatorDescriptor = {
  id: 'bollinger',
  name: 'Bollinger Bands',
  category: 'Volatility',
  placement: 'onchart',
  inputs: [
    { key: 'length', type: 'number', label: 'Length', default: 20, min: 2, max: 1000, step: 1 },
    { key: 'stdDev', type: 'number', label: 'StdDev', default: 2, min: 0.1, max: 10, step: 0.1 },
    { key: 'source', type: 'source', label: 'Source', default: 'close' },
    { key: 'basisColor', type: 'color', label: 'Basis', default: '#f5a623' },
    { key: 'bandColor', type: 'color', label: 'Bands', default: '#4f8cff' },
  ],
  plots: [
    { key: 'upper', type: 'line', title: 'BB Upper', colorKey: 'bandColor', style: { lineWidth: 1 } },
    { key: 'basis', type: 'line', title: 'BB Basis', colorKey: 'basisColor', style: { lineWidth: 1.5 } },
    { key: 'lower', type: 'line', title: 'BB Lower', colorKey: 'bandColor', style: { lineWidth: 1 } },
  ],
  calc: (bars, s) => {
    const values = sourceValues(bars, src(s));
    const length = num(s, 'length', 20);
    const mult = num(s, 'stdDev', 2);
    const basis = sma(values, length);
    const dev = stdev(values, length);
    const upper = basis.map((b, i) => b + mult * dev[i]);
    const lower = basis.map((b, i) => b - mult * dev[i]);
    return { upper: nulls(upper), basis: nulls(basis), lower: nulls(lower) };
  },
};

/**
 * Which calendar boundary restarts the accumulation. The reference also offers
 * Earnings, Dividends and Splits, which need a corporate-actions feed this
 * layer has no access to, so they are not offered rather than silently wrong.
 */
type VwapAnchor = 'session' | 'week' | 'month' | 'quarter' | 'year' | 'continuous';

/** The anchors that are a calendar period rather than a trading session. */
type CalendarAnchor = Exclude<VwapAnchor, 'session' | 'continuous'>;

/** Epoch day in IST. Cheap only because IST is a fixed offset; nothing else is. */
const istDay = (t: number): number => Math.floor((t + IST_OFFSET_SECONDS) / 86400);

/** Monday-based week index. Epoch day 4 is Monday 1970-01-05. */
const istWeek = (t: number): number => Math.floor((istDay(t) - 4) / 7);

function istPeriodBoundary(period: CalendarAnchor, prev: number, now: number): boolean {
  // Week first: a Monday-start week straddles the turn of the year, so the year
  // test below would report a boundary the week itself does not have.
  if (period === 'week') return istWeek(prev) !== istWeek(now);
  const a = utcSecondsToIstParts(prev);
  const b = utcSecondsToIstParts(now);
  if (a.year !== b.year) return true;
  if (period === 'year') return false;
  if (period === 'quarter') return Math.floor((a.month - 1) / 3) !== Math.floor((b.month - 1) / 3);
  return a.month !== b.month;
}

/**
 * The boundary test for one anchor period, on the calendar of `zone`.
 *
 * The default zone keeps the offset arithmetic. Intl is the right answer for an
 * arbitrary zone and the wrong price for the one zone that has no DST to get
 * wrong: measured over twelve thousand daily bars the sweep costs 38ms through
 * Intl against 3ms through `utcSecondsToIstParts`, and a week anchor runs one
 * test per bar. The two answers are pinned identical for Asia/Kolkata by
 * `tests/indicator-timezone.test.ts`, so the branch buys back the old speed for
 * every existing caller and changes nothing about what it returns. The
 * foundation's own `sessionStartFlags` splits on the same line for the same
 * reason.
 */
function periodBoundary(
  period: CalendarAnchor,
  zone: string,
): (prev: number, now: number) => boolean {
  return zone === DEFAULT_TIMEZONE
    ? (prev, now): boolean => istPeriodBoundary(period, prev, now)
    : (prev, now): boolean => isNewZonedPeriod(prev, now, period, zone);
}

/**
 * Per-bar flags for the first bar of each anchor period, on the calendar of
 * `zone`.
 *
 * The week, month, quarter and year tests used to be IST unconditionally, which
 * put a New York month boundary at 18:30 UTC on the last day and restarted the
 * accumulation ninety minutes before the month-end session closed. They follow
 * the chart now, and IST is one zone among them rather than the assumption.
 */
function anchorRestarts(bars: readonly Bar[], anchor: VwapAnchor, zone: string): boolean[] {
  if (anchor === 'continuous') return new Array<boolean>(bars.length).fill(false);
  const times = bars.map((b) => b.time);
  if (anchor === 'session') return sessionStartFlags(times, zone);
  return calendarPeriodFlags(times, periodBoundary(anchor, zone));
}

/** Shift a column forward by `by` bars, the way a plot offset would draw it. */
function shiftColumn(col: readonly number[], by: number): number[] {
  if (by === 0) return col.slice();
  const out = new Array<number>(col.length).fill(NaN);
  for (let i = 0; i < col.length; i++) {
    const to = i + by;
    if (to >= 0 && to < col.length) out[to] = col[i];
  }
  return out;
}

export const VWAP: IndicatorDescriptor = {
  id: 'vwap',
  name: 'VWAP',
  category: 'Volume',
  placement: 'onchart',
  inputs: [
    {
      key: 'anchor', type: 'select', label: 'Anchor Period', default: 'session',
      options: [
        { label: 'Session', value: 'session' },
        { label: 'Week', value: 'week' },
        { label: 'Month', value: 'month' },
        { label: 'Quarter', value: 'quarter' },
        { label: 'Year', value: 'year' },
        { label: 'Continuous', value: 'continuous' },
      ],
    },
    { key: 'source', type: 'source', label: 'Source', default: 'hlc3' },
    { key: 'offset', type: 'number', label: 'Offset', default: 0, min: -500, max: 500, step: 1 },
    {
      key: 'calcMode', type: 'select', label: 'Bands Calculation Mode', default: 'stdev',
      options: [
        { label: 'Standard Deviation', value: 'stdev' },
        { label: 'Percentage', value: 'percent' },
      ],
      group: 'Bands',
    },
    { key: 'showBand1', type: 'boolean', label: 'Band #1', default: true, group: 'Bands' },
    { key: 'bandMult1', type: 'number', label: 'Bands Multiplier #1', default: 1, min: 0, step: 0.5, group: 'Bands' },
    { key: 'showBand2', type: 'boolean', label: 'Band #2', default: false, group: 'Bands' },
    { key: 'bandMult2', type: 'number', label: 'Bands Multiplier #2', default: 2, min: 0, step: 0.5, group: 'Bands' },
    { key: 'showBand3', type: 'boolean', label: 'Band #3', default: false, group: 'Bands' },
    { key: 'bandMult3', type: 'number', label: 'Bands Multiplier #3', default: 3, min: 0, step: 0.5, group: 'Bands' },
    { key: 'color', type: 'color', label: 'VWAP', default: '#2962ff' },
    { key: 'band1Color', type: 'color', label: 'Band #1', default: '#4caf50', group: 'Bands' },
    { key: 'band2Color', type: 'color', label: 'Band #2', default: '#808000', group: 'Bands' },
    { key: 'band3Color', type: 'color', label: 'Band #3', default: '#00bcd4', group: 'Bands' },
  ],
  plots: [
    { key: 'vwap', type: 'line', title: 'VWAP', colorKey: 'color', style: { lineWidth: 1.5 } },
    { key: 'upper1', type: 'line', title: 'Upper Band #1', colorKey: 'band1Color', style: { lineWidth: 1 } },
    { key: 'lower1', type: 'line', title: 'Lower Band #1', colorKey: 'band1Color', style: { lineWidth: 1 } },
    { key: 'upper2', type: 'line', title: 'Upper Band #2', colorKey: 'band2Color', style: { lineWidth: 1 } },
    { key: 'lower2', type: 'line', title: 'Lower Band #2', colorKey: 'band2Color', style: { lineWidth: 1 } },
    { key: 'upper3', type: 'line', title: 'Upper Band #3', colorKey: 'band3Color', style: { lineWidth: 1 } },
    { key: 'lower3', type: 'line', title: 'Lower Band #3', colorKey: 'band3Color', style: { lineWidth: 1 } },
  ],
  // Each band pair shades between its own two edges. A hidden band's columns are
  // all null, so its fill resolves to nothing without needing a second switch.
  fills: [
    { between: ['upper1', 'lower1'], colorUpKey: 'band1Color', colorDownKey: 'band1Color', opacity: 0.05 },
    { between: ['upper2', 'lower2'], colorUpKey: 'band2Color', colorDownKey: 'band2Color', opacity: 0.05 },
    { between: ['upper3', 'lower3'], colorUpKey: 'band3Color', colorDownKey: 'band3Color', opacity: 0.05 },
  ],
  calc: (bars, s) => {
    const n = bars.length;
    const values = sourceValues(bars, src(s));
    const anchor = (typeof s.anchor === 'string' ? s.anchor : 'session') as VwapAnchor;
    const percentMode = s.calcMode === 'percent';
    const offset = Math.round(num(s, 'offset', 0));

    const vwap = new Array<number>(n).fill(NaN);
    // The band half-width in price terms, before the multiplier. Kept as its own
    // column so all three bands share one accumulation pass.
    const basis = new Array<number>(n).fill(NaN);

    // Where the accumulation restarts. A session anchor comes from the bar
    // gaps, not from a calendar: the reference's "session" is the exchange's
    // trading day, and a fixed midnight lands inside it for every exchange but
    // one, restarting VWAP partway through the afternoon. The coarser anchors
    // are calendar tests on the chart's own zone, and they are applied to
    // session opens for the same reason: a New York Friday runs into Saturday
    // on a clock five and a half hours ahead of it.
    const restarts = anchorRestarts(bars, anchor, zoneOf(s));

    let pv = 0;
    let vol = 0;
    let pv2 = 0;
    for (let i = 0; i < n; i++) {
      if (restarts[i]) { pv = 0; vol = 0; pv2 = 0; }
      const v = bars[i].volume ?? 0;
      const x = values[i];
      // A missing price or an unusable volume leaves this bar absent and the
      // totals as they were. Adding it in would blank the line and every band
      // until the next restart, which on the continuous anchor is never. An
      // undefined volume is still a bar that traded nothing.
      if (!Number.isFinite(x) || !Number.isFinite(v)) continue;
      pv += x * v;
      pv2 += x * x * v;
      vol += v;
      if (vol <= 0) continue;
      const mean = pv / vol;
      vwap[i] = mean;
      // Volume-weighted variance. Clamped at zero because accumulated rounding
      // can drive an all-but-flat window a hair negative.
      const variance = Math.max(0, pv2 / vol - mean * mean);
      basis[i] = percentMode ? mean * 0.01 : Math.sqrt(variance);
    }

    const band = (show: boolean, mult: number, sign: number): number[] => {
      const out = new Array<number>(n).fill(NaN);
      if (!show) return out;
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(vwap[i]) && Number.isFinite(basis[i])) {
          out[i] = vwap[i] + sign * basis[i] * mult;
        }
      }
      return out;
    };
    const b1 = s.showBand1 !== false;
    const b2 = s.showBand2 === true;
    const b3 = s.showBand3 === true;
    const m1 = num(s, 'bandMult1', 1);
    const m2 = num(s, 'bandMult2', 2);
    const m3 = num(s, 'bandMult3', 3);

    return {
      vwap: nulls(shiftColumn(vwap, offset)),
      upper1: nulls(shiftColumn(band(b1, m1, 1), offset)),
      lower1: nulls(shiftColumn(band(b1, m1, -1), offset)),
      upper2: nulls(shiftColumn(band(b2, m2, 1), offset)),
      lower2: nulls(shiftColumn(band(b2, m2, -1), offset)),
      upper3: nulls(shiftColumn(band(b3, m3, 1), offset)),
      lower3: nulls(shiftColumn(band(b3, m3, -1), offset)),
    };
  },
};

export const SUPERTREND: IndicatorDescriptor = {
  id: 'supertrend',
  name: 'Supertrend',
  category: 'Trend',
  placement: 'onchart',
  inputs: [
    { key: 'period', type: 'number', label: 'ATR Period', default: 10, min: 1, max: 200, step: 1 },
    { key: 'multiplier', type: 'number', label: 'Multiplier', default: 3, min: 0.1, max: 20, step: 0.1 },
    { key: 'upColor', type: 'color', label: 'Uptrend', default: '#26a69a' },
    { key: 'downColor', type: 'color', label: 'Downtrend', default: '#ef5350' },
  ],
  // Two plots so the band changes color at a flip: each carries null while the
  // other is active, and the line renderer breaks across the gap.
  plots: [
    { key: 'up', type: 'line', title: 'Supertrend Up', colorKey: 'upColor', style: { lineWidth: 2 } },
    { key: 'down', type: 'line', title: 'Supertrend Down', colorKey: 'downColor', style: { lineWidth: 2 } },
  ],
  /**
   * The reference shades the gap between the stop and the candle bodies, using a
   * hidden body-middle plot as the far edge. `bodyMid` is that edge: a value
   * column with no plot of its own, so the band has something to fill against
   * without drawing a second line through the candles.
   *
   * Only one side is live at a time, so the inactive side's fill resolves to
   * nothing and the shading recolours at the flip along with the stop.
   */
  fills: [
    { between: ['bodyMid', 'up'], colorUpKey: 'upColor', colorDownKey: 'upColor', opacity: 0.1 },
    { between: ['bodyMid', 'down'], colorUpKey: 'downColor', colorDownKey: 'downColor', opacity: 0.1 },
  ],
  calc: (bars, s) => {
    const st = supertrend(bars, num(s, 'period', 10), num(s, 'multiplier', 3));
    const up: (number | null)[] = [];
    const down: (number | null)[] = [];
    const bodyMid: (number | null)[] = [];
    for (let i = 0; i < st.length; i++) {
      const p = st[i];
      const live = Number.isFinite(p.value);
      up.push(live && p.direction === -1 ? p.value : null);
      down.push(live && p.direction === 1 ? p.value : null);
      // Null wherever the stop is, so the shaded region starts where the line
      // does rather than running back through the warmup.
      const bar = bars[i];
      bodyMid.push(live && bar !== undefined ? (bar.open + bar.close) / 2 : null);
    }
    return { up, down, bodyMid };
  },
};

export const PARABOLIC_SAR: IndicatorDescriptor = {
  id: 'parabolic-sar',
  name: 'Parabolic SAR',
  category: 'Trend',
  placement: 'onchart',
  inputs: [
    { key: 'start', type: 'number', label: 'Start', default: 0.02, min: 0.001, max: 1, step: 0.001 },
    { key: 'increment', type: 'number', label: 'Increment', default: 0.02, min: 0.001, max: 1, step: 0.001 },
    { key: 'maximum', type: 'number', label: 'Maximum', default: 0.2, min: 0.01, max: 1, step: 0.01 },
    { key: 'color', type: 'color', label: 'Color', default: '#e0b020' },
  ],
  plots: [{
    key: 'sar', type: 'line', title: 'SAR', colorKey: 'color',
    style: { markersOnly: true, markerRadius: 1.5 },
  }],
  calc: (bars, s) => {
    const n = bars.length;
    const out = new Array<number>(n).fill(NaN);
    const step = num(s, 'start', 0.02);
    const inc = num(s, 'increment', 0.02);
    const max = num(s, 'maximum', 0.2);

    // Only complete bars take part. A bar missing its high, low or close is a
    // gap that leaves the stop, trend and acceleration as they were: it cannot
    // seed, and the clamp reads the two complete bars before this one, so one
    // hole cannot turn the stop NaN for the rest of the history.
    let prev: Bar | undefined;
    let prev2: Bar | undefined;
    let rising = false;
    let sar = NaN;
    let ep = NaN;
    let af = step;

    for (let i = 0; i < n; i++) {
      const bar = bars[i];
      if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)) continue;
      if (prev === undefined) { prev = bar; continue; }
      if (prev2 === undefined) {
        rising = bar.close >= prev.close;
        sar = rising ? prev.low : prev.high;
        ep = rising ? bar.high : bar.low;
        // The seed bar carries the seed itself. Accelerating and testing for a
        // reversal on it uses an extreme point taken from that same bar, which can
        // flip the trend before a single step has been walked.
        out[i] = sar;
        prev2 = prev;
        prev = bar;
        continue;
      }

      sar += af * (ep - sar);

      // The reversal is decided on the propagated stop, before the clamp below:
      // a stop pulled back inside the prior two bars can no longer be breached,
      // so clamping first swallows flips the definition does fire. On a reversal
      // the stop is the ending trend's extreme, and that extreme includes this
      // bar: a stop left inside the bar that triggered it is already breached
      // the moment it is plotted.
      if (rising && bar.low < sar) {
        rising = false; sar = Math.max(ep, bar.high); ep = bar.low; af = step;
      } else if (!rising && bar.high > sar) {
        rising = true; sar = Math.min(ep, bar.low); ep = bar.high; af = step;
      } else if (rising && bar.high > ep) {
        ep = bar.high; af = Math.min(max, af + inc);
      } else if (!rising && bar.low < ep) {
        ep = bar.low; af = Math.min(max, af + inc);
      }

      // SAR may not penetrate the prior two bars' range, on whichever side the
      // trend now runs. Applied last so a reversal stop is contained too.
      if (rising) sar = Math.min(sar, prev.low, prev2.low);
      else sar = Math.max(sar, prev.high, prev2.high);

      out[i] = sar;
      prev2 = prev;
      prev = bar;
    }
    return { sar: nulls(out) };
  },
};

/** Shift a series by `k` bars: positive = forward (later), negative = backward. */
function shift(values: readonly number[], k: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const j = i - k;
    if (j >= 0 && j < n) out[i] = values[j];
  }
  return out;
}

export const ICHIMOKU: IndicatorDescriptor = {
  id: 'ichimoku',
  name: 'Ichimoku Cloud',
  category: 'Trend',
  placement: 'onchart',
  inputs: [
    { key: 'conversionPeriod', type: 'number', label: 'Conversion', default: 9, min: 1, max: 200, step: 1 },
    { key: 'basePeriod', type: 'number', label: 'Base', default: 26, min: 1, max: 200, step: 1 },
    { key: 'laggingSpanPeriod', type: 'number', label: 'Lagging Span', default: 52, min: 1, max: 400, step: 1 },
    { key: 'displacement', type: 'number', label: 'Displacement', default: 26, min: 0, max: 200, step: 1 },
    { key: 'conversionColor', type: 'color', label: 'Conversion', default: '#4f8cff' },
    { key: 'baseColor', type: 'color', label: 'Base', default: '#ef5350' },
    { key: 'spanAColor', type: 'color', label: 'Span A', default: '#26a69a' },
    { key: 'spanBColor', type: 'color', label: 'Span B', default: '#ab47bc' },
    { key: 'laggingColor', type: 'color', label: 'Lagging', default: '#8892a6' },
    { key: 'cloudUpColor', type: 'color', label: 'Cloud up', default: '#26a69a' },
    { key: 'cloudDownColor', type: 'color', label: 'Cloud down', default: '#ef5350' },
  ],
  plots: [
    { key: 'conversion', type: 'line', title: 'Tenkan-sen', colorKey: 'conversionColor', style: { lineWidth: 1 } },
    { key: 'base', type: 'line', title: 'Kijun-sen', colorKey: 'baseColor', style: { lineWidth: 1 } },
    { key: 'spanA', type: 'line', title: 'Senkou Span A', colorKey: 'spanAColor', style: { lineWidth: 1 } },
    { key: 'spanB', type: 'line', title: 'Senkou Span B', colorKey: 'spanBColor', style: { lineWidth: 1 } },
    { key: 'lagging', type: 'line', title: 'Chikou Span', colorKey: 'laggingColor', style: { lineWidth: 1 } },
  ],
  // The Kumo. Two lines are not the same picture as a filled cloud: the shading
  // is what makes "price is above the cloud" and "the cloud flipped" readable,
  // and which span leads is itself the signal, hence the two colours.
  fills: [{
    between: ['spanA', 'spanB'],
    colorUpKey: 'cloudUpColor',
    colorDownKey: 'cloudDownColor',
    opacity: 0.14,
  }],
  calc: (bars, s) => {
    const n = bars.length;
    const conv = num(s, 'conversionPeriod', 9);
    const base = num(s, 'basePeriod', 26);
    const lag = num(s, 'laggingSpanPeriod', 52);
    const disp = num(s, 'displacement', 26);

    // Donchian midpoint over `p` bars.
    const mid = (p: number): number[] => {
      const out = new Array<number>(n).fill(NaN);
      for (let i = p - 1; i < n; i++) {
        let hi = -Infinity;
        let lo = Infinity;
        for (let k = 0; k < p; k++) {
          if (bars[i - k].high > hi) hi = bars[i - k].high;
          if (bars[i - k].low < lo) lo = bars[i - k].low;
        }
        out[i] = (hi + lo) / 2;
      }
      return out;
    };

    const conversion = mid(conv);
    const baseLine = mid(base);
    const spanA = conversion.map((c, i) => (c + baseLine[i]) / 2);
    const spanB = mid(lag);
    const closes = bars.map((b) => b.close);
    return {
      conversion: nulls(conversion),
      base: nulls(baseLine),
      spanA: nulls(shift(spanA, disp)),
      spanB: nulls(shift(spanB, disp)),
      lagging: nulls(shift(closes, -disp)),
    };
  },
};

/**
 * HalfTrend — a trend-following level that only moves against the trend once
 * the opposing side of the range genuinely gives way, so it holds flat through
 * noise where a moving average would wobble.
 *
 * Two state machines run at once. `trend` is what is drawn; `nextTrend` is which
 * flip is currently *armed*. While a down-flip is armed the indicator tracks the
 * running maximum of the `amplitude`-bar low; the flip only fires when the mean
 * high drops under that maximum **and** the bar closes below the previous bar's
 * low. The up-flip is the mirror. Requiring both a mean crossing and a close
 * beyond the prior bar's extreme is what keeps the level still.
 *
 * On a flip the new level starts from the level the other side ended on, which
 * is why the line steps rather than jumping to price. `channelDeviation` half-ATR
 * bands ride the level as a channel, and the flip bar is marked half an ATR
 * inside the channel.
 *
 * Original implementation written from the algorithm's published behaviour, per
 * ARCHITECTURE.md §0.1 — not ported from any third-party source.
 */
export const HALFTREND: IndicatorDescriptor = {
  id: 'halftrend',
  name: 'HalfTrend',
  category: 'Trend',
  placement: 'onchart',
  inputs: [
    { key: 'amplitude', type: 'number', label: 'Amplitude', default: 2, min: 1, max: 100, step: 1 },
    { key: 'channelDeviation', type: 'number', label: 'Channel Deviation', default: 2, min: 0, max: 20, step: 0.1 },
    { key: 'atrPeriod', type: 'number', label: 'ATR Period', default: 100, min: 1, max: 500, step: 1 },
    { key: 'showChannels', type: 'boolean', label: 'Show Channels', default: true },
    { key: 'showSignals', type: 'boolean', label: 'Show Signals', default: true },
    { key: 'showLabels', type: 'boolean', label: 'Show Buy/Sell Labels', default: true },
    { key: 'upColor', type: 'color', label: 'Uptrend', default: '#2962ff' },
    { key: 'downColor', type: 'color', label: 'Downtrend', default: '#ef5350' },
  ],
  // The level is split across two plots so it recolours at a flip, exactly as
  // Supertrend does: each carries null while the other is active and the line
  // renderer breaks across the gap.
  plots: [
    { key: 'up', type: 'line', title: 'HalfTrend Up', colorKey: 'upColor', style: { lineWidth: 2 } },
    { key: 'down', type: 'line', title: 'HalfTrend Down', colorKey: 'downColor', style: { lineWidth: 2 } },
    {
      key: 'atrHigh', type: 'line', title: 'Channel High', colorKey: 'downColor',
      style: { markersOnly: true, markerRadius: 1 },
    },
    {
      key: 'atrLow', type: 'line', title: 'Channel Low', colorKey: 'upColor',
      style: { markersOnly: true, markerRadius: 1 },
    },
    {
      key: 'buySignal', type: 'line', title: 'Buy', colorKey: 'upColor',
      style: { markersOnly: true, markerRadius: 3.5 },
    },
    {
      key: 'sellSignal', type: 'line', title: 'Sell', colorKey: 'downColor',
      style: { markersOnly: true, markerRadius: 3.5 },
    },
  ],
  // One ribbon per side. Both endpoints must be non-null for a fill to appear,
  // and only the active side's level is non-null, so the tint follows the trend
  // without any per-bar colour logic.
  fills: [
    { between: ['up', 'atrLow'], colorUpKey: 'upColor', colorDownKey: 'upColor', opacity: 0.15 },
    { between: ['down', 'atrHigh'], colorUpKey: 'downColor', colorDownKey: 'downColor', opacity: 0.15 },
  ],
  // The flip is an event with a name, not a column of prices, so it is a
  // marker rather than a plot. The plate hangs off the channel edge it belongs
  // to, tail pointing at it, which is why buy is a labelUp and sell a labelDown.
  markers: ({ bars, values, settings }) => {
    if (settings.showLabels === false) return [];
    const buy = values.buySignal ?? [];
    const sell = values.sellSignal ?? [];
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      const b = buy[i];
      if (b !== null && b !== undefined) {
        out.push({
          time: bars[i].time, position: 'atPrice' as const, price: b,
          shape: 'labelUp' as const, size: 'small' as const,
          color: str(settings, 'upColor', '#2962ff'), text: 'Buy',
        });
        continue;
      }
      const sg = sell[i];
      if (sg !== null && sg !== undefined) {
        out.push({
          time: bars[i].time, position: 'atPrice' as const, price: sg,
          shape: 'labelDown' as const, size: 'small' as const,
          color: str(settings, 'downColor', '#ef5350'), text: 'Sell',
        });
      }
    }
    return out;
  },
  calc: (bars, s) => {
    const n = bars.length;
    const up: (number | null)[] = new Array(n).fill(null);
    const down: (number | null)[] = new Array(n).fill(null);
    const chHigh: (number | null)[] = new Array(n).fill(null);
    const chLow: (number | null)[] = new Array(n).fill(null);
    const buy: (number | null)[] = new Array(n).fill(null);
    const sell: (number | null)[] = new Array(n).fill(null);
    const out = { up, down, atrHigh: chHigh, atrLow: chLow, buySignal: buy, sellSignal: sell };
    if (n === 0) return out;

    const amp = Math.max(1, Math.round(num(s, 'amplitude', 2)));
    const chDev = num(s, 'channelDeviation', 2);
    const showChannels = s.showChannels !== false;
    const showSignals = s.showSignals !== false;

    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const halfAtr = atr(highs, lows, bars.map((b) => b.close), Math.max(1, Math.round(num(s, 'atrPeriod', 100))));
    const meanHigh = sma(highs, amp);
    const meanLow = sma(lows, amp);
    const rollHigh = highest(highs, amp);
    const rollLow = lowest(lows, amp);

    // 0 = uptrend, 1 = downtrend. `armed` is the flip currently being tracked.
    let trend = 0;
    let armed = 0;
    let maxLow = lows[0];
    let minHigh = highs[0];
    let upLevel = 0;
    let downLevel = 0;
    let seeded = false;

    for (let i = 0; i < n; i++) {
      const half = halfAtr[i] / 2;
      const dev = chDev * half;
      const barHigh = rollHigh[i];
      const barLow = rollLow[i];
      // Bar 0 has no predecessor; comparing against itself can never satisfy the
      // flip condition, which is the correct no-signal answer for a single bar.
      const prevHigh = i > 0 ? highs[i - 1] : highs[0];
      const prevLow = i > 0 ? lows[i - 1] : lows[0];
      const wasTrend = seeded ? trend : -1;

      if (armed === 1) {
        if (Number.isFinite(barLow)) maxLow = Math.max(barLow, maxLow);
        if (Number.isFinite(meanHigh[i]) && meanHigh[i] < maxLow && bars[i].close < prevLow) {
          trend = 1;
          armed = 0;
          minHigh = barHigh;
        }
      } else {
        if (Number.isFinite(barHigh)) minHigh = Math.min(barHigh, minHigh);
        if (Number.isFinite(meanLow[i]) && meanLow[i] > minHigh && bars[i].close > prevHigh) {
          trend = 0;
          armed = 1;
          maxLow = barLow;
        }
      }

      let level: number;
      if (trend === 0) {
        if (wasTrend === 1) {
          upLevel = downLevel; // step across from where the other side ended
          if (showSignals && Number.isFinite(half)) buy[i] = upLevel - half;
        } else {
          upLevel = wasTrend === -1 ? maxLow : Math.max(maxLow, upLevel);
        }
        level = upLevel;
      } else {
        if (wasTrend === 0) {
          downLevel = upLevel;
          if (showSignals && Number.isFinite(half)) sell[i] = downLevel + half;
        } else {
          downLevel = wasTrend === -1 ? minHigh : Math.min(minHigh, downLevel);
        }
        level = downLevel;
      }
      seeded = true;

      if (!Number.isFinite(level)) continue;
      if (trend === 0) up[i] = level;
      else down[i] = level;
      // The level needs no ATR, so it starts well before the channel does.
      if (showChannels && Number.isFinite(dev)) {
        chHigh[i] = level + dev;
        chLow[i] = level - dev;
      }
    }
    return out;
  },
};
