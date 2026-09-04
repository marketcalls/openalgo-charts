# Feeds and live data

*When to read this: you are connecting the chart to a broker or backend, REST history, a WebSocket tick stream, live candle assembly, or a custom `DataFeed`.*

## The DataFeed contract

`src/feed/types.ts`. The chart core never imports a broker SDK; it depends only on this.

```ts
interface DataFeed {
  getBars(req: BarsRequest): Promise<Bar[]>;
  subscribeBars?(req: BarsRequest, onBar: (bar: Bar) => void): UnsubscribeFn;
  subscribeDepth?(req: BarsRequest, onDepth: (depth: MarketDepth) => void): UnsubscribeFn;
}

interface BarsRequest {
  symbol: string;
  exchange: string;
  interval: string;   // '1m' | '5m' | '1h' | 'D' | ...
  from?: UTCSeconds;
  to?: UTCSeconds;
}
```

**`subscribeBars` and `subscribeDepth` are optional.** A history-only feed omits them so callers can feature-detect (`if (feed.subscribeBars)`). `OpenAlgoDataFeed` deliberately does not implement `subscribeBars`; `OpenAlgoLiveDataFeed` implements both.

Supporting types: `MarketDepth { bids: DepthLevel[]; asks: DepthLevel[]; ltp: number; ltq?: number }`, `DepthLevel { price, qty, orders? }`, variable depth, whatever the broker streams. `UnsubscribeFn = () => void`.

`TradeFeed` is the separate, higher-level broker abstraction (`placeOrder` / `modifyOrder` / `cancelOrder` / `subscribeOrders` / `subscribePositions`, taking `PlaceOrder`). The trade tier's `OrderEngine` does **not** use it, it uses the smaller `OrderFeed` (`place` / `modify` / `cancel`) from `openalgo-charts/trade`, which is what `OpenAlgoTradeFeed` implements. See [trading](trading.md).

**Verify every OpenAlgo wire field against your running OpenAlgo build.** The adapters below encode the documented REST paths and WS message shapes, and the parsers are deliberately tolerant, but field names have moved between OpenAlgo releases. Pin them for your deployment before production.

## OpenAlgoDataFeed: REST history

```ts
import { OpenAlgoDataFeed } from 'openalgo-charts';

const feed = new OpenAlgoDataFeed({
  baseUrl: 'http://127.0.0.1:5000',
  apiKey: 'YOUR_KEY',
  fetchImpl: undefined,   // optional; defaults to a bound global fetch
});

const bars = await feed.getBars({
  symbol: 'RELIANCE', exchange: 'NSE', interval: '1m',
  from: nowSec - 7 * 86400, to: nowSec,
});
```

- `POST ${baseUrl}/api/v1/history` with `{ apikey, symbol, exchange, interval, start_date, end_date }`.
- **`from` and `to` are mandatory.** `getBars` throws without them: OpenAlgo history requires a date range. They are UTC seconds; the adapter converts to IST `YYYY-MM-DD` via `utcSecondsToIstDateString`. That is the OpenAlgo server's own convention, not the chart's display zone: `chart.setTimezone(...)` does not change what date this adapter asks for, so widen the range by a day rather than assuming the two agree.
- A non-OK response throws `history request failed (<status>)`.
- `fetchImpl` is injectable so the adapter is unit-testable offline. The default binds global `fetch` to `globalThis` (an unbound `window.fetch` throws "Illegal invocation").

Two pure helpers are exported for reuse and testing:

- `mapHistoryResponse(json)`: reads `json.data[]`, accepts either `timestamp` or `time` on each row, skips rows with neither, returns bars sorted ascending.
- `rowTimeToUtcSeconds(value)`: tolerant timestamp coercion:

| Input | Result |
|---|---|
| `number > 1e12` | treated as epoch **ms** |
| other `number` | `Math.floor(value)` (epoch seconds) |
| numeric-looking string with no `-`, `T`, `:` or space | same numeric rules |
| anything else | `istStringToUtcSeconds(value)`, IST wall-clock parse |

## OpenAlgoWsFeed: realtime

