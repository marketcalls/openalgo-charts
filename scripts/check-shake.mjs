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
const LIMIT_BYTES = 40 * 1024;

// Absent from a chart-only build. Each is a string that appears in the adapter
// source and nowhere in the rendering core.
const MUST_BE_SHAKEN = [
  ['WebSocket adapter', 'authenticate'],
  ['order decoder', 'placeorder'],
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

const kb = (n) => (n / 1024).toFixed(2) + ' kB';
if (size > LIMIT_BYTES) {
  console.error(`FAIL: chart-only import is ${kb(size)} brotli, over the ${kb(LIMIT_BYTES)} budget`);
  failed = true;
}

console.log(`chart-only import (tree-shaken): ${kb(size)} brotli, budget ${kb(LIMIT_BYTES)}`);
if (failed) process.exit(1);
