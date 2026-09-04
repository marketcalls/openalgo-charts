# Trade tier (`openalgo-charts/trade`)

*When to read this: placing, modifying or cancelling real orders from the chart, the order engine, its state machine, pre-trade validation, OCO brackets and the depth ladder.*

Source of truth: every file in `src/trade/`, plus `src/feed/openalgo-trade.ts` (the `OrderFeed` adapter) and `src/feed/types.ts` (`MarketDepth`). Tests: `tests/trade.test.ts`, `tests/order-engine.test.ts`, `tests/dom-ladder.test.ts`. Demos: `examples/phase8-trade.html`, `examples/phase9-chart-trading.html`, `examples/phase10-dom.html`.

Separate bundle entry: `import { OrderEngine } from 'openalgo-charts/trade'` -> `dist/openalgo-charts.trade.mjs`. `OpenAlgoTradeFeed`, `mapOrder`, `mapPosition` are in the **base** package, not this one.

## Which tier

| Need | Use |
|---|---|
| Render broker state you already hold, get gestures back as events | [`chart.trading`](trading.md) (base) |
| Client-side order lifecycle, idempotency, validation, OCO, arm/confirm | `OrderEngine` (this tier) |
| Reconcile whole order/position book snapshots into primitives | `TradeController` (this tier) |
| Depth-of-market ladder | `DomLadder` (this tier) |

They are independent: `chart.trading` uses `TradingPosition`/`TradingOrder` and `PriceLine`; this tier uses `Order`/`Position` and its own primitives.

**Do not use `chart.trading` and this tier on the same chart.** `chart.subscribeClick` and `chart.subscribeDrag` are single-slot setters. The `TradingController` claims both on first access to `chart.trading`; the trade tier requires you to claim them yourself for drag-modify and cancel. Whoever registers last wins, and the loser goes silently dead.

## Data model (`src/trade/types.ts`)

```ts
type OrderSide = 'BUY' | 'SELL';
type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
type OrderStatus = 'pending' | 'working' | 'partial' | 'filled' | 'cancelled' | 'rejected';
type OrderRole = 'entry' | 'sl' | 'tp';

interface Order {
  id: string; symbol: string; side: OrderSide; type: OrderType;
  qty: number; filledQty: number; price: number;
  triggerPrice?: number; status: OrderStatus; parentId?: string; role?: OrderRole;
}
interface Position { symbol: string; netQty: number; avgPrice: number }  // netQty signed
```

`isWorking(o)` is true for `pending | working | partial`, the canonical "still live in the book" filter. Note these are *broker* statuses, distinct from the engine's `ClientOrderState` below.

## `OrderEngine`

```ts
interface OrderEngineOptions {
  feed: OrderFeed;                 // required
  constraints: OrderConstraints;   // required
  mode?: TradeMode;                // default 'live'
  armed?: boolean;                 // default false
  gate?: GateFn;
  minModifyIntervalMs?: number;    // default 150
  now?: () => number;              // default performance.now()
  idGen?: () => string;            // default 'c1', 'c2', ...
  onValidationError?: (reason: string) => void;
}
type TradeMode = 'live' | 'analyzer';
type GateFn = (req: PlaceRequest) => boolean | Promise<boolean>;
```

The broker interface you implement:

```ts
interface OrderFeed {
  place(req: PlaceRequest & { mode: TradeMode }): Promise<{ orderId: string }>;
  modify(orderId: string, patch: { price?: number; triggerPrice?: number; qty?: number }): Promise<void>;
  cancel(orderId: string): Promise<void>;
}
interface PlaceRequest {
  symbol: string; exchange?: string; side: OrderSide; type: OrderType; qty: number;
  price?: number; triggerPrice?: number;
  product?: 'CNC' | 'NRML' | 'MIS';
  clientToken?: string;            // idempotency token
}
interface PlaceResult { ok: boolean; clientId?: string; state?: ClientOrderState; reason?: string }
```

`OrderFeed` is **not** the base package's `TradeFeed`. Implement `OrderFeed` for the engine.

