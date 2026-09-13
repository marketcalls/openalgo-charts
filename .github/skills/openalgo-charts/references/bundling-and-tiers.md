# Bundling and tiers

*When to read this: picking an import specifier, loading the package from a plain HTML page, debugging a "type is not registered" error, or checking a size budget.*

Source of truth: `package.json` (`exports`, `sideEffects`, `files`), `rollup.config.js`, `.size-limit.json`, `src/all.ts`.

## The eight entry points

`exports` declares exactly eight specifiers, each with only `types` and `import` conditions. There is no `main`, no `require` condition and no CJS build: the package is ESM-only (`"type": "module"`, `module: dist/openalgo-charts.mjs`).

| Specifier | Emitted file | Contents | Brotli measured / limit | Import has side effects |
|---|---|---|---|---|
| `openalgo-charts` | `dist/openalgo-charts.mjs` | engine, 13 chart types, indicator + chart-type registries, primitives, feeds, trading controller, shortcuts, TimeNavigator, `ReplayController`, comparison controller, settings schema, chart timezone | 76.16 KB / 77 KB | no |
| `openalgo-charts/trade` | `dist/openalgo-charts.trade.mjs` | order/position/bracket primitives, DOM ladder, `OrderEngine`, `TradeController`, `FakeBroker` | 7.61 KB standalone; 85 KB limit for base + trade | no |
| `openalgo-charts/transform` | `dist/openalgo-charts.transform.mjs` | Renko, Range, Point & Figure, Kagi, Line Break, Heikin Ashi, `runTransform` | 2.66 KB / 5 KB | **yes**, registers the `point-figure` and `kagi` chart types |
| `openalgo-charts/profile` | `dist/openalgo-charts.profile.mjs` | Volume Profile, TPO / Market Profile, Footprint, orderflow | 14.96 KB / 15 KB | no |
| `openalgo-charts/indicators` | `dist/openalgo-charts.indicators.mjs` | 102 Tier-1 built-ins plus the Tier-2 contract | 28.05 KB / 30 KB | **yes**, registers all 102 descriptors |
| `openalgo-charts/draw` | `dist/openalgo-charts.draw.mjs` | 51 drawing tools, `DrawingController`, `DrawingLayer` | 25.90 KB / 26 KB | **yes**, registers every built-in tool |
| `openalgo-charts/webgl` | `dist/openalgo-charts.webgl.mjs` | the WebGL2 series backend, `createWebGL2Backend`, `isWebGL2Supported`, `WebGL2Backend`, `GlDevice` | 6.38 KB / 7 KB | **yes**, registers the `webgl2` render backend |
| `openalgo-charts/widget` | `dist/openalgo-charts.widget.mjs` | `createWidget`, the chrome (top bar, rail, status line, toasts), the dialogs, the keymap, the tokens and stylesheet; the only tier that ships DOM. Imports `openalgo-charts/draw` itself | 41.91 KB / 42 KB | **yes**, registers the seven dialog mounts with the shell |

Types resolve per tier: `dist/index.d.ts`, `dist/trade/index.d.ts`, `dist/transform/index.d.ts`, `dist/profile/index.d.ts`, `dist/indicators/index.d.ts`, `dist/draw/index.d.ts`, `dist/webgl/index.d.ts`, `dist/widget/index.d.ts`.

## Never deep-import into `dist/`

**Import the bare specifier or a declared subpath. Never `openalgo-charts/dist/openalgo-charts.mjs`, never a relative path into `node_modules`, never a tier's internal module.**

The reason is registry identity, and it is a correctness bug, not a size problem. `rollup.config.js` builds each tier as its own bundle with the base marked external, so a tier's runtime imports of shared state survive as a real import rather than being inlined:

```js
const PKG = 'openalgo-charts';
const tierExternal = (id) => id === PKG || id.startsWith(`${PKG}/`);
```

Every `openalgo-charts/<tier>` specifier is external too, and `output.paths` maps each to its sibling file, because the widget tier builds on the draw tier and would otherwise inline a second `DrawingController`.

Every registry (chart types, indicators, drawing tools) is a module-level `Map` inside exactly one module instance. `createChart` reads the base bundle's copy. A deep import creates a second module instance with a second, empty `Map`:

- `import 'openalgo-charts/dist/openalgo-charts.indicators.mjs'` alongside `import { createChart } from 'openalgo-charts'` in a bundler that resolves the two to different graph nodes registers 102 descriptors into a Map nobody reads. `chart.addIndicator('macd')` then throws as if the tier were never loaded.
- The same failure for `openalgo-charts/transform` shows up as `series type "point-figure" needs the transform tier, import 'openalgo-charts/transform' first`, on a page that plainly did import it.
- For `openalgo-charts/draw` you get two `DrawingController` classes and two tool tables; `instanceof` checks and tool ids stop lining up across them.