```ts
import { OpenAlgoWsFeed } from 'openalgo-charts';

const ws = new OpenAlgoWsFeed({
  url: 'ws://127.0.0.1:8765',
  apiKey: 'YOUR_KEY',
  reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 30000, maxAttempts: Infinity },
  socketFactory: undefined,   // optional
});

ws.connect();
const off = ws.onLtp((e) => { /* e: { symbol, exchange, ltp, ltq?, volume?, timeSec } */ });
ws.subscribe('LTP', 'RELIANCE', 'NSE');
```

Modes: `WsMode = 'LTP' | 'Quote' | 'Depth'`, sent as numeric `1 | 2 | 3`.

Wire format (pure formatters, exported where noted):

| Step | Frame |
|---|---|
| auth (sent automatically on open, before anything else) | `{ action: 'authenticate', api_key }` |
| subscribe (`formatSubscribe`) | `{ action: 'subscribe', symbol, exchange, mode }`, plus `depth` (and `depth_level`, the 1.x name) for `Depth` |
| unsubscribe (`formatUnsubscribe`) | `{ action: 'unsubscribe', symbol, exchange, mode }` |
| order stream | `{ action: 'subscribe_orders' }` / `{ action: 'unsubscribe_orders' }` |
| heartbeat | inbound `'ping'` or `{ type: 'ping' }` -> replies `{ action: 'pong' }` |
| inbound data | `{ type: 'market_data', mode, topic, data: { ... } }` |

`parseMessage(raw)` (exported) normalizes inbound frames. It reads payload fields from `data` but tolerates a flat shape, accepts `ltp` or `last_price`, `ltq` or `last_trade_quantity`, maps `depth.buy`/`depth.sell` (`{ price, quantity, orders? }`) into `MarketDepth.bids`/`asks`, and coerces `timestamp` from epoch s, epoch ms, or ISO-8601. Anything it cannot classify returns `null` and is surfaced to `onControl` instead.

Callbacks, each returning its own unsubscribe: `onLtp`, `onDepth((symbol, exchange, depth) => {})`, `onState((s: WsState) => {})` with `'connecting' | 'open' | 'closed' | 'error' | 'reconnecting'`, `onControl` for auth/subscribe acks and server errors, `onOrderUpdate` for the account-level order stream.

Reconnect and resubscribe:

- Enabled by default. On an unexpected close the feed backs off `min(maxDelayMs, baseDelayMs * 2^attempt)`, reconnects, re-authenticates, then replays **every** active subscription plus the order stream if it was on.
- A successful open resets the attempt counter.
- `close()` sets an intentional-close flag and never reconnects; it also clears the pending send queue.
- Sends before the socket is open are queued and flushed after authentication, so `subscribe()` immediately after `connect()` is safe.
- `socketFactory: (url) => SocketLike` injects a socket for tests, React Native, or any non-browser runtime. `SocketLike` needs `send`, `close`, `onopen`, `onclose`, `onmessage`, optionally `onerror` and `readyState` (`1` means open; a factory that connects synchronously is handled).

## OpenAlgoLiveDataFeed: REST + WS + CandleBuilder

The composed feed that actually satisfies the full `DataFeed` contract.

```ts
import { OpenAlgoLiveDataFeed } from 'openalgo-charts';

const live = new OpenAlgoLiveDataFeed({
  baseUrl: 'http://127.0.0.1:5000',
  wsUrl: 'ws://127.0.0.1:8765',
  apiKey: 'YOUR_KEY',
  volumeMode: 'ltq-sum',      // default
  timezone: 'Asia/Kolkata',   // default; the zone a calendar interval buckets in
});

const req = { symbol: 'RELIANCE', exchange: 'NSE', interval: '1m', from, to };
const bars = await live.getBars(req);
series.setData(bars);

const off = live.subscribeBars(req, (bar) => series.update(bar), {
  seedFrom: bars[bars.length - 1],
  cumDayVolumeSoFar: undefined,   // only meaningful for volumeMode: 'day-delta'
});
// later: off(); live.close();
```

