/**
 * Guard the tier type declarations against re-inlining shared types.
 *
 * Each tier is bundled into its own `.d.ts`. If a tier imports a shared type
 * through a *relative* path, the bundler inlines the declaration, and because
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
 * The widget adds a second seam of the same shape one level up: it builds on
 * the draw tier, so a `DrawingController` inlined into its declarations is a
 * different class from the one `openalgo-charts/draw` exports, and
 * `widget.draw` stops being assignable to a host's own controller variable.
 *
 * Runs after `build` in `npm run verify`.
 */
import { readFileSync, existsSync } from 'node:fs';

/** Declarations that must never appear in any tier's bundle. */
const FORBIDDEN = [
  'declare class Chart',
  'declare class TimeScale',
  'declare class PriceScale',
  'declare class DataLayer',
];

/**
 * Tier declaration files, each with the further declarations it must not carry
 * because another tier owns them. The draw tier legitimately declares its
 * controller and layer; the widget has to import them.
 */
const TIERS = {
  'dist/draw/index.d.ts': [],
  'dist/indicators/index.d.ts': [],
  'dist/trade/index.d.ts': [],
  'dist/transform/index.d.ts': [],
  'dist/profile/index.d.ts': [],
  'dist/webgl/index.d.ts': [],
  'dist/widget/index.d.ts': ['declare class DrawingController', 'declare class DrawingLayer'],
};

let failed = false;

for (const [file, ownForbidden] of Object.entries(TIERS)) {
  if (!existsSync(file)) {
    console.error(`check-dts: ${file} is missing. Did the build run?`);
    failed = true;
    continue;
  }
  const src = readFileSync(file, 'utf8');
  for (const decl of [...FORBIDDEN, ...ownForbidden]) {
    // Word-boundary the name so `declare class ChartSomething` is not a hit.
    const re = new RegExp(`${decl}\\b`);
    if (re.test(src)) {
      console.error(
        `check-dts: ${file} inlines "${decl}".\n` +
        '  A tier must import shared types from the entry that owns them:\n' +
        "    import type { IPrimitive } from 'openalgo-charts';\n" +
        "    import type { DrawingController } from 'openalgo-charts/draw';\n" +
        '  A relative import gets bundled in as a second declaration, and the\n' +
        '  private members make it a different type to every consumer.',
      );
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`check-dts: ${Object.keys(TIERS).length} tier declarations clean`);
