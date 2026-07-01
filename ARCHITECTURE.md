# OpenAlgo Charts - Architecture & Design Document

> A from-scratch, canvas-based financial charting engine for OpenAlgo.
> Target: **< 50 KB Brotli** for the full package (engine + trade overlay), no runtime dependencies. *(Brotli is the size metric we hold the budget against - see §11. Gzip runs ~10-15% larger.)*
> Goal: professional-grade interactive financial-chart rendering + advanced on-chart trading & trade management.

> **Status: shipped as 1.0.1.** The design below is implemented and published to npm. The pre-implementation size estimates have been superseded by measured `size-limit` (Brotli) budgets: **base engine ~24 KB, base+trade ~29 KB, transform ~4 KB, profile ~6 KB, everything ~38 KB** against a 50 KB budget. See the *Revision log* for the point-by-point mapping and §13a for the honest deferred list.

<p align="center">
  <img src="docs/architecture-diagram.png" alt="OpenAlgo Charts layered architecture" width="900" />
</p>

---

## 0. Why from scratch (and the principles we follow)

We are writing our own engine from scratch, with no external charting dependency. We deliberately follow the well-established design principles that make minimal canvas charting engines small and fast, because they are the right ideas:

| Principle we adopt | Why |
|---|---|
| **Base + top canvas per pane** (no SVG, no DOM-per-bar), price/time axes as separate widgets | The single biggest size + perf lever. The two-canvas split (data vs cursor/overlay) is what makes crosshair cheap. See §3.1. |
| **Shared data/time layer** merging all series by time → logical indices | Keeps price + volume + indicator panes perfectly aligned on one x-axis. See §4. |
| **Indexed plot rows with cached visible range** | O(log n) visible-range lookup; redraw cost scales with *visible* bars, not total bars. |
| **Bitmap vs media coordinates** | Draw in device pixels so 1px lines stay crisp on HiDPI/retina without blur. |
| **Per-pane invalidation mask** (global level + per-pane + time-scale ops) | Crosshair move must NOT trigger a full data redraw; one indicator pane recomputing must not repaint the others. See §3.2. |
| **Renderers are pure functions of draw-data** | Renderer takes a plain data object + canvas context, draws, returns. No state, easy to test, tree-shakeable. |
| **Primitive/plugin extension API** with views + lifecycle + z-order + hit-test | The trade layer (order lines, DOM ladder) and markers/events are *primitives*, not hardcoded — keeps core lean. See §8. |

What we explicitly **leave out** to hit the size budget: yield-curve charts, options-mode chart, multiple horizontal-scale behaviors, full i18n, watermark plugins. **We keep line/area/baseline/HLC-area** — they're cheap Family-A renderers (see §6A) and are in the requested type list. Heavy chart types (footprint/orderflow/profile) and the trade layer are opt-in tiers (§2).

### 0.1 Licensing & attribution (decision — locked)

**OpenAlgo Charts is released under Apache-2.0.** This is the project's chosen license:

- **Permissive by design.** Apache-2.0 is permissive (not copyleft) — it imposes no copyleft obligation on users of the library, and incorporating any compatibly-licensed third-party routine is straightforward.
- **Default stance: clean-room, original code.** We write our own implementation from documented design principles; we don't copy/paste third-party source or line-by-line port another library's renderers. This keeps the codebase genuinely ours.
- **If any third-party (Apache-2.0 or compatibly licensed) code is ever incorporated** (e.g. a tricky tick-mark or coordinate-snapping routine), §4 obligations are met by preserving that code's copyright/license headers and adding a `NOTICE` entry crediting its original authors. No relicensing needed.
- **Shipping requirements:** include our `LICENSE` (Apache-2.0), a `NOTICE` file listing any third-party attributions, and preserve attribution headers. The `NOTICE` is created in Phase 0 and maintained as code lands.

Net: Apache-2.0 keeps the project permissive *and* lets us incorporate a hard algorithm with attribution if it's ever the pragmatic choice, without a clean-room purity constraint.

---

## 1. Goals & constraints

### Functional
- Candlestick / line / histogram (volume) series, multi-pane (price pane + volume pane + indicator panes).
- Smooth pan, wheel-zoom, pinch-zoom, kinetic flick scrolling, double-click to reset.
- Crosshair with synced price-axis & time-axis labels; OHLC legend.
- Autoscale price (linear / log / percentage), fixed scale, fit-content.
- Live updates: append/replace the last bar at tick speed (60 fps) without GC churn.
- **Chart trading**: drag-to-place order lines, position marker with live P&L, SL/TP bracket lines, one-click buy/sell, DOM ladder, OCO visualization.
- Indicator overlays (EMA/VWAP/Bollinger as line/band primitives) and sub-pane indicators (RSI/MACD).

### Non-functional
- **< 50 KB Brotli** total (engine + trade overlay). Stretch: < 30 KB Brotli engine-only. *(All size numbers in this doc are Brotli. These are estimates until the Phase 1 prototype is measured — see §11.)*
- Zero runtime dependencies. We write our own HiDPI canvas sizing (~30 lines) rather than pulling a separate canvas-sizing helper package, so nothing is excluded from the size measurement.
- TypeScript source, ESM output, tree-shakeable, framework-agnostic (works in plain JS, React wrapper optional).
- 60 fps with 50k bars loaded, 1.5k visible.
- Works in OpenAlgo's existing frontend (it can be dropped into any page; React/HTMX/vanilla all fine).

### Size accounting rule
We measure **Brotli** bytes via `size-limit` in CI. Every PR that grows the Brotli size is flagged. Raw-minified ≈ 3–3.5× the Brotli number; gzip ≈ 1.1–1.15× Brotli. Brotli is what most CDNs/servers actually serve and is the metric we hold the budget against.

---

## 2. Module map & size budget

Directory layout under `openalgo-charts/src/`:

```
src/
├── index.ts                 # public API surface (createChart, addSeries, …)
├── core/
│   ├── canvas.ts            # HiDPI canvas pair (media+bitmap), resize observer
│   ├── render-loop.ts       # rAF scheduler + invalidate mask
│   ├── chart.ts             # top-level orchestrator (owns panes, scales, model)
│   └── pane.ts              # a stacked drawing region (price pane, volume pane…)
├── model/
│   ├── data-store.ts        # shared DataLayer: merge-by-time, logical indices, prepend/merge (§4)
│   ├── bar.ts               # bar/point types, plot-row shape
│   └── series.ts            # one series (data + style + which renderer)
├── scale/
│   ├── time-scale.ts        # index↔x mapping, bar spacing, tick marks, pan/zoom state
│   ├── price-scale.ts       # price↔y mapping, linear/log/percent, autoscale
│   └── ticks.ts             # "nice number" tick generation (shared)
├── render/
│   ├── candles.ts           # candle / hollow / volume-candle / heikin-ashi
│   ├── bars.ts              # OHLC bars + high-low
│   ├── line.ts              # line / line+markers / step / area / HLC-area / baseline
│   ├── histogram.ts         # volume / columns
│   ├── crosshair.ts         # crosshair lines + magnet
│   ├── grid.ts              # background grid
│   └── axis.ts              # price-axis & time-axis label rendering
├── transform/               # ← Family B: price/movement-driven series (opt-in)
│   ├── transform.ts         # ISeriesTransform interface + pipeline
│   ├── heikin-ashi.ts       # 1:1 smoothed candles
│   ├── renko.ts             # brick series (fixed / ATR box size)
│   ├── range-bars.ts        # new bar every N ticks of range
│   ├── point-figure.ts      # X/O column series
│   ├── kagi.ts              # reversal line (thick/thin)
│   └── line-break.ts        # N-line break
├── profile/                 # ← Family C: price×{vol|time|bid-ask} (separate bundle)
│   ├── volume-profile.ts    # volume-at-price (session / visible / fixed range)
│   ├── tpo.ts               # Time Price Opportunity / Market Profile
│   ├── footprint.ts         # per-candle bid/ask cells + delta + imbalance
│   └── orderflow.ts         # cumulative delta, stacked imbalance overlays
├── input/
│   ├── pointer.ts           # unified mouse/touch/pointer events
│   ├── pan-zoom.ts          # drag-pan, wheel-zoom, pinch, kinetic
│   └── hit-test.ts          # what's under the cursor (for primitives)
├── primitives/
│   ├── primitive.ts         # IPrimitive interface (the extension point)
│   ├── price-line.ts        # horizontal line at a price (base for orders/SL/TP)
│   ├── markers.ts           # buy/sell signals + shapes (tiny/small/medium/big)
│   └── event-markers.ts     # Earnings / Dividend / Split badges (time-axis strip)
├── trade/                   # ← the advanced trade-management layer (separate entry point)
│   ├── order-line.ts        # draggable working-order line
│   ├── position.ts          # position marker + live P&L + breakeven
│   ├── bracket.ts           # SL/TP/OCO bracket group tied to a position
│   ├── dom-ladder.ts        # vertical price ladder (DOM) docked to right axis
│   └── trade-controller.ts  # binds gestures → OpenAlgo REST/WS order calls
├── feed/
│   ├── openalgo-rest.ts     # history + books + orders (REST adapter, §10)
│   ├── openalgo-ws.ts       # live tick/quote/depth subscription
│   └── candle-builder.ts    # ticks/quotes → interval OHLC (§10.2)
```