- The constructor connects the socket immediately.
- `subscribeBars` resolves the interval code **once, up front** through `resolveInterval`, then creates a **per-subscription** aggregator: a `CandleBuilder` for a fixed-length interval, a `TickBarAggregator` for a calendar, tick-count or volume one. It filters WS ticks by symbol **and** exchange and forwards the bar to `onBar`. Unsubscribing detaches the callback and sends the WS unsubscribe.
- Resolving up front is deliberate: a bad interval code throws at subscribe time, where the mistake is, instead of silently on every tick for the life of the subscription.
- `opts.seedFrom` seeds the aggregator with the last history bar so the first tick continues that bucket. It applies to **time-bucketed intervals only**: a count-driven bar cannot resume one whose trades were never counted here. `opts.cumDayVolumeSoFar` gives a `day-delta` builder the right baseline.
- A tick with no usable timestamp (`timeSec` absent or `<= 0`) is bucketed at `Date.now()`, never at the epoch.
- `subscribeDepth` subscribes `Depth` and filters the same way.

`intervalToSeconds(interval)` returns the seconds per bar for a **fixed-length** code: `D` and `1D` give `86400`, `W`/`1W` give `604800`, `1s`->1, `5m`->300, `4h`->14400.

**It throws rather than guessing.** `UnknownIntervalError` for a code nothing recognises, and a plain error for a calendar or count-driven code, which has no fixed length to report. Before 1.4.0 it answered 60 for both, so a monthly chart wired through this feed quietly bucketed live ticks into one-minute bars under a label saying otherwise. For anything outside `s/m/h/d/w`, register the code and use `resolveInterval` + `bucketStartOf` instead of asking for seconds.

## CandleBuilder

`src/feed/candle-builder.ts`. Pure and deterministic (no `Date`, no rAF), so it unit-tests exactly.

| Option | Default | Meaning |
|---|---|---|
| `intervalSec` | `60` | Bucket size. |
| `volumeMode` | `'ltq-sum'` | `'ltq-sum'` accumulates `tick.ltq`; `'day-delta'` diffs `tick.cumDayVolume`. |
| `lateTickPolicy` | `'foldIntoBar'` | `'foldIntoBar'` merges a tick older than the current bar into it; `'dropOlderThanPrevBar'` returns `null`. |
| `sessionAnchorSec` | `0` | Bucket alignment origin, in UTC seconds. |

`onTick(tick)` returns `{ bar, isNew } | null`, `null` only under `'dropOlderThanPrevBar'`. `isNew` is true on the first tick of a bucket, so a host can append rather than replace. `bucketStart(t) = anchor + floor((t - anchor) / intervalSec) * intervalSec`. `current()` returns a copy of the forming bar.

`'day-delta'` handles the daily reset: when the incoming cumulative drops below the last one, the new bar starts from 0; otherwise it carries from the previous bar's closing cumulative.

**Seed the builder from the last history bar, and seed it again after every reconnect.** History normally ends *inside* the forming bucket. An unseeded builder opens a fresh bar for that same bucket at whatever tick arrived first, wrong open, volume restarted at zero, and (if you also keep your own array) a duplicate entry for that time. `seed(lastBar, cumDayVolumeSoFar?)` is the fix; the optional second argument sets the `day-delta` baseline to `cumDayVolumeSoFar - (lastBar.volume ?? 0)`.

**Set `sessionAnchorSec` for any interval that does not divide the trading day evenly.** The default anchors buckets to the epoch, so 5-minute bars start at :00/:05 rather than at the session open: 09:15 in Mumbai, 09:30 in New York. The anchor is UTC seconds and knows nothing about the chart's `timezone`, so compute it from the session open you actually want. `zonedWallClockToUtcSeconds(y, m, d, 9, 30, 0, 'America/New_York')` resolves one on a changeover day without an offset table.

