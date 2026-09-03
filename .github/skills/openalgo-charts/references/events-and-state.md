# Events and state

*When to read this: you are subscribing to chart events, building an app-side legend or toolbar, or saving and restoring a layout.*

## The bus

One untyped bus covers everything (`src/core/chart.ts`).

```ts
const off = chart.on('crosshair:move', (payload) => { /* ... */ });
off();                                  // unsubscribe

chart.once('ready', () => { /* fires exactly once */ });

chart.off('crosshair:move', handler);   // drop one listener
chart.off('crosshair:move');            // drop every listener for the name
```

- `on(event, cb)` returns its own unsubscribe function. `once(event, cb)` also returns one, so a pending one-shot can be cancelled before it fires.
- `emit(event, payload)` is **public**. Any tier — and your own code — can route custom events through the same bus.
- Payloads are typed `unknown`. Cast at the boundary.
- **A throwing listener is swallowed.** Each callback runs in its own `try/catch` so one bad handler cannot break the others or the render loop — which also means your exceptions vanish silently. Log inside your handler.
- The listener set is copied before dispatch, so subscribing or unsubscribing from inside a handler is safe.

## Event catalogue

Every name emitted by the engine, verified against the `emit(` call sites in `src/core/chart.ts`, `src/core/trading-controller.ts`, `src/draw/controller.ts`, and `src/replay/controller.ts`.

| Event | Payload | Fires when |
|---|---|---|
| `ready` | `{}` | Once, on a microtask after the constructor — a subscription on the next line still receives it. |
| `crosshair:move` | `{ time, index, price, bar, point: { x, y }, paneIndex, pressed }` | Pointer moves over the plot. `time`/`bar` are `null` off the data. `pressed` is true while a pointer is down. |
| `crosshair:move` (leave) | `{ time: null, index: null, price: null, bar: null, point: null, paneIndex: null }` | Pointer leaves the plot. Note: no `pressed` key on this payload. |
| `click` | `{ id, price, time, paneIndex, point: { x, y }, viaDrag? }` | A clean click anywhere in the plot. `id` is the hit primitive's `externalId`, or `null` on empty plot. |
| `dblclick` | `{}` | Plot double-clicked. Also resets the scale unless a drawing tool is armed. |
| `hover` | `{ id }` | Pointer enters (`id` = `externalId`) or leaves (`id` = `null`) a hit-testable primitive. State-change rate, not pointer rate. |
| `drag` | `{ id, price, time, paneIndex, fromPrice, fromTime }` | A draggable primitive is being moved. `from*` is the grab origin, so deltas start at the press. |
| `drag:end` | `{ id, price, time, paneIndex }` | The drag gesture released. |
| `pan` | `{ from, to, logicalFrom, logicalTo }` | The user pans, **or** a programmatic move that changed the window without changing its span. |
| `zoom` | `{ from, to, logicalFrom, logicalTo }` | Wheel or pinch zoom, **or** a programmatic move that changed the span. |
| `resize` | `{ width, height }` | Container size changed (CSS px); also emitted by an explicit `applySize` that actually changes size. |
| `lazy-load` | `{ from, to, direction: 'backward' }` | The viewport neared the oldest bar and the history loader ran. |
| `paneRemoved` | `{ paneIndex }` | A pane was removed. |
| `paneMoved` | `{ from, to }` | A pane swapped position. |
| `paneMaximized` | `{ paneIndex }` | A pane was maximized; `paneIndex` is `null` when un-maximizing. |
| `paneResized` | `{ paneIndex }` | A pane-divider drag released. |
| `priceAxisMoved` | `{ paneIndex, from, to }` | `movePriceAxis` succeeded: a pane's prices and their scale changed strip. Re-read `priceAxisState` for any menu still open on that axis. |
| `indicatorRemoved` | `{ instanceId, indicatorId, paneIndex }` | An indicator instance was removed (legend button or `removeIndicator`). |
| `indicatorSettings` | `{ instanceId, indicatorId, paneIndex }` | The legend's settings button was clicked. The engine ships no form — render your own. |
| `contextmenu` | `ContextMenuEvent`: `{ paneIndex, point, price, time, index, target, preventDefault }` | The chart was right-clicked, axis strips included. `target.kind` classifies what is under the pointer, and a `price-scale` hit adds `side` and `scaleId` for the axis it names. With no listener the save-image snapshot stays as the fallback. See [settings-and-menus](settings-and-menus.md). |
| `replay:start` | `ReplayState` | The first frame a `ReplayController` applies. |
| `replay:frame` | `ReplayState` | Every playhead move: seek, step, and each played bar. |
| `replay:play` / `replay:pause` | `ReplayState` | Playback armed or halted. |
| `replay:end` | `ReplayState` | The playhead reached the last bar (also emitted by `play()` called there). |
| `replay:stop` | `ReplayState` | Replay was left; data and viewport are already restored. |
| `trading:order_modify` | `{ orderId, newPrice, previousPrice }` | An order line was dragged and released. |
| `trading:order_cancel` | `{ orderId }` | An order's cancel box was clicked. |
| `trading:order_click` | `{ order }` | An order pill was clicked. |
| `trading:position_close` | `{ positionId }` | A position's close box was clicked. |
| `trading:position_click` | `{ position }` | A position pill was clicked. |
| `trading:bracket_modify` | `{ parentId, bracketRole, newPrice }` | A bracket leg (TP/SL) was dragged. |
| `draw:tool` | `{ tool }` | A drawing tool was armed or disarmed (`null`). Drawing tier only. |
| `draw:add` | `{ drawing }` | A drawing was created. Drawing tier only. |
| `draw:update` | `{ drawing }` | A drawing's points, style, text, props or flags changed. Fires once per drawing, so a multi-drag emits one per member. Drawing tier only. |
| `draw:remove` | `{ drawing }` | A drawing was deleted. Drawing tier only. |
| `draw:select` | `{ id }` | Selection changed; `id` is the primary (first picked) id, `null` on deselect. Drawing tier only. |
| `drawing:select` | `{ ids }` | The whole selection in pick order, empty on deselect. Fires with `draw:select`, and only when the selection actually changed. Drawing tier only. |
| `drawing:change` | `{ ids, kind }` | One event per model mutation, after the per-drawing `draw:*` events; `kind` is `'add' | 'update' | 'remove' | 'reorder'`. Drawing tier only. |
| `draw:copy` | `{ drawings }` | A copy reached the clipboard (deep copies, not the live objects). Drawing tier only. |
| `draw:cut` | `{ drawings }` | A cut wrote **and then** deleted. A refused write emits nothing. Drawing tier only. |
| `draw:paste` | `{ drawings }` | The newly created drawings, after their own `draw:add` events. Drawing tier only. |
| `destroy` | `{}` | `chart.destroy()` finished. Emitted last, with the chart already torn down, then every listener is dropped. |
| `symbol` | `{ symbol }` or a bare string | **Host-emitted, never by the core.** The engine has no instrument concept; a link group listens for this to slave a grid. See [chart-linking](chart-linking.md). |

