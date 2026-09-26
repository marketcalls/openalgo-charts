/**
 * Pane rendering benchmark: what one frame costs as the history grows, and
 * what one pointer move costs as the drawings pile up.
 *
 * Three measurements, each on a real `Chart` from a built bundle, painted into
 * contexts that draw nothing but count what they are asked to draw:
 *
 *   A. level of detail   fill and stroke calls in one full frame of 200,000
 *                        candles and their volume fitted into the plot. Drawing
 *                        one mark per bar is what makes a zoomed-out chart slow,
 *                        so the budget is a multiple of the plot's width in
 *                        device pixels, never of the bar count.
 *
 *   B. allocation        heap bytes allocated per frame while panning 50,000
 *                        bars, at two zooms, with the price scales held still
 *                        and autoscaling. What the frame allocates for its
 *                        axes and labels is bounded by the chart's size; what
 *                        it allocates per bar in view is the waste, so the
 *                        budget is on the slope between the two zooms (bytes
 *                        per visible bar per frame), and the scavenges counted
 *                        over a long pan say how often it reaches the
 *                        collector.
 *
 *   C. hit testing       microseconds per hover move across the plot with 500
 *                        drawings, for the whole move (overlay repaint
 *                        included) and for the hit test alone: 500 host
 *                        primitives that declare their hit bounds, and 500
 *                        shapes on the draw tier's layers. The budget is on
 *                        how many primitives a move asks to hit-test, a count
 *                        that does not depend on the machine.
 *
 * Budgets are for the build under test. `--compare=<dir>` measures a second
 * build (dist-baseline/ is the previous release) with the same scenes and
 * prints the two side by side, without holding it to them.
 *
 *   node scripts/bench-pane.mjs [--dist=dist] [--compare=dist-baseline] [--json]
 *
 * The script restarts itself with `--expose-gc` and a young generation large
 * enough that a measured loop runs without a scavenge, so a heap delta is the
 * bytes the loop allocated.
 */

import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

const NODE_FLAGS = ['--expose-gc', '--min-semi-space-size=64', '--max-semi-space-size=64'];
if (typeof globalThis.gc !== 'function') {
  const run = spawnSync(process.execPath, [...NODE_FLAGS, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const JSON_OUT = process.argv.includes('--json');
const ROOT = new URL('../', import.meta.url);
const DIST = arg('dist', 'dist');
// The chart listens for pointer events only where a window exists; the unit
// tests stand one in the same way.
globalThis.window ??= {};
const COMPARE = arg('compare', null);

// ── fixtures ────────────────────────────────────────────────────────────────

/** Deterministic OHLCV, so a number is comparable between runs and machines. */
function makeBars(count) {
  let s = 20260926 >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296);
  const out = new Array(count);
  let price = 1000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = Math.max(1, open + (rnd() - 0.5) * 8);
    out[i] = {
      time: 1_600_000_000 + i * 60,
      open,
      high: Math.max(open, close) + rnd() * 3,
      low: Math.min(open, close) - rnd() * 3,
      close,
      volume: Math.floor(1000 + rnd() * 9000),
    };
    price = close;
  }
  return out;
}

const DRAW_OPS = new Set(['fillRect', 'strokeRect', 'fill', 'stroke', 'fillText', 'strokeText', 'drawImage']);

/**
 * A 2D context that draws nothing and counts the calls that put ink down. A
 * plain object rather than a Proxy: a Proxy allocates on every property read
 * and would drown the allocation measurement in its own garbage.
 */
function countingCtx(counter, width, height) {
  const noop = () => {};
  const ctx = {
    canvas: { width, height },
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif', globalAlpha: 1,
    textAlign: 'left', textBaseline: 'alphabetic', lineJoin: 'miter', lineCap: 'butt', lineDashOffset: 0,
    shadowBlur: 0, shadowColor: 'transparent', globalCompositeOperation: 'source-over', imageSmoothingEnabled: true,
    miterLimit: 10, direction: 'ltr', filter: 'none',
    measureText: (t) => ({ width: String(t).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    getLineDash: () => [],
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    isPointInStroke: () => false,
  };
  for (const name of ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'rect', 'roundRect',
    'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'clip', 'translate', 'scale', 'rotate', 'setTransform', 'resetTransform',
    'transform', 'setLineDash', 'clearRect', 'putImageData']) ctx[name] = noop;
  for (const name of DRAW_OPS) ctx[name] = () => { counter.calls++; };
  return ctx;
}

/** Enough DOM for a chart to build, lay out and take pointer events. */
function fakeDocument(counter) {
  const make = (tag) => {
    const listeners = new Map();
    const el = {
      tagName: String(tag).toUpperCase(),
      style: {},
      children: [],
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { this.children.push(c); return c; },
      removeChild() {},
      remove() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }),
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
      dispatch(type, event) { for (const fn of listeners.get(type) ?? []) fn(event); },
      setPointerCapture() {}, releasePointerCapture() {},
      setAttribute() {}, getAttribute: () => null, hasAttribute: () => false, removeAttribute() {},
      focus() {}, blur() {},
    };
    if (tag === 'canvas') {
      el.width = 0;
      el.height = 0;
      let ctx = null;
      el.getContext = () => (ctx ??= countingCtx(counter, el.width, el.height));
    }
    return el;
  };
  return { createElement: make };
}

