# Bundling and tiers

*When to read this: picking an import specifier, loading the package from a plain HTML page, debugging a "type is not registered" error, or checking a size budget.*

Source of truth: `package.json` (`exports`, `sideEffects`, `files`), `rollup.config.js`, `.size-limit.json`, `src/all.ts`.

## The eight entry points

`exports` declares exactly eight specifiers, each with only `types` and `import` conditions. There is no `main`, no `require` condition and no CJS build: the package is ESM-only (`"type": "module"`, `module: dist/openalgo-charts.mjs`).

| Specifier | Emitted file | Contents | Brotli budget | Import has side effects |
|---|---|---|---|---|
| `openalgo-charts` | `dist/openalgo-charts.mjs` | engine, 13 chart types, indicator + chart-type registries, primitives, feeds, trading controller, shortcuts, TimeNavigator, `ReplayController`, comparison controller, settings schema, chart timezone | 67 KB | no |
| `openalgo-charts/trade` | `dist/openalgo-charts.trade.mjs` | order/position/bracket primitives, DOM ladder, `OrderEngine`, `TradeController`, `FakeBroker` | no standalone row; 75 KB for base + trade | no |
| `openalgo-charts/transform` | `dist/openalgo-charts.transform.mjs` | Renko, Range, Point & Figure, Kagi, Line Break, Heikin Ashi, `runTransform` | 5 KB | **yes**, registers the `point-figure` and `kagi` chart types |
| `openalgo-charts/profile` | `dist/openalgo-charts.profile.mjs` | Volume Profile, TPO / Market Profile, Footprint, orderflow | 11 KB | no |
| `openalgo-charts/indicators` | `dist/openalgo-charts.indicators.mjs` | 102 Tier-1 built-ins plus the Tier-2 contract | 30 KB | **yes**, registers all 102 descriptors |
| `openalgo-charts/draw` | `dist/openalgo-charts.draw.mjs` | 51 drawing tools, `DrawingController`, `DrawingLayer` | 26 KB | **yes**, registers every built-in tool |
| `openalgo-charts/webgl` | `dist/openalgo-charts.webgl.mjs` | the WebGL2 series backend, `createWebGL2Backend`, `isWebGL2Supported`, `WebGL2Backend`, `GlDevice` | 7 KB | **yes**, registers the `webgl2` render backend |
| `openalgo-charts/widget` | `dist/openalgo-charts.widget.mjs` | `createWidget`, the chrome (top bar, rail, status line, toasts), the dialogs, the keymap, the tokens and stylesheet; the only tier that ships DOM. Imports `openalgo-charts/draw` itself | 36 KB | **yes**, registers the seven dialog mounts with the shell |

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
| Base engine | `openalgo-charts.mjs` | 67 KB | 66.39 KB |
| Base + trade layer | base + `trade.mjs` | 75 KB | 74.00 KB |
| Indicator tier | `indicators.mjs` | 30 KB | 27.27 KB |
| Draw tier | `draw.mjs` | 26 KB | 25.12 KB |
| Transform tier | `transform.mjs` | 5 KB | 2.66 KB |
| Profile tier | `profile.mjs` | 11 KB | 10.66 KB |
| WebGL2 tier | `webgl.mjs` | 7 KB | 6.38 KB |
| Widget tier | `widget.mjs` | 36 KB | 35.56 KB |
| Widget terminal | base + `draw.mjs` + `indicators.mjs` + `widget.mjs` | 155 KB | 154.34 KB |
| Everything | all eight bundles | 182 KB | 181.65 KB |

The indicator tier and the `Everything` row were both raised in 1.8.3, from 27 KB and 120 KB, to carry that release's eleven new indicators. They move together by necessity: `Everything` contains the tier, so an aggregate below all-other-tiers plus the tier's ceiling would fail while the tier itself passed. The limits in `.size-limit.json` are the budget of record: measure, do not quote these figures from memory.

**Nothing is excluded from these numbers.** The package has zero runtime dependencies (`dependencies` is absent; everything in `devDependencies` is build tooling), so the measured file *is* the shipped payload. There is no CSS to import, no peer dependency, no web-component registration.

`npm run verify` runs typecheck, tests, build, `check:dts` and `size` in that order, and is the `prepublishOnly` hook.

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
