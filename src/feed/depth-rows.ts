/**
 * Depth-of-market row building shared by the trade tier's on-chart ladder
 * (`buildRows`) and the terminal's standalone ladder (`buildDomRows`). Pure:
 * each tier inlines it, so a fix to price grouping reaches both ladders.
 */
import type { MarketDepth } from './types';
import type { TickSchedule } from './tick-schedule';

/**
 * The public surface of a tick schedule. Structural on purpose: the trade tier
 * names `TickSchedule` through the package entry and the dock through the
 * source module, and a class with private members is only assignable to its
 * own declaration -- the website build compiles both and saw two classes.
 */
type ScheduleLike = Pick<TickSchedule, 'round' | 'bands'>;

export interface DepthRow {
  price: number;
  bidQty: number;
  askQty: number;
}

/**
 * A row price on a tick schedule: the level's nearest valid price, and with
 * grouping the nearest multiple of `n` ticks of that price's band, kept inside
 * the band so the row is still a price a click can trade at.
 */
function scheduleBucket(ticks: ScheduleLike, n: number): (p: number) => number {
  return (p) => {
    const price = ticks.round(p), { bands } = ticks;
    if (n === 1 || !Number.isFinite(price)) return price;
    // A schedule has at least one band (its constructor refuses none), and i
    // walks down from the last to no lower than the first.
    let i = bands.length - 1;
    while (i > 0 && price < bands[i]!.from!) i--;
    const band = bands[i]!;
    const step = band.tick * n;
    const lower = band.from ?? -Infinity, upper = bands[i + 1]?.from ?? Infinity;
    // A boundary is valid in both bands, so it is where a group stops.
    return ticks.round(Math.min(Math.max(Math.round(price / step) * step, lower), upper));
  };
}

/**
 * Only an object is a schedule. Anything else, a numeric string from a plain-JS
 * host included, keeps the arithmetic that predates schedules. A type guard,
 * because the website compiles the trade tier with strict null checks off, where
 * an inline null check does not narrow the union.
 */
function isSchedule(tickSize: number | ScheduleLike): tickSize is ScheduleLike {
  return typeof tickSize === 'object' && tickSize !== null;
}

/**
 * The row-price function for a constant tick or a schedule, or null when the
 * object passed as a schedule has no `round` (each caller decides what that means).
 * A constant tick multiplies `tickSize * groupBy`; a schedule groups whole ticks,
 * a fraction rounding down, because a fractional group would label rows between
 * the prices a band allows.
 */
export function depthBucket(tickSize: number | ScheduleLike, groupBy = 1): ((p: number) => number) | null {
  if (!isSchedule(tickSize)) {
    const step = tickSize * Math.max(1, groupBy);
    return (p: number): number => Math.round(Math.round(p / step) * step * 1e8) / 1e8;
  }
  if (typeof (tickSize as Partial<ScheduleLike>).round !== 'function') return null;
  return scheduleBucket(tickSize, groupBy > 1 ? Math.floor(groupBy) : 1);
}

/** Merge bids and asks into rows keyed by `bucket`, sorted high to low price. */
export function aggregateDepthRows(depth: MarketDepth, bucket: (p: number) => number): DepthRow[] {
  const map = new Map<number, DepthRow>();
  const add = (price: number, qty: number, side: 'bid' | 'ask'): void => {
    const key = bucket(price);
    let row = map.get(key);
    if (row === undefined) { row = { price: key, bidQty: 0, askQty: 0 }; map.set(key, row); }
    if (side === 'bid') row.bidQty += qty; else row.askQty += qty;
  };
  for (const b of depth.bids) add(b.price, b.qty, 'bid');
  for (const a of depth.asks) add(a.price, a.qty, 'ask');
  return Array.from(map.values()).sort((x, y) => y.price - x.price);
}
