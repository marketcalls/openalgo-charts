# Primitives and Plugins

*When to read this: you are drawing anything on the chart that is not a series (price lines, reference levels, markers, zones, badges, on-chart controls), or registering a custom chart type.*

Source of truth: `src/primitives/primitive.ts`, `src/primitives/*.ts`, `src/core/pane.ts`, `src/core/chart.ts`, `src/model/chart-type-registry.ts`.

Everything the chart draws that is not a series is a primitive: markers, event badges, price lines, the pane legend, the time navigator, the drawing layer, and the whole trading tier. One interface covers all of them.

## `IPrimitive`

```ts
interface IPrimitive {
  zOrder(): ZOrder;                                                     // required, a METHOD
  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void; // required
  autoscaleInfo?(): { min: number; max: number } | null;
  hitTest?(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null;
  attached?(host: PrimitiveHost): void;
  detached?(): void;
}

type ZOrder = 'bottom' | 'normal' | 'top';
interface PrimitiveHost { requestUpdate(): void; }
interface PrimitiveHit {
  externalId: string;
  zOrder: ZOrder;
  distance: number;      // media px from the cursor; smaller wins
  cursor?: string;
  draggable?: boolean;   // arms a two-axis drag on press
}
```

**`zOrder` is a method, not a property.** `{ zOrder: 'bottom' }` compiles under a loose annotation and then throws at paint time when the pane calls `p.zOrder()`.

`attached(host)` is called on `pane.addPrimitive`; keep the host and call `host.requestUpdate()` whenever your state changes, it takes no arguments. `detached()` fires on `chart.removePrimitive` and on pane destruction; drop the host reference there.

**The repaint level follows your `zOrder()`, so there is nothing to opt into.** The host reads `zOrder()` on every `requestUpdate` call and schedules a `Cursor` repaint (overlay canvas only, the layer `Pane.paintTop` draws) for a `'top'` primitive and a `Light` one (base canvas) for everything else. A cursor-rate overlay therefore costs one overlay repaint rather than a full series redraw. It is read per call rather than captured at attach, so a primitive that changes layer at runtime is handled too.

### `PrimitiveRenderContext`

| Field | Type | Notes |
|---|---|---|
| `timeScale` | `TimeScale` | `indexToX(index)` returns **media** px; accepts fractional indices. |
| `priceScale` | `PriceScale` | The pane's **right** scale. `priceToY`/`yToPrice` in media px, plus `format(price)`. |
| `dataLayer` | `DataLayer` | `timeToIndex`, `timeToIndexFloat`, `indexToTime`, `indexedBars`, `visibleBars`. |
| `plotWidth` / `plotHeight` | `number` | Media px, excluding the price axis and time axis strips. |
| `priceAxisWidth` | `number` | Media px. |
| `dpr` | `number` | Device pixel ratio for this frame. |
| `theme` | `ChartTheme` | Palette. `theme.background` may be the literal `'transparent'`. |
| `bars?` | `() => readonly Bar[]` | Lazy; the pane's primary price series. Optional, guard with `rc.bars?.()`. |
| `hoverId?` | `string \| null` | `externalId` currently hovered, for hover styling. |
| `dragId?` | `string \| null` | `externalId` currently being dragged. |

A primitive attached to a pane with a left or overlay scale still receives the **right** scale in `rc.priceScale`. Convert against it, or carry your own values.

## The dpr contract

**The canvas context is in bitmap (device pixel) scope; every media-px value you compute must be multiplied by `rc.dpr` before you draw it.**

The reason is in `src/core/canvas.ts`: the backing buffer is sized `round(media * dpr)` and `clearBitmap()` resets the transform with `setTransform(1,0,0,1,0,0)`. No `ctx.scale(dpr, dpr)` is ever applied. So:

- `timeScale.indexToX()`, `priceScale.priceToY()`, `rc.plotWidth`, `rc.plotHeight` are all **media** px. Multiply.
- Font sizes, line widths, radii, and paddings are yours to scale: set the font from `11 * dpr` px, and `ctx.lineWidth = Math.max(1, Math.round(w * dpr))`.
- `hitTest` receives `x`/`y` in **media** px relative to the plot's top-left, and must return `distance` in media px. Do **not** scale in `hitTest`.
- Snap 1px strokes with `Math.round(v * dpr) + 0.5`, the pattern every built-in uses.
- When a left price axis exists the pane translates the context by `round(plotLeft * dpr)` before calling you, so `(0, 0)` is always the plot's top-left.

