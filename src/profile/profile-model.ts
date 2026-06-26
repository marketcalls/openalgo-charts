/**
 * Profile data model (ARCHITECTURE.md §6A, Family C). Price-bucketed
 * distributions: volume-at-price, time-at-price (TPO), and bid/ask footprint.
 */
export interface VolumeProfileResult {
  /** Volume per price bucket, sorted high → low price. */
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
  cells: FootprintCell[]; // sorted high → low price
  /** Net delta = Σ(askVol − bidVol). */
  delta: number;
}

/** Bucket a price to the tick grid. */
export function bucketPrice(price: number, step: number): number {
  return Math.round((Math.round(price / step) * step) * 1e8) / 1e8;
}

/** Inclusive list of bucket prices spanning [low, high]. */
export function priceBuckets(low: number, high: number, step: number): number[] {
  const lo = bucketPrice(low, step);
  const hi = bucketPrice(high, step);
  const out: number[] = [];
  for (let p = lo; p <= hi + step / 2; p += step) out.push(bucketPrice(p, step));
  return out;
}
