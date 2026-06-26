# OpenAlgo Charts

A from-scratch, dependency-free HTML5-canvas charting engine for OpenAlgo:
professional-grade interactive financial-chart rendering plus advanced on-chart
trading and trade management. Target: **< 50 KB Brotli** for the full package.

> Status: **pre-release (0.1.0)** — all 12 build phases of the engine are
> implemented (standard chart types, transforms, trade terminal, depth ladder,
> profiles) with 170+ unit tests, full package **~24 KB Brotli**. See
> [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`docs/getting-started.md`](./docs/getting-started.md),
> and [`examples/index.html`](./examples/index.html).
>
> **Known limitations (not yet production-complete):** the OpenAlgo WS/trade
> adapters ship but their exact message/endpoint schemas must be verified against
> your running OpenAlgo build; there is **no real-browser/pixel test suite yet**
> (logic is covered by a recording-canvas harness); multi-touch pinch, separate
> axis-widget canvases, and overlay/indexed-to-100 price scales are not
> implemented. See [`END_TO_END_AUDIT.md`](./END_TO_END_AUDIT.md) for the full list.

## What's built

- **Chart types:** candles, hollow/volume candles, bars, high-low, line,
  line+markers, step, area, HLC-area, baseline, columns, histogram.
- **Transforms:** Heikin Ashi, Renko, Range bars, Line Break, Point &amp; Figure, Kagi.
- **Profiles &amp; order flow:** Volume Profile, Market Profile (TPO), Footprint, cumulative delta.
- **Trading:** order/position/bracket lines, live P&amp;L, one-click + drag-to-modify,
  OCO, validation, analyzer mode, and a depth-of-market ladder (5→200 levels).
- **Live + historical** data, markers/signals, earnings/dividend events, EMA indicator.

## Install (once published)

```bash
npm install openalgo-charts
```

Loadable tiers (lazy-load only what you use):

- `openalgo-charts` — base engine + all standard chart types
- `openalgo-charts/trade` — on-chart order/position/bracket tools + DOM ladder
- `openalgo-charts/transform` — Renko, Range bars, Point & Figure, Kagi, Line Break, Heikin Ashi
- `openalgo-charts/profile` — Volume Profile, Market Profile (TPO), Footprint, Orderflow

## Develop

```bash
npm install        # install dev toolchain
npm run typecheck  # strict TypeScript check
npm test           # unit tests (vitest)
npm run build      # Rollup → dist/ (minified ESM per tier + types)
npm run size       # size-limit (Brotli) against the budget
npm run verify     # all of the above
```

## Principles

- **Single canvas pipeline** (no SVG, no DOM-per-bar) — small and fast.
- **Gapless time axis by default** — weekends, holidays, and session breaks collapse.
- **Zero runtime dependencies** — nothing is excluded from the size budget.
- **Apache-2.0**, original code.

## License

[Apache-2.0](./LICENSE).
