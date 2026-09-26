import type { Chart } from '../core/chart';
import { tryResolveInterval } from './intervals';
import { isValidTimezone, parseSessionSpec, utcSecondsToZonedParts, zonedWallClockToUtcSeconds, type SessionSpec } from './time';
import { TickSchedule, type TickBand } from './tick-schedule';

export interface InstrumentCalendar {
  /** HHMM-HHMM[:days], with opening weekdays 1 (Sunday) through 7. */
  readonly sessions: readonly string[];
  /** Local opening dates replace weekly sessions. An empty list closes that date. */
  readonly exceptions?: Readonly<Record<string, readonly string[]>>;
}

/** Host-supplied market rules, separate from observations and saved user preferences. */
export interface InstrumentMetadata {
  readonly symbol: string;
  readonly exchange: string;
  readonly timezone: string;
  /** The minimum move: with `tickBands`, the schedule's common grid. */
  readonly priceTick: number;
  readonly pricePrecision: number;
  /**
   * Price-dependent ticks, supplied by the host from its venue's rules. Absent
   * means one tick at every price, which is `priceTick`.
   */
  readonly tickBands?: readonly TickBand[];
  /** In the order adapter's units. This is a grid, never a lot conversion factor. */
  readonly quantityStep: number;
  readonly intervals: readonly string[];
  readonly calendar: InstrumentCalendar;
  readonly hasOpenInterest?: boolean;
}

export interface InstrumentSession {
  /** Local opening date, including for an overnight window. */
  readonly date: string;
  /** UTC seconds, inclusive. */
  readonly open: number;
  /** UTC seconds, exclusive. */
  readonly close: number;
}

