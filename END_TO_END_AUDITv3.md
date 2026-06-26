# OpenAlgo Charts End-to-End Audit v3

Date: 2026-06-27

Scope:

- Package audited: `D:\testing\openalgo-charts`
- Fresh revision audited: `8f2f9bc`
- Previous v3 baseline: `f13d317`
- Local OpenAlgo WS docs checked:
  - `D:\testing\openalgo\docs\prompt\websockets-format.md`
  - `D:\testing\openalgo\docs\websocket-quote-feed.md`
  - `D:\testing\openalgo\docs\scanner-architecture.md`
- Security perspective included: client-side secret exposure, transport, XSS/code-injection scan, supply-chain checks, and package metadata.

Repo state before this file was added: clean (`git status --short` produced no changes).

## Executive Summary

The actionable v2 findings remain fixed at the current HEAD. Since the earlier v3 audit, the package added chart coordinate APIs, screenshot export, crosshair-move callbacks, grid toggles, RSI/ATR/Supertrend, a yfinance historical demo/server, and richer simulated chart-trading workflows.

The WebSocket adapter is materially improved. It now implements the newer OpenAlgo protocol documented in `docs/prompt/websockets-format.md`: authenticate first with `api_key`, subscribe with single `symbol`/`exchange` plus numeric mode, parse nested `market_data`, support ISO timestamps, and respond to `ping`. Older OpenAlgo docs still show batched `symbols` arrays and string modes, so this still needs a live smoke test against the exact OpenAlgo build in use.

The build and package are healthy:

- `npm run verify` passed.
- 27 test files, 215 tests passed.
- Typecheck, Rollup build, standalone IIFE build, and all size limits passed.
- Full package measured 27.69 KB Brotli against a 50 KB budget.
- ESM import smoke, standalone IIFE VM smoke, `npm pack --dry-run`, `npm audit`, and `npm ls --omit=dev` all passed.

Security verdict: no high-confidence XSS, code execution, dependency vulnerability, or runtime supply-chain issue was found in the packaged library code. A new demo-only XSS issue exists in `examples/yfinance/index.html`: free-text `symbol` is interpolated into `legend.innerHTML`. This is not in the npm tarball, but it should be fixed before sharing that demo beyond a trusted local environment.

The biggest v3 finding remains open: `OpenAlgoLiveDataFeed` still creates an unseeded `CandleBuilder` and still does not pass through the WS socket factory, so the composed live feed can mishandle the history-to-live handoff and is hard to test offline.

The current honest release state remains: strong 0.1.0 pre-release, not production-complete. The main remaining blockers are browser/pixel E2E, a live OpenAlgo smoke test with real credentials, the composed live-feed handoff, stale release docs, and demo/security hygiene.

## Verification Matrix

| Check | Result | Evidence |
|---|---:|---|
| `git rev-parse --short HEAD` | Pass | `8f2f9bc` |
| `git status --short` before this file | Pass | Clean output. |
| `npm run verify` | Pass | Typecheck, tests, build, and size all passed. |
| Unit tests | Pass | 27 files, 215 tests. |
| Size limits | Pass | Base 16.68/17 KB, base+trade 21.52/22 KB, transform 3.83/5 KB, profile 2.33/4 KB, everything 27.69/50 KB Brotli. |
| ESM dist import smoke | Pass | Root/trade/transform/profile imported; `VERSION` was `0.1.0`; live/trade adapters and RSI/ATR/Supertrend exported. |
| Standalone IIFE smoke | Pass | `OpenAlgoCharts.VERSION === "0.1.0"`, `createChart` exists, and `supertrend` exists in a VM context. |
| `npm pack --dry-run` | Pass | `openalgo-charts-0.1.0.tgz`, 17 files, 165.2 KB package, 548.1 KB unpacked. |
| `npm audit --audit-level=moderate` | Pass | `found 0 vulnerabilities`. |
| `npm ls --omit=dev` | Pass | No runtime dependencies. |
| Security grep | Pass with demo finding | No packaged-library DOM/code execution issue found; yfinance demo has `legend.innerHTML` fed by free-text symbol. |
| Browser/pixel E2E | Not run | No Playwright/Puppeteer/browser pixel harness exists. |
| Live OpenAlgo smoke | Not run | No running OpenAlgo session, broker login, or credentials were available. |

## Delta Since Prior v3

Notable commits after `f13d317`:

