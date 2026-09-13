# Widget tier

*When to read this: the user wants a chart with a toolbar, a drawing rail, dialogs or shortcuts without writing that chrome; or asks whether the library "has a UI"; or is embedding one of the widget's dialogs in a host of their own.*

Source of truth: `src/widget/index.ts` (the export list), `src/widget/widget.ts` (options, handle, state), `src/widget/mobile.ts` (responsive chrome), `src/widget/context.ts` (the context, the bus, storage, the overlay stack, the dialog registry), `src/widget/keymap.ts`, `src/widget/rail.ts`, `src/widget/topbar.ts`, `src/widget/statusline.ts`, `src/widget/toast.ts`, `src/widget/tokens.ts`, `src/widget/styles.ts`, `src/widget/form.ts`, the dialog modules under `src/widget/dialogs/`, and `dist/widget/index.d.ts` once built. Packaging: `rollup.config.js`, `package.json` (`exports['./widget']`), `.size-limit.json`, `scripts/check-dts.mjs`, `scripts/check-shake.mjs`.

## What it is

`openalgo-charts/widget` is the eighth tier and the only one that builds DOM. `createWidget(container, options)` returns a `Widget` that owns a `Chart`, a `DrawingController`, and the chrome around them: top bar (symbol box, interval pills, chart type, indicators, capture, settings, theme), drawing rail, status line, the settings dialog, the indicator picker and per-indicator settings, drawing properties, a level editor for the fib and gann family, an in-place text editor for the text tools, a right-click menu, a keymap with a `?` shortcuts panel, toasts, one injected stylesheet, and optional layout persistence.

**The engine still ships no DOM.** Rule 12 of the hub skill stands for `openalgo-charts` and the six other tiers. The widget is the exception by design: it is a host, packaged, and it drives the engine only through the public API (`createChart`, `DrawingController`, `chartSettingsSchema`, `drawingSettingsSchema`, the `contextmenu` event, the registries). Enforced by the ESLint tier ACL (nothing under `src/` except `src/widget/` may import it; the widget reaches the engine and the draw tier only through `openalgo-charts` and `openalgo-charts/draw`), by `npm run shake` (a chart-only import is asserted free of the `oac-widget` CSS scope), and by the size rows (the base row did not move).

## Setup

```ts
import { createWidget } from 'openalgo-charts/widget';
import 'openalgo-charts/indicators';                 // the picker lists what the registry holds
import { OpenAlgoDataFeed } from 'openalgo-charts';

const widget = createWidget('#terminal', {
  feed: new OpenAlgoDataFeed({ baseUrl: 'http://127.0.0.1:5000', apiKey: 'YOUR_KEY' }),
  symbol: 'RELIANCE',
  exchange: 'NSE',
  interval: '5m',
  theme: 'dark',
  persist: true,
});
```