```ts
import { CandleBuilder } from 'openalgo-charts';

const builder = new CandleBuilder({ intervalSec: 300, volumeMode: 'ltq-sum', sessionAnchorSec: sessionOpenUtc });
builder.seed(bars[bars.length - 1]);

ws.onLtp((e) => {
  const u = builder.onTick({ time: e.timeSec, price: e.ltp, ltq: e.ltq, cumDayVolume: e.volume });
  if (u !== null) series.update(u.bar);
});
ws.subscribe('LTP', 'RELIANCE', 'NSE');
```

## The interval registry

`src/feed/intervals.ts`, base bundle. An interval code resolves to a **bucketing rule, not a duration**, because three of the four kinds have no duration to state.

```ts
import { registerInterval, resolveInterval, bucketStartOf, isKnownInterval } from 'openalgo-charts';

registerInterval({ code: '1MO', bucketing: { mode: 'calendar', unit: 'month', count: 1 } });
registerInterval({ code: 'T500', bucketing: { mode: 'ticks', count: 500 } });

const { bucketing } = resolveInterval('1MO');
const open = bucketStartOf(bucketing, tickTimeSec, chart.timezone());
```

| `Bucketing` case | Shape | Bar closes when |
|---|---|---|
| `interval` | `{ mode: 'interval', seconds, anchorSec? }` | `seconds` elapse from `anchorSec` (default epoch). |
| `calendar` | `{ mode: 'calendar', unit: 'month' \| 'quarter' \| 'year', count?, timezone? }` | The period ends, at local midnight on the first, in that zone. |
| `ticks` | `{ mode: 'ticks', count }` | `count` trades have printed. |
| `volume` | `{ mode: 'volume', perBar }` | `perBar` quantity has traded. |

This is the vocabulary `TickTimeframe` already used, widened by one case, not a second system. `TickTimeframe` still names exactly the three time-agnostic modes (`interval`, `ticks`, `volume`) and is still re-exported from the tick aggregator; `TickBarAggregator` now takes the wider `Bucketing` plus an optional `{ timezone }`.

| Function | Notes |
|---|---|
| `registerInterval(descriptor)` | Returns a disposer. A registered code **shadows** a built-in token of the same name. |
| `unregisterInterval(code)` | `false` if nothing was registered under it. |
| `registeredIntervals()` | Registration order. Built-in tokens are not listed. |
| `resolveInterval(code)` | Throws `UnknownIntervalError` (which carries `.code`) when nothing recognises it. |
| `tryResolveInterval(code)` | The same, returning `null` instead of throwing. |
| `isKnownInterval(code)` | Boolean probe, for validating an interval picker's input. |
| `bucketStartOf(b, timeSec, zone?)` | UTC seconds the containing bar opened at. Count-driven bars return `timeSec`. |
| `nextBucketStart(b, timeSec, zone?)` | UTC seconds the next bar opens at, or `null` for count-driven bars. |
| `isTimeBucketed(b)` | True for `interval` and `calendar`. |

Codes are matched case-insensitively (`D` and `d` are one interval), because the built-in tokens always were. The built-ins are the old grammar byte for byte: an optional count followed by `s`, `m`, `h`, `d` or `w`.

**A calendar bar is not a fixed number of seconds, and you must not pretend it is.** Buckets are computed as absolute month indices floored to the step, converted back through `zonedWallClockToUtcSeconds`, so a month runs first to first at local midnight in the entry's zone (or the caller's, defaulting to IST). February 2024 is 29 days; March 2024 in `America/New_York` is 31 days minus an hour; quarters land on January, April, July and October. `30 * 86400` is wrong for every one of those.

**An unknown code throws.** That is the deliberate change in 1.4.0, and it is load-bearing: the old silent fall back to 60 seconds drew minute bars under whatever label the caller had chosen. Validate a picker with `isKnownInterval`, and let `resolveInterval` throw on the paths where a wrong timeframe would be a wrong trade.

## Warm-load bar cache

`src/feed/cache.ts`, base bundle. `withBarCache` is a `DataFeed` to `DataFeed` wrapper, so **any** feed gets warm loading, not just `OpenAlgoDataFeed`.

