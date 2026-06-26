# OpenAlgo Charts End-to-End Audit

Date: 2026-06-26

Scope:

- Package audited: `D:\testing\openalgo-charts`
- Reference implementation reviewed: `D:\testing\lightweight-charts`
- Architecture reviewed: `ARCHITECTURE.md`
- Local OpenAlgo API reference checked for `/api/v1/history`: `D:\testing\openalgo\docs\api\market-data\history.md`
- Git revision during audit: `1200454`

Important reproducibility note: this audit was run on a dirty local working tree, not a clean checkout. Current modified files include `src/core/chart.ts`, `src/core/pane.ts`, `src/index.ts`, `src/model/chart-type-registry.ts`, `src/primitives/primitive.ts`, `src/render/axis.ts`, `src/render/line.ts`, `src/scale/price-scale.ts`, `src/trade/bracket.ts`, `src/trade/order-line.ts`, `src/trade/position.ts`, and several tests. Current untracked files include `src/render/gradient.ts`, `src/theme.ts`, `tests/theme-gradient.test.ts`, and this audit report. The verification results below are for that local working tree state.

## Executive Summary

The package is buildable, testable, importable from `dist`, and comfortably inside the declared Brotli size budgets. The base chart engine, renderers, transforms, profile tier, and trade tier all compile and the existing unit suite passes.

However, the current implementation is not yet end-to-end production complete against `ARCHITECTURE.md` or the OpenAlgo integration claim in the README. The main blockers are real OpenAlgo live data integration, history payload correctness, multi-pane pointer/layout correctness, browser/pixel testing, and chart-trading safety edges.

## Verification Matrix

| Check | Result | Notes |
|---|---:|---|
| `npm run typecheck` | Pass | TypeScript compile check passed. |
| `npm run test` | Pass | 19 test files, 154 tests passed. Initial sandbox run failed with `spawn EPERM`; rerun with approved escalation passed. |
| `npm run build` | Pass | Rollup generated all ESM bundles and declarations. |
| `npm run size` | Pass | Base 11.97 KB Brotli, base+trade 16.75 KB, transform 3.43 KB, profile 1.98 KB, all tiers 22.15 KB. |
| `npm run verify` | Pass | Typecheck, tests, build, and size all passed together. |
| Dist import smoke | Pass | Imported `openalgo-charts`, `/trade`, `/transform`, `/profile`; exports were visible and `VERSION` was `0.0.0`. |
| `npm pack --dry-run` | Pass | Tarball contents are `dist/**`, `README.md`, `LICENSE`, and `package.json`; package size 91.9 KB. |
| Browser/pixel E2E | Not run | No Playwright/Puppeteer/browser harness exists in this repo. Vitest is configured for `node` only. |
| Real OpenAlgo live feed | Not run | No real OpenAlgo WS adapter exists in the chart package, and no credentials/session config were provided. |

## What Is Solid

- The build pipeline is real and repeatable in the current working tree: `typecheck`, `test`, `build`, `size`, and `verify` pass.
- The measured size budget is better than the architecture target. Full package is 22.15 KB Brotli against a 50 KB budget.
- Package exports are coherent for ESM consumers: root, `./trade`, `./transform`, and `./profile` all import from `dist`.
- Core design basics match the architecture: shared `DataLayer`, shared `TimeScale`, base/top canvas layers per pane, primitive lifecycle hooks, chart-type registry, transforms, profile primitives, candle builder, and size-limit are present.
- The local package tarball is clean and small. It does not accidentally include source, tests, examples, or docs.

## Critical Findings

### C1. OpenAlgo history request payload is wrong for the real API

Evidence:

- `src/feed/openalgo-rest.ts:89-90` sends `start_date: req.from` and `end_date: req.to`.
- `src/feed/types.ts:11-12` defines `from` and `to` as `UTCSeconds`.
- `docs/getting-started.md:60` calls `getBars()` with no `from` or `to`.
- `D:\testing\openalgo\docs\api\market-data\history.md` documents `start_date` and `end_date` as `YYYY-MM-DD` strings.

Impact:

Real OpenAlgo history calls can fail, return the wrong range, or depend on undefined server behavior. The public getting-started snippet is also not a valid historical request for OpenAlgo as documented.

