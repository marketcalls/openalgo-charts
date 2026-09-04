# Core API

*When to read this: you are creating a chart, adding or mutating series, wiring events, converting between data and pixels, or reasoning about when the chart repaints.*

Source of truth: `src/core/chart.ts`, `src/model/series.ts`, `src/index.ts`.

## First chart

```ts
import { createChart, darkTheme } from 'openalgo-charts';

const chart = createChart(document.getElementById('chart')!, { theme: darkTheme });

const series = chart.addSeries('candlestick');
series.setData([
  { time: 1700000000, open: 100, high: 104, low: 99, close: 103, volume: 1200 },
  { time: 1700003600, open: 103, high: 106, low: 102, close: 105, volume: 900 },
]);

chart.fitContent();
```

`createChart(container, options?)` returns a `Chart`; `new Chart(container, options?)` is equivalent and also exported.

**The container must already have a non-zero size.** The constructor calls `applySize(container.clientWidth, container.clientHeight)`; a container with no height renders a zero-height chart until the `ResizeObserver` fires.

**The chart takes over the container's inline styles.** It sets `display:flex`, `flexDirection:column`, `touchAction:none`, `background` from the theme, `position:relative` when the computed position is `static`, plus `role="application"`, `aria-label` and `tabindex`. It appends one `<div>` per pane and a visually-hidden live region.

## ChartOptions