| Method | Behaviour |
|---|---|
| `placeOrder(req)` | validate -> idempotency -> gate -> `feed.place` -> `ack`/`reject`. Returns `PlaceResult` |
| `placeMarket(symbol, side, qty)` | `placeOrder({ symbol, side, type: 'MARKET', qty })` |
| `requestModify(clientId, price)` | Validates, coalesces, sends at most every `minModifyIntervalMs` |
| `commitModify(clientId)` | Force-flushes the pending modify. Call on drag end |
| `cancelOrder(clientId)` | `submitCancel` -> `feed.cancel` -> `cancelled`, then cancels the OCO peer |
| `linkOco(clientIdA, clientIdB)` | Mutual peer link |
| `onFill(brokerId, full)` | Broker fill in. `full: true` also cancels the peer |
| `onReconnect(presentBrokerIds: ReadonlySet<string>)` | Any non-terminal order absent from the set -> `stale` |
| `state(clientId)` | `ClientOrderState \| undefined` |
| `mode` (getter) | The configured `TradeMode` |

There is **no `placeLimit`** despite what `website/pages/docs/trading.mdx` shows in its DOM-ladder snippet. Use `placeOrder({ ..., type: 'LIMIT', price })`.

### Arming, the gate, and analyzer mode

`armed: false` (the default) routes every order through `gate`. With no `gate` supplied, the engine awaits `Promise.resolve(false)` and every order returns `{ ok: false, reason: 'not confirmed' }`.

**A default-constructed `OrderEngine` places nothing.** Either pass `armed: true` or pass a `gate`. Silent no-ops here look exactly like a broken network.

`mode` is *only* forwarded as `feed.place({ ...req, mode })`. **The engine does not gate anything on `mode`, and `OpenAlgoTradeFeed` drops the field before it reaches the wire**: its `place()` body is `{ strategy, symbol, action, exchange, pricetype, product, quantity, price, trigger_price, disclosed_quantity }`, with no `mode` key. Analyzer/sandbox is a server-side OpenAlgo toggle (`/auth/analyzer-mode`, response field `data.analyze_mode`), not something this field turns on. Treat `mode: 'analyzer'` as a label your own adapter must honour; verify the server is in analyzer mode before trusting it.

### Idempotency and modify throttling

`clientToken` (or a generated id) is recorded before the network call; a repeat returns `{ ok: false, reason: 'duplicate clientToken (idempotent skip)' }` with no second send. On a thrown `feed.place` the token is **released**, so the same request is retryable after a transient transport failure.

`requestModify` validates first: an invalid price is neither queued nor sent, and surfaces through `onValidationError(reason)` so the UI can snap the line back. Only the latest price survives coalescing, and the flush no-ops until `place` has acked (it needs the broker id).

## Order state machine (`src/trade/order-state-machine.ts`)

States: `pending_place`, `working`, `partial`, `filled`, `modify_pending`, `cancel_pending`, `rejected`, `cancelled`, `stale`.
Events: `ack`, `partialFill`, `fill`, `reject`, `submitModify`, `submitCancel`, `cancelled`, `reconnectAbsent`.

| From \ Event | `ack` | `partialFill` | `fill` | `reject` | `submitModify` | `submitCancel` | `cancelled` | `reconnectAbsent` |
|---|---|---|---|---|---|---|---|---|
| `pending_place` | `working` | `partial` | `filled` | `rejected` | none | none | none | `stale` |
| `working` | none | `partial` | `filled` | none | `modify_pending` | `cancel_pending` | `cancelled` | `stale` |
| `partial` | none | `partial` | `filled` | none | `modify_pending` | `cancel_pending` | `cancelled` | `stale` |
| `modify_pending` | `working` | `partial` | `filled` | `working` | none | none | `cancelled` | `stale` |
| `cancel_pending` | none | none | `filled` | `working` | none | none | `cancelled` | `stale` |
| `filled` / `cancelled` / `rejected` / `stale` | none | none | none | none | none | none | none | none |

`transition(state, event)` returns the **same state** for a disallowed event, it never throws, so spurious broker events are absorbed silently. Use `canTransition(state, event)` when you need to know. `isTerminal(state)` is true for `filled`, `cancelled`, `rejected`, `stale`.

