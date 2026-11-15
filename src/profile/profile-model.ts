/**
 * Profile data model (ARCHITECTURE.md §6A, Family C). Price-bucketed
 * distributions: volume-at-price, time-at-price (TPO), and bid/ask footprint.
 */
import type { Bar } from '../model/bar';
import { gridPrice, gridScale, nearWhole } from '../helpers/math';

export interface VolumeProfileResult {
  /** Volume per price bucket, sorted high to low price. */
  buckets: { price: number; volume: number }[];
  /** Point of control: price bucket with the most volume. */
  poc: number;
  /** Value-area high / low (the price band holding `valueAreaPercent` of volume). */
  vah: number;
  val: number;
  totalVolume: number;
}

export interface TpoResult {
  buckets: { price: number; count: number }[];
  poc: number;
  vah: number;
  val: number;
  /** Initial balance: price range of the first `ibPeriods` periods. */
  ib: { high: number; low: number };
}

export interface FootprintCell {
  price: number;
  bidVol: number;
  askVol: number;
}

export interface FootprintBar {
  time: number;
  cells: FootprintCell[]; // sorted high to low price
  /** Net delta = Σ(askVol − bidVol). */
  delta: number;
  /** Lowest/highest running trade delta within this bar, including initial zero.
   * Absent when only aggregated price rows are available. */
  minDelta?: number;
  maxDelta?: number;
  /** Effective ladder step: instrument tick size multiplied by rowTicks. */
  rowSize?: number;
  /** Actual traded prices, before ladder rounding. Absent for empty/legacy bars. */
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  /** Number of classified trade records counted (those passing any size filter), not occupied rows. */
  tradeCount?: number;
  /**
   * Bid and ask volume of every print, before any size filter, at the bar's
   * exact high and low prices. An extreme that traded on both sides is an
   * unfinished auction. Absent on manually assembled bars.
   */
  auction?: { highBid: number; highAsk: number; lowBid: number; lowAsk: number };
}

/**
 * The prices a run of sessions covers, each session's levels sorted high to
 * low, or null when none has a level: what a session profile autoscales to.
 */
export function sessionsPriceRange(sessions: readonly { readonly levels: readonly { readonly price: number }[] }[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const s of sessions) {
    if (s.levels.length === 0) continue;
    max = Math.max(max, s.levels[0]!.price);
    min = Math.min(min, s.levels[s.levels.length - 1]!.price);
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/**
 * A bar's volume for a profile: 0 when it has none to give, absent or not a
 * finite number of at least zero. One NaN added into a row made every total
 * NaN and moved the POC to whichever row compared last.
 */
export function barVolume(bar: Bar): number {
  const v = bar.volume;
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * The row holding `price`, in whole steps from zero. Rows are centred on
 * multiples of the step and a price exactly between two centres belongs to
 * the upper one, so every row spans `[centre - step / 2, centre + step / 2)`
 * and holds as many ticks as the next. Halves are found on the doubled
 * quotient with the float noise taken off: a plain round sent 100.15 and
 * 100.45 on 0.1 rows opposite ways, so rows held 1, 2 or 3 ticks at random.
 * The footprint splits such a tick to the even row instead (footprint.ts).
 */
function rowIndex(price: number, step: number): number {
  return Math.floor((nearWhole((price / step) * 2) + 1) / 2);
}

/**
 * Bucket a price to the row grid of `step`: the centre of the row holding it,
 * the upper row for a price exactly between two.
 */
export function bucketPrice(price: number, step: number): number {
  return gridPrice(rowIndex(price, step), step);
}

/**
 * Inclusive list of bucket prices spanning [low, high]. A step that is not a
 * positive finite number gives no buckets, and so does a range the numbers
 * cannot step through: a step too small to move a price that large, or to
 * number its rows exactly, or a price past the largest number.
 */
export function priceBuckets(low: number, high: number, step: number): number[] {
  // A negative step would walk away from `high` and never stop.
  if (!(step > 0) || step === Infinity) return [];
  const first = rowIndex(low, step);
  const last = rowIndex(high, step);
  const scale = gridScale(step);
  const lo = gridPrice(first, step, scale);
  const hi = gridPrice(last, step, scale);
  // A step that no longer moves the price, or a price that overflows, has no
  // rows a walk could tell apart. Nor does a row past 2^53: there a row plus
  // one is the same row, so the walk below would never pass `last`, and 0.1
  // on a step of 1e-17 is row 10^16 although 0.1 + 1e-17 still moves.
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || lo + step === lo || hi + step === hi) return [];
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(gridPrice(i, step, scale));
  return out;
}

/**
 * Point of control and value area over rows sorted high to low price, as
 * row indices: the POC is the first row with the most weight (a strict `>`,
 * so a tie keeps the higher price), and the area grows from it one row at a
 * time towards the heavier neighbour, the higher one on a tie, until it holds
 * `target`. `upper` is the area's highest-priced row and `lower` its lowest.
 * Every profile in this tier reads its POC and value area here, which is what
 * keeps the semantics the tier documents identical across them. Tier-internal:
 * the tier index does not re-export it.
 */
export function valueArea(weights: readonly number[], target: number): { poc: number; upper: number; lower: number } {
  let poc = 0;
  for (let i = 1; i < weights.length; i++) if (weights[i]! > weights[poc]!) poc = i;
  let upper = poc;
  let lower = poc;
  let acc = weights[poc] ?? 0;
  // Every index stays in 0..weights.length - 1: the loop bound and the guard
  // on each step keep it there.
  while (acc < target && (upper > 0 || lower < weights.length - 1)) {
    const up = upper > 0 ? weights[upper - 1]! : -1;
    const down = lower < weights.length - 1 ? weights[lower + 1]! : -1;
    if (up >= down) acc += weights[--upper]!;
    else acc += weights[++lower]!;
  }
  return { poc, upper, lower };
}