Notes:

- `from` / `to` on `pan`, `zoom` and `lazy-load` are **UTC seconds**, or `null` when that edge falls outside loaded data. `logicalFrom` / `logicalTo` are raw fractional logical indices.
- `pan` and `zoom` short-circuit entirely when nobody is subscribed, so leaving them unsubscribed costs nothing.
- **`pan` and `zoom` are not gesture-only.** `setVisibleLogicalRange`, `fitContent`, `resetScale` and the keyboard pan/zoom commands emit them too, so a linked grid follows an arrow key or a restored zoom. They emit **nothing** when the window did not actually move (a clamped zoom, an already-fitted `fitContent`), and the choice between the two names is made by whether the span changed. `panUp` / `panDown` move a price scale rather than the time window and emit nothing.
- **`destroy` is for letting go, not for reading.** By the time it fires, `chart.isDestroyed` is true and the panes are gone. Use it to unsubscribe, drop the chart from a link group, or release a controller; `destroy()` itself is idempotent, so a second call re-emits nothing.
- **`trading:*` names carry the prefix on both buses.** `chart.on('trading:order_modify', cb)` and `chart.trading.on('trading:order_modify', cb)` are equivalent; `chart.trading.on('order_modify', cb)` never fires.
- **`crosshair:move`, `pan`, `zoom` and `drag` fire at pointer rate.** Do only light work in the handler; defer anything heavy to rAF or a debounce.
- Typed alternatives exist for three of these and coexist with the bus: `chart.subscribeCrosshairMove(cb)` (`CrosshairMoveEvent`), `chart.subscribeClick(cb)` (hit-only, `cb(externalId)`), `chart.subscribeDrag(onDrag, onDragEnd)` (`(id, price, time)`).
- Keyboard shortcuts are **not** on this bus — subscribe via `chart.shortcuts?.on(cb)`. See [interactions](interactions.md).

## getState and restoreState

`chart.getState(): ChartState & ChartSettingsState` returns a JSON-safe snapshot; `chart.restoreState(state): RestoreReport` puts it back. The widened return type is still a `ChartState` to every existing consumer.

