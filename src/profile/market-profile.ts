/**
 * Market Profile / TPO (Time Price Opportunity) — ARCHITECTURE.md §6A, Family C.
 *
 * Groups bars into sessions (day / week / month / composite), splits each
 * session into fixed-length time blocks ("periods", one letter each), and counts
 * how many periods traded at each price. Derives the Point of Control, Value
 * Area, Initial Balance, single prints, and poor highs/lows, plus volume at
 * price. Pure and deterministic (no Date.now / Math.random), so it is fully
 * unit-testable and derivable from intraday OHLCV bars alone.
 */
import type { Bar } from '../model/bar';
import { priceBuckets } from './profile-model';
import { utcSecondsToIstParts, istStringToUtcSeconds } from '../feed/time';

export type MarketProfileSession = 'day' | 'week' | 'month' | 'composite';

export interface MarketProfileOptions {
  /** Price bucket size (the tick grid TPOs are counted on). */
  tickSize: number;
  /** Session grouping. `composite` builds one profile over all bars. */
  session: MarketProfileSession;
  /** TPO period length in minutes — one letter per period. */
  blockMinutes: number;
  /** Value-area fraction of total TPOs (0..1). */
  valueAreaPercent: number;
  /** Number of opening periods that form the Initial Balance. */
  initialBalancePeriods: number;
}

export const DEFAULT_MARKET_PROFILE_OPTIONS: MarketProfileOptions = {
  tickSize: 0.05,
  session: 'day',
  blockMinutes: 30,
  valueAreaPercent: 0.7,
  initialBalancePeriods: 2,
};

export interface MarketProfileLevel {
  price: number;
  /** Distinct periods (TPOs) that traded at this price. */
  count: number;
  /** Period letters at this price, in period order (e.g. `"ABF"`). */
  letters: string;
  /** Volume traded at this price (each bar's volume split across its range). */
  volume: number;
}

export interface MarketProfileSessionResult {
  /** UTC seconds of the session's first and last bar. */
  startTime: number;
  endTime: number;
  /** Price levels, sorted high -> low. */
  levels: MarketProfileLevel[];
  /** Point of control (price with the most TPOs). */
  poc: number;
  /** Value-area high / low. */
  vah: number;
  val: number;
  /** Number of periods (letters) in the session. */
  periods: number;
  /** Initial balance — price range of the opening `initialBalancePeriods`. */
  initialBalance: { high: number; low: number };
  /** Prices that printed a single TPO away from the session extremes. */
  singlePrints: number[];
  /** True when the session high / low printed more than one TPO (weak extreme). */
  poorHigh: boolean;
  poorLow: boolean;
  /** Total traded volume in the session. */
  totalVolume: number;
}

export interface MarketProfileResult {
  sessions: MarketProfileSessionResult[];
  options: MarketProfileOptions;
}

