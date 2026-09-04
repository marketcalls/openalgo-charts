# Drawing Tools

*When to read this: you are adding chart annotations (trendlines, fibs, shapes, text) wiring a drawing toolbar, persisting drawings, or registering a custom tool.*

Source of truth: `src/draw/types.ts`, `src/draw/tools.ts`, `src/draw/controller.ts`, `src/draw/layer.ts`, `src/draw/geometry.ts`, `src/draw/index.ts`.

## Setup

```ts
import { createChart } from 'openalgo-charts';
import { DrawingController } from 'openalgo-charts/draw';

const chart = createChart(el);
chart.addSeries('candlestick').setData(bars);

const draw = new DrawingController(chart, { magnet: 'weak' });   // or 'strong', 'off'; true means 'strong'
draw.setTool('trend-line');   // the next two clicks place it
```

Importing `openalgo-charts/draw` calls `registerBuiltinDrawingTools()` as a side effect, registering all 51 tools into the base bundle's registry. No separate registration call is needed.

**The controller is headless: it ships no toolbar, no dialogs, no key listener.** It owns the model (`Drawing[]`), placement, selection, dragging, undo, and serialisation. Every button, flyout, colour picker, and text prompt is the host's.

`DrawingController` takes a structural `DrawingChartHost`, not the `Chart` class, so the chart from `createChart()` is accepted with no cast (`src/draw/controller.ts:33`).

## The model

```ts
interface Drawing {
  id: string;
  tool: string;              // a registered tool id
  points: DrawingPoint[];    // { time: UTC seconds, price: number, pressure? }
  style: DrawingStyle;
  text?: DrawingText;        // the label, or for the text tool the whole content
  props?: Record<string, unknown>;   // per-tool extras, JSON-safe, persisted verbatim
  paneIndex: number;
  locked?: boolean;          // renders, but cannot be selected or dragged
  visible?: boolean;         // default true
  zIndex: number;            // paint order; below 0 paints under the series. add() fills in 0
  createdAt?: number;        // epoch ms, set by add()
}

interface DrawingStyle {
  color?: string; lineWidth?: number; lineStyle?: 'solid' | 'dashed' | 'dotted';
  fill?: boolean; fillColor?: string; fillOpacity?: number;      // default 0.12
  extendLeft?: boolean; extendRight?: boolean;
  showLabels?: boolean;                                           // level / price / ratio labels where the tool has them
  levels?: FibLevel[];                                            // fib and gann family; defaults per tool
  accountSize?: number; risk?: number;                            // position tools
  showStats?: boolean;                                            // line family: midpoint readout
  pressure?: boolean;                                             // brush: pen pressure drives the width
}

interface DrawingText {
  value: string;                                                  // `\n` starts a new line
  color?: string;                                                 // falls back to style.color
  fontSize?: number; fontFamily?: string;                         // media px (default 12); UI sans stack
  bold?: boolean; italic?: boolean;
  align?: 'left' | 'center' | 'right';                            // default 'left'
  valign?: 'top' | 'middle' | 'bottom';                           // default 'top'
  wrap?: boolean; wrapWidth?: number;                             // default 220 media px
  background?: boolean; backgroundColor?: string; backgroundOpacity?: number;   // plate; opacity default 1
  border?: boolean; borderColor?: string;
  position?: 'inside' | 'outside';                                // shapes only: where the label sits
}

interface FibLevel { ratio: number; color?: string; enabled?: boolean; label?: string; }
```

Unset `color` falls back to `theme.lineColor`, unset `lineWidth` to `1.5`. `style.color` strokes the outline; `text.color` paints an attached label, so one shape carries two colours. `text.position: 'outside'` parks the label above the shape and ignores `valign`. Nothing about text lives on `style`: a 1.9.x `style.text`, `fontColor`, `fontWeight`, `fontStyle`, `textAlign`, `textVAlign` or `textPosition` is a type error in 2.0, and `migrateDrawings` lifts them into `drawing.text` on load. `levels` is a list of `FibLevel` objects, never bare ratios.

## Anchors are `{ time, price }`, never pixels

The time axis is gapless (weekends, holidays, and session breaks collapse) so a pixel anchor would slide the instant the viewport, interval, or dataset changed. Anchors resolve through `DataLayer.timeToIndexFloat`, which is *fractional*, and that has two consequences worth relying on:

- An anchor can sit **inside a collapsed gap** (a Saturday between Friday and Monday) and still map to a stable x.
- An anchor can sit **past the last bar**, which is where trend projections, `forecast`, and the position tools' targets live.

Drag deltas are computed in data space too (`p.time - start.from.time`), so translating a shape keeps it on the same bars.

## Annotations

Six one-anchor tools whose job is a human sentence on the chart. They share
plate-and-tail machinery, so what separates them is where the tail leaves the
plate and how the plate is shaped:

| `id` | Shape | Anchored to |
|---|---|---|
| `note` | Pin at the bar, plate up-right, stem between | A bar |
| `balloon` | Speech bubble above, tail pointing down | A bar |
| `comment` | Quieter square box, tail off the bottom left | A bar |
| `signpost` | Vertical post with the plate at the top | **Time**, not price |
| `price-note` | The anchor's price, with text beneath | A level |
| `table` | A grid of cells | A corner |

Two conventions worth knowing:

- **`price-note` reads its price off the anchor** rather than storing one, the
  same as `price-label`. A typed price is a number that was true once, which on
  a chart is worse than no number.
- **`table` encodes its cells in `text.value`**: a newline starts a row, a pipe
  separates columns, and the first row is drawn bold as a header. One editable
  string, so a table needs no new shape in the drawing model and survives
  `getState` unchanged.

