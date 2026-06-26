# OpenAlgo Charts End-to-End Audit v2

Date: 2026-06-26

Scope:

- Package audited: `D:\testing\openalgo-charts`
- Fresh revision audited: `8eac3f0`
- Previous audit baseline: `1200454`
- Local OpenAlgo docs checked:
  - `D:\testing\openalgo\docs\api\market-data\history.md`
  - `D:\testing\openalgo\docs\api\order-management\placeorder.md`
  - `D:\testing\openalgo\docs\api\order-management\modifyorder.md`
  - `D:\testing\openalgo\docs\api\order-management\cancelorder.md`
  - `D:\testing\openalgo\docs\api\account-services\orderbook.md`
  - `D:\testing\openalgo\docs\api\account-services\positionbook.md`
  - `D:\testing\openalgo\docs\design\37-apikey-playground\README.md`

Repo state before this file was added: clean (`git status --short` produced no changes).

## Executive Summary

The package is materially improved since the first audit. The previous correctness and safety findings around history date payloads, multi-pane hit testing, trade modify validation, idempotency retry, update-kind semantics, custom chart registration, log/inverted scales, IIFE output, versioning, and example options are fixed and covered by tests.

The build is healthy:

- 23 test files, 185 tests passed.
- Typecheck passed.
- Rollup build passed, including `dist/openalgo-charts.standalone.js`.
- All size limits passed.
- Dist ESM imports passed.
- Standalone IIFE smoke passed in a VM context.
- `npm pack --dry-run` produced the expected 0.1.0 package.

The current honest release state is still pre-release, not production. The main remaining blockers are not the original chart-core issues; they are live/browser validation and OpenAlgo adapter contract completeness.

## Verification Matrix

| Check | Result | Evidence |
|---|---:|---|
| `git rev-parse --short HEAD` | Pass | `8eac3f0` |
| `git status --short` before v2 file | Pass | Clean output. |
| `npm run verify` | Pass | Typecheck, tests, build, size all passed. |
| Unit tests | Pass | 23 files, 185 tests. |
| Size limits | Pass | Base 14.45 KB, base+trade 19.3 KB, transform 3.76 KB, profile 2.33 KB, everything 25.4 KB Brotli. |
| ESM dist import smoke | Pass | Root, trade, transform, profile imported; `VERSION` was `0.1.0`; `OpenAlgoWsFeed` and `OpenAlgoTradeFeed` exported. |
| Standalone IIFE smoke | Pass | `OpenAlgoCharts.VERSION === "0.1.0"` and `createChart` exists when evaluated in a VM context. |
| `npm pack --dry-run` | Pass | `openalgo-charts-0.1.0.tgz`, 17 files, 147.4 KB package, 494.9 KB unpacked. |
| Browser/pixel E2E | Not run | No Playwright/Puppeteer/browser harness exists. |
| Live OpenAlgo smoke | Not run | No running OpenAlgo session, broker login, or credentials were available. |

## Fixed Findings From Audit v1

