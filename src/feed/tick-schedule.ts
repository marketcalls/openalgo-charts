/**
 * One band of a price-dependent tick schedule. Valid prices inside a band are
 * whole multiples of its tick, counted from zero rather than from `from`.
 */
export interface TickBand {
  /**
   * Lowest price the band covers, inclusive; it ends where the next band
   * starts. The first band has none: it covers every lower price, zero and
   * negative prices included. A floor is a price limit, not a tick rule.
   */
  readonly from?: number;
  readonly tick: number;
}

const MAX_BANDS = 64;

function fail(message: string): never { throw new Error(`Invalid tick schedule: ${message}`); }
// Descriptor reads never run a getter and never see an inherited field.
function own(band: unknown, key: string): unknown {
  return band !== null && typeof band === 'object' ? Object.getOwnPropertyDescriptor(band, key)?.value : undefined;
}
function decimals(tick: number): number {
  for (let digits = 0; digits <= 12; digits++) {
    const units = tick * 10 ** digits;
    if (units >= 1 && Math.abs(units - Math.round(units)) <= 8 * Number.EPSILON * units) return digits;
  }
  return -1;
}
function onGrid(price: number, tick: number): boolean {
  const units = price / tick;
  return Math.abs(units - Math.round(units)) <= 8 * Number.EPSILON * Math.max(1, Math.abs(units));
}
function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a; }

/**
 * A validated, ordered tick schedule: the increment an instrument trades in
 * at each price. Every boundary must be a multiple of the ticks on both of its
 * sides, so the boundary is itself a valid price, rounding within a band is
 * also the nearest valid price overall, and no step ever skips a boundary.
 */
export class TickSchedule {
  public readonly bands: readonly TickBand[];
  /**
   * The finest grid every scheduled price lies on: the greatest common divisor
   * of the ticks. It is the smallest tick whenever the ticks nest, and finer
   * when they do not, because 20.05 on a 0.05 band is no multiple of 0.02.
   */
  public readonly minMove: number;
  private readonly _digits: readonly number[];

  /** Validated like any host metadata: a plain JSON list is enough. */
  public constructor(bands: readonly TickBand[]) {
    if (!Array.isArray(bands) || !bands.length || bands.length > MAX_BANDS) fail(`expected 1 to ${MAX_BANDS} bands`);
    const out: TickBand[] = [], digits: number[] = [];
    bands.forEach((band: unknown, i) => {
      const tick = own(band, 'tick'), from = own(band, 'from'), name = `bands[${i}]`;
      if (typeof tick !== 'number' || !Number.isFinite(tick) || tick <= 0 || decimals(tick) < 0) {
        fail(`${name}.tick must be a positive number with at most 12 decimals`);
      }
      digits.push(decimals(tick));
      if (!i) {
        if (from !== undefined) fail(`${name} covers every lower price, including zero and negatives, so it takes no from; use price limits for a floor`);
        out.push(Object.freeze({ tick }));
        return;
      }
      if (typeof from !== 'number' || !Number.isFinite(from)) fail(`${name}.from must be a finite number`);
      const previous = out[i - 1];
      if (previous.from !== undefined && from <= previous.from) fail(`${name}.from ${from} must be above bands[${i - 1}].from ${previous.from}; bounds are strictly ascending`);
      if (!onGrid(from, tick)) fail(`${name}.from ${from} is not a multiple of ${name}.tick ${tick}`);
      if (!onGrid(from, previous.tick)) fail(`${name}.from ${from} is not a multiple of bands[${i - 1}].tick ${previous.tick}`);
      // Stored exactly as `round` would return it, so a boundary compares equal.
      out.push(Object.freeze({ from: +(Math.round(from / tick) * tick).toFixed(digits[i]), tick }));
    });
    const scale = 10 ** Math.max(...digits);
    const units = out.map(band => Math.round(band.tick * scale));
    if (units.some(unit => !Number.isSafeInteger(unit))) fail('the ticks have no common grid in safe integers');
    this.bands = Object.freeze(out);
    this._digits = digits;
    this.minMove = +(units.reduce(gcd) / scale).toFixed(Math.max(...digits));
  }

  /** The band a price falls in; an exact boundary belongs to the band it starts. */
  private _band(price: number): number {
    let i = this.bands.length - 1;
    while (i > 0 && price < this.bands[i].from!) i--;
    return i;
  }

  // Exact decimals rather than 10.050000000000001. The string round trip also
  // drops the sign of a zero, which would otherwise print as "-0.00".
  private _at(units: number, band: number): number {
    return +(units * this.bands[band].tick).toFixed(this._digits[band]);
  }

  /** The tick at `price`, NaN when it is not finite. */
  public tickAt(price: number): number {
    return Number.isFinite(price) ? this.bands[this._band(price)].tick : NaN;
  }

  /**
   * The nearest valid price, NaN when `price` is not finite. A price halfway
   * between two valid prices, as written in decimal, rounds toward positive
   * infinity: the nudge undoes the binary error that stores 10.025 a hair
   * below itself, which is not the same thing as moving a real price.
   */
  public round(price: number): number {
    if (!Number.isFinite(price)) return NaN;
    const band = this._band(price), units = price / this.bands[band].tick;
    return this._at(Math.round(units + Math.abs(units) * 16 * Number.EPSILON), band);
  }

  /**
   * The valid price `ticks` whole ticks from `price` (rounded first). Up from a
   * boundary uses the band that starts there, down from it the band below.
   */
  public step(price: number, ticks: number): number {
    if (!Number.isInteger(ticks)) throw new RangeError('TickSchedule.step needs a whole number of ticks');
    let p = this.round(price), left = ticks;
    while (left && Number.isFinite(p)) {
      const up = left > 0;
      let band = this._band(p);
      if (!up && band && p === this.bands[band].from) band--;
      const { tick } = this.bands[band];
      const edge = up ? this.bands[band + 1]?.from : this.bands[band].from;
      // Whole bands are crossed in one jump, so a large count is not a long loop.
      const room = edge === undefined ? Infinity : Math.max(1, Math.round(Math.abs(edge - p) / tick));
      const n = Math.min(Math.abs(left), room);
      p = this._at(Math.round(p / tick) + (up ? n : -n), band);
      left += up ? -n : n;
    }
    return p;
  }
}