function fail(message: string): never { throw new Error(`Invalid instrument: ${message}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('expected a plain object');
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !('value' in item))) return fail('accessors are not metadata');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || Array.from(value).some(char => char.charCodeAt(0) < 32)) return fail(label);
  return value;
}
function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fail(label);
  return value;
}
function strings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit) return fail('invalid list');
  return value.map(item => text(item, 'invalid list item'));
}
function sessions(value: unknown): readonly string[] {
  const result = strings(value, 16);
  if (result.some(item => !parseSessionSpec(item))) return fail('invalid session');
  return Object.freeze(result);
}
function dateString(date: Date): string { return date.toISOString().slice(0, 10); }
function date(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail('invalid exception date');
  const result = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(result.getTime()) || dateString(result) !== value) return fail('invalid exception date');
  return result;
}
function metadata(input: unknown): InstrumentMetadata {
  const raw = record(input), calendar = record(raw.calendar);
  const timezone = text(raw.timezone, 'timezone');
  if (!isValidTimezone(timezone)) return fail('unknown timezone');
  const priceTick = positive(raw.priceTick, 'price tick');
  const precision = raw.pricePrecision;
  if (typeof precision !== 'number' || !Number.isInteger(precision) || precision < 0 || precision > 12) return fail('price precision must be 0..12');
  const units = priceTick * 10 ** precision;
  if (!Number.isFinite(units) || units < 1 || Math.abs(units - Math.round(units)) > 8 * Number.EPSILON * Math.max(1, units)) {
    return fail('price precision cannot represent the tick');
  }
  const intervals = strings(raw.intervals, 128);
  if (!intervals.length || new Set(intervals).size !== intervals.length) return fail('intervals must be nonempty and unique');
  for (const code of intervals) {
    const rule = tryResolveInterval(code)?.bucketing;
    if (!rule || (rule.mode === 'interval' && (!Number.isFinite(rule.seconds) || rule.seconds <= 0))) return fail(`unsupported interval ${code}`);
  }
  const exceptions: Record<string, readonly string[]> = {};
  if (calendar.exceptions !== undefined) {
    const values = record(calendar.exceptions);
    if (Object.keys(values).length > 3660) return fail('too many session exceptions');
    for (const [key, value] of Object.entries(values)) { date(key); exceptions[key] = sessions(value); }
  }
  if (raw.hasOpenInterest !== undefined && typeof raw.hasOpenInterest !== 'boolean') return fail('invalid OI capability');
  const bands = raw.tickBands === undefined ? undefined : new TickSchedule(raw.tickBands as readonly TickBand[]);
  // One number for the axis and the old tickSize readers, so it has to be the
  // grid every band lies on; a coarser one would move valid prices.
  if (bands && bands.minMove !== priceTick) return fail(`price tick ${priceTick} must equal the schedule's minimum move ${bands.minMove}`);
  return Object.freeze({
    symbol: text(raw.symbol, 'symbol'), exchange: text(raw.exchange, 'exchange'), timezone,
    priceTick, pricePrecision: precision, quantityStep: positive(raw.quantityStep, 'quantity step'),
    intervals: Object.freeze(intervals),
    calendar: Object.freeze({ sessions: sessions(calendar.sessions), exceptions: Object.freeze(exceptions) }),
    ...(raw.hasOpenInterest === undefined ? {} : { hasOpenInterest: raw.hasOpenInterest }),
    ...(bands ? { tickBands: bands.bands } : {}),
  });
}

function boundary(day: Date, minute: number, timezone: string): number {
  const civil = new Date(day.getTime() + minute * 60000);
  const year = civil.getUTCFullYear(), month = civil.getUTCMonth() + 1, d = civil.getUTCDate();
  const hour = civil.getUTCHours(), min = civil.getUTCMinutes();
  const answer = zonedWallClockToUtcSeconds(year, month, d, hour, min, 0, timezone);
  const actual = utcSecondsToZonedParts(answer, timezone);
  if (actual.year !== year || actual.month !== month || actual.day !== d || actual.hour !== hour || actual.minute !== min) {
    return fail('session boundary is absent in this timezone');
  }
  return answer;
}

/** Validated, detached rules. Construction does not change global intervals or chart defaults. */
export class Instrument {
  public readonly metadata: InstrumentMetadata;
  /**
   * The validated `tickBands`, or null for a constant tick. A constant tick
   * has no schedule, so it keeps a single snapping rule, `priceTick`, on every
   * path: the order constraints, chart drags and anything the host builds.
   */
  public readonly tickSchedule: TickSchedule | null;
  private readonly _sessions: readonly SessionSpec[];
  private readonly _exceptions: ReadonlyMap<string, readonly SessionSpec[]>;

  public constructor(input: unknown) {
    this.metadata = metadata(input);
    this.tickSchedule = this.metadata.tickBands ? new TickSchedule(this.metadata.tickBands) : null;
    this._sessions = this.metadata.calendar.sessions.map(item => parseSessionSpec(item)!);
    this._exceptions = new Map(Object.entries(this.metadata.calendar.exceptions ?? {})
      .map(([key, value]) => [key, value.map(item => parseSessionSpec(item)!)]));
  }

  /** Provider tokens are exact: a feed may distinguish monthly M from minute m. */
  public supportsInterval(code: string): boolean { return this.metadata.intervals.includes(code); }

  /** Formats display only. The source bars retain their unrounded values. */
  public formatPrice(value: number): string { return Number.isFinite(value) ? value.toFixed(this.metadata.pricePrecision) : ''; }

  /** Resolve an active window. Closed dates and breaks return null, never inferred hours. */
  public sessionAt(utcSeconds: number): InstrumentSession | null {
    if (!Number.isFinite(utcSeconds) || !Number.isFinite(new Date(utcSeconds * 1000).getTime())) return fail('invalid timestamp');
    const p = utcSecondsToZonedParts(utcSeconds, this.metadata.timezone);
    let found: InstrumentSession | null = null;
    for (const offset of [0, -1]) {
      const day = new Date(Date.UTC(p.year, p.month - 1, p.day + offset)), key = dateString(day);
      for (const spec of this._exceptions.get(key) ?? this._sessions) {
        if (spec.days && !spec.days.includes(day.getUTCDay() + 1)) continue;
        // UTC comparisons below survive a repeated DST hour; wall minutes do not.
        if (offset === -1 && spec.end > spec.start) continue;
        const open = boundary(day, spec.start, this.metadata.timezone);
        const close = boundary(day, spec.end + (spec.end <= spec.start ? 1440 : 0), this.metadata.timezone);
        if (utcSeconds < open || utcSeconds >= close) continue;
        if (found) return fail('overlapping active sessions');
        found = { date: key, open, close };
      }
    }
    return found;
  }

  /** The host clears old bars and owns source loading; only metadata is applied here. */
  public applyTo(chart: Chart, interval: string): void {
    if (!this.supportsInterval(interval)) return fail(`unsupported interval ${interval}`);
    if (chart.isDestroyed) return fail('chart is destroyed');
    const series = chart.primarySeries();
    if (!series) return fail('chart needs a primary series');
    const previous = chart.getDataContext(), m = this.metadata;
    if (previous && (previous.symbol !== m.symbol || previous.exchange !== m.exchange || previous.interval !== interval)
      && chart.primaryBars().length) return fail('clear previous source bars before applying metadata');
    chart.setTimezone(m.timezone);
    // The scale holds one tick, so a schedule gives it the common grid: the
    // axis then prints every band and its own snap never moves a valid price.
    chart.setPriceScaleOptions({ minMove: m.priceTick });
    // Oscillators and volume use their own units, even when their panes already exist.
    // The primary series can use a left or hidden scale instead of the chart default.
    series.priceScale().setOptions({ minMove: m.priceTick });
    series.priceScale().setPriceFormatter(value => this.formatPrice(value));
    chart.setDataContext({ symbol: m.symbol, exchange: m.exchange, interval, hasOpenInterest: m.hasOpenInterest });
    // Drags snap by the same schedule the order constraints carry, and a
    // constant tick clears the one an earlier instrument left.
    chart.setTickSchedule(this.tickSchedule);
  }
}