Everything else comes from the shared text block, `drawing.text`: `value`,
`fontSize`, `color`, `backgroundColor`, `border`, plus `style.fillOpacity`.

## Icons

The tier ships a glyph for every tool, as path data:

```ts
import { drawingToolIcon, ICON_ATTRS } from 'openalgo-charts/draw';

<svg {...ICON_ATTRS} width={24} height={24}>
  <path d={drawingToolIcon('trend-line')} />
</svg>
```

| Export | |
|---|---|
| `DRAWING_TOOL_ICONS` | `Record<string, string>` of tool id to `d` attribute |
| `drawingToolIcon(id)` | One glyph, or `undefined` when there is none |
| `drawingToolIconIds()` | Every id the set covers |
| `ICON_VIEWBOX` | `'0 0 24 24'` |
| `ICON_STROKE` | `2` |
| `ICON_ATTRS` | The whole attribute bag for the `<svg>` (an `IconAttrs`) |
| `CHROME_ICONS` | `Record<string, string>` of chrome id (undo, redo, lock, trash, magnet, ...) to `d` attribute, on a 16 grid |
| `chromeIcon(id)` / `chromeIconIds()` | One chrome glyph or `undefined`; every chrome id |
| `CHROME_ICON_VIEWBOX` / `CHROME_ICON_STROKE` / `CHROME_ICON_ATTRS` | `'0 0 16 16'`, `1.5`, the attribute bag |
| `CHROME_ICON_FILLED` | The chrome ids painted solid rather than stroked (`chromeIconSvg` consults it; a host wrapping raw path data must too) |
| `iconSvg(id, opts?)` / `chromeIconSvg(id, opts?)` | A complete inline `<svg>` string in `currentColor`; `size` in px or `'1em'` (an `IconSvgOptions`). Throws on an unknown id |
| `iconSprite(ids?)` / `iconUse(id, opts?)` | One hidden symbol sheet (ids `oac-icon-<id>`, `ICON_SYMBOL_PREFIX`) and the per-glyph `<use>`; symbols carry no presentation attributes, so stroke and fill inherit from the frame |
| `toolCursor(id, opts?)` | A CSS `cursor` value carrying the glyph over a contrasting halo; `size` 1..128 (default 20), `hotspot` (default the centre), `color`, `halo`, `fallback` (a `ToolCursorOptions`) |

The path data is data, not DOM: the host still builds its own rail and
flyouts. The string builders derive from that one set, so the rail, a flyout
and the armed cursor cannot drift apart. What the host no longer does is draw
a glyph per tool before it can show a toolbar, which is what every adopter had
to do before, each drifting on weight and grid independently until the set
read as many icons rather than one. Measure the count with
`drawingToolIconIds().length` before quoting it: the tool set covers more ids
than there are tools (the cursor, the magnet, and glyphs drawn ahead of tools
not yet registered).

**Render at 24px, or an integer multiple.** With a 2-unit stroke on integer
coordinates, an orthogonal edge covers exactly two device pixels at 1:1. At 18px
the 0.75 scale puts it on 1.5 pixels and every edge is anti-aliased across two
rows: that is a host sizing choice and no path data can fix it.

The set is held to one grid by `tests/draw-icons.test.ts`, which checks each
glyph for the live area, whole units, a single weight, complexity and span. A
set of this size cannot be kept consistent by review, and the checks caught two
faults on the first run that reading the paths did not.

## Tool catalogue

51 built-in tools. `Clicks` is what the user does; `Anchors` is what ends up in `drawing.points` (they differ only where `expand` is involved).

| Family | `id` | Clicks | Anchors | Shortcut |
|---|---|---|---|---|
| Lines | `trend-line` | 2 | 2 | `Alt+T` |
| Lines | `ray`, `extended-line`, `arrow` | 2 | 2 | |
| Lines | `horizontal-line`, `horizontal-ray`, `vertical-line`, `cross-line` | 1 | 1 | `Alt+H`, `Alt+J`, `Alt+V`, `Alt+C` |
| Shapes | `rectangle`, `ellipse`, `circle` | 2 | 2 | |
| Shapes | `triangle`, `rotated-rectangle` | 3 | 3 | |
| Paths | `path`, `polyline` | n, double-click to end | n | |
| Paths | `arc`, `curve`, `double-curve` | 3 | 3 | |
| Channels | `parallel-channel`, `fib-channel` | 3 | 3 | |
| Fibonacci | `fib-retracement`, `fib-time-zone`, `fib-fan` | 2 | 2 | |
| Fibonacci | `fib-extension` | 3 | 3 | |
| Gann | `gann-fan`, `gann-box` | 2 | 2 | |
| Cycles | `cyclic-lines`, `time-cycles`, `sine-line` | 2 | 2 | |
| Forecasting | `long-position`, `short-position` | 1 | 3 (via `expand`) | |
| Forecasting | `forecast` | 2 | 2 | |
| Measurers | `measure`, `price-range`, `date-range` | 2 | 2 | |
| Arrows | `arrow-up`, `arrow-down` | 1 | 1 | |
| Text / notes | `text`, `price-label`, `flag-mark` | 1 | 1 | |
| Annotations | `note`, `balloon`, `comment`, `signpost`, `price-note`, `table` | 1 | 1 | |
| Marks | `arrow-up`, `arrow-down`, `arrow-left`, `arrow-right` | 1 | 1 | |
| Text / notes | `callout` | 2 | 2 | |
| Brushes | `brush`, `highlighter` | press-drag-release | n samples | |

Those five are the only shortcuts. `registeredDrawingTools()` returns every descriptor (`id`, `name`, `points`, `shortcut`, `defaultStyle`); `BUILTIN_DRAWING_TOOLS` is the same list in toolbar order.