Node and any bundler honouring `exports` will refuse a deep specifier outright, which is the good outcome. The failure mode appears when a bundler is configured to ignore `exports`, when a monorepo alias points at `dist/`, or when someone hand-writes a relative path.

`src/transform/index.ts`, `src/indicators/index.ts` and `src/draw/index.ts` all carry this rule in their header comments. Follow it in tier code too: import shared runtime values from `'openalgo-charts'`, never `'../index'` by path.

## What the tier bundles actually import

Verified against the built output:

- `dist/openalgo-charts.indicators.mjs` and `dist/openalgo-charts.transform.mjs` begin with `import{...}from"./openalgo-charts.mjs"`, a **relative** specifier, not the bare package name. Rollup rewrites it via `output.paths: { 'openalgo-charts': './openalgo-charts.mjs' }`.
- `dist/openalgo-charts.draw.mjs`, `.trade.mjs` and `.profile.mjs` emit no base import at all: they take only *types* from `openalgo-charts`, which erase at compile time. Their registries and primitives are self-contained.

**Serving `dist/` directly over HTTP works with no import map.** A `<script type="module">` that loads `/dist/openalgo-charts.indicators.mjs` resolves `./openalgo-charts.mjs` as a sibling URL. Every example in `examples/` relies on this; none declares an import map. The `.d.ts` builds keep the bare specifier, which TypeScript resolves through `exports`.

## sideEffects and tree-shaking

```json
"sideEffects": [
  "**/transform/**", "**/indicators/**", "**/draw/**", "**/webgl/**", "**/widget/**",
  "./dist/openalgo-charts.transform.mjs",
  "./dist/openalgo-charts.indicators.mjs",
  "./dist/openalgo-charts.draw.mjs",
  "./dist/openalgo-charts.webgl.mjs",
  "./dist/openalgo-charts.widget.mjs"
]
```

An array, not `false`: the base, trade and profile bundles are declared side-effect-free and tree-shake normally; the five registering tiers are marked as having side effects so a bare `import 'openalgo-charts/indicators'` (or `'openalgo-charts/webgl'`, or the widget, whose import registers its dialogs) is never dropped.

Tree-shaking will remove unused named exports from any tier. It will **not** remove a registration that a bundler can see is reachable, the registration runs at module scope in the tier's `index.ts`.

If a bundler still eliminates a bare side-effect import (an aggressive config, an older `sideEffects` implementation, a re-export barrel that loses the marking), call the registrar explicitly. All three are idempotent and exported for exactly this case:

```ts
import { registerBuiltinIndicators } from 'openalgo-charts/indicators';
import { registerBuiltinDrawingTools } from 'openalgo-charts/draw';
import { registerTransformChartTypes } from 'openalgo-charts/transform';

registerBuiltinIndicators();
registerBuiltinDrawingTools();
registerTransformChartTypes();
```

**A named import from a tier already runs its registration.** `import { RenkoTransform } from 'openalgo-charts/transform'` executes the module, so P&F and Kagi are registered too. The explicit call is only for the bare-import case.

## Loading shapes

**Bundler (Vite, webpack, Rollup, Next.js), bare specifier.**

```ts
import { createChart } from 'openalgo-charts';
import 'openalgo-charts/indicators';
import { DrawingController } from 'openalgo-charts/draw';
```

Lazy-load a tier the user may never touch:

```ts
const { DrawingController } = await import('openalgo-charts/draw');
```

**Plain `<script>`, the standalone IIFE.** `dist/openalgo-charts.standalone.js` is built with `format: 'iife', name: 'OpenAlgoCharts'`, from the base entry with nothing external. It defines a `window.OpenAlgoCharts` global and needs no module support.

```html
<script src="/dist/openalgo-charts.standalone.js"></script>
<script>
  const chart = OpenAlgoCharts.createChart(document.getElementById('chart'));
  chart.addSeries('candlestick').setData(bars);
</script>
```

**The standalone bundle is base-only.** No tier is included and no tier can attach to it, a tier `.mjs` loaded beside it would import its own second copy of the base. Use native ESM when you need tiers on a bundler-free page.

**Native ESM, concrete `.mjs` URLs.**

```html
<script type="module">
  import { createChart } from '/dist/openalgo-charts.mjs';
  import '/dist/openalgo-charts.indicators.mjs';
</script>
```

**A bare specifier does not resolve in a browser.** `import { createChart } from 'openalgo-charts'` in a `<script type="module">` is a resolution error: the browser has no `node_modules` lookup and no `exports` map. Either use a path/URL, or declare an import map:

```html
<script type="importmap">
{ "imports": { "openalgo-charts": "/dist/openalgo-charts.mjs" } }
</script>
```

An import map is optional here. Because the tier bundles reference `./openalgo-charts.mjs` relatively, serving `dist/` unmodified is enough.

## Size budgets

Enforced by `npm run size` (`size-limit`, Brotli, `@size-limit/file`), from `.size-limit.json`:

