/**
 * The render bench's budgets (tests/e2e/render-bench.perf.ts), as one table.
 *
 * Each cell of `measuredP95Ms` is the p95 step cost, in milliseconds, that the
 * bench measured on the reference machine for one renderer, one bar count and
 * one scenario: the lowest of five full runs. Other work shared the machine
 * while it measured, and load only ever adds time, so the lowest run is the
 * closest to what the machine itself costs. The budget that fails the run is
 * that figure times `margin`, never below `floorMs`:
 *
 *   budget = max(ceil(measured * margin), floorMs)
 *
 * The table holds measurements rather than budgets so that tightening one is a
 * measurement, not a judgement: after a cheaper path lands, run
 * `npm run bench:render` five times on the reference machine, put each cell's
 * lowest p95 here, then run `node scripts/check-render-bench-docs.mjs --write`
 * so docs/performance-notes.md quotes the same figures (CI fails until it
 * does). The margin is a separate policy and changes on its own, with its
 * reason in the commit.
 *
 * Why these two constants:
 *
 *   margin   The reference machine is a desktop CPU; a hosted CI runner has
 *            fewer and older cores, shares them, and gives the software GL
 *            device and the collector fewer threads. Four times the desktop
 *            p95 leaves room for a runner core half as quick and a busy run on
 *            top of that, and still fails a change that makes a path several
 *            times costlier, which is the regression this exists to catch.
 *   floorMs  One frame at 60 Hz. A frame that costs less is on time whatever it
 *            costs, so a budget below that line would police timer and
 *            collector noise rather than anything a user sees.
 */

export const RENDER_BENCH_BUDGETS = {
  reference: 'the 2.5.7 build, lowest p95 of five runs on an 8-core desktop CPU (16 logical) in headless Chromium 149, 2026-09-26',
  margin: 4,
  floorMs: 17,
  measuredP95Ms: {
    canvas2d: {
      10000: { pan: 3.1, zoomOut: 21.2, tick: 209.1 },
      50000: { pan: 3.2, zoomOut: 65.4, tick: 1166.3 },
      200000: { pan: 2.9, zoomOut: 278.2, tick: 5591.7 },
    },
    webgl2: {
      10000: { pan: 12.4, zoomOut: 20.4, tick: 206.3 },
      50000: { pan: 12.5, zoomOut: 57.5, tick: 1089.9 },
      200000: { pan: 12.1, zoomOut: 232, tick: 5785.6 },
    },
  },
};

export const BENCH_RENDERERS = /** @type {const} */ (['canvas2d', 'webgl2']);
export const BENCH_BAR_COUNTS = /** @type {const} */ ([10000, 50000, 200000]);
export const BENCH_METRICS = /** @type {const} */ (['pan', 'zoomOut', 'tick']);

/** What each metric times, for reports and the docs table. */
export const BENCH_METRIC_LABELS = {
  pan: 'pan frame p95',
  zoomOut: 'full zoom-out frame p95',
  tick: 'tick p95, 10 studies',
};

/**
 * The budget in milliseconds for one cell of the table.
 *
 * @param {'canvas2d' | 'webgl2'} renderer
 * @param {number} bars
 * @param {'pan' | 'zoomOut' | 'tick'} metric
 * @returns {number}
 */
export function renderBenchBudgetMs(renderer, bars, metric) {
  const row = RENDER_BENCH_BUDGETS.measuredP95Ms[renderer]?.[bars];
  const measured = row?.[metric];
  if (typeof measured !== 'number' || !(measured > 0)) {
    throw new Error(`render bench: no measured p95 for ${renderer} at ${bars} bars (${metric})`);
  }
  return Math.max(Math.ceil(measured * RENDER_BENCH_BUDGETS.margin), RENDER_BENCH_BUDGETS.floorMs);
}