Tool-specific `defaultStyle` values that change behaviour, not just colour:

| Tool | `defaultStyle` |
|---|---|
| `trend-line` / `ray` / `extended-line` / `arrow` | `extendLeft`/`extendRight` = `false,false` / `false,true` / `true,true`; `showStats: true` adds a midpoint readout (price change, percent, bars, angle) |
| `rectangle` / `ellipse` / `circle` / `triangle` / `rotated-rectangle` | `fill: true`; a label comes from `drawing.text` (`align`, `valign`, `position: 'inside' | 'outside'`), 14 px when the block sets no size |
| `fib-retracement` / `fib-extension` / `fib-channel` | `levels: cloneLevels(DEFAULT_FIB)` (ratios 0 to 1 with the conventional colours), `showLabels: true`. The anchor leg is stroked in `style.color`; bands are tinted by the level that closes them unless `fillColor` is set; `extendLeft` / `extendRight` are honoured |
| `fib-fan` / `gann-fan` / `gann-box` / `fib-time-zone` | `levels: cloneLevels(DEFAULT_FIB_FAN / DEFAULT_GANN_FAN / DEFAULT_GANN_BOX / DEFAULT_FIB_TIME_ZONE)` |
| `long-position` / `short-position` | `accountSize: 100000, risk: 1, fillOpacity: 0.13, showLabels: true` |
| `text` / `callout` | `defaultText: { value: 'Text', fontSize: 14 }` / `{ value: 'Note', fontSize: 12 }` (a `DrawingText`, merged under the caller's `text`) |
| `brush` / `highlighter` | `lineWidth: 2` / `lineWidth: 12, fillOpacity: 0.28`; `pressure: true` lets a pen's per-sample `DrawingPoint.pressure` drive the width (off by default, so a mouse stroke is constant) |
| `cyclic-lines` / `forecast` | `lineStyle: 'dashed'` |

`fib-time-zone` uses the Fibonacci **sequence** (`0,1,2,3,5,8,13,21,34,55` bar multiples), not ratios, and its levels carry no colour (they fall back to `style.color`). `gann-fan` levels are price-per-time ratios (`1x1` = 1, `1x2` = 0.5, `2x1` = 2), coloured by `cycleColor(i)` and labelled by `gannLabel`; `gann-box` applies `DEFAULT_GANN_BOX` (0, .25, .382, .5, .618, .75, 1) to both axes plus the 1x1 diagonal. `circle` measures its radius in screen px so it stays round. `arc` passes *through* its middle anchor; `curve` treats it as an off-curve control.

## The 2.0 drawing model

`Drawing` is `{ id, tool, points, style, text?, props?, paneIndex, locked?, visible?, zIndex, createdAt? }`.

- **`text` is its own block (`DrawingText`)**, not a set of keys on `style`: `{ value, color?, fontSize?, fontFamily?, bold?, italic?, align?, valign?, wrap?, wrapWidth?, background?, backgroundColor?, backgroundOpacity?, border?, borderColor?, position? }`. A 1.9.x `style.text` / `fontColor` / `textAlign` / `textVAlign` / `textPosition` / `fontWeight` / `fontStyle` is lifted into it on load and paste. The text tool is its content; a shape's text is a label placed by `position`.
- **`style.levels` is `FibLevel[]`** (`{ ratio, color?, enabled?, label? }`; `enabled: false` hides a rung without forgetting it, `label` prints instead of the ratio), not `number[]`. A bare ratio takes the conventional colour from `levelColor(ratio)` (`LEVEL_NEUTRAL` for 0, 1, 2, 3 and anything unnamed); the migration attaches those colours, and `cloneLevels` copies a ladder so a tool default is never shared. `formatRatio` prints a level label, `CYCLE_PALETTE` / `cycleColor(i)` colour a sequence, and `DEFAULT_FIB`, `DEFAULT_FIB_FAN`, `DEFAULT_GANN_BOX`, `DEFAULT_GANN_FAN`, `DEFAULT_FIB_TIME_ZONE` are the frozen defaults.
- **`zIndex` is paint order.** Below zero paints under the series, at or above zero over it; ties break by list order, so `drawings()` is the paint order. `sortByZIndex(list)` is the stable sort the layer uses, and `DrawingLayerOrder` (`'bottom' | 'top'`) is which of the two layers a pane primitive is. A default of 0 paints exactly where 1.9.2 painted.
- **`props`** is a JSON-safe bag for a tool's extras (a table's cells, a callout's tail side), persisted verbatim.
- **`DRAWING_STATE_VERSION`** (`2`) is the document version `toJSON` writes.

### Settings schema

Every tool declares which of its fields a host may show, as dot paths with a control kind, and **only fields its `draw` reads**: a control with nothing behind it is a bug, not a style choice.

```ts
import { drawingSettingsSchema, readDrawingSettings, applyDrawingSettings } from 'openalgo-charts/draw';

const schema = drawingSettingsSchema(d.tool);          // { fields, textIsContent? }
const values = readDrawingSettings(d, schema);         // { 'style.color': '#..', 'text.value': 'Hi', ... }
draw.update(d.id, applyDrawingSettings(d, formState, schema));
```

`SettingsField` is `{ path, label, kind, min?, max?, step?, options?, group? }`; `FieldKind` is `'color' | 'number' | 'select' | 'lineStyle' | 'boolean' | 'text' | 'opacity' | 'levels'` and `FieldGroup` is `'line' | 'fill' | 'text' | 'levels' | 'behavior'`. `textIsContent` is true for `text`, `callout`, `note`, `balloon`, `comment`, `signpost`, `price-note` and `table`: ask for the text the moment the tool is placed. `readDrawingSetting(d, path)` reads one value (`levels` comes back as a copy). `coerceSettingValue(field, raw)` turns a form string into what the kind stores. `applyDrawingSettings` returns whole `style` / `text` bags; with a schema it coerces and drops undeclared paths, and a value of `undefined` deletes the key (the host's "reset to default"). A custom tool builds its own with `composeSettings([LINE_FIELDS, FILL_FIELDS], { textIsContent })`, from the shared lists `LINE_FIELDS`, `FILL_FIELDS`, `EXTEND_FIELDS`, `LEVEL_FIELDS`, `TEXT_FIELDS`, `FONT_FIELDS`, `SHAPE_TEXT_FIELDS`, `PLATE_TEXT_FIELDS`, the single fields `COLOR_FIELD`, `LINE_WIDTH_FIELD`, `LINE_STYLE_FIELD`, `SHOW_LABELS_FIELD`, `TEXT_VALUE_FIELD`, and the option lists `LINE_STYLE_OPTIONS`, `ALIGN_OPTIONS`, `VALIGN_OPTIONS`, `TEXT_POSITION_OPTIONS`, `FONT_OPTIONS`. `drawingSettingsSchema` is a registry lookup (a tool without a declaration gets the line fields), which is why it lives in tools.ts rather than with the pure schema helpers.

## DrawingController API

```ts
new DrawingController(chart, {
  magnet: 'off',            // 'weak' | 'strong' | 'off'; true = 'strong'. Snap new anchors to the hovered bar's O/H/L/C
  stayInDrawingMode: false, // stay armed after a shape completes
  historyLimit: 50,         // undo depth
  defaultStyle: {},         // merged UNDER each tool's own defaults
  clipboard: undefined,     // ClipboardPort; defaults to navigator.clipboard, null disables it
  pasteOffsetBars: 2,       // how far a paste is nudged along time
  pasteOffsetPixels: 16,    // how far a paste is nudged down the price axis
});
```

| Member | Behaviour |
|---|---|
| `setTool(id \| null)` | Arms a tool; throws on an unregistered id. Also calls `chart.setPlacementMode(true/false)`. |
| `activeTool()` | Armed id, or `null`. |
| `setOptions(patch)` | Live-patch the four options above. |
| `drawings()` / `get(id)` | Read the model. `drawings()` is the live array, in **paint order** (creation order until a reorder; `createdAt` keeps the creation time). |
| `add(drawing)` | `add({ tool, points, style, paneIndex, text?, props?, id?, locked?, visible?, zIndex? })` (a `DrawingInput`) returns the created `Drawing`, with `zIndex` 0, `createdAt` and a minted id (a supplied id that collides with a restored one is replaced). The tool's `defaultText` merges under `text` the way `defaultStyle` merges under `style`. |
| `update(id, patch)` / `updateMany(patches)` | Patch `points` \| `style` \| `text` \| `props` \| `locked` \| `visible` \| `zIndex` (a `DrawingPatch`). `style`, `text` and `props` merge; `points` replaces. `updateMany([{ id, patch }])` is one undo step and one `drawing:change`. |
| `remove(id)` / `removeMany(ids)` / `clear()` | Delete one / several (one undo step) / all. |
| `finish()` | Commit a `points: 0` tool at the anchors placed so far. Returns whether it committed. |
| `cancel()` | Drop the anchors placed so far; disarms the tool unless `stayInDrawingMode` keeps it (a second call then disarms). Returns whether anything changed. |
| `popAnchor()` | Remove the last anchor of a `points: 0` tool still being placed (the Backspace of placement). Fixed-anchor and freehand tools have nothing to pop. |
| `hovered()` | Id of the unselected drawing under the pointer, or `null`. Fed by the chart's `hover` event; `drawing:hover { id }` fires when it changes. |
| `magnetMode()` | The resolved `MagnetMode` (`'off' | 'weak' | 'strong'`), after the boolean shorthand is mapped. |
| `select(id \| ids \| null, additive = false)` / `selected()` / `selection()` | Selection. `additive` toggles each id (shift, ctrl or meta click does this for you); unknown ids are ignored. `selected()` is the primary (first picked) id; `selection()` is the list in pick order. Events fire only when the selection actually changes. |
| `duplicate(ids)` | Clones with the paste offset (`pasteOffsetBars` / `pasteOffsetPixels`), selects the clones, one undo step. Returns the clones. |
| `nudge(ids, dx, dy)` | Moves by a screen distance in media px (right and down positive); locked members stay. One undo step. Needs `timeToCoordinate` / `coordinateToTime` on the host for the horizontal half, else assumes the default 8 px bar spacing. |
| `setZIndex(id, z)` / `bringToFront(id)` / `sendToBack(id)` | Paint order. The two shortcuts are **band-local**: they set `zIndex` to the max / min of the same pane on the same side of the series and move the drawing to the end / start of the list, never crossing the series. |
| `sendBehindSeries(id)` / `bringAboveSeries(id)` | Set `zIndex` to -1 / 0. No-ops (no history) when already on that side. |
| `undo()` / `redo()` / `canUndo()` / `canRedo()` | History. |
| `copy(target?)` / `cut(target?)` / `paste()` | **Async.** See the clipboard section. |
| `clipboard()` | The `DrawingClipboard` behind them, for reporting failures. |
| `toJSON()` / `fromJSON(data)` | `{ version: 2, drawings }` (a `DrawingsDocument`) out, deep-copied; replace-all in (and clears history + selection). `fromJSON` accepts a 1.9.x bare `Drawing[]` too and upgrades it. |
| `migrateDrawings(input)` | The upgrade `fromJSON` runs, exported for a host reading a saved layout on its own: any 1.9.x array or v2 document in, a v2 `DrawingsDocument` out, never throws. |
| `destroy()` | Unhooks listeners, removes every pane layer, releases placement mode. |

Events on the chart bus: `draw:tool`, `draw:add`, `draw:update`, `draw:remove`, `draw:select` (the primary id), `draw:copy`, `draw:cut`, `draw:paste`, plus the 2.0 pair `drawing:select` (`{ ids }`, the whole selection) and `drawing:change` (`{ ids, kind: 'add' | 'update' | 'remove' | 'reorder' }`, one per mutation, after the per-drawing `draw:*` events), and `drawing:hover` (`{ id: string | null }`, when the unselected drawing under the pointer changes). `DrawingChangeKind` names the `kind` union.

**The controller listens on `chart.on(...)`, not `subscribeClick` / `subscribeDrag`.** Those two are single-slot callbacks the host needs for its own order lines; routing drawings through the bus means the two never contend.

### Placement lifecycle

1. `setTool(id)` arms the tool and puts the chart in placement mode, so a press places an anchor instead of panning.
2. Each `click` appends an anchor. Between anchors, a translucent preview (alpha 0.7) follows the live cursor.
3. When `pending.length >= tool.points`, `expand()` runs (if the tool has one) and the drawing is committed, selected, and (unless `stayInDrawingMode`) the tool disarms.
4. `points: 0` tools (`path`, `polyline`) never self-complete: double-click, or `finish()`. Fewer than 2 anchors discards the attempt.
5. `freehand` tools (`brush`, `highlighter`) ignore clicks and sample the cursor while the pointer is held; the release commits. A tap that never moved is discarded.
6. A press-drag-release also draws a two-anchor shape in one gesture: the chart emits the press point, then the release point tagged `viaDrag`.
7. **Shift locks the angle** on tools with `angleLock` (the line family): the free end is projected onto the nearest 45 degree ray on screen, while placing and while dragging a handle. It projects rather than rotates, so a level line ends under the pointer's x. It needs the host's four pixel mappings and is inert without them.
8. **The magnet ring.** With `magnet` on, the layer paints a ring where the next click will land (the hovered bar's time and the nearest O/H/L/C, so a snapped anchor sits on the bar centre). `'weak'` pulls only when one of the four is within a few px, and needs `priceToCoordinate` to judge that; `'strong'` always pulls. Shift's angle lock wins over the magnet and hides the ring.
9. **Freehand strokes** read the coalesced `samples` a pressed `crosshair:move` carries, so a fast stroke inks every position the pointer passed through rather than one per frame; on release the trail is thinned (`rdpSimplify`, a pixel and a half) and painted as a spline (`catmullRom`). A pen stores `pressure` per sample (a mouse stores nothing), and `style.pressure` on the brush and highlighter lets it drive the width (`pressureWidth`).
10. **Escape, Enter and Backspace** while a tool is armed mean `cancel()`, `finish()` and `popAnchor()`; `keyToDrawingAction` says so when the host passes `placing: true`.

### Selection and dragging

Hit ids are `draw:<id>` for the body and `draw:<id>#<n>` for anchor `n`. A body drag on an unselected drawing selects it alone first; then the **whole selection** moves as one undo entry (locked members stay, other-pane members through `priceToCoordinate` / `coordinateToPrice`); dragging a handle moves that one anchor to the cursor. `draw:update` fires per moved drawing on `drag:end`, plus one `drawing:change`. The grab radius is 6 media px for a body, 7 for a handle; handles of the selected drawing win over its own body.

Freehand strokes expose only their first and last handle: one handle per sample would bury the ink.

The controller also tracks the unselected drawing under the pointer from the chart's `hover` event (`hovered()`, `drawing:hover`), and the layer paints its handles faintly so a drawing reads as grabbable before it is grabbed. A hover change between two drawing layers costs the overlay tier only. The layer sizes its grab targets by the last pointer device (`setPointerType`, fed from the payload's `pointerType`), so a touch gets a larger radius than a mouse. Dragging an under-series drawing lifts it to the top layer for the gesture and re-lists it on release, one Light repaint each; the drag itself is Cursor-only.

### Undo, lock, visibility

**A whole drag is one undo step.** The snapshot is pushed once per gesture, on the first `drag` event, not per frame. Any new edit clears the redo branch. Snapshots are `JSON.stringify` of the full list, capped at `historyLimit`.

`update(id, { locked: true })` keeps the drawing rendered but removes it from hit-testing entirely, it cannot be selected or dragged, and it draws no handles. `update(id, { visible: false })` removes it from both rendering and hit-testing.

## Clipboard: copy, cut, paste

```ts
// The host owns the key bindings; the engine installs no listeners.
window.addEventListener('keydown', async (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === 'c') await draw.copy();
  if (e.key === 'x') await draw.cut();
  if (e.key === 'v') await draw.paste();
});
```

**All three are `async`**, because `navigator.clipboard` is: it returns promises and can reject on a permission the user has not granted. Awaiting them is not optional for `cut`, whose result is the difference between "deleted" and "left alone".

| Member | Signature | Notes |
|---|---|---|
| `copy` | `(target?: string \| string[] \| null) => Promise<boolean>` | Defaults to the selection. `false` means nothing to copy, or the payload could not be stored anywhere. |
| `cut` | `(target?: string \| string[] \| null) => Promise<boolean>` | Deletes **only** after the write resolves successfully. One undo step. |
| `paste` | `() => Promise<Drawing[]>` | Empty array when the clipboard holds nothing of ours. Never throws on foreign content. |

### The payload, and why foreign text is safe

The clipboard is shared with everything else on the machine, so a paste can arrive from a spreadsheet, another charting product, or a hand-edited copy of our own JSON. Two defences:

1. **One namespaced top-level key**, `openalgo-charts/drawings`, carrying a `version`. Anything else is recognised as not ours by looking at one property, and pastes nothing. A Ctrl+V handler must not throw at the user because the last thing they copied was a spreadsheet cell.
2. **Field-by-field validation**, all-or-nothing. The tool must be registered (`hasDrawingTool`), every anchor must be finite, `paneIndex` must be a non-negative integer, style values must be renderable primitives or a short array of numbers, and there are caps on counts and string length. One corrupt entry rejects the whole payload, because pasting the other nine silently is worse than pasting none.

`encodeClipboardPayload`, `decodeClipboardPayload` and `sanitizeDrawing` are exported from `openalgo-charts/draw` if you want to move drawings through your own transport (a websocket, a saved template) with the same validation.

### Degrading instead of breaking

Every write also lands in a **module-level in-memory clipboard shared by every controller in the page**. That is what makes chart-to-chart paste work with the OS clipboard permission refused, and it is why the store is a singleton rather than per-controller state.

```ts
const ok = await draw.cut();
if (!ok) toast('Nothing was cut');
const why = draw.clipboard().lastError();   // set when memory worked but the OS clipboard did not
if (why !== null) toast('Copied in this tab only');
```

Turn the backstop off with `new DrawingClipboard({ fallbackToMemory: false })` when a cut that cannot reach the OS clipboard must not delete the drawing. Pass `clipboard: null` to `DrawingController` to disable the system port entirely (tests, non-browser runtimes), or `clipboard: myPort` to inject one; `setOptions({ clipboard })` swaps the port at runtime, which is how you hand one over after the user grants permission.

### What a paste actually inserts

Fresh objects with **fresh ids**, never a second reference to the drawing that was copied, so editing the paste cannot alter its source or the clipboard. One undo step for the whole paste, and the last one is selected.

The copy is nudged so it is visibly a second shape: `pasteOffsetBars` (2) along time, and `pasteOffsetPixels` (16) down the price axis. The vertical nudge is applied **per anchor** through `priceToCoordinate` / `coordinateToPrice`, not as one price delta, so it is a rigid *screen* translation and a shape keeps its proportions on a logarithmic scale.

A `paneIndex` the receiving chart does not have is folded onto one it does. Without that, `addPrimitive` would conjure an empty pane on the target chart.

## Persistence

Every mutation writes `chart.setDrawingState(this.toJSON())`, so drawings ride along in `chart.getState().drawings` with no extra plumbing.

```ts
localStorage.setItem('layout', JSON.stringify(chart.getState()));   // includes drawings

chart.restoreState(JSON.parse(localStorage.getItem('layout')!));
const draw = new DrawingController(chart);   // reads the state in its constructor
```

**Restore chart state before constructing the controller.** The constructor reads `chart.drawingState()` once; a `restoreState` afterwards leaves the controller holding the old list, which the next `_sync()` writes back over the restored one.

The controller and its layers belong to the chart they were built on, so a rebuild (interval, chart type, or theme swap) needs `const saved = draw.toJSON(); draw.destroy();` before `chart.destroy()`, then `new DrawingController(newChart).fromJSON(saved)`. Anchors are data, so the shapes land on the same bars even at a different interval.

## Keyboard

```ts
import { matchDrawingShortcut, drawingShortcuts } from 'openalgo-charts/draw';

drawingShortcuts();      // { 'trend-line': 'Alt+T', 'horizontal-line': 'Alt+H', ... }
matchDrawingShortcut(e); // tool id, or null
```

**The library installs no key listener.** Only the host knows whether the chart has focus, a dialog is open, or the user is typing in a field. `matchDrawingShortcut` is pure and takes any `{ key, altKey?, ctrlKey?, metaKey?, shiftKey? }`.

Editing chords are the same shape: `keyToDrawingAction(e, { hasSelection, hasTarget, editingText, placing? })` returns a `DrawingKeyAction` (`{ type: 'undo' | 'redo' | 'copy' | 'cut' | 'paste' | 'duplicate' | 'delete' | 'cancel' | 'finish' | 'popAnchor' }` or `{ type: 'nudge', dx, dy }`) or `null`. With `placing: true` (pass `draw.activeTool() !== null`), a bare Escape, Enter or Backspace maps to `cancel`, `finish` or `popAnchor` before anything else is considered, so Backspace never deletes the selection while an anchor is being placed; `hasTarget` is `draw.hovered() !== null`. Ctrl/Cmd+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes, Ctrl+C / X / D need a selection or a hovered target, Ctrl+V always pastes, Delete / Backspace need a selection or target, and the arrows nudge the selection by `NUDGE_STEP_PX` (1) or `NUDGE_STEP_SHIFT_PX` (10) with Shift. `editingText`, any Alt, or an extra Shift on a chord returns `null`. `DrawingKeyEvent` and `DrawingKeyContext` type the two arguments. The host maps each action to the matching controller call: `duplicate(selection())`, `removeMany(selection())`, `nudge(selection(), dx, dy)`.

Matching rules, all verified in `tests/draw-tier.test.ts`:

- Key comparison is case-insensitive (`'t'` and `'T'` both match `Alt+T`).
- **Modifiers must match exactly.** `Alt+T` does *not* fire for `Ctrl+Alt+T` or `Shift+Alt+T`, so a tool can never shadow a browser or host chord.
- `metaKey` counts as Ctrl, so a Mac Cmd chord does not arm an Alt-only tool.
- A bare letter never matches, without Alt or Ctrl the function returns `null` immediately, so ordinary typing is safe.

## Registering a custom tool

A tool is a descriptor. `draw` receives anchors in **device** px (already multiplied by `rc.dpr`); `distance` receives them in **media** px, the same space as the cursor. The hit-test field is named `distance`, not `hitTest`.

```ts
import { registerDrawingTool, distToSegment } from 'openalgo-charts/draw';

registerDrawingTool({
  id: 'vwap-band',
  name: 'VWAP Band',
  points: 2,
  shortcut: 'Alt+B',
  defaultStyle: { color: '#f5a623', lineWidth: 2, fillOpacity: 0.15 },
  draw: ({ ctx, rc, pts, style }) => {
    const band = 8 * rc.dpr;                       // pts are already device px
    ctx.globalAlpha = style.fillOpacity ?? 0.15;
    ctx.fillStyle = style.color;
    ctx.fillRect(pts[0].x, pts[0].y - band, pts[1].x - pts[0].x, band * 2);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = Math.max(1, style.lineWidth * rc.dpr);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.stroke();
  },
  // media px to the shape; 0 means "inside"; null means a miss.
  distance: (x, y, { pts }) => {
    const d = distToSegment(x, y, pts[0], pts[1]);
    return d <= 8 ? 0 : d;
  },
});
```

Exported geometry helpers: `distToSegment`, `distToLine`, `distToPolyline`, `distToRect`, `distToEllipse`, `rectOf`, `boundsOf`, `extendSegment`. Freehand geometry, pure and DOM-free, for a custom tool or a host that captures its own trail: `rdpSimplify(points, epsilonPx)` thins a `ScreenPoint[]` to the corners its shape needs; `catmullRom(ctx, points, tension = 0.5)` traces a smooth spline through them (it neither begins nor strokes the path, so the caller sets the style); `pressureWidth(baseWidth, pressure, range = 0.6)` swells or thins a width by a 0..1 pressure around the 0.5 mouse stand-in. The built-in brush and highlighter use all three.

Three optional descriptor fields change *placement*, not rendering:

| Field | Effect |
|---|---|
| `freehand: true` | Sample the cursor while held, commit on release. Requires `points: 0`. Only the end anchors get handles. |
| `angleLock: true` | Shift snaps the free end of a two-anchor tool to 45 degree steps on screen, while placing and while dragging a handle. The line family sets it; a rectangle's opposite corner is not a line end, so shapes leave it off. |
| `expand(clicked, { barSeconds, visibleBars, toPixel?, fromPixel? })` | Turn the clicked anchors into the full anchor set, so fewer clicks can drop a complete editable default. Every returned point stays a draggable handle. `toPixel` / `fromPixel` are present only when the host can map coordinates; a tool that sizes in pixels falls back to chart units without them. |
| `constrain(points, handle)` | The anchors to keep after one moved: `handle` is the dragged index, or `null` for a `points` patch. Pure. The position tools reflect the level that was NOT moved across the entry when both land on one side, so the one under the hand stays put. |

Size an `expand` default against `visibleBars`, not a fixed bar count, a fixed count is a hairline zoomed out and pane-filling zoomed in. The position tools size on screen instead, through `toPixel` / `fromPixel`: 64 px of risk and 150 px of width read the same on every instrument and at every zoom, where 1% of a 2.87 stock and 1% of an index are the same fraction and very different boxes.

**A non-finite `distance` must be a miss.** The layer treats `null`, `NaN`, and `Infinity` as misses; returning `NaN` from a degenerate shape would otherwise swallow every click on the pane.

## Host UI wiring

The pattern the OpenAlgo terminal uses (`D:\testing\openalgo\frontend\src\lib\trading\terminal.ts`, rail in `src/components/trading/DrawingRail.tsx`, tool catalogue in `src/lib/trading/drawTools.tsx`): the tier is dynamically imported on first use, the controller is the only stateful thing, and React only ever sees a derived stats object.

```ts
// Lazy-load the tier the first time a drawing control is touched.
const { DrawingController, drawingShortcuts, matchDrawingShortcut, drawingSettingsSchema } =
  await import('openalgo-charts/draw');

const draw = new DrawingController(chart, { magnet, stayInDrawingMode: false });
draw.fromJSON(savedDrawings);           // survive a chart rebuild
const chords = drawingShortcuts();      // id -> 'Alt+T', rendered next to tool names

// One handler for every mutation: persist, then re-derive toolbar state.
for (const ev of ['draw:tool', 'draw:add', 'draw:update', 'draw:remove', 'draw:select']) {
  chart.on(ev, () => {
    localStorage.setItem('draw', JSON.stringify(draw.toJSON()));
    setStats({
      tool: draw.activeTool(), count: draw.drawings().length,
      canUndo: draw.canUndo(), canRedo: draw.canRedo(),
      hasSelection: draw.selected() !== null, shortcuts: chords,
    });
  });
}

// A text tool is useless empty: open the host's dialog as soon as one lands.
chart.on('draw:add', (p) => {
  const d = (p as { drawing: { id: string; tool: string; text?: { value: string } } }).drawing;
  if (drawingSettingsSchema(d.tool).textIsContent) openTextDialog(d.id, d.text?.value ?? '');
});

// Keys: the host decides when the chart owns them.
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (e.key === 'Escape') return draw.setTool(null);
  if (e.key === 'Delete') { const id = draw.selected(); if (id) draw.remove(id); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.shiftKey ? draw.redo() : draw.undo(); return; }
  const id = matchDrawingShortcut(e);
  if (id !== null) { e.preventDefault(); draw.setTool(id); }
});

// A style bar patches the selection.
draw.update(draw.selected()!, { style: { color, lineWidth, lineStyle, fillOpacity } });
```

## Foot-guns

**Tool `defaultStyle` beats the controller's `defaultStyle`.** The merge order in `add()` is `{ ...controller.defaultStyle, ...tool.defaultStyle, ...drawing.style }`, so a controller-wide `{ fill: false }` will not turn off a rectangle's fill. Patch the drawing, or pass `style` on `add`.

**`drawings()` returns the live array, not a copy.** Mutating it desynchronises the pane layers and the chart state. Use `toJSON()` when you need a snapshot.

**`boundsOf(points)`** (with `rectOf` and the `distTo*` helpers) is the screen-space bounding box a custom tool's `distance` or a host's marquee wants; it is exported so nobody restates it.

**A drawing renders only once it has `max(1, tool.points)` anchors.** A partially-placed `points: 0` shape lives in the preview slot, not the model, so it is absent from `toJSON()` until committed.

**Magnet only applies to pane 0.** `_snap` returns the raw price for any other pane index, because O/H/L/C snapping has no meaning on an indicator pane.

Related: [primitives-and-plugins](primitives-and-plugins.md) (the `IPrimitive` contract `DrawingLayer` implements), [events-and-state](events-and-state.md) (the bus and `getState`), [interactions](interactions.md) (placement mode, pan/zoom), [bundling-and-tiers](bundling-and-tiers.md) (lazy-loading the tier).

## Named tool exports

Individual tools are exported too, under the UPPER_SNAKE form of the id:
`NOTE`, `BALLOON`, `COMMENT`, `SIGNPOST`, `PRICE_NOTE`, `TABLE`, `CALLOUT`,
`FLAG_MARK`, `ARROW_UP`, `ARROW_DOWN`, `ARROW_LEFT`, `ARROW_RIGHT`.

As with the indicator tier, importing `openalgo-charts/draw` registers all 51 tools,
but each descriptor is also exported by name for selective registration:

```ts
import { registerDrawingTool } from 'openalgo-charts/draw';
import { TREND_LINE, FIB_RETRACEMENT, RECTANGLE } from 'openalgo-charts/draw';

for (const t of [TREND_LINE, FIB_RETRACEMENT, RECTANGLE]) registerDrawingTool(t);
```

| Export &rarr; id | Export &rarr; id | Export &rarr; id |
|---|---|---|
| `ARROW` &rarr; `arrow` | `CROSS_LINE` &rarr; `cross-line` | `ELLIPSE` &rarr; `ellipse` |
| `EXTENDED_LINE` &rarr; `extended-line` | `FIB_EXTENSION` &rarr; `fib-extension` | `FIB_RETRACEMENT` &rarr; `fib-retracement` |
| `HORIZONTAL_LINE` &rarr; `horizontal-line` | `HORIZONTAL_RAY` &rarr; `horizontal-ray` | `LONG_POSITION` &rarr; `long-position` |
| `MEASURE` &rarr; `measure` | `PARALLEL_CHANNEL` &rarr; `parallel-channel` | `PATH` &rarr; `path` |
| `RAY` &rarr; `ray` | `RECTANGLE` &rarr; `rectangle` | `SHORT_POSITION` &rarr; `short-position` |
| `TEXT` &rarr; `text` | `TREND_LINE` &rarr; `trend-line` | `VERTICAL_LINE` &rarr; `vertical-line` |

The 2.0 entry also names the measurement, shape, freehand, fib and cycle families:
`FORECAST`, `PRICE_RANGE`, `DATE_RANGE`, `CIRCLE`, `TRIANGLE`, `POLYLINE`, `ARC`,
`CURVE`, `ROTATED_RECTANGLE`, `DOUBLE_CURVE`, `HIGHLIGHTER`, `BRUSH`, `FIB_CHANNEL`,
`FIB_TIME_ZONE`, `FIB_FAN`, `GANN_FAN`, `GANN_BOX`, `CYCLIC_LINES`, `TIME_CYCLES`,
`SINE_LINE`. The remaining tools are registered by `registerBuiltinDrawingTools()` and reachable
through `getDrawingTool(id)` / `hasDrawingTool(id)` / `registeredDrawingTools()`.

Clipboard persistence uses `DRAWING_CLIPBOARD_KEY` (`'openalgo-charts/drawings'`)
and `DRAWING_CLIPBOARD_VERSION` (`2`, tracking `DRAWING_STATE_VERSION`; a version 1 body is
accepted and upgraded); `systemClipboard` and
`clearMemoryClipboard` are the two backing stores. `cloneDrawing` is the deep copy a
copy or a `duplicate` makes. `DRAW_TIER` is the tier constant.

## Types for a custom tool

| Type | Where it shows up |
|---|---|
| `DrawingChartHost` | What `new DrawingController(chart)` accepts. Wire the controller to something other than a `Chart` by satisfying this |
| `ExpandContext` | The argument to `DrawingTool.expand`, so a custom tool can type its own implementation |
| `DrawingInput` / `DrawingPatch` / `DrawingsDocument` | What `add` accepts, what `update` accepts, what `toJSON` returns |
| `DrawingText` / `FibLevel` | The text block and one level of a ladder (see the 2.0 model above) |
| `MagnetMode` | `'off' | 'weak' | 'strong'`, what `magnet` resolves to and `magnetMode()` returns |
| `DrawingPointerKind` | `'mouse' | 'touch' | 'pen'`, what `DrawingLayer.setPointerType` takes; a touch gets larger grab targets |
| `DrawingPoint.pressure` | Optional 0..1 pen pressure on a freehand sample; kept by the clipboard and the migration |
| `IconAttrs` / `IconSvgOptions` / `ToolCursorOptions` | The icon attribute bag, and the option bags of `iconSvg` and `toolCursor` |
