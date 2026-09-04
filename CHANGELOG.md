# Changelog

All notable changes to OpenAlgo Charts.

## 2.0.2

### Added

- **`doubleClick`, a `ChartOptions` key for what a double-click on a pane
  does.** `'reset'` is the default and what the chart has always done: fit
  every loaded bar and autoscale, which also lands the viewport on the oldest
  bar and wakes a history loader, so on a live terminal a double-click fetched
  another page. `'maximize'` toggles the pane under the pointer to the whole
  stack, which is what a multi-pane terminal usually wants from the gesture;
  `'none'` only emits. The `dblclick` event now carries `paneIndex`, `x`, `y`
  and a `handled` flag: a listener that acts on the press itself sets it and
  the chart's own action is skipped. A double-click during placement still
  finishes the shape whatever the option says.


### Sizes

Measured with `npm run size` (Brotli) on the 2.0.2 build: base engine 66.45 KB
against 67 kB, base + trade 74.06 KB against 75 kB, widget terminal 155.09 KB
against 156 kB, everything 182.39 KB against 183 kB. The other six rows did not
move.

## 2.0.1

### Fixed

- **A depth subscription asks for its depth under the key the proxy reads.**
  `formatSubscribe` sent the requested book depth as `depth_level`; the
  OpenAlgo websocket proxy reads `depth`, and the platform's protocol
  reference names `depth`. Every request above the default was therefore
  served at five levels with no error, since five is also the proxy's
  fallback. The frame now carries `depth`, and keeps `depth_level` beside it
  for any consumer that learned the old name from this library. Found while
  wiring the 2.0.0 depth ladder into a host; the ladder was the first caller
  to ask for more than five.

### Sizes

Measured with `npm run size` (Brotli) on the 2.0.1 build: base engine 66.42 KB
against 67 kB, base + trade 74.03 KB against 75 kB, widget terminal 155.06 KB
against 156 kB, everything 182.37 KB against 183 kB. The other six rows did not
move.

## 2.0.0

The drawing model, rebuilt, and the chrome as a package. A `Drawing` now
carries a paint order, a text block and a per-level colour, the controller
selects more than one at a time, and every 1.9.x layout and clipboard body is
upgraded on the way in. The series pass goes through a render backend port
with a WebGL2 backend behind it, the chart exports itself as vector SVG, and
`openalgo-charts/widget` is the eighth tier: the toolbar, rail, dialogs and
shortcuts in one call, so a host that wants a terminal rather than a chart no
longer writes them. A 1.9.x host has a step-by-step guide in
[`docs/migrating-to-2.md`](docs/migrating-to-2.md).

### Breaking changes

- **`DrawingStyle` no longer carries text.** `text`, `fontColor`, `fontWeight`,
  `fontStyle`, `textAlign`, `textVAlign` and `textPosition` moved into their own
  block, `drawing.text` (a `DrawingText`: `value`, `color`, `bold`, `italic`,
  `align`, `valign`, `position`, the font and plate keys), because seven keys
  that only meant something to the eight tools that draw words were sitting on
  every trend line's style bag, and a host could not tell a label from a stroke
  colour without knowing the tool. Tools now merge a `defaultText` under the
  caller's text the way `defaultStyle` merges under style.

- **`style.levels` is `FibLevel[]`, not `number[]`.** Each rung is
  `{ ratio, color?, enabled?, label? }`, so one level can be recoloured,
  relabelled or hidden without rebuilding the ladder. `levelColor(ratio)` is
  the one statement of the conventional colour per ratio (`LEVEL_NEUTRAL` for
  the anchors and for anything unnamed), shared by every fib and gann tool and
  by the migration, so 0.618 reads as the same thing on every tool.

- **`toJSON()` returns `{ version: 2, drawings }`** (a `DrawingsDocument`), and
  `chart.getState().drawings` is therefore a document, because a bare array
  carries no version and could never be told apart from the next shape.
  `fromJSON` still accepts a 1.9.x bare array. `DRAWING_CLIPBOARD_VERSION` is
  now 2 and tracks `DRAWING_STATE_VERSION`; a version 1 clipboard body is
  accepted and upgraded.

- **`Drawing.zIndex` is required on the type** (`add()` fills in 0), and
  **`drawings()` is paint order**, not creation order, because a layer that
  sorts by a field must be able to trust the field is there; `createdAt` keeps
  the creation time and `DrawingInput` is what `add()` accepts.

- **`select()` takes a selection.** `select(id | ids | null, additive)`
  replaces the selection, or with `additive` toggles each id into it;
  `selected()` is now the primary (first-picked) id and `selection()` is the
  whole list. A host that called `select(id)` and read `selected()` sees no
  change; one that assumed the selection had at most one member should read
  `selection()`.

- **`chart.renderer` is `rendererKind`.** The old name stays as the same value,
  but the type is `RenderBackendKind` and it reports the backend the chart
  actually paints with, which differs from the `renderer` option when the
  chosen backend declined or fell back.

### Added

- **`openalgo-charts/widget`, the eighth tier and the only one that ships
  DOM.** `createWidget(container, options)` builds the chart with its chrome
  in one call: a top bar (symbol box with search, interval pills, chart type,
  Indicators, capture, settings, theme), the drawing rail from the draw tier's
  sprite with pins, flyouts, magnet and stay modes, a status line, toasts, a
  keymap with a `?` shortcuts panel and conflict reporting against the
  engine's own table, and optional layout persistence
  (`persist: true | namespace`). Every dialog is generated from a schema the
  engine already ships: chart settings from `chartSettingsSchema`, indicator
  settings from the descriptor, drawing properties from
  `drawingSettingsSchema`, plus an indicator picker, a level editor for the
  fib and gann family, an in-place text editor and a right-click menu that
  offers order entry through `onOrder`, so a control exists only where the
  engine has something behind it. The chrome takes its colours from the
  active `ChartTheme` through `--oac-` tokens, so `setTheme` recolours canvas
  and chrome together. The engine still ships no DOM: the widget is a
  packaged host driving the public API, kept out of every other bundle by the
  ESLint tier ACL and by `npm run shake`, and it must not touch the document
  on import. Exported alongside `createWidget`: the `Widget` handle, the
  `WidgetContext` every mount is handed, the dialog registry
  (`registerWidgetDialog`, `widgetDialog`), the seven `mount*` functions,
  `Keymap`, `mountRail`, `mountTopbar`, `mountStatusline`, `mountToasts`,
  `renderForm`, the token helpers, `WIDGET_TIER`. 35.56 KB Brotli against a
  36 kB budget; base + draw + indicators + widget, what one `createWidget`
  call loads, 155.03 KB against 156 kB.

- **A render backend port, and a WebGL2 backend behind it.** The series pass
  on each pane goes through an `IRenderBackend` (`beginFrame`, `drawSeries`,
  `endFrame`); the shipped `Canvas2dBackend` draws through the pane's own 2D
  context and is pixel-identical to 1.9.2. The `renderer` option
  (`'canvas2d' | 'webgl2' | 'auto'`, default `'canvas2d'`) or an injected
  `renderBackend` factory picks the backend once, at construction, because a
  backend that could change under a frame would have to be checked by every
  renderer. The new `openalgo-charts/webgl` tier (6.38 KB Brotli) registers
  `WebGL2Backend` under `'webgl2'`: every standard chart type is batched into
  one shared offscreen WebGL2 surface with analytic anti-aliasing and
  composited into the pane's base canvas, so screenshots, the SVG export and
  the DOM are unchanged; kagi, point-figure and custom types draw through the
  2D context. An explicit `'webgl2'` throws until the tier is imported and
  falls back to `canvas2d` with one console warning on a device without
  WebGL2; `'auto'` is silent. A lost context or an unusable device moves the
  chart to `canvas2d` for the session and emits `renderer:fallback`
  (`RendererFallbackEvent { from, to, reason }`). Exported alongside:
  `registerRenderBackend`, `unregisterRenderBackend`,
  `registeredRenderBackends`, `resolveRenderBackend`, `createRenderBackend`,
  `backendDegradation`, `candleGeometry`, and from the tier
  `createWebGL2Backend`, `isWebGL2Supported`, `GlDevice`, `sharedGlDevice`,
  `registerWebGL2Renderer`, `WEBGL_TIER`.

- **Vector export.** `chart.exportSVG(options?)` returns the chart as a
  standalone SVG string: the ordinary paint of every pane, run once into a
  serialising 2D context at pixel ratio 1, so axis labels and tags stay text
  and lines stay lines, and there is no second renderer to drift from the
  canvas one. Nothing transient is in it (no crosshair, hover or drag).
  `ExportSvgOptions` takes `width` and `height` (a different size lays the
  chart out for the export and puts the live layout back without a blank
  frame), `background` and `dpr` (only `1`). The context itself,
  `SvgContext`, is exported with `SvgLinearGradient` and `SvgContextOptions`
  for a host that wants to run its own primitive into one.

- **`zIndex`.** Below zero paints under the series, at or above zero over it;
  ties break by list order. `setZIndex`, `bringToFront` and `sendToBack`
  (band-local: they never cross the series), `sendBehindSeries` and
  `bringAboveSeries`. A default of 0 paints exactly where 1.9.2 painted, which
  the render-parity harness checks at zero differing pixels.