## Paint order

`pane.paintBase()` draws to the base canvas (z-index 0) in this exact order:

1. Pane background, then the left price axis strip (if any)
2. Grid
3. **`zOrder() === 'bottom'` primitives**
4. Series (registry-driven)
5. Right price axis ticks
6. Last-price line and tag
7. **`zOrder() === 'normal'` primitives**
8. Time axis (bottom pane only)

`pane.paintTop()` clears the overlay canvas (z-index 1) and draws:

1. **`zOrder() === 'top'` primitives**
2. Crosshair, price tag, time tag

Within a z-order band, primitives paint in attach order. `top` sits on the cheap-repaint canvas, so anything that must react to the cursor without a full repaint belongs there. `normal` deliberately paints *after* the last-price line so order pills stay legible when the LTP crosses them.

**Steps 3 and 4 are clipped to the plot; nothing else is (1.8.5).** Bottom-layer primitives and the series draw inside a clip of `plotWidth` by `plotHeight`, which is released before the axis ladder. A bar is positioned by its centre and drawn outward, so without it the newest bar against the right edge put half a body and a wick into the price-axis strip, behind the labels.

The practical consequence for a primitive author: a **`bottom`** primitive can no longer paint into the axis strips, which is what you want for a background zone or a shaded region. A **`normal`** or **`top`** primitive still can, deliberately, because that is where an axis tag or a price-line pill belongs. If your background shading suddenly stops at the plot edge, that is this change and it is the correct picture.

## Hit-testing and `externalId`

The chart hit-tests one pane at a time and reduces the results with `bestHit`:

```ts
function bestHit(hits: readonly (PrimitiveHit | null)[]): PrimitiveHit | null
```

Smallest `distance` wins; on a tie the higher z-order wins (`top` > `normal` > `bottom`). `null` entries are skipped. Use it directly inside a composite primitive that delegates to sub-objects.

Routing, from `src/core/chart.ts`:

- **Click**: on pointerup without movement, the pane is hit-tested at the press point. A hit fires `chart.subscribeClick(cb)` with the `externalId`, and the `click` bus event carries `{ id, price, time, paneIndex, point }` with `id: null` on empty plot.
- **Drag**: on pointerdown, a hit arms a drag when `hit.draggable === true`, or when `hit.cursor === 'ns-resize'` and `subscribeDrag` has a callback. Moves fire `subscribeDrag(onDrag)` and a `drag` bus event `{ id, price, time, paneIndex, fromPrice, fromTime }`; release fires `onDragEnd` and `drag:end`.
- A drag that never moved is replayed as a click, so a draggable primitive is still clickable.
- `hoverId` / `dragId` are pushed back into `PrimitiveRenderContext` each frame, which is how `PriceLine` renders its hover and dragging states without any state of its own.

Namespacing convention used by the built-ins, one primitive, several targets:

| Primitive | `externalId` |
|---|---|
| `PriceLine` | `id`, and `${id}::close` for the cancel segment |
| `PaneLegend` | `${id}::close` / `::hide` / `::settings` / `::up` / `::down` / `::maximize`, `${id}::row` |
| `BuySellButtons` | `${id}:buy` / `${id}:sell` / `${id}:qty` |
| `TimeNavigator` | `${id}::zoomIn` / `::zoomOut` / `::panLeftBar` / `::panRightBar` |
| `DrawingLayer` | `draw:<drawingId>`, `draw:<drawingId>#<anchorIndex>` |
| `SeriesMarkers` / `EventMarkers` | the caller's `marker.id` / `event.id` (no hit at all when absent) |

Record hit geometry during `draw` and read it in `hitTest`, that is how `PriceLine`, `BuySellButtons`, and `PaneLegend` stay in sync with what was actually painted, and it means a primitive that has not drawn yet correctly reports no hit.

## `autoscaleInfo`