```ts
import { withBarCache, OpenAlgoDataFeed } from 'openalgo-charts';

const feed = withBarCache(new OpenAlgoDataFeed(cfg), { ttlMs: 60_000, max: 24 });

const bars = await feed.getBars({ symbol, exchange, interval, from, to });
await feed.getBars({ symbol, exchange, interval, from, to, noCache: true });  // force a fetch
feed.stats();          // { entries, bars, hits, misses, evictions }
```

| Option | Default | Notes |
|---|---|---|
| `ttlMs` | `300_000` | Absolute age bound. |
| `max` | `24` | Entries before LRU eviction. |
| `maxBars` | `250_000` | Total cached bars before LRU eviction. |
| `storage` | in-memory `Map` | A `BarCacheStore` (`get`/`set`/`delete`, sync **or** async). |
| `now` | `Date.now` | Injectable clock. |
| `intervalSeconds` | `intervalToCacheSeconds` | For tokens this does not know. Return `0` to disable caching for that interval. |

**The key is `symbol|exchange|interval`, and the range is deliberately not in it.** One entry per series holds the widest set fetched so far, and a narrower request is served by slicing it. Keying on the range would miss on every pan and on every "same chart, one bar later" reload, which is exactly the traffic warm loading is meant to remove.

**Freshness is two gates that must both pass.** `ttlMs` bounds absolute age, and a hit past the entry's coverage is allowed only while the bar after the last closed bar is still forming (`nowSec < entry.to + 1 + intervalSec`). The second gate is measured on the feed's own bar grid, not against UTC midnight, so a daily Indian bar opening at 03:45 UTC is judged against its own session. A request reaching further back than the entry's `from` is a real gap at the left edge and always refetches.

**The forming bar is never stored.** This is the rule to carry into any cache you write yourself, not a detail of this one:

> A closed bar is immutable and can be cached freely. **The last bar is alive until its interval ends.** A cache that serves a stale forming bar is worse than no cache at all: the wrong close reaches the last-price line, the axis tag, the header LTP and every indicator computed off it (RSI, VWAP, a Supertrend flip), instantly and with no spinner to warn anyone. This library draws Buy and Sell buttons on the chart; a fast wrong price is a worse failure than a slow right one.

So trailing unclosed bars are dropped on store and coverage ends at the last closed bar. A hit is therefore short by at most that one bar, which a live subscription re-supplies immediately, and is never wrong about a bar it does return.

Other behaviour worth knowing:

- `getBars` passes straight through, uncached, when `from` or `to` is absent (coverage cannot be reasoned about) or the resolved interval is `<= 0` (the caller opting out).
- A rejected fetch propagates untouched and leaves the previous entry alone. Nothing is written unless bars arrive.
- Bars are cloned in and out, because live builders mutate bar objects in place.
- `subscribeBars` and `subscribeDepth` are forwarded **only when the wrapped feed has them**, with every argument, so feature detection still tells a history-only feed from a live one and `OpenAlgoLiveDataFeed`'s third `opts` argument survives the hop. `cache.source` is the wrapped feed.
- Bounds are LRU on entries **and** on total bars, because one intraday series can be 100k bars and an entry count alone does not bound memory. A single series larger than `maxBars` is simply not cached.
- `invalidate({ symbol, exchange, interval })` drops one series; `invalidate()` and `clear()` drop everything this instance knows of. With an injected persistent store, keys written by an earlier session are dropped when next read and found expired, not by `clear()`.
- **Out of hours every load is cold** unless the host helps. The cache cannot know a market is closed, so a request whose `to` is "now" is always past the coverage of an entry that ends at the last session's close. If the host has a session table, cap `to` at the newest bar it expects to exist and the reload goes warm.

## OpenAlgoTradeFeed

`src/feed/openalgo-trade.ts` implements the trade tier's `OrderFeed` over OpenAlgo REST.

```ts
import { OpenAlgoTradeFeed } from 'openalgo-charts';

const trade = new OpenAlgoTradeFeed({
  baseUrl: 'http://127.0.0.1:5000',
  apiKey: 'YOUR_KEY',
  strategy: 'openalgo-charts',   // default
  defaultProduct: 'MIS',         // default; 'CNC' | 'NRML' | 'MIS'
});
```