| Budget row | Files measured | Limit | Measured |
|---|---|---|---|
| Base engine | `openalgo-charts.mjs` | 77 KB | 76.16 KB |
| Base + trade layer | base + `trade.mjs` | 85 KB | 83.77 KB |
| Indicator tier | `indicators.mjs` | 30 KB | 28.05 KB |
| Draw tier | `draw.mjs` | 26 KB | 25.90 KB |
| Transform tier | `transform.mjs` | 5 KB | 2.66 KB |
| Profile tier | `profile.mjs` | 15 KB | 14.96 KB |
| WebGL2 tier | `webgl.mjs` | 7 KB | 6.38 KB |
| Widget tier | `widget.mjs` | 42 KB | 41.91 KB |
| Widget terminal | base + `draw.mjs` + `indicators.mjs` + `widget.mjs` | 173 KB | 172.02 KB |
| Everything | all eight bundles | 205 KB | 203.62 KB |

Version 2.1.2 raises the full-package budget from 187 KB to 188 KB for the feed, indicator lifecycle and recovery fixes. Version 2.1.3 raises base, widget and widget-terminal ceilings to 68 KB, 37 KB and 157 KB for navigation controls, and the chart-only tree-shaking ceiling to 45 KiB. Version 2.1.6 raises the base, base-plus-trade, widget-terminal and total ceilings
to 73 KB, 81 KB, 165 KB and 197 KB for shared loading, resilient caching and
managed study status. Aggregate rows constrain the total independently of individual tier ceilings. The limits in `.size-limit.json` are the budget of record.

Version 2.1.7 budgets the shared object inventory and compact Objects panel at
74 KB base, 82 KB base plus trade, 40 KB widget, 168 KB widget terminal and 200 KB
for all tiers. The chart-only import keeps its 45 kB tree-shaking ceiling.

Version 2.1.8 budgets normalized gestures and touch controls at 75 KB base,
83 KB base plus trade, 42 KB widget, 170 KB widget terminal and 202 KB total.
The chart-only tree-shaking ceiling is 46 KiB; widget controls remain excluded.

**Nothing is excluded from these numbers.** The package has zero runtime dependencies (`dependencies` is absent; everything in `devDependencies` is build tooling), so the measured file *is* the shipped payload. There is no CSS to import, no peer dependency, no web-component registration.

`npm run verify` runs lint, typecheck, unit tests, build, demo tests, declaration checks, size budgets and tree shaking, and is the `prepublishOnly` hook.

## `src/all.ts` is not an entry point

`src/all.ts` re-exports the base plus transform, profile, indicators, draw and webgl into one module, built by the `allBundle` config with the `aliasSelf` plugin resolving `openalgo-charts` back to `src/index.ts`. Nothing is external, so every tier shares one registry instance.

It exists so the documentation site's live demos can run every tier from a single module. It is **not** published: `files` excludes it explicitly.

```json
"files": ["dist/**", "!dist/openalgo-charts.all.mjs", "!dist/openalgo-charts.all.mjs.map", "NOTICE"]
```

It has no `.d.ts` build and no `exports` entry. `openalgo-charts/all` does not resolve. Applications import the tiers they use. The trade tier is deliberately left out of the combined bundle because it shares type names with the base feed types.

## Related

[core-api](core-api.md) · [chart-types](chart-types.md) · [indicators](indicators.md) · [transforms](transforms.md) · [drawing-tools](drawing-tools.md) · [trade-tier](trade-tier.md) · [profiles-and-orderflow](profiles-and-orderflow.md) · [widget](widget.md) · [react-integration](react-integration.md) · [pitfalls](pitfalls.md)

## Tier identity constants

Each opt-in tier exports a string constant naming itself, so feature detection does
not depend on a bare string literal that a rename would silently break:

| Export | Value | From |
|---|---|---|
| `INDICATORS_TIER` | `'indicators'` | `openalgo-charts/indicators` |
| `DRAW_TIER` | `'draw'` | `openalgo-charts/draw` |
| `TRANSFORM_TIER` | `'transform'` | `openalgo-charts/transform` |
| `PROFILE_TIER` | `'profile'` | `openalgo-charts/profile` |
| `TRADE_TIER` | `'trade'` | `openalgo-charts/trade` |
| `WEBGL_TIER` | `'webgl'` | `openalgo-charts/webgl` |
| `WIDGET_TIER` | `'widget'` | `openalgo-charts/widget` |

They are exported from the tier's own entry point, not from the base bundle, so
importing one to test for it defeats the purpose. Track what your own code loaded.

The 2.1.9 branding and optional watermark change uses 77 KB base, 85 KB
base plus trade, 173 KB widget terminal and 205 KB total budgets. The chart-only
import is 48.96 KiB (45.51 KiB in 2.1.8), with a 50 KiB ceiling for bundled vector
artwork, watermark settings and guarded logo input. The widget stays below 42 KB.