| ID | v2 status | Verification notes |
|---|---|---|
| C1 history payload | Fixed | `src/feed/openalgo-rest.ts:80-99` requires `from`/`to` and sends `start_date`/`end_date` as IST `YYYY-MM-DD`; `tests/openalgo-rest.test.ts:55-64` asserts the request payload. |
| C2 live WS missing | Partially fixed | `src/feed/openalgo-ws.ts` adds injectable WS adapter, pure subscribe/parse helpers, and fake-socket tests. See new adapter-contract findings below. |
| C3 multi-pane layout/hit-test | Fixed | `src/core/chart.ts:296-324` uses weighted pane heights for layout; `src/core/chart.ts:384-393` maps pointers using cumulative weighted heights. |
| C4 browser/pixel E2E | Deferred | Documented in README and architecture. Still not implemented. |
| H1 dirty worktree/untracked dependency | Fixed | Repo was clean before this v2 file was added. |
| H2 invalid drag-modify | Fixed | `src/trade/order-engine.ts:153-159` drops invalid modify prices and calls `onValidationError`. |
| H3 idempotency retry | Fixed | `src/trade/order-engine.ts:117-132` releases the token after a failed place; `tests/audit-fixes.test.ts:39-48` covers retry. |
| H4 order line repaint on LTP | Fixed | `src/trade/order-line.ts:30-32` requests update. |
| H5 transform-tier error clarity | Fixed with packaging caveat | `src/model/chart-type-registry.ts:92-97` gives a clear transform-tier error. See V2-M2 about `sideEffects: false`. |
| H6 custom chart style typing | Fixed | `registerChartType` and `getChartType` accept custom string keys at `src/model/chart-type-registry.ts:87-92`. |
| H7 update misclassification | Fixed | `src/model/data-layer.ts:74-95` returns `append`, `replace`, or `insert`; chart auto-scroll checks only `append` in `src/core/chart.ts:227-235`. |
| H8 no trade adapter | Partially fixed | `src/feed/openalgo-trade.ts` exists with injected fetch and tests. See V2-H1 for documented OpenAlgo payload gaps. |
| H9 price scale modes | Partially fixed | Logarithmic and inverted are implemented/tested. Percentage, indexed-to-100, and overlay scales remain deferred. |
| H10 pinch/touch | Deferred | Mouse drag, wheel, kinetic, and axis-drag exist; multi-touch pinch remains future work. |
| M1 visible-range perf | Deferred | Still linear scan/rebuild path in `DataLayer.visibleBars`; documented as future optimization. |
| M2 IIFE build | Fixed | `rollup.config.js:40-61` adds `dist/openalgo-charts.standalone.js`; VM smoke passed. |
| M3 version/status | Fixed | `package.json` is `0.1.0`; README marks pre-release and lists limitations. |
| M4 ignored histogram option | Fixed | `examples/phase4-live.html:30` uses `{ style: { color } }`. |
| M5 primitive axis views | Deferred plus lifecycle issue | Axis-view primitives are documented as deferred. Detach-on-destroy is still missing; see V2-M3. |
| M6 separate axis widgets | Accepted simplification | Documented in `ARCHITECTURE.md` section 13a. |
| M7 bracket drag IDs | Documented | Integration responsibility is documented. |
| M8 example browser contract tests | Deferred | Covered by the same browser harness gap as C4. |

## New / Remaining Findings

### V2-H1. OpenAlgo trade adapter does not yet match the documented REST order contract

Evidence:

- Local OpenAlgo `placeorder.md` documents `product` as mandatory, but `src/feed/openalgo-trade.ts:39-48` does not send `product`.
- Local OpenAlgo `modifyorder.md` documents `strategy`, `symbol`, `action`, `exchange`, `pricetype`, `product`, `quantity`, and `price` as mandatory, but `src/feed/openalgo-trade.ts:54-61` sends only `orderid`, `price`, `trigger_price`, and `quantity`.
- Local OpenAlgo `orderbook.md` and `positionbook.md` show quantities and average prices as strings, but `src/feed/openalgo-trade.ts:84-111` types and maps them as numbers without coercion.
- `tests/openalgo-adapters.test.ts:63-80` checks only the endpoint and a partial payload shape, so these documented mandatory fields are not currently asserted.

Impact:

The adapter is structurally present, but real `placeorder` and especially `modifyorder` calls can fail against the documented OpenAlgo API. Book reconciliation can also pass string values into numeric chart/trade fields at runtime.

Recommendation:

Add `product` and the other required order fields to the order model or adapter config. Preserve the original order request fields so modify can send the documented payload. Coerce numeric strings from orderbook/positionbook with `Number(...)` and test against fixtures copied from the local OpenAlgo docs.

### V2-H2. OpenAlgo WS adapter schema and browser send timing still need hardening

Evidence:

- `src/feed/openalgo-ws.ts:44-50` formats subscribe messages as `{ action, apikey, mode, symbol, exchange }`.
- Local OpenAlgo `docs/design/37-apikey-playground/README.md` shows a WebSocket subscribe example using `{ "action": "subscribe", "symbols": ["NSE:SBIN-EQ", ...] }`.
- `src/feed/openalgo-ws.ts:120-126` sends immediately through `this._sock?.send(...)`; browser `WebSocket.send()` before `OPEN` can throw.
- `SocketLike` includes `onopen`, but `OpenAlgoWsFeed.connect()` does not queue subscriptions until open.

Impact:

The fake-socket tests prove parsing/format helpers, but a browser/live OpenAlgo smoke can still fail due to schema mismatch or send-before-open timing.

Recommendation:

Verify the actual current proxy schema against a running OpenAlgo build. Then either change `formatSubscribe()` to the current schema or support both schema versions. Queue subscribe/unsubscribe messages until socket open, and add a fake socket test that models `readyState`.

### V2-M1. `DataFeed.subscribeBars()` remains an API trap for OpenAlgoDataFeed

Evidence:

- `src/feed/types.ts:17-18` defines `DataFeed.getBars()` and `DataFeed.subscribeBars()`.
- `src/feed/openalgo-rest.ts:102-107` intentionally returns a no-op from `OpenAlgoDataFeed.subscribeBars()`.
- `docs/getting-started.md:70-82` correctly tells users to wire `OpenAlgoWsFeed` plus `CandleBuilder` manually.

Impact:

The docs are honest, but the type contract suggests a feed object can provide live bars through `subscribeBars()`. Calling it on `OpenAlgoDataFeed` silently does nothing.

Recommendation:

Either remove `subscribeBars()` from the base `DataFeed` contract, make it optional, or provide a composed `OpenAlgoLiveDataFeed` that wraps `OpenAlgoDataFeed`, `OpenAlgoWsFeed`, and `CandleBuilder`.

### V2-M2. Transform tier registration can be tree-shaken away by bundlers

Evidence:

- `src/transform/index.ts:16-26` registers `point-figure` and `kagi` as module side effects.
- `package.json:28` sets `"sideEffects": false`.
- `src/model/chart-type-registry.ts:96` tells consumers to import `openalgo-charts/transform` first.

Impact:

Bundlers that honor `sideEffects: false` can drop a bare `import 'openalgo-charts/transform'`, which would preserve the clear runtime error but still prevent registration in optimized builds.

Recommendation:

Mark the transform entry as side-effectful, for example `"sideEffects": ["dist/openalgo-charts.transform.mjs"]`, or expose an explicit `registerTransformChartTypes()` function that consumers call.

### V2-M3. `Chart.destroy()` still does not detach primitives

Evidence:

- `Pane.removePrimitive()` calls `primitive.detached?.()` at `src/core/pane.ts:73-78`.
- `Chart.destroy()` at `src/core/chart.ts:592-608` removes pane elements and clears `_panes` without walking primitives or calling `Pane.removePrimitive()`.
- The v1 report resolution table claims destroy detaches via `removePrimitive`, but the source does not do that.

Impact:

Primitive hosts can remain referenced after chart teardown, especially trade/profile primitives with `_host` fields. This is a lifecycle leak risk in single-page apps that create/destroy charts repeatedly.

Recommendation:

Add a `Pane.destroy()` or `Pane.clearPrimitives()` path that calls `detached()` for every primitive, and call it from `Chart.destroy()`. Add a lifecycle unit test.

### V2-L1. README verification numbers are slightly stale

Evidence:

- `README.md:8-9` says `170+ unit tests` and `~24 KB Brotli`.
- Fresh verification shows 185 tests and 25.4 KB Brotli for all tiers.

Impact:

Low. The claim is directionally true, but release docs should match measured output.

Recommendation:

Update README to `185 tests` and `~25.4 KB Brotli` or phrase it as `180+ tests` and `< 26 KB Brotli`.

## Deferred Scope Still Accepted

These are documented deferrals and not hidden defects:

- Browser/pixel E2E and example smoke tests.
- Live OpenAlgo smoke test with broker credentials.
- Percentage, indexed-to-100, and overlay price scales.
- Multi-touch pinch.
- Binary-search/cached visible range performance work.
- Primitive price/time axis views.
- Separate axis-widget canvases, accepted as a small-engine simplification.

## Architecture Accuracy Check

The `ARCHITECTURE.md` section 13a is useful and mostly honest. Two spots still overstate implementation details:

- Section 10.1 still presents `DataFeed.subscribeBars()` as part of the simple live contract, while the real OpenAlgo path is manual `OpenAlgoWsFeed` plus `CandleBuilder`.
- The revision-log wording for primitive API still mentions full price/time/fixed axis views, while section 13a correctly says those are deferred. Keep section 13a, but reconcile the older revision-log language when the docs are next edited.

## Resolutions (post-v2, commit pending)

All actionable v2 findings addressed; deferred-scope items remain documented. Tests 185 → 194; full package 25.4 → 26.1 KB Brotli (still < 50 KB).

| ID | Status | Resolution |
|---|---|---|
| V2-H1 trade contract | **Fixed** | `place` sends mandatory `product` (+ `strategy`); `modify` sends the full documented payload (strategy/symbol/action/exchange/pricetype/product/quantity/price) built from a cached **order context** (populated by `place` and `getOrders`); orderbook/positionbook string numerics coerced via `Number()`. Tests assert payloads + a modify of an unknown order throws. |
| V2-H2 WS schema + timing | **Fixed (verify schema)** | `formatSubscribe` now uses the documented `symbols: ["EXCHANGE:SYMBOL"]` array; sends are **queued until `onopen`** (no send-before-open throw), with a `readyState`-modelled fake-socket test. Exact proxy schema still to confirm against a live build. |
| V2-M1 subscribeBars trap | **Fixed** | `DataFeed.subscribeBars` is now **optional**; `OpenAlgoDataFeed` omits it (history-only); new `OpenAlgoLiveDataFeed` composes REST + WS + `CandleBuilder` to deliver real live bars + depth. |
| V2-M2 tree-shaken registration | **Fixed** | `package.json` `sideEffects` now lists the transform tier so its registration survives; plus an explicit, idempotent `registerTransformChartTypes()` export for manual control. |
| V2-M3 destroy lifecycle | **Fixed** | `Pane.destroy()` detaches every primitive; `Chart.destroy()` calls it per pane. Lifecycle unit test added. |
| V2-L1 stale README numbers | **Fixed** | README updated to 190+ tests / ~26 KB Brotli. |
| Arch §10.1 accuracy | **Fixed** | Clarified that `OpenAlgoDataFeed` is history-only and live data comes via `OpenAlgoLiveDataFeed` / WS + `CandleBuilder`. |

Still deferred (documented, not defects): browser/pixel + example E2E, live OpenAlgo smoke with credentials, percentage/indexed-to-100/overlay scales, multi-touch pinch, binary-search visible-range perf, primitive axis views, separate axis-widget canvases.

## Release Readiness Verdict

Status: strong 0.1.0 pre-release, not production-ready yet.

The chart-core and safety fixes from audit v1 are mostly verified. The remaining production blockers are:

1. Fix OpenAlgo trade REST payloads and numeric mapping against the local docs.
2. Verify and harden the OpenAlgo WS schema and socket-open behavior.
3. Add browser/pixel/example E2E coverage.
4. Add a live OpenAlgo smoke test with credentials.
5. Fix primitive detach-on-destroy lifecycle.

After those, the package would be much closer to a defensible production claim. As of this audit, it is suitable for local demos, adapter iteration, and pre-release integration testing.