- **Multi-select.** `selection()`, `updateMany`, `removeMany`,
  `duplicate(ids)` and `nudge(ids, dx, dy)`. A shift, ctrl or meta click is
  additive (the chart's `click` payload now carries the three flags). A body
  drag on an unselected drawing selects it alone and then moves the whole
  selection as one undo entry, because "move these three together" was three
  drags and three undo steps; locked members stay. New bus events
  `drawing:select { ids }` and `drawing:change { ids, kind }` fire alongside
  the legacy `draw:*` names, which are unchanged.

- **A per-tool settings schema.** `drawingSettingsSchema(toolId)` returns the
  fields a host may show, as dot paths with a control kind, and a tool
  declares only fields its `draw` reads: a control with nothing behind it is
  a defect, not a style choice. `readDrawingSettings` and
  `applyDrawingSettings` move values between a form and a drawing, coercing
  form strings by kind; `composeSettings` and the shared field lists build a
  custom tool's schema. The schema's `textIsContent` flag tells a host which
  tools are their text, so it can ask for it on placement.

- **`migrateDrawings(input)`**, the pure 1.9.x to 2.0 upgrade `fromJSON` runs,
  exported for a host reading a saved layout on its own. Load is lenient
  (anything renderable survives; a malformed optional field is dropped on its
  own) because a saved layout is the user's own work; paste stays strict
  because a paste is foreign input.

- **`keyToDrawingAction(e, ctx)`**, the editing counterpart of
  `matchDrawingShortcut`: undo, redo, copy, cut, paste, duplicate, delete and
  arrow-key nudge as a pure mapping the host wires to the controller. With
  `placing: true` a bare Escape, Enter or Backspace maps to `cancel`, `finish`
  or `popAnchor` first, so Backspace never deletes the selection while an
  anchor is being placed.

- **Drawing feel.** The controller tracks the unselected drawing under the
  pointer from the chart's `hover` event (`hovered()`, `drawing:hover { id }`)
  and the layer paints its handles faintly, so a drawing reads as grabbable
  before it is grabbed. Shift locks the free end of a line to 45 degree steps
  on screen while placing and while dragging a handle
  (`DrawingTool.angleLock`, set on the line family). `magnet` accepts
  `'off' | 'weak' | 'strong'` (`true` still means `'strong'`; `magnetMode()`
  reports the resolved mode): `'weak'` pulls only when an O/H/L/C sits within
  a few pixels, so a click on open space lands where it was made, and either
  mode paints a ring where the next click will land, on the bar's centre.
  `cancel()` and `popAnchor()` join `finish()` as the placement verbs. Grab
  targets grow for a touch pointer (`DrawingLayer.setPointerType`,
  `DrawingPointerKind`).

- **Line readouts.** `style.showStats` on `trend-line`, `ray`,
  `extended-line` and `arrow` adds a midpoint readout: signed change and
  percent, bars between the anchors, and the angle on screen. Off by default.

- **Position tools that place a trade.** `long-position` and `short-position`
  take the entry click and the target click; the second click is also the
  direction, so a release above the entry is a long and below it a short,
  whichever tool was armed. The stop lands opposite the entry at 1:2, sized on
  screen (64 px of risk, 150 px wide) rather than as a fraction of price.
  `DrawingTool.constrain(points, handle)` is new: the anchors to keep after
  one moved, which the position tools use to hold the stop and the target on
  opposite sides of the entry (drag one through the entry and the other
  reflects, so the trade flips with its ratio intact). `ExpandContext` gained
  optional `toPixel` / `fromPixel`, present when the host can map
  coordinates, so an `expand` default can be sized in pixels and fall back to
  chart units. The readouts are direction and R:R, money at risk and size,
  and each zone's move in percent, with `props.showHeader`, `showLossSize`,
  `showTargetLabel`, `showStopLabel`, `showPrices`, `profitColor` and
  `lossColor` as the toggles.
- **Freehand strokes.** The brush and highlighter ink every coalesced pointer
  sample a pressed move carries, thin the trail on release to the corners its
  shape needs, and paint it as a spline, so a fast stroke is a curve rather
  than a chain of chords. A pen stores `DrawingPoint.pressure` per sample (a
  mouse stores nothing) and `style.pressure` lets it drive the width; the
  clipboard and the migration keep the field. The geometry is exported, pure
  and DOM-free: `rdpSimplify`, `catmullRom`, `pressureWidth`.

- **Icons as markup.** Beside the tool path data, a chrome set on a 16 grid
  (`CHROME_ICONS`, `chromeIcon`, `chromeIconIds`, `CHROME_ICON_FILLED`, its
  viewBox, stroke and attribute bag) and string builders that derive from the
  one registry, so a rail, a flyout and the armed cursor cannot drift apart:
  `iconSvg` and `chromeIconSvg` (an inline `<svg>` in `currentColor`),
  `iconSprite` and `iconUse` (one hidden symbol sheet plus per-glyph `<use>`,
  ids under `ICON_SYMBOL_PREFIX`), and `toolCursor` (a CSS `cursor` value
  carrying the glyph over a contrasting halo).

- **Pointer payloads.** `crosshair:move`, `click`, `drag` and `drag:end` now
  report `modifiers`, `pointerType` and `pressure`; `drag` carries `point`
  and coalesced `samples`, `drag:end` carries `point`, and `crosshair:move`
  carries `samples` while pressed, which is how a freehand stroke reads its
  trail in placement mode. Click `pressure` is the press pressure. No
  existing field changed. `PointerModifiers`, `PointerKind`, `PointerSample`,
  `PointerInfo`, `ChartClickEvent`, `ChartDragEvent` and `ChartDragEndEvent`
  are exported from the base entry.

- **An eased wheel zoom, and a right-edge anchor.** A wheel tick used to land
  its whole step on one frame while a flick already glided to a stop, so the
  chart glided when panned and jumped when zoomed. `ZoomGlide` (exported with
  `ZoomGlideOptions` and `DEFAULT_ZOOM_GLIDE_OPTIONS`) eases the zoom in log
  space, folds a new tick into a running glide without a jump, and applies
  the first frame's step on the event itself so `barSpacing` reads its new
  value synchronously. The ease is on by default (`animZoom: true`), which is
  the one visible change for a host that sets nothing; `animZoom: false`
  restores the single-frame step of 1.9.2. `zoomAnchor: 'cursor' | 'right'`
  (`ZoomAnchor`) pins the latest bar under `'right'` so history stretches away
  from it, which is what a live chart usually wants; that default is unchanged.

- Named descriptors for the tools the entry did not name: `FORECAST`,
  `PRICE_RANGE`, `DATE_RANGE`, `CIRCLE`, `TRIANGLE`, `POLYLINE`, `ARC`, `CURVE`,
  `ROTATED_RECTANGLE`, `DOUBLE_CURVE`, `HIGHLIGHTER`, `BRUSH`, `FIB_CHANNEL`,
  `FIB_TIME_ZONE`, `FIB_FAN`, `GANN_FAN`, `GANN_BOX`, `CYCLIC_LINES`,
  `TIME_CYCLES`, `SINE_LINE`; `boundsOf` from the geometry helpers;
  `cloneDrawing` from the clipboard.

### Changed

- **A wheel zoom eases by default.** `animZoom` is `true` unless the host says
  otherwise, so a 1.9.x host sees its wheel zoom glide over a few frames
  instead of landing on one. The bar spacing it lands on is the same, and
  `barSpacing` still moves on the event itself; `animZoom: false` restores the
  single-frame step. Section 8 of
  [`docs/migrating-to-2.md`](docs/migrating-to-2.md).

- **A position box is two clicks, not one.** In 1.9.x one click dropped a
  1:1 box at 1% of price either way. New placements take the entry and the
  target and derive the stop; a 1.9.x box that was saved loads unchanged, with
  the same `[entry, target, stop]` anchor order.
- **The yfinance demo is a native-ESM host on the 2.0 drawing tier.** One
  5,677-line page became markup, one stylesheet and thirty modules that import
  `/dist/openalgo-charts.mjs` and its tier files by the URL a page would use,
  so the demo proves the published shape. The rail and its flyouts render from
  the tier's sprite, cursors and chord table; the properties bar is generated
  from `drawingSettingsSchema`; the shell has toasts, an overlay stack, a
  loading, empty and error card, a light theme, a typed feed with retries and
  per-slot cancellation, and a versioned layout document with migrations. The
  demo carries its own vitest config (`npm run test:demo`, part of
  `npm run verify`) and `server.py` gained `--fixture`, `--self-test` and
  validated parameters.

- The demo's text dialog moves to `drawing.text`, and its Duplicate button
  uses the controller's `duplicate`, which also carries text and props along
  (the hand-rolled copy dropped both).

### Fixed

- Fib retracement and extension stroke their anchor leg in `style.color`, so
  the colour control has a job; their bands are tinted by the level that
  closes them; `extendLeft` is honoured by retracement, extension and channel.
- `price-range` and `date-range` honour `showLabels`, which was declared but
  never read.
- Flag mark and arrow markers honour `style.fill = false`.
- Circle, triangle and rotated rectangle carry a shape label like rectangle
  and ellipse; the text tool honours `valign` as its vertical anchor.
- A chart-type switch in the demo came up without the watermark because
  `render()` never let go of the destroyed chart's handle.

### Performance

- **Candles skip the body fill once the wick already covers it.** At tight
  zoom `optimalBarWidth` collapses body and wick to the same width and x, so
  the body fill repainted pixels the wick had just painted in the same colour;
  `candleTier()` names the condition and `drawCandles` does one `fillRect`
  per candle instead of two, which is where a chart draws the most of them.
  Nothing changes at normal zoom, and the render-parity harness holds it at
  zero differing pixels.
- **Hovering a drawing costs the overlay tier only.** Both drawing layers are
  `'top'` primitives, so a hover change that touches only `'top'` hits raises
  a Cursor invalidation rather than Light: the pointer moves sixty times a
  second, and repainting the series for a line it merely passes over was a
  stutter. A base-canvas primitive keeps its Light repaint on enter and leave.
- **Dragging an under-series drawing lifts it to the top layer** for the
  gesture, so the base tier is not repainted per frame.
- **One draw call per frame on the GPU.** The WebGL2 backend batches every
  series of a pane into one shared page-wide surface, so a dashboard of
  multi-pane charts no longer spends its frame budget on the series pass, and
  it never opens more than one GL context however many panes are on the page.
- Freehand samples are projected through one `getBoundingClientRect` and one
  pane layout per event rather than per sample.

### Internal

- **ESLint, and the tier boundary fails the build.** The package's shape is
  eight lazily loaded bundles with enforced budgets, which only holds while the
  base never reaches into a lazy tier; prose in ARCHITECTURE.md did not fail
  CI, and one stray import would have pulled the indicator tier into the base
  with nothing going red. The ACL names its two existing crossings and rejects
  every other one, rejects a relative import of `../core` or `../draw` from
  `src/widget` (which would inline a second `Chart`), and rejects any import
  of the widget from another tier. `npm run lint` runs first in
  `npm run verify`.
- **A render-parity harness.** `scripts/build-baseline.mjs` builds a reference
  `dist` from another git ref and `tests/e2e/render-parity.spec.ts` renders
  both in one real browser and compares canvases pixel for pixel across seven
  bar spacings, because two shipped defects had passed a fully green unit
  suite. `tests/e2e/webgl-parity.spec.ts` diffs the GPU backend against the 2D
  one for every native type and asserts a real draw call happened, so a silent
  2D fallback cannot pass it; `tests/e2e/widget.spec.ts` mounts the built
  widget tier from the static server and checks the chrome painted.
- `check-dts` fails a widget declaration file that declares
  `DrawingController`; `check-shake` asserts the `oac-widget` CSS scope and
  the context-loss listener are absent from a chart-only build; the skills
  coverage script imports every built tier under Node, so a module-scope
  `document` access fails the release.
- `tests/renderer-option.test.ts` walks the import graph from the base entry
  and fails if it ever reaches `src/render/webgl`.
- The e2e suite records why sub-pixel bar spacings are not tested: the time
  scale clamps to `minBarSpacing`, so every spacing below 1 renders as 1,
  which also makes `conflate` inert at default settings.
- The last typedoc warning in the tree is gone, so the API reference builds
  clean with every tier as an entry point.

### Sizes

Measured with `npm run size` (Brotli) on the 2.0.0 build: base engine
66.39 KB against 67 kB (a 62 kB budget in 1.9.2, raised for the zoom glide,
the pointer payloads, the SVG serialiser and the render backend port);
base + trade 74.00 KB against 75 kB; draw tier 25.82 KB against 26 kB
(15.39 KB against 16 kB in 1.9.2, grown for the schema, the level palette, the
migration, the key map, the multi-select controller, the interaction feel,
the freehand geometry, the icon builders and the two-click position tool); webgl tier 6.38 KB against
7 kB; widget tier 35.56 KB against 36 kB; a widget terminal (base + draw +
indicators + widget) 155.03 KB against 156 kB; everything 182.34 KB against
183 kB (a 126 kB budget in 1.9.2). The indicator, transform and
profile tiers did not move. Chart-only shake 43.84 kB against 44 kB. Tool
count is unchanged at 51; 3999 tests across 170 files.

## 1.9.2

Eight annotation tools, and the icon set that was missing for all of them.

### Added

- **Annotations: `note`, `balloon`, `comment`, `signpost`, `price-note` and
  `table`**, plus `arrow-left` and `arrow-right`. 43 tools to 51.

  They share plate-and-tail machinery, so what separates them is where the tail
  leaves the plate and how the plate is shaped: a note pins a bar and sits its
  text up-right, a balloon floats above with the tail pointing down, a comment
  is the quiet square version, and a signpost stands a post on the bar so its
  plate can clear the price action entirely. That last one is anchored to
  **time** rather than to a level, which is what an event needs.

  `price-note` reads its price off the anchor rather than storing one, the same
  as `price-label`: a typed price is a number that was true once, which on a
  chart is worse than no number at all. `table` encodes its cells in
  `style.text` with a newline per row and a pipe between columns, so a whole
  table is one editable string and needs no new shape in the drawing model.

  `arrowMarker` was hard-wired to a boolean up/down, which cannot express left
  or right; it now takes an axis.

- **An icon for every drawing tool**, as path data: `DRAWING_TOOL_ICONS`,
  `drawingToolIcon(id)`, `drawingToolIconIds()`, and `ICON_ATTRS` carrying the
  attribute bag a host puts on the `<svg>`.

  The engine still ships no DOM. These are strings, and the host still builds
  its own rail, flyouts and toolbar. What it no longer does is draw fifty-one
  glyphs before it can show one, which is what every adopter had to do: the
  demo drew its own set, the reference terminal drew another, and each drifted
  on stroke weight, grid and density independently until the result read as
  fifty-one icons rather than as one set. A shipped set is worth more than a
  better glyph.

  Every glyph is authored to one grid, and `tests/draw-icons.test.ts` holds all
  of it mechanically: a 24 viewBox, a live area of 2 to 22, whole-unit
  coordinates, a single stroke weight, round caps and joins, a complexity
  ceiling, a minimum span, and no two glyphs drawing the same thing. A set of
  this size cannot be kept consistent by review, and those checks caught two
  faults on their first run that reading the paths had not: a spiral whose arc
  chain landed the pen outside the box, and the same glyph then filling only
  nine units of it.

  **Render at 24px or an integer multiple.** With a 2-unit stroke on whole
  coordinates, an orthogonal edge covers exactly two device pixels at 1:1. At
  18px the 0.75 scale puts it on 1.5 pixels and every edge is anti-aliased
  across two rows. That is a host sizing choice, and no path data can fix it:
  it is why a hand-drawn set at a 1.5 stroke on whole coordinates never looked
  crisp at any size.

### Changed

- The draw tier's budget goes from 14 to 16 kB for the eight tools and the icon
  set, measured at 15.39 kB. The pattern clusters still to come (Elliott,
  harmonics, pitchforks) are a sub-tier decision rather than another raise.

## 1.9.1

The legend and the axis name the same number, so they now spell it the same way.

Released as 1.9.1 rather than 1.9.0 at the maintainer's request.

### Fixed

- **An indicator legend disagreed with the axis beside it.** Seen on a live
  chart: a Supertrend legend read `1034.0` next to a price axis reading
  `1029.20`, and a Williams VIX Fix legend read `0.618` next to its own axis
  reading `0.62`. The two sit inches apart and describe the same quantity, so a
  reader is left to reconcile them with nothing to say which is right.

  The legend held a second opinion: it worked its format out from the pane's
  tick size, which is wrong in both directions. A study pane carries no tick at
  all since 1.8.9 stopped the instrument's reaching it, so the legend fell
  through to a magnitude ladder written for volume columns and printed three
  significant figures. And a price pane's tick alone knows nothing about the
  two-decimal floor or a host's own price formatter, so a volume study printed
  seven digits of share count where its axis said `1.20M`.

  The axis already answers all of that, so the legend asks it: `IndicatorHost`
  gains an optional `formatPrice(paneIndex, value)`, which `Chart` answers from
  that pane's price scale. One source of truth rather than two derivations that
  agree by luck. The magnitude ladder stays as the fallback for a host driving
  the indicator runtime without a chart.

## 1.8.9

Indicator precision, reported as one indicator reading `0.6` where it should read
`0.61`, and found to be wrong for a whole class of them.

### Fixed

- **A study pane was formatted in the instrument's tick size.**
  `Chart.setPriceScaleOptions` documents `'primary'` scope as "each pane's right
  scale only", and that is literally what it did: *every* pane's right scale,
  not just pane 0's. A host pushing the instrument's tick down chart-wide, which
  is the ordinary thing to do on a symbol change, therefore set the decimals on
  every study pane too.

  That is a category error. A tick size belongs to the instrument. An RSI is a
  dimensionless 0..100 band and a Williams VIX Fix is a percentage; neither
  trades in the instrument's tick. With a 0.10 tick the RSI axis read
  `70.0 / 50.0 / 30.0` and the VIX Fix read `0.6`, in both cases a precision
  nobody chose.

  `minMove` is now the one field in the chart-wide block withheld from a pane
  that does not quote the instrument. Pane 0 is one from birth, so a caller who
  configures nothing sees byte-identical behaviour there; any other pane starts
  out a study's until a host plots a price series on it, which promotes it and
  hands it the tick. Scope semantics are unchanged for every other field.

- **A study pane inferring precision from its own span still read too coarse.**
  Withholding the tick is only half the answer: a 0..100 band implies a step of
  one whole point, so the ladder was labelled `70` and a reading of 62.24 rounded
  to `62`, past the part a trader comparing it to the level is looking at. Those
  panes now carry `minPrecision: 2`, the same floor the percent-rebase branch has
  always used. The floor lifts above five integer digits, where a decimal stops
  being information: a cumulative study like OBV keeps its integer form, and a
  study living inside a tenth of a point still gets its third decimal.

  So an overlay study prints at the instrument's tick and a study on its own
  pane prints at two decimals or finer. **Custom descriptors get this with
  nothing to declare**, because the rule is keyed on the pane an indicator is
  handed rather than on anything in the descriptor. Checked by sweeping the
  registry rather than by fixing the two that were noticed.

- **A click on a primitive fired twice.** `_onPointerMove` ends a gesture itself
  when it finds the button already released, because a release over a context
  menu or outside the window never arrives. The real `pointerup` still lands
  afterwards, found no drag armed, and fell through to the plain click path to
  fire the same click again at the stale press coordinates. Every control
  addressed by `subscribeClick` doubled: an indicator legend's hide, maximize and
  move-pane, a comparison row's remove, an order pill's cancel. A toggle that
  fires twice is a control that looks dead. A gesture now ends once.

### Demo

`examples/yfinance/` gains a volume on/off control and real tooltips on its
icon-only controls. The tooltip it replaces was clipped at the rail's edge by an
`overflow-x` the rail never asked for, and the "double-click to keep the tool
active" line it shows is now wired rather than merely claimed.

## 1.8.8

Documentation and package metadata. No engine change: every number this library
draws is identical to 1.8.7.

### Added

- **A CDN guide**, and the two package fields that make the short URL work.

  Every release has been on unpkg and jsDelivr since it was first published,
  because both sit in front of npm rather than being places you upload to. But
  nothing in the docs said so, and `https://unpkg.com/openalgo-charts` returned a
  404: with no `main` (this package is ESM-first, through `exports`) the bare URL
  had nothing to resolve to. `unpkg` and `jsdelivr` now point at the standalone
  build, so it resolves.

  The new page leads with the module form, which is the one to reach for: import
  each tier straight from a URL and a chart carrying all 102 indicators is a
  single HTML file with no build step, no bundler and no install.

  It also writes down the two things the usual CDN-publishing advice gets wrong
  for this library. There is no stylesheet, because the engine ships no DOM, so
  the `<link rel="stylesheet">` such guides recommend would 404 on a file that
  does not exist and is not meant to. And there is no CDN deployment step to
  perform, because unpkg and jsDelivr mirror npm.

  The standalone script is documented for what it is: **base tier only**. There
  is no `registerBuiltinIndicators` on that global, so no built-in indicators and
  no drawing tools come with it. It exists for a page that cannot load modules.

## 1.8.7

Market replay, reported broken from a live terminal and rebuilt around the
question it exists to ask: from here, what happens next?

### Fixed

- **Entering replay drew an empty chart.** The data was there and the price axis
  was measured correctly; the viewport sat about 280 bars to the left of every
  bar. An indicator's plots are series in the same data layer, so
  `dataLayer.baseIndex` counts them, and 1.8.5 deferred indicator recompute to
  the frame. After replay truncated the price series to a prefix, the indicator's
  own series stayed at full length for the rest of the turn and held the base
  index up with it. A host that truncates and then positions the viewport in the
  same turn, which is exactly what entering replay does, converted its logical
  range against a base index hundreds of bars too high.

  A wholesale `setData` now recomputes before the base index is read. The tick
  path stays deferred, which is where the coalescing earns its keep: an appended
  bar makes the primary the longest series, so the base index is already right
  with the indicator a bar behind, and a burst of ticks between two frames still
  costs one recompute. Measured unchanged on the benchmark.

### Added

- **Intra-bar replay.** `ReplayController` takes `subBars`, the finer session
  the displayed bars are built from, and steps a sub-bar at a time so the newest
  bar forms in front of the user instead of landing complete. One 5-minute bar
  over 1-minute data takes five steps. Without it, every step lands a finished
  candle and the moment a trader is practising for, watching a bar build and
  deciding before it closes, never happens.

  A bucket closes on the displayed bar **verbatim** rather than on the aggregate,
  so two feeds that disagree mid-bar still agree on every close and a replayed
  session ends where the plain one does. `ReplayState` gains `subIndex` and
  `subSteps`, and its `bar` is the partial one while a bar is forming, which is
  what a host drives its own forming volume bar from. Followers stop at the last
  completed bucket: a volume histogram is summed and a candle is merged, and the
  controller is not told which it has. A seek still lands on a completed bar.

- **`TextWatermark`**, a word stamped faintly across the plot to say what mode
  the chart is in. A chart replaying August looks exactly like a chart showing
  today, and reading a live decision off history is the mistake it prevents. It
  shrinks to fit a narrow pane, hit-tests to nothing, and is captured by
  `takeScreenshot()` because it is drawn on the canvas rather than over it.

- **`ReplayShade`**, which dims every bar after an index and rules a line at the
  cut. Choosing a replay start while the next twenty bars are readable is
  choosing on hindsight, which is the one thing replay exists to remove. Add one
  per pane: a bright volume pane gives away what the price pane is hiding.

### Demo

`examples/yfinance/` now shows the whole flow, which is where all of the above
was proved: press Replay and pick a start bar with the future greyed across
every pane, walk it with a sub-bar counter in the transport, and leave through a
confirm rather than losing the playhead to a mis-click. A snapshot menu next to
it saves or copies the chart as a PNG, watermark included.

## 1.8.6

Both items are about the same thing: an indicator that has computed a number
should say what that number is, at the precision the instrument trades in. No
indicator maths changed.

### Added

- **Every plotted series now carries its current value as a tag on the price
  axis.** A study drew its line to the right edge and then said nothing about
  where it actually sat, so reading a Supertrend stop off the chart meant tracing
  the line back by eye against the ladder. The pane collected one tag and
  stopped, which meant the instrument claimed the only slot and every overlay,
  every indicator plot and every comparison series was skipped.

  A tag is drawn in its own plot's colour, formatted by the same scale as the
  ticks beside it, for any series on the pane's readout scale: an overlay on the
  price pane, a study on a pane of its own, a volume histogram on its own pane.
  A plot whose current value is `na` draws nothing rather than showing the last
  number it happened to have, so a flipped Supertrend tags one half and not both.
  Set `lastValueVisible: false` on a series style to opt out, the same flag that
  has always controlled the instrument's own tag.

  Tags are resolved against each other and against the ladder by the existing
  priority table, with a new `seriesValue` rank between `previousClose` and
  `tick`: two studies a rupee apart do not print over one another, a tag
  suppresses the plain tick it would otherwise sit on, and the last-price tag
  outranks all of them.

### Fixed

- **The legend rounded a four-figure price to whole numbers.** A Supertrend at
  1339.70 read `1340` in the legend while the price axis two inches away read
  1339.70. The legend formatter was a magnitude ladder written for volume
  columns, and one of its rungs rounds anything at or above 1000 to no decimals:
  fine for 12.35M of turnover, wrong for a price, and 0.30 out for anyone reading
  a stop off it. The legend now formats to the precision the pane's tick implies,
  which is the precision the axis prints. Panes with no tick, volume and open
  interest among them, keep the compacting ladder, and a `minMove` of 0 still
  means "infer" rather than "no decimals".

## 1.8.5

Three axis defects, all reported off a live chart placed side by side with a
professional terminal. No indicator maths changed.

### Fixed

- **The price ladder printed six labels whatever the pane measured.** A 700 px
  pane read one price every 120 px where the reference terminal read one every
  30, so a trader taking a level off the axis was interpolating between rungs
  hundreds of points apart. The count now follows the pane height at a fixed
  spacing (`PRICE_LABEL_SPACING`, 32 px), which puts about twenty prices on that
  same pane instead of five. Both are internal, like the axis renderer they
  serve; `PriceScale.ticks(maxTicks)` stays public and unchanged.

  A denser ladder has one visible consequence, and it matches the reference: the
  last-price tag now always suppresses the label next to it, because rungs sit
  about a tag-height apart. Suppression was already the rule, there was simply
  usually nothing close enough to suppress.

- **A session that had just opened carried no date.** Time-axis labels were only
  ever placed on the regular grid, so when a new day had fewer bars than the grid
  stride, no tick landed inside it and the date was never drawn: today's bars sat
  under yesterday's date with nothing marking the change. The first bar of a new
  day is now always a candidate, and it outranks the grid tick beside it, which
  is why a terminal prints "Sep" between two hourly labels rather than on the
  hour. Labels are resolved by priority and drawn left to right.

- **Bars painted into the price axis.** Nothing clipped the plot, and a bar is
  positioned by its centre and drawn outward, so the newest one against the right
  edge put half a body and a wick into the axis strip, behind the labels.
  Scrolling the series under the axis made it obvious. The plot is now clipped
  for series and primitives, and the clip is released before the ladder, the
  last-price tag and the trading pills, which live in that strip on purpose.

### Sizes

| Bundle | Limit | Actual |
|---|---|---|
| Base engine | 60 KB | 59.38 KB |
| Base + trade | 68 KB | 66.99 KB |
| Indicators tier | 30 KB | 27.27 KB |
| Draw tier | 14 KB | 13.13 KB |
| Transform tier | 5 KB | 2.66 KB |
| Profile tier | 11 KB | 10.66 KB |
| **Everything** | **124 KB** | **120.7 KB** |

The tree-shaken chart-only budget is now close: 37.89 KB against 38.00 KB.

2420 tests across 131 files.

## 1.8.4

A performance release. No indicator maths changed and no public surface moved:
every number this engine draws is the same as in 1.8.3.

### Changed

- **Indicator recompute is scheduled with the frame instead of the data update.**
  It ran synchronously inside `updateBar`, so a burst of live ticks spent a full
  pass over every bar, for every indicator, on every tick, and threw all but the
  last away unseen. Rendering was already coalesced into a frame; the maths was
  not.

  Measured on a 1875-bar chart, 50 ticks arriving between two frames:

  | | recomputes per indicator | burst |
  | --- | --: | --- |
  | before | 50 | typical 175 ms, heavy 643 ms |
  | after | 1 | typical 7 ms, heavy 21 ms |

  That is 24x on a five indicator chart and 31x on a ten indicator one. 643 ms
  of blocked main thread is roughly 38 dropped frames from a single burst, which
  is what a trader sees as jank at the open.

  **Deferring the maths does not defer the answer.** `chart.indicators()` and
  `IndicatorInstance.values()` both flush any pending recompute before returning,
  through a new optional `flushIndicators()` on `IndicatorHost`. A caller that
  updates a bar and reads the value back in the same turn still gets the fresh
  number. The hook is optional, so a host that implements `IndicatorHost` itself
  needs no change.

  This bounds recompute by the display refresh rather than by the tick rate. It
  does not make a recompute cheaper, so a host still pays once per frame for
  whatever history it has loaded.

### Added

- `npm run bench`, an indicator performance benchmark, now running in CI. The
  test suite proves the numbers an indicator produces and never the cost of
  producing them, so an algorithmic regression shipped silently before this.
  Budgets are a tenfold guard rather than a tight bound.
- `npm run soak`, a teardown and long-session memory harness. Measured: 1.30 kB
  retained per chart over 300 create and destroy cycles, and a heap flat across
  20,000 ticks (+9.4 bytes per tick, about 0.80 MB over a full trading session).
  Deliberately not in the CI gate: heap thresholds on a shared runner are flaky,
  and a memory test that cries wolf teaches people to ignore memory tests.

### Fixed

- Three documentation surfaces stated that `npm run size` was failing on the
  indicator tier and the aggregate row. That was true for the hour between the
  1.8.3 additions landing and the budgets being raised, and it never shipped.

### Sizes

| Bundle | Limit | Actual |
|---|---|---|
| Base engine | 60 KB | 59.2 KB |
| Base + trade | 68 KB | 66.81 KB |
| Indicators tier | 30 KB | 27.27 KB |
| Draw tier | 14 KB | 13.13 KB |
| Transform tier | 5 KB | 2.66 KB |
| Profile tier | 11 KB | 10.66 KB |
| **Everything** | **124 KB** | **120.53 KB** |

2411 tests across 130 files.

## 1.8.3

Eleven indicators added, taking the registry from 91 to 102, and every one of them
measured against the standard definition bar by bar rather than eyeballed. The
same harness was turned on the built-ins that were already shipping, which is
where this release earns its keep: three of them were wrong, and one had been
wrong since it was written.

**Read the Upgrading section before you take this.** Several studies now start
later than they used to and several defaults moved to the values the standard
definition pairs them with, so a saved chart will look different. Both changes
are deliberate and both make the old picture the wrong one.

### Added

Five volatility studies, five trend studies and one volume study. Each was built
from the published definition and then measured against it across 600 bars, at
the shipped defaults and at two or three other parameter sets, comparing every
plot on every bar and the warmup index on both sides.

- **Standard Error Bands** (`standard-error-bands`, Volatility, price pane).
  Upper, basis and lower with a shaded fill. The residual standard error
  `sqrt((Syy - Sxy^2/Sxx)/(periods - 2))` about the least-squares line, placed on
  the **regression endpoint** (the fitted value at the newest bar of the window)
  and only then smoothed, each leg independently. That ordering is the whole
  study: smoothing first and fitting after gives a different, wrong line. First
  print at `(periods - 1) + (averagePeriods - 1)`, so bar 22 at the 21/2/Simple/3
  defaults. Inputs: periods 21, errors 2, method Simple / Exponential / Weighted,
  averagePeriods 3, plus basis, band and fill colours. Worst relative difference
  against the standard definition 5.19e-15 at the defaults, 9.32e-16 and 1.32e-15
  at two other parameter sets.

- **Moving Average Channel** (`ma-channel`, Volatility, price pane). A simple
  mean of the **highs** and a simple mean of the **lows**, each with its own
  length and its own plot-time displacement, with a fill between them. Not a mean
  of the close with a spread bolted on, which is the shape it is usually mistaken
  for. The two legs warm up independently, so lengths 34 and 13 first print at
  bars 33 and 12. Worst relative difference 1.76e-15 on the upper leg and
  8.82e-16 on the lower.

- **Chaikin Volatility** (`chaikin-volatility`, Volatility, own pane). The rate
  of change of a smoothed high-low range: `roc(ema(high - low, periods),
  rocLookback)`, with a dashed zero level. First print at
  `(periods - 1) + rocLookback`, bar 19 at the 10/10 defaults. Bit-exact against
  the standard definition, worst relative difference 0.

- **Standard Deviation** (`standard-deviation`, Volatility, own pane).
  **Population** standard deviation of the close, dividing by `n` rather than
  `n - 1`, times a `deviations` multiplier. The population-against-sample
  question is the only thing that can be wrong here and it was settled by
  measurement rather than by reading: at fixture bar 4 the population reading is
  1.5514425743803728 and the sample reading would be 1.7346. Worst relative
  difference 2.77e-16.

- **Standard Error** (`standard-error`, Volatility, own pane). The residual
  spread of the closes about the least-squares line fitted through them. The
  divisor is `length - 2` because the fitted slope and intercept each consume a
  degree of freedom, which is what makes this a standard error rather than a
  standard deviation, and is why the input floor is 3 and not 1. Bit-exact
  against the standard definition at length 14 and at 34.

- **Linear Regression Slope** (`linreg-slope`, Trend, own pane). The ordinary
  least-squares gradient of close against bar position over a trailing window, in
  price per bar, with a dashed zero level. Nothing rescales the result, so the
  reading is in the instrument's own units and a slope of 0.67 means 67 paise a
  bar. Bit-exact at periods 14, 7, 2 and 50.

- **Smoothed Moving Average** (`smma`, Trend, price pane). Wilder's smoother with
  `alpha = 1 / length`, seeded from the simple average of the first `length`
  source values. That recursion is exactly what `rma` already does, so the
  descriptor adds no arithmetic of its own. Selectable source (open, high, low,
  close, hl2, hlc3, ohlc4), default length 7. Worst relative difference 2.26e-16
  across three parameter sets.

- **Net Volume** (`net-volume`, Volume, own pane). The bar's own volume signed by
  the direction its close took: up gives `+volume`, down gives `-volume`, an
  unchanged close gives 0. Bitwise identical to the standard definition on all
  600 fixture bars.

  **It has no warmup**, which is the load-bearing detail and the one an
  implementation gets wrong. Bar 0 has no previous close, so neither comparison
  can hold and the definition falls through to its zero arm; returning `null`
  there instead would be a defect, and the test pins bar 0 at 0.

  One presentation choice is ours rather than the definition's, and is flagged
  rather than hidden: it draws as a **histogram with base 0**, not as a line.
  This is a per-bar signed quantity that flips sign every few bars, and a line
  drawn through it is unreadable. The sibling volume descriptor is already a
  histogram with base 0, so this matches the house shape. The numbers are
  identical either way.

Three more trend studies landed late in the release, after the eight above were
already measured. They were built the same way, from the published definition and
then checked bar by bar against it.

- **T3 Average** (`t3`, Trend, price pane). A generalised double average applied
  three times over. One layer is `e1 * (1 + factor) - e2 * factor`, where `e1` is
  the SMA-seeded exponential average of the source and `e2` is that average of
  `e1`, so the layer sits exactly `factor` of its own lag ahead of a plain
  exponential average, and at `factor = 1` it is a DEMA. Cubing that expression
  gives terms of exponential depth three to six, and a slot is only finite where
  its deepest term is, so the warmup is `6 * (length - 1)`: bar 24 at the default
  length of 5, bar 12 at 3, bar 120 at 21, and bar 0 at length 1, where every
  average is the identity and T3 is the source. Inputs: length 5, factor 0.7,
  source, a Highlight Movements switch and three colours; with the switch on the
  line takes the rising or falling colour per bar and holds the neutral colour on
  an unchanged value.

  One deviation from literal arithmetic, flagged rather than buried: at
  `factor = 0` the layer returns `e1` instead of computing `e1 * 1 - e2 * 0`.
  Multiplying by zero would still let the second average's warmup blank a further
  `length - 1` bars of a line that has by then collapsed to a plain chained
  average. Nothing with a live factor touches that branch.

- **Hull Suite** (`hull-suite`, Trend, price pane). One overlay carrying three
  variations of the Hull average, the same line displaced two bars, and the band
  between them. `Hma` is `wma(2 * wma(n / 2) - wma(n), round(sqrt(n)))`; `Ehma`
  is the same shape with the SMA-seeded exponential average in place of both
  weighted passes; `Thma` is `wma(3 * wma(n / 3) - wma(n / 2) - wma(n), n)`,
  smoothed over the full window rather than its root, and is therefore handed
  **half** the configured length. First print at bar 60 for Hma and Ehma at the
  default length of 55 (a weighted average over 55 prints at bar 54 and the outer
  pass over `round(sqrt(55)) = 7` needs six more) and at bar 52 for Thma, whose
  windows are all 27. The floor inside and the round outside are both
  load-bearing and are pinned: at length 63, `round(sqrt(63)) = 8` puts the first
  value at bar 69 where flooring would put it at 68. Inputs: source, variation,
  length 55, length multiplier 1, colour the hull by trend, colour the candles by
  trend (off), show the band, and three colours. Both plots, the band and the
  candle colours read the undisplaced line only, so they cannot disagree, and
  hiding the band changes no colour.

  **Three controls the published definition carries are deliberately absent,
  because this engine cannot back them, and a control with nothing behind it is
  worse than an absent one.** A higher-timeframe mode with its own resolution
  input: `calc` is handed the chart's own bars and has no way to ask for another
  resolution. A line-thickness input: `style.lineWidth` is static in a plot
  descriptor and no settings key stands behind it, so the control would move
  nothing (both lines ship at 2). A band-transparency input: a fill's opacity is
  a fixed number in the descriptor rather than a settings key, so the band is
  fixed at 0.6.

- **Consolidation and Breakout** (`consolidation-breakout`, Trend, price pane).
  An inside-bar state machine rather than a formula. One carried index names the
  mother bar whose high and low define the current range; every later bar whose
  **body** (open to close, wicks ignored) sits inside that range extends the
  consolidation and is tinted, and the first body to escape it fires a marker and
  becomes the new mother. Two rails plot the live range and go null between
  consolidations, so two disconnected rails read as two separate ranges.

  The two reads of that index straddle the reassignment, and that ordering is the
  study: the break test reads the range as it stood before this bar could claim
  it, while the rails and the tint read it after. One bar therefore both fires
  its marker against the range it left and opens the next one. Collapsing the two
  into a single read shifts every signal by a bar and still looks plausible on a
  chart, so `tests/study-consolidation.test.ts` pins the breaking bar itself.

  The freshness gates are the definition's constants, not inputs, because neither
  has a reading a user would tune: a body that escapes the bar immediately after
  a new mother is that mother's own follow-through, and a range still standing
  250 bars later has stopped being a consolidation. No warmup: bar 0 is the one
  bar where the seeded index and the reassignment agree, so it prints its own high
  and low and starts the first range. Inputs: mark breakouts, tint inside bars,
  and four colours. Markers are `triangleUp` below the bar and `triangleDown`
  above it. The two range lines are fixed at `lineWidth` 2 for the same reason
  Hull Suite's are.

### Fixed

Four defects found by measuring shipped built-ins against the standard
definition. All four are now exact.

- **EMA emitted a value from bar 0 and was wrong for the whole warmup.** The
  descriptor called the base bundle's `ema()`, which seeds from `values[0]`: the
  first reading was a single price wearing a moving average's name, and the error
  decayed rather than stopping. At length 14 that was 155 mismatching bars with
  the worst relative error, 6.9e-4, landing on bar 13, the seed bar itself.

  It now uses `smaSeededEma`, seeding from the simple average of the first
  `length` closes and printing nothing before bar `length - 1`, which is what the
  standard definition does and what every other EMA in the tier was already
  doing. Zero mismatching bars afterwards. The public base `ema()` is deliberately
  untouched: it is documented API matching `openalgo.ta` and it is not this
  descriptor's business to redefine it.

- **Parabolic SAR flipped trend on the bar that established it.** Two ordering
  faults, worth 39 mismatching bars of 600 and a worst relative error of 1.1e-2.
  The stop was propagated, clamped and tested for a reversal on the **seed bar**,
  so the seed could reverse the trend it had just set; and the stop was clamped
  into the prior two bars' range **before** the reversal test, so a stop pulled
  back below the bar could no longer be breached and flips the definition calls
  for were silently dropped. The seed bar now carries the seed and nothing else,
  and the order is propagate, reverse, accelerate, clamp. Zero mismatches
  afterwards.

  One deviation is kept deliberately: at bar index 2 the reference
  implementation skips the second clamp bar and we clamp against both previous
  bars, as Wilder's rule states. Both variants were measured and they are identical on the fixture, so
  this costs no parity.

- **ADX blanked itself for the rest of the chart after a single flat bar.** With
  a DI length of 1, a bar whose true range is exactly 0 (an instrument locked at
  one price: a circuit freeze, a halt, an illiquid strike) dropped +DI, -DI and
  DX to a gap. Our ADX is a Wilder average over DX, so one gap poisons the
  recursion and the ADX line never comes back. The last finite pair is now held
  across a zero or absent smoothed true range, which is what the standard
  definition does, and the line survives the halt.

- **HMA was a fifth of a bar early at every odd length.** The Hull average halves
  its length and feeds that to a weighted average. We floored the half, so a
  length of 9 asked for a 4-bar window where the standard definition asks for a
  4.5-bar one: five bars weighted 4.5, 3.5, 2.5, 1.5, 0.5. Flooring shortens the
  fast leg's lag from 1.2 bars to 1, and the three passes then cancel to zero lag
  instead of the correct 0.4, so the line sat 0.4 slopes high. Even lengths were
  always exact, which is why this survived: the default of 9 is odd, and the
  error is a smooth 4.6e-3 at the default, never a visible break.

  The half period is now carried at full precision. The outer period still floors
  its square root, which is what the standard definition does and is not the same
  question. Measured after the fix at lengths 9, 13, 16, 21 and 55: exact on
  every bar, with the warmup index unchanged on both sides.

The previous pass in this release fixed five more, all user-visible for the same
reasons: **MACD** legs are SMA-seeded EMAs (warmup moves), **ADX** seeds its true
range correctly (warmup moves), **Fisher Transform** gained a flat-window floor,
**Chop Zone** takes its range off the high series, and **Special K** carries the
full 12-term table (warmup moves a long way, see below).

### Changed

Ten defaults across eight indicators now match the values the standard definition
pairs them with. These are defaults only: an explicitly configured setting, and a
saved layout that recorded one, are untouched.

| Indicator | Setting | Was | Now |
|---|---|---:|---:|
| `sma` | Length | 20 | 9 |
| `ema` | Length | 20 | 9 |
| `wma` | Length | 20 | 9 |
| `stochastic` | %K Smoothing | 3 | 1 |
| `cci` | MA Length | 14 | 20 |
| `obv` | MA Length | 14 | 9 |
| `ma-cross` | Long MA Length | 21 | 26 |
| `alligator` | Jaw Length | 13 | 21 |
| `alligator` | Teeth Length | 8 | 13 |
| `alligator` | Lips Length | 5 | 8 |

The Stochastic one is the largest change in appearance: a %K smoothing of 1 is
raw %K, so the line is noticeably faster and noisier than the 3 it used to
default to. The Alligator moves to the slower 21/13/8 set rather than Williams'
original 13/8/5; the offsets 8/5/3 are shared by both, so only the smoothing
lengths move.

### Upgrading

A chart saved before this release can look different in three ways. None of them
is a regression, and each is worth knowing about before you go looking for a bug.

**Studies that now start later.** These previously drew across bars they had no
honest value for, which is worse than drawing nothing: an average seeded from one
price is not an average, and a plot that starts at bar 0 tells a backtest that a
signal existed before the data to compute it did.

| Study | First bar with a value |
|---|---|
| EMA | `length - 1`, so bar 8 at the new default of 9. It drew from bar 0 before. |
| MACD | bar 25 for the MACD line, bar 33 for signal and histogram, at the 12/26/9 defaults |
| ADX / DMI | bar 14 for +DI and -DI, bar 27 for ADX, at the default 14 |
| Special K | bar 724 |

Special K is the one to plan around. Its longest term needs 725 bars before it
can produce a first reading, and its signal line needs a further stretch on top,
so on a chart holding less history than that it now draws **nothing at all**
where it used to draw a line. That line was computed off an incomplete table and
was not the study. Give it more bars, or a longer timeframe, and it returns.

**Studies whose values changed.** Parabolic SAR flips where the definition says
it flips rather than a bar early or late; Fisher Transform no longer runs away on
a flat window; Chop Zone reads its range off the high series; ADX no longer goes
blank after a flat bar. In each case the old line was wrong, not merely
different.

**Defaults.** See the table above. Anything you configured explicitly, including
via `getState()` / `restoreState()`, keeps the value you set.

### Sizes

The indicator tier rises 25.04 to 27.27 kB: 1.10 kB for the first eight studies
plus three fixes, and 1.07 kB for the three that landed late, so about 200 bytes
a study across the eleven. Reuse is why it is not more. Standard Error Bands
leans on `linreg`, `sma`, `wma` and the file's existing gapped EMA and adds only
the standard-error term itself; Moving Average Channel is two calls to `sma` and
the existing shift helper; SMMA is one call to `rma`; T3 is three nested calls to
the same SMA-seeded exponential average the file already had; Hull Suite is `wma`
and that average again. Nothing was added to the shared `calc.ts`.

**Two budgets were raised, and only two.** The indicator tier goes 27 kB to
30 kB. That raise was staged earlier in this release and handed back as
unnecessary, on the measurement that stood at the time; the last three studies
took the tier 213 bytes past the old ceiling, so it is necessary now and is taken
at the figure already agreed rather than at a figure chosen to just clear the
reading.

"Everything" has to move with it, because it is the same six files summed and
would otherwise fail while the tier inside it passes. The arithmetic, in the
1000-byte kB `size-limit` reports:

    59,057 base + 7,609 trade + 2,656 transform + 10,662 profile + 13,126 draw
      = 93,110 B, every tier except indicators
    93,110 B + 30,000 B, the new indicator ceiling
      = 123,110 B, rounded up to a 124 kB budget

So "Everything" goes 120 kB to 124 kB and measures 120.38 kB against it. No other
budget moved.

| Tier | Measured | Budget |
|---|---:|---:|
| Base engine | 59.06 KB | 60 KB |
| Base + trade | 66.67 KB | 68 KB |
| Indicators | 27.27 KB | 30 KB |
| Draw | 13.13 KB | 14 KB |
| Transform | 2.66 KB | 5 KB |
| Profile | 10.66 KB | 11 KB |
| Everything | 120.38 KB | 124 KB |

Trade, draw, transform and profile measure exactly what they did in 1.8.2: no
code outside `src/indicators/` changed except the version string. That string is
why the base
bundle reads 59.06 against last release's 59.05, a 12-byte difference in how
`1.8.3` compresses rather than anything shipping in it.

2408 tests across 129 files. 102 indicators, 43 drawing tools, zero runtime
dependencies.

## 1.8.2

### Added

- **`ctx.tickSize` on the calculation context.** The instrument's tick size,
  read from the pane's price scale `minMove`, which is the same number the axis
  already formats and `snapToTick` already snaps to. An indicator sizing a range
  in ticks previously had to ask the user for a value the chart was holding.

  It is `undefined` rather than a guess when the host has not set `minMove`. The
  scale treats 0 as "infer precision from the visible range", and handing that
  to an indicator as though it meant one paisa would be worse than saying
  nothing. `IndicatorHost.tickSize?(paneIndex)` is optional, so a host predating
  it still satisfies the interface.

## 1.8.1

The indicator descriptor learns what the *chart* is doing, not only what the
bars say: where the last bar stands, when a condition it declared came true, and
how to state a regime as shading or as a colour on the price candles themselves.
Around that, five smaller things a study or a host kept having to hand-roll: a
plot that draws as candles, a session window stated rather than inferred, an
interval read as a count and a unit, the two colour helpers every per-bar
colouring rule ends up rewriting, and a price or a bar time picked off the chart
instead of typed into a field.

### Added

- **`IndicatorCalcContext`, the optional fourth argument to `calc`.** It carries
  `barState` (`isNew`, `isConfirmed`, `isRealtime`, `lastIndex`), `symbol`,
  `interval`, `timezone` and `now()`, so a study can act once per bar rather than
  once per tick, or refuse to signal off a bar that is still moving. `calcTail`
  takes it as a sixth argument.

  Optional and **trailing**, which is the whole point: all 91 built-ins and every
  user descriptor written against `calc(bars, settings, store)` keep their exact
  signature and their exact behaviour. A calculation that ignores the context
  computes what it always did.

  `isConfirmed` is inferred from the last bar's gap against the chart clock,
  because that is the only interval signal the engine has: it is handed bars and
  never a timeframe. A session break or a holiday widens the gap, so it reads as
  "this bar's own span has elapsed", not as "the exchange has closed".
  `isRealtime` is sticky, set the first time a tail-only change lands. `isNew` is
  false on a full history load, since there was no update to append. `symbol` and
  `interval` answer `undefined` under `chart.addIndicator`, on the same terms as
  the attach context.

- **`alerts`, conditions the runtime watches on the descriptor's behalf.** A
  crossover of an indicator's own columns is something only that indicator knows
  how to name, so the spec is declared as data (`id`, `title`, optional
  `message`, and a `when` predicate judging one bar) and a trigger arrives as
  `'indicator:alert'` on the chart's own bus with an `IndicatorAlertPayload`.

  Alerts fire **only on a tail-only change**, reusing the same gate `calcTail`
  uses and for the same reason. Any other pass reseeds the watermark silently, so
  adding an indicator to a loaded chart, changing a setting, paging history in or
  switching symbol announces nothing: an indicator dropped onto two years of bars
  must not fire every crossover in them at once. The watermark is a bar **time**,
  not a count, so a page of older bars at the left edge cannot re-fire the chart.

  `IndicatorAttachContext.emit(event, payload)` is the imperative half, for a
  signal that arrives from outside the calculation entirely. New types:
  `IndicatorAlertSpec`, `IndicatorAlertContext`, `IndicatorAlertPayload`.

- **`background`, per-bar shading behind the indicator's own pane.** A regime
  study answers "which state is the market in", which is a property of the whole
  bar rather than of a price: as a plot it would need a value to sit at and would
  drag the pane's autoscale around with it. One colour per bar, `null` to leave a
  bar unshaded, `[]` to clear the layer.

  The cost is in the work skipped. Everything outside the visible range is
  dropped before anything is painted, and adjacent bars sharing a colour coalesce
  into one rect, so a two-state regime over 50k bars is a handful of fills a
  frame rather than one per bar. Band edges are bar midpoints, so two runs abut
  exactly instead of overlapping by a pixel, and the edges are clamped to the
  plot because nothing clips them: the axis strips share that canvas. The layer
  contributes nothing to autoscale and is anchored to the first bar's **time**,
  so a page of history at the left edge does not slide the shading off its bars.
  It draws over the grid, so a descriptor should pass a translucent `rgba()`.
  `IndicatorBackground` is exported and usable as a plain primitive.

- **`barColors`, recolouring the price candles from a study's verdict.** Distinct
  from a plot's `colorBy`, which paints the indicator's own series: a trend
  filter, a volatility regime or a higher-timeframe bias is a claim about the
  price bars themselves, and drawing it as a second series beside them says
  something weaker.

  The engine never writes into the bars the caller handed `setData`. It clones
  only the ones whose colour actually changes and republishes those straight to
  the data layer, so the time points and the base index do not move and no
  recompute cascade follows; a pass where nothing changed writes nothing at all,
  which is the common case on a live tick.

  Only one overlay can be on the candles, so this is last writer wins, which is
  deterministic rather than arbitrary: publishers run in `addIndicator` order, so
  the same instance wins every frame. Withdrawal is gated on ownership. Two gaps
  are known and left in rather than paid for in base bytes: removing the
  **winner** while a second publisher is still live drops the bars back to their
  own colours until that publisher's next recompute, and prepending older history
  retakes the "own colour" snapshot from bars that already carry the overlay, so
  removing the indicator afterwards leaves the pre-prepend region tinted.

- **`IndicatorPlot.ohlc`, a plot drawn as candles.** Four `calc` keys naming
  four columns in the **same** `IndicatorValues`: a smoothed Heikin-Ashi overlay,
  a higher-timeframe candle, a synthetic spread instrument each return four
  ordinary columns and point at them. A second result shape for `calc` would have
  forked the contract every descriptor and every helper is written against.

  `key` stays the series identity and the legend reading falls back to the
  `close` column. The named columns must all exist and be bar-aligned or
  `addIndicator` throws, which it can do because the first `calc` runs inside the
  instance constructor: a wrong column name is an error rather than an empty
  pane. A type override on the plot degrades quietly, since line, area and
  histogram read `close`.

- **Session windows you state rather than infer.** `parseSessionSpec('0915-1015')`,
  `inSessionAt(utcSeconds, spec, zone?)` and `sessionFlags(times, spec, zone?)`,
  with `SessionSpec` as the parsed form. `sessionStartFlags` reads the trading day
  back out of the bar gaps, which cannot answer which *part* of a session you
  meant: an opening range, the cash hours inside an extended session, one
  exchange's hours drawn on another exchange's chart.

  The grammar is `HHMM-HHMM`, optionally `:` and the days the window opens on
  (1 = Sunday). The window is half-open, so a bar stamped exactly at the end
  belongs to what comes after it, which is what an opening-range comparison
  needs. An end at or before the start runs past midnight, which makes
  `start === end` the whole day rather than nothing. The day filter names the day
  the window **opens** on, so an overnight window stays one session instead of
  being cut in half at 00:00. An unparseable string marks nothing rather than
  throwing, because it is normally a settings field a user is halfway through
  typing.

- **Interval introspection: `intervalParts`, `isIntradayInterval`,
  `isDailyInterval`, `isSecondsInterval`, `isTickInterval`**, with the
  `IntervalParts` type. A study written against `'1m'`, `'5m'` and `'15m'`
  silently misbehaves on `'3m'`, and a host's own registered code was never in
  anybody's list at all.

  The answer is read off the **bucketing rule**, not the code's spelling, so it
  is canonical (`'120m'` and `'2h'` both read 2 h, a 90-second bar reads 90 s) and
  it answers for any registered code. `M` is months, keeping the token grammar's
  rule that lower-case `m` is minutes, so a quarter reads 3 M and a year 12 M.
  The length predicates ask about a magnitude rather than a unit, so a
  registrable `25h` decomposes into hours while answering false to
  `isIntradayInterval`. A calendar or count-driven code has no clock length at
  all rather than a long one.

- **`withAlpha` and `fromGradient` on the public surface.** Per-bar colour means
  computing a colour string per bar, and hand-rolling that ends in a private
  `#rrggbb` parser in every project. `withAlpha` was already the engine's own and
  simply had no export path; `fromGradient(value, min, max, low, high)` is new and
  blends in sRGB, alpha included, clamped outside the range.

  It reuses the single existing colour parser rather than adding a second, and
  allocates only the result string per call: no closure, no cache, no lookup
  table. The clamp is two comparisons rather than `Math.min`/`Math.max` because
  both are false against a not-available value, which lands it on `low` instead
  of emitting `rgba(NaN,...)`. That is not cosmetic: canvas ignores an
  unparseable `fillStyle` and silently keeps the previous one, so a NaN string
  would bleed the neighbouring bar's colour across this one rather than failing
  visibly.

- **`chart.beginPick(kind, cb)`, interactive value capture.** A settings field
  naming a price or a time is host chrome, but the value is often easier to point
  at than to type, and only the engine knows what is under the cursor. The host
  arms a pick, the next plot click answers with a number, and the pick disarms
  itself; the returned function cancels it.

  Built on the `click` event the draw tier already resolves anchors from, so it
  inherits pane resolution, on-demand autoscale and the same payload rather than
  adding a second capture path. Placement mode is deliberately **not** armed
  while picking: a pick wants panning left alone (scroll back to the bar you
  mean, then click it), and outside placement mode a drag emits no click, so
  panning cannot answer a pick by accident, and arming a pick never cancels an
  active drawing tool. A `'time'` pick snaps to the bar clicked, because the raw
  click time is interpolated between bars on the gapless axis and matches no bar.
  A click the chart could not resolve leaves the pick armed rather than answering
  with a bogus number. One pick per chart, held in a `WeakMap` keyed on the host,
  so arming a second cancels the first and a destroyed chart takes its pending
  pick with it. `'pick:start'` and `'pick:end'` bracket it for a host that wants
  to swap its cursor. New types: `PickKind`, `PickHost`.

### Changed

- **`IndicatorHost` gained two optional members**, `setBarColors(colors, owner)`
  and `emit(event, payload)`. Both optional, so a host implementing the interface
  itself needs no change; a host that wants indicator bar colours or indicator
  alerts implements them.

### Sizes

Base rises 57.31 to 59.07 kB, against its unchanged 60 kB budget.

Of the 1.76 kB, the runtime spine plus the background primitive is 980 B and is
unavoidable: `IndicatorBackground` is constructed by the indicator runtime, which
is base. The remaining 776 B is the barrel exports plus the one `chart.ts` hook
(sessions 226 B, interval introspection 174 B, pick 115 B, the gradient helpers
21 B, and roughly 240 B of joint export-map cost that only disappears if all four
go). The registry additions are pure type declarations and cost nothing.

| Tier | Measured | Budget |
|---|---:|---:|
| Base engine | 59.07 KB | 60 KB |
| Base + trade | 66.67 KB | 66 KB (over; see below) |
| Indicators | 25.04 KB | 27 KB |
| Draw | 13.13 KB | 14 KB |
| Transform | 2.66 KB | 5 KB |
| Profile | 10.66 KB | 11 KB |
| Everything | 118.16 KB | 120 KB |
| Chart-only, tree-shaken | 37.55 KB | 38 KB |

**The base+trade entry needs a decision before release.** `size-limit` sums the
per-file figures rather than compressing the concatenation, so a 66 kB combined
limit caps the base at 58.39 kB, which is 1.61 kB tighter than the base's own
budget. That is exactly the outcome 1.7.1's Sizes section says it was avoiding:
it raised the pair to 60 and **68** kB because doing so "keeps the trade allowance
where it was instead of making the combined entry a stricter constraint on the
base than the base's own budget". The config carries 66, and it is the older
artefact by timestamp. The trade tier itself has not moved: it is 7.61 kB of the
combined figure against the 8 kB it has always had. Against 68 kB this release
passes with 1.33 kB spare.

1953 tests across 106 files. Zero runtime dependencies.

## 1.7.1

The indicator descriptor gains the parts a ported study needs and could not
express: free-standing geometry, levels derived from the data, one plot that
escapes to the price pane, and the calculation helpers the 91 built-ins are made
of. Per-bar colour reaches every renderer that draws a bar rather than the two
that happened to read it.

### Added

- **`draws`, geometry a descriptor could not express before.** A descriptor
  returns lines, boxes, labels and polylines anchored to `{ time, price }`. A
  plot is one value per bar and a level is a horizontal line across the pane, so
  a pivot-to-pivot trendline, a supply zone or a measured-move projection had
  nowhere to live.

  Anchors are **times, never logical indices**: paging history in at the left
  edge shifts every index, and a trendline pinned to one would slide off its
  pivots the moment it did. `extendLeft` / `extendRight` solve the segment for
  the pane edge along its own slope, so a ray keeps its angle instead of
  flattening into a horizontal nobody asked for. The layer contributes nothing
  to autoscale, since a projection reaching far above the data would otherwise
  squash the study it annotates into a band a few pixels tall. Shapes entirely
  off-pane are culled before any path work. A label, and a box's caption, split
  on `\n`.

  One primitive holds the whole list, created lazily on the first non-empty
  result and replaced wholesale on each recompute, so a live tick does not
  attach and detach a dozen objects and re-sort the pane's z-order for each.
  `IndicatorDrawings` is exported and usable as a plain primitive. New types:
  `IndicatorDrawing`, `DrawAnchor`.

- **Levels derived from the data.** `levels` now runs after every `calc` instead
  of once at construction, and is handed the bars and the computed values
  alongside the settings, so a level can be yesterday's high or a session band
  rather than only a number the user typed.

  The context spreads the settings keys onto itself, so all 91 built-ins reading
  `ctx.overbought` are untouched; `settings`, `bars` and `values` join
  `timezone` as reserved keys. The returned list is diffed against the previous
  one, so RSI's constant 70/50/30 lines are not detached and reattached on every
  tick. `IndicatorLevel` gained `lineWidth` and `lineStyle`, with
  the original `dashed` still honoured and `lineStyle` winning when both are
  set. New type: `IndicatorLevelContext`.

- **`IndicatorPlot.overlay`.** One plot of a pane indicator drawn on the price
  pane: an oscillator whose trailing stop belongs on the candles, without
  splitting the study into two indicators the user configures twice. Markers
  ride the first plot's series, so they follow it; fills, levels, drawings and
  the table stay on the indicator's own pane.

- **The attach context reaches further.** `symbol()`, `interval()`, `now()`,
  `paneIndex()`, `addPrimitive()` and `removePrimitive()` join `settings`,
  `bars`, `requestRecompute`, `store` and `timezone`. `symbol` and `interval`
  answer `undefined` under `chart.addIndicator`: the core is handed bars and
  never an instrument, so a host that owns the symbol picker supplies them
  through its own `IndicatorHost` rather than having the engine invent a name.
  `now()` is the chart's wall clock, the one the countdown row reads, so an
  indicator deciding whether the last bar is still forming agrees with the axis.

- **`Bar.color` on every Family-A renderer.** It reached histogram and column
  only. Candles, hollow candles, volume candles and OHLC bars now take it on
  body, border and wick together, so a recoloured candle cannot keep a wick
  arguing the other way. Line, step, area and the HLC-area close line split
  their stroke into runs at the bars where the colour changes, with consecutive
  runs abutting at the point they share so no seam of background opens: the
  segment arriving at a bar takes that bar's colour, and a step's horizontal and
  vertical legs take one between them. Baseline is deliberately excluded, its
  stroke is already split by the above/below-base rule and has its own colour
  pair. A series where no point carries a colour is still walked into a single
  stroke, byte for byte the op stream it emitted before. Indicator plots reach
  this through `colorBy`, which was documented as histogram-and-column only.

- **Multi-line marker text.** `\n` in a `labelUp` / `labelDown` plate stacks the
  rows, sizes the plate to the widest and keeps it centred on its anchor, so the
  tail still points at the bar and a two-row plate sits higher rather than
  sliding sideways. A free `text` marker writes its rows outward from the
  anchor, so a block above a bar grows upward instead of back over the candle.
  The single-line path is untouched, down to the plate arithmetic.

- **Gradient and per-point colour on `IndicatorFill`.**
  `gradient: { topValue?, bottomValue?, topColor, bottomColor }` shades a band
  across price instead of filling it flat; an omitted stop takes the band's own
  high or low, so either side can be pinned independently. The stops resolve
  once per frame, so the shading does not restart at every crossing.
  `FillPoint.color` overrides one bar, and the two runs share that edge rather
  than leaving a seam. Precedence is point colour, then gradient, then
  `colorUp` / `colorDown`. New type: `FillGradient`.

  `IndicatorFillSpec` does not carry either yet, so a descriptor cannot declare
  one: this is reachable by constructing the primitive directly.

- **`PriceLineOptions.lineStyle`**, the three-way form of `dashed`
  (`'solid' | 'dashed' | 'dotted'`), reusing the `CanvasLineStyle` alias and the
  same dash table the grid and crosshair already use. `dashed` still works and
  `lineStyle` wins when both are set.

- **21 calculation helpers exported** from `openalgo-charts/indicators`:
  `smaSeededEma`, `change`, `roc`, `dev`, `percentRank`, `alma`, `vwma`,
  `highestBars`, `lowestBars`, `rollingSum`, `cumulative`, `linreg`, `swma`,
  `stoch`, `percentileNearestRank`, `correlation`, `cci`, `pivotHigh`,
  `pivotLow`, `barsSince`, `valueWhen`, joining the seven that were already
  public. They match the published `ta.*` formulas the built-ins were ported
  against, so a custom descriptor can port a study rather than re-derive it.
  Every one of the 21 is already in the tier bundle, so this adds names to the
  export map and no code.

### Changed

- **`IndicatorHost.addIndicatorLevel` takes an options object** rather than
  positional arguments. The level gained a width and a line style this release,
  and a call site of seven bare values is where the next one gets passed in the
  wrong slot. A host that implements `IndicatorHost` itself has to update the
  call; `chart.addIndicator` is unaffected.

- **`PriceLineOptions.lineWidth` and `dashed` are optional**, defaulting to 1
  and off, which matches what `price-levels.ts` already assumed. This breaks
  only a consumer reading `options().lineWidth` or `options().dashed` into a
  non-optional `number` / `boolean`.

### Fixed

- **`calcTail` could splice a tail onto a history that no longer existed.** The
  incremental path was gated on the bar count being `n` or `n + 1`, which does
  not say the previous result still describes the earlier bars. A symbol change
  landing on a matching count, or one older bar paged in at the left edge, took
  the tail path anyway and left the plot silently wrong until the next full
  `calc`.

  The guard now reads times: the first bar must be unchanged, and the last must
  be either that same bar replaced in place or one appended directly after it.
  The appended case is read off `bars[n - 2]` rather than by projecting the next
  bucket, which a session gap or a holiday makes unguessable on a gapless axis.

- **A column plot ignored its own Colour control.** `drawColumns` read only the
  up/down pair, so the `style.color` an indicator's generated colour input
  writes was inert. Precedence is now `bar.color`, then `style.color`, then the
  up/down pair. Every built-in column plot sets `colorBy` and returns a colour
  for every finite value, so none of their appearances change.

- **An area series drew a solid outline** when its `lineStyle` was `dashed` or
  `dotted`: `drawArea` never passed the style through to the outline.

### Sizes

Base rises 56 to 60 kB and base+trade 64 to 68 kB.

The base grew because this release lands in base modules: the drawings layer is
imported statically by the indicator runtime, the way the fill primitive already
was, and per-bar colour, the widened level path and the level diff are all base
code. It measures 57.31 kB against the new 60, which restores headroom 1.6.0 did
not have (55.78 against 56).

Base+trade rises by the same 4 kB rather than to a tighter number. The trade tier
did not grow: it is 7.61 kB of the combined figure against the 8 kB it has always
had, so the combined budget was failing purely because the base moved. Raising it
by the base's increase keeps the trade allowance where it was instead of making
the combined entry a stricter constraint on the base than the base's own budget.
Nothing else moved, and "everything" did not need raising.

| Tier | Measured | Budget |
|---|---:|---:|
| Base engine | 57.31 KB | 60 KB |
| Base + trade | 64.92 KB | 68 KB |
| Indicators | 25.04 KB | 27 KB |
| Draw | 13.13 KB | 14 KB |
| Transform | 2.66 KB | 5 KB |
| Profile | 10.66 KB | 11 KB |
| Everything | 116.40 KB | 120 KB |
| Chart-only, tree-shaken | 36.42 KB | 38 KB |

1949 tests across 106 files. Zero runtime dependencies.

## 1.6.0

Broker-readiness hardening across the trade and feed layers, driven by an external
production-readiness review and by verifying every one of its claims against the
code rather than trusting them. An independent reassessment scored the result
68/100, up from 61.

### Fixed, and the reason to upgrade

- **`modifyorder` zeroed the price field the caller did not touch.** Dragging a
  stop-limit order's line wiped its limit price to zero at the broker, on a live
  working order.

  OpenAlgo's modifyorder takes the WHOLE order rather than a delta, so every
  field is sent on every modify. `modify()` correctly rebuilt symbol, action,
  exchange, pricetype, product and quantity from its cached context, but took the
  two price fields from the patch alone: `price: patch.price ?? 0`. Defaulting an
  unmentioned field to 0 does not leave it alone, it overwrites it with zero. A
  stop-limit carries both a limit and a trigger, and dragging its line sends only
  the trigger, so that path sent `price: 0`.

  Verified against the published 1.5.0 tarball, which answers `price: 0`. Anyone
  running a terminal with draggable stop-limit lines should upgrade.

### Breaking, despite the minor version

Same call as 1.4.0 made for `intervalToSeconds`, for the same reason: the old
behaviour produced wrong answers.

- **`mapOrder` returns `DecodedOrder`, not `Order`.** `status` widens to
  `OrderStatus | 'unknown'` and `rawStatus` carries the broker's own text when it
  is unknown. Previously an unrecognised broker status silently became `working`,
  a missing action silently became **BUY**, and an unreadable number became 0. A
  fail-open BUY default is the worst possible direction for a trading payload.

  Assigning the result straight to `Order` no longer type-checks. Handle
  `'unknown'`, or use the new `getOrderBook()`, which returns
  `{ orders, quarantined }` so a row that cannot be decoded is surfaced rather
  than rendered as live state. `decodeOrder(raw)` is the strict primitive.

### Added

- **Feed-level quantity and idempotency guards.** Both already existed in
  `OrderEngine` and were unreachable for anyone calling the feed directly, which
  is what most hosts do. A guarantee you can bypass by calling one layer down is
  not a guarantee.

  Quantity is checked on every order with no configuration: NaN, zero, negative
  and fractional are refused. The new `constraints(symbol, exchange)` hook adds
  the freeze limit and lot grid, including on MARKET orders, which is the case
  that matters because a market order cannot be taken back.

  A repeated `clientToken` is refused before anything is sent. A failure AFTER
  the request leaves keeps the claim and marks it ambiguous rather than releasing
  it: a failed write says the response did not arrive and says nothing about
  whether the order did. `tokenState()` and `releaseToken()` let a host resolve
  that deliberately. Every refusal is thrown pre-flight, so a caller can tell
  "nothing was sent" from "this may be live".

- **Chart-anchored primitives.** `addPrimitive(p, { anchor: 'chart-bottom' })`
  makes a primitive chart furniture rather than pane furniture, and the engine
  re-homes it as panes are added, removed, moved and maximized. Maximize is the
  case a host could not work around, because it hides the other panes and takes
  a watermark pinned to pane 0 with them. `'chart-top'` exists too.

- **`paneAdded`.** Panes are created lazily when an indicator asks for one, and
  that was silent: `paneRemoved` had no counterpart. Fires once per pane, after
  the relayout, so a listener reads settled geometry.

- **Analyzer mode is a guard rather than cargo.** `place()` accepted a `mode` and
  never transmitted it. It is now checked against the server: OpenAlgo decides
  analyzer server-side, so a mode field in the order body would be ignored, and a
  control that looks real and does nothing is worse than no control. The feed
  reads `/api/v1/analyzer/` and refuses when the server disagrees with the caller.

- Order-engine intent state separate from broker state, so a resolved promise is
  no longer promoted to the exchange's word; quantity constraints binding on every
  order type; `placeMarket` accepting exchange and product; bounded engine maps.

- WebSocket handshake gating, a liveness probe, jittered backoff, topic-derived
  identity, and optional sequence tracking. Reference-counted subscriptions on the
  composed live feed, so one consumer leaving no longer cuts the stream for the
  others.

- A working stop-loss drew nothing on the chart, and a one-sided bracket drew a
  phantom take-profit at the position's average price. Both fixed.

### Security

- **Polynomial ReDoS in `scaleFont`** (CodeQL, shipped code). `\d+(?:\.\d+)?px`
  retried from every start position and backtracked the whole run. Font strings
  can arrive from a restored layout, and layouts are shareable. Bounded and given
  a leading boundary: 813ms to 1ms on 40,000 digits, byte-identical on real fonts.

- Development advisories 12 to 0, including one critical. GitHub Actions pinned by
  commit SHA. CI given least-privilege tokens, a runtime audit gate, an SBOM and
  CodeQL. A release workflow using npm OIDC trusted publishing, so no long-lived
  token need exist. `SECURITY.md` added, stating plainly that the browser is not a
  trust boundary.

- The live example no longer persists the API key to `localStorage`, and its
  legend escapes every interpolated value.

### Sizes

Two budgets rise, base 55 to 56 kB and base+trade 62 to 64 kB. Those entries
measure whole bundle files, and the base bundle carries the OpenAlgo adapters, so
hardening them grows the file even though a charting host never imports them.
A chart-only import tree-shakes to 34.9 kB with the WebSocket adapter provably
absent, which is what a charting user actually pays and did not move. `npm run
shake` now guards that number directly.

| Tier | Measured | Budget |
|---|---:|---:|
| Base engine | 55.78 KB | 56 KB |
| Base + trade | 63.39 KB | 64 KB |
| Indicators | 24.88 KB | 27 KB |
| Draw | 13.13 KB | 14 KB |
| Transform | 2.66 KB | 5 KB |
| Profile | 10.66 KB | 11 KB |
| Everything | 114.72 KB | 120 KB |
| Chart-only, tree-shaken | 34.94 KB | 38 KB |

1882 tests across 100 files. Zero runtime dependencies.

## 1.5.0

### Fixed

- **Removing a sub-plot indicator could throw**
  `TypeError: Cannot read properties of undefined (reading 'removeSeries')`,
  leaving the teardown half-done: the legend went, the plot stayed on the chart.

  `_createSeries` captured `paneIndex` once and every closure on the returned
  `SeriesApi` used that number afterwards. A slot number is not stable.
  `removeIndicator` prunes a pane that just emptied, which splices the pane array
  so everything below shifts up one, and `movePane` swaps two entries outright.
  The captured number then names a different pane, or none at all.

  Concretely: three sub-plots on panes 1, 2 and 3. Remove the first, and the
  survivors shift to 1 and 2 while their series still name 2 and 3. Remove the
  last and `_panes[3]` is undefined. That is why it needed more than one sub-plot
  and never appeared when clearing them bottom-up, which shifts nothing.

  The quieter half had no symptom to report it at all: when the stale index still
  lands on a live pane, the series is stripped from the **wrong** pane. Series
  now hold their pane by identity, since panes travel with their series through
  both operations.

### Added

- **`SeriesStyle.bodyVisible`.** `false` drops the candle body fill and leaves
  the outline and the wick, which is what a settings dialog's Body switch means.
  Distinct from `hollow`, which empties only the up candles and is the
  hollow-candle chart type; this empties both.

  It exists because the candle settings row could not honestly carry a checkbox
  without it. `chartSettingsSchema` now gives the Body row the same switch its
  Borders and Wick neighbours already had, rather than the row going without one
  because nothing in `SeriesStyle` backed it.

  It is the one flag here that can legitimately leave nothing drawn: with borders
  off as well, a candle is reduced to its wick. That is two deliberate switches
  rather than an accident, so it is honoured rather than second-guessed. The 3px
  width guard on the inset outline is skipped when the body is hidden, since the
  guard exists to stop a 1px outline swallowing a narrow *filled* body and with
  no fill the outline is the candle.

### Examples

- `examples/yfinance` was passing `intervalSeconds` to `withBarCache`, an option
  1.4.0 renamed to `barCloses`. Nothing read it, so the wrapper had silently been
  running on its default, which happens to be the registry-backed answer it was
  reaching for, hence no visible symptom. It now passes `barCloses` and reads the
  chart's timezone inside the closure rather than capturing it, because a New
  York month is not a Mumbai month. Two `accent-color` declarations on checkboxes
  are also gone: they tint a *native* control, and these boxes are drawn by the
  `appearance: none` rule at the top of the file.

1734 tests across 91 files. Everything tier 110.7 KB brotlied, against a 120 KB
budget.

## 1.4.0

### Breaking

- **`intervalToSeconds` throws where it used to return 60.** It was exported in
  1.3.0 and answered 60 seconds for any code its regex did not recognise, so a
  typo drew minute bars under whatever label the caller thought it had asked
  for. It now throws `UnknownIntervalError` for an unregistered code, and a
  separate error for a calendar or count-driven code that has no fixed length to
  report. A caller passing user input needs a `try`/`catch`, or should use
  `tryResolveInterval` / `isKnownInterval`, which answer without throwing.

- **Upper-case `M` no longer resolves at all.** The built-in token regex folded
  case, so `M` and `1M` read as minutes. Every terminal that uses these tokens
  reads lower-case `m` as minutes and upper-case `M` as a month, and anything
  gating on "has the next bar closed yet" therefore believed a month closed
  every sixty seconds. Nothing is registered for `M` by default: a host that
  wants months registers a calendar interval deliberately. Lower-case `m` is
  untouched, as are `s`, `h`, `d`, `w` and their upper-case forms.

  This is shipped as a minor release by explicit decision, so a consumer on
  `^1.3.0` will pick it up automatically. Both changes only affect codes that
  were already producing the wrong answer.

### Added

- **Chart linking.** `createLinkGroup({ crosshair, viewport, symbol })` drives a
  grid of charts as one workspace. `add`, `remove`, `setOptions`, `destroy`,
  `setSymbol`, `symbol()`, `members()`, `has()` and `crosshairIndex()` are the
  whole surface, and like `ReplayController` and `ComparisonController` it ships
  no DOM: the host draws its own link badge and colour chips, and decides which
  charts belong to which group. Each of the three channels switches on its own,
  because a user routinely wants one without the others: mirror the cursor
  across four timeframes but keep each zoom, or slave every chart's instrument
  but let each keep its own window.

  **Nothing crosses a chart boundary as a logical index.** That is the decision
  everything else hangs off. The x axis is a gapless index over each chart's own
  bars, so logical index 300 is a different instant on every chart in the grid.
  Copying an index or a range straight across works perfectly on two charts of
  the same symbol and interval, which is exactly how it would ship broken. Every
  value is converted index to time on the sender through `indexToTimeFloat`, and
  time back to index on the receiver through `timeToIndex` / `timeToIndexFloat`,
  against that chart's own `DataLayer`. A daily chart and an hourly chart with
  different history depth therefore stay on the same instant and the same
  wall-clock window. The two conversions, `followerIndex` and `followerRange`,
  are pure and exported.

  Coverage is answered as an absence, not as a gap. A follower refuses any
  instant before its first bar or after its last one, because that is a period
  it does not cover at all and pinning the crosshair to an edge bar would assert
  an alignment that does not exist. Inside its range with no bar at that second
  it snaps to the nearest bar **in time**, which is not the nearest in index once
  the bars either side of a session break are hours apart, or draws nothing under
  `whenMissing: 'hide'`.

  A follower's crosshair is a new `LinkCrosshair` primitive on the `top`
  z-order, one per pane so it spans price, volume and indicator panes the way the
  native global crosshair does. It draws the **vertical line only**, at
  `LINK_CROSSHAIR_ALPHA` of the pane's own crosshair colour. The horizontal line
  marks a price, and the price under a cursor on another instrument is not a
  price on this one: on a grid of four symbols a mirrored price line would be a
  straight lie four times over. The vertical line marks an instant, and an
  instant is shared.

  Feedback loops are stopped by one group-wide re-entrancy guard rather than one
  per channel. Any member event arriving while the group is broadcasting is an
  echo of that broadcast by definition, since a human cannot pan two charts in
  one call stack; and a symbol change that reloads data can move a viewport, so
  that second-order echo is the same bug wearing a different hat. Destroyed
  members are detected by `isDestroyed` (falling back to an empty pane list for a
  host wrapping something that is not a `Chart`) and pruned on the spot, which
  also stops `addPrimitive` from resurrecting a pane on a corpse.

  **The engine keeps no instrument concept and linking does not invent one.** The
  host participates: it reports a change by emitting `'symbol'` on the chart's
  own bus or by calling `setSymbol`, and it supplies the per-member `onSymbol`
  callback that actually loads the new instrument's bars. A member with no
  `onSymbol` broadcasts its own changes but never follows anyone else's, which is
  how a host pins one chart of a grid.

- **Drawings on the clipboard.** `DrawingController` gains async `copy`, `cut`
  and `paste`, over a new `DrawingClipboard` in the draw tier that wraps
  `navigator.clipboard`. The host still owns the key bindings, because the engine
  installs no listeners: these are plain calls to make on Ctrl+C, Ctrl+X and
  Ctrl+V.

  The payload is JSON under a single namespaced top-level key
  (`openalgo-charts/drawings`, with a version), so foreign text and foreign JSON
  are recognised as **not ours** by looking at one property and paste nothing,
  rather than throwing at the host because the user last copied a spreadsheet
  cell. Everything read back is validated field by field before it can reach the
  model: the tool must be registered, every anchor must be finite, the pane must
  be a non-negative integer, style values must be renderable primitives or a
  short array of numbers, and there are caps on counts and string length.
  Validation is all-or-nothing, because a payload with one corrupt entry is a
  corrupt payload and pasting the other nine silently would be worse than
  pasting none.

  Clipboard failures degrade rather than break. Every write also lands in a
  module-level in-memory clipboard shared by every controller in the page, which
  is what makes chart-to-chart paste work with the permission refused, and is
  why that store is a singleton rather than per-controller state. `cut` deletes
  **only** after the write resolves successfully, so with
  `fallbackToMemory: false` a refused write leaves the model exactly as it was
  instead of destroying a drawing that went nowhere. `clipboard().lastError()`
  reports a copy that reached memory but not the system clipboard, which is
  precisely what a host wants to be able to tell the user.

  Paste inserts fresh objects with fresh ids in a single undo step, so editing
  the copy cannot alter its source. It is offset two bars along time and 16 px
  down the price axis (`pasteOffsetBars` / `pasteOffsetPixels`), applied per
  anchor through `priceToCoordinate` / `coordinateToPrice` so the nudge is a
  rigid *screen* translation that keeps a shape's proportions on a logarithmic
  scale. A pane index the receiving chart does not have is folded onto one it
  does, because `addPrimitive` would otherwise conjure an empty pane.
  `draw:copy`, `draw:cut` and `draw:paste` are emitted on the chart's bus.

  `DrawingClipboard`, `ClipboardPort` and the encode / decode / sanitise trio
  are exported from `openalgo-charts/draw`, so a host can name the type
  `DrawingController.clipboard()` returns and can move drawings over its own
  transport with the same validation a paste gets. Deliberately not from the
  base barrel: `clipboard.ts` needs `hasDrawingTool`, so exporting it there
  would drag all 43 drawing tools into the 55 kB base bundle.

- **Warm-load bar caching for any feed.** `withBarCache(feed, options)` is a
  `DataFeed` to `DataFeed` wrapper, so a custom feed gets it too and not only
  `OpenAlgoDataFeed`.

  The key is `symbol | exchange | interval`, and the requested range is
  deliberately **not** part of it: one entry per series holds the widest set
  fetched so far and a narrower request is served by slicing it. Keying on the
  range would miss on every pan and on every "same chart, one bar later" reload,
  which is exactly the traffic warm loading exists to remove.

  Freshness is two gates that must both pass. `ttlMs` bounds absolute age, and a
  hit past the entry's coverage is allowed only while the bar after the entry's
  last closed bar is still forming (`nowSec < entry.to + 1 + intervalSec`). That
  second gate is measured on the feed's own bar grid rather than against UTC
  midnight, so a daily Indian bar opening at 03:45 UTC is judged against its own
  session instead of the wrong boundary. A closed session therefore stays usable
  for the whole TTL while a 1m chart is only reused inside the current minute.

  **The forming bar is never stored at all.** It keeps moving, and a frozen
  snapshot of it served to a live chart is worse than no cache, because the chart
  paints a confident candle with no spinner and no way to know. Trailing unclosed
  bars are dropped on store, so a hit is short by at most that one bar, which a
  live subscription re-supplies immediately, and is never wrong about a bar it
  does return.

  Bounds are LRU on both entry count (`max`, 24) and total bars (`maxBars`,
  250k), because entries alone do not bound memory when one intraday series can
  be 100k bars, and bar count is the only honest proxy for bytes that does not
  mean serialising every entry on every write. Storage is an in-memory `Map` by
  default with an injectable sync-or-async `BarCacheStore`, so a host can choose
  localStorage or IndexedDB and the engine chooses neither. Opt-out is
  `getBars({ ..., noCache: true })` plus `invalidate()` and `clear()`, and
  `stats()` reports entries, bars, hits, misses and evictions for a status line.

- **An interval registry whose entry is a bucketing rule, not a duration.**
  `registerInterval({ code, bucketing })` puts a host's own interval codes in
  front of the engine, and `resolveInterval(code)` is how the engine asks how a
  code buckets. `Bucketing` is a four-case union:
  `{ mode: 'interval', seconds, anchorSec? }` for fixed lengths,
  `{ mode: 'calendar', unit: 'month' | 'quarter' | 'year', count?, timezone? }`
  for periods that have no seconds, and `{ mode: 'ticks', count }` /
  `{ mode: 'volume', perBar }` for count-driven bars.

  That is deliberately the vocabulary `TickTimeframe` already used, widened by
  one case, rather than a second parallel system. The three original variants now
  live in `src/feed/intervals.ts`, `TickTimeframe` is re-exported from
  `tick-aggregator` meaning exactly what it always meant, and `TickBarAggregator`
  takes the widened `Bucketing` plus an optional `timezone`.

  Calendar buckets are computed as absolute month indices floored to the step and
  converted back through `zonedWallClockToUtcSeconds`, so a month runs first to
  first at local midnight in the entry's zone (or the caller's, defaulting to
  IST). A month is not 30 days and a year is not 365: February 2024 is 29 days,
  March 2024 in `America/New_York` is 31 days minus an hour, and quarters land on
  January, April, July and October for every year. `bucketStartOf` and
  `nextBucketStart` are the pair, and `nextBucketStart` returns null for
  count-driven bars, whose close depends on trade flow rather than the clock.

  `registeredIntervals()` lists what a host has added, `tryResolveInterval` and
  `isKnownInterval` are the non-throwing probes for validating an interval
  picker, and `unregisterInterval` and the disposer returned by
  `registerInterval` take a code away again.

