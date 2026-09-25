# Widget tier

*When to read this: the user wants a chart with a toolbar, a drawing rail, dialogs or shortcuts without writing that chrome; or asks whether the library "has a UI"; or is embedding one of the widget's dialogs in a host of their own.*

Source of truth: `src/widget/index.ts` (the export list), `src/widget/widget.ts` (options, handle, state), `src/widget/mobile.ts` (responsive chrome), `src/widget/context.ts` (the context, the bus, storage, the overlay stack, the dialog registry), `src/widget/keymap.ts`, `src/widget/rail.ts`, `src/widget/topbar.ts`, `src/widget/statusline.ts`, `src/widget/toast.ts`, `src/widget/tokens.ts`, `src/widget/styles.ts`, `src/widget/form.ts`, the dialog modules under `src/widget/dialogs/`, and `dist/widget/index.d.ts` once built. Packaging: `rollup.config.js`, `package.json` (`exports['./widget']`), `.size-limit.json`, `scripts/check-dts.mjs`, `scripts/check-shake.mjs`.

## What it is

`openalgo-charts/widget` is one of nine tiers and the only one that builds DOM. `createWidget(container, options)` returns a `Widget` that owns a `Chart`, a `DrawingController`, and the chrome around them: top bar (symbol box, interval pills, chart type, indicators, capture, settings, theme), drawing rail, status line, the settings dialog, the indicator picker and per-indicator settings, drawing properties, a level editor for the fib and gann family, an in-place text editor for the text tools, a right-click menu, a keymap with a `?` shortcuts panel, toasts, one injected stylesheet, and optional layout persistence.

**The engine still ships no DOM.** Rule 12 of the hub skill stands for `openalgo-charts` and the seven other DOM-free tiers. The widget is the exception by design: it is a host, packaged, and it drives the engine only through the public API (`createChart`, `DrawingController`, `chartSettingsSchema`, `drawingSettingsSchema`, the `contextmenu` event, the registries). Enforced by the ESLint tier ACL (nothing under `src/` except `src/widget/` may import it; the widget reaches the engine and the draw tier only through `openalgo-charts` and `openalgo-charts/draw`), by `npm run shake` (a chart-only import is asserted free of the `oac-widget` CSS scope), and by the size rows.

## Setup

From 2.5.2, chart-owned event markers open `EventDetailsPopup` automatically.
Use `WidgetOptions.eventDetails` for its detail loader, labels and formatter, or
`eventDetails: false` for host-owned event UI. The default formatter uses the
chart's current timezone and widget locale. Event data is supplied through
`widget.chart.setEvents()`, with optional groups and clustering controls.
Symbol changes, replaced events and widget disposal close the popup and cancel
pending detail loading. See the timeline section in `primitives-and-plugins.md`.

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

