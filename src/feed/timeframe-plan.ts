import type { SessionCalendar } from './instrument';
import { bucketStartOf, nextBucketStart, resolveInterval, type Bucketing } from './intervals';
import { utcSecondsToZonedParts, zonedWallClockToUtcSeconds } from './time';
import type { BarsRequest } from './types';

/** A candle label and the half-open observation window it represents. */
export interface TimeframeBucket { time: number; from: number; to: number }

/** Native wire token, timestamp convention and declared retention limits. */
export interface TimeframeSource {
  interval: string;
  /** Null means unknown alignment. Such a source can only be used natively. */
  bounds(time: number): TimeframeBucket | null;
  earliest?: number;
  maxBars?: number;
  maxSpanSeconds?: number;
}

/** Host-owned capabilities, including calendar/session/adjustment revision in key. */
export interface TimeframeMarket {
  key: string;
  calendar: SessionCalendar;
  sources: readonly TimeframeSource[];
}

/** Source choice for one requested interval in one market revision. */
export interface TimeframePlan {
  interval: string;
  source: TimeframeSource;
  native: boolean;
  market: TimeframeMarket;
}

function rule(code: string): Bucketing {
  const b = resolveInterval(code).bucketing;
  if (b.mode === 'interval' && Number.isSafeInteger(b.seconds) && b.seconds > 0) return b;
  if (b.mode === 'calendar' && Number.isSafeInteger(b.count ?? 1) && (b.count ?? 1) > 0) return b;
  throw new Error(`Invalid clock or calendar timeframe: ${code}`);
}

function months(b: Bucketing): number {
  return b.mode === 'calendar' ? (b.count ?? 1) * ({ month: 1, quarter: 3, year: 12 }[b.unit]) : 0;
}

function equivalent(a: Bucketing, b: Bucketing): boolean {
  return a.mode === 'interval' && b.mode === 'interval'
    ? a.seconds === b.seconds && (a.anchorSec ?? 0) === (b.anchorSec ?? 0)
    : a.mode === 'calendar' && b.mode === 'calendar' && months(a) === months(b) && a.timezone === b.timezone;
}

function compatible(target: Bucketing, source: Bucketing): boolean {
  if (source.mode !== 'interval') return false;
  if (target.mode === 'calendar') return source.seconds === 86400;
  if (target.mode !== 'interval') return false;
  // Calendar periods need daily observations. Intraday gaps cannot establish a daily series.
  if (target.seconds >= 86400) return source.seconds === 86400;
  return source.seconds < target.seconds && target.seconds % source.seconds === 0;
}

function covers(source: TimeframeSource, req: BarsRequest): boolean {
  return source.earliest === undefined || req.from === undefined || req.from >= source.earliest;
}

/** Prefer a native alias, otherwise the coarsest compatible source with coverage. */
export function planTimeframe(request: BarsRequest, market: TimeframeMarket): TimeframePlan {
  const target = rule(request.interval);
  const sources = market.sources.map(source => ({ source, rule: rule(source.interval) }));
  const native = sources.find(item => equivalent(target, item.rule) && covers(item.source, request));
  if (native) return { interval: request.interval, source: native.source, native: true, market };
  const candidates = sources.filter(item => compatible(target, item.rule));
  if (!candidates.length) throw new Error(`No compatible source for ${request.interval}`);
  const covered = candidates.filter(item => covers(item.source, request));
  if (!covered.length) throw new Error(`Insufficient source coverage for ${request.interval}`);
  covered.sort((a, b) => (b.rule.mode === 'interval' ? b.rule.seconds : 0) - (a.rule.mode === 'interval' ? a.rule.seconds : 0));
  const instant = request.from ?? request.to ?? Date.now() / 1000;
  const session = market.calendar.sessionFrom(instant);
  for (const { source } of covered) {
    const plan: TimeframePlan = { interval: request.interval, source, native: false, market };
    const probe = session ? Math.max(instant, session.open) : instant;
    const bucket = timeframeBucketAt(plan, probe);
    // A candle inside a bucket can fit by accident while the next crosses its
    // edge. Intraday divisibility must also hold at the target opening.
    const edge = target.mode === 'interval' && target.seconds < 86400 ? bucket?.from ?? probe : probe;
    const bounds = source.bounds(edge);
    if (bounds && bucket && bounds.from >= bucket.from && bounds.to <= bucket.to && bounds.to > bounds.from) return plan;
  }
  throw new Error(`Unknown or incompatible source alignment for ${request.interval}`);
}

function civilBucket(time: number, seconds: number, timezone: string): TimeframeBucket {
  const p = utcSecondsToZonedParts(time, timezone);
  const day = Date.UTC(p.year, p.month - 1, p.day) / 86400000;
  const count = seconds / 86400;
  // Monday 1970-01-05 is a continuous multi-week anchor, including across years.
  const anchor = seconds % 604800 === 0 ? 4 : 0;
  const first = anchor + Math.floor((day - anchor) / count) * count;
  const boundary = (offset: number): number => {
    const date = new Date((first + offset) * 86400000);
    return zonedWallClockToUtcSeconds(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, 0, 0, timezone);
  };
  const from = boundary(0);
  return { time: from, from, to: boundary(count) };
}

/** Exchange-session buckets for intraday bars; civil calendar buckets for days and above. */
export function timeframeBucketAt(plan: TimeframePlan, time: number): TimeframeBucket | null {
  if (!Number.isFinite(time)) throw new Error('Invalid timeframe timestamp');
  if (plan.native) return plan.source.bounds(time);
  const b = rule(plan.interval), calendar = plan.market.calendar;
  if (b.mode === 'calendar') {
    const from = bucketStartOf(b, time, calendar.timezone);
    return { time: from, from, to: nextBucketStart(b, time, calendar.timezone)! };
  }
  if (b.mode !== 'interval') return null;
  if (b.seconds >= 86400) {
    if (b.seconds % 86400 !== 0) throw new Error('Multi-day timeframes require whole calendar days');
    return civilBucket(time, b.seconds, calendar.timezone);
  }
  const session = calendar.sessionAt(time);
  if (!session) return null;
  const from = session.open + Math.floor((time - session.open) / b.seconds) * b.seconds;
  return { time: from, from, to: Math.min(from + b.seconds, session.close) };
}