- **A chart says when it is gone.** `chart.isDestroyed`, a `'destroy'` event on
  the bus, and an idempotent `destroy()`. Anything holding a chart it did not
  create (a link group, a controller, a host cache) has to know the object is a
  corpse before it calls into it, and inferring that from a side effect such as
  an empty pane list only works for as long as nothing else can empty one. The
  event is emitted last, with the chart already torn down, because a listener is
  there to let go of the chart rather than to read it.

### Changed

- **Programmatic viewport moves announce themselves.** `setVisibleLogicalRange`,
  `fitContent`, `resetScale` and the keyboard pan and zoom commands now emit
  `'pan'` or `'zoom'` like a drag or a wheel does, so a chart linked into a grid
  follows an arrow key or a restored zoom and not only a gesture.

  One helper covers all of them rather than four bespoke emits.
  `_emitViewportIfMoved` compares the range before and after the mutation, emits
  nothing when the window did not actually move (a clamped zoom, an already
  fitted `fitContent`), and picks `'zoom'` or `'pan'` by whether the span
  changed, because a restore can do either and a listener cannot tell from the
  payload otherwise. The no-move check is load-bearing: without it a linked grid
  re-broadcasts on every no-op. `panUp` and `panDown` move a price scale rather
  than the time window and deliberately emit nothing. The keyboard `fitContent`
  command now routes through `chart.fitContent()`, so it gets the full
  invalidation the method always did.