/** Period index -> TPO letter (`A`-`Z`, then `a`-`z`, then wraps). */
export function tpoLetter(period: number): string {
  const m = ((period % 52) + 52) % 52;
  return m < 26 ? String.fromCharCode(65 + m) : String.fromCharCode(97 + (m - 26));
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/** UTC seconds -> session group key for the chosen mode (IST calendar). */
function sessionKey(utcSeconds: number, mode: MarketProfileSession): number {
  if (mode === 'composite') return 0;
  const p = utcSecondsToIstParts(utcSeconds);
  if (mode === 'month') return istStringToUtcSeconds(`${p.year}-${pad2(p.month)}-01`);
  const dayStart = istStringToUtcSeconds(`${p.year}-${pad2(p.month)}-${pad2(p.day)}`);
  if (mode === 'day') return dayStart;
  // week: roll back to the Monday of the IST week
  const backToMonday = ((p.weekday + 6) % 7) * 86400;
  return dayStart - backToMonday;
}

interface LevelAcc {
  count: number;
  periods: Set<number>;
  volume: number;
}

export function computeMarketProfile(
  bars: readonly Bar[],
  options: Partial<MarketProfileOptions> = {},
): MarketProfileResult {
  const o: MarketProfileOptions = { ...DEFAULT_MARKET_PROFILE_OPTIONS, ...options };
  const tick = o.tickSize > 0 ? o.tickSize : DEFAULT_MARKET_PROFILE_OPTIONS.tickSize;
  const blockSec = Math.max(1, Math.round(o.blockMinutes * 60));
  const vaPct = Math.min(1, Math.max(0, o.valueAreaPercent));
  const ibPeriods = Math.max(1, Math.floor(o.initialBalancePeriods));

  // Group bars by session, preserving first-seen order (bars assumed ascending).
  const groups = new Map<number, Bar[]>();
  const order: number[] = [];
  for (const b of bars) {
    const k = sessionKey(b.time, o.session);
    let g = groups.get(k);
    if (g === undefined) { g = []; groups.set(k, g); order.push(k); }
    g.push(b);
  }

  const sessions: MarketProfileSessionResult[] = [];
  for (const k of order) {
    const g = groups.get(k) as Bar[];
    if (g.length === 0) continue;
    const first = g[0].time;
    const map = new Map<number, LevelAcc>();
    let maxPeriod = 0;
    let ibHigh = -Infinity;
    let ibLow = Infinity;
    let totalVolume = 0;

    for (const b of g) {
      const period = Math.max(0, Math.floor((b.time - first) / blockSec));
      if (period > maxPeriod) maxPeriod = period;
      if (period < ibPeriods) { ibHigh = Math.max(ibHigh, b.high); ibLow = Math.min(ibLow, b.low); }
      const buckets = priceBuckets(b.low, b.high, tick);
      const vShare = (b.volume ?? 0) / Math.max(1, buckets.length);
      totalVolume += b.volume ?? 0;
      for (const price of buckets) {
        let a = map.get(price);
        if (a === undefined) { a = { count: 0, periods: new Set<number>(), volume: 0 }; map.set(price, a); }
        if (!a.periods.has(period)) { a.periods.add(period); a.count += 1; }
        a.volume += vShare;
      }
    }

    const levels: MarketProfileLevel[] = Array.from(map.entries())
      .map(([price, a]) => ({
        price,
        count: a.count,
        volume: a.volume,
        letters: Array.from(a.periods).sort((x, y) => x - y).map(tpoLetter).join(''),
      }))
      .sort((x, y) => y.price - x.price);

    if (levels.length === 0) continue;

    // POC + value-area expansion from the POC outward.
    const total = levels.reduce((s, l) => s + l.count, 0);
    let pocIdx = 0;
    for (let i = 1; i < levels.length; i++) if (levels[i].count > levels[pocIdx].count) pocIdx = i;
    let upper = pocIdx;
    let lower = pocIdx;
    let acc = levels[pocIdx].count;
    const targetVa = total * vaPct;
    while (acc < targetVa && (upper > 0 || lower < levels.length - 1)) {
      const up = upper > 0 ? levels[upper - 1].count : -1;
      const down = lower < levels.length - 1 ? levels[lower + 1].count : -1;
      if (up >= down) { upper -= 1; acc += levels[upper].count; }
      else { lower += 1; acc += levels[lower].count; }
    }

    // Single prints: a lone TPO away from the session high/low.
    const singlePrints: number[] = [];
    for (let i = 1; i < levels.length - 1; i++) if (levels[i].count === 1) singlePrints.push(levels[i].price);

    sessions.push({
      startTime: first,
      endTime: g[g.length - 1].time,
      levels,
      poc: levels[pocIdx].price,
      vah: levels[upper].price,
      val: levels[lower].price,
      periods: maxPeriod + 1,
      initialBalance: {
        high: Number.isFinite(ibHigh) ? ibHigh : levels[0].price,
        low: Number.isFinite(ibLow) ? ibLow : levels[levels.length - 1].price,
      },
      singlePrints,
      poorHigh: levels[0].count > 1,
      poorLow: levels[levels.length - 1].count > 1,
      totalVolume,
    });
  }

  return { sessions, options: o };
}