Returning `{ min, max }` **expands the pane's right price scale** so the primitive is not clipped. It is consulted only for the right scale, only when that scale is on `autoScale`, and once per autoscale pass alongside every visible bar.

Return `null` for anything that overlays rather than drives the range, the drawing layer, indicator fills, watermarks, legends, and on-chart buttons all do. `PriceLine` returns `{ min: price, max: price }`, which is what keeps an order line on screen.

Keep it cheap: it runs on every `Full` invalidation, which includes every `series.update()`.

## Built-in primitives

| Primitive | z | Purpose | Key options / methods |
|---|---|---|---|
| `PriceLine` | `normal` | Horizontal level with a right-axis tag and an optional broker-style pill group. | `price`, `color`, `lineWidth`, `dashed`, `id`, `label`, `badge`, `qty`, `leftLabel`, `extentFromRight`, `closeButton`, `cursor`; `setPrice`, `setOptions`, `setLeftLabel`, `setDragGhost`, `options()` |
| `PriceLevels` | `normal` | The ten **derived** reference levels (previous close, session high / low, last price, four extended-hours levels, bid, ask), each a line plus an axis tag. It computes its own prices from the bars and the viewport; you do not set them. | `levels` (per-kind `{ line, label, color, lineWidth, lineStyle, text, extentFromRight }`), `timezone`, `marketPhase`, `quote`; `setLevel`, `setOptions`, `setQuote`, `values()`, `available(kind)`, `level(kind)`. See below |
| `SeriesMarkers` | `normal` | Bar-anchored signal glyphs, visible-range culled and stacked per bar. `MarkerShape` covers `arrowUp`/`arrowDown`, `circle`, `square`, `triangleUp`/`triangleDown`, `diamond`, `flag`, `text`, and the `labelUp`/`labelDown` text plates (tail pointing at the anchor price, `text` required). | `setMarkers(SeriesMarker[])`; renderers `drawShape`, `drawLabel`, `markerSizePx`, `effectiveMarkerPx` |
| `EventMarkers` | `normal` | Corporate-action badge strip near the plot bottom. | `setEvents(ChartEvent[])` |
| `LogoWatermark` | `top` (option) | Corner brand mark with an optional hover-revealed label and link. | `src`/`image`, `position`, `height` (28), `margin` (12), `opacity` (0.7), `tint`, `label`, `padding`, `href`; `setOptions`, `href()` |
| `TextWatermark` | `bottom` (option) | A word stamped faintly across the plot to say what mode the chart is in, `Replay` being the case it exists for. Shrinks to fit a narrow pane, hit-tests to nothing, and is captured by `takeScreenshot()` because it is drawn on the canvas. | `text`, `fontSize` (64), `opacity` (0.08), `color`, `font`, `zOrder`; `setOptions` |
| `ReplayShade` | `top` (option) | Dims every bar after `index` and rules a line at the cut. Used while a replay start bar is being chosen: picking one while the next twenty bars are readable is picking on hindsight. Add one per pane, or a bright volume pane gives away what the price pane is hiding. | `index` (null draws nothing), `color`, `lineColor`, `lineWidth`, `lineVisible`; `setOptions` |
| `BuySellButtons` | `top` | Docked in-plot BUY / qty / SELL panel. | `id` (`trade`), `position` (`top-left`), `margin` (12), `qty`, `buyColor`, `sellColor`, `showPrices`, `scale` (0.6 to 1.5); `setPrices`, `setMark`, `setQty`, `setColors` |
| `PaneLegend` | `top` | Canvas-drawn legend row: swatch, title, params, live values, action buttons, and the status line. | `id`, `title`, `params`, `color`, `valueColor`, `row`, `actions`, `hidden`, `maximized`, `font` (11), `left` (8), `top` (6), `statusLine` (per-field switches), `status` (host data or a per-frame getter); `setValue`, `setValues` (readings may carry `field: 'ohlc' \| 'change' \| 'volume'`), `setOptions`. See [settings-and-menus](settings-and-menus.md) |
| `TimeNavigator` | `top` (option) | Hover-revealed zoom / step controls above the time axis. | Created by the chart itself from `ChartOptions.timeNavigator` (default `true`); `buttons`, `size` (26), `bottomMargin` (10), `revealHeight` (64), `labels`, `hints`, `showTooltip` |
| `LinkCrosshair` | `top` | The crosshair a linked chart shows for a cursor in **another** chart: a vertical line only, at `LINK_CROSSHAIR_ALPHA` (0.55) of the pane's crosshair colour. A mirrored horizontal line would assert a price belonging to another instrument. Normally created for you by `LinkGroup`, one per pane. | `setIndex(index \| null)`, `index()`. See [chart-linking](chart-linking.md) |
| `IndicatorFill` | `bottom` | Two-tone band between two indicator `calc` columns (Ichimoku cloud, Keltner, a shaded overbought/oversold band), split at exact crossings. The columns need not be plotted. | `colorUp`, `colorDown`, `opacity` (0.12); `setPoints(FillPoint[])`, `setOptions`, `setVisible` |