- **An unknown interval code is an error, not a minute.** `resolveInterval`
  throws `UnknownIntervalError` carrying the offending code, and
  `intervalToSeconds` throws both for an unknown code and, separately, for a
  calendar or count-driven code that has no fixed length to report.
  `OpenAlgoLiveDataFeed.subscribeBars` resolves the code up front, so a bad
  interval fails at subscribe time rather than silently on every tick for the
  life of the subscription.

  The old behaviour was a silent fall back to 60 seconds, which drew minute bars
  under whatever label the caller thought it had asked for, with nothing anywhere
  saying so. A chart that refuses to open is a bug report; a chart showing the
  wrong timeframe is a wrong trade. `tryResolveInterval` and `isKnownInterval`
  exist for the callers that genuinely want to ask without being thrown at.

- **The live feed aggregates calendar, tick and volume intervals too.**
  `OpenAlgoLiveDataFeed` sends fixed intervals through `CandleBuilder` as before
  (it is the one that carries the late-tick policy) and everything else through
  `TickBarAggregator`, which is the one that knows those boundaries. It takes a
  `timezone` for calendar buckets, and `seedFrom` still continues a historical
  bar for time-bucketed intervals only, because a count-driven bar cannot resume
  one whose trades were never counted here.

### Fixed

- **A `top` primitive's own repaint request redrew the whole pane.** Every
  `requestUpdate` invalidated at `Light`, which repaints the base canvas, but a
  `top` primitive is only ever drawn by `Pane.paintTop`, which runs at `Cursor`.
  The pane legend, the drawing layer's live preview, the trading pills, the
  buy/sell buttons, the chart table and the DOM ladder all sit there, so a
  cursor-rate update from any of them cost a full series redraw instead of one
  overlay repaint, times every chart in a linked grid. The host now reads
  `primitive.zOrder()` per call and requests `Cursor` for a `top` one, which
  fixes it for every such overlay with no API change and nothing for a primitive
  author to remember. Read per call rather than captured at attach, because
  `zOrder()` is a method and a primitive is free to change layer.

