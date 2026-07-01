# Changelog

All notable changes to OpenAlgo Charts.

## 1.0.0

First public release. Full package ~38 KB Brotli (all tiers), base engine
~24 KB, zero runtime dependencies, Apache-2.0.

### Added since 0.1.0
- Indicators: RSI, ATR, Supertrend (Wilder semantics, matching `openalgo.ta`),
  alongside EMA.
- Interaction: vertical price pan (drag the plot up/down), `chart.resetScale()`
  + double-click/Fit, `priceToCoordinate` / `coordinateToPrice` for DOM overlays,
  and `subscribeCrosshairMove` for OHLC legends/tooltips.
- Touch: pinch-to-zoom and two-finger pan (`touch-action: none`).
- Accessibility: focusable container with `role`/`aria-label`, a polite live
  summary, and keyboard navigation (arrows pan, +/- zoom, Home/0 reset).
- `chart.takeScreenshot()` (composites all panes/layers) and runtime grid toggles.
- Footprint primitive upgraded: volume-graded bid×ask cells, diagonal-imbalance
  boxes, POC marker, per-bar delta/volume footer.
- Live feed: composed REST + WebSocket + candle-builder data feed; WS adapter
  speaks the documented OpenAlgo protocol (authenticate → numeric-mode subscribe →
  `market_data`), with connection/control callbacks.
- Examples: yfinance, order-flow, market-profile (TPO), and a full LIVE OpenAlgo
  demo (history + WebSocket + chart trading) - validated against a live instance.
- Unified event bus: `chart.on` / `off` / `once` (`crosshair:move`, `click`,
  `pan`, `zoom`, `resize`, `lazy-load`, `ready`), with `trading:*` mirrored through it.
- Data-driven trading visualization (`chart.trading`): position/order pills,
  TP/SL brackets, and fill markers (chevron / bubble / count).
- Custom formatting: `ChartOptions.priceFormatter` and `timeFormatter` (with
  runtime setters); per-pane `priceScale` options; the time axis is no longer IST-only.
- Flexible series input: `setData` accepts `Bar | LinePoint | Whitespace`
  (normalized via `toBar`); `series.getData()` reads the current bars.
- WebSocket auto-reconnect (backoff + re-auth + resubscribe); `OpenAlgoLiveDataFeed`
  bare `D`/`W` intervals, day-delta volume, and symbol+exchange tick filtering.
- Docs site: an interactive example gallery (chart type, themes, tooltips, event
  markers, live streaming) plus framework-integration, mobile, data-loading,
  events, types, constants, and glossary pages.

### Fixed
- Multi-series `DataLayer.update`: a series-local append that is not the global
  newest no longer corrupts the shared time-axis order.
- Package ships `NOTICE` (Apache-2.0); the accessible summary refreshes on live
  updates; `visibleBars` uses binary search for large datasets.
- `OpenAlgoDataFeed`/`OpenAlgoTradeFeed`: bind the global `fetch` (browser
  "Illegal invocation").
- WebSocket subscribe schema corrected to the documented per-symbol numeric-mode
  protocol.
- `modifyorder` sends the required `disclosed_quantity`.
- `mapOrder`: `trigger_price: 0` → `undefined` so LIMIT order lines render at the
  price, not 0.

### Quality
- 297 unit tests (39 files) + a Playwright real-browser smoke suite; GitHub
  Actions CI runs typecheck, unit, build, size budgets, a docs-site build, a
  NOTICE pack check, and the E2E smoke on every push/PR.

## 0.1.0 (initial development build)

First end-to-end build of the engine. Dependency-free, ~22 KB Brotli for the
full package (all tiers).

### Engine (base tier)
- HiDPI canvas layout (base + top canvas per pane), render loop, per-pane
  invalidation mask, resize handling.
- Shared DataLayer (merge-by-time → logical indices) keeping all panes aligned;
  gapless time axis (weekends/holidays/session breaks collapse).
- Time scale (index↔x, pan, cursor-anchored zoom, kinetic flick, fit-content)
  and price scale (linear, autoscale, tick-size formatting/snap).
- Internal time = UTC seconds; IST/epoch conversion at the feed edge.
- Live candle builder (session-aligned bucketing, ltq-sum vs cumulative-day
  volume, late-tick policy, history→live seam) + last-price line.
- Chart-type registry with all standard styles: bars, candles, hollow,
  volume-candle, line, line+markers, step, area, HLC-area, baseline, columns,
  histogram.
- Primitive/plugin API (views, z-order, hit-test, autoscale, lifecycle) powering
  markers (buy/sell signals + shapes, four sizes), event badges
  (earnings/dividend/split), and price lines.
- EMA indicator; OpenAlgo REST data adapter; deterministic fake feed.
- Optional OHLC-preserving conflation for very large datasets.

### Transform tier
- Heikin Ashi, Renko, Range bars, Line Break (render as candles); Point &amp;
  Figure and Kagi (custom renderers). Incremental for live updates.

### Trade tier
- Read: order/position/bracket primitives + live P&amp;L; book reconciliation with
  reconnect-stale handling.
- Write: order state machine, tick/price-band/freeze validation, arm/confirm
  gate, idempotency, rate-limited drag-modify, OCO, analyzer mode.
- Depth-of-market ladder: depth-agnostic (5→200 levels), virtualized,
  price-bucket aggregation, size heatmap, click-to-place, graceful degradation.

### Profile tier
- Volume Profile (POC + value area), Market Profile / TPO (+ initial balance),
  Footprint (bid/ask delta + imbalance), order flow (cumulative delta + stacked
  imbalance). Footprint/order flow require classified trade data.

### Tooling
- TypeScript, Rollup multi-entry build, `size-limit` (Brotli) budgets per tier,
  154 unit tests (incl. a recording-canvas harness for renderers).