| Captured in `ChartState` | Restored |
|---|---|
| `version` (`CHART_STATE_VERSION`) | validated |
| `viewport` `{ from, to }` (logical range), `barSpacing` | yes, viewport only when the chart already has data |
| `grid` `{ vertLines, horzLines }` plus the grid style keys | yes |
| `canvas` (grid, crosshair, scales, margins), `statusLine`, `trading` colours, `events` filters | yes; `canvas` is applied **before** the panes, so a pane's own saved margins are the more specific answer and win |
| `crosshairMode` `'normal' \| 'magnet'` | yes |
| `timezone` (IANA name) | yes, but a name this runtime does not recognise is **skipped**, not thrown, so one stale zone cannot cost the whole layout |
| `panes[]` — `weight`, and per-pane `priceScale` `{ marginTop, marginBottom, minMove, mode, inverted, autoScale, range? }` | yes; panes are created as needed, `range` only present when `autoScale` is false |
| `indicators[]` — `{ indicatorId, settings, paneIndex }` | yes, replaced not appended |
| `drawings` | round-tripped opaquely; only present when a drawing state has been set. The draw tier writes a `DrawingsDocument` (`{ version: 2, drawings }`) here and reads a 1.9.x bare array too |
| `series[]` — `{ type, style, paneIndex, priceScaleId }` | **no**, reported back to you |
| series **data** | **no**, never captured |

**`restoreState` never recreates series.** The chart does not know your symbol, timeframe, or feed. It restores what it owns and hands back the descriptors so you rebuild and refeed them.

`RestoreReport`:

| Field | Type | Meaning |
|---|---|---|
| `applied` | `boolean` | False when the payload was rejected. |
| `series` | `SeriesState[]` | Descriptors found in the state. |
| `indicators` | `number` | Instances actually recreated. |
| `reason` | `string?` | Set only on rejection. |

Rejection is total, never partial: a non-object, or one without a numeric `version`, gives `reason: 'not a chart state object'`; a `version` greater than `CHART_STATE_VERSION` gives `state version N is newer than M`. An **older** version is accepted. `CHART_STATE_VERSION` is `1` and is exported from the package root.

**An indicator whose tier was never imported is skipped, not thrown.** `restoreState` checks `hasIndicator(id)` and moves on, so a layout saved with `openalgo-charts/indicators` loaded still restores everything else in an app that omits the tier. Any pane left empty as a result (index > 0, no series) is then removed, so a skipped indicator does not leave a blank region claiming height.

**Restore the viewport after your data lands.** Logical ranges index bars, so `viewport` is skipped entirely while `dataLayer.length === 0`. Calling `restoreState` a second time is safe and idempotent — indicators are removed and rebuilt, not duplicated.

## Save and restore a layout

```ts
// Save
localStorage.setItem('layout', JSON.stringify(chart.getState()));

// Restore
const saved = JSON.parse(localStorage.getItem('layout') ?? 'null');

const report = chart.restoreState(saved);          // 1. grid, panes, scales, indicators
if (report.applied) {
  for (const s of report.series) {                 // 2. rebuild series — yours to feed
    const series = chart.addSeries(s.type, {
      paneIndex: s.paneIndex,
      style: s.style,
      priceScaleId: s.priceScaleId,
    });
    series.setData(await loadBars(symbol, interval));
  }
  chart.restoreState(saved);                       // 3. viewport, now that bars exist
} else {
  console.warn('layout rejected:', report.reason);
}
```

## Drawings ride along

`ChartState.drawings` is an opaque slot. The base engine only stores and returns it:

```ts
chart.drawingState();          // read the slot
chart.setDrawingState(value);  // write it
```

`DrawingController` (`src/draw/controller.ts`) drives both ends automatically: it reads `chart.drawingState()` in its constructor and restores anything it finds, and it writes `chart.setDrawingState(this.toJSON())` after every mutation. So an app that already persists `getState()` keeps drawings for free once the tier is loaded — no extra storage plumbing.

Ordering matters when the controller already exists: `restoreState` overwrites the slot but does not push it into a live controller. Either construct the controller after the restore, or call `controller.fromJSON(chart.drawingState())` yourself. See [drawing-tools](drawing-tools.md).

## Related

- [core-api](core-api.md) — `createChart`, `applyOptions`, viewport methods, `destroy`.
- [data-and-time](data-and-time.md) — history paging behind `lazy-load`.
- [trading](trading.md) — the `trading:*` data model.
- [indicators](indicators.md) — `indicatorSettings` and building a settings form.
- [replay-and-compare](replay-and-compare.md): the `replay:*` payload, and the comparison controller's own state.
- [settings-and-menus](settings-and-menus.md): the settings slice of the state, and the `contextmenu` target.
- [react-integration](react-integration.md) — unsubscribing on unmount.
