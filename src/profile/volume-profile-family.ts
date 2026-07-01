/**
 * Volume Profile family (ARCHITECTURE.md §6A, Family C). Volume-at-price grouped
 * into sessions (composite / day / week / month), with a POC and Value Area per
 * session and an optional buy/sell split.
 *
 * The buy/sell split is an honest OHLCV approximation: a bar's whole volume is
 * attributed to buyers when it closed up (`close >= open`) and to sellers when it
 * closed down. True bid/ask delta needs classified trades - see the
 * [Footprint](./footprint.ts). Set `deltaFromBarDirection: false` to keep volume
 * un-split (buy/sell/delta all zero).
 *
 * Visible-range volume profile = pass the visible slice of bars with
 * `session: 'composite'`. Pure and deterministic.
 */
import type { Bar } from '../model/bar';
import { priceBuckets } from './profile-model';
import { utcSecondsToIstParts, istStringToUtcSeconds } from '../feed/time';

export type VolumeProfileSession = 'composite' | 'day' | 'week' | 'month';

export interface VolumeProfileFamilyOptions {
  /** Price bucket size. */
  tickSize: number;
  /** Session grouping. `composite` builds one profile over all bars. */
  session: VolumeProfileSession;
  /** Value-area fraction of total volume (0..1). */
  valueAreaPercent: number;
  /** Split each bar's volume into buy/sell by bar direction (close >= open => buy). */
  deltaFromBarDirection: boolean;
}

export const DEFAULT_VOLUME_PROFILE_FAMILY_OPTIONS: VolumeProfileFamilyOptions = {
  tickSize: 0.05,
  session: 'composite',
  valueAreaPercent: 0.7,
  deltaFromBarDirection: true,
};

export interface VolumeProfileLevel {
  price: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  /** buyVolume - sellVolume. */
  delta: number;
}

export interface VolumeProfileSessionResult {
  startTime: number;
  endTime: number;
  /** Price levels, sorted high -> low. */
  levels: VolumeProfileLevel[];
  /** Point of control (price with the most volume). */
  poc: number;
  vah: number;
  val: number;
  totalVolume: number;
  buyVolume: number;
  sellVolume: number;
  delta: number;
}

export interface VolumeProfileFamilyResult {
  sessions: VolumeProfileSessionResult[];
  options: VolumeProfileFamilyOptions;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

/** UTC seconds -> session group key for the chosen mode (IST calendar). */
function sessionKey(utcSeconds: number, mode: VolumeProfileSession): number {
  if (mode === 'composite') return 0;
  const p = utcSecondsToIstParts(utcSeconds);
  if (mode === 'month') return istStringToUtcSeconds(`${p.year}-${pad2(p.month)}-01`);
  const dayStart = istStringToUtcSeconds(`${p.year}-${pad2(p.month)}-${pad2(p.day)}`);
  if (mode === 'day') return dayStart;
  const backToMonday = ((p.weekday + 6) % 7) * 86400;
  return dayStart - backToMonday;
}

interface Acc {
  volume: number;
  buy: number;
  sell: number;
}

export function computeVolumeProfileSessions(
  bars: readonly Bar[],
  options: Partial<VolumeProfileFamilyOptions> = {},
): VolumeProfileFamilyResult {
  const o: VolumeProfileFamilyOptions = { ...DEFAULT_VOLUME_PROFILE_FAMILY_OPTIONS, ...options };
  const tick = o.tickSize > 0 ? o.tickSize : DEFAULT_VOLUME_PROFILE_FAMILY_OPTIONS.tickSize;
  const vaPct = Math.min(1, Math.max(0, o.valueAreaPercent));

  const groups = new Map<number, Bar[]>();
  const order: number[] = [];
  for (const b of bars) {
    const k = sessionKey(b.time, o.session);
    let g = groups.get(k);
    if (g === undefined) { g = []; groups.set(k, g); order.push(k); }
    g.push(b);
  }

  const sessions: VolumeProfileSessionResult[] = [];
  for (const k of order) {
    const g = groups.get(k) as Bar[];
    if (g.length === 0) continue;
    const map = new Map<number, Acc>();
    let totalVolume = 0;
    let buyVolume = 0;
    let sellVolume = 0;

    for (const b of g) {
      const vol = b.volume ?? 0;
      totalVolume += vol;
      const up = b.close >= b.open;
      const barBuy = o.deltaFromBarDirection ? (up ? vol : 0) : 0;
      const barSell = o.deltaFromBarDirection ? (up ? 0 : vol) : 0;
      buyVolume += barBuy;
      sellVolume += barSell;
      const buckets = priceBuckets(b.low, b.high, tick);
      const n = Math.max(1, buckets.length);
      const vShare = vol / n;
      const buyShare = barBuy / n;
      const sellShare = barSell / n;
      for (const price of buckets) {
        let a = map.get(price);
        if (a === undefined) { a = { volume: 0, buy: 0, sell: 0 }; map.set(price, a); }
        a.volume += vShare;
        a.buy += buyShare;
        a.sell += sellShare;
      }
    }

    const levels: VolumeProfileLevel[] = Array.from(map.entries())
      .map(([price, a]) => ({ price, volume: a.volume, buyVolume: a.buy, sellVolume: a.sell, delta: a.buy - a.sell }))
      .sort((x, y) => y.price - x.price);

    if (levels.length === 0) continue;

    // POC + value-area expansion by volume.
    let pocIdx = 0;
    for (let i = 1; i < levels.length; i++) if (levels[i].volume > levels[pocIdx].volume) pocIdx = i;
    let upper = pocIdx;
    let lower = pocIdx;
    let acc = levels[pocIdx].volume;
    const target = totalVolume * vaPct;
    while (acc < target && (upper > 0 || lower < levels.length - 1)) {
      const up = upper > 0 ? levels[upper - 1].volume : -1;
      const down = lower < levels.length - 1 ? levels[lower + 1].volume : -1;
      if (up >= down) { upper -= 1; acc += levels[upper].volume; }
      else { lower += 1; acc += levels[lower].volume; }
    }

    sessions.push({
      startTime: g[0].time,
      endTime: g[g.length - 1].time,
      levels,
      poc: levels[pocIdx].price,
      vah: levels[upper].price,
      val: levels[lower].price,
      totalVolume,
      buyVolume,
      sellVolume,
      delta: buyVolume - sellVolume,
    });
  }

  return { sessions, options: o };
}