async function loadBuild(dir) {
  const base = await import(new URL(`${dir}/openalgo-charts.mjs`, ROOT).href);
  const draw = await import(new URL(`${dir}/openalgo-charts.draw.mjs`, ROOT).href);
  return { base, draw };
}

/** A chart on the fake DOM with a frame loop the bench drives by hand. */
function makeChart(build, options = {}) {
  const counter = { calls: 0 };
  const doc = fakeDocument(counter);
  const pending = new Map();
  let next = 1;
  const container = doc.createElement('div');
  const chart = new build.base.Chart(container, {
    document: doc,
    pixelRatio: () => 1,
    shortcuts: false,
    raf: {
      schedule: (cb) => { const h = next++; pending.set(h, cb); return h; },
      cancel: (h) => { pending.delete(h); },
    },
    ...options,
  });
  chart.applySize(1000, 600);
  const flush = () => {
    let frames = 0;
    for (let guard = 0; guard < 8 && pending.size > 0; guard++) {
      const batch = [...pending.values()];
      pending.clear();
      for (const cb of batch) cb();
      frames += batch.length;
    }
    return frames;
  };
  return { chart, counter, flush, container };
}

// ── A. level of detail ──────────────────────────────────────────────────────

function levelOfDetail(build, bars, options) {
  const { chart, counter, flush } = makeChart(build, { timeScale: { minBarSpacing: 0.0005 }, ...options });
  chart.addSeries('candlestick').setData(bars);
  chart.addSeries('histogram', { paneIndex: 1 }).setData(
    bars.map((b) => ({ time: b.time, open: 0, high: b.volume, low: 0, close: b.volume })),
  );
  chart.fitContent();
  flush();
  // Three frames, keep the last: the first one measures scales, and a frame
  // after that is what a user holding the view sees.
  let calls = 0;
  let ms = 0;
  for (let i = 0; i < 3; i++) {
    counter.calls = 0;
    chart.invalidate((m) => m.invalidateGlobal(3));
    const t0 = performance.now();
    flush();
    ms = performance.now() - t0;
    calls = counter.calls;
  }
  const plotWidth = chart.timeScale.width;
  const spacing = chart.timeScale.barSpacing;
  chart.destroy();
  return { bars: bars.length, plotWidth, barSpacing: +spacing.toFixed(5), calls, ms: +ms.toFixed(2) };
}

// ── B. allocation while panning ─────────────────────────────────────────────

const heapUsed = () => v8.getHeapStatistics().used_heap_size;

/**
 * Run `fn` and report the collections that ran inside it. The profiler is
 * read synchronously; a PerformanceObserver would only hear of them after the
 * loop had finished.
 */
function collections(fn) {
  const profiler = new v8.GCProfiler();
  profiler.start();
  fn();
  return profiler.stop().statistics.length;
}

