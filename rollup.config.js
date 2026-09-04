import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import dts from 'rollup-plugin-dts';

// One entry point per loadable tier (see ARCHITECTURE.md §2).
const entries = {
  index: 'src/index.ts',
  trade: 'src/trade/index.ts',
  transform: 'src/transform/index.ts',
  profile: 'src/profile/index.ts',
  indicators: 'src/indicators/index.ts',
  draw: 'src/draw/index.ts',
  webgl: 'src/webgl/index.ts',
};

const outFile = {
  index: 'openalgo-charts',
  trade: 'openalgo-charts.trade',
  transform: 'openalgo-charts.transform',
  profile: 'openalgo-charts.profile',
  indicators: 'openalgo-charts.indicators',
  draw: 'openalgo-charts.draw',
  webgl: 'openalgo-charts.webgl',
};

const typesFile = {
  index: 'index',
  trade: 'trade/index',
  transform: 'transform/index',
  profile: 'profile/index',
  indicators: 'indicators/index',
  draw: 'draw/index',
  webgl: 'webgl/index',
};

/**
 * Every tier is its own bundle, so anything it deep-imports from the base is
 * *inlined* — a second, private copy. That is only a size cost for pure
 * functions, but for the registries (chart types, indicators) it is a
 * correctness bug: a tier would register into a Map that `createChart` never
 * reads. Tiers therefore import shared runtime state from `../index`, which is
 * external for tier builds and emitted as a plain `openalgo-charts` import.
 */
const PKG = 'openalgo-charts';
const tierExternal = (id) => id === PKG;

/**
 * Resolve the package's own name to the base entry. Used only by the bundles
 * that must inline the base (the IIFE and the combined docs bundle); tier
 * bundles leave it external so the import survives into the output.
 */
const aliasSelf = {
  name: 'alias-self-reference',
  resolveId(id) {
    return id === PKG ? { id: new URL('src/index.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') } : null;
  },
};

const js = Object.entries(entries).map(([key, input]) => ({
  input,
  external: key === 'index' ? undefined : tierExternal,
  output: {
    file: `dist/${outFile[key]}.mjs`,
    format: 'es',
    sourcemap: true,
    // Emit the shared import as a path relative to the tier bundle rather than
    // the bare package name, so `<script type="module">` loading /dist/*.mjs
    // straight from a server works with no import map. Bundlers and Node
    // resolve the relative path just as happily. (The .d.ts builds keep the
    // bare specifier, which TypeScript resolves through package.json exports.)
    paths: { [PKG]: `./${outFile.index}.mjs` },
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.build.json' }),
    terser({ format: { comments: false } }),
  ],
}));

// Standalone IIFE for plain <script> / CDN drop-in (base bundle → window.OpenAlgoCharts).
const iife = {
  input: entries.index,
  output: {
    file: 'dist/openalgo-charts.standalone.js',
    format: 'iife',
    name: 'OpenAlgoCharts',
    sourcemap: true,
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.build.json' }),
    terser({ format: { comments: false } }),
  ],
};

// Combined bundle (base + every tier in one module instance) — docs live demos
// only. Nothing is external here, so the tiers resolve `../index` to the real
// base module and share one registry. No .d.ts (not a published entry point).
const allBundle = {
  input: 'src/all.ts',
  output: {
    file: 'dist/openalgo-charts.all.mjs',
    format: 'es',
    sourcemap: true,
  },
  plugins: [
    aliasSelf,
    typescript({ tsconfig: './tsconfig.build.json' }),
    terser({ format: { comments: false } }),
  ],
};

const types = Object.entries(entries).map(([key, input]) => ({
  input,
  external: key === 'index' ? undefined : tierExternal,
  output: { file: `dist/${typesFile[key]}.d.ts`, format: 'es' },
  plugins: [dts()],
}));

export default [...js, iife, allBundle, ...types];