Recommendation:

Change the feed contract or adapter so the REST payload sends `YYYY-MM-DD` dates. Either require `from` and `to` and convert UTC seconds to IST date strings, or expose explicit `startDate` and `endDate` fields. Add an HTTP payload unit test that asserts the exact JSON sent to `/api/v1/history`.

### C2. OpenAlgo live market data integration is a stub

Evidence:

- `src/feed/openalgo-rest.ts:97` implements `subscribeBars()` as a no-op unsubscribe function.
- `ARCHITECTURE.md:810` says `OpenAlgoDataFeed` and `OpenAlgoTradeFeed` implement REST plus WS.
- `README.md:7-8` says all phases are complete, including live/trade/depth/profile capability.

Impact:

The package can simulate live candles with `CandleBuilder`, but it cannot subscribe to a real OpenAlgo LTP/Quote/Depth stream through its own OpenAlgo adapter. That is a release blocker for the stated OpenAlgo charting package.

Recommendation:

Add an `openalgo-ws.ts` adapter that maps OpenAlgo LTP/Quote/Depth events into `CandleBuilder`, `series.update()`, DOM ladder depth, and LTP updates for trade primitives. Add deterministic fake-WS tests before broker testing.

### C3. Multi-pane layout and pointer mapping are inconsistent

Evidence:

- `src/core/pane.ts:51` sets every pane DOM element to `flex: 1 1 auto`.
- `src/core/chart.ts:287` relayouts canvases by pane weights.
- `src/core/chart.ts:354` maps pointer Y to panes by equal `this._height / this._panes.length`, ignoring weights and actual DOM rectangles.

Impact:

Multi-pane charts can draw one pane height but hit-test another. Crosshair, click, order-line dragging, and price conversion can be wrong when panes have unequal weights, especially price+volume/indicator layouts.

Recommendation:

Set pane DOM height/flex-basis from the same weighted layout used to size canvases. For hit testing, use actual pane bounding rectangles or cumulative measured pane heights, not equal division.

### C4. No real browser, canvas, DPR, or interaction E2E coverage

Evidence:

- `vitest.config.ts:6` uses `environment: 'node'`.
- Tests use fake/recording contexts, not real browser canvases.
- `ARCHITECTURE.md:843` calls for renderer pixel goldens.
- The local `lightweight-charts` reference has extensive browser-facing structure: `src/gui/mouse-event-handler.ts`, `src/gui/pane-widget.ts`, `src/gui/price-axis-widget.ts`, `src/gui/time-axis-widget.ts`, and pane separators.

Impact:

The package can pass all current tests while still failing in real DOM layout, ResizeObserver behavior, HiDPI canvas backing size, pointer capture, wheel/pinch gestures, text rendering, and z-order visual output.

Recommendation:

Add a Playwright or Puppeteer smoke suite that loads the built `dist` examples, captures pixels at DPR 1/1.5/2, verifies nonblank canvases, exercises pan/zoom/crosshair/drag, and checks multi-pane alignment.

## High Findings

### H1. Dirty worktree and untracked source dependency make release reproducibility uncertain

Evidence:

- `git diff --name-only` currently shows many modified source and test files.
- `git status --short` shows untracked `src/theme.ts`.
- `src/model/chart-type-registry.ts` imports `../theme`.

Impact:

The current local build passes in the dirty workspace. A clean checkout or CI run from only committed files may fail or behave differently if required source files or related tests are not committed together. This is a release reproducibility blocker.

Recommendation:

Commit required source files or remove the dependency. Add a clean-checkout CI run before publishing.

### H2. Trade modify validation can send invalid modify prices

Evidence:

- `src/trade/order-engine.ts:141-148` validates a drag-modify price, but if validation fails it falls back to the raw `price`.

Impact:

Dragging an order line outside allowed bands can still send a broker modify request. That weakens the chart-trading safety model and can create avoidable broker rejects or throttling.

Recommendation:

If validation fails, do not enqueue or flush the modify. Surface a rejected local state or callback so the UI can snap back and display the validation error.

### H3. Idempotency tokens are marked sent before order placement succeeds

Evidence:

- `src/trade/order-engine.ts:102-112` checks `_sentTokens`, then adds the token before `this._feed.place()` resolves.