Note the asymmetry: in `modify_pending`, `reject` means "the amend failed, the order is still working" and goes to `working`, not `rejected`.

## Validation (`src/trade/validation.ts`)

```ts
interface PriceBand { lower: number; upper: number }
interface OrderConstraints { tickSize: number; priceBand?: PriceBand; freezeQty?: number }
interface ValidationResult { ok: boolean; reason?: string; price?: number }

withinPriceBand(price, band): boolean            // inclusive on both bounds
validateOrder(price, qty, c): ValidationResult
```

Check order: `qty <= 0` -> reject; `qty > freezeQty` -> reject; snap with `roundToTick(price, tickSize)`; band check runs on the **snapped** price. On success `price` holds the snapped value, always use `result.price`, not your input. `roundToTick` is `Math.round(value / step) * step` and returns raw floats (`100.05000000000001`), so format for display and never compare with `===`.

`OrderEngine.placeOrder` skips the price path entirely when `req.price` is undefined and only checks `qty > 0`. **A `MARKET` order bypasses the freeze-quantity check.**

## P&L helpers (`src/trade/pnl.ts`): pure, LTP-hot-path safe

```ts
unrealizedPnl(position, ltp): number              // (ltp - avgPrice) * netQty
unrealizedPnlPercent(position, ltp): number       // signed % of entry notional; 0 if avgPrice or netQty is 0
breakeven(position, chargesPerUnit = 0): number   // avgPrice + dir * chargesPerUnit; avgPrice when flat
riskReward(entry, stop, target): number | null    // |target-entry| / |entry-stop|; null when risk is 0
bracketValid(side, entry, stop, target): boolean  // BUY: stop<entry && target>entry; SELL: inverted
```

## Primitives

| Class | Constructor | Draws | Hit ids | zOrder |
|---|---|---|---|---|
| `WorkingOrderLine` | `(order: Order, { extentFromRight? })` | Dashed line, `[SIDE][qty][TYPE price +/-dist][cancel]`, axis price tag | `order:<id>` (`ns-resize`), `order:<id>::close` (`pointer`) | `normal` |
| `PositionMarker` | `(position: Position, { extentFromRight? })` | Entry line, entry->LTP band tinted by P&L sign, `[LONG\|SHORT][qty][pnl (pct)][cancel]` | `position:<symbol>`, `position:<symbol>::close` (both `pointer`) | `normal` |
| `BracketGroup` | `(state: BracketState)` | Shaded risk/reward zones, SL/TP dashed lines with chips, an R:R chip | `bracket-sl:<symbol>`, `bracket-tp:<symbol>` (`ns-resize`) | `bottom` |

```ts
interface BracketState { symbol: string; side: OrderSide; entry: number; stop: number; target: number }
```

`extentFromRight` defaults to `0.5`, clamped `0.1..1`. All three take `update(...)`; the first two take `setLtp(ltp)`. `WorkingOrderLine` renders at `triggerPrice ?? price`, dims when `status === 'pending'`, and shows `filledQty/qty` once partially filled. `PositionMarker` draws nothing when `netQty === 0`.

**`BracketGroup` is purely visual, it carries no OCO logic.** One-cancels-other is `OrderEngine.linkOco(a, b)`, keyed on client ids.

## `TradeController` / `TradeHost`

```ts
interface TradeHost { addPrimitive(p: IPrimitive): void; removePrimitive(p: IPrimitive): void }

const tc = new TradeController(chart.tradeHost(0));  // any pane
tc.reconcile(orders, positions);   // full snapshot; idempotent, safe on every update and reconnect
tc.onLtp('RELIANCE', 2950);        // pushes into every bound primitive
```

`reconcile` diffs by `Order.id` and `Position.symbol`: new -> add, existing -> `update`, missing -> remove. Reconnect needs no special path, a fresh snapshot without a stale order removes its line. Rules: orders failing `isWorking` are skipped; orders with `role: 'sl' | 'tp'` are **excluded from standalone lines** and folded into a `BracketGroup`; a bracket only appears when a non-flat position exists for that symbol (SL uses `triggerPrice ?? price`, TP uses `price`). Introspection: `orderLineCount()`, `positionCount()`, `bracketCount()`.