`container` is an `HTMLElement`, a CSS selector, or an element id and must exist before the call. Give it a real height for rendering; since 2.1.3 an initially hidden chart can receive data and apply its pending initial view when layout reports a usable width. See [host-integration](host-integration.md#hidden-charts-and-preferred-views). The widget imports `openalgo-charts` and `openalgo-charts/draw` itself; the indicator tier is the host's import because not every terminal wants 105 indicators.

Importing the module touches no DOM; only `createWidget` does (it injects the stylesheet and builds the root then). Import it anywhere, call it once the container exists. `npm run skills:coverage` imports the built tier under Node and fails on a module-scope `document` access.

## Exports

### Translation contract (`localization.ts`)

`widgetText(ctx, key, values?)` resolves typed English source messages, interpolates
named values once and falls back for missing, blank, malformed or throwing host
translations. `WidgetBuiltinMessage`, `WidgetMessageKey`, `WidgetMessageValues`,
`WidgetMessageParameters`, `WidgetTranslator` and `WidgetTranslationOptions` are
the exported types. `WidgetOptions.translate`, `WidgetContext.translate` and
`AlertUiOptions.translate` share the optional synchronous callback. The callback
receives `(key, fallback, values)` and returns a translated template or undefined.

Generated metadata uses `schema.*` keys with descriptor text as fallback.
`FormTranslationOptions` adds a stable `scope` for `controlsFromInputs` and
`controlsFromFields`; `FormOptions.translate` localizes form furniture. Symbol and
interval codes, user alert/drawing text, object names, configured branding and
provider errors remain literal. `locale` independently formats status-line
numbers. Recreate a widget to change every mounted control's language.
See [widget localization](../../../../docs/widget-localization.md) for key shapes,
fallback rules and async persistence guidance.

The existing `WorkspaceRepository`/`WorkspaceStorage` API supplies asynchronous
account persistence. Keep each repository's namespace fixed, create another for
an account change, and fence stale restores in the host. Widget `persist` remains
synchronous preference storage. Do not put credentials in portable documents.

`WidgetOptions` and `ContextMenuHooks` also accept `tradingCapabilities?:
TradingCapabilitySource`, `tradingMode` and `tradingLocked`. Unsupported order
routes are hidden; replay and host selection locks disable placement. Callbacks
recheck capabilities, replay and chart context immediately before `onOrder`.
Throwing capability/lock providers refuse the action. Execution remains host-owned.

Everything `src/widget/index.ts` exports at runtime. The shell (`createWidget` and the handle) is what a host uses; the rest is exported so a host that wants one piece of the chrome and its own for the rest can have it, or so a dialog module of the host's own can register with the shell.

### The shell (`widget.ts`)

| Export | Kind | Purpose |
|---|---|---|
| `createWidget(container, options?)` | function | The one call. Returns a `Widget`. |
| `WIDGET_TIER` | const `'widget'` | The tier's identity constant, like `DRAW_TIER`. |
| `stripView(state)` | function | A detached `WidgetChartState` view patch without viewport, manual ranges or ratio locks on any scale. It enables auto-fit while retaining formatting and declared fixed ranges when the layout lands on another symbol or interval. |
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
| `mountTopbar(ctx, host, opts)` | function | Symbol box with search, interval pills, chart type menu, Indicators, Go to (with `onGoTo`), Objects, capture, settings, theme. Returns a `TopbarHandle` (`refresh`, `destroy`). |
| `openMenu(ctx, anchor, rows, opts?)` | function | A popover menu under `anchor`, with an optional filter box; the chart type menu and the symbol results share it. Returns the closer. |
| `chartTypeChoices()` | function | The registered chart types a user can pick for the instrument (the registry minus histogram-family internals). |
| `chartTypeLabel(id)` | function | A label from `CHART_TYPE_LABELS`, else the id. |
| `CHART_TYPE_LABELS` | const | Labels for the built-in chart types. |
| `intervalLabel(code)` | function | `'1d'` as `D`, `'1w'` as `W`, minute and hour codes as written, a registered calendar code upper-cased. |
| `downloadText(doc, filename, text, mime)` | function | Hand text to the browser as a file; false when the runtime cannot. |
| `captureName(symbol, interval, now?)` | function | `SYMBOL-5m-2026-01-31-09-15`, filename-safe. |
| `SEARCH_DEBOUNCE_MS` | const `150` | Quiet before `symbolSearch` runs. |
| `TopbarOptions`, `TopbarHandle`, `TopbarState`, `SymbolMatch`, `SymbolSearch`, `MenuRow`, `MenuOptions` | types | |

The Capture menu includes **Download chart data (CSV)**, using the base
`exportChartDataCsv` API. It captures source identity when opened and refuses a
changed, empty or loading source. The widget supplies source readiness; custom
`mountTopbar` hosts can supply `TopbarOptions.dataAvailable()` for their own loading
boundary. Active replay exports only installed rows. File failures surface in
the status line and download resources are released after handoff or failure.

### Status line, toasts, tokens, styles

| Export | Kind | Purpose |
|---|---|---|
| `mountStatusline(ctx, host, opts?)` | function | Symbol, interval, O H L C, change, volume, the hovered bar's time, bar count, timezone; a transient message slot. Returns a `StatuslineHandle` (`setSymbol`, `setMessage`, `destroy`). |
| `priceDigits(chart)` | function | Decimals for the readout: the pane's own precision floored at `MIN_PRICE_DIGITS`. |
| `mountAccountSummary(ctx, host, { source, locale? })` | function | Account summary: the selected account (a menu switches it), an Analyzer tag for the sandbox ledger, equity, margin used and available, and a Stale or error state. `source` is an `AccountStateSource`, usually the trade tier's `AccountManager`. Read-only apart from switching; it has no order controls. An `unsupported` source renders disabled (`aria-disabled`, class `is-disabled`) with the provider's reason visible. Mounted before `.oac-statusline__tz` when the host has one. In a narrow status line (a container query on the row) the hover time yields first, then margin used, equity and available drop out, and below 860 px the summary moves beside the title so the account and its tag are never the part that is clipped; the picker's tooltip keeps the figures. Returns an `AccountSummaryHandle` (`el`, `refresh`, `destroy`). |
| `ACCOUNT_SUMMARY_CSS` | const | The summary's rules, part of `WIDGET_COMPONENT_CSS`. |
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
| `AccountSummaryOptions`, `AccountSummaryHandle`, `StatuslineOptions`, `StatuslineHandle`, `Toaster`, `ToastHandle`, `ToastKind`, `ToastOptions`, `WidgetThemeName`, `WidgetTokens`, `Rgba` | types | |

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
| `mountContextMenu(ctx, anchor?, { event?, hooks? })` | function | The right-click menu for the chart's `contextmenu` payload: trade rows when `onOrder` is given (limit and stop rows only over the price pane, where the pointer's price is the instrument's; a study pane offers the market rows alone), drawing actions on a drawing, scale modes on a price axis, `Move pane up` and `Move pane down` (row ids `pane-up`, `pane-down`, greyed at an edge, and greyed with the note "price pane stays on top" where a chart built without `movablePrimaryPane` would refuse the swap) over any pane when there are two or more, the price pane included, `Collapse pane` or `Expand pane` (row id `pane-collapse`) over a study pane in any slot, paste, fit, indicators, settings. A menu raised from a button names no pane and has no pane rows. A move or a collapse is saved with the layout and emitted as a `layout` event with reason `paneMoved` or `paneCollapsed`. |
| `mountAlertEditor(ctx, anchor?, opts?: AlertEditorOptions)` | function | Draft editor seeded by `source` or editing `alertId`. Save validates source identities, finite bounds and expiry in the labelled chart timezone. Cancel never arms an alert. |
| `mountAlertsPanel(ctx, anchor?, opts?: AlertsPanelOptions)` | function | Live alert list with lifecycle, scope, timing, availability, last delivery, edit, enable/disable and delete. Both options types accept `onClose`. |
| `attachContextMenu(ctx, hooks?)` | function | Subscribe to the chart's `contextmenu`, `preventDefault`, mount the menu. Returns the unsubscriber. `createWidget` does this itself. |
| `contextMenuEntries(ctx, event, hooks)` | function | The `MenuEntry[]` the menu is built from, for a host composing its own. |
| `WIDGET_DIALOGS` | const | Registry mounts: `settings`, `indicatorPicker`, `indicatorSettings`, `drawingProperties`, `contextMenu`, `levelEditor`, `textEditor`, `alertEditor`, `alerts`. Registered on import. |
| `renderForm(host, controls, opts)` | function | One control renderer for every generated form: switch column, label, control column; `colorPair` on one row. Returns a `FormHandle`. |
| `controlsFromInputs(inputs)` | function | `ChartSettingsInput[]` (the engine's settings schema) to `FormControl[]`. |
| `controlsFromFields(fields)` | function | A drawing tool's `SettingsField[]` to `FormControl[]`. |
| `mountIndicatorInputControls(ctx, options)` | function | Adds symbol lookup and chart picking to an existing indicator form. Returns `IndicatorInputControlsHandle` with `cancelPick`, `refresh` and `destroy`. |
| `IndicatorInputControlsOptions`, `IndicatorInputControlsHandle` | types | Native typed-field host actions. |
| `SettingsDialogOptions`, `IndicatorPickerOptions`, `IndicatorSettingsOptions`, `IndicatorSettingsTab`, `DrawingPropertiesOptions`, `LevelEditorOptions`, `TextEditorOptions`, `TextEditorHandle`, `ContextMenuHooks`, `ContextMenuOptions`, `MenuEntry`, `MenuItem`, `OrderRequest`, `PanelHandle`, `FormControl`, `FormKind`, `FormOptions`, `FormHandle` | types | |

`OrderRequest` is `{ side: 'BUY' | 'SELL'; type: 'MARKET' | 'LIMIT' | 'SL'; price: number | null; paneIndex: number }`; `price` is null for a market order. Otherwise it is the pointer's price, not snapped to the instrument's tick or `TickSchedule` (the widget knows neither), so round it, for example with `validatePrice`, before sending.

`FormKind` includes `symbol`, `session`, `multiline`, `price` and `timestamp`.
`FormHandle.validate()` checks drafts and `setError(key, message)` reports a
field error without committing invalid settings. Prices and timestamps preserve
their numeric value; timestamps are absolute UTC seconds, including fractions.
An ordinary `time` field retains its existing clock-string contract.

`IndicatorInputControlsOptions` provides `instance`, `inputs`, `panel`,
`field(key)` and atomic `onPatch(patch): boolean`. Optional `current()` fences
stale dialogs; `suspend()` lets a custom host hide its modal while picking.
The built-in `OverlayStack.suspend(panel)` releases the focus trap and scrim
until its idempotent resume callback runs. Destroy the controls with the form.
Configured lookup is available as `WidgetContext.symbolSearch`. A selected
symbol and its `exchangeKey` commit together; a missing exchange defaults to
an empty string. Without lookup, manual symbol entry remains available.
Price picks resolve the study's actual pane and scale, including hidden scales;
a mixed-scale study needs an explicit target. Drawing placement blocks picking.
Context changes, study removal and chart destruction cancel pending controls.

Alert panels use optional `WidgetContext.alerts`, supplied automatically by
`createWidget`. Custom contexts without a controller show an unavailable reason.
Draft numeric forms set `FormOptions.preserveInvalidNumbers` so an empty field
stays empty and Save can report it. Live settings forms retain their previous
behavior of restoring the last valid numeric value. Alert expiry is entered in
the chart timezone captured and labelled when the editor opens; changing the
chart timezone does not reinterpret the draft. New alerts default to two chart
calendar months ahead, clamped to the last day of the target month. Clearing the
field means no expiry. Editing another field preserves the stored UTC instant,
including its seconds. Programmatically added alerts retain their existing
defaults; the two-month prefill belongs to the editor.
Context changes or removed anchors prevent stale drafts from being saved.

Text, number, select and date fields share one control column. Their height
uses `--oac-ctl-h`, and their outer corners and button corners use `--oac-radius`.
Color swatches stay compact. Theme overrides should target these tokens.

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
| `movablePrimaryPane` | `boolean` | `false`, as in the engine | Pass `true` to let a trader move the price pane below its studies; the widget's own chrome (pane menu, status line, alerts, Objects panel) follows it wherever it sits. Leave it off while host code drives `widget.chart` with an explicit pane `0` for the price, or drop those zeros first. `createChartGrid` hands it to every chart it builds. See [scales-and-panes](scales-and-panes.md#moving-the-price-pane-opt-in). |
| `account` | `AccountStateSource` | none | Account summary in the status line (see `mountAccountSummary`). Omitted shows nothing; a source whose provider declares no accounts shows disabled with the reason. Hidden with the status line (`statusline: false`, and the compact mobile controls, which hide the status line). It only reads and switches accounts. |
| `styleNonce` | `string` | none | Response CSP nonce for the shared widget and dialog stylesheet. Style-attribute policy remains the host's responsibility. |
| `keyboardRoute` | `() => boolean \| undefined` | none | For hosts with several widgets: false silences this widget's chords and chart shortcuts, true sends them here, undefined keeps the usual rule (pointer or focus, or always for a `shortcuts` scope of `global`). Applies to a `ShortcutManager` instance too, shared or not. The chart grid sets it per cell. |

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
widget.alerts;                       // the owned AlertController, including drawing anchors
widget.series;                       // the primary SeriesApi, retained by setChartType
widget.symbol(); widget.exchange(); widget.interval(); widget.chartType(); widget.theme();
widget.setSymbol(symbol, exchange?);
widget.setInterval(code);            // throws UnknownIntervalError for a code the registry lacks
widget.setChartType(id);             // registered renderer; retains handle, data, styles, scale and markers
widget.setTheme('dark' | 'light' | theme);
widget.openSettings();               // false when no dialog is registered under 'settings'
widget.openIndicatorPicker();
widget.openObjects();                // false after destruction; focuses the existing panel when open
widget.openAlerts();                 // desktop Alerts and mobile More use the same live list
widget.openDateNavigation();         // the Go to panel; false after destruction
await widget.goTo({ from, to? });    // DateNavigationResult; loads older history first
widget.getState();                   // WidgetState; rejects nonportable alert payloads
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

Search matches name, kind and pane labels (displayed starting at 1, with the price
pane named **Price pane** in any slot, in the section headings and the move targets alike). Live updates
preserve search and action-button focus. Rows show visibility, drawing lock and
selection, and external-indicator data status. Only supported actions appear; an
action returning `false` or throwing reports through the existing toast. No primary
source removal control is offered. Settings reuse the widget's current chart,
indicator and drawing editors. Drawing actions use existing undo history.

Each pane section lists its stack in draw order, back to front (`objects.stack(pane)`),
a group at its first member's place and rows outside the stack after. A drawing row
notes **Behind series** or **Above** and the row it sits on. Dragging a row onto the
upper half of another puts it under that row in paint order, the lower half over it;
`dragover` accepts only a drop `objects.canPlace` allows, marking the row
`is-drop-before` / `is-drop-after`, so an unpaintable drop is refused before release.
**Earlier** and **Later** step through the same order with `objects.place` (a source or
study steps between whole slots); rows outside the stack keep `reorder`. A drop onto a
row of another pane moves the row there first. A custom `objects` model without `stack`
keeps the list order.

Study policies reach the panel the same way: an unlisted study has no row, and a
protected one offers only the actions its policy allows. Elsewhere the widget greys the
context menu's settings and remove rows with the note "protected", greys the indicator
picker's remove button, declines the settings dialog with a toast ("{name} settings are
protected"), and leaves unlisted studies out of the picker's running list and the alert
source lists. See [study policies](core-api.md#study-policies).

Drawing policies reach the panel through the inventory: an unlisted drawing
(`policy.listed: false`) has no row, a read-only one (`policy.editable: false`)
has no Hide, Lock or Remove, and an unselectable one no select. Elsewhere in the
widget a read-only selection keeps its copy and duplicate actions while every
edit control is drawn disabled with the note "read-only": context menu rows, the
properties dialog (fields, lock, visibility, delete, restore defaults), the rail's
lock, eye and trash, and the mobile selection bar. The text and level editors
decline to open on it. In a selection that mixes the two, Cut, Delete and the trash
tooltip count only the drawings they take. **Group selected** is off for a
selection of read-only drawings only, and the alert editor's drawing picker leaves
unlisted drawings out. See [drawing policies](drawing-tools.md#drawing-policies).

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

`createAlertUi(container, options: AlertUiOptions): AlertUi` mounts the shared
alert editor and list over an existing chart. Supply the host-owned `chart`,
`draw` and `alerts` controllers and a positioned container with a real size.
It exposes `openList`, `openEditor`, `close`, `isOpen`, `setTheme` and `destroy`.
`onOpenChange` follows the whole nested dialog stack, so capture-phase host
shortcuts can stay suspended until every dialog closes. `theme`, `chartTheme`,
`locale` and `styleNonce` are optional. Destroying this UI leaves its chart and
controllers alive; destroying the chart disposes the UI automatically.
Delivery and persistence remain the host's responsibility. Observe
`alert:triggered` for delivery and `alerts:checkpoint` plus lifecycle events for
persistence. Restore the complete chart document once, with the drawing and
alert controllers already attached. Do not restore drawings again afterward.

- `package.json` `exports['./widget']`: `types: ./dist/widget/index.d.ts`, `import: ./dist/openalgo-charts.widget.mjs`. Listed in `sideEffects` (importing registers the dialogs).
- `rollup.config.js`: `openalgo-charts` and every `openalgo-charts/<tier>` are external for tier builds and emitted as sibling paths (`./openalgo-charts.mjs`, `./openalgo-charts.draw.mjs`), so `dist/` serves with no import map. The widget must never inline the base or the draw tier; `check-dts.mjs` fails a build whose `dist/widget/index.d.ts` declares `Chart` or `DrawingController`.
- `.size-limit.json`: `Widget tier` row (the bundle alone) and `Widget terminal` row (base + draw + indicators + widget); `Everything` includes the widget. Read the budgets there and measure with `npm run size`; never quote either from memory.
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


## Chart controls added in 2.5.3

`WidgetOptions.panels` defaults to true: Data and Objects share a closed-by-default
resizable dock, switching to an overlay sheet on narrow hosts. `panels: false`
keeps the Objects popup and omits Data. `Widget.openDataWindow()` opens readings;
`openObjects()` opens its neighbour. Optional `WidgetState.panels` saves selected
view and width; old records stay valid. No saved-state version bump is needed.

- `readDataWindow(chart, time?, options?)` returns `DataWindowSnapshot` with
  `DataWindowSection` and `DataWindowRow` records. `DataWindowOptions` carries locale
  and translation. Values are exact-time OHLC/volume/OI and plot readings, including
  plot offsets and candle-plot close columns. Absence is null, formatted Unavailable.
- `mountDataWindow(context, host)` returns `DataWindowHandle` with refresh/destroy.
  It observes `crosshair:readout`, data, object and timezone changes without replacing
  a host's crosshair callback; hover does not copy the whole history each time.
- `mountPanelDock(context, stage, options)` returns `PanelDockHandle`. Types are
  `PanelDockId`, `PanelDockState`, `PanelDockContent`, `PanelDockOptions` and
  `PanelDockHandle`. Content factories mount into their host and return destroy().
  `sanitizePanelDockState` accepts unknown stored input and bounds the width.
- `createObjectsPanelContent` returns `ObjectsPanelContent` (element, initialFocus,
  destroy) for a host panel without popup furniture. `mountObjectsPanel` is retained.
- `mountSymbolPicker` uses `SymbolPickerOptions` and returns `SymbolPickerHandle`.
  The existing `SymbolMatch` adds optional assetClass, iconUrl and contractGroup
  with explicit contract SymbolMatch records. `SymbolSearch` stays query-only.
  `safeSymbolIconUrl` accepts HTTPS and root-relative URLs, rejects credentials.
  Async queries are fenced by query, chart context and mounted lifetime.
- `mountQuickEntry` uses `QuickEntryOptions` and returns `QuickEntryHandle`. The
  host's enabled() decides chart ownership. `typingNavigation: false` opts a widget
  out. Existing shortcuts, overlays, drawing placement, editors, modifiers and IME
  retain precedence. Bare numeric input means minutes; invalid intervals stay open.
- `createColorPicker` uses `ColorPickerOptions`, returns `ColorPickerHandle`, and
  preserves existing alpha. Pass openOverlay from the context inside a dialog.
  `FormOptions.openOverlay` threads the same opener through generated forms;
  `FormHandle.destroy()` disposes child controls. Destroy before removing a form.
- The indicator picker lists running instances and removes only the chosen ID.
- `AlertUi.context` exposes the context for hosts reusing other widget controls.

`DATA_WINDOW_CSS`, `PANEL_DOCK_CSS`, `SYMBOL_PICKER_CSS`, `QUICK_ENTRY_CSS` and
`COLOR_PICKER_CSS` can be included individually. `WIDGET_COMPONENT_CSS` combines
all component styles, including dialogs and indicator-picker additions. Include it
beside `WIDGET_CSS` when managing styles yourself; apply widget tokens to the root.
createWidget/createAlertUi inject the complete component styles automatically.

## Date and range navigation (2.5.4)

`widget.goTo({ from, to? })` shows a date, or an explicit range, in UTC seconds.
It waits for a load in flight, loads older history through
`dataController.loadMore(until)` until the request is covered, then places it
with `chart.setVisibleLogicalRange`. A date is centred at the current zoom, and
kept left of the newest bar's normal margin; a range fills the plot, centred at
the widest bar spacing when short. Placement runs after the accepted load, so
later live bars and refreshes keep its anchor. A newer request, a symbol or
interval change, `restoreState` onto another context, or `destroy` settles the
promise `{ status: 'cancelled' }` without moving the view, and so does closing the
panel while its request loads. So does a pan or zoom while an older page loads,
whether it comes from a gesture, a key, a linked chart or the host's own
`setVisibleLogicalRange`: the view is wanted elsewhere, and the older bars still
arrive without moving it. The widget's own move that keeps the bars in view still
when a refresh lands does not count; nor does a move of the blank chart during a
first load, which that load's arrival resets. The top bar's **Go to** button and
the mobile **More** sheet open the panel (`openDateNavigation()`); on a tick or
volume interval both are greyed with the reason and `openDateNavigation()` returns
false. Daily and longer intervals show date fields only, since a time cannot change
which bar a date names. The panel closes when the interval or the chart timezone
changes under it, since its fields and hint were built for both, and it clears its
loading line when its request is cancelled.

`DateNavigator` is the DOM-free coordinator behind it, for custom hosts:

```ts
import { zonedStringToUtcSeconds } from 'openalgo-charts';
import { DateNavigator, openDateNavigation } from 'openalgo-charts/widget';

const navigator = new DateNavigator({
  chart: () => currentChart,                  // or a Chart; re-read after each load
  // Prepend bars reaching `time` and say what happened. loadMore never rejects:
  // it records a failure in the state, so read the state rather than assume progress.
  loadHistory: async time => {
    const first = controller.bars()[0]?.time;
    await controller.loadMore(time);
    const state = controller.getState();
    if (state.historyStatus === 'error') throw state.historyError;
    if (state.historyStatus === 'limited') return 'limited';
    if ((controller.bars()[0]?.time ?? Infinity) < (first ?? Infinity)) return 'loaded';
    return state.hasMore === false ? 'exhausted' : 'empty';
  },
});
// A date typed on the chart's own clock (IST unless the host set another zone).
const from = zonedStringToUtcSeconds('2024-01-15', currentChart.timezone());
const result = await navigator.goTo({ from });
openDateNavigation(ctx, anchor, {
  navigate: target => navigator.goTo(target),
  cancel: () => navigator.cancel(),           // the panel was closed while loading
});
```

The navigator cannot tell the host's own view moves from the user's, so a custom
host that wants a pan or zoom to drop a loading request watches for it around its
loader, as the widget and the reference host do, and skips the moves it makes
itself for arriving bars:

```ts
loadHistory: async time => {
  const moved = () => { if (!keepingViewForData) navigator.cancel(); };
  const offs = [chart.on('pan', moved), chart.on('zoom', moved)];
  try { await controller.loadMore(time); } finally { for (const off of offs) off(); }
  // ...then read the state as above
},
```

| Export | Kind | Purpose |
|---|---|---|
| `DateNavigator` | class | `goTo(target)`, `cancel()`, `destroy()`. One request at a time; a new one cancels the previous. |
| `DateNavigatorOptions` | type | `chart` (a `Chart` or a getter), optional `loadHistory(time, signal)`, optional `interval()` (default: the data context). |
| `DateNavigationTarget` | type | `{ from, to? }`; `to` is inclusive (bars opening at or before it, a bar a day or longer counted from its local midnight). |
| `DateNavigationResult` | type | `{ status, from?, to?, history?, clipped?, error? }`; `from`/`to` are the placed bars' open times. |
| `DateNavigationStatus` | type | `placed`, `partial`, `no-data`, `unsupported`, `invalid`, `cancelled`, `error`. |
| `HistoryReach` | type | What one loader call achieved: `loaded`, `empty`, `exhausted`, `limited`, `unavailable`. |
| `openDateNavigation(ctx, anchor, options)` | function | The compact panel (Date or Range, date and optional time in the chart timezone). Returns `PanelHandle`; closes once placed and keeps any other outcome's reason in place. |
| `DateNavigationDialogOptions` | type | `navigate(target)`, optional `cancel()` (the panel was dismissed, or closed by an interval or timezone change, while its request loaded; not called when its chart was destroyed), optional `pending: { target, result }` (show and report a request already under way, for a host whose load rebuilt the chart and closed the panel that started it), and `onClose()`. A closed panel reports nothing. |
| `DATE_NAVIGATION_CSS` | const | The panel's styles; part of `WIDGET_COMPONENT_CSS`. |

Rules the coordinator applies:

- Bars of a day or longer count from the local midnight of their first day, so a
  date lands on its own daily bar whether the feed stamps midnight or the session
  open. They end at the local midnight after their last day, so a day of 23 or 25
  hours around a clock change keeps its own bar. Shorter bars keep their stamp; an
  instant in an overnight or weekend gap moves to the next session; a range with
  no bar inside it is `no-data`.
- A date names the bar the axis labels with that date. West of UTC a daily bar
  stamped at UTC midnight is the previous evening on the chart's clock, so the
  axis, crosshair and data window label it with the previous date, and that is
  the date that names it. Set the chart timezone to `UTC` for such a feed when its
  bars should read, and be found, by their UTC date.
- Only time-bucketed intervals navigate (fixed and calendar); tick, volume and
  unknown codes are `unsupported`. The view never moves for `no-data`,
  `unsupported`, `invalid`, `cancelled` or `error`.
- `partial` with `history` means the source stopped before the requested start:
  `exhausted` (nothing older), `empty` (inspected windows held nothing; older
  history may exist), `limited` (retention) or `unavailable` (no loader, replay,
  a paused controller). `partial` with `clipped` means the range is wider than the
  plot at its narrowest spacing; its start is in view.
- History is never loaded during replay (`isReplaying(chart)`), and a date beyond
  the replay cursor is `no-data`. A chart linked through `createLinkGroup` follows
  the placement by time, like any other viewport change.
- A loader that reports `loaded` without adding older bars stops the loop as
  `empty`, so a misbehaving host cannot keep it spinning.

## Chart grid (2.5.4)

`createChartGrid(container, options)` returns a `ChartGrid`: one widget per cell on a
rows by columns grid, with splitters, one active cell, linking through the base
`LinkGroup`, and the portable `WorkspacePayload` of `openalgo-charts/workspace`. It is
part of the widget tier, not a new one. Source of truth: `src/widget/grid.ts`.

```ts
import { createChartGrid } from 'openalgo-charts/widget';
import { parseWorkspacePayload } from 'openalgo-charts/workspace';

const grid = createChartGrid('#desk', { feed, symbol: 'RELIANCE', exchange: 'NSE', interval: '5m',
  preset: '2x2', links: { crosshair: true, viewport: true }, persist: 'desk' });
grid.setPreset('1x3');
const report = grid.applyWorkspace(parseWorkspacePayload(fileText)); // { applied, reason? }
```

- `ChartGridOptions` is `WidgetOptions` (every cell's options) minus `keyboardRoute`,
  with its own `feed` (below), plus `preset` (`ChartGridPreset`, default `1x1`), `links` (`LinkOptions`), `compactWidth`
  (default 640 CSS px, 0 off), and grid-level `persist`/`storage`. `symbol`, `exchange`,
  `interval` and `chartType` seed the first cell. Cells default to `mobile: 'never'`,
  because a cell in a split is often narrower than the phone threshold.
- `feed` is one `DataFeed` for every chart, or a function
  `(chart: { id, historyPeriod? }) => DataFeed` called once per chart as it is built, for a
  source that answers by period: the grid keeps each pane's `historyPeriod` (from an
  applied payload, or copied from the active chart when a preset adds charts) and writes
  it back in `getWorkspace()`, but only such a function honours it. Return the same feed
  object for charts that should share one request pool.
- `CHART_GRID_PRESETS`: `1x1`, `1x2`, `1x3`, `2x1`, `3x1`, `2x2` as `[rows, columns]`.
  `setPreset` keeps surviving cells in reading order (same widget instances), builds new
  ones on the active chart's instrument, destroys the rest and resets weights. No span
  editing; spans from a saved payload are drawn and splitters stop where a span crosses.
- `ChartGridCell` (`id`, `widget`, `element`, `row`, `column`, `rowSpan`, `columnSpan`,
  `historyPeriod`);
  `cells()`, `active()`, `setActive(id, { focus })`, `layout()` (`ChartGridLayout`),
  `linkOptions()`, `setLinks(patch)` (switching symbol or interval on adopts the active
  chart's), `theme()`, `setTheme()`, `compact()`, `restored()`, `destroy()`.
- Events (`ChartGridEvents`, `ChartGridEventName`): `active` (from `setActive`, and when
  a preset or an applied workspace moves the active chart), `layout` (`preset`,
  `weights`, `workspace`, `compact`), `links`, `theme`.
- Persistence (`persist`): preset, link, theme, active chart, instrument, keyboard
  splitter and drawing add or remove changes are written before the task ends. Pans,
  zooms and drags are debounced (`SAVE_DEBOUNCE_MS`) and flushed when the page hides
  (`visibilitychange`), on `pagehide` and on `destroy`. A stored desk that fails to
  restore (a study or chart type registered later, say) is not overwritten: the grid
  falls back to `preset`, toasts the reason on the active chart, and `restored()`
  returns `{ applied: false, reason }` (null when nothing was stored). The stored desk
  stays until the user changes the grid; data loads and focus do not count.
- Keyboard: only the active cell answers. Pointer down or focus inside a cell makes it
  active. A key pressed with the focus on the page body, while the pointer is over the
  grid, goes to the active chart; a focused splitter or tab keeps its arrow keys.
- `WidgetOptions.keyboardRoute` is the hook behind that: `() => boolean | undefined`.
  False silences the widget's chords and its chart's shortcuts, true routes them there,
  undefined keeps the usual rule: pointer or focus, or always when the host's
  `shortcuts` scope is `global`. A `ShortcutManager` instance is routed too; one
  instance shared by several widgets (every grid cell gets the same options) is wrapped
  per widget, so rebinding it still reaches them all. A host with several plain widgets
  can use it.
- `getWorkspace()` returns a JSON `WorkspacePayload` that `parseWorkspacePayload` accepts:
  slots, weights, preset, active pane, sync, per-pane chart state, `settings['widget.theme']`,
  rail magnet/stay and `historyPeriod` when the chart has one. `volume` is written false
  and `comparisons` empty: a widget draws neither. `applyWorkspace` checks the whole
  payload first (size, slots, overlap, weights, intervals, chart types, studies, text
  history periods, no comparisons, linked symbols or intervals that agree),
  builds and restores every new cell off screen, and on the first failure destroys them,
  aborting their history requests, and returns `{ applied: false, reason }` with the old
  cells untouched. Pass untrusted input through `parseWorkspacePayload` first.
- Linked viewports ignore moves caused by freshly loaded bars, so a follower on another
  interval is not squeezed; views converge on the next pan or zoom. The linked window is
  kept as times, read from the chart last navigated, and moves with that chart's new
  bars. After a linked navigation a resize keeps each chart on the window it showed: the
  engine keeps the right edge, so a chart following new bars keeps following, and the
  grid puts the span back rather than the bar width, so charts of different widths still
  agree. A chart shown from behind the compact tabs takes the linked window. The window is
  forgotten when its chart changes instrument or is removed, and when viewport linking
  is switched on, which starts without one until the next pan or zoom. A linked symbol
  is the symbol and exchange together, so a change of exchange alone (one ticker on NSE
  and BSE) reaches the followers.
- Below `compactWidth` only the active cell shows, with a tab strip to switch; splitters
  hide. `CHART_GRID_CSS` is part of `WIDGET_COMPONENT_CSS`.

## Watchlist and news panels (2.5.5)

Two optional sources for the panel dock, beside Data and Objects. A tab (and the top bar
and mobile More entries) appears only when its source is supplied, and each needs
`panels` on. Sources: `src/widget/watchlist-panel.ts`, `news-panel.ts`, `quote-board.ts`,
`news-reader.ts`.

```ts
import { createWidget } from 'openalgo-charts/widget';
import { WatchlistRepository, createIndexedDbWatchlistStorage } from 'openalgo-charts/workspace';

const widget = createWidget('#chart', {
  feed, symbol: 'INFY', exchange: 'NSE',
  watchlist: { store: new WatchlistRepository(createIndexedDbWatchlistStorage(indexedDB), 'account-7'), quotes },
  news: { feed: newsFeed, pageSize: 20 },
});
widget.openWatchlist(); // false without a watchlist source, with panels off, or after destroy
widget.openNews();
```

- `WidgetOptions.watchlist` (`WidgetWatchlistOptions`): `store` (a `WatchlistStore`,
  usually `WatchlistRepository`), `quotes?` (`QuoteFeed`), `staleAfterMs?` (default
  60000), `pollMs?` (snapshot-only sources, default 15000, 0 off), `formatPrice?(value,
  instrument)`. Choosing a row calls `setSymbol(symbol, exchange)`, and the widget
  supplies the panel's `normalize` as setSymbol's upper-casing, so a lower-case entry is
  the chart's own row and never a second copy of it. `WidgetOptions.news`
  (`WidgetNewsOptions`): `feed`, `pageSize?` (20), `staleAfterMs?` (300000), `maxItems?` (500).
- `PanelDockId` adds `'watchlist'` and `'news'`; `PanelDockOptions` takes optional
  `watchlist(host)` and `news(host)` factories. `sanitizePanelDockState` keeps both ids;
  restoring one on a dock without that source leaves it closed.
- `mountWatchlistPanel(ctx, host, WatchlistPanelOptions)` returns a `WatchlistPanelHandle`
  (`el`, `initialFocus`, `reload()`, `destroy()`), for a custom host's dock as the
  reference host does. A table of the active list: symbol, last, change and percent
  change from the provider's `previousClose`. List select, New, Rename and Delete (inline
  forms, confirm before delete), an Add input (the host's `symbolSearch` when there is
  one; typed text is uppercased and saved on the chart's exchange), and "Add {symbol}"
  for the chart's instrument. `normalize?(instrument)` maps an entry to the instrument
  the host charts for it (default unchanged): adds are saved in that form, an add
  matching a listed entry that way is refused as already listed, and the current-row
  marker and "Add {symbol}" compare through it. Remove per row; Alt+ArrowUp/Down
  reorders in list order with the revision it was computed from, one move at a time so
  a held key lands every step; ArrowUp/Down moves between rows.
- Rows take prices only from `quotes`. Without it every row is `unavailable` and shows
  `n/a`. Row `data-state` is a `QuoteRowStatus`: `loading`, `live`, `delayed`,
  `snapshot`, `stale`, `unavailable`, `error`; the status line reads the
  `QuoteBoardStatus`, and warns that values are stale only when one is on screen. The
  board holds one timer, for the next visible snapshot to age past `staleAfterMs`; a
  row behind a live stream never ages, so an idle board holds none. Only rows an `IntersectionObserver` reports on screen hold a
  stream; a list switch, a hidden page, closing or switching the panel, and `destroy`
  release them. Sorting by header (`WatchlistSort`, `WatchlistSortKey`: `list`, `symbol`,
  `last`, `change`, `percent`; a third click returns to list order) is stable, sinks
  unknowns in both directions, and holds row order while the pointer or focus is in the
  rows. The sort is read from and written to `ctx.storage` (`watchlist-sort`), and kept
  per store in memory as well, so it outlives a panel switch when that storage keeps
  nothing. Conflicts show "The watchlists changed in another session" and reload the store.
- `mountNewsPanel(ctx, host, NewsPanelOptions)` returns a `NewsPanelHandle` (`el`,
  `initialFocus`, `refresh()`, `destroy()`). It follows the chart's `data:context`
  instrument (an interval change is the same instrument), cancels the previous request
  on a switch, and lists headline, source and time in the chart's timezone. A detail
  view shows the summary and "Open article" only for `safeNewsUrl(url)`: absolute http or
  https without credentials, opened with `rel="noopener noreferrer"` and
  `referrerpolicy="no-referrer"`. All provider text is set as text.
- DOM-free controllers, exported for custom hosts: `QuoteBoard` (`setVisible`, `row`,
  `status`, `error`, `subscribed`, `destroy`; `QuoteBoardOptions`, `QuoteRow`) and
  `NewsReader` (`setInstrument`, `refresh`, `loadMore`, `snapshot`, `destroy`;
  `NewsReaderOptions`, `NewsSnapshot` with `refreshFailed`, `NewsStatus`: `idle`,
  `loading`, `ready`, `empty`, `error`). `quoteChange(quote)` returns
  `{ change, percent }` or null without a positive `previousClose`.
- `WATCHLIST_PANEL_CSS` and `NEWS_PANEL_CSS` are part of `WIDGET_COMPONENT_CSS`.