`container` is an `HTMLElement`, a CSS selector, or an element id and must exist before the call. Give it a real height for rendering; since 2.1.3 an initially hidden chart can receive data and apply its pending initial view when layout reports a usable width. See [host-integration](host-integration.md#hidden-charts-and-preferred-views). The widget imports `openalgo-charts` and `openalgo-charts/draw` itself; the indicator tier is the host's import because not every terminal wants 102 indicators.

Importing the module touches no DOM; only `createWidget` does (it injects the stylesheet and builds the root then). Import it anywhere, call it once the container exists. `npm run skills:coverage` imports the built tier under Node and fails on a module-scope `document` access.

## Exports

Everything `src/widget/index.ts` exports at runtime. The shell (`createWidget` and the handle) is what a host uses; the rest is exported so a host that wants one piece of the chrome and its own for the rest can have it, or so a dialog module of the host's own can register with the shell.

### The shell (`widget.ts`)

| Export | Kind | Purpose |
|---|---|---|
| `createWidget(container, options?)` | function | The one call. Returns a `Widget`. |
| `WIDGET_TIER` | const `'widget'` | The tier's identity constant, like `DRAW_TIER`. |
| `stripView(state)` | function | A `WidgetChartState` without its viewport and pinned ranges; what a saved layout gets when it lands on a different symbol or interval. |
| `resolveTheme(t)` | function | `'dark'`, `'light'`, a `ChartTheme` or `undefined` to `{ theme, name }`. |
| `loadWindow(interval, lookback, nowSec)` | function | The `{ from, to }` the feed is asked for: `lookback` bars back from now, or five years for a non-time bucketing. |
| `DEFAULT_INTERVALS` | const | `['1m', '5m', '15m', '1h', '1d', '1w']`, with every other registered code appended when the host names none. |
| `DEFAULT_LOOKBACK_BARS` | const `500` | Bars per load when `lookbackBars` is not given. |
| `SAVE_DEBOUNCE_MS` | const `250` | Debounce on writing the persisted layout. |
| `STATE_KEY` | const `'state'` | The storage entry the layout lives under. |
| `WIDGET_STATE_VERSION` | const `1` | `WidgetState.version`. |
| `Widget`, `WidgetOptions`, `WidgetState`, `WidgetChartState`, `WidgetRestoreReport`, `WidgetEventName` | types | See the sections below. |
| `mountMobile(ctx, options)` | function | Mount the narrow header, bottom bar and sheets against an existing `WidgetContext`. Returns `MobileHandle`. |
| `MobileMode`, `MobileOptions`, `MobileHandle` | types | Responsive mode, mount contract and handle for custom widget composition. |

### The context, bus, storage and overlays (`context.ts`)

| Export | Kind | Purpose |
|---|---|---|
| `WidgetBus` | class | Typed `on` / `off` / `emit` / `clear`; the widget's own events ride it. |
| `WidgetStorage` | class | Namespaced `get` / `set` / `remove` over a `StorageLike`; `enabled` is false when `persist` is off, and a throwing store reads as "nothing saved". |
| `STORAGE_PREFIX` | const `'oac-widget:'` | Every key the widget writes sits under it. |
| `defaultStorage()` | function | The page's `localStorage` when it exists and works, else null. |
| `registerWidgetDialog(name, mount)` | function | Make a dialog's mount known to every shell. Returns a disposer. |
| `registerWidgetDialogs(mounts)` | function | Several at once, from a module's exports. |
| `unregisterWidgetDialog(name)` | function | Remove one; false when nothing was registered. |
| `widgetDialog(name)` | function | The registered `DialogMount` for a name, or null. The top bar reads this on every refresh, which is how its settings and indicators buttons light up. |
| `registeredWidgetDialogs()` | function | The names registered so far. |
| `createOverlayStack(root, doc)` | function | The layer dialogs, popovers and menus open on: positioned from an anchor or centred, focus-trapped, one Escape per layer, focus returned on close. |
| `createTipController(root, layer, doc)` | function | Hover labels for controls, shown after `TIP_DWELL_MS`. |
| `TIP_DWELL_MS` | const `600` | Pointer dwell before a tip appears. |
| `esc(s)` | function | HTML-escape the four characters that matter. |
| `h(doc, tag, className?, attrs?)` | function | `createElement` with a class and attributes. |
| `glyph(doc, svg, kind)` | function | A span holding trusted `<svg>` from the draw tier's icon registry (`'tool'` or `'chrome'` sizing). |
| `inTextField(target)` | function | Whether a key event came from a text control, where chords stay out of the way. |
| `focusable(n)`, `focusables(root)` | functions | Focus-trap helpers. |
| `placeBeside(anchor, size, bounds, gap?, pad?)`, `placeBelow(...)`, `placeTip(...)` | functions | Pure placement maths in root coordinates, flipping when there is no room. |
| `boxIn(root, el)` | function | An element's box in the widget root's coordinate space. |
| `WidgetContext`, `WidgetBusEvents`, `BusHandler`, `StorageLike`, `DialogMount`, `DialogHandle`, `WidgetDialogName`, `OverlayOptions`, `OverlayStack`, `TipSpec`, `TipSource`, `TipSide`, `TipController`, `Box`, `Size` | types | |

### The keymap (`keymap.ts`)

| Export | Kind | Purpose |
|---|---|---|
| `Keymap` | class | One capture-phase keydown listener on the document; `register(combo, action, scope, opts)` returns a disposer; `handle`, `attach`, `list`, `conflicts`, `onConflict`, `format`, `activeScopes`, `destroy`. |
| `openShortcutsPanel(ctx)` | function | The `?` panel: every binding by group, a shadowed one struck through. Returns the closer. |
| `parseKeyCombo(spec)` | function | A human spec (`'Ctrl+Shift+Z'`, `'Mod+Z'`) to the canonical chord. |
| `eventKeyCombo(e)` | function | The canonical chord an event stands for, or `''` for a bare modifier press. |
| `formatKeyCombo(combo, isMac?)` | function | A chord as a user reads it (`Cmd` on a Mac). |
| `fromChartCombo(combo)` | function | The engine's `ShortcutManager` spelling to the widget's. |
| `KeyScope`, `KeyEventLike`, `KeyAction`, `KeyBinding`, `KeyBindingOptions`, `KeyConflict`, `KeymapOptions`, `KeymapGroup`, `ChartShortcutSource` | types | |

Scopes resolve narrowest first: `['overlay']` alone while any overlay is open (nothing else fires; the stack's own listener handles Escape and Tab), otherwise `rail` (focus in the rail), `chart` (pointer or focus on the chart), `widget` (pointer or focus in the root), `global`. A binding's action may return `false` to decline the key, in which case the next scope is tried and finally the engine sees it. A claimed chord is prevented and stopped, so the engine's `ShortcutManager` never sees it. Conflicts with the engine's own table are reported through `conflicts()` and the `keymap:conflict` bus event; the nudge arrows are registered layered and excluded from the report, while `Alt+H` and `Alt+V` (draw-tier tool chords) genuinely shadow the chart's grid toggles and are listed.

### The rail (`rail.ts`)

| Export | Kind | Purpose |
|---|---|---|
| `mountRail(ctx, host, opts?)` | function | The drawing rail into `host`. Returns a `RailHandle` (`sync`, `refresh`, `prefs`, `restorePrefs`, `magnetMode`, `setMagnetMode`, `cycleMagnet`, `stayMode`, `setStayMode`, `setDrawLock`, `destroy`). |
| `RAIL_GROUPS` | const | The group table: lines, channels, fib and gann, shapes, cycles, marks, text, measure, and the ids in each. The rail's order comes from here, not from `rail.tools`. |
| `MAGNET_MODES` | const | `['off', 'weak', 'strong']`, the cycle the magnet button walks. |
| `RAIL_PREFS_KEY` | const `'rail'` | The storage entry the rail's pins, last-picked tools, magnet and stay modes live under. |
| `toolGlyph(doc, id)` | function | A tool's glyph from the draw tier's sprite; a tool without an icon still gets its name. |
| `toolName(id)` | function | A tool's display name from the registry, or the id itself. |
| `sanitizeRailPrefs(raw, groups, toolsOf)` | function | Validate a stored preference object field by field, dropping what this build cannot honour. |
| `RailOptions`, `RailHandle`, `RailPrefs`, `RailGroup`, `RailGroupItem` | types | |

The sprite is injected once per document on the body (`id="oac-rail-sprite"`), so it outlives any one widget.

### The top bar (`topbar.ts`)

| Export | Kind | Purpose |
|---|---|---|
| `mountTopbar(ctx, host, opts)` | function | Symbol box with search, interval pills, chart type menu, Indicators, Objects, capture, settings, theme. Returns a `TopbarHandle` (`refresh`, `destroy`). |
| `openMenu(ctx, anchor, rows, opts?)` | function | A popover menu under `anchor`, with an optional filter box; the chart type menu and the symbol results share it. Returns the closer. |
| `chartTypeChoices()` | function | The registered chart types a user can pick for the instrument (the registry minus histogram-family internals). |
| `chartTypeLabel(id)` | function | A label from `CHART_TYPE_LABELS`, else the id. |
| `CHART_TYPE_LABELS` | const | Labels for the built-in chart types. |
| `intervalLabel(code)` | function | `'1d'` as `D`, `'1w'` as `W`, minute and hour codes as written, a registered calendar code upper-cased. |
| `downloadText(doc, filename, text, mime)` | function | Hand text to the browser as a file; false when the runtime cannot. |
| `captureName(symbol, interval, now?)` | function | `SYMBOL-5m-2026-01-31-09-15`, filename-safe. |
| `SEARCH_DEBOUNCE_MS` | const `150` | Quiet before `symbolSearch` runs. |
| `TopbarOptions`, `TopbarHandle`, `TopbarState`, `SymbolMatch`, `SymbolSearch`, `MenuRow`, `MenuOptions` | types | |

### Status line, toasts, tokens, styles

| Export | Kind | Purpose |
|---|---|---|
| `mountStatusline(ctx, host, opts?)` | function | Symbol, interval, O H L C, change, volume, the hovered bar's time, bar count, timezone; a transient message slot. Returns a `StatuslineHandle` (`setSymbol`, `setMessage`, `destroy`). |
| `priceDigits(chart)` | function | Decimals for the readout: the pane's own precision floored at `MIN_PRICE_DIGITS`. |
| `MIN_PRICE_DIGITS` | const `2` | |
| `mountToasts(host, doc?)` | function | The toast stack. Returns a `Toaster` (`toast(message, kind?)`, `destroy`). |
| `TOAST_MS` | const | `{ info: 4000, success: 3500, error: 0 }`; 0 stays until dismissed. |
| `TOAST_MAX` | const `5` | Beyond this many the oldest goes. |
| `TOAST_LEAVE_MS` | const `160` | Leave transition. |
| `widgetTokens(theme, mode?)` | function | Every chrome custom property derived from a `ChartTheme`. |
| `applyTokens(el, tokens)` | function | Write a token set inline on an element. |
| `themeMode(theme)` | function | `'dark'` or `'light'`, judged from the theme background. |
| `token(name)` | function | `var(--oac-name)`. |
| `parseColor(input)`, `formatColor(c)`, `luminance(color)`, `mix(a, b, t)`, `withAlpha(color, alpha)` | functions | The colour maths the tokens are built from; exported for a host deriving its own. |
| `TOKEN_PREFIX` | const `'--oac-'` | |
| `WIDGET_FONT`, `WIDGET_MONO` | consts | The UI and monospace font stacks. |
| `RAIL_WIDTH`, `TOPBAR_HEIGHT`, `STATUSLINE_HEIGHT` | consts | `42`, `40`, `24` CSS pixels, shared by the stylesheet and the placement maths. |
| `WIDGET_CSS` | const | The shell stylesheet text. |
| `DIALOG_CSS` | const | The dialog rules, appended to the same sheet by `createWidget`. |
| `OBJECTS_PANEL_CSS` | const | Object list rules, included in the widget stylesheet; custom hosts append it alongside `WIDGET_CSS` and `DIALOG_CSS`. |
| `WIDGET_STYLE_ID` | const `'oac-widget-css'` | Id of the injected `<style>`, one per document. |
| `injectWidgetStyles(doc, extra?, nonce?)` | function | Inject or fill an empty sheet once per document; `extra` is appended when filling it. Assigns the nonce before filling/insertion, preserves an existing nonce and leaves populated host CSS untouched. |
| `StatuslineOptions`, `StatuslineHandle`, `Toaster`, `ToastHandle`, `ToastKind`, `ToastOptions`, `WidgetThemeName`, `WidgetTokens`, `Rgba` | types | |

### Dialogs and forms (`dialogs/`, `form.ts`)

Every mount takes the context and an optional anchor element (so it satisfies `DialogMount`), plus an options object, and returns a `PanelHandle` (`el`, `close()`, `isOpen()`). A mount that cannot act (no selection, an unknown instance) toasts and returns a closed handle rather than throwing. Anchored, a picker or properties panel opens as a popover below the anchor; without one, dialogs are centred and modal.

| Export | Kind | Purpose |
|---|---|---|
| `mountSettingsDialog(ctx, anchor?, { tab?, unavailable?, onApply?, onClose? })` | function | Chart settings, generated from `chartSettingsSchema(chart)`; Cancel and Escape revert the dirty keys. |
| `mountIndicatorPicker(ctx, anchor?, { onAdd?, closeOnAdd? })` | function | Searchable, grouped list of every registered indicator. |
| `mountIndicatorSettings(ctx, anchor?, { instanceId?, tab?, onChange?, onClose? })` | function | Inputs and styles for one indicator, from its descriptor. `instanceId` falls back to `anchor.dataset.instanceId`, then the chart's only indicator. |
| `mountDrawingProperties(ctx, anchor?, { ids?, onClose? })` | function | The selected drawings' fields, from `drawingSettingsSchema`. |
| `mountLevelEditor(ctx, anchor?, { ids? })` | function | Per-level ratio, colour and visibility for the fib and gann tools. |
| `mountTextEditor(ctx, anchor?, { id?, onDone? })` | function | In-place editing laid over the painted text. Returns a `TextEditorHandle` with `commit()` and `cancel()`; an outside press commits, Escape cancels. |
| `mountContextMenu(ctx, anchor?, { event?, hooks? })` | function | The right-click menu for the chart's `contextmenu` payload: trade rows when `onOrder` is given, drawing actions on a drawing, scale modes on a price axis, paste, fit, indicators, settings. |
| `attachContextMenu(ctx, hooks?)` | function | Subscribe to the chart's `contextmenu`, `preventDefault`, mount the menu. Returns the unsubscriber. `createWidget` does this itself. |
| `contextMenuEntries(ctx, event, hooks)` | function | The `MenuEntry[]` the menu is built from, for a host composing its own. |
| `WIDGET_DIALOGS` | const | The seven mounts under the registry names: `settings`, `indicatorPicker`, `indicatorSettings`, `drawingProperties`, `contextMenu`, `levelEditor`, `textEditor`. Registered on import. |
| `renderForm(host, controls, opts)` | function | One control renderer for every generated form: switch column, label, control column; `colorPair` on one row. Returns a `FormHandle`. |
| `controlsFromInputs(inputs)` | function | `ChartSettingsInput[]` (the engine's settings schema) to `FormControl[]`. |
| `controlsFromFields(fields)` | function | A drawing tool's `SettingsField[]` to `FormControl[]`. |
| `SettingsDialogOptions`, `IndicatorPickerOptions`, `IndicatorSettingsOptions`, `IndicatorSettingsTab`, `DrawingPropertiesOptions`, `LevelEditorOptions`, `TextEditorOptions`, `TextEditorHandle`, `ContextMenuHooks`, `ContextMenuOptions`, `MenuEntry`, `MenuItem`, `OrderRequest`, `PanelHandle`, `FormControl`, `FormKind`, `FormOptions`, `FormHandle` | types | |

`OrderRequest` is `{ side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT' | 'SL'; price: number | null; paneIndex: number }`; `price` is null for a market order.

## `WidgetOptions`

`ChartOptions` (minus `theme`) plus:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `feed` | `DataFeed` | none | `getBars` is called for the current symbol and interval at start and on every `setSymbol` / `setInterval` / `reload`; `subscribeBars` when the feed has it. Without a feed, put data on `widget.series` yourself. |
| `symbol` | `string` | `''` (or the saved one) | Upper-cased. With a feed and a symbol, the first load starts in the constructor. |
| `exchange` | `string` | `''` | Passed to the feed with the symbol. |
| `interval` | `string` | `'1d'` (or the saved one) | Must be a code the interval registry knows; an unknown code throws the engine's `UnknownIntervalError` at the call site. A saved code this build does not know falls back to `'1d'`. |
| `intervals` | `readonly string[]` | `DEFAULT_INTERVALS` plus every registered code | The pill list. Each is validated the same way. |
| `chartType` | `string` | `'candlestick'` | The primary series type; must be a registered chart type. |
| `theme` | `'dark' \| 'light' \| ChartTheme` | `'dark'` | Drives the canvas and the chrome tokens. Note the engine's own default is light; the widget's is dark. |
| `rail` | `boolean \| RailOptions` | on | `false` hides it. `RailOptions.tools` restricts which ids appear (order still follows `RAIL_GROUPS`); `favorites` seeds the pins when nothing is stored. |
| `topbar` | `boolean` | on | |
| `statusline` | `boolean` | on | |
| `mobile` | `'auto'` \| `'always'` \| `'never'` | `'auto'` | Compact widget controls. Auto activates when the widget container is at most 640 CSS px wide or the primary pointer is coarse. |
| `indicators` | `boolean` | on | The Indicators button. |
| `persist` | `boolean \| string` | off | `true` uses the `default` namespace; a string names one, so two widgets on a page keep separate layouts. |
| `storage` | `StorageLike \| null` | the page's `localStorage` | The store behind `persist`. |
| `locale` | `string` | the runtime's | BCP 47 tag for the numbers on the status line. |
| `symbolSearch` | `(query) => SymbolMatch[] \| Promise<SymbolMatch[]>` | none | Called as the user types in the symbol box, after `SEARCH_DEBOUNCE_MS`. |
| `lookbackBars` | `number` | `DEFAULT_LOOKBACK_BARS` | Bars per load. |
| `now` | `() => number` | `Date.now` | Clock for the load window and the capture filename. |
| `onOrder` | `(order: OrderRequest) => void` | none | Order entry from the right-click menu. Without it the menu draws no trade rows. |
| `styleNonce` | `string` | none | Response CSP nonce for the shared widget and dialog stylesheet. Style-attribute policy remains the host's responsibility. |

Confirm defaults against `WidgetOptions` in the typings rather than assuming.

## Mobile controls

`createWidget` always mounts one mobile handle. Mode `'auto'` observes the widget
container and the primary-pointer media query. It activates at 640 CSS px or less or
when `(pointer: coarse)` matches, `'always'` stays active, and `'never'` keeps desktop
chrome. Width is based on the container, not the viewport.

The compact header provides symbol entry and intervals. The bottom bar provides Draw,
Studies, Objects and More according to the same `topbar`, `rail` and `indicators` options
as desktop chrome. More contains theme, chart settings and chart type. A selected drawing
adds Properties, Lock or Unlock, and Delete. An active drawing tool adds Finish, Cancel,
Undo, Magnet and Stay in the Drawing sheet.

Both layouts share `ctx.draw`, `ctx.objects`, widget events, dialogs and the overlay stack,
so resizing does not copy or reset selection, drawings or undo state. `RailOptions.tools`
filters the mobile Drawing sheet to the same allowed tool ids as the desktop rail.

If `prefers-reduced-motion: reduce` matches, `createWidget` supplies `animZoom: false` and
`animAutoscale: false` only when the host omitted those options. Explicit values win.
`mountMobile` is public for custom composition and returns `{ el, active, refresh, destroy }`;
ordinary hosts should let `createWidget` wire and destroy it.

## The `Widget` handle

```ts
widget.chart;                        // Chart
widget.draw;                         // DrawingController
widget.root;                         // the .oac-widget element
widget.context;                      // the WidgetContext every mounted piece was handed
widget.objects;                      // the owned base-tier ChartObjects inventory
widget.series;                       // the primary SeriesApi, replaced by setChartType
widget.symbol(); widget.exchange(); widget.interval(); widget.chartType(); widget.theme();
widget.setSymbol(symbol, exchange?);
widget.setInterval(code);            // throws UnknownIntervalError for a code the registry lacks
widget.setChartType(id);             // a registered chart type id; the series is rebuilt with the same bars
widget.setTheme('dark' | 'light' | theme);
widget.openSettings();               // false when no dialog is registered under 'settings'
widget.openIndicatorPicker();
widget.openObjects();                // false after destruction; focuses the existing panel when open
widget.getState();                   // WidgetState, JSON-safe
widget.restoreState(state);          // WidgetRestoreReport
await widget.reload();               // fetch again for the current symbol and interval
widget.on(event, cb);                // returns the unsubscriber
widget.off(event, cb?);
widget.destroy();                    // saves if persisting, removes the chrome, destroys the chart
widget.isDestroyed;
```

`getState()` returns `{ version: 1, symbol, exchange, interval, chartType, theme, chart: chart.getState(), rail: RailPrefs | null }`. `restoreState` validates field by field and returns `{ applied, reason?, chart?: RestoreReport }`; a saved viewport is applied only when the state was captured on the same symbol and interval, otherwise `stripView` drops it and the indicators, drawings and panes still land. With `persist`, the state is written under `oac-widget:<namespace>:state` (debounced by `SAVE_DEBOUNCE_MS`, flushed on `pagehide` and on `destroy`) and the rail's preferences under `oac-widget:<namespace>:rail`.

### Objects panel

`mountObjectsPanel(ctx, anchor?, opts?: ObjectsPanelOptions)` returns `PanelHandle`
(`el`, `close()`, `isOpen()`). `ObjectsPanelOptions` contains optional `objects:
ChartObjects` and `onClose`. The explicit model overrides optional
`WidgetContext.objects`; one must be provided, otherwise the mount throws a clear
missing-model error. Closing the panel releases only its subscription, and calls
`onClose` once. The host retains ownership of the model.

```ts
import { mountObjectsPanel } from 'openalgo-charts/widget';

const panel = mountObjectsPanel(widget.context, openButton, {
  objects: widget.objects,
  onClose: () => updateToolbarState(false),
});
panel.close();
```

Search matches name, kind and pane labels (displayed starting at 1). Live updates
preserve search and action-button focus. Rows show visibility, drawing lock and
selection, and external-indicator data status. Only supported actions appear; an
action returning `false` or throwing reports through the existing toast. No primary
source removal control is offered. Settings reuse the widget's current chart,
indicator and drawing editors. Drawing actions use existing undo history.

The panel uses the shared overlay for pointer containment, focus trapping, Escape
and focus restoration. Its scrollable list fits the actual container, including
350 px and short hosts; search and footer remain reachable. All controls are text.
`createWidget` already includes `OBJECTS_PANEL_CSS`; a custom stylesheet must include
it along with the shared widget and dialog rules.

`widget.objects` is a base-tier `ChartObjects`, detailed in
[core-api](core-api.md#object-inventory-and-management). Custom profiles register
explicit operations there. `widget.destroy()` disposes its inventory; custom
hosts dispose their own. Indicator visibility persists in chart/widget layouts,
with omitted legacy visibility defaulting to visible. Host provider state and
callbacks require separate persistence and registration after replacement.

### Events

`on` takes a `WidgetEventName`; payloads are `WidgetBusEvents[K]`:

| Event | Payload | When |
|---|---|---|
| `symbol` | `{ symbol, exchange }` | The user picked one in the top bar or `setSymbol` was called. Also emitted on `widget.chart` so a link group can follow. |
| `interval` | `{ interval }` | Likewise. |
| `theme` | `{ theme, chartTheme }` | `setTheme` or the top bar's toggle. |
| `layout` | `{ reason, chartType? }` | Something `getState()` would now return differently: the chart type, a restored layout, a pane change. |
| `data` | `{ symbol, interval, bars, error? }` | A load finished, or failed (then `error` is the message and `bars` is 0). |
| `status` | `{ text, kind }` | The status line's transient message changed. |

Chart events stay on `widget.chart`, drawing events on `widget.draw`. The bus also carries `keymap:conflict` for `widget.context.bus.on`.

## Live history and reconnect recovery

The widget passes `BarSubscriptionOptions` to `feed.subscribeBars`: `seedFrom` continues the last loaded bar, and `onResync` requests authoritative history after a stream interruption. On resync it pauses display updates while buffering live bars, loads the current window with `BarsRequest.noCache: true`, merges the buffered observations, replaces the series with `setData`, restores the visible logical range, and seeds the replacement subscription from the merged last bar. Monitoring stays active during the fetch; a repeated reconnect starts a newer request and supersedes the earlier one. `withBarCache` forwards subscription options and honors `noCache`; custom wrappers must preserve both. Never replay older gap-fill bars through the tail-only `series.update` path.

For overlapping timestamps the merge preserves the history open, combines high/low extrema, uses the latest buffered close, and takes the maximum of the volume snapshots. Bars without buffered updates retain authoritative history. The overlap merge is conservative: a buffered whole candle may retain a seed extreme corrected by history, and does not establish exact snapshot/tick ordering or reconstruct unseen trades. The replacement seeded subscriber is installed before releasing the previous subscription.

An automatic refresh that fails or returns no bars keeps the previous chart visible, reports stale history in the status line and emits a `data` error. Display updates remain paused while buffering and reconnect monitoring continue. `widget.reload()` is the manual retry; requests keep bypassing the cache until a current load succeeds. Same-context manual reload and automatic recovery preserve the visible time anchor. Stale results and callbacks are guarded after symbol/interval changes or destruction. The host owns closing the feed itself.

## `WidgetContext`

What the shell hands every mounted piece, and what a host's own panel wants: `chart`, `draw`, `root`, `document`, `theme` (`'dark' | 'light'`), `chartTheme`, `keymap`, `bus`, `storage` (a `WidgetStorage`), `locale`, `toast(message, kind?)`, `openOverlay(el, opts?)` (returns the closer), `status(text, kind?)`, `tips`, `overlays`, `symbol()` (`{ symbol, exchange }`), `interval()`.

A dialog module of your own: build the panel with `createElement`, hand it to `ctx.openOverlay(el, { anchor, placement: 'below' })` or `{ placement: 'center', modal: true }`, stop propagation of its own `keydown` (except Escape and Tab) and `pointerdown` so the chart's pointer capture does not eat a click, and register chords in scope `'overlay'` if it wants any while open. Register it with `registerWidgetDialog(name, mount)` to have the shell open it by name.

## Tokens and styling

One `<style>` element per document (`WIDGET_STYLE_ID`), every rule scoped under `.oac-widget`. Colours, spacing, radius and font are `--oac-` custom properties produced by `widgetTokens(theme)` and written inline on the widget root by `applyTokens`; the colours derive from the active `ChartTheme` (`background` stepped for panels, `axisLine` / `paneSeparator` for borders, `axisText` for text, `lineColor` for the accent, `upColor` / `downColor` for buy and sell), so the chrome and the canvas cannot disagree, and `setTheme` rewrites them. Names: `bg`, `panel`, `panel-2`, `elev`, `elev-2`, `elev-3`, `bd`, `bd-soft`, `bd-hover`, `tx`, `tx-strong`, `mut`, `faint`, `acc`, `acc-2`, `on-bg`, `on-bd`, `ring`, `ring-soft`, `buy`, `sell`, `amber`, `danger`, `scrim`, `shadow`, `sb-thumb`, `sb-thumb-hover`, `font`, `mono`, `fs`, `radius`, `rail-w`, `topbar-h`, `status-h`, `ctl-h`. Because the tokens are inline declarations, a host stylesheet override needs `!important` (`#terminal .oac-widget { --oac-font: ... !important; }`); override tokens, never internal class names. Icons come from the draw tier (`iconSprite`, `iconUse`, `chromeIconSvg`), so the rail, its flyouts and the armed cursor share one glyph source. The chrome meets the UI standard in [themes-and-styling](themes-and-styling.md#host-chrome-the-ui-standard) by construction.

### Content Security Policy

Pass the host's fresh response nonce as `createWidget(container, { styleNonce: requestNonce })`. The widget and dialogs use one sheet per document, with the `.nonce` IDL property assigned before CSS is filled or the element is inserted. The helper is `injectWidgetStyles(doc, extra?, nonce?)`; existing two-argument calls still work.

An illustrative style policy is `style-src-elem 'nonce-RESPONSE_NONCE'; style-src-attr 'unsafe-inline'`, where `RESPONSE_NONCE` is the same unpredictable value generated for this response. The nonce authorizes the stylesheet; inline theme/layout styles need a separately considered attribute policy. This is not a complete policy for scripts or other resources.

An empty or whitespace-only SSR `<style id="oac-widget-css" nonce="...">` is filled in place, retaining the existing nonce even if the option differs. Put its nonce in the original HTML to avoid a parser CSP violation before hydration. Populated host CSS and its nonce are preserved unchanged; if supplying that sheet yourself, include `WIDGET_CSS`, `DIALOG_CSS` and `OBJECTS_PANEL_CSS`. Read a connected element's `.nonce`, since the browser can hide its content attribute.

## Custom rail tools

`registerDrawingTool` from `openalgo-charts/draw` **before** `createWidget`, then name the id in `rail.tools` (and `rail.favorites` to pin it). The rail reads the registry once when it builds: an id it cannot find is not shown, and an unknown favourite is dropped. A custom id appears in the rail only where `RAIL_GROUPS` places it, so a tool outside every group is reachable by pin, chord or `draw.setTool`. The rail labels the button with the tool's `name`; a glyph is drawn when `DRAWING_TOOL_ICONS` has the id. A tool's `shortcut` is bound through the widget keymap and listed in the `?` panel; a conflicting binding is reported, not silently overridden. Its `settings` schema decides what the properties dialog shows, so a control exists only for a field the tool's `draw` reads.

## Packaging facts

- `package.json` `exports['./widget']`: `types: ./dist/widget/index.d.ts`, `import: ./dist/openalgo-charts.widget.mjs`. Listed in `sideEffects` (importing registers the dialogs).
- `rollup.config.js`: `openalgo-charts` and every `openalgo-charts/<tier>` are external for tier builds and emitted as sibling paths (`./openalgo-charts.mjs`, `./openalgo-charts.draw.mjs`), so `dist/` serves with no import map. The widget must never inline the base or the draw tier; `check-dts.mjs` fails a build whose `dist/widget/index.d.ts` declares `Chart` or `DrawingController`.
- `.size-limit.json`: `Widget tier` row (the bundle alone, 42 kB budget) and `Widget terminal` row (base + draw + indicators + widget, 173 kB budget); `Everything` includes the widget. Measure with `npm run size`; never quote from memory.
- The standalone IIFE is base-only and cannot host the widget. Use native ESM from `dist/`.

## Pitfalls

- **Expecting the engine to have grown a UI.** Only `openalgo-charts/widget` has one. `createChart` still returns a bare canvas chart.
- **Deep-importing the widget or the draw tier.** Two `DrawingController` classes, two tool tables, `widget.draw` not assignable to your variable. Package specifiers only (hub rule 6).
- **An indicator picker that is empty.** The indicators tier was not imported. `import 'openalgo-charts/indicators'`.
- **Container with no size.** Same as `createChart`: give it a height before the call.
- **Two widgets sharing one persistence namespace.** Pass a distinct string to `persist` for each.
- **An interval code the registry does not know.** `interval`, `intervals` and `setInterval` throw `UnknownIntervalError`; register the code first.
- **Rendering the widget from framework state.** Create in a mount effect, hold in a ref, `destroy()` on cleanup.

## Related

[core-api](core-api.md) · [drawing-tools](drawing-tools.md) · [settings-and-menus](settings-and-menus.md) · [indicators](indicators.md) · [themes-and-styling](themes-and-styling.md) · [bundling-and-tiers](bundling-and-tiers.md) · [react-integration](react-integration.md) · [pitfalls](pitfalls.md)

## Shared loading in 2.1.6

`WidgetOptions.loading?: DataLoadingOptions` configures the base controller.
`Widget.dataController` is `DataLoadingController | null`, null without a feed.
The widget binds history/paging/stream updates, observable chart and study statuses,
Retry controls and context propagation. Same-context reload preserves the visible
time anchor; only source changes reset to the preferred initial window.
`dataController.setPaused(true)` fences display writes for a custom replay owner.
See [host-integration](host-integration.md) for unmount and replay ordering.

## Branding and watermark defaults (2.1.9)

The widget inherits `ChartOptions.branding` and `ChartOptions.watermark`. Its existing
symbol/interval changes update `chart.setDataContext`, which supplies automatic watermark
text. No second text store or manually attached logo is needed. The default corner mark
is visible on both layouts, while the background watermark starts off. Appearance settings
operate through the same chart schema and chart state used by bare-chart hosts. See
[primitives-and-plugins](primitives-and-plugins.md#chart-branding-and-optional-text-watermark-219)
for the APIs, migration and interaction checks.