## `DomLadder`

```ts
interface DomLadderOptions { tickSize: number; width: number; groupBy: number; maxRows: number; rowHeight: number }
const DEFAULT_DOM_LADDER_OPTIONS = { tickSize: 0.05, width: 96, groupBy: 1, maxRows: 60, rowHeight: 14 };
```

A right-docked depth strip drawn on the overlay (`zOrder: 'top'`), price-aligned to the pane's price scale. Input is one method: `setDepth(depth: MarketDepth)`, called on every book update. `tier()` returns the current `LadderTier`. Rows hit-test as `ladder-bid:<price>` / `ladder-ask:<price>` with a `pointer` cursor, route them to a place-order flow.

`MarketDepth` (from `src/feed/types.ts`) is `{ bids: DepthLevel[]; asks: DepthLevel[]; ltp: number; ltq?: number }` with `DepthLevel = { price: number; qty: number; orders?: number }`. Length is whatever the broker streams, **5 to 200 levels**.

Pure helpers, exported for custom rendering and tests:

| Function | Signature | Notes |
|---|---|---|
| `ladderCapability` | `(depth) => LadderTier` | `0` levels -> `'none'`; `<= 5` -> `'compact'`; else `'deep'` |
| `buildRows` | `(depth, tickSize, groupBy = 1) => LadderRow[]` | Merges bids+asks into `{ price, bidQty, askQty }`, bucketed to `tickSize * groupBy`, sorted high->low. Total qty is preserved across aggregation |
| `visibleRows` | `(rows, priceToY, plotHeight, rowHeight, maxRows) => LadderRow[]` | Culls off-screen rows (±1 row), then keeps the `maxRows` nearest the vertical centre, re-sorted high->low |

Depth arrives through the feed's optional `subscribeDepth(req, onDepth)`, `OpenAlgoLiveDataFeed` implements it over WS mode `'Depth'`.

```ts
const ladder = new DomLadder({ tickSize: 0.05, width: 110, maxRows: 60, groupBy: 1 });
chart.tradeHost(0).addPrimitive(ladder);
feed.subscribeDepth({ symbol, exchange, interval }, (d) => ladder.setDepth(d));
```

**`DomLadder` options are constructor-only.** There is no `setOptions`; changing `groupBy`, `width` or `maxRows` means building a new ladder and re-adding it.

**The strip overlays the plot, it does not reserve layout space.** Widen `priceAxisWidth` or accept that the rightmost `width` px of candles sit under the ladder.

## `FakeBroker`

Deterministic in-memory `OrderFeed` for tests and offline demos. Members: `onBook(cb)` / `setBook(orders, positions)` (copies its inputs), `onLtp(cb)` / `emitLtp(symbol, ltp)`, `onDepth(cb)` / `emitDepth(symbol, depth)`, `place`/`modify`/`cancel` (broker ids `B1`, `B2`, …), `fill(orderId)`, `orders()` / `positions()`, the test hook `rejectNextPlace = 'reason'` (next `place()` throws once), and `static makeDepth(ltp, levels, tickSize = 0.05)`.

`place()` marks `MARKET` orders `'filled'` and everything else `'working'`. It appends to the order book but never updates `positions`, seed those with `setBook`.

## Worked example: engine + OpenAlgo + chart gesture