- `4d7fe10` added the yfinance historical demo.
- `6b6601f` fixed real-browser module loading/MIME behavior for that demo.
- `bffd3fd`, `c4b37db`, and `c4189d5` improved crosshair behavior, labels, chart-type switching, screenshots, and grid toggles.
- `7f916a9` added RSI, ATR, and Supertrend.
- `37021c3`, `0940b66`, `17bdd94`, `bf536a1`, and `8f2f9bc` expanded demo chart trading: drag-to-modify, bracket panel, right-click order placement, short lines, OCO clarity, market fills, fill arrows, and position lines.
- `6e736c2` aligned the WS adapter with the newer OpenAlgo protocol docs.

## Verified v2 Fixes

| ID | v3 status | Verification notes |
|---|---|---|
| V2-H1 trade REST contract | Fixed | `OpenAlgoTradeFeed.place()` sends `strategy`, `product`, symbol/action/exchange/pricetype/quantity/price fields; `modify()` sends full cached order context; unknown modify throws; string numeric book fields are coerced. Covered by `tests/audit-v2-fixes.test.ts` and `tests/openalgo-adapters.test.ts`. |
| V2-H2 WS schema and send timing | Improved/fixed offline, live schema still needs smoke | `formatSubscribe()` now uses the newer documented single-symbol/numeric-mode schema and `OpenAlgoWsFeed` authenticates first, queues until open, parses nested `market_data`, handles ISO timestamps, and responds to ping. Exact OpenAlgo proxy behavior still requires live validation. |
| V2-M1 `subscribeBars` API trap | Fixed at interface level | `DataFeed.subscribeBars` is optional; `OpenAlgoDataFeed` is history-only; `OpenAlgoLiveDataFeed` exists. See new V3-H1 for live feed correctness/testability. |
| V2-M2 transform tier tree-shaking | Fixed | `package.json` lists transform side effects and `registerTransformChartTypes()` is exported and idempotent. |
| V2-M3 primitive lifecycle | Fixed | `Pane.destroy()` detaches primitives; `Chart.destroy()` calls it; lifecycle unit test added. |
| V2-L1 README stale numbers | Fixed in README | README now says 190+ tests and about 26 KB Brotli. Other docs remain stale; see V3-M3. |
| Architecture section 10.1 | Mostly fixed | It now notes `subscribeBars` is optional and names `OpenAlgoLiveDataFeed`; the code block still shows `subscribeBars` as required. |

## New / Remaining Findings

### V3-H1. `OpenAlgoLiveDataFeed` can corrupt the current candle at live handoff

Evidence:

- `docs/getting-started.md:34-35` shows the correct manual live path: create a `CandleBuilder` and call `builder.seed(lastHistoricalBar)`.
- `src/feed/openalgo-live.ts:47-49` creates a fresh `CandleBuilder` inside `subscribeBars()` and never calls `seed()`.
- If the last historical bar is the current interval and the first live tick lands in that same interval, `CandleBuilder` starts a new bar from that tick only. A downstream `series.update()` can replace the existing candle with incomplete OHLC/volume.
- The tests only cover `intervalToSeconds()` for this class; they do not instantiate `OpenAlgoLiveDataFeed` or simulate first-tick handoff.
- `OpenAlgoLiveDataFeed` also drops the lower-level WS testability hook: `OpenAlgoWsFeed` supports `socketFactory`, but `OpenAlgoLiveConfig` does not expose it and constructs `new OpenAlgoWsFeed({ url, apiKey })` directly.

Impact:

This is a real live-data correctness risk. It does not affect historical REST, the lower-level `OpenAlgoWsFeed`, or manual `CandleBuilder` usage, but it weakens the new composed feed that was added to close V2-M1.

Recommendation:

Add a seed path to the composed live feed before it emits bars. Conservative options:

- Accept an optional `lastBar` seed in `subscribeBars` or config and call `builder.seed(lastBar)`.
- Or add an async `subscribeBars` variant that calls `getBars(req)`, seeds from the last returned bar, then subscribes.
- Expose `socketFactory?: SocketFactory` on `OpenAlgoLiveConfig` and pass it through to `OpenAlgoWsFeed`.
- Add a fake-socket test where the first live tick in the same bucket updates a seeded historical bar instead of replacing it with tick-only OHLC.

### V3-H2. Browser/pixel E2E is still the largest release-validation gap

Evidence:

- The current test suite is strong for pure logic and fake DOM/canvas behavior, but no Playwright/Puppeteer browser harness exists.
- The new yfinance demo is a useful manual browser proof point, but it is not run by CI or an automated browser harness.
- `END_TO_END_AUDITv2.md`, README, and `ARCHITECTURE.md` all document this as deferred.
- The IIFE VM smoke verifies global exports, but it does not prove real DOM layout, canvas pixels, pointer events, device pixel ratio behavior, or example pages in a browser engine.

Impact:

For a canvas charting package, this remains the main blocker for a defensible production claim. Unit tests cannot catch many rendering, sizing, HiDPI, overlay, and pointer interaction regressions.

Recommendation:

Add a minimal Playwright suite before calling the package production-ready:

- Render the example chart at desktop and mobile viewports.
- Assert nonblank canvas pixels and stable dimensions.
- Exercise pan, wheel zoom, crosshair, pane hit-testing, right-click order menu, order-line drag, grid toggles, screenshot export, and destroy/remount.
- Add a small golden-pixel set for candles, lines, histograms, axes, crosshair, and a trade line at DPR 1 and 2.

### V3-H3. Live OpenAlgo adapter schemas still need a real smoke test

Evidence:

- Offline tests verify request bodies and WS helper shapes, but no test hit a running OpenAlgo server.
- README and architecture still correctly warn that exact WS/trade wire schemas must be verified against a running OpenAlgo build.
- The WS helper still sends `apikey` and `mode` along with `symbols`; local docs previously showed only `action` and `symbols` in the example. That may be accepted by the real proxy, but it is not proven here.

Impact:

The adapters are much closer than in v2, but production integration is not fully proven until a real server accepts history, live LTP/Quote/Depth subscriptions, order place/modify/cancel, orderbook, and positionbook end to end.

Recommendation:

Create a credential-gated smoke test script that is skipped by default and enabled with environment variables. It should verify:

- `/api/v1/history` payload with IST `start_date`/`end_date`.
- WS connect, subscribe, first LTP, first Quote, first Depth.
- Analyzer/paper order place, modify, cancel, orderbook, and positionbook mappings.
- No API key is logged in failures.

### V3-M1. Architecture doc still mixes current implementation with target design

Evidence:

- `ARCHITECTURE.md:17-19` says price/time axes are separate widgets and visible range is cached.
- `ARCHITECTURE.md:44-46` lists pinch zoom and percentage scale as current target features.
- `ARCHITECTURE.md:365-385` describes `percentage`, indexed-to-100, and overlay price scales as implemented design.
- `ARCHITECTURE.md:529-566` describes primitive price/time axis views and fixed axis labels.
- `ARCHITECTURE.md:888-907` correctly says browser/pixel E2E, percentage/indexed/overlay scales, pinch, separate axis widgets, primitive axis views, visible-range caching, and live adapter schema verification are deferred.

Impact:

The deferred section is honest, but readers can still come away believing the earlier design sections describe the current 0.1.0 implementation. This is a documentation accuracy issue, not a runtime bug.

Recommendation:

Add a short "Current 0.1.0 implementation status" table near the top of `ARCHITECTURE.md`, or tag each target-only section with "planned". Keep section 13a, but reconcile the earlier sections so they do not overstate shipped behavior.

### V3-M2. Release/documentation artifacts are stale in several places

Evidence:

- `package.json:3` is `0.1.0`, but `package-lock.json:3` and `package-lock.json:9` still say `0.0.0`.
- `docs/getting-started.md:4` says the full package is about 22 KB Brotli; fresh measured output is 26.11 KB.
- `CHANGELOG.md:7` also says about 22 KB Brotli.
- `docs/api/variables/index.VERSION.html` still documents `VERSION` as `0.0.0`.
- `docs/api/hierarchy.html` does not show `OpenAlgoLiveDataFeed`, so the generated API docs are from an older source state.

Impact:

Low to medium. The npm tarball is generated from `package.json` and `dist`, so runtime/package exports are correct. But stale lockfile metadata and generated docs are release hygiene problems and can confuse consumers or reviewers.

Recommendation:

- Run a lockfile-only refresh so the root lock metadata matches `0.1.0`.
- Regenerate TypeDoc after the current source changes.
- Update `docs/getting-started.md` and `CHANGELOG.md` to measured 26.11 KB or a less brittle "about 26 KB".

### V3-M3. Visible-range lookup remains linear despite architecture wording

