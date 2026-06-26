# OpenAlgo Charts

A from-scratch, dependency-free HTML5-canvas charting engine for OpenAlgo:
professional-grade interactive financial-chart rendering plus advanced on-chart
trading and trade management. Target: **< 50 KB Brotli** for the full package.

> Status: **early development**. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the
> full design and the phased roadmap. This README tracks what is actually built.

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
