import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import dts from 'rollup-plugin-dts';

// One entry point per loadable tier (see ARCHITECTURE.md section 2). The widget
// is the eighth: the only tier that ships DOM, and the only one that builds on
// other tiers rather than on the base alone.
const entries = {
  index: 'src/index.ts',
  trade: 'src/trade/index.ts',
  transform: 'src/transform/index.ts',
  profile: 'src/profile/index.ts',
  indicators: 'src/indicators/index.ts',
  draw: 'src/draw/index.ts',
  webgl: 'src/webgl/index.ts',
  widget: 'src/widget/index.ts',
};

const outFile = {
  index: 'openalgo-charts',
  trade: 'openalgo-charts.trade',
  transform: 'openalgo-charts.transform',
  profile: 'openalgo-charts.profile',
  indicators: 'openalgo-charts.indicators',
  draw: 'openalgo-charts.draw',
  webgl: 'openalgo-charts.webgl',
  widget: 'openalgo-charts.widget',
};

const typesFile = {
  index: 'index',
  trade: 'trade/index',
  transform: 'transform/index',
  profile: 'profile/index',
  indicators: 'indicators/index',
  draw: 'draw/index',
  webgl: 'webgl/index',
  widget: 'widget/index',
};

/**
 * Every tier is its own bundle, so anything it deep-imports from the base is
 * inlined: a second, private copy. That is only a size cost for pure
 * functions, but for the registries (chart types, indicators) it is a
 * correctness bug: a tier would register into a Map that `createChart` never
 * reads. Tiers therefore import shared runtime state from `openalgo-charts`,
 * which is external for tier builds and emitted as a plain import.
 *
 * The same rule holds one level up. The widget builds on the draw tier (the
 * controller, the icon sprite, the tool registry), so `openalgo-charts/draw`
 * and every other tier specifier are external too. A widget that inlined the
 * draw tier would carry a second `DrawingController` class and a second tool
 * table, and `instanceof` would stop agreeing across them; `check-dts.mjs`
 * fails the build if a tier's declarations inline one of those classes.
 */
const PKG = 'openalgo-charts';
const specifierOf = (key) => (key === 'index' ? PKG : `${PKG}/${key}`);
const tierExternal = (id) => id === PKG || id.startsWith(`${PKG}/`);

/**
 * Emit each shared import as a path relative to the tier bundle rather than
 * the bare specifier, so `<script type="module">` loading /dist/*.mjs straight
 * from a server works with no import map. Bundlers and Node resolve the
 * relative path just as happily. (The .d.ts builds keep the bare specifier,
 * which TypeScript resolves through package.json exports.)
 */
const tierPaths = Object.fromEntries(
  Object.keys(entries).map((key) => [specifierOf(key), `./${outFile[key]}.mjs`]),
);

const abs = (rel) => new URL(rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/**
 * Resolve the package's own specifiers to their source entries. Used only by
 * the bundles that must inline everything (the IIFE and the combined docs
 * bundle); tier bundles leave them external so the import survives into the
 * output.
 */
const aliasSelf = {
  name: 'alias-self-reference',
  resolveId(id) {
    const key = Object.keys(entries).find((k) => specifierOf(k) === id);
    return key ? { id: abs(entries[key]) } : null;
  },
};

const js = Object.entries(entries).map(([key, input]) => ({
  input,
  external: key === 'index' ? undefined : tierExternal,
  output: {
    file: `dist/${outFile[key]}.mjs`,
    format: 'es',
    sourcemap: true,
    paths: tierPaths,
  },
  plugins: [
    typescript({ tsconfig: './tsconfig.build.json' }),
    terser({ format: { comments: false } }),
  ],
}));

// Standalone IIFE for plain <script> / CDN drop-in (base bundle, window.OpenAlgoCharts).
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

// Combined bundle (base + every tier in one module instance), docs live demos
// only. Nothing is external here, so the tiers resolve the package specifiers
// to the real source modules and share one registry. No .d.ts (not a published
// entry point).
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