| Method | Endpoint |
|---|---|
| `place(req)` | `POST /api/v1/placeorder` -> `{ orderId }` (reads `orderid` or `order_id`) |
| `modify(orderId, patch)` | `POST /api/v1/modifyorder` |
| `cancel(orderId)` | `POST /api/v1/cancelorder` |
| `getOrders()` | `POST /api/v1/orderbook` -> `Order[]` |
| `getPositions()` | `POST /api/v1/positionbook` -> `Position[]` |

Every request sends `apikey` in the body. Non-OK responses surface OpenAlgo's own `message` text (RMS rules, square-off windows) rather than a bare status code.

**`modify` requires the full order context, so it throws for an order this feed has never seen.** OpenAlgo's `modifyorder` needs symbol/action/exchange/pricetype/product/quantity, not just the delta. The feed caches that context on `place` and on `getOrders`; modifying an order placed elsewhere means calling `getOrders()` first.

`mapOrder` / `mapPosition` (exported) coerce OpenAlgo's string-or-number fields and map `order_status` into the chart's vocabulary (`open`/`trigger pending` -> `working`, `pending` -> `pending`, `complete` -> `filled`, `cancelled`, `rejected`, default `working`). A `trigger_price` of 0 is normalized to `undefined` so an order line does not render at zero.

## Writing a custom DataFeed

Complete and sufficient, history plus live bars, no library internals:

```ts
import type { Bar, BarsRequest, DataFeed, UnsubscribeFn } from 'openalgo-charts';

export class MyFeed implements DataFeed {
  async getBars(req: BarsRequest): Promise<Bar[]> {
    const rows = await myApi.candles(req.symbol, req.interval, req.from, req.to);
    return rows
      .map((r) => ({ time: Math.floor(r.epochMs / 1000), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }))
      .sort((a, b) => a.time - b.time);
  }

  subscribeBars(req: BarsRequest, onBar: (bar: Bar) => void): UnsubscribeFn {
    const sub = myApi.stream(req.symbol, (msg) => {
      onBar({ time: Math.floor(msg.bucketMs / 1000), open: msg.o, high: msg.h, low: msg.l, close: msg.c, volume: msg.v });
    });
    return () => sub.cancel();
  }
}
```

Rules for any adapter: convert to UTC seconds at the edge, sort ascending, keep one bar per time, and omit `subscribeBars` entirely rather than shipping a no-op, callers feature-detect it. If your source pushes ticks rather than bars, compose a `CandleBuilder` inside `subscribeBars` the way `OpenAlgoLiveDataFeed` does.

## FakeDataFeed and generateBars

Deterministic, network-free, seeded xorshift32, safe for pixel-diff tests.

```ts
import { FakeDataFeed, generateBars } from 'openalgo-charts';

const bars = generateBars(1700000000, 500, 3600);   // startTime, count, intervalSec
series.setData(bars);

const feed = new FakeDataFeed(60);                  // intervalSec, optional scheduler
const off = feed.subscribeBars({ symbol: 'X', exchange: 'NSE', interval: '1m' }, onBar, { tickMs: 500 });
```

- `getBars` returns 500 bars from `req.from ?? 1_700_000_000`.
- `subscribeBars` genuinely streams (default a 1s `setInterval`), so feature detection stays honest. Pass a `FeedScheduler` `(cb, ms) => UnsubscribeFn` to drive it by hand in tests.
- `generateBars` uses no global randomness and no `Date.now()`, so output is identical across runs.

## Related

- [data-and-time](data-and-time.md): `Bar`, UTC seconds, `update` vs `prependData`, tick bars, the chart timezone and the time helpers.
- [chart-linking](chart-linking.md): a grid of charts on one instrument, and the per-member `onSymbol` that loads its bars.
- [events-and-state](events-and-state.md), `lazy-load` and the rest of the event bus.
- [trading](trading.md) / [trade-tier](trade-tier.md), `OrderFeed`, `OrderEngine`, on-chart order lines.
- [pitfalls](pitfalls.md).