> **model/ note:** `data-store.ts` is the *shared* DataLayer (merges all series by time → logical indices), not a per-series store — see §4. Per-series plot rows hang off it.

### Size budget (raw minified → est. Brotli)

> **Methodology (point of record):** numbers are **Brotli-compressed**. Since we have zero runtime dependencies, nothing is excluded from the measurement. Raw-minified ≈ 3–3.5× the Brotli figure; gzip ≈ 1.1–1.15× Brotli. **All figures below are pre-implementation estimates** and the first deliverable of Phase 1 is to wire `size-limit` and replace them with measured values.

We split the package into **three loadable tiers** so the base stays tiny and heavy chart types are opt-in (dynamic `import()` / separate entry points). This is the key to keeping the <50 KB promise while supporting footprint/TPO/orderflow.

**Tier 1 — Base bundle (always loaded):**

| Module | Raw min | Brotli (est.) |
|---|--:|--:|
| core (canvas, render-loop, chart, pane) | 7 KB | 2.4 KB |
| model (shared data-layer, bar, series, candle-builder) | 9 KB | 3.0 KB |
| scale (time, price + edge cases, ticks; incl. ordinal mode) | 14 KB | 4.6 KB |
| render — all Family-A types: bars, candles, hollow, volume-candle, line, line+markers, step, area, HLC-area, baseline, columns, high-low, crosshair, grid, axis | 16 KB | 5.2 KB |
| input (pointer, pan-zoom, hit-test) | 8 KB | 2.6 KB |
| primitives (base + price-line + markers + event-markers) | 5 KB | 1.7 KB |
| feed (rest + ws + candle-builder wiring) | 4 KB | 1.4 KB |
| **Tier 1 subtotal** | **~63 KB** | **~21 KB Brotli** |

**Tier 2 — Trade layer (opt-in, `openalgo-charts/trade`):**

| trade (order-line, position, bracket, dom-ladder, controller, state machine) | 16 KB | 5.2 KB |

**Tier 3 — Advanced chart types (each lazy-loaded only when selected):**

| Module | Raw min | Brotli (est.) |
|---|--:|--:|
| transform/ (Family B: heikin-ashi, renko, range, P&F, kagi, line-break) | 9 KB | 3.0 KB |
| conflation/downsampling (optional, §4.4) | 3 KB | 1.0 KB |
| profile/ volume-profile + tpo | 7 KB | 2.3 KB |
| profile/ footprint + orderflow | 10 KB | 3.4 KB |

**Verdict (estimates, to be confirmed by measurement):**
- **Base chart ≈ 21 KB Brotli** — well inside budget for the full set of standard chart types, because we ship fewer base features and lazy-load the heavy ones.
- **Base + trade layer ≈ 26 KB Brotli** — under 50 KB with headroom.
- **Everything (all tiers) loaded at once ≈ 36 KB Brotli** — *still* under 50 KB, and in practice footprint/orderflow code only downloads when selected.