```ts
import { createChart, OpenAlgoTradeFeed } from 'openalgo-charts';
import { OrderEngine, TradeController } from 'openalgo-charts/trade';

const chart = createChart(el);
chart.addSeries('candlestick').setData(bars);

const feed = new OpenAlgoTradeFeed({
  baseUrl: 'http://127.0.0.1:5000', apiKey, strategy: 'chart-trading', defaultProduct: 'MIS',
});
const engine = new OrderEngine({
  feed,
  constraints: { tickSize: 0.05, priceBand: { lower: ltp * 0.8, upper: ltp * 1.2 }, freezeQty },
  armed: false,
  gate: (req) => window.confirm(`${req.side} ${req.qty} ${req.symbol}?`),
  onValidationError: (reason) => setStatus(reason),
});
const controller = new TradeController(chart.tradeHost(0));

// Chart hit ids are 'order:<brokerId>'; the engine is addressed by clientId.
const clientOf = new Map<string, string>();
const knownBrokerIds = new Set<string>();

async function refreshBook() {
  const [orders, positions] = await Promise.all([feed.getOrders(), feed.getPositions()]);
  controller.reconcile(orders, positions);   // fills, cancels and stale orders all resolve here
}

async function placeFromChart(side: 'BUY' | 'SELL', type: 'LIMIT' | 'SL', price: number) {
  const r = await engine.placeOrder({ symbol, exchange, side, type, qty, product: 'MIS', price });
  if (!r.ok) return setStatus(`blocked: ${r.reason}`);
  const before = new Set(knownBrokerIds);
  const orders = await feed.getOrders();
  const fresh = orders.find((o) => !before.has(o.id));
  if (fresh) { clientOf.set(`order:${fresh.id}`, r.clientId!); knownBrokerIds.add(fresh.id); }
  await refreshBook();
}

// Drag a working-order line -> throttled modify; release -> commit.
chart.subscribeDrag(
  (id, price) => { const c = clientOf.get(id); if (c) engine.requestModify(c, price); },
  (id, price) => {
    const c = clientOf.get(id);
    if (c) { engine.requestModify(c, price); void engine.commitModify(c).then(refreshBook); }
  },
);

// The pill cancel button routes as `order:<id>::close`.
chart.subscribeClick((id) => {
  if (!id.endsWith('::close')) return;
  const c = clientOf.get(id.slice(0, -'::close'.length));
  if (c) void engine.cancelOrder(c).then(refreshBook);
});

setInterval(refreshBook, 8000);
```

Reconciling the fill back onto the chart *is* `refreshBook()`, the filled order drops out of `getOrders()`, `TradeController` removes its line, and the new `Position` grows a `PositionMarker`. Call `controller.onLtp(symbol, ltp)` on every tick so the P&L band and distance labels stay current.

`OpenAlgoTradeFeed.modify` needs the full order context, which it caches on `place()` and `getOrders()`. **Calling `modify()` for an order it has never seen throws** `cannot modify <id>, unknown order context`; call `getOrders()` after a page reload before allowing drags.

## Foot-guns

**`onFill` takes a broker id, `cancelOrder`/`requestModify`/`state` take a client id.** Mixing them is a silent no-op.

**`onReconnect` is destructive.** Any tracked non-terminal order whose broker id is missing from the set becomes `stale`, which is terminal, pass the *complete* fresh book, never a partial page.

**Terminal states swallow everything.** After `stale`, a late fill event cannot move the order back; rebuild from a snapshot instead.

**`OpenAlgoTradeFeed` sends `pricetype: req.type` verbatim.** Your `OrderType` strings must be the exact values OpenAlgo expects (`MARKET`, `LIMIT`, `SL`, `SL-M`). `exchange` defaults to `'NSE'`, `product` to `defaultProduct` (default `'MIS'`).

## Deeper

Visualization layer and its events: [trading](trading.md). Entry points and tree-shaking: [bundling-and-tiers](bundling-and-tiers.md). `subscribeDepth` and WS modes: [feeds-and-live](feeds-and-live.md). `IPrimitive` and hit-testing: [primitives-and-plugins](primitives-and-plugins.md). `chart.on('drag' | 'drag:end' | 'click' | 'hover')` payloads: [events-and-state](events-and-state.md).

## Field validators

`validateOrder` runs the whole set. The two field-level checks are exported so a form
can validate as the user types instead of only on submit:

```ts
validatePrice(price: number, c: OrderConstraints): ValidationResult
validateQuantity(qty: number, c: OrderConstraints): ValidationResult
```

Both return a `ValidationResult` rather than throwing, so a failure is a value you
render, not an exception you catch.

`isPreflightFailure(err)` distinguishes an order rejected *before* it reached the
broker from one the broker rejected. The difference matters: a preflight failure is
the user's to fix and the order never existed, so retrying is safe and no reconcile
against the broker is needed.

`TRADE_TIER` is the tier's identity constant (`'trade'`).