- **`destroy()` could run twice, and left every subscription attached.** A second
  call re-ran the teardown and would now re-emit `'destroy'`; and the listener
  map was never cleared, so a subscription on a destroyed chart retained its
  closure and everything that closure captured for as long as the host held the
  corpse. Both are closed: `destroy()` returns immediately if it has already run,
  and `_listeners` is cleared after the event goes out.

### Internal

- The yfinance demo drives all four features by hand. A toolbar split toggle
  opens a second `Chart` with its own symbol picker and interval pills, joined to
  a `createLinkGroup`; a link menu carries live crosshair, viewport and symbol
  switches plus the nearest / hide choice for a missing instant; Ctrl+C, Ctrl+X
  and Ctrl+V are wired to the controller's clipboard with the chords shown in the
  right-click menu; `withBarCache` sits behind the yfinance feed with a warm or
  fetched verdict in the status line and a hit counter in the toolbar; and 1MO
  and 1Q calendar intervals are registered and folded from daily bars through
  `bucketStartOf`.

  Two of its decisions were forced by running it rather than reading it. A freshly
  loaded follower fits its own content with viewport sync suspended: letting the
  fit broadcast threw the leader off the window the user was on, and adopting the
  leader's window instead left a month of hourly bars as a sliver in an empty
  plot, so the two converge on the first pan, which is what the group documents.
  And the demo caps a request's `to` at the newest bar it holds whenever the venue
  is shut: the cache only allows a hit past its coverage while the next bar is
  still forming and it cannot know a market is closed, so out of hours every load
  was cold no matter what. With the cap, a reload reports "warm 1 ms" against
  "fetched 320 ms".

- No size budget raised. Measured against the same limits 1.3.0 set: base
  52.88 kB of 55, base plus trade 59.46 of 62, indicators 24.88 of 27, draw
  13.11 of 14 (70 B for the clipboard exports), transform 2.66 of 5, profile
  10.66 of 11, everything 110.76 kB of 120.

- Test suite grew from 1543 to 1719 across 91 files.

## 1.3.0

### Added

- **Market replay.** `ReplayController` walks a historical session forward one
  bar at a time, so a setup can be practised on it and every indicator redraws
  exactly as it stood at that past moment.

  It is headless in the same sense as `DrawingController`: it owns the playhead
  and the transitions and ships no DOM, so the host renders its own transport
  bar and clock from `state()` plus the `replay:start`, `replay:frame`,
  `replay:play`, `replay:pause`, `replay:end` and `replay:stop` events on the
  chart's bus.

  The mechanic is deliberately plain. Every transition (a seek, a step, and
  each played frame alike) hands the series a fresh **prefix** of the full bar
  array through the ordinary `setData` path, and that path already recomputes each
  indicator from `sourceBars()`. Shorten the history and every plot, level,
  fill, marker and legend row reconstructs itself as it stood at that bar, with
  no replay-aware code anywhere in the indicator tier.

  Playback timing is injectable (`now` and `scheduler`), and the bars owed by a
  tick come from the clock rather than from the tick count, so a throttled
  timer still plays at the requested speed. A single tick is capped at ten
  bars, so returning to a backgrounded tab does not fast-forward the session.
  `stop()` restores the pre-replay data together with bar spacing and right
  offset, which is what reproduces the visible range to the pixel even if the
  user panned and zoomed while replaying.

- **Multi-symbol comparison.** `addComparison(chart, { symbol, bars })` puts a
  second instrument on the primary one's pane and returns a handle with
  `setBars`, `remove`, `list`, `priceScale` and `alignment`. The per-chart
  `ComparisonController` behind it adds `setMode`, `realign`, `clear` and
  `destroy`.

  Comparability comes from the scale, not from the data. The bars are stored as
  the instrument's own prices on the pane's hidden overlay scale, so the legend
  and the crosshair still speak in real prices; the pane switches to
  `percentage` (or `indexed-to-100`) while a comparison is on it, and a
  per-frame pass gives the overlay the primary's range scaled by the ratio of
  their baselines, so equal percentage moves land on equal pixels. Without that
  last step each scale autoscales to its own data and a 1% mover looks exactly
  like a 10% mover, which is the lie the feature would otherwise ship.

  Alignment answers the two directions of mismatch differently, because they
  mean different things. A comparison print with no primary bar is **dropped**:
  the DataLayer merges every series onto one index space, so a foreign
  timestamp would mint a logical index and shift the primary's own bars. A
  primary bar with no comparison print becomes **whitespace**, which the line
  renderer breaks across, so a holiday on one exchange reads as a gap rather
  than as a straight line drawn through it.

  A pane's single hidden overlay is usually already taken by the volume
  histogram, so the controller detects that and falls back to the left axis
  instead of autoscaling price and volume together.

- **Axis chrome: a corner session clock and a bar-close countdown.** Both are
  off unless a chart asks for them through `axisChrome`, so a chart that omits
  the block draws the axes it always drew.

  `axisChrome.sessionClock` fills the one rectangle no series, tick or tag ever
  occupies: the corner where the two axis strips meet. It reads in the chart's
  own timezone rather than the machine's, with the zone's offset from UTC on a
  second row so a trader can see which clock they are reading; pass
  `{ showOffset: false }` for the time alone, and it drops the row by itself in
  a strip too short to carry it.

  `axisChrome.barCountdown` adds a second row inside the last-price tag counting
  down to the current bar's close. The interval is read back off the bars
  (median of the recent gaps, so an overnight break does not stretch it) rather
  than configured, because the chart is never told its own timeframe and one
  that switches mid-session has to follow. Past the close the count rolls into
  the next bar's cycle instead of stalling at zero, so a feed that is late with
  a new bar still shows a running clock.

  Neither reaches a global clock. `axisChrome.clock` supplies wall-clock UTC
  seconds and defaults to the system clock, so a delayed or replayed chart can
  be honest about what time its data thinks it is.

- **Price-axis labels no longer draw underneath the last-price tag.** The tag is
  painted into the same strip a moment after the tick ladder, so it used to land
  on top of whichever tick label it overlapped and the two read as mush. The
  pane now reserves the band the tag will occupy before the ladder is drawn, and
  a tick colliding with it is dropped instead of drawn through.

  Only labels the tag would actually have covered are affected: a chart whose
  last price sits clear of every tick draws the same ladder it always did.
  `AXIS_LABEL_PRIORITY` ranks the claimants (crosshair over last price over
  price line over session level over previous close over plain ticks), so the
  reading a trader is actually chasing is the one that survives a pile-up.

- **Reference price levels as one family.** `PriceLevels` is a primitive over
  ten levels: previous close, session high and low, last price, the four
  extended-hours opens and closes, and bid and ask.

  Each level is **one options group carrying its own `line` and `label` flags**,
  so the horizontal line across the plot and the tag on the price axis are two
  switches on the same idea. Terminals that split those halves across separate
  menus let them drift, and a user ends up with an axis tag for a line that is
  not drawn. Colour, width, dash, tag text and how far the line runs from the
  axis (`extentFromRight`) sit in the same group.

  The session comes from the bars and never from a calendar midnight. The
  session in view is the one containing the viewport's **right edge**, so
  scrolling back through history moves the previous close back with it, and the
  boundaries are read out of the bar gaps by `sessionStartFlags`, falling back
  to the calendar only when the series shows no readable break, which is the
  right answer for daily bars. Previous close is the previous session's last
  *traded* close, walked back over a whitespace tail so a halted closing minute
  does not blank the level.

  **A level with no data is `null`, never `0`.** Extended hours need a phase the
  OHLC feed does not carry (`marketPhase`, a host-supplied classifier), and bid
  and ask need a live `quote`; without them those levels stay inert rather than
  drawing a line across the middle of the plot. `available(kind)` reports it, so
  a host renders that control disabled with its state visible instead of hiding
  it. `values()` reads the last frame's prices, and the pure
  `computePriceLevels()` behind it is exported, so the numbers are testable and
  usable in a readout without a canvas.

  The last price is not duplicated. The core already draws it from
  `SeriesStyle.priceLineVisible` / `lastValueVisible`, so that level defaults to
  off and `lastPriceLevelFromSeriesStyle` / `seriesStyleForLastPriceLevel`
  translate between the two shapes, letting a host present it in the same form
  as every other level while the series keeps owning it. There is deliberately
  no `autoscaleInfo`: a previous close a gap away would stretch the range and
  flatten the bars the chart is actually for.

- **Price-scale `percentage` and `indexed-to-100` modes.** `PriceScaleMode`
  gains the two rebasing modes, built by extending the existing transform pair
  rather than by adding a parallel path: percent change is the index minus the
  100 it rebases to, so both share one ladder.

  The baseline is data, not geometry, so it arrives through the new
  `setBaseline(value)`; the pane supplies the first visible bar each frame,
  which is what makes panning re-base. With no baseline the transform falls
  back to the identity and the scale behaves exactly like `linear` rather than
  answering with nonsense before the first frame. Zero and negative baselines
  are refused for the same reason: percent change from zero is undefined, and a
  negative baseline flips the sign of the transform, so a rising price would
  draw downward on an axis that still labelled itself normally.

  Labels switch to the rebased domain while a rebase is in force ("+3.42%" with
  an explicit sign, "103.42" for indexed, two decimals minimum) and deliberately
  outrank a custom price formatter, since a currency prefix on a percent change
  would read as money that is not there.

- **A chart settings schema.** `chartSettingsSchema(chart)` describes a
  terminal's settings dialog as tabs of controls in the same vocabulary the
  indicator settings form already uses, so a host that can render one can
  render the other with no new widget code. `readChartSettings(chart)` and
  `applyChartSettings(chart, patch)` are its round trip, over flat dotted keys
  that survive JSON.

  The schema and its accessors are one structure: each control carries its own
  `read` and `write` beside its input descriptor, so a control cannot drift
  from the option it drives and there is no second table to keep in step. That
  is also the rule for what ships in it. Every control maps to an option that
  changes what is drawn or stored; a checkbox with nothing behind it is absent
  rather than inert. Price-tab controls are generated from the primary series
  type, so a candle gets borders and wicks while a line gets a dash.

  Five tabs, grouped so a trader finds a setting without hunting rather than to
  mirror anyone else's dialog: **Price** (what the instrument is painted with),
  **Readout** (what the header says), **Axes** (what the two scales do, and the
  timezone), **Appearance** (the surface around the data) and **Trading** (what
  the trade layer draws). Alerts and Events are not among them: alerts arrive
  with the feature, events have no data source in the schema, and an empty tab
  is worse than an absent one.

- **A paired colour control, `colorPair`.** A property with a bullish and a
  bearish colour is one labelled row carrying its switch and both swatches side
  by side, not a section header over separate Up and Down rows. The stacked form
  triples the height of every panel, which is what forces a scrollbar onto a
  dialog that should fit.

  It is a schema **row** over ordinary flat value keys rather than a new value
  shape: the control carries `up.key`, `down.key` and an optional `enabled.key`,
  each an everyday key of `ChartSettingsValues`, so `readChartSettings` and
  `applyChartSettings` needed no new protocol, the patch stays JSON-safe, and a
  host that ignores the widget can still drive the row key by key.

  `enabled` is optional on purpose. Candle Borders and Wick have
  `borderVisible` / `wickVisible` behind them, a candle Body has no such flag,
  so that row ships with two swatches and no switch rather than with a checkbox
  that would do nothing. Candles, bars, columns, the line and baseline fills and
  the three trade-colour rows (long/short, take profit/stop loss, buy/sell) are
  all paired rows now.

- **The chart timezone is a control in the schema**, `time.timezone` on the Axes
  tab: a select over `CHART_TIMEZONES` (roughly east to west, so the list reads
  like a trading day) with the chart's own zone folded in when it is not one of
  them, so a host that configured `Pacific/Auckland` still sees its setting
  selected. It calls `chart.setTimezone`, and a name `isValidTimezone` rejects
  is skipped rather than thrown, so one stale zone in a restored layout cannot
  throw away the rest of the apply. A dialog no longer has to bolt its own zone
  row on beside the schema and hand-roll the Cancel path for it.

- **The Canvas option block.** `GridOptions` grows from a spacing-only bag into
  the grid controls a dialog needs (per-axis visibility, colour, dash and line
  width), and `CanvasOptions` gathers it with crosshair, scale text and line,
  and plot margins. `chart.setCanvasOptions` and `ChartOptions.canvas` apply it;
  `dashPattern`, `resolveGridStyle`, `resolveScaleStyle`, `resolveCrosshairStyle`
  and `resolvePlotMargins` are exported so a host can preview with the same
  code that paints.

  Option overrides theme when set, theme is the default. Theme colours are
  deliberately not copied into the options at construction: that would freeze
  the palette and make a later `setTheme` a silent no-op for everything the
  dialog had touched, so each resolver falls through field by field instead.
  Plot margins convert the dialog's percentages into the `marginTop` and
  `marginBottom` fractions the price scale already owns, so there is no second
  margin state.

- **Status line options on the pane legend.** The legend row now carries
  per-field switches (logo, title with a symbol, description or ticker mode,
  market status, chart values, bar change, volume, last day change, last value
  label, and a background plate with colour and opacity).

  The primitive invents no data. Readings the host already pushes through
  `setValues` carry an optional `field` tag, so one switch hides exactly one
  group, and the three things a legend cannot know (a logo bitmap, the market
  state, the day change) arrive through a new `status` option that accepts a
  snapshot or a per-frame getter and draws nothing when absent. Every switch
  defaults to the behaviour that predates it, so a caller passing no options
  gets the same row it always drew.

- **Chart timezone, and the default does not move.** A chart that names no zone
  is `Asia/Kolkata` as it always was, and keeps the frozen offset arithmetic
  rather than reaching `Intl` at all: its axis labels, its crosshair tag and
  every session-anchored number are what 1.2.0 produced, byte for byte, on the
  same code, and never depend on the host's ICU build. That is pinned rather
  than assumed: a harness diffs price ticks, the last-price tag, the time labels
  and the legend row across six datasets against a 1.2.0 worktree, and the same
  instants driven through the IANA link name `Asia/Calcutta`, which takes the
  zone-aware path, draw identical labels.

  To move a chart off it, `ChartOptions.timezone`, `chart.setTimezone(zone)` and
  `applyOptions({ timezone })` take an IANA name, `chart.timezone()` reads it
  back, and `getState()` carries it so a saved layout restores the hours it was
  saved with.

  Naming a zone moves the whole calendar and not only the labels: the time axis
  (including which ticks escalate to a day, month or year label), the crosshair
  time tag, VWAP's week, month, quarter and year anchors, CPR's weekly and
  monthly pivot frames, and the month a Seasonality bar's close is counted in.
  A `session` anchor still reads the session out of the bar gaps as it has since
  1.2.0, and falls back to the zone's calendar day only when the gaps are
  unreadable. On US intraday bars read in `America/New_York`, the last ninety
  minutes of the 30 April session now fall in April rather than in May:
  Seasonality reads that month's real return instead of 0.00%, and May's monthly
  pivot frame is built from April's real high instead of one truncated ninety
  minutes early. `setTimezone` recomputes those studies rather than only
  repainting, because moving the calendar changes the numbers and not just the
  axis under them. An explicit `timeFormatter` still outranks the zone: a host
  formatting its own labels has settled the question.

  An IANA name and not a fixed offset, because a zone that observes DST is a
  different offset in July than in January. Changeovers are followed rather than
  approximated: New York skips 02:00 on 10 March 2024, and London jumps 00:00 to
  02:00 on 31 March and prints 01:00 twice on 27 October. An unknown name throws
  where it is set, so the mistake surfaces at the call site rather than as a
  chart quietly showing the wrong hours; a stale name in a restored layout is
  skipped instead, so one bad zone cannot cost a whole saved workspace.

  The zone reaches an indicator on the settings blob under the reserved
  `timezone` key, which the chart supplies. It is deliberately kept out of the
  indicator's own settings, so a layout saved on a New York chart does not carry
  New York onto the chart that restores it.

- **A `contextmenu` event**, carrying the pane index, the price, the time, the
  logical index, and a classified target: a drawing, an indicator with its
  instance id, a legend, a primitive, a series with its type, a price scale, a
  time scale, or empty plot. Calling its `preventDefault` suppresses the
  browser menu; with no listener the existing save-image snapshot stays as the
  fallback.

  A price-scale hit says **which** scale it was: `side` is the strip that was
  clicked, and `scaleId` is the scale that strip acts on, `''` when the side
  carries no series of its own and the pane's values live on the hidden overlay.
  It is the argument the `priceAxis*` calls take, so a menu can be raised on
  what was actually clicked. The time axis now wins the bottom-left corner
  because it spans the full width and its dates run through it; the bottom-right
  corner stays the price axis', where its own labels run out. Plot hits are
  unchanged.

- **A price-axis menu the host can build without guessing.**
  `chart.priceAxisState(paneIndex, scaleId)` returns everything such a menu
  renders: `autoFit`, `inverted`, `mode`, `lockRatio`, the `side` it draws in,
  whether any series maps to it (`active`), whether anything has measured it
  (`scaled`), and whether a move would do anything (`movable`). The acting half
  is `setPriceAxisOptions`, `setPriceAxisAutoFit`, `setPriceAxisLockRatio` and
  `movePriceAxis`, and `PRICE_SCALE_MODES` lists the four modes in the order a
  menu offers them. Every item is both readable and actionable, which is what
  keeps a row from being drawn ticked and doing nothing.

  Moving an axis swaps the two side scales rather than copying their state, so
  the range, mode, margins and formatter travel with it; the vacated strip
  starts again from the chart-wide defaults, the axis columns are recomputed so
  a strip no pane uses any more is released and the plot reclaims its width, a
  `priceAxisMoved` event is emitted, and a move onto an occupied side is
  refused, because one strip draws one axis.

  The ratio lock is real rather than a stored flag: the pane keeps the geometry
  the lock was taken at and rescales the visible span by height over bar
  spacing each frame, in transformed space through `yToPrice` so a logarithmic
  axis is right too. Auto-fit or `resetScale` releases it, and locking is
  refused on a scale nothing has measured, since there is no ratio to hold.

- **`colorByPreviousClose` and `precision` on `SeriesStyle`.** The first colours
  a bar by close-versus-previous-close, which is how most terminals paint one:
  body, border and wick take a single verdict computed once per bar, so the
  candle cannot disagree with itself. It is honoured by the candle family and
  by OHLC / high-low bars, and the pane looks up the bar left of the visible
  range so the leading bar is quoted against something rather than falling back
  to its own open. The Price tab of the settings schema exposes it for those
  types. The second overrides the decimals the
  price scale infers. It rides the scale's *formatter* rather than its
  `minMove`, so `precision: 0` formats to whole numbers without also starting
  to snap prices to them.

- **More of the chart's option surface is readable and writable**, which is what
  a settings dialog needs: `canvasOptions`, `statusLineOptions`,
  `setPriceScaleOptions` and `priceScaleOptions`, `setAutoScale`, `setEvents`
  and `setEventOptions` for the chart-owned corporate-action strip,
  `tradingSettings` and `setTradingSettings` (which never instantiate the trade
  layer just to be read), `primarySeries` and `primarySeriesInfo`, `theme` and
  `crosshairMode`.

### Changed

- **`chart.getState()` carries the settings slice.** Canvas options, status line
  options, trading colours and the event filters ride along beside `grid`, and
  `restoreState` puts them back, so a saved layout no longer loses everything
  the settings dialog did. The return type widens to
  `ChartState & ChartSettingsState`, which is still a `ChartState` to every
  existing consumer, and canvas margins are applied before the panes so a
  pane's own saved margins remain the more specific answer and win.

- **The price scale owns its tick ladder.** `PriceScale.ticks(maxTicks)` builds
  what the axis renderer used to build for itself. It is byte-identical for
  linear and log, but the rebasing modes need the ladder chosen in label space
  and mapped back, because a nice price is an ugly percentage: without it the
  axis reads "+3.47%, +6.94%" instead of "+5.00%, +10.00%".

- **`setGridOptions` takes the whole grid block**, not just the two visibility
  flags, and the pane strokes the vertical and horizontal lines separately so
  each can carry its own colour and dash.

- **An HLC area strokes the two edges of its band.** `SeriesStyle.highColor` and
  `lowColor` had named the top and bottom of the band since the type was
  written, and no renderer had ever read them: the band was a fill and a close
  line, so setting either colour did nothing. Both are now drawn. Neither has a
  default, so an existing caller that named neither gets the frame it always
  got, and one edge can be stroked without the other.

- **`SeriesStyle.volumeScaled` is gone.** It had been superseded by the
  `volume-candle` chart type, which scales bodies from the visible maximum
  volume in the registry whatever the flag said, so no code path could consult
  it. Removed rather than wired: the capability is a chart type, and a second
  way to ask for it that has never worked is not worth keeping.

- **One settings key moved: `scales.lastValueVisible` is now
  `symbol.lastValueVisible`.** The key names the `SeriesStyle` field it patches,
  and it now sits beside the price line it contradicts when the two disagree.
  Every other dotted key is untouched: they are a wire format hosts have written
  down, and an unknown key in a patch is ignored, so a layout saved with the old
  name restores everything else and loses only that switch.

