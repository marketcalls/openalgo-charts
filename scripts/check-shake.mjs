/**
 * Tree-shake guard.
 *
 * The `.size-limit.json` entries measure whole BUNDLE FILES, which is the right
 * guard on total exported surface but says nothing about what a consumer ships.
 * The base bundle carries the OpenAlgo adapters, so hardening the WebSocket or
 * the order decoder grows that file even though a charting-only host never
 * imports them.
 *
 * This measures the number that matters to such a host: bundle an entry that
 * imports only `createChart`, let rollup shake, and brotli the result. It also
 * asserts the adapters are genuinely gone rather than merely small, because a
 * stray side effect would keep them and the byte count alone would not say why.
 *
 * Rollup is already a direct devDependency, so this adds nothing to the tree.
 */
import { rollup } from 'rollup';
import { brotliCompressSync } from 'node:zlib';

const BUNDLE = new URL('../dist/openalgo-charts.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// Raised from 38 to 39 kB in 1.8.6, for the per-series axis value tags: the
// collection pass in the pane, the tag renderer, and the resolve that keeps two
// of them off each other. Measured cost 0.31 kB brotli against a 37.89 kB
// baseline. Raise this only with the same kind of note, and never to get a
// build green: the point of the number is that a feature has to be worth its
// bytes to a host that only wanted a chart.
//
// Raised from 39 to 40 kB for 2.0. The wheel zoom glide (398e813) took the
// chart-only import to 39.05 kB on its own, measured by building without the
// 2.0 change; the three modifier flags the click payload now carries for
// additive drawing selection land inside the same 39.05 kB reading. Both are
// core input behaviour a host that only wanted a chart still gets.
//
// Raised from 40 to 44 kB for the vector export (2.0). chart.exportSVG runs
// the ordinary paint into a serialising context (src/render/svg-export.ts),
// and because the call is synchronous and returns a string, the serialiser
// ships with the chart rather than behind a lazy import. Measured cost 3.75 kB
// brotli: 39.34 kB before, 43.09 kB after, on the same build.
// Navigation preferences and reset controls in 2.1.3 also belong to chart-only hosts.
// Proportional wheel routing and eased price projections are part of the core chart.
// Default vector branding and the opt-in chart watermark are available to raw
// chart hosts too. The chart-only build measures 48.96 KiB versus 45.51 KiB on
// 2.1.8, including guarded link gestures and screenshot handling for hidden panes.
// Selected candle readouts survive recalculation and history prepends, and linked
// markers update the follower's OHLC and study legends without pointer echoes.
// The measured chart-only cost is 0.21 KiB: 49.92 KiB at 2f6b54c to 50.13 KiB.
// Keep one readout timestamp shared by native and linked hover. These corrections
// belong to core chart hosts; allow 50.25 KiB while retaining every tier budget.
// Primary source reads and the history/live update event serve headless hosts.
// Their measured chart-only cost is 0.04 KiB (50.25 to 50.29); the optional
// alert controller must still disappear, checked by MUST_BE_SHAKEN below.
// Alert documents also round-trip on charts without a controller. Atomic input
// validation, JSON-safe payloads and stable study identities add 1.56 KiB:
// 50.26 to 51.82 KiB. The controller, registry, UI and drawing tier stay optional.
// Independent named overlays belong to chart-only hosts, including multiple
// price units in one pane. Measured 51.89 to 51.96 KiB (0.07 KiB); allow 52.10.
// Common-start comparison and replay alignment remain optional and must shake.
// Whole-reading legend fitting and plot-bounded actions serve raw chart hosts.
// Measured 51.96 to 52.32 KiB (0.36 KiB); optional tiers still must shake below.
// The legend row belongs to every chart host: a source button a descriptor can
// ask for, a button size the row stacks against, and readings that skip a plot
// drawn in a fully transparent colour. Measured 52.35 to 52.66 KiB (0.31 KiB);
// The reviewed 2.4.6 renderer also resolves each marker's live series scale,
// rebinds replaced anchors and rejects NaN gaps and invisible legend readings.
// Final measurement is 52.75 KiB, 0.41 KiB above the 2.4.5 release's 52.34.
// Allow 53 KiB while every optional tier still shakes out below.
// Primitive start/cancel notifications and pane-local gesture coordinates in
// 2.4.7 raise the chart-only build to 53.00 KiB. Alert evaluation and visuals
// still shake out; allow 53.25 KiB for the core gesture lifecycle.
// Automatic table measurement and clipping remain available to a chart-only host.
// 2.5.0 measures 53.36 KiB; optional tiers and the alert controller must still shake out.
// Grouped event markers and appearance notifications serve headless chart hosts.
// 2.5.2 measures 54.67 KiB; drawing calculations and the details popup stay optional.
// Identity-preserving study movement, renderer stacking and crosshair readout
// events in 2.5.3 also serve raw chart hosts. Against 253ae71, the chart-only
// build grows from 54.67 to 55.58 KiB (929 bytes Brotli); allow 55.75 KiB.
// Drawing groups, widget controls and the optional controllers still shake out.
// Known-interval indicator confirmation now shares the interval registry and
// calendar boundary logic. This prevents session gaps becoming bar durations
// and confirms calendar bars in their configured zone. The unchanged a1828e9
// base bundle measures 55.58 KiB, versus 56.09 KiB with this fix (0.51 KiB).
// These semantics also govern compiled studies on raw charts; allow 56.25 KiB.
// Named table ownership, computed fill descriptors and complete scale snapshots
// serve native chart hosts. Measured 56.15 to 57.13 KiB (0.98 KiB); allow 57.25.
// The new numerical helpers remain in the optional indicator tier.
// Direct navigation notifications and renderer changes retain live host state.
// They add 0.42 KiB, from 57.13 to 57.55 KiB, including type lookup and formatter
// restoration. The ceiling is 57.75 KiB; optional calculation
// helpers remain outside the chart-only import.
// Runtime series-to-scale assignment and price-anchored per-bar gradients add
// 0.29 KiB, from 57.55 to 57.84 KiB. Both serve native chart hosts; allow 58 KiB.
// Variable-window calculations remain in the optional indicator tier.
// Provider confirmation, source revision tracking and left-axis value labels
// serve raw chart hosts. Together with native table formatting, this batch
// moves the base from 98.28 to 100.10 kB and chart-only from 57.84 to 59.62 KiB.
// Allow 59.75 KiB while retaining the optional-tier removal checks below.
// Whole-study scale transactions, primitive projection and owned range defaults
// keep native studies coherent across axes and manual views. They add 2.09 KiB
// to chart-only imports (59.62 to 61.71), and 2.10 kB to the base bundle
// (100.10 to 102.20). Allow 61.75 KiB; requested-context calculations remain
// in the optional indicator tier and all removal checks below still apply.
// Composed request cancellation, native snapshot hooks and source observation
// add 0.67 KiB to chart-only imports (61.71 to 62.38). These let raw chart hosts
// supply explicit availability without adding transport. Allow 62.50 KiB;
// managed requested calculations stay in the optional indicator tier.
// Explicit study alerts share source confirmation and calculation ownership.
// Their live-update, close and lifetime checkpoints serve raw chart hosts,
// adding 1.05 KiB to chart-only imports (62.47 to 63.52) and 1.14 kB to the
// base bundle (102.94 to 104.08). Allow 63.75 KiB while notification controls,
// feed adapters and optional tiers must still disappear below.
// Dependency ordering, committed source snapshots and restore preflight serve
// native hosts as well as the widget. They add 2.61 KiB to chart-only imports
// (63.52 to 66.13) and 2.79 kB to the base bundle (104.08 to 106.87).
// Allow 66.25 KiB; source selectors and template copying stay in optional tiers.
// Independent visible columns require placement, geometry, input routing and
// snapshot parsing in raw charts. The measured implementation adds 1.18
// KiB (66.13 to 67.31); allow 67.5 KiB. Host menus stay in the optional widget.
// Native per-plot assignment, validation and callback-safe transactions add
// 0.68 KiB (67.31 to 67.99). Allow 68.25 KiB; workspace persistence stays optional.
// Scoped restore formatting and occupied-pane preservation add 0.38 KiB
// (67.99 to 68.37). Allow 68.5 KiB; template planning remains in the workspace tier.
// Primary-price fitting and the persistent study-count control also serve raw
// chart hosts. Their range selection, row geometry, state and consumed-gesture
// handling add 1.22 KiB (68.37 to 69.59), with base growing 109.13 to 110.47 kB.
// Allow 69.75 KiB. Settings forms and workspace parsing remain optional below.
// Typed scalar validation, paired exchange defaults and targeted capture
// lifecycle fences add 1.12 KiB (69.59 to 70.71). Base grows by 1025 bytes;
// symbol search, editor validation and modal controls remain in the widget.
// Native tables now measure cell hover targets and wrap their canvas details.
// Smooth study paths add cubic geometry and local clipping, shared by SVG.
// These remain available to raw-chart hosts without loading optional tiers.
// The final measurement is 71.78 KiB, up 1.07 KiB from the typed-input batch.
// Independent user navigation and native annotation text styles remain in base.
// Their measured chart-only build is 73.26 KiB; optional host tiers still disappear.
// Pane collapse is core layout: the strip geometry, divider pairing across a
// strip, axis and pointer routing that report no price on it, navigator
// re-homing and the saved flag. Measured alone 73.35 to 73.74 KiB (0.39 KiB),
// with the base bundle 116.15 to 116.72 kB; the menu rows stay in the widget.
// Study drawing and marker targets route outputs inside the indicator runtime,
// which every chart carries. Measuring price-pane shapes on the candles' own
// scale and restacking routed layers created late complete it: measured alone
// 73.35 to 73.92 KiB (0.57 KiB).
// Drawing policies, go-to-date and the chart grid each add under 0.05 KiB here
// when measured alone; their controllers, panels and grid chrome stay in the
// optional tiers. The merged 2.5.4 build measures 74.43 KiB (76220 bytes);
// allow 74.44 KiB.
// The price pane is an identity rather than slot 0, so a chart that opts in
// (movablePrimaryPane) can move it below its studies: the defaults that name
// it, the restore slot and its validation, the option's pin on every move, the
// legend corner, the remove and collapse guards, the study, alert and
// comparison lookups, and the saved drawings kept in step with pane moves for
// a draw tier that loads later. Measured 74.43 to 74.97 KiB (76220 to 76771
// bytes, 0.54 KiB), with the base bundle 117.42 to 118.01 kB; the pane menus
// stay in the widget and template remapping in the workspace tier. Allow
// 74.98 KiB.
// A drag on `chart.trading` can now snap its order and bracket lines to the
// instrument's tick schedule: the controller's setter and the two rounded
// drag prices ship with every chart, since `chart.trading` does. The schedule
// class itself only rides in by type and is shaken out here. Measured 76220 to
// 76287 bytes (74.43 to 74.50 KiB). The setter's refusal of a band list and
// the hand-off that seeds a layer built after Instrument.applyTo take it to
// 76306 bytes (74.52 KiB); allow 74.52 KiB.
// Together in 2.5.5, the movable price pane, the tick-schedule drag rounding and
// the indicator gap recovery measure 75.07 KiB (76874 bytes); allow 75.08 KiB.
// Watchlists, news, account state and viewport drawings live in the optional
// tiers; the widget check below keeps the panels out of this import.
// Sharing one luminance calculation between the canvas helpers and the widget
// tokens took the import from 76874 to 76850 bytes (75.05 KiB); the budget
// follows it down to 75.05 KiB.
const LIMIT_BYTES = 75.05 * 1024;

// Absent from a chart-only build. Each is a string that appears in the adapter
// source and nowhere in the rendering core.
const MUST_BE_SHAKEN = [
  ['WebSocket adapter', 'authenticate'],
  ['order decoder', 'placeorder'],
  // The GPU backend lives in its own tier (src/render/webgl, shipped as
  // openalgo-charts.webgl.mjs) and nothing in the base entry imports it. The
  // string is the context-loss listener that only that backend installs.
  ['WebGL2 backend', 'webglcontextlost'],
  // The widget is the one tier that ships DOM (src/widget, shipped as
  // openalgo-charts.widget.mjs). The ESLint ACL forbids the base from importing
  // it; this is the check on the built output, so that a host which only
  // wanted a chart can never receive a toolbar. The string is the CSS scope
  // every widget rule is written under, and nothing in the engine paints HTML.
  ['widget tier', 'oac-widget'],
  ['trader alert controller', 'An alert controller already owns this chart'],
  ['bar condition registry', 'Bar condition id already registered'],
  ['comparison controller', 'a comparison needs a primary series to align against'],
  ['replay controller', 'replay needs a series to drive'],
  ['replay availability timeline', 'replay timing needs subBarEndTime'],
  ['replay group', 'openalgo-charts: replay group '],
  ['managed requested indicator', 'Requested indicator:'],
];

const virtual = {
  name: 'virtual-entry',
  resolveId: (id) => (id === '\0entry' ? id : null),
  load: (id) => (id === '\0entry' ? `export { createChart } from ${JSON.stringify(BUNDLE)};` : null),
};

const bundle = await rollup({ input: '\0entry', plugins: [virtual], logLevel: 'silent' });
const { output } = await bundle.generate({ format: 'es' });
await bundle.close();

const code = output.map((c) => (c.type === 'chunk' ? c.code : '')).join('');
const size = brotliCompressSync(Buffer.from(code)).length;

let failed = false;
for (const [what, needle] of MUST_BE_SHAKEN) {
  if (code.includes(needle)) {
    console.error(`FAIL: the ${what} survived a chart-only import (found ${JSON.stringify(needle)})`);
    failed = true;
  }
}

const kb = (n) => (n / 1024).toFixed(2) + ' KiB';
if (size > LIMIT_BYTES) {
  console.error(`FAIL: chart-only import is ${kb(size)} brotli, over the ${kb(LIMIT_BYTES)} budget`);
  failed = true;
}

console.log(`chart-only import (tree-shaken): ${kb(size)} brotli, budget ${kb(LIMIT_BYTES)}`);
if (failed) process.exit(1);