Attachment:

```ts
chart.addPrimitive(primitive, paneIndex = 0);
chart.removePrimitive(primitive);

chart.addPriceLine({ price, color, lineWidth, dashed, id }, paneIndex = 0); // returns PriceLine
chart.addEventMarkers(paneIndex = 0);                                       // returns EventMarkers
series.createMarkers();                                                     // returns SeriesMarkers, wired to that series
chart.tradeHost(paneIndex = 0);                                             // { addPrimitive, removePrimitive } for the trade tier
```

**`id` on `PriceLine` is not patchable.** `setOptions` accepts `Partial<Omit<PriceLineOptions, 'id'>>`, because swapping the routing handle mid-drag would strand the gesture.

## `PriceLevels`: the reference-level family

```ts
import { PriceLevels, PRICE_LEVEL_KINDS, computePriceLevels } from 'openalgo-charts';

const levels = new PriceLevels({
  levels: {
    previousClose: { line: true, label: true },
    sessionHigh: { line: true, label: false },     // line on the plot, no tag on the axis
    sessionLow: { line: false, label: false },
  },
  timezone: 'America/New_York',
});
chart.addPrimitive(levels, 0);

levels.setLevel('previousClose', { color: '#8b95a8', lineStyle: 'dashed' });
levels.values().previousClose;      // number | null, as of the last frame
levels.available('bid');            // false until a quote is fed
```

`PriceLevelKind` is `'previousClose' | 'sessionHigh' | 'sessionLow' | 'lastPrice' | 'preMarketOpen' | 'preMarketClose' | 'postMarketOpen' | 'postMarketClose' | 'bid' | 'ask'`, and `PRICE_LEVEL_KINDS` is that list in the order a settings panel should show it.

**A level's line and its axis tag are two flags in one group.** `line` draws across the plot, `label` draws the tag on the price axis, and neither implies the other. Do not model them as two separate menus: that is exactly how a tag ends up on the axis for a line nobody is drawing.

Defaults: `previousClose`, `sessionHigh` and `sessionLow` are on (dashed); every other kind is off. `lastPrice` is off **because the core already draws it** (see below).

| Option | Notes |
|---|---|
| `levels` | Per-kind partial style, merged over the defaults. |
| `timezone` | IANA name, used only for the calendar fallback when the bars show no readable session break. |
| `marketPhase` | `(bar) => 'pre' \| 'regular' \| 'post' \| null`. **Required for the four extended-hours levels**: the OHLC feed carries no phase, and the primitive will not guess one. |
| `quote` | `{ bid?, ask? }` or a function returning one, read each frame. **Required for bid and ask.** `setQuote(null)` clears it. |

### What the numbers mean

- **The session comes from the bar gaps**, through `sessionStartFlags`, not from a calendar midnight. The calendar is the fallback for a series with no readable break, which is the right answer for daily bars.
- **The session in view is the one containing the viewport's right edge** (`dataLayer.indexToTimeFloat(timeScale.visibleRange().to)`), so panning back through history moves previous close back with it. The right-offset gap past the last bar still resolves to the newest session.
- **Previous close is the previous session's last *traded* close**, walked back over a whitespace tail so a halted closing minute does not blank the level.
- **Session high and low ignore whitespace**, because `NaN` loses every comparison silently.
- **A level with no data is `null`, never `0`.** Nothing is drawn for it. `available(kind)` is the host's signal to render that control **disabled with its state visible**, not to hide it: "no previous session yet" is information, an absent checkbox is not.
- **There is no `autoscaleInfo`.** A previous close a gap away from the session in view would stretch the range and flatten the bars the chart is for. A reference level that scrolls off the top is the lesser harm, and it is what the last-price line already does.