- **Session windows are wall clock in a zone they name.** `SessionWindow`'s
  `startMinute` and `endMinute` are minutes from midnight on the window's own
  zone, and every `TRADING_HOURS` preset now carries one, so `us-regular` reads
  as 09:30 to 16:00 `America/New_York` instead of an unexplained 1140 to 90.
  `MarketProfileOptions.timezone` and `VolumeProfileFamilyOptions.timezone`
  (both `Asia/Kolkata` by default) settle the day, week and month buckets for a
  profile whose window names no zone.

  A window's own zone outranks the display zone for the window test **and** for
  the bucketing, because bucketing on the display zone would cut a 09:15 to
  15:30 Kolkata session in half when the chart is read from New York: that
  session genuinely straddles New York midnight. A preset therefore selects the
  same instants and forms the same sessions on any display, and only labels
  move.

  **The presets reproduce the 1.2.0 instants exactly through a summer week, and
  are deliberately an hour later in winter.** The old table was authored in EDT
  terms - 1140 IST minutes is 09:30 New York only while EDT is in force - so
  `london`, `new-york` and `us-regular` silently drifted by an hour for the
  months either side of it, which is the defect the re-expression exists to fix.
  `india`, `asia` and `all-hours` are unchanged year-round.

### Fixed

- **Hollow candles ignored two of their own colour options.** In hollow mode the
  up outline was painted with `upColor` rather than `borderUpColor`, and
  `borderVisible` was never consulted at all; a filled down body in that mode
  got no border either, which left `borderDownColor` unreachable. The border
  colour is now computed once and used in both branches. The hollow up outline
  still draws with borders off, because it *is* the body, but falls back to the
  body colour rather than erasing the candle.

- **The zone stopped at the axis.** Four wiring gaps, each invisible to a test
  of either half on its own. The pane pre-baked its own labeller instead of
  handing `drawTimeAxis` the zone, so a host with its own `timeFormatter` was
  told the day had turned over at IST midnight whatever zone the chart was on.
  Nothing put the chart's zone on an indicator's settings, so `setTimezone`
  relabelled the axis while every session anchor kept computing on IST, and
  changing the zone did not recompute them. `colorByPreviousClose` was copied
  into the candle style object and nowhere else, so an OHLC bar series stored
  the flag and painted as though it were off. And the demo's O/H/L/C, change and
  volume readings carried no `field` tag, so the Chart values, Bar change values
  and Volume switches reached nothing and those readings answered to Indicator
  values instead.

- **A chart could measure itself before its container had a size.** Built inside
  a container the browser had not laid out yet, every price scale stayed on its
  `0..1` placeholder until something else forced a resize, so an early
  `priceToCoordinate` or a first-frame primitive read a range that was not the
  data's. The chart now re-applies the container size one frame after
  construction, and only when the container reports a real positive box, so a
  size the host applied itself and a container that is still hidden are both
  left alone. `destroy` cancels the pending frame. It uses the chart's own
  resolved scheduler, so a test driving frames by hand is not left waiting on a
  browser rAF that never comes.

- **Half the chart ignored a price axis that had moved.** Moving a pane's prices
  to the left strip relabelled the axis and left everything else pointing at the
  right one: the crosshair tag, the last-price line and tag, the coordinate API
  (`priceToCoordinate` / `coordinateToPrice`) and the axis drag all read the
  right scale whatever the prices were labelled in, and the left strip could not
  be dragged at all. Each now follows the scale the pane's values actually sit
  on.

### Internal

- The yfinance demo's settings dialog was rebuilt against the new schema: five
  tabs with their own glyphs, a paired-colour row rendered as one line with its
  switch and both swatches, themed checkboxes and selects instead of the browser
  defaults, colour inputs as small rounded squares rather than full-width bars,
  dark scrollbars styled once at the root, and a "Restore this tab" action
  driven by the schema's own declared defaults. Every tab, the densest included,
  now fits a 729 px viewport without scrolling. The hand-rolled Timezone row and
  its Cancel bookkeeping are gone: the schema's `time.timezone` control drives
  it, and the demo only mirrors the zone back so a chart rebuild keeps it.

- The demo also gained a price-axis context menu, built entirely from
  `chart.priceAxisState()`: auto-fit, invert and pin-price-per-bar as ticked
  toggles, the four scale modes as one exclusive group, a side-move row, and two
  flyouts over a `PriceLevels` primitive, one for the lines on the plot and one
  for the tags on the axis. A level with no data renders disabled with its state
  visible rather than being hidden. Alt+R/L/P/1, Alt+I and Alt+A are shown in
  the rows, in the same Alt+key grammar the drawing tier already uses.

- Size budgets raised for the new capability: base 42 to 55 kB, base plus trade
  49 to 62 kB, everything 96 to 120 kB. The indicator, draw, transform and
  profile tiers are untouched. Measured: base 49.37 kB, base plus trade
  55.95 kB, everything 105.88 kB.

- Test suite grew from 1129 to 1543 across 81 files.

## 1.2.0

### Added

- **Tables over the chart.** `ChartTable` is a new screen-space primitive: a
  grid pinned to a pane corner that stays put while the chart pans underneath,
  like the watermark and the pane legend. It has no time anchor, takes no part
  in autoscale, and survives a zoom untouched.

  Columns size from a fixed width, a per-column array, or a percentage of the
  plot; rows size from a fixed height, a percentage, or per-row weights, so a
  separator row can be a rule rather than a full-height gap. Type shrinks rather
  than overflowing when a stretched row is shorter than the declared font.

- **`IndicatorDescriptor.table`**, an optional hook beside `markers`, returning
  rows of cells and the table options to draw them with. It runs after `calc`,
  so it reads the values it just produced. An indicator whose output is a matrix
  rather than a column of prices had nowhere to put it: a plot is a price per
  bar, and a monthly return heatmap is neither. The runtime creates the table
  lazily, so an indicator without the hook pays nothing.

- **Five new built-in indicators**, taking the catalogue from 86 to **91**:

  - **Seasonality** (`seasonality`) - a monthly return heatmap, one row per
    year, with average, standard deviation and percent-positive summary rows.
    The first indicator to use the table hook, and the only one whose entire
    output is the grid. Months can be excluded by `YYYY-MM` key.
  - **CPR with Floor Pivot** (`cpr`) - the central pivot range and floor pivots
    across Daily, Weekly and Monthly frames, 27 plots in all. Auto mode picks
    one frame from the bar spacing; Manual stacks any combination.
  - **AlphaTrend** (`alphatrend`) - an ATR-offset trailing level gated by MFI
    (or RSI when the feed carries no volume), with the level shaded against its
    own two-bar lag and Buy/Sell plates at each crossover.
  - **Range Analysis** (`range-analysis`) - session range against its rolling
    average, as a two-column study.
  - **WaveTrend Pro** (`wavetrend`) - the channel oscillator with its signal
    line and momentum histogram, overbought and oversold bands, and cross
    markers.

- **Session boundaries are exported**: `sessionStartIndices`,
  `sessionStartFlags` and `calendarPeriodFlags` on the package root. They read
  an exchange's trading day back out of the bar timestamps, which is what the
  session-anchored indicators now use, and what a custom indicator should use
  rather than assuming a timezone.

### Changed

- **VWAP, TWAP and CPR read the trading session from the bars.** They anchored
  to an IST calendar day, which is 18:30 UTC. That is the middle of a New York
  session, so on US intraday bars VWAP restarted every afternoon, and CPR built
  each daily frame out of one session's tail plus the next session's head across
  the overnight gap.

  On a month of AAPL five-minute bars the old rule found 27 "days" with a widest
  range of 34.75 points, against 22 real sessions with a widest range of 11.14.
  S3 came out 37 points low, which stretched the price scale far past the
  candles.

  Sessions are now found from the widest recurring gap in the timestamps. The
  reading is declined, and the calendar rule kept, when there is nothing to
  read: bars already a day or coarser, a market that never closes, or a feed
  whose only gaps are weekends. An intraday lunch break is shorter than the
  four-hour floor, so it is not mistaken for a close.

  The coarser anchors (week, month, quarter, year) now compare session opens
  rather than every bar, for the same reason in the other direction: the last
  ninety minutes of a New York Friday fall on a Saturday in IST, which started
  the next week partway through Friday's session.

  **Behaviour on NSE data is unchanged.** Its session runs 03:45 to 10:00 UTC,
  so the session date and the IST date are always the same day.

- **`maximizePane` hides the other panes** instead of collapsing them to a
  sliver. They were parked at a 0.001 weight, which left a strip of squeezed
  candles and a separator hairline above the pane you had asked to see on its
  own.

  A maximized pane now takes the whole chart through the layout rather than by
  rewriting weights, and panes with no share are hidden outright, so their box
  paints no border and their canvases answer no hit tests. The bottom *visible*
  pane owns the time axis, so maximizing the price pane with indicators beneath
  it still gets a date axis. Stored weights are never disturbed, so
  un-maximizing restores the stack exactly and `getState` can no longer persist
  the placeholder.

### Fixed

- **A pane kept the price range of a departed indicator.** Panes are reused when
  one indicator replaces another, so swapping RSI for Seasonality left the table
  pane labelled 0.00 to 1.00 from a scale that had been 0 to 100. An indicator
  whose entire output is a table or a set of markers plots no values, so nothing
  ever autoscales its pane.

  A scale now forgets its range when it loses its last series, and the axis is
  drawn only for a scale that has actually been measured. A manually scaled axis
  is left alone, since nothing would recompute a range the user set by hand.

### Internal

- The yfinance demo gained a search box on the indicator menu, which 91 entries
  needs, and its saved layout now records the symbol, interval and period it was
  captured on. A viewport is a range of bar indices and a manual price range is
  a range of prices, and neither survives a change of dataset: restoring a day
  chart's view onto five-minute bars left the candles off-screen, which read as
  the chart having loaded nothing at all.

- Size budgets raised for the new capability: base 40 to 42 KB, base plus trade
  47 to 49 KB, indicators tier 21 to 27 KB, everything 90 to 96 KB. Measured:
  base 38.2 KB, indicators tier 24.7 KB, everything 94.0 KB.

- Test suite grew from 1001 to 1129 across 66 files.

## 1.1.0

### Added

- **66 new built-in indicators**, taking the catalogue from 20 to **86**. Every
  one is an original implementation written from the published definition of a
  well-known formula, verified against hand-computed values rather than
  transcribed.

  - *Moving averages and overlays*: ALMA, DEMA, TEMA, HMA, KAMA, LSMA, VWMA,
    McGinley Dynamic, Median, MA Cross, MA Ribbon, TWAP, Envelope, Donchian
    Channels, Keltner Channels, Chande Kroll Stop, Chandelier Exit, Williams
    Alligator.
  - *Momentum and strength*: Aroon, Aroon Oscillator, Awesome Oscillator,
    Balance of Power, Chande Momentum Oscillator, Coppock Curve, DPO, Fisher
    Transform, Connors RSI, Momentum, Rate of Change, PPO, TRIX, True Strength
    Index, SMI Ergodic Indicator, SMI Ergodic Oscillator, Stochastic Momentum
    Index, Know Sure Thing.
  - *Ranges and oscillators*: Stochastic RSI, Williams Percent Range, Ultimate
    Oscillator, Relative Vigor Index, Relative Volatility Index, Woodies CCI,
    Pring's Special K.
  - *Volatility*: Bollinger Bands %b, Bollinger BandWidth, BBTrend, Choppiness
    Index, Historical Volatility, Average Daily Range, Chop Zone, Mass Index,
    Ulcer Index.
  - *Volume and flow*: Chaikin Money Flow, Chaikin Oscillator, Ease of Movement,
    Elder Force Index, Klinger Oscillator, NVI, PVI, Price Volume Trend, PVO.
  - *Signals*: Vortex, Volatility Stop, Trend Strength Index, Williams Fractals,
    RSI Divergence.

- **Shaded fill regions on 22 descriptors** (28 fills in all), including the
  overbought/oversold background bands on RSI, Stochastic, Stochastic RSI, MFI,
  CCI, Connors RSI, Choppiness, Williams %R, Relative Volatility Index, SMI and
  Bollinger %b.

  The idiom is worth knowing if you write your own: `IndicatorFillSpec.between`
  resolves against **`calc` output columns, not declared plots**, so a band
  between two constant levels is a fill between two constant columns that are
  never plotted.

- **A smoothing block on CCI and OBV** matching the reference: a selectable MA
  over the indicator's own output, with optional Bollinger Bands around it.

### Changed

- **VWAP is substantially extended.** It now ships standard-deviation bands
  (three pairs at multipliers 1, 2 and 3, only the first shown by default), a
  `calcMode` of Standard Deviation or Percentage, six anchor periods (session,
  week, month, quarter, year, continuous), an `offset` input, and a fill per
  band pair. Its line colour is now `#2962ff`.

  The cumulative maths is unchanged, so existing VWAP plots are unaffected. Note
  that on daily bars with the session anchor each bar is its own session, so the
  bands collapse onto the line; they are an intraday tool.

- **Supertrend draws its shaded band** between the stop and the candle body
  midpoint, recolouring at each flip.

- Pane legends no longer print `Balance of Power` style parameter summaries
  containing bare booleans.

### Fixed

- **The `column` renderer ignored per-bar colour.** `drawColumns` always used
  the up/down pair from the series style, discarding the `color` set on each
  point, even though the indicator registry documents `colorBy` as supported by
  both the histogram and column renderers. Three indicators were silently
  painting a single colour across the whole series: Chop Zone, Awesome
  Oscillator and BBTrend. Chop Zone's nine-colour ladder was the visible symptom.

### Internal

- The indicator source modules were reorganised and renamed by family:
  `trend`, `momentum`, `volume`, `overlay`, `oscillators`, `volatility`, `flow`,
  `adaptive`, `averages`, `strength`, `ranges`, `indices`, `signals`, and
  `external` (formerly `tier2.ts`). These are internal paths, not published
  entry points, so nothing consumers import has moved.

- New calculation helpers shared by the ports: a standard SMA-seeded EMA (which
  differs from the base bundle's `ema` for roughly the first `length` bars),
  plus `change`, `roc`, `dev`, `percentRank`, `alma`, `vwma`, `highestBars`,
  `lowestBars`, `rollingSum`, `cumulative`, `linreg`, `swma`, `stoch`,
  `percentileNearestRank`, `correlation`, `cci`, `pivotHigh`, `pivotLow`,
  `barsSince` and `valueWhen`.

- Third-party product names removed from source and tests, with a CI step that
  fails the build if one reappears. The check is case-aware so it catches
  camelCase identifiers without tripping on legitimate names like Choppiness.

- Size budgets raised for the new catalogue: indicators tier 9 to 21 KB,
  everything 76 to 90 KB. Measured: indicators tier 20.1 KB, everything 88.2 KB.

- Test suite grew from 620 to 1001 across 61 files.

## 1.0.29

### Added

- **HalfTrend** joins the indicator tier as `halftrend`, bringing the built-in
  count to 20. A trend-following level that holds flat through noise: two state
  machines run at once, and a flip only fires when the mean high (or low) crosses
  the tracked extreme **and** the bar closes beyond the previous bar's low (or
  high). Requiring both is what keeps the level still where a moving average
  wobbles. Ships with half-ATR channel bands, per-side ribbons, and Buy/Sell
  labels, each independently toggleable.

  Original implementation written from the algorithm's published behaviour, per
  ARCHITECTURE.md §0.1, not ported from any third-party source.

- **`IndicatorDescriptor.markers`**: an optional hook returning bar-anchored
  `SeriesMarker`s, run after every `calc` so it reads the values it just
  produced. A plot cannot express a named signal: a plot is a column of prices,
  whereas a flip is a discrete event with a label. The runtime creates the marker
  layer lazily on the first plot's series, so an indicator without the hook pays
  nothing.

- **`INDICATOR_PLOT_STYLES` is now exported** from the package root. The docs
  already listed it as an import, but it was only declared internally, so the
  documented call failed. It is the plot-style option list a generated settings
  form offers alongside `INDICATOR_LINE_STYLES` and `INDICATOR_SOURCES`.

- **`labelUp` / `labelDown` marker shapes**: text plates with a tail that points
  at the anchor price, for named signals rather than bare glyphs. `labelUp` puts
  its body below the anchor, `labelDown` above. `drawLabel` is exported for
  custom primitives that want the same plate.

### Fixed

- **`VERSION` had drifted four patches behind `package.json`** (it read `1.0.24`
  at the 1.0.28 release), so anything displaying the library version showed the
  wrong one. A test now pins the two together.

- **Pane legends no longer print `true true true`.** `_paramSummary` included
  boolean inputs, so an indicator with visibility toggles rendered them as bare
  words. Booleans are now excluded for the same reason colours already were: the
  value names nothing, and what the toggle did is already visible on the chart.

### Changed

- Size budgets raised for the new feature: base 37 -> 38 KB, base+trade 44 -> 45
  KB, everything 73.5 -> 76 KB. Measured: base 37.00 KB, everything 74.17 KB.

### Documentation

Corrected claims that no longer matched the source. The library behaved
correctly in every case below; the docs did not.

- README: version (said 1.0.8), test counts (said 468 across 47 files, now 619
  across 50), and both size tables, which disagreed with each other because they
  were snapshots from different releases.
- README + ARCHITECTURE.md §13a: the four stated **Footprint gaps are all
  stale**: the renderer is theme-driven, has `setOptions`, three display modes,
  and draws stacked imbalances. Replaced with the real remaining gap: only
  `Footprint` reads `rc.theme`; `VolumeProfile`, `MarketProfile` and
  `HorizontalProfile` do not.
- README + ARCHITECTURE.md §13a: **overlay price scales are implemented**
  (`priceScaleId: ''`). Only `percentage` and `indexed-to-100` are absent.
- `ChartOptions.theme` JSDoc said `darkTheme` was the default; `DEFAULT_THEME`
  is `lightTheme`. This one shipped in the typings.
- The event-bus comment claimed `chart.trading.on('order_modify')` was
  equivalent to the prefixed name. `TradingController` keys its listener map on
  the full `trading:order_modify`, so the bare name never fired.
- `events.mdx`: `click` carries `{ id, price, time, paneIndex, point }` and `id`
  is **`null`** for a click on empty space; `drag:end` carries the same shape
  minus `point`. Both were documented as near-empty payloads.
- `data-feeds.mdx`: `TradeFeed` was documented with `orderBook()` /
  `positionBook()` / `marketDepth()`; it actually declares `subscribeOrders` /
  `subscribePositions`. Added the `OrderFeed` vs `TradeFeed` split, since
  `OrderEngine` takes the smaller one.
- `trading.mdx` called `eng.placeLimit(...)`, which does not exist, corrected to
  `placeOrder` with a real `PlaceRequest`.
- `drawing-tools.mdx` showed `draw.add('rectangle', [a, b], style)`; `add` takes
  a single drawing object.
- `primitives-and-plugins.mdx` showed `zOrder` as a property in one snippet and
  as a method in another. It is a method.
- `market-profile.mdx` used `colorMode: 'heat'` and `showLetters`, neither of
  which exists, the heat modes are `count` and `volume`, and letters are
  controlled by `blockDisplay`.
- `scales-and-panes.mdx` documented `timeScale.scrollToRealtime()`, which does
  not exist.
- `keyboard-shortcuts.mdx` said the arrow keys pan one bar; they pan two.
- `live-data.mdx` referenced an exported `mapOrderStatus`; the mapping is
  internal.
- Stale built-in counts corrected across the source comments, README,
  `getting-started.mdx` and `.size-limit.json`, plus the draw tier's header,
  which still said 18 tools when 43 are registered.

## 1.0.28

### Added

- **Drawing tools carry a keyboard `shortcut`.** The built-in line tools ship
  the standard chords, `Alt+T` trend line, `Alt+H` horizontal line, `Alt+J`
  horizontal ray, `Alt+V` vertical line, `Alt+C` cross line, and any tool
  registered with `registerDrawingTool` can declare its own.

- **`matchDrawingShortcut(event)`** resolves a key event to a tool id, and
  **`drawingShortcuts()`** returns the `id -> shortcut` map for rendering the
  chord beside a tool's name in a palette.

  The library installs no listener: only the host knows whether the chart has
  focus, a dialog is open, or the user is typing. Modifiers must match exactly,
  so `Alt+T` does not fire for `Ctrl+Alt+T` and a tool cannot shadow a browser
  or host chord; a bare letter never matches, so ordinary typing is unaffected.
  `metaKey` counts as Ctrl.

## 1.0.27

### Added

- **`PriceLine.setOptions()`** restyles a line in place, colour, width, dash,
  labels, badges, and repaints. Only `setPrice`, `setLeftLabel` and
  `setDragGhost` were updatable, so a line's colour was fixed at construction
  and a last-price line could not follow the tick direction. `id` is excluded:
  it is the handle the chart routes clicks and drags through, and swapping it
  under a live drag would strand the gesture.

## 1.0.26

### Fixed

- **Price-scale margins are fractions of the pane height, as documented.**
  `autoscaleRange` padded the *data span* by the margin instead, so how much
  room a margin reserved depended on how tall the data happened to be. A volume
  overlay asking for `marginTop: 0.82` to sit in the bottom 18% of the pane got
  `high + 0.82 * span` and drew its bars across **55%** of it, swallowing the
  price series.

  The data band now occupies the `1 - marginTop - marginBottom` left between the
  margins. Margins totalling 1 or more keep a sliver of room rather than
  producing an infinite range.

  Existing charts on the `0.1` default shift by a few percent (the data band
  goes from 83% of the pane to 80%); only large margins, which were the broken
  case, move noticeably.

### Changed

- Third-party product names removed from source comments, docs and examples.

## 1.0.25

### Added

- **`LogoWatermark` plate padding is settable.** `padding` takes a number for
  both axes or `{ x, y }` for each, defaulting to the previous `{ x: 7, y: 4 }`.
  `height` sizes the mark and `padding` sizes the plate around it, so the corner
  at rest is now exactly specifiable: a 40px mark with `padding: 2.5` sits in a
  45x45 square.

### Fixed

- **The plate is its requested size at every DPR.** The padding was rounded to
  device pixels and then doubled, so a fractional value was rounded twice and a
  plate asked to be 45px tall came out 46 on a non-retina display. The four
  edges are snapped instead, which also keeps the border crisp.

- **The hover target follows the padding.** It was fixed at 4px around the mark,
  so a generously padded plate had dead margins that looked interactive; it now
  matches the visible plate, with 4px kept as the floor so a tightly padded mark
  is still a forgiving target.

## 1.0.24

### Added

- **`LogoWatermark` can be a hover-revealed, clickable brand lockup.** `label`
  shows the mark alone at rest and unrolls the wording to its right on hover,
  clipped to the revealed width so the text wipes out of the mark rather than
  fading in place.

  The mark and the label **share one colour**: whichever of `tint` or
  `labelColor` is set drives both. Left to render independently, the mark kept
  its source colour and sat beside the label in an unrelated shade.

  A rounded `background` plate sits behind the pair, drawn at full alpha so it
  does not inherit the logo's transparency: without one the wording lands
  straight on the candles and is unreadable wherever the chart is busy.

  `href` marks it clickable, the hit reports a pointer cursor and `href()`
  returns the URL with `utm_medium`, `utm_campaign` and a `utm_source` naming
  the embedding page (host and path only, never the query string). A canvas
  cannot hold an anchor, so the host does the navigating.

  A mark with neither `label` nor `href` stays out of the hit path entirely, so
  plain decoration cannot swallow clicks meant for the chart.

### Fixed

- Tinting borrowed a document from the drawing context to build its offscreen
  canvas, and threw where there was none. It now falls back to an untinted mark
, which matters more now that a labelled mark is always tinted.

## 1.0.23

### Fixed

- **`sma` was poisoned permanently by a single non-finite value.** It kept a
  running sum, so `sum += NaN` made every later value `NaN`, and subtracting
  the NaN back out when it left the window could not restore it. Any indicator
  fed a series with a warmup gap, which is any indicator chained onto another,
  produced nothing at all for the whole series. It now sums only finite values
  and counts the rest, so it reports `NaN` while a gap is inside the window and
  recovers the moment it leaves.

### Added

- **Per-bar plot colour.** `IndicatorPlot.colorBy` returns a colour per bar, and
  histogram and column renderers honour a `color` on the data point. One colour
  for a whole series cannot express a study whose meaning changes bar to bar.

- **MACD's histogram is four states**, matching how it is normally read: above
  or below zero says which side, and rising or falling against the previous bar
  says whether that momentum is building or fading. All four are settings
  (`histUpColor`, `histUpFadeColor`, `histDownColor`, `histDownFadeColor`), and
  the MACD/signal lines default to blue and orange.

