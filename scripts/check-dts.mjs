/**
 * Guard the tier type declarations against re-inlining shared types.
 *
 * Each tier is bundled into its own `.d.ts`. If a tier imports a shared type
 * through a *relative* path, the bundler inlines the declaration — and because
 * the core classes carry private members, TypeScript treats that copy as a
 * different type. The symptom is brutal and silent: a consumer doing
 *
 *   const chart = createChart(el);
 *   new DrawingController(chart);
 *
 * gets "Types have separate declarations of a private property '_container'",
 * with no way to fix it from outside the package. The tiers must import shared
 * types from the package entry, which tier builds leave external.
 *
 * Runs after `build` in `npm run verify`.
 */
import { readFileSync, existsSync } from 'node:fs';

/** Declarations that must never appear in a tier's bundle. */
const FORBIDDEN = [
  'declare class Chart',
  'declare class TimeScale',
  'declare class PriceScale',
  'declare class DataLayer',
];

const TIERS = [
  'dist/draw/index.d.ts',
  'dist/indicators/index.d.ts',
  'dist/trade/index.d.ts',
  'dist/transform/index.d.ts',
  'dist/profile/index.d.ts',
  'dist/webgl/index.d.ts',
];

let failed = false;

for (const file of TIERS) {
  if (!existsSync(file)) {
    console.error(`check-dts: ${file} is missing — did the build run?`);
    failed = true;
    continue;
  }
  const src = readFileSync(file, 'utf8');
  for (const decl of FORBIDDEN) {
    // Word-boundary the name so `declare class ChartSomething` is not a hit.
    const re = new RegExp(`${decl}\\b`);
    if (re.test(src)) {
      console.error(
        `check-dts: ${file} inlines "${decl}".\n` +
        '  A tier must import shared types from the package entry:\n' +
        "    import type { IPrimitive } from 'openalgo-charts';\n" +
        '  A relative import gets bundled in as a second declaration, and the\n' +
        '  private members make it a different type to every consumer.',
      );
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`check-dts: ${TIERS.length} tier declarations clean`);
