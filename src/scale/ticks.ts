/**
 * "Nice number" tick generation for the price axis (ARCHITECTURE.md §5).
 * Produces round, human-friendly step sizes.
 */

/**
 * Round `x` to a "nice" value: 1, 2, 5 or 10 times a power of ten. The 2.5
 * rung the price axis also uses lives in `nextNiceStep`.
 */
export function niceNum(x: number, round: boolean): number {
  if (x <= 0) return 0;
  const exp = Math.floor(Math.log10(x));
  const f = x / Math.pow(10, exp);
  let nf: number;
  if (round) {
    if (f < 1.5) nf = 1;
    else if (f < 3) nf = 2;
    else if (f < 7) nf = 5;
    else nf = 10;
  } else {
    if (f <= 1) nf = 1;
    else if (f <= 2) nf = 2;
    else if (f <= 5) nf = 5;
    else nf = 10;
  }
  return nf * Math.pow(10, exp);
}

/**
 * The next value up the 1, 2, 2.5, 5, 10 nice ladder. The 2.5 rung matters:
 * without it a 15-point range clamps from step 2 (8 labels) straight to step 5
 * (3 labels), when 2.5 lands exactly on the six the caller asked for.
 */
function nextNiceStep(step: number): number {
  const exp = Math.floor(Math.log10(step));
  const f = step / Math.pow(10, exp);
  for (const rung of [1, 2, 2.5, 5]) {
    if (rung > f * (1 + 1e-9)) return rung * Math.pow(10, exp);
  }
  return 10 * Math.pow(10, exp);
}

/** How many aligned ticks `step` puts inside [min, max]. */
function tickCount(min: number, max: number, step: number): number {
  const start = Math.ceil(min / step) * step;
  const end = Math.floor(max / step) * step;
  return Math.round((end - start) / step) + 1;
}

/** Whether `x` is a whole number, to the noise a product of decimals carries. */
function isWhole(x: number): boolean {
  return Math.abs(x - Math.round(x)) <= 1e-9 * Math.max(1, Math.abs(x));
}

/**
 * The step for an instrument quoted in `tick`s: the tick when `step` is finer,
 * `step` when it is already a whole number of ticks, else the next 1 / 2 / 5
 * count of ticks above it (0.025 on a 0.01 tick is 0.05). Every rung is then a
 * price the instrument trades at and prints as itself: a 0.005 step on a 0.01
 * tick printed 8.095 as "8.10" beside a real 8.10.
 */
function tickStep(step: number, tick: number): number {
  return step <= tick ? tick : isWhole(step / tick) ? step : tick * niceNum(step / tick, false);
}

/**
 * Generate up to ~`maxTicks` nicely-rounded tick values spanning [min, max].
 * Returns ascending values aligned to the chosen step (may sit slightly inside
 * the range). Returns a single midpoint when the range is degenerate.
 *
 * `tick` is the instrument's price increment. Given one, the step is a whole
 * number of ticks and never finer than one, so a tight range thins its rungs
 * (to none, on a range narrower than a tick) rather than print prices the
 * instrument cannot trade at. 0 leaves the step to the span alone.
 */
export function niceTicks(min: number, max: number, maxTicks = 6, tick = 0): number[] {
  if (!isFinite(min) || !isFinite(max) || max <= min) {
    return [Number.isFinite(min) ? min : 0];
  }
  const slots = Math.max(1, maxTicks - 1);
  // Derive the step from the *raw* span. Rounding the span up to a nice number
  // first and then dividing rounds twice (10.5 rounds to 20, then to a step of 5), which costs
  // roughly half the labels the caller asked for: a 10-point range on a 65000
  // instrument came out with three ticks instead of six.
  let step = niceNum((max - min) / slots, true);
  if (!(step > 0)) return [min];
  // `round: true` snaps to the *nearest* nice value, so it can land below the
  // requested density and yield more than `maxTicks` labels. Walk up the nice
  // ladder until the count fits; `maxTicks` is a ceiling, not a target.
  for (let guard = 0; guard < 20 && tickCount(min, max, step) > maxTicks; guard++) {
    step = nextNiceStep(step);
  }
  if (tick > 0) step = tickStep(step, tick);
  const start = Math.ceil(min / step) * step;
  const end = Math.floor(max / step) * step;
  const ticks: number[] = [];
  // Guard against floating drift producing a runaway loop.
  const count = Math.round((end - start) / step) + 1;
  for (let i = 0; i < count && i < 1000; i++) {
    const v = start + i * step;
    // Snap tiny floating error so labels read cleanly.
    ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  }
  return ticks;
}

/**
 * The roundest price in [a, b]: the first multiple of the largest 1 / 2 / 5
 * step that has one there. Steps down to a fraction of the window always do;
 * a window too narrow or too far out to measure is `a` itself, as the search
 * would never end.
 */
function roundestIn(a: number, b: number): number {
  if (!(b - a > 0 && b < Infinity)) return a;
  for (let e = Math.floor(Math.log10(b)); e >= Math.floor(Math.log10(b - a)) - 1; e--) {
    for (const m of [5, 2, 1]) {
      const s = m * Math.pow(10, e), v = Math.ceil(a / s) * s;
      if (v <= b) return v;
    }
  }
  return a;
}

/**
 * The ladder for a logarithmic axis. Equal price steps bunch at the top of a
 * log axis and spread apart at its foot: the linear ladder over 2 to 3000 put
 * every label in the top 178 px of 600. Here a slot is an equal share of the
 * log span, one price ratio, and each rung is the roundest price between one
 * and two slots above the rung below, so the labels keep their spacing down
 * every decade on screen: 1, 2, 5, 10 across decades, 100, 120, 150, 200
 * within one, and much the linear ladder on a narrow range. A range a log
 * cannot read, or too narrow for one slot to resolve, keeps the linear ladder.
 */
export function logTicks(min: number, max: number, maxTicks = 6, tick = 0): number[] {
  const ratio = Math.pow(max / min, 1 / Math.max(1, maxTicks - 1));
  if (!(ratio > 1 + 1e-9 && ratio < Infinity)) return niceTicks(min, max, maxTicks, tick);
  const ticks: number[] = [];
  for (let low = min; ticks.length < maxTicks;) {
    let rung = roundestIn(low, low * ratio);
    // Up to a tick, never down, so the rung keeps its slot above the last. The
    // margin is relative: an absolute one rounded a rung a billionth of a tick
    // up to zero.
    if (tick > 0) rung = Math.ceil((rung / tick) * (1 - 1e-12)) * tick;
    if (!(rung <= max)) break;
    ticks.push(rung);
    low = rung * ratio;
  }
  return ticks;
}

/**
 * Most decimals a label carries. Eight printed every price under about 1e-7
 * as 0.00000001; twelve still reads a price of 1e-10 to two figures.
 */
const MAX_PRECISION = 12;

/** Decimal places implied by a price step / tick size (for label formatting). */
export function precisionForStep(step: number): number {
  if (step <= 0 || !isFinite(step)) return 2;
  if (step >= 1) return 0;
  return Math.min(MAX_PRECISION, Math.ceil(-Math.log10(step)));
}

/**
 * Decimals that print every multiple of `tick` exactly. `precisionForStep`
 * reads a step's magnitude, right for a span and wrong for a tick: it gives
 * 0.25 one decimal and 2.5 none, so a valid 100.25 printed as "100.3".
 */
export function tickPrecision(tick: number): number {
  let digits = precisionForStep(tick);
  while (digits < MAX_PRECISION && !isWhole(tick * Math.pow(10, digits))) digits++;
  return digits;
}