- **`William VIX FIX`** (`williams-vix-fix`), a synthetic VIX from price alone.
  The histogram goes lime when `wvf` pierces its Bollinger upper band or the top
  percentile of its range, gray otherwise, with the range lines and upper band
  drawable via the `hp` / `sd` toggles. Those toggles hide the *plots* only: the
  colour rule reads its own columns, so hiding the band cannot silently stop the
  alert, which is the whole point of the study.

- **A hairline between stacked panes**, themed as `paneSeparator`. Drawn on the
  pane's DOM box, so it sits exactly on the boundary the user drags rather than
  drifting from it when weights change.

### Changed

- Base+trade budget 42.5 -> 43 KB for the new indicator.

## 1.0.22

### Fixed

- **A maximized indicator pane drew its legend through the host's overlay.**
  `legendOffset` was pinned to one pane index, on the assumption that the host's
  own readout always covers pane 0's corner. Maximizing a lower pane parks the
  others at a placeholder weight, so the maximized pane moves into that same
  corner, and, not being pane 0, kept the default corner and drew straight
  through the host's symbol / OHLC line.

  The offset now follows whichever pane actually renders at the chart's top,
  re-evaluated on every relayout. `legendOffset.paneIndex` is gone; it described
  a fixed answer to a question whose answer moves.

  Host-added legend rows are left alone, a host positions its own.

## 1.0.21

### Fixed

- **`legendOffset` shifted every pane, not just the overlaid one.** A host that
  offsets the price pane clear of its own OHLC readout was also pushing the
  legend on each lower indicator pane down by the same amount, and a lower pane
  is short, so its row went off the pane entirely, taking the settings, close
  and move-pane buttons with it. An RSI pane could not be configured, moved or
  removed from its own legend.

  The offset now applies to one pane, `paneIndex` (default 0), because that
  overlay is nearly always on the price pane. Every other pane keeps the
  default corner.

## 1.0.20

### Added

- **A repeated indicator gets its own colours.** Adding a second EMA gave it the
  descriptor's one default blue, so three EMAs were indistinguishable both on
  the chart and in the legend, and telling which row belonged to which meant
  opening each one's settings.

  The 2nd and later instances of the same `indicatorId` now rotate through a
  palette. Only colour keys the caller left unset are filled, so an explicit
  colour always wins; the first instance keeps exactly what the descriptor
  chose; and the count is per indicator id, so adding two EMAs does not shift
  the first RSI. Multi-plot indicators stride by their plot count, so MACD's
  three lines shift as a block instead of landing on the previous instance's
  colours.

## 1.0.19

### Fixed

- **`BuySellButtons` painted its label outside the button at any `scale` below
  1.** The price and label baselines were fixed pixel offsets (18 and 33) tuned
  for the 42px box, so they were exact at scale 1 and increasingly wrong below
  it, at 0.72 the label sat 3px past the bottom edge. They are fractions of the
  button height now, which is the same result at scale 1.

## 1.0.18

### Added

- **A plot's chart type is now a setting.** `indicatorStyleInputs` generates a
  "Plot style" select per plot (`<plot>:type`), so the same column of numbers can
  be drawn as a line, step, area, histogram or columns, a descriptor cannot know
  which reads best for a given use. Defaults to the declared type, so nothing
  moves unasked. `INDICATOR_PLOT_STYLES` is the option list.

  Switching rebuilds that plot's series rather than restyling it: the chart type
  belongs to the series, not the style bag.

## 1.0.17

### Added

- **Indicator fills, the Ichimoku cloud.** A descriptor can declare `fills`,
  shading the band between two of its plots. Two lines are not the same picture
  as a filled region: the shading is what makes "price is above the cloud" and
  "the cloud flipped" readable at a glance, and which span leads is itself the
  signal, which is why the band takes two colours.

  Ichimoku now ships one between Senkou Span A and B, restyleable through
  `cloudUpColor` / `cloudDownColor`. Runs are split at the exact crossing rather
  than the nearest bar, or the colours would bleed a bar past every flip, and a
  gap in either plot breaks the band instead of bridging it.

  `IndicatorFill` is exported for hosts that want to shade their own pair.

- **The `measure` tool reports what a measurement should.** It drew a box and
  one line of text; it now draws the price and time arrows that make it read as
  a measurement, and a chip carrying the change, percentage, bar count,
  calendar span, and (via `rc.bars()`) the volume over the span.

### Changed

- Base tier budget 35 -> 36 KB, base+trade 41.5 -> 42.5 KB, full 72 -> 73 KB.
  The fill primitive lives in the base bundle because `IndicatorInstance` does.

## 1.0.16

### Added

- **`BuySellButtons` takes a `scale`** (default 1, clamped 0.6 to 1.5). The panel
  was a fixed 190x42, which crowds the pane's legend rows in a dense trading
  layout and left no way to make room. Box, gaps, corner radius and type all
  scale together, and so do the hit rects, a smaller button that still took
  full-size clicks would be worse than no option at all.

## 1.0.15

### Added

- **`legendOffset` chart option**: where indicator legend rows start inside a
  pane, in media px. A host that draws its own overlay in the top-left corner
  (an OHLC readout, a symbol line) had no way to push the canvas rows clear of
  it, so adding an indicator landed its legend *underneath* the host's own text:
  unreadable, and its settings and close buttons invisible and unclickable.
  Defaults to `{ top: 6, left: 8 }`, so nothing moves unless you ask.

## 1.0.14

The lazy tiers were unusable from TypeScript. Fixed, with a build guard so it
cannot come back. 556 unit tests.

### Fixed

- **`openalgo-charts/draw`, `/trade` and `/profile` could not be used from
  TypeScript at all.** Passing the chart from `createChart()` to
  `new DrawingController(chart)` failed with

  > Types have separate declarations of a private property `_container`

  and there was no way to fix it from outside the package.

  Each tier is bundled into its own `.d.ts`. A tier that imported a shared type
  through a *relative* path had that declaration **inlined**: so `Chart`,
  `TimeScale`, `PriceScale` and `DataLayer` each existed twice. Those classes
  carry private members, which makes them nominal rather than structural, so the
  second copy was a genuinely different type to TypeScript. Plain JavaScript
  consumers never noticed, which is why it survived this long.

  Tiers now import shared types from the package entry, which tier builds
  already leave external, so there is one declaration and one identity. The tier
  declarations shrank as a side effect: draw 47 KB -> 17 KB, trade and profile
  similarly.

- `DrawingController` takes a structural `DrawingChartHost`, the seven members
  it actually uses, rather than the whole `Chart` class. The real chart
  satisfies it with nothing to cast, and the contract now states what the
  controller needs.

### Added

- **`DataLayer`, `IndexedBar` and `SeriesId` are exported types.**
  `chart.dataLayer` was public while its type was not nameable, so a consumer
  could hold one but never declare one.
- `npm run check:dts`, wired into `verify`: fails the build if any tier
  re-inlines a shared declaration.

## 1.0.13

Nine more drawing tools (34 -> 43), freehand brushes, one-click position tools,
and the fix for `path` / `polyline` being impossible to finish. 556 unit tests.

### Fixed

- **Brush and Highlighter behaved as polylines**: a vertex per click, and no
  way to end the shape. Both are `points: 0`, which the controller read as
  "collect anchors until told to stop", the same contract `polyline` wants.

  `DrawingTool` gains `freehand`. A freehand tool samples the cursor while the
  pointer is held and commits on release, so one press-drag-release is one
  stroke. `crosshair:move` now carries `pressed`, since placement mode swallows
  the pan path and there was otherwise no way to observe a drag in progress.

- **A selected brush showed a grab handle on every sampled point**, burying the
  ink under dozens of circles and leaving no way to grab the stroke itself. A
  freehand drawing now handles only its two ends; it still keeps every sample,
  which is what gives it its shape.

### Added

- **Nine more drawing tools**, taking the built-in set from 34 to 43 (draw tier
  8.3 KB -> 11.3 KB Brotli):

  Shapes: `rotated-rectangle` (anchors 0->1 lay out an edge, 2 sets the depth
  perpendicular, so it can follow a trend channel an axis-aligned rectangle
  cannot) and `double-curve` (an S through three anchors, the second control
  mirrored about the chord's midpoint). Cycles: `cyclic-lines`, `time-cycles`,
  `sine-line`. Text and notes: `price-label` (reads its value off the anchor, so
  dragging it re-reads rather than going stale), `callout`, `flag-mark`.
  Brushes: `brush`.

- **`path` and `polyline` can now be finished.** Both declare `points: 0`, and
  nothing could ever complete them -- double-click reset the view instead, so
  they collected vertices forever. Double-click now finishes the shape while a
  tool is armed, and `controller.finish()` is public for binding a key.

- `path` is a click-per-vertex shape again, with an arrowhead on its last leg --
  what separates it from `polyline`. The freehand brush moved to its own `brush`
  id, so the two are no longer one tool wearing two names.

- **`DrawingTool.expand`**: a tool can turn the anchors actually clicked into
  its full anchor set, so it can place a complete, immediately editable default
  from fewer clicks. Receives `barSeconds` and `visibleBars`.
- **Long/Short Position place from a single click at 1:1**, sized to ~8% of the
  visible range so the box is grabbable at any zoom, with all three anchors
  still draggable. Previously they needed three clicks and drew nothing until
  the third.
- **Position and Forecast readouts** are now chips rather than one terse line.
  Position: `Target: <Δ> (<%>), Amount: <cash>` outside the target line,
  the same for `Stop`, and `Qty` / `Risk/reward ratio` at the entry, each
  hugging its own line, so the layout reads the same for a long and a short.
  Forecast: the anchor price/date, the projected move with its duration and
  landing price/date, and a SUCCESS/MISSED verdict once the window has elapsed.
- **`PrimitiveRenderContext.bars()`**: the pane's primary price series, lazily,
  for a primitive that needs what price actually did rather than just the
  scales. The forecast verdict is the first caller.

### Demo

- **5m / 15m / 30m drew nothing** while 1h and 1d worked. Yahoo caps intraday
  history (~60 days for 5m-90m, ~730 for 1h) and answers an over-long request
  with an *empty* frame rather than an error, so the default 1y range silently
  produced no bars. The range is now clamped to what the interval can serve,
  the range menu only offers those, and the status line says when it clamped.
- The yfinance dev server sends `Cache-Control: no-store`. The browser keeps ES
  modules in its own module map, so rebuilding the library and reloading still
  ran the previous bundle with no sign anything was stale.

## 1.0.12

A fix for the forming candle rendering as two overlapping candles of opposite
colour during live ticks, and `version()` catching up with the package version.
534 unit tests.

### Fixed

- **The forming candle could render as two overlapping candles of opposite
  colour**: a red body with a green one painted over it, and a wick spanning
  both, while live ticks came in.

  `setData` sorted its input by time but never de-duplicated it, while the
  shared time axis collapses times through a `Set`. Two bars at the same time
  therefore resolved to the same logical index, so `visibleBars` handed the
  renderer both and they drew at the same x, the second over the first. A live
  feed produces that pair whenever its candle builder starts unseeded: it opens
  a fresh bar for the bucket the fetched history already ends in, and the host
  appends it alongside the historical one. Reconnecting mid-bar does it again.

  `setData` now collapses repeated times, keeping the last occurrence, the
  newer value when a live bar arrives alongside the historical bar it
  supersedes. `prependData` and `update` already de-duplicated.

  Seed your candle builder from the last historical bar
  (`builder.seed(bars[bars.length - 1])`) so the live bar continues it: an
  unseeded builder still opens at the first tick price it sees rather than the
  bucket's true open.

- **`VERSION` / `version()` reported `1.0.8`**: the constant is hand-maintained
  and was missed by the 1.0.9, 1.0.10 and 1.0.11 bumps. It now matches
  `package.json` again.

## 1.0.11

16 more drawing tools, rail flyout menus, and the fix for a blank
region that could appear under the chart and persist across reloads.
532 unit tests.

### Added

- **16 more drawing tools**, taking the built-in set from 18 to 34 (draw tier
  6.6 KB -> 8.3 KB Brotli).

  Shapes: `circle`, `triangle`. Paths: `polyline`, `arc`, `curve`. Channels:
  `fib-channel`. Fibonacci: `fib-time-zone`, `fib-fan`. Gann: `gann-fan`,
  `gann-box`. Forecasting: `forecast`. Measurers: `price-range`, `date-range`.
  Arrows: `arrow-up`, `arrow-down`. Brushes: `highlighter`.

  `circle` measures its radius in pixels, so it stays round on screen rather
  than becoming the ellipse differing axis scales would otherwise produce. `arc`
  passes *through* its middle anchor while `curve` treats that anchor as a
  control handle. The measurers all take their bar count from logical indices,
  so it matches the gapless axis rather than raw elapsed time.

- **Rail flyout menus in the yfinance demo.** Rail groups now open a sectioned
  list of their tools, the pattern professional terminals use, instead of cycling tools
  on repeat clicks, which was undiscoverable past two. The button re-activates
  the last tool picked; the caret opens the list. Icons were redrawn on a 24x24
  grid with a thinner stroke and outlined endpoint handles.

- **Right-click drawing actions in the yfinance demo**: "Delete Drawing" for
  the selected one and "Remove All Drawings (n)" for the lot. Both rows hide
  when there is nothing to act on, so the menu never offers a dead option.

- `pane.primitives()`, matching the existing `pane.series()`.

### Fixed

- **A large blank region could appear under the chart, and persist across
  reloads.** Three faults compounded.

  `removeIndicator` did not prune the pane it had just emptied, that logic sat
  in the pane legend's close handler, so the on-chart X cleaned up but a host
  removing the same indicator from its own UI (a toolbar chip, a menu) left an
  empty pane behind. An empty pane still claims its weight and still draws a
  default 0..100 price axis, which is the blank region plus the second set of
  axis labels under the price ticks. The pruning now lives in
  `removeIndicator`, so every caller behaves the same.

  `getState` then persisted that orphan, and `restoreState` faithfully rebuilt
  it, so once it happened it survived every reload. `restoreState` now drops
  panes that end up with no series.

  `maximizePane` parks the other panes at a `0.001` placeholder and snapshots
  the real weights by index, but `removePane` never spliced that snapshot, so
  un-maximizing restored weights against a shifted array and could strand panes
  at the placeholder. `removePane` now keeps it aligned.

- **The yfinance demo rendered a white chart inside dark chrome.** It never
  passed a theme, and the library default is the light palette (since
  `275ee1e`). It now asks for `darkTheme` explicitly.

- The drawing-tools doc had a blank line splitting its style table, which broke
  the last three rows out of the table in the rendered page.

## 1.0.10

Market Profile brought up to a full TPO implementation, row height became a
setting rather than a side effect of tick size, and the chart gained
hover-revealed zoom controls. 518 unit tests.

### Added

- **Time navigator**: the zoom / step controls that live just above the time
  axis. Invisible until the pointer nears the bottom of the chart, then faded in
  over `fadeSeconds`: `-` `+` to zoom, `‹` `›` to step exactly one bar.

  The buttons run the *same* commands the keyboard does (`_runShortcut`), so the
  two paths cannot drift apart, and each tooltip reads its combo from the live
  keymap, rebind `zoomIn` and the tooltip follows. On by default; pass
  `timeNavigator: false` to drop it, or an options object to restyle. It rides
  the bottom pane and follows when panes are added or removed, and hit-tests to
  nothing while hidden so it never steals a click from the chart underneath.

  Reveal is driven by pointer position rather than `rc.hoverId` on purpose: hover
  ids come from `bestHit`, so a drawing or an order line near the bottom of the
  chart would win the hit and silently hide the controls.

  New commands `panLeftBar` / `panRightBar` (one bar, unbound by default) and a
  public `pane.primitives()` accessor, matching the existing `pane.series()`.

- **Controllable TPO / footprint row height.** Row height is now
  `tickSize * rowTicks` instead of being pinned to the instrument tick. The
  multiplier is the one a trader already thinks in: Nifty trades in 0.1 and you
  want 2-point rows, so `rowTicks` is `2 / 0.1 = 20`. `rowTicksFor(2, 0.1)` does
  the division. Keeping the two separate matters, the tick is what imbalance and
  single-print logic count on, so widening rows must not mean lying about it.

  The same multiplier reaches order flow: `computeFootprint(t, trades, 0.1, 20)`
  and `new FootprintAggregator(tf, 0.1, 20)`, so a chart's bricks and its profile
  rows can share one grid.

- **Letters degrade to bricks automatically.** A TPO row is only as tall as the
  price scale makes it, so at some zoom a letter stops fitting. `blockDisplay:
  'auto'` (the new default) crossfades: the block is always drawn and the letter
  fades in over `letterFade` px above `minLetterHeight`, so zooming through the
  threshold reads as one continuous change instead of a jump. `'letters'`,
  `'blocks'` and `'blocks+letters'` pin the choice. The footprint fades its cell
  numbers the same way via `textFade`, replacing a hard on/off cutoff.

- **Market Profile analytics.** Per-period detail (`periodDetail`), the
  developing POC / value-area track, day type (normal / normal-variation / trend
  / double-distribution / neutral), open type (drive / test-drive /
  rejection-reverse / auction), range extension beyond the initial balance,
  buying and selling tails (`tailEdges`), volume POC, and `nakedLevels()` for
  prior POC / VAH / VAL no later session traded back through.

- **Session windows.** `window` drops bars outside a trading session and anchors
  period `A` to the window's open rather than to whatever bar arrived first, 
  which otherwise shifted every letter. Windows crossing midnight are treated as
  one session instead of two halves. Built-ins in `TRADING_HOURS`: `all-hours`,
  `india`, `asia`, `london`, `new-york`, `us-regular`. `compositeSessions` merges
  N consecutive sessions into a rolling composite.

- **Renderer options** to match: `colorMode` gains `period` (one hue per TPO
  period, now the default) alongside `valueArea` / `count` / `volume` / `uniform`;
  plus `split` period columns, `showTpoCounts`, `showTails`, `showPoorHighLow`,
  `showNakedLevels`, `showDevelopingPoc` / `showDevelopingVa`, `showDayType` /
  `showOpenType` / `showSessionLabel`, `outsideVaOpacity`, `profileSpacing`,
  `volumeProfileSide` and `showVolumeValues`. `hitTest` / `hoverAt` map a pointer
  back to the session and row for a host-drawn tooltip.

### Fixed

- **The docs Market Profile example rendered a histogram, not a market profile.**
  The "Market Profile (TPO)" section used `computeTpo` + `HorizontalProfile`, a
  volume-profile-shaped bar chart with no letters at all, even though the
  `MarketProfile` letter renderer already existed. It now uses
  `computeMarketProfile` + `MarketProfile`, and `examples/market-profile` was
  rebuilt around the real primitive with a live row-size slider.

### Changed

- `MarketProfile`'s `showLetters` boolean is replaced by `blockDisplay`
  (`showLetters: false` becomes `blockDisplay: 'blocks'`).
- The profile tier's size budget moves from 8 KB to 11 KB (now 10.12 KB
  brotlied) to cover the analytics above. The base engine moves from 34 KB to
  35 KB for the time navigator (418 B).

## 1.0.9

Order-flow overhaul, drag-to-draw, shape text, and a price-axis density fix.
492 unit tests.

### Added

- **Footprint rewritten** (`src/profile/footprint-primitive.ts`). Cells now fill
  proportionally to volume instead of being outlined, so a column reads as a heat
  ladder; imbalanced cells fill *saturated* rather than gaining a border, and runs
  of consecutive same-side imbalances get a bracket down the edge.

  New options: `displayMode` (`bidask` | `delta` | `volume`), `statsRows`, a
  per-bar table of `volume` / `delta` / `deltaPct` / `cvd` / `trades`, each cell
  tinted by its own strength, plus `stackedImbalances`, `showPoc`, `showCandle`,
  `widthFactor`, `radius`, and `minTextHeight`. Column width derives from the
  chart's bar spacing unless `cellWidth` pins it, and rows shorter than
  `minTextHeight` drop their numbers and degrade to a pure heatmap, so zooming
  out never turns into unreadable overlap.

  `setOptions()` merges and repaints for live restyling; `hitTest()` and
  `hoverAt()` map a pointer back to the bar and price row so a host can build a
  tooltip without the library owning any DOM. `autoscaleInfo()` now returns a
  range, so the footprint drives the pane's scale.

- **Shape text.** `DrawingStyle` gains `fontColor`, `textVAlign`, and
  `textPosition`; rectangles, ellipses, and parallel channels now render a
  `style.text` label, one shape with two colours (`color` strokes the outline,
  `fontColor` paints the label). `textPosition: 'inside'` with
  `textVAlign` x `textAlign` gives the nine placements a shape-text
  panel exposes; `'outside'` parks the block above the shape.

- **Live order-flow demo** (`examples/orderflow/index.html`). Synthetic classified
  ticks stream into a `FootprintAggregator` and the forming bar updates in place, 
  the same path a live WebSocket trade feed takes. Speed, timeframe, display mode,
  imbalance ratio, stacked toggle, and stats toggle are all wired to `setOptions`,
  with a hover inspector fed by `hoverAt`.

### Fixed

- **Drawing a rectangle by dragging placed nothing and scrolled the chart.**
  Press-drag-release is how every charting UI lays down a two-point shape, but the
  chart only emitted a `click` when the pointer had *not* moved, so the gesture
  produced no anchors, while the pan path consumed it and scrolled the view out
  from under the user. Click-click still worked, which is why it went unnoticed.

  New `chart.setPlacementMode(active)`: while a host is placing something, a press
  no longer pans, and a press-drag-release is reported as two `click` events, the
  press point, then the release point tagged `viaDrag`. `DrawingController` arms
  and releases this with the active tool, so every two-point tool (rectangle,
  ellipse, trend line, channel, fib, position) gains drag-to-draw with no API
  change. Single-anchor tools ignore the release half, so dragging with `text`
  armed no longer drops a second box where you let go.

- **The price axis produced about half the tick labels it was asked for.**
  `niceTicks` rounded the span up to a nice number and *then* divided to get the
  step, rounding twice. A 10.5-point range became 20, giving a step of 5 and
  three labels where six were requested; on a footprint autoscaled to ~15 points
  around 65000 the axis was nearly bare.

  The step now comes from the raw span. Because `niceNum(x, true)` snaps to the
  *nearest* nice value it can undershoot and overshoot `maxTicks`, so the result
  is clamped up the 1, 2, 2.5, 5, 10 ladder until it fits. The 2.5 rung, 
  already promised by `niceNum`'s own docstring but missing from its
  implementation, is what keeps a 15-point range from collapsing from 8 labels
  straight to 3.

### Changed

- `Footprint.hoverAt(x, y, rc?)`: `rc` is now optional and defaults to the
  context of the last paint, so a crosshair handler can call `hoverAt(p.x, p.y)`
  instead of fabricating a `PrimitiveRenderContext` out of chart internals.

- Docs demos follow the site theme. `RunnableExample` wraps `createChart` to pass
  the resolved light/dark palette, since the library default is the light one and
  every example was rendering a white panel into a dark page.

## 1.0.8

Two new lazy tiers (**indicators** and **drawing tools**) plus the registries,
state, and pane chrome they need. Base engine ~32.7 KB Brotli, full package
~58 KB across all six tiers, 468 unit tests.

### Fixed

- **Lazy tiers could not register into the base bundle's registries.** Each tier
  is its own rollup bundle with nothing marked external, so a deep import like
  `../model/chart-type-registry` was *inlined*, giving the tier a second,
  private copy of the registry `Map`. The documented usage
  (`import 'openalgo-charts/transform'` then `chart.addSeries('point-figure')`)
  therefore threw `series type "point-figure" needs the transform tier` even
  though the tier was loaded. Only `src/all.ts`, built for the docs site, 
  happened to work, because it puts everything in one module instance.

  Tiers now import shared runtime state from the package entry
  (`import { registerChartType } from 'openalgo-charts'`), which is external for
  tier builds, so every bundle references one registry instead of inlining its
  own. Duplicated *pure* helpers across tiers were only ever a size cost, and
  removing the inlined registry shrank the transform tier from 4.6 KB to
  2.7 KB Brotli.