/** Bytes allocated by `fn`, measured with no collection inside it, or null when one ran. */
function allocated(fn) {
  globalThis.gc();
  let bytes = 0;
  const ran = collections(() => {
    const before = heapUsed();
    fn();
    bytes = heapUsed() - before;
  });
  return ran === 0 ? bytes : null;
}

/**
 * Pan 50,000 bars at one zoom. `fixed` holds both price scales still, which
 * takes autoscale out of the frame: what is left per bar is the series pass
 * and the renderers.
 */
function panAllocation(build, bars, spacing, frames, fixed) {
  const { chart, flush } = makeChart(build);
  chart.addSeries('candlestick').setData(bars);
  chart.addSeries('histogram', { paneIndex: 1 }).setData(
    bars.map((b) => ({ time: b.time, open: 0, high: b.volume, low: 0, close: b.volume })),
  );
  chart.timeScale.setBarSpacing(spacing);
  chart.timeScale.setRightOffset(-20_000);
  flush();
  if (fixed) {
    const [price, volume] = chart.panes();
    price.priceScale.setPriceRange({ min: 800, max: 1200 });
    price.priceScale.setAutoScale(false);
    volume.priceScale.setPriceRange({ min: 0, max: 12_000 });
    volume.priceScale.setAutoScale(false);
  }
  const step = () => {
    chart.timeScale.setRightOffset(chart.timeScale.rightOffset - 3);
    flush();
  };
  // Warm the frame up first so the measured loop runs optimised code, not the
  // compiler's own allocations.
  for (let i = 0; i < 400; i++) step();
  const visible = Math.round(chart.timeScale.width / chart.timeScale.barSpacing);
  // In chunks small enough to fit the young generation, each after a full
  // collection, so no scavenge can hide what a chunk allocated.
  const CHUNK = 20;
  let bytes = 0;
  for (let done = 0; done < frames && bytes !== null; done += CHUNK) {
    const chunk = allocated(() => { for (let i = 0; i < CHUNK; i++) step(); });
    bytes = chunk === null ? null : bytes + chunk;
  }
  // A long pan with the collector left alone: how often the young generation fills.
  globalThis.gc();
  const scavenges = collections(() => { for (let i = 0; i < frames * 10; i++) step(); });
  chart.destroy();
  return { fixed, spacing, visible, bytesPerFrame: bytes === null ? null : Math.round(bytes / frames), scavenges, frames: frames * 10 };
}

// ── C. hit testing ──────────────────────────────────────────────────────────

/**
 * A host primitive standing for one drawing: a short segment it paints and
 * answers for, with the box outside which it can never answer. The box is
 * refreshed when it paints, which is when it knows where it is.
 */
function segmentPrimitive(tally, t0, p0, t1, p1) {
  let box = null;
  const project = (rc) => {
    const x0 = rc.timeScale.indexToX(rc.dataLayer.timeToIndexFloat(t0));
    const x1 = rc.timeScale.indexToX(rc.dataLayer.timeToIndexFloat(t1));
    return { x0, y0: rc.priceScale.priceToY(p0), x1, y1: rc.priceScale.priceToY(p1) };
  };
  const GRAB = 6;
  return {
    zOrder: () => 'top',
    draw(ctx, rc) {
      const s = project(rc);
      ctx.beginPath(); ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1); ctx.stroke();
    },
    hitBounds(rc) {
      const s = project(rc);
      box = { left: Math.min(s.x0, s.x1) - GRAB, top: Math.min(s.y0, s.y1) - GRAB,
        right: Math.max(s.x0, s.x1) + GRAB, bottom: Math.max(s.y0, s.y1) + GRAB };
      return box;
    },
    hitTest(x, y, rc) {
      tally.tests++;
      const s = project(rc);
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len = dx * dx + dy * dy;
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.x0) * dx + (y - s.y0) * dy) / len));
      const d = Math.hypot(x - (s.x0 + t * dx), y - (s.y0 + t * dy));
      return d <= GRAB ? { externalId: `seg:${t0}:${p0}`, zOrder: 'top', distance: d } : null;
    },
  };
}