Impact:

A rejected request or transport failure with a client token cannot be retried with the same token, even when the broker never accepted it. That complicates recovery from transient network errors.

Recommendation:

Track idempotency as `pending`, `accepted`, and `failed/unknown`. Preserve duplicate-send protection, but allow explicit retry policy for failed or unknown transport outcomes.

### H4. Working order LTP updates do not request repaint

Evidence:

- `src/trade/order-line.ts:33` updates `_ltp` without calling `requestUpdate()`.
- `src/trade/position.ts:30-32` does request an update for the same kind of LTP change.

Impact:

Distance-to-LTP labels on working order lines can become stale until another chart invalidation happens.

Recommendation:

Call `this._host?.requestUpdate()` in `WorkingOrderLine.setLtp()`.

### H5. Transform-only series are in the base public type before their renderers are registered

Evidence:

- `src/model/chart-type-registry.ts:15-30` includes `point-figure` and `kagi` in `SeriesType`.
- `src/model/chart-type-registry.ts:204-206` notes those are registered only by the transform tier.
- `src/transform/index.ts:16-21` registers them as side effects.

Impact:

TypeScript lets a root-package consumer call `addSeries('point-figure')`, but runtime throws `unknown series type` unless the transform entry point has been imported first.

Recommendation:

Either exclude transform-only types from the base `SeriesType`, auto-register the transform tier where those types are accepted, or make `addSeries()` return a clear missing-tier error with documentation.

### H6. Custom chart-style docs do not match the public type surface

Evidence:

- `docs/guides.md:81-82` shows `registerChartType('my-style', ...)`.
- `src/model/chart-type-registry.ts:82-84` types `registerChartType(type: SeriesType, ...)`, where `SeriesType` is a fixed string union.

Impact:

The documented custom style example does not type-check without a cast or module augmentation.

Recommendation:

Widen the registry key type to `string`, or document the required TypeScript augmentation pattern.

### H7. `DataLayer.update()` misclassifies historical inserts as right-edge appends

Evidence:

- `src/model/data-layer.ts:74-95` returns `true` after adding an out-of-order new time because `_indexByTime.has(bar.time)` is true after `addBars()`.
- `src/core/chart.ts:219` consumes the boolean as `addedNewBar` for live update behavior.

Impact:

Late or historical ticks can be treated as a new right-edge bar, affecting auto-scroll and viewport behavior.

Recommendation:

Return a richer update kind such as `replace`, `appendRight`, or `insertHistorical`, and let the chart react only to `appendRight`.

### H8. Trade feed contracts are split and no OpenAlgo trade adapter exists

Evidence:

- `src/feed/types.ts:52-55` defines `TradeFeed` with `placeOrder`, `modifyOrder`, and `cancelOrder`.
- `src/trade/order-engine.ts:23-26` defines its own `OrderFeed` with `place`, `modify`, and `cancel`.
- `ARCHITECTURE.md:810` expects an `OpenAlgoTradeFeed`.

Impact:

The chart-trading engine is testable with fake feeds, but there is no coherent public OpenAlgo order adapter to connect it to real `/placeorder`, `/modifyorder`, `/cancelorder`, orderbook, positionbook, analyzer mode, and reconnect reconciliation.

Recommendation:

Unify the feed interface and implement `OpenAlgoTradeFeed` as a separate opt-in adapter. Add simulator tests for ack, partial fill, reject, cancel, modify, reconnect, and stale order recovery.

### H9. Price scale is linear-only while the architecture promises more modes

Evidence:

- `src/scale/price-scale.ts:3` says the implementation covers linear mode and leaves log/percentage/inverted/overlay behavior for later.
- `ARCHITECTURE.md` lists linear, log, percentage, inverted, indexed-to-100, custom range, overlay scales, and label collision handling as design targets.

Impact:

Charts that require percentage, log, indexed-to-100, inverted, or overlay price scales cannot be represented accurately.

Recommendation:

Either implement the promised modes or change README/architecture status to mark them as not yet supported.

### H10. Touch and pinch support is below the architecture target

Evidence:

- `src/core/chart.ts:346-350` attaches pointer, wheel, and dblclick handlers.
- Mouse drag kinetic scrolling exists, but there is no dedicated multi-touch pinch path.
- The lightweight reference has explicit touch handling in `src/gui/mouse-event-handler.ts`, `src/gui/pane-widget.ts`, and `src/gui/time-axis-widget.ts`.

Impact:

Mobile and trackpad/tablet behavior will lag the stated "smooth pan, wheel-zoom, pinch-zoom" goal.

Recommendation:

Add an input manager that tracks active pointers, implements pinch scale around a focus point, and has browser E2E coverage for mouse, touch, and wheel paths.

## Medium Findings

### M1. Visible range lookup is linear and rebuilds indexed rows repeatedly

Evidence:

- `src/model/data-layer.ts:124` builds indexed bars.
- `src/model/data-layer.ts:136-140` scans all indexed bars for every visible range request.
- `ARCHITECTURE.md:19` calls for cached visible range lookup where redraw cost scales with visible bars.

Impact:

50k-bar, multi-series charts may spend avoidable time rebuilding and scanning data during pan/zoom and live updates. Conflation exists, but it starts after the visible rows have already been selected.

Recommendation:

Store sorted per-series indexed rows and use binary search for visible range slicing. Cache invalidation should be tied to set/update/prepend operations.

### M2. Standalone IIFE build is missing

Evidence:

- `ARCHITECTURE.md:11` says output should include ESM plus IIFE standalone for script/CDN drop-in.
- `rollup.config.js:29-31` emits only `format: 'es'`.
- `package.json:9-24` exports only ESM entry points.

Impact:

The package cannot currently be dropped into a plain `<script>` tag despite the architecture promise.

Recommendation:

Add an IIFE bundle target or update the architecture/docs to say the package is ESM-only.

### M3. README and changelog overstate implementation status

Evidence:

- `README.md:7-8` says all 12 phases are complete.
- `CHANGELOG.md:5` says `0.1.0`.
- `package.json:3` and `src/version.ts:2` are still `0.0.0`.

Impact:

Consumers will assume production-level live OpenAlgo integration, chart trading, browser validation, and release stability that are not present yet.

Recommendation:

Align README, CHANGELOG, and `VERSION` with actual support. If this is still pre-release, document it as such and list unsupported features explicitly.

### M4. Example uses an ignored option shape

Evidence:

- `examples/phase4-live.html:30` passes `{ histogramStyle: { color: '#33415e' } }`.
- `src/core/chart.ts:139-147` only consumes `options.style`.

Impact:

The example appears to configure the volume histogram color, but that option is ignored.

Recommendation:

Change the example to `{ style: { color: '#33415e' } }`, or add typed per-series option support.

### M5. Primitive API is thinner than the architecture and lightweight-charts plugin model

Evidence:

- `src/primitives/primitive.ts:40-47` supports draw, autoscale, hitTest, attached, and detached.
- The lightweight reference exposes pane views, price-axis views, time-axis views, axis-pane views, wrappers, and plugin templates in `src/model/iseries-primitive.ts` and `packages/create-lwc-plugin`.
- `src/core/chart.ts:513-526` destroys panes without calling `detached()` on attached primitives.

Impact:

Simple markers and order lines work, but advanced primitives cannot draw axis labels or fixed axis/time views cleanly. Destroy lifecycle may leak primitive-side state.

Recommendation:

Add explicit primitive view types for pane, price-axis, time-axis, and fixed coordinate rendering, or narrow the documented primitive promise. Ensure `destroy()` detaches primitives.

### M6. Axis widgets are not separate canvases

Evidence:

- The architecture describes separate price/time axis widgets.
- Current `Pane.paintBase()` draws axes inside the pane canvas path (`src/core/pane.ts:143-208`).
- Lightweight-charts uses separate `price-axis-widget.ts` and `time-axis-widget.ts`.

Impact:

Axis repaint and label layout are coupled to pane repaint. This limits optimization and makes advanced axis views harder.

Recommendation:

Either accept this as a deliberate small-engine simplification and update `ARCHITECTURE.md`, or split price/time axes into separate canvas widgets.

### M7. Bracket drag IDs do not map cleanly to order-engine modify IDs

Evidence:

- `src/trade/bracket.ts:93-94` returns `bracket-sl:{symbol}` and `bracket-tp:{symbol}` from hit testing.
- `examples/phase9-chart-trading.html:65` maps drag IDs through `brokerToClient`, which is order-id oriented.

Impact:

Dragging a bracket stop/target line in the example is unlikely to modify the intended child order without extra mapping.

Recommendation:

Emit child order IDs from bracket primitives, or provide a controller-level mapping from bracket handles to broker/client order IDs.

### M8. Test suite does not cover public examples as executable contracts

Evidence:

- Examples import `../dist/*.mjs`, but no test script loads the HTML examples.
- `package.json` has no browser/example test script.

Impact:

Examples can drift from the typed API and still pass all tests.

Recommendation:

Add a browser smoke test that serves `examples/`, loads each page, waits for canvas output, and fails on console errors.

## Architecture Coverage Compared With `ARCHITECTURE.md`

| Area | Current state | Gap |
|---|---|---|
| Size budget | Passed and well under target. | None for measured bundles. |
| Rollup tiers | Root, trade, transform, profile are present. | IIFE/CDN output missing. |
| Base/top canvas per pane | Present. | Axis widgets are not separate canvases. |
| Shared data/time model | Present. | Visible range lookup is not cached/binary searched. |
| Per-pane invalidation | Present. | Layout/hit-test pane geometry needs correction. |
| Family A renderers | Present. | Browser pixel validation missing. |
| Family B transforms | Present as opt-in tier. | Runtime tier loading is easy to misuse from root types. |
| Family C profiles | Present as opt-in tier. | Real tick/orderflow data adapter missing. |
| OpenAlgo history feed | Partial. | Date payload and required range handling are wrong. |
| OpenAlgo live feed | Not implemented. | WS adapter and depth subscription missing. |
| Trade engine | Partial and tested with fake feeds. | Real OpenAlgo adapter, retry semantics, and modify safety need work. |
| DOM ladder | Present as primitive logic. | Click-to-place / real depth wiring not complete. |
| Browser interactions | Mouse drag, wheel zoom, kinetic scroll exist. | Pinch/touch and browser E2E missing. |
| Testing | 154 node/unit tests pass. | Pixel, real canvas, ResizeObserver, pointer, example, and OpenAlgo adapter tests missing. |

## Lightweight-Charts Comparison Notes

The local `D:\testing\lightweight-charts` reference is much larger and more mature. The main lessons that still apply to OpenAlgo Charts are:

- It separates chart, pane, price-axis, and time-axis widgets (`src/gui/chart-widget.ts`, `src/gui/pane-widget.ts`, `src/gui/price-axis-widget.ts`, `src/gui/time-axis-widget.ts`).
- It has a dedicated mouse/touch event handler and explicit touch paths (`src/gui/mouse-event-handler.ts`, `src/gui/pane-widget.ts`).
- It supports pane separators/resizing (`src/gui/pane-separator.ts`).
- Its price scale supports log, percentage, indexed-to-100, and richer formatter/axis behavior (`src/model/price-scale.ts`).
- Its primitive/plugin model has pane views, axis views, axis-pane views, wrappers, and plugin templates (`src/model/iseries-primitive.ts`, `packages/create-lwc-plugin`).

OpenAlgo Charts does not need to clone all of that to stay lightweight, but the architecture currently promises several of those behaviors. Either implement the subset that matters, or explicitly document the smaller scope.

## Recommended Fix Order

1. Commit or remove the untracked source dependencies so a clean checkout builds.
2. Fix OpenAlgo history request dates and update getting-started docs.
3. Implement real OpenAlgo WS data subscriptions for LTP/Quote/Depth.
4. Fix multi-pane weighted DOM layout and pointer/hit-test mapping.
5. Add browser smoke and pixel tests for built examples.
6. Fix trade modify validation and idempotency retry semantics.
7. Align README, CHANGELOG, version, and architecture status with actual support.
8. Decide whether IIFE output, separate axis widgets, and full price-scale modes are required for this release or explicitly deferred.

## Release Readiness Verdict

Not release-ready as a production OpenAlgo charting package yet.

It is ready as a compact pre-release/prototype package for local demos and unit-tested library development. The build is healthy, but the integration and browser validation gaps are too large for a production claim, especially around real OpenAlgo live data and chart trading.