Evidence:

- `src/model/data-layer.ts:136-143` builds `indexedBars(id)` and then linearly filters by index on every visible-range request.
- `src/core/pane.ts:134` and `src/core/pane.ts:185` call `visibleBars()` during autoscale and paint.
- `ARCHITECTURE.md:19` says indexed plot rows have cached visible range, and section 13a says binary-search visible-range caching is deferred.

Impact:

This is acceptable for the current demo/pre-release scale, but it is a known performance ceiling for large histories and multiple panes.

Recommendation:

For production-scale data, store per-series indexed rows and binary-search by logical index. Cache the last visible window per series and invalidate only when data or range changes.

## Security Review

### Confirmed security issues

No high-confidence security vulnerability was found in the current package code.

Specific checks:

- No `eval`, `new Function`, executable string timers, shell execution, cookie access, or package-code `postMessage` usage found.
- Example `innerHTML = ''` calls only clear known chart containers with a constant empty string; no user-controlled HTML injection path was found.
- Canvas text/data rendering does not insert untrusted feed values into the DOM.
- `npm audit --audit-level=moderate` reported 0 vulnerabilities.
- `npm ls --omit=dev` reported no runtime dependencies.
- `package.json` has no install lifecycle scripts (`preinstall`, `postinstall`, `prepare`) that would execute for consumers.

### V3-S1. Browser-side OpenAlgo API keys are a deployment risk

Evidence:

- `docs/getting-started.md:59` shows `OpenAlgoDataFeed({ baseUrl: 'http://127.0.0.1:5000', apiKey: 'YOUR_KEY' })`.
- `docs/getting-started.md:74` shows `OpenAlgoWsFeed({ url: 'ws://127.0.0.1:8765', apiKey: 'YOUR_KEY' })`.
- `src/feed/openalgo-rest.ts:86-97`, `src/feed/openalgo-trade.ts:53-56`, and `src/feed/openalgo-ws.ts:50-55` send the API key in REST/WS payloads.

Impact:

For a trusted local OpenAlgo UI, this is expected. For a public or multi-user browser app, embedding a live trading API key in JavaScript exposes it to every user of that page. If `http://` or `ws://` is used beyond localhost, the key and order payloads can also be exposed on the network.

Recommendation:

- Document the browser adapters as trusted-local/operator-ui adapters.
- For public or multi-user deployments, keep OpenAlgo API keys server-side and expose only a narrow backend proxy with per-user auth, authorization, CSRF protection where cookies are used, rate limits, and audit logging.
- Require HTTPS/WSS for non-localhost deployments.
- Do not let untrusted users control `baseUrl` or `wsUrl`; otherwise the app can leak its API key to an attacker-controlled endpoint.
- Ensure errors and logs redact `apikey`.

### V3-S2. Live trading needs explicit production safety controls outside this package

Evidence:

- The package has validation hooks and order-engine safeguards, but the adapter can still place/modify/cancel orders when configured with live credentials.
- The security boundary for auth, authorization, account selection, and API key storage is the integrating app/OpenAlgo deployment, not this canvas package.

Impact:

This is not a code vulnerability by itself, but it is a high-impact deployment concern because the trade tier can move real orders.

Recommendation:

Before production live trading:

- Prefer analyzer/paper mode by default.
- Gate live mode behind explicit user confirmation and server-side authorization.
- Apply server-side quantity, product, instrument, price-band, and order-type limits.
- Log order intent and broker responses with key redaction.
- Use short-lived/session-scoped credentials when possible.

## Deferred Scope Still Accepted

These remain documented deferrals and are not hidden defects:

- Browser/pixel E2E and example smoke tests.
- Live OpenAlgo smoke with broker credentials.
- Percentage, indexed-to-100, and overlay price scales.
- Multi-touch pinch.
- Binary-search/cached visible-range performance work.
- Primitive price/time axis views.
- Separate axis-widget canvases.

## Release Readiness Verdict

Status: strong 0.1.0 pre-release, not production-ready yet.

The original correctness/safety gaps from v1 and v2 are largely closed. The new concern is narrower: the composed `OpenAlgoLiveDataFeed` should not be treated as production-ready until it seeds live candles correctly and can be tested with an injectable socket. After that, the remaining production bar is validation breadth: browser/pixel E2E, real OpenAlgo smoke tests, and security-hardening guidance for deployments that expose trading features beyond a trusted local operator UI.