- **A `setPointerCapture` throw aborted the rest of `pointerdown`.** Chrome
  throws `NotFoundError` when the pointer id is not currently active, and the
  call was only optional-chained, which guards against the method being
  *absent*, not against it throwing. Anything armed after it silently never
  happened: the pane-divider grab, the price/time axis-drag arm, and the
  order-line drag arm. Both capture calls are now wrapped; capture is an
  optimisation, never fatal.
- **Pane hit-testing could be offset from what was drawn.** `_relayout` gave each
  pane a flex *ratio* (`flex: w 1 0`) while sizing its canvas from the chart's
  own `this._height`, so the browser distributed the container's real height and
  the model used a possibly-stale one. Any drift between the two shifted every
  hit-test away from the pixels: pane boundaries, legend buttons, and crosshair
  mapping all landed elsewhere. Panes now get the same pixel height the canvas
  is sized to, making layout == hit-test by construction.
- **Point & Figure no longer emits a phantom first column.** When the first move
  after the anchor bar was *down*, the direction was still `0`, so the reversal
  branch fired while the column's top and bottom boxes were equal, emitting a
  zero-height column that the renderer drew as a blank slot at the start of
  every down-opening chart. Direction is now established without emitting a
  column, and `flush()` returns nothing until a real column exists.
- **P&F columns are built from the bar range, not just the close.** The new
  `method` option defaults to `'hl'` (the standard construction): a bar's high
  extends an X column and its low extends an O column. A bar that swung through
  several boxes intrabar but closed flat used to produce no boxes at all. Pass
  `method: 'close'` for the previous close-only behaviour.
- **The P&F renderer walks integer box indices** instead of accumulating
  `level += boxSize`. Thirty steps of `0.05` land on `101.49999999999991`, which
  duplicated the top glyph of tall columns. Glyph rows outside the plot are now
  culled, and a per-column glyph cap keeps a pathological box size from hanging
  a frame.

### Added

- **`openalgo-charts/draw`, a new lazy tier (6.3 KB Brotli)** with 18 drawing
  tools and a headless `DrawingController`: trend line, ray, extended line,
  arrow, horizontal line/ray, vertical line, cross line, rectangle, ellipse,
  parallel channel, fib retracement/extension, long/short position, measure,
  text, and path. The controller runs placement (with a live preview), selection,
  whole-shape and per-anchor dragging, magnet snap to O/H/L/C, undo/redo, and
  serialisation, and ships **no UI**, so a host wires its own toolbar.
  `registerDrawingTool` makes a custom tool first-class, exactly like a chart
  type or an indicator.
- **Drawing anchors live in data space** (`{ time, price }`), never pixels. The
  time axis is gapless, so a pixel anchor would slide the moment a weekend
  collapsed; anchors map through `DataLayer.timeToIndexFloat`, which also
  resolves positions *between* bars and *past the last bar*, where projections
  live. Drawings round-trip through `ChartState.drawings` with no extra plumbing.
- **Full text styling** on the `text` tool: `fontFamily`, `fontWeight`,
  `fontStyle`, `background` + `backgroundColor` + `backgroundOpacity`,
  `border` + `borderColor`, `wrap` + `wrapWidth`, and `textAlign`. Text renders
  multiline, soft-wraps against live font metrics, and hit-tests its **measured**
  box rather than a character-count estimate.
- `PrimitiveHit.draggable`: arm a two-axis drag (drawing anchors and shapes),
  alongside the existing one-axis `cursor: 'ns-resize'` price-line path.
- **`drag` / `drag:end` events**, carrying `fromTime` / `fromPrice` (the grab
  origin) so a consumer's delta measures from the press rather than the first
  move. The `click` event now also fires on empty plot, with position and a null
  `id`: what a tool that *places* something needs.
- **Pane legends with inline controls.** `PaneLegend` draws the terminal-style
  row at a pane's top-left, swatch, name, parameters, and **one reading per
  plot in that plot's own colour** (a single number in a single colour cannot
  say which value belongs to which line of an MA ribbon or MACD), tracking the
  crosshair and falling back to the latest bar on leave, plus inline action
  buttons: show/hide, settings, move pane up/down, maximize, and delete.
  Controls stay hidden until the row is hovered, so a stack of legends reads as
  clean text; the row itself hit-tests (`::row`) to trigger that reveal, and the
  chart swallows those clicks so they never surface as phantom ids.
  Rows stack automatically per pane, a host can add its own (a symbol/OHLC
  header, a volume readout) with `chart.addPrimitive(new PaneLegend(...), pane)`
  and indicator rows flow beneath it; removing one closes the gap. Drawn on the canvas (like `BuySellButtons` and `DomLadder`) so it
  composites into screenshots and costs no DOM per pane, with icons as vector
  strokes rather than text glyphs, which render as emoji on some platforms.
  Every indicator gets one automatically; the first legend on a non-price pane
  also carries the pane-level controls, so extra rows stay uncluttered. The
  chart handles these presses itself, so a host gets them without wiring
  anything. `settings` has no built-in dialog (the engine ships no DOM) so it
  emits `indicatorSettings`; everything needed to *generate* a form is already
  on the descriptor's `inputs`.
- **Pane management:** `setPaneWeight`, `paneWeight`, `movePane`, `maximizePane`,
  `maximizedPane`, and `removePane`, plus **draggable pane dividers**: press
  within 4px of a boundary and drag to redistribute height between the two
  adjacent panes (cursor turns `row-resize`), conserving their combined weight
  so other panes are untouched and neither side can collapse. Removing a pane
  takes its series and indicators with it and re-indexes the panes below;
  pane 0 is pinned. Deleting the last indicator on a pane removes the pane too.
  New events: `paneResized`, `paneMoved`, `paneMaximized`, `paneRemoved`,
  `indicatorRemoved`, `indicatorSettings`.
- **An indicator registry, the sibling of the chart-type registry.** The
  chart-type registry answers *"how do I paint an array of bars"*; this one
  answers *"what do I compute, what does it plot, and what can a user tune"*.
  An `IndicatorDescriptor` is data, not code in the core, the chart never
  switches on an indicator id, and each `plot` names a registered **chart
  type**, so indicators ride the existing Family-A renderers and add no drawing
  code at all. `registerIndicator` / `getIndicator` / `registeredIndicators` /
  `indicatorDefaults` ship in the base bundle (~1.5 KB); the catalog does not.
- **`chart.addIndicator(id, settings?, { paneIndex? })`**, plus
  `chart.indicators()` and `chart.removeIndicator(instanceId)`. The returned
  `IndicatorApi` handle carries `settings()`, `setSettings(patch)`,
  `series(plotKey)`, `values()`, and `remove()`. The runtime creates one series
  per plot, places `'onchart'` indicators on the price pane and `'pane'`
  indicators on a new one, draws declared reference levels, applies a declared
  fixed range (RSI 0..100), recomputes on every source-data change, and tears
  everything down on `remove()` / `destroy()`. Indicator plots never claim the
  primary price series, so they can be added before any candles exist without
  hijacking the magnet crosshair and OHLC legend.
- **`openalgo-charts/indicators`, a new lazy tier (4.5 KB Brotli)** with 18
  Tier-1 built-ins: SMA, EMA, WMA, VWAP, Bollinger Bands, Supertrend, Parabolic
  SAR, Ichimoku Cloud, RSI, MACD, Stochastic, ADX/DMI, CCI, MFI, ATR, Volume,
  OBV, and A/D. Importing the tier registers all of them.
- **The Tier-2 contract** (`createTier2Indicator`) for indicators whose data is
  *not* derived from the chart's OHLCV, open interest, CVD, PCR, any external
  feed. It wraps a `fetch` / `subscribe` / `refetchOn` lifecycle into an ordinary
  descriptor, so the runtime, settings, panes, and removal all work identically;
  there is no second runtime. External points are projected onto the bar
  timeline by last-known-value, the most recent point *at or before* each bar,
  never interpolated and never forward-looking, and a failed fetch leaves the
  previous data on screen rather than blanking the pane.
- `IndicatorDescriptor.calcTail`: an optional incremental path so a live tick
  does not cost a full recompute. Return values for `[fromIndex, bars.length)`
  and the runtime splices them onto the previous result; return `null` to fall
  back to `calc`.
- **`chart.getState()` / `chart.restoreState(state)`**: a JSON-safe snapshot of
  the viewport, grid, crosshair mode, pane weights, per-pane price scales, and
  indicator instances, plus an opaque `drawings` slot the drawing tier owns and
  the base engine round-trips. The contract is that the chart serialises what
  the chart owns: series **data** is the app's, so `restoreState` never
  recreates series, it returns a `RestoreReport` listing the descriptors it saw
  so the app can rebuild them from its own feed and re-apply the saved styling.
  Restore is idempotent (indicators are replaced, not appended), a state from a
  newer `CHART_STATE_VERSION` is rejected rather than half-applied, and an
  indicator whose tier is not loaded is skipped rather than thrown.
- **`chart.subscribeDrag` now passes `time` alongside `price`**, so a two-axis
  drag (a trendline endpoint, a forward projection) has a usable time even where
  the gapless axis has no bar. Existing price-only callbacks are unaffected.
- **`chart.timeToCoordinate(time)` / `chart.coordinateToTime(x)`**, backed by
  new `DataLayer.indexToTimeFloat` / `timeToIndexFloat`. `indexToTime` only
  answers for indices that have a bar; anchoring to an arbitrary x needs a time
  *between* bars too, which the gapless axis (§5.3) makes the common case,
  since everything a weekend or session break collapsed lands there, and past
  the right edge, where projections live.
- `SeriesStyle.markersOnly`: draw a line series' markers with no connecting
  stroke (Parabolic SAR, scatter plots).
- `DataLayer.seriesBars(id)`: a series' bars with no per-call allocation, the
  read path for anything recomputing over full history.

- **P&F box-size modes.** `mode: 'fixed' | 'percent' | 'atr'`, `'percent'`
  sizes the box at `price × percent / 100` and `'atr'` at
  `ATR(atrPeriod) × atrMultiplier` (Wilder), both re-resolved each time a column
  opens, so the grid tracks price level and volatility.
- **Columns carry their own geometry.** `PointFigureColumn` extends `Bar` with
  `boxSize` and `boxes`, and the renderer reads the box size from the column.
  `style: { boxSize }` is no longer needed, which removes the footgun where the
  transform and the style could disagree and silently desync the glyph stack, 
  and is the only way variable-box modes can render correctly. `style.boxSize`
  remains as a fallback for hand-built column data; failing that the renderer
  infers the box from the shortest column in view.
- A column's `high` is now the **exclusive top edge** of its highest box, so
  `[low, high)` is exactly the span the glyphs occupy and
  `boxes === (high - low) / boxSize`. The stack previously drew one glyph short.

## 1.0.7

### Fixed
- A right-click on the chart no longer replays the previous left-click. Only the
  primary button starts a gesture in `_onPointerDown` (a right-click's
  `pointerdown` is ignored so the chart never pans with no button held), but the
  matching `pointerup` was unguarded, so a right-click's `pointerup` fell through
  to the click branch and re-hit-tested at the *stale* down-position from the last
  left-click, re-firing `subscribeClick`. With `BuySellButtons` (1.0.6) that meant
  the first right-click after buying/selling silently placed a second, duplicate
  order. `pointerup` now applies the same primary-button guard as `pointerdown`
  (touch/pen unaffected; the internal drag-recovery path is preserved).

## 1.0.6

### Added
- `BuySellButtons`, an inline trade panel drawn on the chart
  (a `SELL` button, a quantity chip, and a `BUY` button, docked to a corner and
  fixed while the chart pans/zooms). Clicks hit-test to `${id}:sell` /
  `${id}:buy` / `${id}:qty`, routed through `chart.subscribeClick`, so the app
  places the order. Prices update cheaply per tick via `setPrices(bid, ask)` /
  `setMark(price)`; `setQty()` and `setColors()` restyle at runtime. Configurable
  `position`, `margin`, labels, colors, and `showPrices`. Add it with
  `chart.addPrimitive(new BuySellButtons({ ... }))`. Base-tier export.
  (Base engine limit raised to 28 KB / 34.5 KB Brotli.)

## 1.0.5

### Fixed
- The browser's native right-click **"Save image as…"** now saves the visible
  chart instead of a blank image. The chart renders as stacked canvases and the
  browser captures only the topmost (transparent overlay) layer, so on
  `contextmenu` the clicked pane's base layer is composited beneath its overlay
  and overlay repaints are frozen while the menu is open (live ticks used to
  wipe the snapshot); rendering resumes on the next pointer/wheel/key input.
  Apps that present their own context menu (`preventDefault`) are unaffected.
  The native save captures the clicked pane only, `downloadScreenshot()`
  remains the full multi-pane export.

## 1.0.4

Trading-UI beautification: the order-placement surfaces (order / position /
bracket lines, DOM ladder) get a modern, theme-aware visual pass plus real
interaction feedback, and order lines go event-driven via OpenAlgo's
`subscribe_orders` WebSocket stream. 334 unit tests; base engine ~26.4 KB
Brotli (size limits raised to 27 / 33.5 KB for the visual-state rendering and
the order-update stream).

### Added
- Hover + dragging visual states for interactive price lines: hovering a
  draggable order line thickens it and brightens its pill, the cancel button
  fills solid on hover, and a dragged line gets a soft emphasis halo. The chart
  now applies primitive cursor hints (`ns-resize` over draggable lines,
  `pointer` over cancel/close/ladder rows) to the container and emits a new
  `hover` event (`chart.on('hover', ({ id }) => ...)`) on primitive enter/leave.
- Drag ghost: `PriceLine.setDragGhost(price | null)` draws a dimmed reference
  line at the pre-drag price while modifying an order. `chart.trading` wires it
  automatically; the live example wires it for the raw drag path.
- Broker-style segmented pill groups on order/position lines, 
  `[badge][qty][label][x]`: a solid colored badge (`BUY` / `SELL` / `TP` /
  `SL` / `LONG` / `SHORT`), boxed qty and info segments, and an integrated
  cancel `x` (still routes as `<id>::close`). New `PriceLineOptions.badge` and
  `qty` fields; text auto-contrasts against fills (`contrastText`), so every
  theme stays legible.
- `WorkingOrderLine` shows fill progress (`3/10`) once partially filled, dims
  pending (un-acked) orders until the broker confirms, and gains a close (x) segment
  (`order:<id>::close`) plus a compact price-only axis tag.
- `PositionMarker` renders the segmented group with live P&L (₹ and %) colored
  by sign, a close (x) segment (`position:<symbol>::close`), and highlights on hover.
- `BracketGroup` chips now include prices (`SL 2,850.00`, `TP 3,000.00`), the
  R:R chip is theme-aware, risk/reward zones derive from `theme.loss`/`profit`,
  and SL/TP lines thicken on hover/drag.
- `DomLadder` is fully theme-aware (heat colors from `theme.buy`/`sell`, qty
  text auto-contrasts with the background), gains a docked-edge separator and a
  hovered-row outline as a click-to-trade affordance.
- New shared render helpers (`src/render/pill.ts`): `parseColor`, `luminance`,
  `contrastText`, `withAlpha`, `shade`, `roundRectPath`, `drawPill`, `drawGrip`.

- Real-time order updates: `OpenAlgoWsFeed.subscribeOrders()` /
  `onOrderUpdate(cb)` speak OpenAlgo's account-level `subscribe_orders` stream
  (fills, partial fills, rejections, cancellations, live broker or analyze
  sandbox), with automatic replay on reconnect. New pure helpers
  `formatSubscribeOrders`, `formatUnsubscribeOrders`, `parseOrderUpdate`, and
  `mapOrderStatus`. The live example updates order lines from this stream and
  keeps a slow poll only for reconciliation.
- `chart.downloadScreenshot(filename?)`: public PNG export of the full
  composited chart (all panes + overlays); the screenshot shortcut now routes
  through it. The browser's native right-click "Save image as…" only captures
  the transparent overlay layer.

### Fixed
- Right-click no longer arms the pan state: a context-menu click used to leave
  the chart "sticky-dragging" (its `pointerup` is swallowed by the menu). Only
  the primary button starts a pan / line-drag, and a missed `pointerup` is now
  recovered on the next move.
- Live example: Renko / Range / Line Break / Kagi / P&F no longer render with
  time gaps between elements, the volume pane is re-bucketed onto the
  transformed element times instead of re-adding every raw timestamp to the
  shared axis (documented in Transforms).
- `OpenAlgoTradeFeed` errors now include OpenAlgo's own message (e.g. "MIS
  orders cannot be placed after square-off time…") instead of a bare HTTP
  status code.
- The crosshair is hidden while dragging an order line, the frozen crosshair
  at the grab point used to read as a phantom second line.
- The series last-price line no longer strikes through order/position pill
  groups (it now draws beneath trading primitives).
- WS `trigger pending` (with a space) order status now maps to `working`.

### Changed
- `PrimitiveRenderContext` gains optional `hoverId` / `dragId` fields (custom
  primitives can render their own hover/active states).
- Trade-fill bubble/count markers use auto-contrast text instead of fixed white.
- Trade-tier `WorkingOrderLine` / `PositionMarker` default to a half-width line
  (`extentFromRight` constructor option), matching the partial-width order
  lines of the parity API.

## 1.0.3

Cosmetic parity to close the last visual gaps for a migration off another engine.
318 unit tests; base engine ~24.8 KB Brotli.

### Added
- `SeriesStyle.priceLineVisible` and `lastValueVisible` toggle the dashed last-price
  line and the axis value tag per series; `SeriesStyle.title` carries a label for
  host-drawn legends. The last-price line/tag now follow the first right-scale price
  series (the main series) rather than whichever was added last.
- Crosshair styling via the theme: `crosshairStyle` (`solid` | `dashed` | `dotted`),
  `crosshairWidth`, `crosshairLabelBackground`, and `crosshairLabelVisible`.
- `timeFormatter` receives an optional `tickMarkType` hint
  (`year` | `month` | `day` | `time` | `timeWithSeconds`) so a host can render adaptive
  axis labels (year at year boundaries, month at month, day otherwise). New exported
  type `TickMarkType`.

## 1.0.2

Drop-in parity work so a host app can back every chart with this engine. Base
engine ~24.7 KB Brotli; 314 unit tests (40 files).

### Added
- Left / right / overlay price scales: `addSeries(type, { priceScaleId: 'right' | 'left' | '' })`.
  `'left'`/`'right'` draw independent, independently-autoscaled axes; `''` is a hidden
  overlay scale (volume-in-price-pane). `series.priceScale()` exposes the scale so
  `.setOptions({ marginTop, marginBottom })` can pin a volume histogram to the bottom.
- Mutable series handle: `series.applyOptions(partialStyle)`, `series.remove()`, and
  `SeriesStyle.visible` (hidden series are excluded from autoscale).
- Viewport preservation: `timeScale.setVisibleLogicalRange()` / `getVisibleLogicalRange()`
  and `chart.fitContent()` (no-arg), keep the user's zoom across a full-history reload.
- Per-series `priceFormat` (`price` / `volume` / `custom`), applied to the series' scale;
  `compactVolume` helper.
- Dashed / dotted line series via `SeriesStyle.lineStyle`.
- Runtime `chart.applyOptions()` / `chart.setTheme()` (theme, grid, formatters, crosshair
  mode) without recreating the chart; theme `axisFontSize`, `gridStyle`, transparent `background`.

### Fixed
- `RenderLoop` no longer stalls after the first frame under a synchronous scheduler.

## 1.0.1

Full package ~38 KB Brotli (all tiers), base engine ~24 KB, zero runtime
dependencies, Apache-2.0.

### Added
- Unified event bus: `chart.on` / `off` / `once` (`crosshair:move`, `click`,
  `pan`, `zoom`, `resize`, `lazy-load`, `ready`), with `trading:*` mirrored through it.
- Data-driven trading visualization (`chart.trading`): position/order pills,
  TP/SL brackets, and fill markers (chevron / bubble / count).
- Custom formatting: `ChartOptions.priceFormatter` and `timeFormatter` (with
  runtime setters); per-pane `priceScale` options; the time axis is no longer IST-only.
- Flexible series input: `setData` accepts `Bar | LinePoint | Whitespace`
  (normalized via `toBar`); `series.getData()` reads the current bars.
- WebSocket auto-reconnect (backoff + re-auth + resubscribe); `OpenAlgoLiveDataFeed`
  bare `D`/`W` intervals, day-delta volume, and symbol+exchange tick filtering;
  `FakeDataFeed` streams deterministic bars through an injectable scheduler.
- Docs site: an interactive example gallery (chart type, themes, tooltips, event
  markers, live streaming, "Get this chart" code toggle) plus framework-integration,
  mobile, data-loading, events, types, constants, and glossary pages; redesigned
  yfinance and live OpenAlgo example apps.

### Fixed
- Multi-series `DataLayer.update`: a series-local append that is not the global
  newest no longer corrupts the shared time-axis order.
- Package now ships `NOTICE` (Apache-2.0); the accessible summary refreshes on
  live updates; `visibleBars` uses binary search for large datasets.
- Docs accuracy: real `SeriesApi`, `subscribeBars`, indicator return types, and
  interval/size/test-count figures.

### Quality
- 297 unit tests (39 files) + a Playwright real-browser smoke suite. GitHub
  Actions CI runs typecheck, unit, build, size budgets, a docs-site build, a
  `NOTICE` pack check, and the E2E smoke on every push/PR. Warning-free TypeDoc.

## 1.0.0

First public release. Full package ~29 KB Brotli (all tiers), zero runtime
dependencies, Apache-2.0.

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
- Footprint primitive upgraded: volume-graded bid x ask cells, diagonal-imbalance
  boxes, POC marker, per-bar delta/volume footer.
- Live feed: composed REST + WebSocket + candle-builder data feed; WS adapter
  speaks the documented OpenAlgo protocol (authenticate -> numeric-mode subscribe ->
  `market_data`), with connection/control callbacks.
- Examples: yfinance, order-flow, market-profile (TPO), and a full LIVE OpenAlgo
  demo (history + WebSocket + chart trading) - validated against a live instance.

### Fixed
- `OpenAlgoDataFeed`/`OpenAlgoTradeFeed`: bind the global `fetch` (browser
  "Illegal invocation").
- WebSocket subscribe schema corrected to the documented per-symbol numeric-mode
  protocol.
- `modifyorder` sends the required `disclosed_quantity`.
- `mapOrder`: `trigger_price: 0` -> `undefined` so LIMIT order lines render at the
  price, not 0.

### Quality
- 223 unit tests + a Playwright real-browser smoke suite; GitHub Actions CI runs
  typecheck, unit, build, size budgets, and the E2E smoke on every push/PR.

## 0.1.0 (initial development build)

First end-to-end build of the engine. Dependency-free, ~22 KB Brotli for the
full package (all tiers).

### Engine (base tier)
- HiDPI canvas layout (base + top canvas per pane), render loop, per-pane
  invalidation mask, resize handling.
- Shared DataLayer (merge-by-time -> logical indices) keeping all panes aligned;
  gapless time axis (weekends/holidays/session breaks collapse).
- Time scale (index<->x, pan, cursor-anchored zoom, kinetic flick, fit-content)
  and price scale (linear, autoscale, tick-size formatting/snap).
- Internal time = UTC seconds; IST/epoch conversion at the feed edge.
- Live candle builder (session-aligned bucketing, ltq-sum vs cumulative-day
  volume, late-tick policy, history->live seam) + last-price line.
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
- Depth-of-market ladder: depth-agnostic (5 to 200 levels), virtualized,
  price-bucket aggregation, size heatmap, click-to-place, graceful degradation.

### Profile tier
- Volume Profile (POC + value area), Market Profile / TPO (+ initial balance),
  Footprint (bid/ask delta + imbalance), order flow (cumulative delta + stacked
  imbalance). Footprint/order flow require classified trade data.

### Tooling
- TypeScript, Rollup multi-entry build, `size-limit` (Brotli) budgets per tier,
  154 unit tests (incl. a recording-canvas harness for renderers).