function scatter(bars, count, fn) {
  let s = 7;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296);
  const first = bars.length - 150;
  for (let i = 0; i < count; i++) {
    const a = bars[first + Math.floor(rnd() * 140)];
    const b = bars[Math.min(bars.length - 1, first + Math.floor(rnd() * 140) + 3)];
    fn(a.time, a.low + (a.high - a.low) * rnd(), b.time, b.low + (b.high - b.low) * rnd());
  }
}

function hoverCost(build, bars, kind, count) {
  const { chart, flush, container } = makeChart(build);
  chart.addSeries('candlestick').setData(bars);
  const tally = { tests: 0 };
  if (kind === 'primitives') {
    scatter(bars, count, (t0, p0, t1, p1) => chart.addPrimitive(segmentPrimitive(tally, t0, p0, t1, p1), 0));
  } else {
    const draw = new build.draw.DrawingController(chart);
    scatter(bars, count, (t0, p0, t1, p1) => draw.add({ tool: 'trend-line', paneIndex: 0, style: {}, points: [{ time: t0, price: p0 }, { time: t1, price: p1 }] }));
  }
  flush();
  const moves = [];
  for (let i = 0; i < 400; i++) moves.push({ clientX: 40 + ((i * 37) % 860), clientY: 30 + ((i * 53) % 380) });
  const move = (m) => {
    container.dispatch('pointermove', { ...m, pointerId: 1, pointerType: 'mouse', buttons: 0, button: 0, preventDefault() {}, stopPropagation() {} });
    flush();
  };
  for (const m of moves) move(m); // warm up
  tally.tests = 0;
  const t0 = performance.now();
  for (let r = 0; r < 5; r++) for (const m of moves) move(m);
  const us = ((performance.now() - t0) * 1000) / (moves.length * 5);
  const testsPerMove = tally.tests / (moves.length * 5);
  // The hit test alone, without the overlay repaint every move also asks
  // for: the part a prefilter can change. Through the chart's own internals,
  // as the drawing-catalog e2e spec reaches them.
  const pane = chart._panes[0];
  const rc = chart._renderContext(0);
  const hitOnce = () => { for (const m of moves) pane.hitTestPrimitives(m.clientX, m.clientY, rc); };
  hitOnce();
  const t1 = performance.now();
  for (let r = 0; r < 5; r++) hitOnce();
  const hitUs = ((performance.now() - t1) * 1000) / (moves.length * 5);
  chart.destroy();
  return {
    kind, count, usPerMove: +us.toFixed(1), usPerHitTest: +hitUs.toFixed(1),
    testsPerMove: kind === 'primitives' ? +testsPerMove.toFixed(1) : null,
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

async function measure(dir) {
  const build = await loadBuild(dir);
  const big = makeBars(200_000);
  const mid = makeBars(50_000);
  return {
    dist: dir,
    lod: [
      { conflate: 'default', ...levelOfDetail(build, big, {}) },
      { conflate: false, ...levelOfDetail(build, big, { conflate: false }) },
    ],
    pan: [panAllocation(build, mid, 6, 200, false), panAllocation(build, mid, 1.2, 200, false)],
    panFixed: [panAllocation(build, mid, 6, 200, true), panAllocation(build, mid, 1.2, 200, true)],
    hover: [hoverCost(build, mid, 'primitives', 500), hoverCost(build, mid, 'drawings', 500)],
  };
}

/** Per visible bar per frame: the slope between the two zooms. */
const slope = (pan) => {
  const [a, b] = pan;
  if (a.bytesPerFrame === null || b.bytesPerFrame === null || b.visible === a.visible) return null;
  return +((b.bytesPerFrame - a.bytesPerFrame) / (b.visible - a.visible)).toFixed(2);
};

// Budgets, for the build under test.
//  A: marks per frame at most four per device-pixel column of the plot (a
//     candle is at most a wick and a body, its volume two columns), plus a
//     fixed allowance for the grid, axes and labels. Every bar drawn is
//     400,000 marks.
//  B: bytes per visible bar per frame. With the price scales held still the
//     frame is the series pass and the renderers; autoscaled, it is that plus
//     the autoscale walk. What is left per bar is outside the pane: numbers
//     the price scale returns boxed, and each series type's `extents` object
//     (210 to 290 and about 430 bytes when this was written, on a loaded
//     machine, against 840 to 890 and 1,090 to 1,170 for the pass that built
//     two objects per bar per series). The budgets sit under half the old
//     figures; tests/pane-draw-items.test.ts pins the reuse itself.
//  C: a hover move asks fewer than ten of the 500 bounded primitives.
const LOD_PER_COLUMN = 4;
const LOD_CHROME = 600;
const BYTES_PER_BAR_FIXED = 400;
const BYTES_PER_BAR = 600;
const TESTS_PER_MOVE = 10;

const results = [await measure(DIST)];
if (COMPARE !== null) results.push(await measure(COMPARE));

const failures = [];
{
  const r = results[0];
  const lod = r.lod[0];
  const limit = LOD_PER_COLUMN * lod.plotWidth + LOD_CHROME;
  if (lod.calls > limit) failures.push(`A: ${lod.calls} marks for ${lod.bars} bars exceeds ${limit} (plot ${lod.plotWidth} px)`);
  for (const [label, pan, budget] of [['fixed scales', r.panFixed, BYTES_PER_BAR_FIXED], ['autoscaled', r.pan, BYTES_PER_BAR]]) {
    const perBar = slope(pan);
    if (perBar === null) failures.push(`B (${label}): a collection ran inside every measured loop; allocation unknown`);
    else if (perBar > budget) failures.push(`B (${label}): ${perBar} bytes per visible bar per frame exceeds ${budget}`);
  }
  const hover = r.hover[0];
  if (hover.testsPerMove >= TESTS_PER_MOVE) failures.push(`C: ${hover.testsPerMove} hit tests per move exceeds ${TESTS_PER_MOVE}`);
}

if (JSON_OUT) {
  console.log(JSON.stringify(results.map((r) => ({
    ...r, bytesPerVisibleBar: slope(r.pan), bytesPerVisibleBarFixed: slope(r.panFixed),
  })), null, 2));
} else {
  for (const r of results) {
    console.log(`\n== ${r.dist}`);
    console.log('\nA. level of detail, one full frame, candles plus volume\n');
    console.log('   conflate |    bars | spacing px | plot px |  marks | ms');
    for (const l of r.lod) {
      console.log(`   ${String(l.conflate).padEnd(8)} | ${String(l.bars).padStart(7)} | ${String(l.barSpacing).padStart(10)} | ${String(l.plotWidth).padStart(7)} | ${String(l.calls).padStart(6)} | ${l.ms}`);
    }
    console.log('\nB. allocation while panning 50,000 bars\n');
    console.log('   scales     | spacing | visible | bytes/frame | scavenges in frames');
    for (const p of [...r.panFixed, ...r.pan]) {
      console.log(`   ${(p.fixed ? 'fixed' : 'autoscaled').padEnd(10)} | ${String(p.spacing).padStart(7)} | ${String(p.visible).padStart(7)} | ${String(p.bytesPerFrame ?? 'n/a').padStart(11)} | ${p.scavenges} in ${p.frames}`);
    }
    console.log(`   bytes per visible bar per frame: ${slope(r.panFixed) ?? 'n/a'} with fixed scales, ${slope(r.pan) ?? 'n/a'} autoscaled`);
    console.log('\nC. hover move with 500 drawings\n');
    console.log('   scene      | us/move | us/hit test | hit tests/move');
    for (const h of r.hover) {
      console.log(`   ${h.kind.padEnd(10)} | ${String(h.usPerMove).padStart(7)} | ${String(h.usPerHitTest).padStart(11)} | ${h.testsPerMove ?? 'n/a'}`);
    }
  }
}

if (failures.length) {
  console.error('\nBUDGET EXCEEDED');
  for (const f of failures) console.error('  ' + f);
  process.exitCode = 1;
}