(We get a wide range of chart types in a small base size by lazy-loading the advanced ones. **These ratios are the design intent; the prototype's measured `size-limit` output is the source of truth.**)

---

## 3. The core engine

### 3.1 DOM & canvas layout model (`core/canvas.ts`, `core/pane.ts`)

**Explicit layout.** The chart is a grid of rows (panes) × columns (left axis | pane cell | right axis). **Each pane cell holds *two* stacked canvases**, and each price-axis cell and the shared time-axis row hold their own canvas:

```
chart container (CSS grid)
├── pane row 0 (price)     [ left-axis canvas | pane: base + top canvas | right-axis canvas ]
├── pane separator (drag to resize)
├── pane row 1 (volume)    [ left-axis canvas | pane: base + top canvas | right-axis canvas ]
├── pane row 2 (RSI)       [ left-axis canvas | pane: base + top canvas | right-axis canvas ]
└── time-axis row          [   (corner)       | time-axis canvas        | (corner)          ]
```

- **base canvas** — grid, series, indicator lines, static primitives. Repainted only on `Light`/`Full`.
- **top canvas** — crosshair, hover highlights, primitives being dragged (order lines), magnet. Repainted on `Cursor` (cheap).
- **price-axis widgets** (left/right) and the **time-axis widget** are separate canvases with their own draw passes, so an axis-label change doesn't force a pane repaint and vice-versa.

Each canvas has two coordinate systems:
- **media size** = CSS pixels (what you reason about: "draw at x=100").
- **bitmap size** = `media × devicePixelRatio` (the real backing buffer).

```
class CanvasLayer {
  el: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  dpr: number          // window.devicePixelRatio
  mediaW, mediaH       // CSS px
  bitmapW, bitmapH     // device px = media * dpr

  resize(w, h) {
    this.mediaW = w; this.mediaH = h
    this.dpr = devicePixelRatio
    this.el.style.width  = w + 'px'
    this.el.style.height = h + 'px'
    this.el.width  = bitmapW = round(w * dpr)
    this.el.height = bitmapH = round(h * dpr)
  }
}
```

**Two scopes for drawing:**
- *Media scope*: `ctx.scale(dpr,dpr)` applied → draw in CSS px (text, anti-aliased fills).
- *Bitmap scope*: no scaling → draw in device px, snap line edges to integer pixels for crisp 1px lines (candles, grid, crosshair). This integer-snapping is what keeps lines sharp instead of blurry on HiDPI displays.

A single `ResizeObserver` on the container drives `resize()`. We inline the ~30 lines of HiDPI sizing rather than depend on a separate package.

### 3.2 Render loop & invalidation (`core/render-loop.ts`, `core/invalidate-mask.ts`)

The central trick for performance: **never redraw more than necessary.** A single global level is too coarse for multi-pane indicators and trade overlays (review point 2). The mask is a **global level + a per-pane map + a queue of time-scale operations.**

```ts
const enum Level { None = 0, Cursor = 1, Light = 2, Full = 3 }

interface PaneInvalidation { level: Level; autoScale?: boolean }   // per-pane, merges by max + OR

type TimeScaleOp =                       // queued, applied before paint
  | { type: 'fitContent' }
  | { type: 'applyRange'; range: LogicalRange }
  | { type: 'applyBarSpacing'; value: number }
  | { type: 'applyRightOffset'; value: number }
  | { type: 'reset' }
  | { type: 'animationStart'; anim: ITimeScaleAnimation }   // smooth scroll/zoom
  | { type: 'animationStop' }

class InvalidateMask {
  globalLevel: Level
  panes: Map<paneIndex, PaneInvalidation>   // a pane can be invalidated without touching others
  timeScaleOps: TimeScaleOp[]
  merge(other): void                         // coalesce multiple invalidations in one frame
}
```

Semantics:
- **Per-pane invalidation** — recomputing the RSI pane raises *its* entry only; the price and volume panes keep their cached draw-data and aren't repainted. An indicator finishing a calc, or one pane's autoscale changing, is local.
- **`autoScale` flag per pane** — separates "rescale this pane's price axis" from "repaint at current scale," so a new data point that doesn't change the range skips the autoscale pass.
- **Time-scale ops are a queue, not a level** — fit-content, apply-range, bar-spacing, right-offset, reset, and **animations** (kinetic scroll, smooth zoom) are discrete operations applied to the shared time scale before painting. Animations re-arm the next frame until `finished()`.
- `chart.invalidate(mask)` merges into the pending mask and schedules one rAF; multiple calls per frame coalesce.

```
function frame(now) {
  applyTimeScaleOps(mask.timeScaleOps, now)         // incl. stepping animations
  if (mask.globalLevel >= Full) recomputeAllScalesAndTicks()
  for (const [p, inv] of mask.panes) {
    if (inv.autoScale) recomputePaneAutoscale(p)
    if (inv.level >= Light) paintPaneBase(p)        // grid, series, indicators
    if (inv.level >= Cursor) paintPaneTop(p)        // crosshair, dragging primitives
  }
  paintAxes(dirtyAxes)
  if (anyAnimationActive) scheduleNextFrame()
  mask = empty
}
```

This lets a live tick (Light on the price pane only), an RSI recompute (Light on the RSI pane only), and a crosshair sweep (Cursor on the hovered pane) all coexist without any of them forcing a full multi-pane repaint.

### 3.3 Chart & Pane orchestration — panes stay in sync

- `Chart` owns: the **single shared time scale** + shared `DataLayer` (§4), an ordered list of `Pane`s, the input manager, the invalidate mask, and the primitive list.
- `Pane` owns: its own price scale(s), its series, its base+top canvases, its axis widgets, and a height (resizable via pane separators).
- **Top (price) pane and bottom (volume/indicator) panes are always x-synced.** This is structural, not bookkeeping: every series across every pane writes into the *one* `DataLayer`, which assigns a single set of **logical indices** shared by all of them. The shared time scale maps that one index space → x. Therefore:
  - Pan/zoom changes the shared time scale once → every pane's x-axis moves together, bar-for-bar aligned, by construction.
  - The crosshair's vertical line and time label are computed from the shared time scale, so hovering bar *i* highlights bar *i* in **all** panes simultaneously.
  - A volume bar is guaranteed under its candle because they share the same logical index, even with whitespace/holidays (gapless, §5.3).

There is no "sync the panes" code path that could drift — alignment falls out of the single shared index space.

---

## 4. Data model — shared DataLayer + per-series rows

### 4.0 Time representation (single internal model) — review point 6

OpenAlgo hands us time in **two formats**: REST history returns **IST date/time strings** (and/or epoch depending on endpoint), while the WS feed returns **epoch milliseconds**. Mixing them is a bug factory. So we define one internal representation and convert at the edges:

- **Internal time = `UTC seconds`** (integer). One number, sortable, timezone-free, what scales and the DataLayer operate on.
- **`originalTime` is preserved** on every data item — the exact value the caller passed in, returned untouched in API callbacks/markers so round-tripping never loses precision or format.
- **Display timezone is separate** from storage. Axis labels and the crosshair format `UTC seconds → IST` (default `Asia/Kolkata`, configurable) at render time only. Storage never shifts by timezone.

Conversion rules (in `feed/`, never in the core):
- REST IST string → parse as IST → `UTC seconds`. (Be explicit about the IST offset; do not rely on the host machine's locale.)
- WS epoch ms → `floor(ms / 1000)` → `UTC seconds`.
- Intraday bar timestamps are the **bar-open** time, bucketed by the candle builder (§10.2).

### 4.1 Shared DataLayer (`model/data-store.ts`) — review point 3

The store is **not per series.** There is one `DataLayer` per chart that merges *all* series (price, volume, every indicator, across every pane) onto a single time axis. This is what guarantees pane sync (§3.3) and correct alignment of price + volume + indicators.

```ts
class DataLayer {
  // one sorted, de-duplicated set of time points across ALL series → logical indices 0..N-1
  private _sortedTimes: number[]                    // UTC seconds, the shared index space
  private _pointByTime: Map<UTCSeconds, TimePointData>   // merge bucket per time
  private _rowsBySeries: Map<Series, PlotRow[]>     // per-series rows aligned to logical index
  private _baseIndex: number                        // logical index of the latest *real* bar
  // whitespace: a time can exist (for alignment) with no value for some series → gap-free axis,
  // but that series simply isn't drawn at that index.

  setSeriesData(series, items): DataUpdateResponse  // bulk; re-merges time points
  update(series, item): DataUpdateResponse          // single point (live); see §4.2
  prependData(series, older): DataUpdateResponse     // history paging; see §4.2
}
```

Key responsibilities:
- **Merge by time → assign logical indices.** Each distinct timestamp across all series gets one logical index; every series maps its data onto that shared index. Adding an indicator that only has values for some bars uses **whitespace** for the rest, so it stays aligned without inventing bars.
- **`baseIndex`** tracks the latest real bar so "scroll to realtime," right-offset, and the last-price line all reference one anchor.
- Per-series `PlotRow[]` are the index-addressable arrays the renderers actually read (the old "indexed OHLC store" idea, now *derived from* the shared layer rather than owned per series).

Why index-based throughout: the time scale maps **logical index → x** linearly. Pan/zoom is O(1) per bar, and non-trading gaps (weekends/holidays/lunch) collapse because absent times simply have no logical index (§5.3).

### 4.2 Data mutation API (review point 4 — prepend / merge / out-of-order)

`setData()` + `update(last)` alone can't express history paging or corrections. Full contract:

| Method | Use | Semantics |
|---|---|---|
| `setData(series, bars)` | Initial/bulk load, full replace | Re-merge time points; recompute logical indices; autoscale + fit. |
| `update(series, bar)` | Live tick (hot path) | `time == lastTime` → **mutate last row in place** (no alloc). `time > lastTime` → **append**, advance `baseIndex`, maybe auto-scroll. `time < lastTime` → **out-of-order correction** (see below). |
| `prependData(series, older)` | Lazy history paging on left-pan | Insert older bars **before** index 0; **shift all logical indices** by the inserted count; **preserve the viewport** by adjusting `rightOffset`/range so the screen doesn't jump. Re-merge time points with existing series. |
| `mergeRange(series, bars)` | Backfill / replace an arbitrary window | Upsert by time within `[from,to]`; reconcile indices; used for gap-fill after reconnect. |

**Out-of-order / late ticks & corrections:** a tick whose time is older than the last bar (late print, exchange correction, reconnect replay) is **upserted by time** into the correct bucket, not appended. The candle builder (§10.2) defines the *policy* (accept within the current bar, reject older than a threshold, or fold into the matching historical bar). The DataLayer just guarantees the merge stays sorted and indices stay consistent. After any prepend/merge, primitives and the trade layer re-anchor to *time*, not to a frozen index, so order/position lines don't drift when indices shift.

### 4.3 Series (`model/series.ts`)

A series is `{ rows: PlotRow[] (in DataLayer), style, kind, priceScaleId, paneIndex }`. `kind` selects the renderer (via the chart-type registry, §6A). Series contribute autoscale info (min/max over the visible logical range, plus any primitive `autoscaleInfo`) to their pane's price scale.

### 4.4 Conflation / downsampling (optional layer) — review point 7

When zoomed far out, many bars map to **sub-pixel** widths; drawing all of them is wasted work. We add an **optional, OHLC-preserving** conflation layer so 50k+ bars (and future larger datasets) stay 60 fps:

- **Trigger** — when effective bar width < ~0.5 px (scaled by a `conflationFactor`, e.g. 1.0–8.0, where higher = more aggressive smoothing).
- **OHLC-preserving merge** — each conflated bucket keeps `open` = first, `close` = last, `high` = max, `low` = min, `volume` = sum. The candle/bar shape is preserved, just at coarser granularity — never a lossy average.
- **Lives in `model/conflation/`**, built *over* the DataLayer rows; the renderer reads the conflated view when active, the raw rows otherwise. Off by default; turning it on changes nothing visible until you're zoomed out past the threshold.
- Family B (Renko/Range/etc.) and profiles opt out — they have their own aggregation semantics.

---

## 5. Scales — the coordinate math

### 5.1 Time scale (`scale/time-scale.ts`)

State: `barSpacing` (px per bar), `rightOffset` (how many bars of empty space on the right). Mapping:

```
indexToX(i)  = round((i - rightVisibleIndex) * barSpacing + width)   // bitmap-snapped
xToIndex(px) = rightVisibleIndex + (px - width) / barSpacing
```

- **Pan** = change `rightOffset` by `dx / barSpacing`.
- **Zoom** = change `barSpacing` around a focus index (the cursor), clamped to `[minBarSpacing, maxBarSpacing]`.
- **Tick marks**: pick a "nice" stride (1, 2, 5, 10, 30 min; hourly; daily; monthly) based on `barSpacing` and the bars' interval; label boundaries (new day → show date, else show time). NSE-aware: day boundaries and session opens get emphasis.

### 5.2 Price scale (`scale/price-scale.ts`)

Three modes (`linear`, `logarithmic`, `percentage`). Linear mapping:

```
priceToY(p) = height * (1 - (p - min) / (max - min))      // + margins
yToPrice(y) = min + (1 - y/height) * (max - min)
```

Log uses `log10(p)`; percentage normalizes to the first visible bar. **Autoscale**: each frame (on Full or a pane `autoScale` flag), gather min/max `low`/`high` over the visible logical range from each series **plus each primitive's `autoscaleInfo`** (so order/SL/TP lines and indicator bands are never clipped), add top/bottom margins, and snap the range to nice tick boundaries via `scale/ticks.ts`.

`ticks.ts` implements the classic "nice number" algorithm (round step to 1/2/2.5/5 × 10ⁿ) shared by both axes.

#### 5.2.1 Price-scale features & edge cases (review point 9)

These directly affect Indian instruments, options, MCX, label correctness, and order-line snapping — so they're first-class, not afterthoughts:

- **Tick size / `minMove` + `precision`** — every instrument has a tick (e.g. 0.05 for many NSE stocks, 0.01, 0.10; MCX varies). Drives price formatting *and* order-line snapping: a dragged SL/TP rounds to the nearest valid tick. Sourced per symbol (from instrument metadata, §10).
- **Price formatters** — pluggable `formatPrice(p)`: default decimal by precision, plus percent and custom (e.g. paise, lots, bps). Currency/grouping for ₹ labels.
- **Scale modes** — `linear`, `logarithmic`, `percentage`, and **indexed-to-100** (rebase visible series to 100 at the left edge — comparison mode). **Inverted scale** (flip y, for spreads/short views).
- **Margins & padding** — configurable top/bottom scale margins (fraction), and **edge tick padding** so the top/bottom labels aren't clipped at the pane border.
- **Custom visible price range** — pin the scale to an explicit `[min,max]` (disable autoscale) or set it programmatically; needed for fixed-grid views and replay.
- **Multiple / overlay price scales** — `priceScaleId` lets several series share or split scales: right scale (price), left scale (e.g. a second instrument), and **overlay scales** (volume drawn in the *same* pane as price but on its own hidden scale). Each pane can host a main scale + N overlay scales.
- **Label collision rules** — axis labels (ticks, last price, crosshair, order lines, alerts) compete for vertical space. A label-layout pass de-overlaps them (priority order: crosshair > order/position lines > last price > regular ticks), hiding or nudging lower-priority labels.

### 5.4 Time-scale features & edge cases

- **`fitContent` / `setVisibleRange` / `setVisibleLogicalRange` / `scrollToRealtime`** as explicit time-scale ops (queued via the invalidate mask, §3.2).
- **Right offset** (empty bars after the last) and **bar-spacing clamp** `[min,max]`.
- **Animations** — kinetic scroll decay and smooth zoom/scrollToPosition run as time-scale animations stepped each frame.
- **Whitespace handling** — times that exist for alignment but carry no value for a series don't break tick generation.

### 5.3 Non-trading gaps — gapless by default (locked decision)

**The chart NEVER shows gaps for non-trading time. This is the default and there is no setting to undo it.** Weekends (Sat/Sun), market holidays, and intraday session breaks (e.g. NSE 15:30→09:15) all collapse to nothing.

This is not a feature with logic behind it — it falls straight out of the **index-based** time scale. Because x is `index × barSpacing` and there is **no bar row** for any non-trading period, there is no slot to leave blank. Friday's candle is pixel-adjacent to Monday's; a holiday Wednesday's candle is adjacent to Tuesday's and Thursday's. No holiday calendar, no `get_holidays` call, and no "hide gaps" toggle are involved — gaps are *structurally impossible* in the default path.

Consequences to honor in the implementation:
- The time-axis tick logic reads each bar's real timestamp **only to choose labels** (new day → show date), never to position bars. A weekend boundary shows the date jump (Fri→Mon) at adjacent pixels — correct and expected.
- Live mode appends Monday's first bar right after Friday's last with no spacer, since the tick bucket simply differs.
- A *"show real gaps"* mode (time-proportional axis) remains possible as an explicit opt-in **later**, relevant only for 24/7 instruments (crypto). For all NSE/BSE/MCX equities, F&O, and commodities it stays off forever.

---

## 6. Renderers

Each renderer is a pure-ish function: `(ctx, drawData, scope) => void`. No internal state beyond style caches. This keeps them independently tree-shakeable (importing only `LineSeries` shouldn't pull candle code).

- **candles.ts**: compute `barWidth = optimalBarWidth(barSpacing, dpr)` (odd/even parity matched to crosshair for symmetry — a subtle but important parity trick); draw body rect + high/low wick; up/down/doji colors; hollow option. Batches same-color bars to minimize `fillStyle` changes.
- **line.ts**: walk-line algorithm — single `ctx.beginPath()` over the visible range, `lineTo` each point, one `stroke()`. Optional area fill with a cached vertical gradient. Step/curved/straight modes.
- **histogram.ts**: volume bars in the volume pane; per-bar color (up/down). Base value configurable.
- **crosshair.ts**: vertical + horizontal dashed lines on the overlay canvas. Default 'normal' mode tracks the pointer exactly; opt-in 'magnet' mode snaps the horizontal line to the nearest OHLC value (price pane only). Drives the axis labels.
- **grid.ts**: vertical lines at time ticks, horizontal at price ticks, drawn on the data canvas behind series.
- **axis.ts**: price-axis labels (right), time-axis labels (bottom), the moving crosshair label box, and last-price label.

---

## 6A. Chart type catalog & the three rendering families

The full set you want spans **three architecturally distinct families**. The key design decision: a **Series Type Registry** where every chart type registers a descriptor `{ dataKind, transform?, renderer, scaleMode }`. The chart core doesn't know about specific types — it just runs the descriptor. Adding a new style = adding one descriptor. This is how we support a long list without bloating the core, and how *you* (or users) can author **custom chart styles**.

```ts
interface ChartTypeDescriptor {
  name: string                       // "renko", "footprint", …
  dataKind: 'ohlc' | 'tick' | 'bidask'   // what feed granularity it needs
  scaleMode: 'time' | 'ordinal'      // x-axis: real time, or per-element (brick/column)
  transform?: ISeriesTransform       // raw → derived series (Family B); omit for A
  renderer: ISeriesRenderer          // how to paint it
  bundle: 'base' | 'transform' | 'profile'  // which tier it ships in
}
registerChartType(renkoDescriptor)   // pluggable
```

### Family A — Time-indexed (1 element per time bar) → **pure renderer swap, Tier 1**

Same `DataStore`, same time/price scales as candles; only the renderer differs. From your screenshot, all of these are Family A:

| Type | Renderer notes |
|---|---|
| **Bars** (OHLC) | left tick = open, right tick = close, vertical = range |
| **Candles** | body + wicks (the baseline renderer) |
| **Hollow candles** | body hollow when `close ≥ open`, filled when down; color by close-vs-prevclose |
| **Volume candles** | candle **body width ∝ volume** (needs per-bar width from volume, not fixed bar spacing) |
| **Line** | walk-line over `close` |
| **Line with markers** | line + a dot at each point |
| **Step line** | horizontal-then-vertical segments |
| **Area** | line + gradient fill to baseline |
| **HLC area** | three lines (H, L, C) with fill between H and L |
| **Baseline** | area split above/below a reference price, two colors |
| **Columns** | vertical bars from a base value (close-based) |
| **High-low** | thin vertical line per bar from low to high (no open/close) |

These cost almost nothing to add — they're variations of three renderers (`bars.ts`, `line.ts`, `histogram.ts`, `candles.ts`). **Heikin Ashi** also lands here visually but is technically a transform (see Family B) since it derives smoothed OHLC; it stays 1:1 with time so it keeps the time scale.

### Family B — Price/movement-transformed (derived elements, **non-uniform x**) → **Tier 3 `transform/`**

Renko, Range bars, Point & Figure, Kagi, Line Break. These **re-bucket** raw data into a *new* synthetic series driven by **price movement, not the clock**. One source bar can produce zero, one, or many output elements (e.g. a big move = many Renko bricks). Architecture:

1. A **transform pipeline** stage sits between the raw `DataStore` and the renderer:
   ```ts
   interface ISeriesTransform {
     // streaming: feed raw bars/ticks in order, emit derived elements
     reset(params): void
     push(bar: Bar): DerivedElement[]   // 0..n new elements (bricks/columns/lines)
     // each DerivedElement carries the source time it formed at, for axis labels
   }
   ```
2. Output goes into a **derived store** that the renderer draws.
3. The **time scale switches to `ordinal` mode**: x = `elementIndex × spacing` (uniform per brick/column), and `index → label` reads each element's *formation time* (so the time axis still shows real dates, just non-uniformly spaced). The price scale is unchanged.

| Type | Transform logic | Renderer |
|---|---|---|
| **Heikin Ashi** | `haClose=(o+h+l+c)/4`, `haOpen=(prevHaO+prevHaC)/2`, … (1:1, keeps `time` scale) | candle renderer |
| **Renko** | emit a brick each time price moves ≥ boxSize (fixed or ATR-based); reversal needs 2×box | brick rects, ordinal |
| **Range bars** | new bar when `high−low` reaches the range setting | candle/bar renderer, ordinal |
| **Point & Figure** | columns of X (up) / O (down); reversal threshold flips column; box size quantizes price | X/O glyph columns, ordinal |
| **Kagi** | single line; flips thick↔thin on a reversal beyond threshold; direction changes at shoulders/waists | variable-width polyline, ordinal |
| **Line Break** | new line only if close breaks the high/low of the prior N lines | rect series, ordinal |

Transforms must be **incremental/streaming** so live ticks extend the last element (or spawn new bricks) without recomputing history — same `series.update` hot-path discipline as Family A (§4.2). This is the part that makes live Renko/Range bars work.

### Family C — Profile & order-flow (price × {volume | time | bid-ask}) → **Tier 3 `profile/`**

These are not OHLC series at all — each x-slot (or session) holds a **distribution over price**. This is the heaviest family and has a hard **data dependency** (flagged below).

| Type | What it draws | Data needed |
|---|---|---|
| **Volume Profile** | horizontal histogram of volume-at-price (POC, Value Area 70%), as session / visible-range / fixed-range | OHLCV (approx: spread each bar's volume across its H–L) **or** ticks (exact) |
| **TPO / Market Profile** | letters/blocks marking which time-periods (e.g. 30-min) traded at each price; POC, Value Area, Initial Balance, single prints | intraday bars (e.g. 1-min → bucketed into TPO periods) |
| **Volume Footprint** | per-candle grid: each price row shows **bid volume × ask volume**, colored by delta; imbalance highlighting (diagonal bid/ask) | **trade-level data classified bid/ask** (or L1 bid/ask + trade prints) |
| **Orderflow** | footprint **+ cumulative delta** line, **stacked imbalances**, absorption/exhaustion markers | same as footprint |

**Profile data model:** a price-bucketed array per slot/session:
```ts
interface PriceBucket { price: number; bidVol: number; askVol: number; tpoCount: number }
interface ProfileSlot { startTime; endTime; buckets: PriceBucket[]; poc; vah; val }
```
Renderers draw **horizontally** (volume profile / footprint cells) rather than the vertical OHLC paradigm, but reuse the **same price scale** (price→y) — they just bucket price into rows of `tickSize × N`.

**⚠ Data dependency (be honest about this):**
- Family A & B + Volume Profile + TPO are all derivable from what OpenAlgo already serves (`get_historical_data` OHLCV + intraday bars). Volume Profile/TPO from OHLCV are *approximations* (volume distributed across the bar's range); good enough for most, but not "true" tick-accurate.
- **Footprint & Orderflow require trade-by-trade data with bid/ask classification** (was each print at the bid or the ask?). OpenAlgo gives live `get_market_depth` (current L1/L2) and tick LTP via WS, but **historical footprint needs recorded tick/trade history**, which OpenAlgo does not store by default. Two paths:
  1. **Live-only footprint**: build footprint in real time by classifying incoming WS trade ticks against the live bid/ask, and persist a rolling buffer for the session. Works for today's session, not for arbitrary history.
  2. **Tick recorder**: add an OpenAlgo-side tick/depth recorder (DB table) so historical footprint/orderflow can be replayed. This is a backend feature, not a charting one — flag it as a prerequisite.

This data-tiering is why footprint/orderflow ship as a **separate lazy-loaded bundle**: most users won't have tick history, and we shouldn't tax the base bundle for a feature gated on a data pipeline.

### Custom chart styles (extensibility)

Because every type is just a `ChartTypeDescriptor`, **custom styles are first-class**: a user provides a `transform` (optional) + a `renderer` and calls `registerChartType()`. The four built-in families are themselves authored this way — there's no privileged "core" type. This directly satisfies "ensure we can create custom chart styles like Renko, Range bars, P&F." (Those four ship built-in; the *mechanism* is open for anything else — e.g. a custom "Better Renko", Heikin-Renko, or a proprietary footprint variant.)

## 7. Input handling (`input/`)

- **pointer.ts**: normalizes mouse + touch + pen into one stream (pointerdown/move/up, wheel, gesture). Tracks single vs multi-touch.
- **pan-zoom.ts**:
  - drag on chart → pan time scale; drag on price axis → rescale price (manual mode); drag on time axis → change bar spacing.
  - wheel → zoom around cursor (Shift = horizontal pan, Ctrl/⌘ = faster zoom).
  - two-finger pinch → zoom; flick → **kinetic** momentum (velocity decay each frame).
  - double-click → reset to fit-content / real-time.
- **hit-test.ts**: on move, ask each primitive "are you under (x,y)?" so order lines highlight and become draggable. Returns the topmost hit with a cursor hint (e.g. `ns-resize` over an order line).

---

## 8. Primitive / plugin API (`primitives/`)

The extension point that keeps the core small and powers the trade layer. The earlier minimal interface was too small for real trading tools (review point 8). The full `IPrimitive` API provides multiple **view surfaces**, **lifecycle hooks**, **z-order**, **autoscale contribution**, and **hit-testing**.

```ts
interface IPrimitive<TParams = AttachedParams> {
  // ── lifecycle ──
  attached?(p: TParams): void          // p = { chart, series, requestUpdate } refs
  detached?(): void
  updateAllViews?(): void              // viewport changed → recompute view data
  // primitives call the injected requestUpdate() to schedule a repaint when their
  // own state changes (e.g. an order moved) — drives a targeted per-pane invalidation.

  // ── view surfaces (each returns cached arrays; new array only when changed) ──
  paneViews?(): readonly IPaneView[]              // main chart area
  priceAxisPaneViews?(): readonly IPaneView[]     // drawing inside the price-axis strip
  timeAxisPaneViews?(): readonly IPaneView[]      // drawing inside the time-axis strip
  priceAxisViews?(): readonly IAxisView[]         // FIXED labels on the price axis (e.g. order price)
  timeAxisViews?(): readonly IAxisView[]          // fixed labels on the time axis (e.g. event time)

  // ── autoscale ──
  autoscaleInfo?(start: Logical, end: Logical): { priceRange: {min,max} } | null

  // ── hit-test (priority + distance for disambiguation) ──
  hitTest?(x: number, y: number): {
    zOrder: 'bottom' | 'normal' | 'top'   // ties broken by z-order
    cursor?: string                        // e.g. 'ns-resize' over an order line
    externalId: string                     // which element (for click/drag routing)
    // engine picks the nearest hit by pixel distance, then by z-order
  } | null
}

// each IPaneView exposes its z-order so primitives layer correctly vs series:
interface IPaneView { zOrder(): 'bottom' | 'normal' | 'top'; renderer(): { draw(ctx, scope) } | null }
```

Notes that matter for the trade layer:
- **`requestUpdate`** (injected at `attached`) is how an order line says "I moved, repaint me" without the app polling — it raises a per-pane `Cursor`/`Light` invalidation (§3.2).
- **Z-order** (`bottom`/`normal`/`top`) controls layering: grid/zones at `bottom`, order/position lines at `normal`, the line being dragged + crosshair at `top`.
- **Fixed axis labels** (`priceAxisViews`) are how an order line gets its price tag pinned on the right axis, and an event marker gets its time tag — distinct from drawing in the pane.
- **Hit-test returns distance + z-order** so when an order line, an alert line, and a position line stack near the cursor, the engine drags the intended one.

`price-line.ts` is the reusable base (a horizontal line at a price with a fixed right-axis label, color, style, optional drag handle); orders, SL, TP, breakeven, alerts, and indicator levels are all `PriceLine`s. Primitives register per-series or per-pane and draw in z-order after series. The same API powers user price lines, trend lines, and price alerts, with the trading equivalents built in as first-class.

### 8.1 Series markers — buy/sell signals & shapes (`primitives/markers.ts`)

Price/bar-anchored glyphs attached to specific bars, added via a `createSeriesMarkers(series, [...])` factory. This covers buy/sell **signals** (strategy entries/exits, actual fills) and arbitrary **shapes**.

```ts
interface SeriesMarker {
  time: Time
  position: 'aboveBar' | 'belowBar' | 'inBar' | 'atPrice'
  price?: number                     // required when position === 'atPrice'
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square' | 'triangleUp'
       | 'triangleDown' | 'diamond' | 'flag' | 'text'
  size: 'tiny' | 'small' | 'medium' | 'big'   // four discrete sizes (see below)
  color: string
  text?: string                      // e.g. "BUY", "SELL", "EMA cross"
  id?: string                        // for hit-test / click callbacks
}
const markers = createSeriesMarkers(series, [...])   // add/update/remove later
```

Behavior:
- A **BUY signal** = `{ shape:'arrowUp', position:'belowBar', color:'#26a69a', text:'BUY' }`; a **SELL** = `{ shape:'arrowDown', position:'aboveBar', color:'#ef5350', text:'SELL' }`.
- Markers are kept **sorted by index** and only the visible range is drawn (binary search, same as bars) → thousands of signals stay 60 fps.
- Multiple markers on one bar **stack** (vertical offset accumulates) so they never overlap.
- `aboveBar`/`belowBar` offset from the bar's high/low; `inBar` sits at the body; `atPrice` pins to an exact price-y.
- Hit-test enabled → hover highlights, click fires `onMarkerClick(id)`.
- **OpenAlgo tie-in**: auto-plot real executions from `get_trade_book` (buy fills → up arrows, sell fills → down arrows at fill price), and let strategies push live signal markers via the API.

#### Shape sizing — tiny / small / medium / big (locked)

Markers (and shape glyphs generally) support **four discrete size presets**, not a free pixel value, so they stay visually consistent and DPI-crisp:

| Size | Base glyph px (CSS) | Use |
|---|--:|---|
| `tiny` | 6 px | dense scalping signals, many markers per screen |
| `small` | 9 px | default for high-frequency signals |
| `medium` | 12 px | standard buy/sell arrows |
| `big` | 16 px | emphasis / sparse swing signals |

The renderer multiplies the base by `devicePixelRatio` and snaps to integer device pixels, and clamps the glyph so it never exceeds the current `barSpacing` (a `big` marker auto-shrinks toward `small` when bars are tightly packed, so it never swamps the candles). Text labels scale their font with the same four-step ladder.

### 8.2 Event markers — Earnings / Dividends / Splits (`primitives/event-markers.ts`)

The **E / D / S badges** shown just above the time axis (earnings/dividend/split events). These are **time-anchored only** (no price), so they're a *pane* primitive drawn in a dedicated strip above the time-axis, not a series marker.

```ts
interface ChartEvent {
  time: Time
  type: 'earnings' | 'dividend' | 'split' | 'news' | string   // custom types allowed
  label: string                     // 'E', 'D', 'S', or short text
  color?: string                    // defaults per type
  guideLine?: boolean               // dotted vertical line up through the chart
  tooltip?: Record<string, unknown> // EPS est vs actual, div amount + ex-date, ratio…
}
const events = createEventMarkers(chart, [...])
```

Behavior:
- Rendered as small rounded badges in a bottom strip; same gapless index→x mapping, so a badge sits under its bar regardless of weekends/holidays.
- Hover (hit-test) → tooltip overlay with the `tooltip` payload (earnings: estimate vs actual, surprise %; dividend: amount, ex/record dates; split: ratio). Click → `onEventClick(event)`.
- Reuse the same four-size ladder (`tiny`/`small`/`medium`/`big`) for badge size.

**⚠ Data dependency (honest note):** OpenAlgo serves market data and orders but **not a corporate-actions / earnings calendar**. So earnings/dividend/split events need an external source — NSE/BSE corporate-announcements feed, or a third-party calendar API — normalized into `ChartEvent[]`. Buy/sell signals and trade-fill markers have **no** such dependency (they come from your strategy or `get_trade_book`). The event-marker *renderer* ships regardless; only the data feeding it is your integration step.

Both 8.1 and 8.2 live in the **base bundle** (they're tiny — part of the ~1.8 KB primitives budget plus a little for the event strip) and need no engine changes.

---

## 9. The trade-management layer (`trade/`) — advanced on-chart trading

This is the differentiator and ships as a **separate entry point** (`openalgo-charts/trade`) so chart-only users don't pay for it. Everything here is built on the primitive API above; the chart core stays trading-agnostic.

### 9.1 Components

- **order-line.ts** — `WorkingOrderLine`: a draggable horizontal line for each open/working order (LIMIT/SL price). Shows side (BUY/SELL), qty, order type, distance-from-LTP in ticks/₹, and a ✕ to cancel. Dragging it calls `modify_order`; dropping it on the LTP cancels or converts. Color-coded buy=green / sell=red.
- **position.ts** — `PositionMarker`: a line at average entry price with a filled band to LTP showing **live unrealized P&L** (₹ and %), quantity, and breakeven (entry ± charges). Updates on every tick from the WS feed.
- **bracket.ts** — `BracketGroup`: SL line + Target line linked to a position as **OCO**. Dragging SL/TP modifies the child orders; visually shows risk (red zone below entry) and reward (green zone above) with R:R ratio. This delivers the core advanced-trade-management ("ATM strategy") workflow.
- **dom-ladder.ts** — `DomLadder`: an optional vertical price ladder docked to the right axis showing bid/ask sizes per price level (from `get_market_depth`), with click-to-place at a level and visual order/position rows. This is a full depth-of-market ladder docked to the chart. **Depth-agnostic by design** — see §9.3: it adapts to whatever level count the broker returns (5 / 20 / 30 / 50 / 200).
- **trade-controller.ts** — the brain. Subscribes to OpenAlgo order book / position book / depth, reconciles them into primitives, translates gestures into OpenAlgo REST calls, and handles optimistic UI + rollback on reject.

### 9.2 Gesture → action mapping

| Gesture | Action | OpenAlgo call |
|---|---|---|
| Drag on price axis at price P (armed BUY) | Place LIMIT buy @ P | `place_order(LIMIT, BUY, qty, P)` |
| Drag a working-order line to P′ | Modify order price | `modify_order(orderid, P′)` |
| Click ✕ on order line | Cancel order | `cancel_order(orderid)` |
| Drag SL line | Modify stop child order | `modify_order(sl_orderid, …)` |
| Drag TP line | Modify target child order | `modify_order(tp_orderid, …)` |
| One-click BUY/SELL button | Market order at qty | `place_order(MARKET, side, qty)` |
| "Close" on position marker | Flatten | `close_all_positions` / `place_smart_order(qty=0)` |
| Reverse | Flip position | `place_smart_order` with opposite target |

All destructive/outward actions (place/modify/cancel) go through a **confirm + arm** gate (configurable: confirm dialog, or "armed" click-to-trade mode like pro DOMs) — never fire an order on a stray drag.

### 9.3 State reconciliation

`trade-controller` is the single source of truth:

```
on WS order update / poll order_book:
  diff against current WorkingOrderLines → add/move/remove primitives
on WS position update / poll position_book:
  update PositionMarker price, qty, P&L
on WS depth (get_market_depth):
  update DomLadder bid/ask sizes
on every LTP tick:
  recompute P&L, breakeven, R:R; invalidate(Cursor)  // overlay only
```

Because P&L updates hit only the overlay canvas (`Invalidate.Cursor`), live tick-by-tick P&L animation costs almost nothing.

### 9.4 Variable market depth (5 / 20 / 30 / 50 / 200 levels)

Depth is **broker-dependent**: standard NSE Level-2 is 5 bid + 5 ask, but some brokers stream 20, 30, 50, even 200 levels. Every depth-consuming component (`dom-ladder.ts`, footprint/orderflow) is built **depth-agnostic** — it reads the level count from the payload at runtime, never assumes 5.

```ts
interface MarketDepth {
  bids: { price: number; qty: number; orders?: number }[]   // length = broker's level count
  asks: { price: number; qty: number; orders?: number }[]
  ltp: number; ltq?: number; totalBidQty?: number; totalAskQty?: number
}
```

Rendering rules that scale from 5 to 200:
- **Viewport virtualization** — the ladder draws only the price rows currently visible in its strip (a window centered on the LTP), not all 200. Scroll/recenters on LTP. With 5 levels this is a no-op; with 200 it's what keeps it 60 fps and readable. (Same culling discipline as the bar renderer.)
- **Price-bucket aggregation** — optional: group every N ticks into one row when the book is deep, so a 200-level book can be shown compactly (configurable tick grouping / price-step).
- **Size heatmap** — per-row background opacity ∝ qty / maxVisibleQty, so large resting liquidity stands out. With deep books this is the basis of an optional **depth-heatmap over time** (liquidity as a 2D color field) — a natural future feature *enabled* by 20–200 level data, parked in the `profile/` tier.
- **Auto-detect** — on subscribe, request the broker's max available depth; the component sizes its row pool to `max(bids.length, asks.length)` from the first message and adapts if it changes.

This means the same `DomLadder` works unchanged whether a broker gives 5 or 200 — deeper books just unlock richer visuals (full ladder, heatmap), never break the component.

**Graceful degradation (review point 13):** the ladder declares a capability tier from the live payload — **(a) 5-level** compact ladder (default, every broker), **(b) 20/30/50-level** full ladder + heatmap when the broker streams it, **(c) none** → if depth isn't available for an instrument/broker, the DOM simply doesn't render and chart trading falls back to axis-drag / one-click order entry. No depth ≠ broken chart.

### 9.5 Order/trade state machine (review point 12)

Chart trading mutates real money, so the trade layer is a **strict state machine**, not optimistic guesswork. Each working order is tracked through explicit states:

```
            placeOrder()                 ack (orderid)            (fill events)
  [idle] ───────────────▶ PENDING_PLACE ───────────▶ WORKING ──┬─▶ PARTIAL ──▶ FILLED
                              │  reject                  │       │
                              ▼                          │       └─▶ FILLED
                          REJECTED ◀────────reject───────┤
                                                          │ modifyOrder()
                                          MODIFY_PENDING ◀┤───────────────────▶ WORKING (new price)
                                          CANCEL_PENDING ◀┘ cancelOrder() ────▶ CANCELLED
   (on reconnect, any non-terminal order whose id is absent from a fresh orderbook) ─▶ STALE → reconcile
```

Hardening rules each transition obeys:
- **Idempotency** — every outbound action carries a client token; a retry after a timeout never double-places. Reconcile by `orderid` from the orderbook, not by assuming the request succeeded.
- **Optimistic UI + rollback** — show the order line immediately on `PENDING_PLACE` (greyed/dashed); solidify on `WORKING`; **remove and toast on `REJECTED`**. Never show a *filled position* optimistically — positions update only from the position book.
- **Reconnect recovery** — on WS reconnect, refetch order/position/trade books and **diff** against on-chart primitives: add missing, remove vanished (`STALE`), reconcile prices. The chart's truth is always the latest book snapshot.
- **Tick-size rounding** — any dragged price snaps to the instrument's `minMove` (§5.2.1) *before* sending; reject sub-tick prices client-side.
- **Price-band / freeze-qty validation** — pre-validate against the instrument's allowed price band and freeze quantity; block and explain rather than letting the broker reject. Margin pre-check via `getFunds()` before arming.
- **Rate limiting** — coalesce rapid drag-modifies (debounce) and cap order actions/sec so a frantic drag doesn't spam `modifyorder`.
- **Analyzer / sandbox mode** — OpenAlgo's analyzer (paper) mode is a first-class switch: the same gestures route to the sandbox, the chart badges itself "ANALYZER" so a paper order is never mistaken for live. The state machine is identical; only the endpoint target differs.
- **Confirm + arm gate** — destructive actions pass through the §9.2 confirm/arm gate before entering `PENDING_PLACE`.

---

## 10. OpenAlgo integration (`feed/`)

### 10.0 Adapter contract vs naming (review point 11)

**Three different naming surfaces exist for the same operations — don't conflate them:**

| Our adapter method (stable) | OpenAlgo **REST** endpoint (what we actually call) | MCP tool name | Python SDK |
|---|---|---|---|
| `getBars()` | `POST /api/v1/history` | `get_historical_data` | `client.history()` |
| `getQuote()` | `POST /api/v1/quotes` | `get_quote` | `client.quotes()` |
| `getDepth()` | `POST /api/v1/depth` | `get_market_depth` | `client.depth()` |
| `placeOrder()` | `POST /api/v1/placeorder` (+ `/placesmartorder`, `/basketorder`, `/splitorder`) | `place_order` | `client.placeorder()` |
| `modifyOrder()` | `POST /api/v1/modifyorder` | `modify_order` | `client.modifyorder()` |
| `cancelOrder()` | `POST /api/v1/cancelorder` | `cancel_order` | `client.cancelorder()` |
| `getOrders()` | `POST /api/v1/orderbook` | `get_order_book` | `client.orderbook()` |
| `getPositions()` | `POST /api/v1/positionbook` | `get_position_book` | `client.positionbook()` |
| `getTrades()` | `POST /api/v1/tradebook` | `get_trade_book` | `client.tradebook()` |
| `getFunds()` | `POST /api/v1/funds` | `get_funds` | `client.funds()` |
| `getHolidays()` | `GET /market/holidays` | `get_holidays` | — |
| `getTimings()` | `GET /market/timings` | `get_timings` | — |
| `getIntervals()` | `POST /api/v1/intervals` | `get_available_intervals` | `client.intervals()` |

> The chart depends **only on the left column** (our `DataFeed`/`TradeFeed` adapter methods). The `OpenAlgoFeed` adapter is the *only* file that knows the REST paths/payloads. The MCP/Python names earlier in this doc were convenience labels — the **REST endpoints are the real contract** (market routes are registered under `/market/...`, order/data routes under `/api/v1/...`). Verify exact paths/auth against the running OpenAlgo build before coding the adapter, and pin them in one constants file.

- **History** (`feed/openalgo-rest.ts`): `POST /api/v1/history` → bulk `setData()`. Intervals from `/api/v1/intervals`. Indian specifics: NSE/BSE/NFO/MCX exchanges; `/market/holidays` and `/market/timings` feed *session-awareness extras* only (not gap logic — §5.3).
- **Live** (`feed/openalgo-ws.ts`): OpenAlgo WebSocket for LTP / Quote / Depth → the **candle builder** (§10.2) → `series.update()`; Depth → DOM ladder; LTP → P&L.
- **Trading**: the order/book/funds endpoints above, behind the `TradeFeed` adapter + state machine (§9.5).
- **Options** (later): option chain / greeks (Black-76 off the synthetic future for Indian F&O — see your `black76-indian-options` note) / synthetic future / expiries → indicator primitives (IV bands, max-pain line).

### 10.2 Live candle aggregation (`feed/candle-builder.ts`) — review point 5

**The WS feed does not give interval candles.** OpenAlgo's LTP mode gives a tick *price* (+ last-traded-qty); Quote mode gives *day* OHLC + *cumulative day* volume — neither is the OHLC of the current 1-/5-/15-min bar. So the client **builds** interval candles. This is its own module with explicit policies:

```ts
class CandleBuilder {
  constructor(intervalSec, opts: {
    sessionResetAt?: 'daily',          // start a fresh first-bar each session
    volumeMode: 'ltq-sum' | 'day-delta', // LTP: sum ltq; Quote: diff cumulative day volume
    lateTickPolicy: 'foldIntoBar' | 'dropOlderThanPrevBar',
    tz: 'Asia/Kolkata',
  })
  onTick(price, ltq, cumDayVol, tsMs): Bar   // returns the (mutated or new) current bar
}
```

Rules:
- **Bucketing** — `bucket = alignToSession(floor(tsUTC / intervalSec) * intervalSec)`. Same bucket as current bar → update `high/low/close`; new bucket → emit/append a fresh bar (`open = price`).
- **Session reset** — the first bar of each session starts at the session open from `/market/timings`, not at an arbitrary `floor`, so daily/weekly buckets and the 09:15 open are correct (and align with gapless indices, §5.3).
- **Volume handling** — *LTP mode*: accumulate `ltq` into the bar's volume. *Quote mode*: volume arrives as **cumulative day total**, so the bar's volume = `cumDayVol − cumDayVolAtBarStart` (a delta), never the raw cumulative number. This distinction is a classic bug source; it's explicit here.
- **Late-tick policy** — a tick older than the current bar's open is either folded into the matching (current/previous) bar or dropped if older than a threshold; it never silently appends out of order. Ties into the DataLayer's out-of-order upsert (§4.2).
- **Timezone normalization** — all bucketing is on `UTC seconds` (§4.0); IST appears only in labels.
- **History→live seam** — the builder is seeded with the last historical bar so the first live tick continues that bar (or correctly starts the next), implementing the buffered handoff from §10.1.

### 10.1 Live + historical (one consistent API surface)

The engine handles both modes through a **simple two-method contract**, so the mental model is consistent:
- **Historical**: `series.setData(bars)` — bulk-load a fetched range; autoscale + fit-content; this is the static/backtest/replay case.
- **Live**: `series.update(bar)` — same `time` as last bar → mutate the last candle in place (intra-bar tick); newer `time` → append a new bar and advance real-time mode. This is the 60 fps hot path; it allocates nothing and triggers a `Light`/last-bar redraw, not a full repaint.

Standard live behaviors: **auto-scroll to realtime** only when the user is already at the right edge (don't yank the view if they've scrolled into history), a **last-price line + label**, and **lazy history paging** — when the user pans left past the loaded range, fire `getBars(olderRange)` and prepend. Family B transforms and Family C profiles consume the *same* `setData`/`update` stream; the transform/profile pipelines are incremental so live ticks extend Renko bricks / footprint cells correctly without recompute.

A thin `DataFeed` interface decouples the chart from OpenAlgo so the engine itself stays broker-agnostic and independently testable. **Note:** `subscribeBars` is *optional* — `OpenAlgoDataFeed` is history-only (REST), and live bars come from `OpenAlgoLiveDataFeed` (REST + WS + candle builder) or by wiring `OpenAlgoWsFeed` LTP ticks through a `CandleBuilder` yourself.

```ts
interface DataFeed {
  getBars(req): Promise<Bar[]>
  subscribeBars(req, onBar): UnsubscribeFn
  subscribeDepth?(req, onDepth): UnsubscribeFn
}
interface TradeFeed {
  placeOrder(o): Promise<{orderid}>
  modifyOrder(id, patch): Promise<void>
  cancelOrder(id): Promise<void>
  subscribeOrders(cb): UnsubscribeFn
  subscribePositions(cb): UnsubscribeFn
}
```

`OpenAlgoDataFeed` / `OpenAlgoTradeFeed` implement these against OpenAlgo's REST + WS. Swapping brokers later = new adapter, zero chart changes.

---

## 11. Build, tooling, size enforcement & testing

- **Language**: TypeScript, `const enum` for zero-cost enums, strict mode.
- **Bundler**: Rollup + `@rollup/plugin-terser`. Output: ESM (primary) + IIFE standalone (for `<script>` drop-in / CDN). Separate entry points per tier (`index`, `/trade`, `/transform`, `/profile`) so they tree-shake and lazy-load independently.
- **Size CI**: `size-limit` with **Brotli** targets per tier. Since we have zero runtime dependencies, nothing is excluded from the measurement. Hard ceilings: **engine 30 KB Brotli, base+trade 50 KB Brotli**, per-tier sub-limits. PRs exceeding a limit fail CI. **Wiring `size-limit` is the first task of Phase 1 so every estimate in this doc gets replaced by a measured number early.**
- **No dependencies**: HiDPI sizing, resize observation, and event handling are hand-rolled (~50 lines total).

### 11.1 Testing — starts in Phase 2, not "once stable" (review point 14)

Charts are visual and interaction-heavy; deferring tests guarantees regressions. The test pyramid comes online alongside the code:

- **Unit (Phase 2+)** — pure math: scale mappings, `ticks.ts` nice-numbers, DataLayer merge/prepend/index-shift, candle-builder bucketing + volume-delta + late-tick policy, timezone/session conversions. Fast, run on every commit.
- **Renderer pixel-diff (Phase 2–3)** — puppeteer + pixelmatch: snapshot each renderer (candles/line/histogram/bars/…) at fixed data + DPR, diff against golden PNGs. Catches sub-pixel/HiDPI regressions.
- **Interaction (Phase 3)** — scripted pan / wheel-zoom / pinch / crosshair / fit-content asserting scale state and that **all panes stay x-synced**.
- **HiDPI (Phase 2–3)** — run pixel tests at `devicePixelRatio` 1, 1.5, 2, 3 to lock crisp-line behavior.
- **Timezone/session (Phase 2)** — IST-string and epoch-ms inputs produce identical internal `UTC seconds`; session resets land on 09:15; weekends/holidays stay gapless.
- **Fake OpenAlgo feed + order simulator (Phase 2–3)** — a deterministic in-memory `DataFeed`/`TradeFeed` that replays recorded history, emits scripted ticks/depth, and simulates the full order state machine (acks, partials, rejects, reconnect-with-stale-orders). Lets the chart and trade layer be tested with **zero broker/network**, including reconnect-recovery and out-of-order ticks.

---

## 12. Implementation roadmap

Build in vertical slices so there's always a runnable chart. **Testing infra (size-limit + unit + pixel + fake feed) lands in Phase 1–2 and grows with each phase (§11.1).**

0. **Project + measurement harness** — repo, Rollup tiers, `size-limit` (Brotli) wired, fake `DataFeed`/`TradeFeed` stub, pixel-diff harness skeleton. *(so every later phase is measured, not guessed)*
1. **Skeleton** — DOM/canvas layout (base+top per pane, axis widgets), render loop + per-pane invalidate mask + resize. Hardcoded grid. *(proves HiDPI + loop)* + first `size-limit` numbers replace the estimates.
2. **Static candles** — shared DataLayer + time/price scales (incl. tick-size formatting) + candle renderer + axes. Load history (`setData`) via the REST adapter. *(proves core math)* + unit + pixel + timezone/session tests.
3. **Interaction** — pan, wheel-zoom, crosshair, autoscale, fit-content, kinetic, lazy history paging (`prependData` + viewport preserve). *(this is "a chart")* + interaction + HiDPI tests; assert pane x-sync.
4. **Live** — WS → candle builder (§10.2, volume-delta + late-tick + session reset) → `series.update`; last-price line, auto-scroll, volume pane. *(historical + live parity)* + fake-feed tick/out-of-order tests.
5. **Family A complete** — Series Type Registry + all 12 time-indexed renderers from the screenshot (bars/hollow/volume-candle/line+markers/step/area/HLC-area/baseline/columns/high-low). *(cheap, high payoff)* + per-renderer pixel goldens.
6. **Primitives** — full primitive API (views/lifecycle/z-order/hit-test) + price-line base + markers + event-markers + one indicator (EMA) to validate it.
7. **Family B (`transform/`)** — transform pipeline + ordinal scale mode; Heikin Ashi → Renko → Range → P&F → Kagi → Line Break, each incremental for live.
8. **Trade layer (read-only)** — order/position/bracket primitives + live P&L, driven by the state machine reconciling the books. No order placement yet.
9. **Chart trading (write)** — arm/confirm gate + drag-to-modify + one-click + brackets/OCO + tick-size/price-band validation + analyzer mode. Tested entirely against the order simulator first.
10. **DOM ladder** (5-level → deep + heatmap, graceful degradation) + polish.
11. **Family C (`profile/`)** — Volume Profile + TPO from OHLCV first; Footprint + Orderflow once the OpenAlgo tick-recorder backend exists. *(gated on data pipeline — §6A)*
12. **Conflation** (§4.4) + cross-tier `size-limit` hardening.

Each phase is independently demoable and measurable against the size budget. Phases 1–6 deliver a full professional-grade chart with every standard style; 7+ are the differentiators.

### 12.1 Documentation & developer experience (docs-as-you-go track)

Documentation is a **first-class deliverable, produced alongside the code — not deferred.** Every public API gets TSDoc when it's written; every phase ships at least one runnable example. The doc set:

| Artifact | What | When | Tooling |
|---|---|---|---|
| **TSDoc on public API** | Doc comments on every exported type/method → IDE intellisense + source for the API reference | continuous, from Phase 1 | TSDoc, lint-enforced |
| **API reference** | Auto-generated from the bundled `.d.ts` / TSDoc | regenerated each phase | dts-bundle-generator + TypeDoc |
| **Getting started** | Install (npm + CDN), "chart in 10 lines", OpenAlgo data wiring | Phase 2 | Markdown |
| **Guides** | One per topic: chart types & custom styles, multi-pane/sync, live+historical feed, markers/signals/events, indicators | grows per phase (5→11) | Markdown + live demo |
| **Trade-layer guide** | Chart trading, order/position/bracket lines, DOM ladder, the order state machine, arm/confirm **safety**, analyzer mode | Phase 8–10 | Markdown + demo |
| **Primitive/plugin authoring** | How to write a custom chart style (`ChartTypeDescriptor`) and a custom primitive (the §8 API) — extensibility is a headline feature, so this guide is essential | Phase 6–7 | Markdown + template |
| **Examples gallery** | Runnable demos, one per chart type + trade scenarios | per phase | Vite demo app |
| **Migration / interop note** | API shape and how to port from other charting libraries | Phase 5 | Markdown |
| **README + CHANGELOG + LICENSE/NOTICE** | Repo basics; NOTICE per §0.1 licensing stance | Phase 0, maintained | Markdown |

Two principles: **(1) the API reference is generated, never hand-maintained** (it can't drift from the types); **(2) each guide links a live, runnable demo** so docs are verified by the example actually working. A "docs lint" (TSDoc coverage on public exports, dead-link check) runs in CI like `size-limit` does. This adds a documentation checkpoint to phases 0, 2, 5, 6–10 rather than a separate phase.

---

## 13. Risk notes & decisions to revisit

- **Touch/pinch correctness** is the fiddliest part — budget extra time; mature charting engines have years of edge-case fixes here that we'll have to earn ourselves.
- **Order-line dragging vs pan**: must hit-test primitives *before* starting a pan, or drags will scroll the chart instead of moving the order. Resolve in `input/hit-test.ts` priority order.
- **Optimistic UI**: show the order line immediately on `PENDING_PLACE`, reconcile/rollback on the book's confirm/reject (§9.5) — otherwise chart trading feels laggy. But never show a *filled* position optimistically.
- **Confirm gating**: default to explicit confirm; offer "armed" mode for experienced users. This is a safety + trust decision, not just UX.
- **Time-axis labels**: gaps collapse automatically (§5.3), but tick-label logic must know the instrument's session (from `/market/timings`) to label day/session boundaries and seed the candle builder's session reset correctly.
- **50k-bar live perf**: validate the `series.update` hot path allocates nothing (reuse bar objects) and that DataLayer index-shift on `prependData` stays O(n) — before committing to the row shape. Enable conflation (§4.4) for the zoomed-out case.
- **`originalTime` round-trip**: every callback/marker/event must echo the caller's original time value, not the internal UTC-seconds — verify in unit tests (§11.1) to avoid format drift.

---

---

## 13a. Deferred / not-yet-implemented (honest status)

These are designed-for but **not implemented** in the current 1.0.1 release.
They are documented here so the architecture doesn't over-promise:

- **Price-scale `percentage`, `indexed-to-100`, and overlay scales** - only
  `linear` + `logarithmic` + `inverted` are implemented.
- **Separate price/time axis-widget canvases** - axes draw within the pane
  canvas by design (small-engine simplification).
- **Primitive price/time axis *views*** - primitives draw in the pane + hit-test
  + autoscale + lifecycle; dedicated fixed axis-label views are future work.
- **OpenAlgo adapter wire schemas** (REST order fields, WS message shape) - the
  adapters exist with injectable transports + offline tests, but the exact field
  names should be verified against a running OpenAlgo build before production.

Shipped since the first draft (were previously deferred): a Playwright/Chromium
E2E smoke suite (`npm run e2e`), multi-touch pinch (zoom + two-finger pan),
binary-search visible-range lookup, WebSocket auto-reconnect with resubscribe, a
unified `chart.on(...)` event bus, a data-driven trading overlay, custom price
and time formatters, and per-pane price-scale options.

## 14. Revision log — v2 (implementation-review responses)

Point-by-point mapping of the implementation review to where each is now addressed:

| # | Review point | Resolution | Section |
|---|---|---|---|
| 1 | Canvas/layout underspecified ("one canvas") | Explicit base+top canvas per pane + separate price/time axis widgets; grid layout diagram | §0 table, **§3.1** |
| 2 | Invalidation too simple (global only) | Global level **+ per-pane map (+autoScale flag) + time-scale op queue + animations** | **§3.2** |
| 3 | Shared time/data layer missing | Single `DataLayer` merges all series by time → shared logical indices, whitespace, `baseIndex`; per-series rows derive from it | **§4.1**, §3.3 |
| 4 | History prepend/update semantics | Full mutation API: `setData` / `update` / **`prependData` (index-shift + viewport preserve)** / `mergeRange`; out-of-order upsert | **§4.2** |
| 5 | Live candle aggregation missing | `candle-builder.ts`: bucketing, **session reset, volume-delta (cumulative-day vs ltq), late-tick policy, tz** | **§10.2** |
| 6 | Time model not explicit | Internal **UTC seconds + `originalTime`**; IST-string (REST) and epoch-ms (WS) convert at edges; display tz separate | **§4.0** |
| 7 | No conflation/downsampling | Optional **OHLC-preserving** conflation layer (sub-0.5px) | **§4.4** |
| 8 | Primitive API too small | Full API: lifecycle (`attached`/`detached`/`updateAllViews`), `requestUpdate`, **pane + price/time axis pane views, fixed axis views, z-order, hit-test w/ distance+priority, autoscaleInfo(start,end)** | **§8** |
| 9 | Price-scale edge cases | tick size/`minMove`, formatters, inverted, indexed-to-100, custom range, overlay scales, margins, edge padding, label collision | **§5.2.1**, §5.4 |
| 10 | Size claims (gzip vs brotli; area/baseline contradiction) | All numbers → **Brotli** w/ methodology + "measure in Phase 1"; **kept** line/area/baseline/HLC (correction noted); zero-dependency so nothing excluded from measurement | header, §0, **§2**, §11 |
| 11 | Adapter names ≠ real endpoints | Adapter-method ↔ **REST `/api/v1/*` & `/market/*`** ↔ MCP ↔ Python mapping table; chart depends only on adapter | **§10.0** |
| 12 | Trade layer needs a state machine | Explicit states (pending/ack/partial/filled/modify/cancel/rejected/**stale-on-reconnect**) + idempotency, rollback, reconnect recovery, rate-limit, tick rounding, price-band, **analyzer mode** | **§9.5** |
| 13 | DOM ladder depends on depth | Depth-agnostic + **graceful degradation**: 5-level / 20–50 deep+heatmap / none→fallback entry | §9.4, **§9.5 note** |
| 14 | Testing too late | Test pyramid from **Phase 1–2**: unit, pixel-diff (HiDPI), interaction, tz/session, **fake feed + order simulator** | **§11.1**, §12 |
| 15 | Licensing/attribution | **Project licensed Apache-2.0** (permissive, no copyleft); default clean-room original code; any incorporated third-party routine keeps headers + `NOTICE` attribution | **§0.1** |

**Biggest-gap priority for implementation (per the review):** shared data/time model (§4) → live candle aggregation (§10.2) → per-pane invalidation (§3.2) → primitive lifecycle/hit-test (§8) → realistic size/API contracts (§2, §10.0). These front-load into Phases 0–6.

---

*End of document. Next deliverable options: (a) start Phase 0–3 as a working prototype in `D:\testing\openalgo-charts` (repo + size-limit harness + shared DataLayer + static candles + interaction), (b) detailed TypeScript interface stubs for every module (DataLayer, scales, primitive API, candle-builder, feed adapters, trade state machine), or (c) the trade-layer + OpenAlgo adapter spec expanded with sequence diagrams.*
