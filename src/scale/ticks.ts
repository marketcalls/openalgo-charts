/**
 * "Nice number" tick generation (ARCHITECTURE.md §5). Shared by the price axis
 * (and later the time axis). Produces round, human-friendly step sizes.
 */

/** Round `x` to a "nice" value (1, 2, 2.5, 5, 10 × 10ⁿ). */
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
 * Generate up to ~`maxTicks` nicely-rounded tick values spanning [min, max].
 * Returns ascending values aligned to the chosen step (may sit slightly inside
 * the range). Returns a single midpoint when the range is degenerate.
 */
export function niceTicks(min: number, max: number, maxTicks = 6): number[] {
  if (!isFinite(min) || !isFinite(max) || max <= min) {
    return [Number.isFinite(min) ? min : 0];
  }
  const range = niceNum(max - min, false);
  const step = niceNum(range / Math.max(1, maxTicks - 1), true);
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

/** Decimal places implied by a price step / tick size (for label formatting). */
export function precisionForStep(step: number): number {
  if (step <= 0 || !isFinite(step)) return 2;
  if (step >= 1) return 0;
  return Math.min(8, Math.ceil(-Math.log10(step)));
}
