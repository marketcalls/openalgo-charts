// @ts-check
/**
 * Lint config. Two jobs, and the second is the one that earns its keep.
 *
 * 1. Ordinary correctness rules over TypeScript.
 * 2. The TIER ACL. This package's whole shape is seven lazily-loaded ESM bundles
 *    with enforced Brotli budgets, which only works while the base tier never
 *    reaches into a lazy one. ARCHITECTURE.md says so in prose; prose does not
 *    fail CI, and a single stray import is enough to pull a 27 KB tier into the
 *    61 KB base without anything going red. `npm run size` catches it only if
 *    the result happens to cross a budget line.
 *
 * The ACL is written against what the tree actually does today, with each
 * existing crossing named and justified rather than waved through, so a NEW
 * crossing fails and an old one stays visible.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Lazy tiers: each is its own bundle and its own size budget. */
const LAZY_TIERS = ['indicators', 'draw', 'transform', 'profile', 'trade', 'webgl'];

/**
 * Base-tier directories. Everything here lands in `openalgo-charts.mjs`, so an
 * import from one of these into a lazy tier is a size regression by definition.
 */
const BASE_DIRS = [
  'core', 'render', 'scale', 'model', 'primitives',
  'input', 'feed', 'replay', 'compare', 'link', 'helpers',
];

const crossTier = (tiers, why) => ({
  patterns: tiers.map((t) => ({
    group: [`**/${t}/**`, `../${t}/*`, `../../${t}/*`, `./${t}/*`],
    message: why,
  })),
});

export default tseslint.config(
  { ignores: ['dist/**', 'dist-baseline/**', 'node_modules/**', 'website/**', 'examples/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    rules: {
      // TypeScript resolves identifiers itself, including every DOM and ES
      // global, and reports an unknown one as a compile error. Leaving
      // `no-undef` on just means re-declaring lib.dom in an eslint globals
      // block and getting 81 false positives until it is complete.
      'no-undef': 'off',
      // The codebase leans on `unknown` at its public edges and narrows
      // deliberately; an explicit `any` is the thing worth flagging.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },

  // ── the tier ACL ────────────────────────────────────────────────────────────
  {
    files: BASE_DIRS.map((d) => `src/${d}/**/*.ts`),
    rules: {
      'no-restricted-imports': [
        'error',
        crossTier(
          LAZY_TIERS,
          'Base tier must not import a lazy tier: it pulls that whole bundle into openalgo-charts.mjs. ' +
            'Invert the dependency (register into a base registry from the tier) instead.',
        ),
      ],
    },
  },

  // `openalgo-trade.ts` is the OpenAlgo broker adapter. It is types-plus-one-
  // validator against the trade tier, and it lives in `feed/` because that is
  // where the OpenAlgo transports live. Named rather than silently allowed: if
  // this grows past `validateQuantity`, the adapter belongs in `trade/`.
  {
    files: ['src/feed/openalgo-trade.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Note on `src/index.ts`: the base entry re-exports four standalone
  // calculators (ema, rsi, atr, supertrend). They are plain functions over
  // `Bar[]` with no registry, no descriptor and no tier imports, which is what
  // makes them safe to ship in base; the indicator TIER is
  // `indicators/index.ts` and stays out. The ACL above targets `src/<dir>/**`,
  // so the entry point is outside it by construction and needs no exemption.

  // Node scripts (.cjs / .mjs). `no-undef` is off for the same reason as in TS:
  // enumerating the Node globals here just to satisfy it buys nothing, and
  // these files are never shipped.
  {
    files: ['**/*.cjs', '**/*.mjs', '*.config.js'],
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },

  // Tests and scripts are not shipped; they may reach anywhere and may log.
  {
    files: ['tests/**/*.ts', 'tests/**/*.cjs', 'scripts/**/*.mjs', '*.config.ts', '*.config.js'],
    rules: {
      'no-console': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // The fake DOM/canvas helpers stand in for browser APIs whose real
      // signatures are `Function`-shaped listener bags. Naming each one buys
      // nothing in a test double.
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
);