### Do not double-draw the last price

The pane already draws the last-price line and tag from `SeriesStyle.priceLineVisible` / `lastValueVisible`. Two owners would paint it twice, so the `lastPrice` level defaults to off and two helpers translate between the shapes:

```ts
import { lastPriceLevelFromSeriesStyle, seriesStyleForLastPriceLevel } from 'openalgo-charts';

const style = chart.primarySeriesInfo()!.style;
const row = lastPriceLevelFromSeriesStyle(style);            // { line, label } for your menu
chart.primarySeries()!.applyOptions(seriesStyleForLastPriceLevel({ line: true, label: false }));
```

Present it as one more row in the same family; write the answer back to the series it belongs to.

### The numbers without a canvas

`computePriceLevels({ bars, anchorTime, timezone, marketPhase, quote })` is pure and exported, returning the same `PriceLevelValues` the primitive computes. Use it for a readout, a test, or an alert check with no chart attached. `values()` on the primitive is the last frame's answer, so every level reads `null` before the first frame.

Session boundaries are cached per bar array (a `WeakMap` keyed on identity plus length and the first and last timestamp), because boundaries cannot move under an intra-bar tick. Replacing the array with `setData` invalidates it by identity.

## A custom primitive

Complete, HiDPI-correct, and hit-testable:

```ts
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit } from 'openalgo-charts';

class SupplyZone implements IPrimitive {
  private host: PrimitiveHost | null = null;
  private y0 = 0;                       // last painted bounds, media px
  private y1 = 0;

  constructor(private lo: number, private hi: number, private id = 'supply-zone') {}

  attached(host: PrimitiveHost) { this.host = host; }
  detached() { this.host = null; }
  zOrder() { return 'bottom' as const; }

  // Keep the band on screen even when price leaves it.
  autoscaleInfo() { return { min: this.lo, max: this.hi }; }

  setRange(lo: number, hi: number) {
    this.lo = lo; this.hi = hi;
    this.host?.requestUpdate();         // schedules a repaint; takes no arguments
  }

  draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext) {
    const d = rc.dpr;
    this.y0 = rc.priceScale.priceToY(this.hi);   // media px, remembered for hitTest
    this.y1 = rc.priceScale.priceToY(this.lo);
    const w = rc.plotWidth * d;                   // media -> device

    ctx.save();
    ctx.fillStyle = rc.hoverId === this.id ? 'rgba(239,83,80,0.22)' : 'rgba(239,83,80,0.12)';
    ctx.fillRect(0, this.y0 * d, w, (this.y1 - this.y0) * d);

    ctx.strokeStyle = '#ef5350';
    ctx.lineWidth = Math.max(1, Math.round(d));
    ctx.beginPath();
    for (const y of [this.y0, this.y1]) {
      const yy = Math.round(y * d) + 0.5;         // crisp 1px line
      ctx.moveTo(0, yy); ctx.lineTo(w, yy);
    }
    ctx.stroke();

    ctx.font = `${11 * d}px system-ui, sans-serif`;
    ctx.fillStyle = '#ef5350';
    ctx.textBaseline = 'top';
    ctx.fillText(rc.priceScale.format(this.hi), 6 * d, this.y0 * d + 4 * d);
    ctx.restore();
  }

  // x / y arrive in MEDIA px relative to the plot. No dpr here.
  hitTest(x: number, y: number, rc: PrimitiveRenderContext): PrimitiveHit | null {
    if (x < 0 || x > rc.plotWidth) return null;
    if (y < this.y0 || y > this.y1) return null;
    return { externalId: this.id, zOrder: 'bottom', distance: 0, cursor: 'pointer' };
  }
}

chart.addPrimitive(new SupplyZone(24100, 24250), 0);
chart.subscribeClick((id) => { if (id === 'supply-zone') openZoneEditor(); });
```