| Key | Type | Default | Notes |
|---|---|---|---|
| `document` | `Document` | `container.ownerDocument` | Element factory (SSR / multi-window). |
| `pixelRatio` | `() => number` | `window.devicePixelRatio ?? 1` | Called per frame; canvases resize to media x dpr. |
| `raf` | `{ schedule, cancel? }` | `requestAnimationFrame` | Injectable frame scheduler (deterministic tests). |
| `theme` | `ChartTheme` | `DEFAULT_THEME` | See [themes-and-styling](themes-and-styling.md). |
| `priceAxisWidth` | `number` | `56` | Media px. Also the width reserved for a left axis when one exists. |
| `timeAxisHeight` | `number` | `22` | Media px, bottom pane only. |
| `legendOffset` | `{ top?, left? }` | `{ top: 6, left: 8 }` | Where indicator legend rows start in the top-most pane. |
| `crosshairMode` | `'normal' \| 'magnet'` | `'normal'` | `magnet` snaps to O/H/L/C, price pane only. |
| `now` | `() => number` | `performance.now` | Time source for kinetic pan / navigator fade. |
| `conflate` | `boolean` | `false` | OHLC-preserving downsampling when bars fall under ~0.5 device px. |
| `conflationFactor` | `number` | `1` | Conflation aggressiveness. |
| `renderer` | `'canvas2d' \| 'webgl2' \| 'auto'` | `'canvas2d'` | Which backend paints the series. `'webgl2'` throws until `openalgo-charts/webgl` has been imported, and on a device without WebGL2 falls back to `canvas2d` with one console warning; `'auto'` takes `webgl2` when it is registered and works on this device, else `canvas2d`, silently. Decided once, at construction; read the result from `chart.rendererKind`. See [Render backends](#render-backends). |
| `renderBackend` | `RenderBackendFactory` | from `renderer` | Build the backend yourself, one call per pane, bypassing `renderer` and the registry. A factory that returns `null` gets the 2D backend for that pane. |
| `grid` | `Partial<GridOptions>` | `vertLines`/`horzLines` `true` | Visibility plus per-axis colour, dash, width and spacing. Unset colours fall through to the theme. |
| `canvas` | `CanvasOptions` | `{}` | Grid, crosshair, scale text/lines, plot margins in one block. See [settings-and-menus](settings-and-menus.md). |
| `statusLine` | `LegendStatusLineOptions` | all on | Per-field status-line switches applied to every pane legend. |
| `ariaLabel` | `string` | `'Interactive financial chart'` | |
| `shortcuts` | `ShortcutManager \| Partial<ShortcutManagerOptions> \| false` | built-in keymap | `false` disables keyboard control. |
| `priceFormatter` | `(price: number) => string` | tick-size-aware `toFixed` | Applies to each pane's **right** scale: axis labels, last-price tag, price-line labels. |
| `priceScale` | `Partial<PriceScaleOptions>` | `DEFAULT_PRICE_SCALE_OPTIONS` | Applied to each pane's **right** scale as the pane is created. See [scales-and-panes](scales-and-panes.md). |
| `timeFormatter` | `(utcSeconds, tickMark?) => string` | built-in labels in `timezone` | Time axis and crosshair time tag. Outranks `timezone` for labels. |
| `timezone` | `string` (IANA name) | `'Asia/Kolkata'` | Zone the axis, crosshair tag and calendar-anchored indicators resolve in. **Throws** on a name the runtime does not recognise. See [data-and-time](data-and-time.md). |
| `timeNavigator` | `boolean \| Partial<TimeNavigatorOptions>` | `true` | Hover-revealed zoom/step controls above the time axis. |
| `axisChrome` | `AxisChromeOptions` | `{}` (nothing drawn) | `sessionClock` (corner clock in the chart's zone), `barCountdown` (second row in the last-price tag), and `clock`, a **wall-clock UTC seconds** source defaulting to the system clock. Not re-appliable through `applyOptions`; use `setAxisChromeOptions`. See [scales-and-panes](scales-and-panes.md). |

**`DEFAULT_THEME` is `lightTheme`, not `darkTheme`.** A dark shell must pass `{ theme: darkTheme }` explicitly even though the `theme` JSDoc says otherwise.

There is no `width`/`height` option; size comes from the container plus `applySize`.

## addSeries

```ts
const vol = chart.addSeries('histogram', {
  paneIndex: 0,
  priceScaleId: '',                      // hidden overlay scale
  style: { color: '#33415e', base: 0 },
  priceFormat: { type: 'volume' },
});
```

`AddSeriesOptions`:

| Key | Type | Default | Notes |
|---|---|---|---|
| `paneIndex` | `number` | `0` | Panes are created on demand; pane 0 gets weight 1, later panes 0.32. |
| `style` | `SeriesStyle` | `{}` | Merged over the chart type's `defaultStyle`. See [chart-types](chart-types.md). |
| `priceScaleId` | `'right' \| 'left' \| ''` | `'right'` | `''` is a hidden overlay scale with no axis. |
| `priceFormat` | `{ type: 'price', precision?, minMove? } \| { type: 'volume' } \| { type: 'custom', formatter }` | none | Applied to the series' *price scale*, not the series. |

The first `addSeries` call whose type has `isPriceSeries: true` becomes the primary series: it drives the magnet crosshair, `CrosshairMoveEvent.bar`, the last-price line/tag, and the bars indicators compute from. Indicator-created series never claim it.

## SeriesApi

Returned by `addSeries`. Full surface (`src/model/series.ts`):

| Method | Signature | Notes |
|---|---|---|
| `setData` | `(items: readonly SeriesDataItem[]) => void` | Replaces all data. The first non-empty `setData` on the chart auto-fits once. |
| `prependData` | `(items: readonly SeriesDataItem[]) => void` | History paging; viewport is preserved. |
| `update` | `(item: SeriesDataItem) => void` | Updates the last item or appends. |
| `getData` | `() => Bar[]` | Normalized OHLC, oldest first. |
| `applyOptions` | `(style: Partial<SeriesStyle>) => void` | Merge + repaint. **Not** `setStyle`. |
| `remove` | `() => void` | Detaches from the pane and frees its data rows. |
| `priceScale` | `() => PriceScale` | The live scale this series maps to. |
| `createMarkers` | `() => SeriesMarkers` | Markers layer bound to this series. |

Items are `{ time, open, high, low, close, volume?, color? }`, `{ time, value, color? }`, or `{ time }` (whitespace gap). See [data-and-time](data-and-time.md).

## Lifecycle and sizing

- `chart.destroy()` — the only teardown method. **There is no `chart.remove()`.** It stops the render loop and kinetic animation, removes every indicator, disconnects the `ResizeObserver`, unbinds all pointer/wheel/keyboard listeners, destroys every pane, and clears the container's cursor hint.
- `chart.applySize(width, height)` — media px; no-ops when unchanged. A `ResizeObserver` on the container calls it automatically, so manual calls are only needed in hosts without `ResizeObserver`.
- `chart.applyOptions(opts)` takes a runtime subset only: `theme`, `grid`, `canvas`, `statusLine`, `priceScale`, `priceFormatter`, `timeFormatter`, `timezone`, `crosshairMode`. Nothing else from `ChartOptions` is re-appliable.

## Viewport

```ts
const range = chart.getVisibleLogicalRange();  // { from, to } fractional bar indices
mainSeries.setData(fullHistory);
chart.setVisibleLogicalRange(range);           // restore the user's zoom
```

- `chart.fitContent()` — fit all bars; no-op on an empty chart.
- `chart.resetScale()` — fit content **and** re-enable autoscale on every pane. This is what double-click runs.
- `chart.timeScale` — the live `TimeScale`; mutating it repaints via an injected change handler.

**A logical range is meaningless before data lands.** `setVisibleLogicalRange` indexes bars, so apply it after `setData`, not before.

## Coordinates

| Method | Direction | Notes |
|---|---|---|
| `timeToCoordinate(time)` | UTC seconds -> container x, media px | Interpolates and extrapolates past the right edge. |
| `coordinateToTime(x)` | container x -> UTC seconds | |
| `priceToCoordinate(price, paneIndex = 0)` | price -> container y, media px \| `null` | `null` when the pane does not exist. Uses the pane's **readout** scale, which is the one its first visible price series maps to, so it is right on a pane whose axis was moved to the left strip. |
| `coordinateToPrice(y, paneIndex = 0)` | container y -> price \| `null` | Same scale as above. |

Both price conversions force an autoscale pass first, so they are correct before the first paint.

## Formatters

```ts
chart.setPriceFormatter((p) => 'Rs ' + p.toFixed(2)); // every pane's right scale
chart.setPriceFormatter(null);                        // back to tick-size default
chart.setTimeFormatter((s) => new Date(s * 1000).toISOString().slice(11, 16));
chart.setTimeFormatter(undefined);                    // back to the built-in labels
chart.setTimezone('America/New_York');                // which zone those labels are in
chart.timezone();                                     // read it back
```

Per-series formatting goes through `addSeries({ priceFormat })` or `series.priceScale().setPriceFormatter(fn)`.

**`setTimezone` is not only a relabelling.** It also recomputes every calendar-anchored indicator (VWAP, TWAP, CPR, Seasonality), because moving the calendar moves where a session, week or month starts. It throws on a name the runtime does not recognise, so validate with `isValidTimezone(zone)` first if the name comes from user input. The default is `'Asia/Kolkata'`; a chart that sets no zone labels exactly as it always did. See [data-and-time](data-and-time.md).

## Screenshots and vector export

`chart.takeScreenshot(): HTMLCanvasElement` composites every pane's base + top canvas onto one opaque canvas at device resolution. `chart.downloadScreenshot(filename = 'chart.png')` does that and triggers a PNG download. Use these instead of the browser's native "Save image", which only captures the transparent overlay layer.

`chart.exportSVG(options?: ExportSvgOptions): string` is the same frame written as a standalone SVG document: every pane's base and top paint in DOM order, at pixel ratio 1, with axis labels and tags as `<text>` and no crosshair, hover or drag state. `ExportSvgOptions` takes `width` and `height` (media px; absent means the live size, and a different size lays the chart out for the export and puts the live layout back without a blank frame), `background` (default `true`; `false` leaves the document transparent for an embedded figure) and `dpr`, which only accepts `1` and throws on anything else. Saving is the host's job: `new Blob([svg], { type: 'image/svg+xml' })` and an anchor.

The serialiser behind it, `SvgContext`, is exported (with `SvgLinearGradient` and `SvgContextOptions`) so a host can run its own primitive or a bare renderer into one: construct it at the document size, pass `asCanvasContext()` to whatever paints, read `toString()`. Calls with no vector form (`setTransform`, radial gradients, `Path2D`, image data) throw with `strict: true` and are otherwise listed in `unsupported` and skipped; `measureText` is approximate (a per-character width table), which the tag boxes and label culling tolerate.

## Events

Two surfaces. The typed `subscribe*` helpers, and the string bus.

```ts
chart.subscribeClick((externalId) => { /* hit-tested primitives only */ });
chart.subscribeCrosshairMove((e) => { /* CrosshairMoveEvent */ });
chart.subscribeDrag(
  (id, price, time) => { /* per move */ },
  (id, price, time) => { /* on release */ },
);
```

**The `subscribe*` helpers store exactly one callback each and return `void`.** A second call replaces the first and there is no unsubscribe. For multiple listeners or teardown use the bus: `chart.on(name, cb)` returns an unsubscribe function; `chart.once`, `chart.off(name, cb?)` and `chart.emit(name, payload)` are also public.

Core event names: `ready`, `crosshair:move`, `click`, `hover`, `drag`, `drag:end`, `pan`, `zoom`, `resize`, `dblclick`, `contextmenu`, `lazy-load`, `paneResized`, `paneMoved`, `paneMaximized`, `paneRemoved`, `indicatorRemoved`, `indicatorSettings`. `ReplayController` adds `replay:start|frame|play|pause|end|stop`, and the trading tier routes `trading:*` through the same bus. See [events-and-state](events-and-state.md).

`CrosshairMoveEvent`: `time: number | null`, `index: number | null`, `price: number | null`, `bar: Bar | null`, `point: { x, y } | null`, `paneIndex?: number | null`, and on a move (not the all-null leave payload) `pressed: boolean`, `modifiers: PointerModifiers` (`{ shift, alt, ctrl, meta }`), `pointerType: PointerKind` (`'mouse' | 'touch' | 'pen'`), `pressure` (0..1 as the pointer events spec defines it: measured, else 0.5 while a button is held, else 0) and, only while pressed, `samples: PointerSample[]` (`{ x, y, pressure }` per coalesced position, container x and pane-local y). The same three pointer facts (`PointerInfo`) ride on `ChartClickEvent`, `ChartDragEvent` (which adds `point` and `samples`) and `ChartDragEndEvent` (which adds `point`); all seven types are exported from the base entry.

Two pure helpers from the input and render layers are exported for a host that wants the same feel outside the chart: `ZoomGlide` (with `DEFAULT_ZOOM_GLIDE_OPTIONS`, a `ZoomGlideOptions`) is the eased wheel zoom, a closed-form exponential approach in log space that the chart samples per frame, so a wheel tick glides the way a flick already does; `candleTier(bodyW, wickW, style)` says whether a candle this narrow still shows a body (`'full'`) or only its wick (`'wick'`), which the candle renderer uses to skip a body the wick has already painted, and which a custom renderer can use to draw the same pixels.

## History paging

```ts
chart.setHistoryLoader(async () => {
  const older = await fetchOlderBars();
  series.prependData(older);
  chart.historyLoadComplete();   // re-arms the trigger
});
```

Fires when the visible range's `from` drops below logical index 10, and re-fires only after `historyLoadComplete()`. A `lazy-load` event with `{ from, to, direction: 'backward' }` is emitted alongside.

## Panes and primitives

`chart.panes(): readonly Pane[]` exposes the live panes (each with `.priceScale`, `.weight`, `.series()`, `.primitives()`, `.base`, `.top`). Pane management lives in [scales-and-panes](scales-and-panes.md); `chart.addPrimitive(primitive, paneIndex = 0)` and `chart.removePrimitive(primitive)` in [primitives-and-plugins](primitives-and-plugins.md).

`chart.getState()` / `chart.restoreState(state)` serialise viewport, grid, crosshair mode, timezone, pane weights and price scales, indicators, the settings block (canvas, status line, trading colours, event filters), and an opaque `drawings` slot. **Series data is never captured**: `restoreState` returns a `RestoreReport` listing series descriptors for the host to rebuild.

## Option accessors

Beyond `applyOptions`, the chart reads and writes its own option blocks so a settings dialog has something to bind to: `setCanvasOptions` / `canvasOptions`, `setGridOptions` / `gridOptions`, `setStatusLineOptions` / `statusLineOptions`, `setPriceScaleOptions` / `priceScaleOptions`, `setAutoScale`, `setAxisChromeOptions` / `axisChromeOptions`, `setEvents` / `setEventOptions` / `eventOptions`, `tradingSettings` / `setTradingSettings`, `primarySeries` / `primarySeriesInfo`, `theme`, `crosshairMode`, `setTimezone` / `timezone`. One axis at a time there is `priceAxisState`, `setPriceAxisOptions`, `setPriceAxisAutoFit`, `setPriceAxisLockRatio` and `movePriceAxis`. The declarative schema over all of them is in [settings-and-menus](settings-and-menus.md).

## Render model

Each pane owns two stacked canvases: `pane.base` (z-index 0: background, grid, series, axes, bottom/normal primitives) and `pane.top` (z-index 1: top primitives and the crosshair). Both are sized media x `dpr`; all drawing happens in device-pixel scope.

`chart.invalidate((mask) => ...)` folds work into a single pending `InvalidateMask` and asks the `RenderLoop` for a frame; repeated requests inside one tick coalesce into one `rAF` callback. `InvalidationLevel` (exported):

| Level | Value | Work done |
|---|---|---|
| `None` | 0 | Nothing. |
| `Cursor` | 1 | Repaint the top canvas only. |
| `Light` | 2 | Repaint the base canvas at current scales, no rescale. |
| `Full` | 3 | Autoscale every price scale, then repaint everything. |

The effective level per pane is `max(globalLevel, paneLevel)`. Crosshair moves raise `Cursor` globally; hover changes raise `Light` globally; a primitive's `requestUpdate` raises `Light` on its pane only; data mutations, pan, zoom, resize, theme and grid changes raise `Full` globally.

**Every `series.update()` schedules a `Full` repaint.** A high-frequency feed therefore re-autoscales each frame; batch ticks upstream (see [feeds-and-live](feeds-and-live.md)) rather than calling `update` per tick.

## Render backends

The per-frame series pass on each pane goes through an `IRenderBackend` (`src/render/backend.ts`). The pane paints everything else (background, grid, axes, primitives) on the 2D context the backend hands back from `overlay2d()`, so a backend only has to own the one pass a GPU can speed up. `Canvas2dBackend` ships in the base tier, registers itself under `'canvas2d'`, and draws through the very same 2D context the pane already holds, so its op stream is byte for byte the one every chart drew before the port existed (`tests/e2e/render-parity.spec.ts` holds it to zero differing pixels).

```ts
interface IRenderBackend {
  readonly kind: RenderBackendKind;                       // 'canvas2d' | 'webgl2'
  readonly device?: RenderDevice;                         // { available, lost }; a GPU backend only
  mount(canvas: HTMLCanvasElement, ctx2d: CanvasRenderingContext2D | null): void;
  resize(widthPx: number, heightPx: number, dpr: number): void;
  beginFrame(clear: boolean): void;
  drawSeries(entry, items, priceToY, barSpacing, dpr, style, rc): void;  // RendererEntry.draw minus the context
  endFrame(): void;
  overlay2d(): CanvasRenderingContext2D | null;
  destroy(): void;
}
```

`mount` takes the pane's existing 2D context as its second argument (the pane's base `CanvasLayer` already asked the canvas for one; a second `getContext` would split a frame across two contexts). A backend that owns its canvas ignores it.

Choosing one: `chart.rendererKind` (a `RenderBackendKind`; `chart.renderer` is the same value under the name it first shipped with) reports what the chart actually paints with. It differs from the `renderer` option when the chosen factory declined (no WebGL2 on this device) and the 2D backend stood in, and from the moment a GPU backend degrades (see the fallback below). The registry behind the option is exported for a tier or host that brings a backend:

| Export | What it does |
|---|---|
| `registerRenderBackend(kind, factory)` | Register or replace the factory for a `RenderBackendKind`. `RenderBackendFactory` is `() => IRenderBackend \| null`; returning `null` declines at run time. |
| `unregisterRenderBackend(kind)` | Drop a registered backend. Refuses `'canvas2d'`, the fallback every other choice lands on. |
| `registeredRenderBackends()` | The kinds currently registered. |
| `resolveRenderBackend(choice?: RendererChoice)` | Turn the option into a factory: an unregistered explicit kind throws, a factory that declines falls back to `canvas2d`. |
| `createRenderBackend(choice?)` | One backend instance for the choice, via `resolveRenderBackend`. |
| `backendDegradation(backend)` | `RendererFallbackReason \| null`: `'context-lost'` while a GPU backend's context is away, `'unavailable'` when its device never came up (the program failed to compile on a live context), `null` for a healthy backend and always for `canvas2d`. What the chart polls after each frame. |

The export path bypasses the backend: `exportSVG` calls each renderer's `draw` directly on the serialising context, because a document has no pixels to take from a GPU. `candleGeometry` in [chart-types](chart-types.md#renderer-geometry) is the shared snapping source a second backend must reproduce.

### The WebGL2 tier (`openalgo-charts/webgl`)

```ts
import { createChart } from 'openalgo-charts';
import 'openalgo-charts/webgl';                 // registers the 'webgl2' backend

const chart = createChart(el, { renderer: 'auto' });
chart.rendererKind;                             // 'webgl2' where WebGL2 works, else 'canvas2d'
chart.on('renderer:fallback', (e) => { /* e.from, e.to === 'canvas2d', e.reason */ });
```

The GPU series backend is its own lazy tier (6.38 KB Brotli; nothing of it is in the base bundle, which `tests/renderer-option.test.ts` and `npm run shake` both check). Importing it registers the backend under `'webgl2'`, so `renderer: 'auto'` picks it up wherever WebGL2 is available and `renderer: 'webgl2'` stops throwing. The bare import is enough; `registerWebGL2Renderer()` is exported (idempotent) for a bundler that would drop a side-effect-only import. Its other exports:

| Export | What it does |
|---|---|
| `createWebGL2Backend(device?)` | One backend for one pane, or `null` when WebGL2 is unavailable on this device. The registered factory is this call, so an explicit `renderer: 'webgl2'` on such a device gets `canvas2d` and one console warning. |
| `isWebGL2Supported()` | Whether this browser hands out a WebGL2 context. A cached probe; always `false` outside a browser. |
| `WebGL2Backend` | The backend class, `new WebGL2Backend(device = sharedGlDevice())`, for a host that injects it through `renderBackend`. |
| `GlDevice`, `sharedGlDevice()` | The holder of the one page-wide context and the offscreen surface it draws on. `device.available` and `device.lost` are what `backendDegradation` reads. |
| `GlSurface` (type) | What the context is created on: a detached canvas or an `OffscreenCanvas`, or a stand-in in tests. |
| `WEBGL_TIER` | `'webgl'`, the tier's identity constant. |
| `VertexBatch`, `ColorCache`, `PremultipliedRgba` (types) | What `WebGL2Backend.batch` and `GlDevice.colors` are: the frame's vertex batch and the parsed, premultiplied colour cache. Type-only exports, for a host that reads them off a backend. |

**How it paints.** The pane keeps its base canvas and its 2D context; the backend is handed that context at `mount` like the 2D backend is. It batches every native series into one offscreen WebGL2 surface shared by every pane of every chart on the page (browsers allow around sixteen live contexts, so one per pane would fail a dashboard of a few multi-pane charts) and at `endFrame` composites the result into the pane's base canvas with a single `drawImage`, under the plot clip and exactly where the 2D backend would have painted the series. The DOM is unchanged, so `takeScreenshot`, `exportSVG` and the context-menu snapshot read the same canvases they always did, and axes, text, price lines, markers and drawings stay on the 2D path. Drawn natively: `candlestick`, `hollow-candle`, `volume-candle`, `bar`, `high-low`, `line`, `line-markers`, `step`, `area`, `hlc-area`, `baseline`, `column`, `histogram`. Rect-based types land on the same device pixels as the 2D renderers because both read the same geometry helpers; anti-aliased edges (lines, fills, markers) differ by sub-pixel fringe amounts. `kagi`, `point-figure` and any custom chart type flush the batch and draw through the 2D context, so z-order between series holds.

**Falling back.** The chart reads `backendDegradation` on every pane after each frame. When a GPU backend loses its context, or its program fails to compile on a live context, the chart moves every pane to `canvas2d` for the rest of the session (a pane added later matches), `rendererKind` reads `'canvas2d'`, and one `'renderer:fallback'` event fires with a `RendererFallbackEvent` (`{ from: RenderBackendKind; to: 'canvas2d'; reason: RendererFallbackReason }`, the reason `'context-lost' | 'unavailable'`). The frame in which the context went away is painted through the backend's own 2D fallback, so the chart never shows a blank frame. The types `RenderDevice`, `RendererFallbackReason` and `RendererFallbackEvent` are exported from the base entry.

## The rest of the base surface

These are exported and supported, but sit outside the paths above. Signatures are
from `dist/index.d.ts`.

**Defaults you can read rather than retype.** Each is the exact object the engine
starts from, so spreading one keeps your override honest when a new key is added.

| Export | Type |
|---|---|
| `DEFAULT_CANDLE_STYLE` | `CandleStyle` |
| `DEFAULT_HISTOGRAM_STYLE` | `HistogramStyle` |
| `DEFAULT_CANDLE_BUILDER_OPTIONS` | `CandleBuilderOptions` |
| `DEFAULT_CHART_TABLE_OPTIONS` | `ChartTableOptions` |
| `DEFAULT_TIME_NAVIGATOR_OPTIONS` | `TimeNavigatorOptions` |

**Primitives you can attach directly.** Both implement `IPrimitive`, so they follow
the rules in [primitives-and-plugins](./primitives-and-plugins.md).

- `ChartTable` - a grid pinned to a pane corner. What an indicator's `table` hook
  builds for you; attach it yourself when the table is not tied to a study.
- `IndicatorDrawings` - the primitive behind a descriptor's `draws` hook. One
  primitive holds the whole shape list, because a descriptor rebuilds its shapes on
  every recompute and per-shape primitives would re-sort z-order on every live tick.

**Calendar boundaries, zone-aware.** The `zone` argument defaults to
`DEFAULT_TIMEZONE`; never let it fall through to the browser's local zone.

```ts
isNewZonedWeek(prev, now, zone?)   isNewZonedMonth(prev, now, zone?)
isNewZonedQuarter(prev, now, zone?) isNewZonedYear(prev, now, zone?)
startOfZonedWeek(utcSeconds, zone?) startOfZonedMonth(utcSeconds, zone?)
formatZonedDate(utcSeconds, zone?)  formatZonedTimeSeconds(utcSeconds, zone?)
formatIstCrosshairLabel(utcSeconds)
```

`barCloseSec(interval, barStartSec, zone?)` returns when a bar closes, or `null` for
a code with no clock length - tick, Renko and range bars. Do not treat `null` as zero.

**Cache and feed plumbing.** `barCacheKey(req)` is the key
[`withBarCache`](./feeds-and-live.md) stores under; build it the same way if you
pre-seed the store. `backoffDelayMs(attempt, opts)` is the reconnect schedule.
`classifyAuthAck(raw)` returns `'ok' | 'failed' | null`, `parseTopic(topic)` splits a
subscription topic, and `readSequence(raw)` pulls a sequence number when present.
`decodeOrder(raw, path?)` returns an `OrderDecodeResult` rather than throwing, and
`mapOrderStatus(s)` narrows a broker string to `OrderStatus | 'unknown'` - an
unrecognised status stays visible instead of being silently dropped.

**Geometry, for a primitive doing its own drawing.**

- `bitmapSize(mediaWidth, mediaHeight, dpr)` - device-pixel size of a canvas
- `snapToDevicePixel(mediaCoord, dpr)` - the half-pixel alignment that keeps a
  1 px line from rendering as a 2 px blur
- `precisionForStep(step)` - decimal places implied by a tick size
- `watermarkRect(position, margin, w, h, plotW, plotH)` and
  `tableOrigin(position, margin, w, h, plotW, plotH)` - corner placement

**Interaction.** `beginPick(host, kind, cb)` starts a price or time pick and returns
its cancel function; call it to tear the pick down. `isRebasing(mode)` reports whether
a `PriceScaleMode` re-bases the series, which is true for `percentage` and
`indexed-to-100` and is why a rebased pane cannot share an axis with an absolute one.

## Types that name a public signature

These sit in public signatures and are now exported, so a host can annotate what
it receives instead of restating the shape:

| Type | Where it shows up |
|---|---|
| `ChartSettingsInput` | `ChartSettingsTab.inputs`. A union of `IndicatorInput` and `ChartSettingsColorPairInput` |
| `ChartSettingsColorPairInput` | The settings-dialog control that edits an up/down colour pair as one field |
| `AxisStyle` | What `resolveScaleStyle` returns |
| `OrderUpdateEvent` | The argument to `OpenAlgoWsFeed.onOrderUpdate` |

They were referenced by the public API long before they were exported, which
meant a host writing its own settings dialog had to infer the shape or copy it.