## A custom chart type

`registerChartType(type, entry)` adds a per-bar renderer the core dispatches to; there is no core change and no `switch`.

```ts
import { registerChartType } from 'openalgo-charts';

registerChartType('range-band', {
  defaultStyle: { lineWidth: 1.5, color: '#4f8cff' },
  isPriceSeries: true,          // its last close drives the last-price line and tag
  draw: (ctx, items, toY, barSpacing, dpr, style, rc) => {
    const w = Math.max(1, Math.floor(barSpacing * 0.7)) * dpr;
    ctx.fillStyle = style.color ?? rc.theme.lineColor;
    for (const { x, bar } of items) {
      const yh = toY(bar.high) * dpr;             // toY returns MEDIA px
      const yl = toY(bar.low) * dpr;
      ctx.fillRect(Math.round(x * dpr - w / 2), yh, w, Math.max(1, yl - yh));
    }
  },
  // Per-bar autoscale contribution for this series' own price scale.
  extents: (bar) => ({ min: bar.low, max: bar.high }),
});

chart.addSeries('range-band').setData(bars);
```

`RendererEntry` in full: `defaultStyle: SeriesStyle`, `isPriceSeries: boolean`, `draw(ctx, items, toY, barSpacing, dpr, style, rc)`, `extents(bar, style)`. `items` is `{ x: number /* bar centre, media px */, bar: Bar }[]`, already culled to the visible range and conflated when `conflate` is on. `rc` is `{ plotHeight, maxVolume, theme }`, media px, the visible-window volume peak, and the palette.

`registeredChartTypes()` lists every registered id. `'point-figure'` and `'kagi'` live in the transform tier and only resolve once `openalgo-charts/transform` is imported.

**Write a chart type only when the thing is one mark per bar on the time axis, driven by `Bar` fields, and it should feed autoscale through `extents`.** Everything else is a primitive: zones spanning arbitrary prices, bands between two other series, chrome and controls, anything hit-testable, anything anchored to `{ time, price }` rather than to a bar, and anything that must sit on the overlay canvas.

## Foot-guns

**A primitive that draws nothing until it has data must still return a real `zOrder()`.** The pane calls it on every frame for every primitive, before `draw`.

**`hitTest` geometry must come from the last `draw`, not from a fresh computation.** If you recompute layout in `hitTest` you will drift from what is on screen the moment a scale changes between frames.

**`rc.theme.background` can be the string `'transparent'`.** Built-ins branch on it (`PriceLine`, `PaneLegend`) rather than filling with it; a plate filled with `'transparent'` disappears against a busy chart.

**`rc.bars()` returns the live array the data layer holds.** Treat it as read-only, and guard the call, a synthetic render context may not supply it.

**`series.update()` schedules a `Full` repaint,** which re-runs every `autoscaleInfo()` and every `draw`. Cache anything expensive across frames.

Related: [core-api](core-api.md) (`addPrimitive`, invalidation levels, the event bus), [chart-types](chart-types.md) (the built-in renderers), [drawing-tools](drawing-tools.md) (`DrawingLayer`, a primitive built on this contract), [trading](trading.md) and [trade-tier](trade-tier.md) (order lines and `tradeHost`), [indicators](indicators.md) (`IndicatorFill`, `PaneLegend`), [events-and-state](events-and-state.md) (click and drag routing), [scales-and-panes](scales-and-panes.md) (which scale a primitive sees).

## Anchoring to the chart instead of a pane (1.6.0)

```ts
chart.addPrimitive(mark, { anchor: 'chart-bottom' })   // or 'chart-top'
```

Pass a placement instead of a pane index and the engine re-homes the primitive whenever a
pane is added, removed, moved or maximized. Use it for anything that is chart furniture
rather than pane furniture: a watermark, a corner clock, a brand mark.

Maximize is the reason this exists rather than a `paneAdded` listener. It HIDES the other
panes, so a primitive pinned to pane 0 disappears with it instead of merely sitting in the
wrong place, and no amount of host bookkeeping fixes that from outside.

`removePrimitive` also clears the anchor registration, so a removed primitive stays removed;
before that was wired, the next pane change resurrected it.
