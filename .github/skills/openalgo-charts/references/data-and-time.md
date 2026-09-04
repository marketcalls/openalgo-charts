# Data and time

*When to read this: you are shaping bars for a series, wiring history paging, formatting the time axis, or explaining why bars moved, merged, or vanished.*

## The Bar shape

`src/model/bar.ts` is the only data contract. Everything a series accepts normalizes to `Bar` via `toBar`.

| Field | Type | Notes |
|---|---|---|
| `time` | `UTCSeconds` (`number`) | Integer UTC seconds. Required. |
| `open` `high` `low` `close` | `number` | Required on a `Bar`. |
| `volume` | `number?` | Optional; not all feeds carry it. |
| `color` | `string?` | Per-bar override honoured by renderers that support it (histogram, column). |

**Bar times are UTC seconds, never milliseconds and never `Date`.** `UTCSeconds` is a bare `number`, so a millisecond timestamp compiles fine and then places the bar ~50,000 years in the future, which silently destroys the shared axis. Convert at the feed edge with `epochMsToUtcSeconds` (`src/feed/time.ts`).

```ts
import type { Bar } from 'openalgo-charts';

const bar: Bar = { time: 1700000000, open: 100, high: 102, low: 99.5, close: 101, volume: 12000 };
```

## Three item shapes, one internal bar

`SeriesDataItem = Bar | LinePoint | Whitespace`. `toBar` normalizes:

| Input | Becomes |
|---|---|
| `{ time, open, high, low, close, volume?, color? }` | passes through untouched |
| `LinePoint` `{ time, value, color? }` | flat OHLC bar (`open = high = low = close = value`) |
| `Whitespace` `{ time }` | `open/high/low/close = NaN` |

`isWhitespace(p)` returns true when the item has neither `open` nor `value`. A whitespace point claims a logical index so panes stay aligned, but the line renderer draws a gap there and autoscale skips it. Use whitespace to reserve future sessions or to punch a hole in one series while others keep drawing.

```ts
series.setData([
  { time: 1700000000, value: 101 },   // LinePoint
  { time: 1700000060 },               // Whitespace, index reserved, nothing drawn
  { time: 1700000120, value: 103 },
]);
```

## setData vs update vs prependData

`SeriesApi` (`src/model/series.ts`) exposes exactly these write paths:

| Method | Data effect | Viewport effect |
|---|---|---|
| `setData(items)` | Full replace of this series. Sorted ascending, duplicate times collapsed **last-wins**. | Auto-fits **only on the first non-empty call** for the chart's lifetime (`_hasFitContent`). Later calls leave the logical range alone. |
| `update(item)` | Upsert one item: newer time appends, equal time replaces the last bar, older time replaces or inserts. | Appends auto-scroll only when the viewport was already at the right edge; otherwise `rightOffset` is decremented so visible bars do not shift. |
| `prependData(items)` | Upsert-merge by time (`DataLayer.addBars`), existing times replaced, new times inserted, result stays sorted. | Preserved. `baseIndex` shifts by the inserted count and `rightEdge - index` is invariant. |
| `getData()` | Read back the normalized `Bar[]`, oldest to newest. | None. Allocates a fresh array each call. |

**A second `setData` does not refit the chart.** The auto-fit latch fires once. After a timeframe or symbol switch, call `chart.fitContent()` (or `chart.timeScale.fitContent(n)`) yourself, or the old logical range is reapplied to a different bar count.

```ts
const series = chart.addSeries('candlestick');
series.setData(bars);          // fits once
series.update(liveBar);        // hot path, per tick
series.prependData(olderBars); // history paging, viewport preserved
```

## The shared logical-index model

One `DataLayer` per chart (`src/model/data-layer.ts`). Every distinct time across **all** series is merged into a sorted array and assigned a logical index `0..N-1`. Series rows are addressed by that shared index, which is what keeps price, volume and indicator panes aligned and what collapses non-trading gaps: an absent time simply has no index.

Consequences you must design around:

- **One bar per time, per series, is an invariant.** Times map through a `Set`, so two bars sharing a time resolve to the same x and draw on top of each other. `setData` collapses duplicates keeping the last occurrence in the caller's array (`Array#sort` is stable); `addBars`/`prependData` upsert through a `Map`, so incoming bars win.
- **Reconnect overlap is safe.** Re-fetch a window that overlaps what you already have and hand it to `prependData`, the merge dedupes by time. No gap arithmetic needed.
- **Logical indices are not stable across a prepend.** Anything you cached as an index is wrong afterwards. Cache times, not indices.
- **The axis is gapless, so most x positions have no bar behind them.** `indexToTime(i)` answers only for whole indices that have a bar; `indexToTimeFloat(i)` interpolates between bars and extrapolates past either edge at the nearest bar spacing, and `timeToIndexFloat(t)` is its inverse. Both return `NaN` with no data. `chart.coordinateToTime(x)` / `chart.timeToCoordinate(time)` wrap them.
- `visibleBars(id, from, to)` binary-searches into the window, so a repaint costs `O(log n + visible)`, not `O(total)`. Prefer it over scanning `seriesBars(id)` (which returns the live array, treat as read-only).

`DataLayer.update` classifies each live bar and returns the kind, which is what drives the auto-scroll decision:

| Kind | When |
|---|---|
| `'append'` | Newer than this series' last bar **and** newer than every time on the shared axis. |
| `'replace'` | Same time as the last bar (intra-bar tick), or any existing time. |
| `'insert'` | An older time that does not exist yet (late / out-of-order arrival). |

## Infinite history paging

```ts
let oldest = bars[0].time;

chart.setHistoryLoader(async () => {
  const older = await api.barsBefore(oldest, 500);
  if (older.length > 0) {
    series.prependData(older);
    oldest = older[0].time;
  }
  chart.historyLoadComplete();   // re-arms the trigger
});
```

The loader fires from `_maybeLoadHistory` whenever the visible logical range's `from` drops below 10, during a drag, a wheel zoom, or a kinetic glide. A latch (`_loadingHistory`) suppresses re-entry until you call `historyLoadComplete()`.

**`historyLoadComplete()` is mandatory on every invocation, including the one that returns nothing.** Skipping it leaves the latch set and paging never fires again.

The same trigger also emits the observable `lazy-load` event (`{ from, to, direction: 'backward' }`), see [events-and-state](events-and-state.md). Only `'backward'` is ever emitted.

## Timezone

Internal time is UTC seconds. What the chart *labels* it in is `ChartOptions.timezone`, an IANA name that **defaults to `Asia/Kolkata`**. IST is the default, not a property of the engine: any zone the runtime recognises works, and daylight saving is followed rather than approximated because the name is resolved per instant.

```ts
import { createChart } from 'openalgo-charts';

const chart = createChart(el, { timezone: 'America/New_York' });

chart.timezone();                        // 'America/New_York'
chart.setTimezone('Europe/London');      // relabels and recomputes on the next frame
chart.applyOptions({ timezone: 'UTC' }); // same thing through the options path
```

| API | Contract |
|---|---|
| `ChartOptions.timezone` | IANA name. Default `'Asia/Kolkata'`. **Throws** on a name the runtime does not recognise. |
| `chart.timezone()` | The resolved zone. |
| `chart.setTimezone(zone)` | Relabels *and* recomputes every calendar-anchored indicator. No-ops when the zone is unchanged. Throws on an unknown name. |
| `chart.applyOptions({ timezone })` | Same as `setTimezone`. |
| `getState()` / `restoreState()` | The zone rides in the payload. A saved zone the runtime does not recognise is **skipped**, not thrown, so one stale name cannot cost a whole layout. |
| `applyChartSettings(chart, { 'time.timezone': zone })` | The settings schema's own control, on the Axes tab, so a dialog does not need a zone row of its own. An invalid name is skipped here too, rather than throwing away the rest of the patch. See [settings-and-menus](settings-and-menus.md). |

What the zone drives:

- Time-axis tick labels, **including which tick escalates** to a day, month or year mark: a New York chart escalates at New York's midnight, not at IST's.
- The crosshair time tag.
- Every calendar-anchored indicator: `vwap` (`session`, `week`, `month`, `quarter`, `year` anchors), `twap`, `cpr` (weekly and monthly frames), `seasonality` (which month a close is counted in). See [indicators](indicators.md).

What it does **not** drive: `SessionWindow` in the profile tier carries its own zone, so a preset selects the same real instants on any display. See [profiles-and-orderflow](profiles-and-orderflow.md).

**An explicit `timeFormatter` outranks the zone.** A host that formats its own labels has settled the question; the formatter receives raw UTC seconds either way.

```ts
// Pick the zone from the instrument, so switching symbol switches the clock.
const ZONES: Record<string, string> = {
  NSE: 'Asia/Kolkata', BSE: 'Asia/Kolkata', NFO: 'Asia/Kolkata',
  NASDAQ: 'America/New_York', NYSE: 'America/New_York',
  LSE: 'Europe/London', TSE: 'Asia/Tokyo',
};

function loadSymbol(exchange: string, bars: readonly Bar[]): void {
  chart.setTimezone(ZONES[exchange] ?? 'UTC');   // before or after setData, either way
  series.setData(bars);
}
```

**The default costs nothing extra.** On `Asia/Kolkata` the engine keeps its original fixed-offset arithmetic and never reaches `Intl`, so labels are byte-identical to pre-1.3.0 output and independent of the host's ICU build. A named zone goes through a per-zone `Intl.DateTimeFormat` memoised by UTC second, so a pan resolves each visible tick once, not once per frame.

## Time helpers

Two families, both exported from the package root (`src/feed/time.ts`). The IST family is the fixed-offset special case and is unchanged; the zoned family is the general one, every function taking `zone` as a trailing argument defaulting to `DEFAULT_TIMEZONE`.

| Function | Purpose |
|---|---|
| `epochMsToUtcSeconds(ms)` | `Math.floor(ms / 1000)`. Zone-free. |
| `IST_OFFSET_SECONDS` | `19800` (5h30m). |
| `istStringToUtcSeconds(s)` | Parses `YYYY-MM-DD`, `YYYY-MM-DD HH:MM[:SS]`, and the `T`-separated variant as IST wall clock. Locale-independent; throws on an unparseable string. |
| `utcSecondsToIstParts(s)` | `{ year, month (1-12), day, hour, minute, second, weekday (0=Sun) }`. |
| `utcSecondsToIstDateString(s)` | `YYYY-MM-DD`, the form OpenAlgo history requests need. |
| `formatIstTime(s)` / `formatIstTimeSeconds(s)` | `HH:MM` / `HH:MM:SS`. |
| `formatIstDate(s)` | `DD Mon`. |
| `isNewIstDay(a, b)` | True when two instants fall on different IST calendar days. |

| Zoned function | Purpose |
|---|---|
| `DEFAULT_TIMEZONE` | `'Asia/Kolkata'`. |
| `isValidTimezone(zone)` | True when the runtime resolves the name. Use it to validate before `setTimezone` if you do not want the throw. |
| `utcSecondsToZonedParts(s, zone?)` | `ZonedParts` (same shape as `IstParts`). |
| `utcSecondsToZonedDateString(s, zone?)` | `YYYY-MM-DD` in the zone. |
| `zonedStringToUtcSeconds(str, zone?)` | Wall-clock string in the zone to UTC seconds. |
| `zonedWallClockToUtcSeconds(y, m, d, h?, min?, sec?, zone?)` | Wall-clock components to UTC seconds. Two-pass, so a changeover day resolves to the offset in force at the answer. |
| `zoneOffsetSeconds(s, zone?)` | The zone's offset **at that instant**. |
| `zonedDayIndex(s, zone?)` / `zonedWeekIndex(s, zone?)` | Calendar day / Monday-week index. Cheaper than a midnight timestamp and immune to a 169-hour DST week. |
| `startOfZonedDay/Week/Month(s, zone?)` | UTC seconds of the local midnight opening that period. |
| `isNewZonedDay/Week/Month/Quarter/Year(a, b, zone?)` | Boundary tests. |
| `isNewZonedPeriod(a, b, period, zone?)` | The same, with `ZonedPeriod = 'day' \| 'week' \| 'month' \| 'quarter' \| 'year'`. |
| `formatZonedTime/TimeSeconds/Date(s, zone?)` | `HH:MM` / `HH:MM:SS` / `DD Mon`. |
| `formatZonedCrosshairLabel(s, zone?)` | The crosshair tag form, e.g. `Wed 05 Jun '24 09:30`. |

## Custom time formatting

A formatter replaces the zone-aware labeller outright, for both the axis ticks and the crosshair pill:

```ts
const chart = createChart(el, {
  timeFormatter: (utcSeconds, tickMark) =>
    tickMark === 'day' || tickMark === 'month' || tickMark === 'year'
      ? new Date(utcSeconds * 1000).toISOString().slice(0, 10)
      : new Date(utcSeconds * 1000).toISOString().slice(11, 19),
});
```

`tickMark: TickMarkType` is `'year' | 'month' | 'day' | 'time' | 'timeWithSeconds'`. The axis computes it by comparing each tick against the previous one **in the chart's zone**, and picks `timeWithSeconds` when the label step is under 60 seconds. The first visible tick is always `'day'`. Pass `undefined` to `setTimeFormatter` to go back to the built-in labels in the chart's zone.

**A `timeFormatter` overrides labels only, never the calendar.** Session anchors and pivot frames still resolve on `chart.timezone()`, so a formatter that renders New York hours on a chart left at `Asia/Kolkata` puts a VWAP restart in the middle of the drawn day. Set the zone as well.

## Where the time axis puts a label

Two kinds of position, since 1.8.5:

- **The regular grid**, roughly every 80 px, which is what carries the clock readings.
- **The first bar of every new day**, whether or not it lands on that grid.

The second exists because labels used to be placed only on the grid. When a new session had fewer bars than the grid stride, no tick fell inside it and the date was never drawn at all: today's bars sat under yesterday's date with nothing marking the change, which is exactly what a chart looks like a few minutes after the open. Forcing the mark is also why a professional terminal prints "Sep" between two hourly labels rather than on the hour.

Labels are then resolved by priority and drawn left to right. A boundary date outranks the grid tick beside it, because losing "Sep" to a 10:00 its neighbours already imply is the failure the forced mark exists to prevent. Two boundaries still check each other, so zoomed far out they do not print through one another.

A `timeFormatter` sees the boundary as `tickMark: 'day'` (or `'month'` / `'year'`), so a host formatter gets the same treatment without changing.

## Tick, volume and calendar bars

`TickBarAggregator` (`src/feed/tick-aggregator.ts`) builds bars from raw trade ticks on any `Bucketing` rule:

```ts
import { TickBarAggregator } from 'openalgo-charts';

const agg = new TickBarAggregator({ mode: 'ticks', count: 100 });
// { mode: 'volume', perBar: 5000 }
// { mode: 'interval', seconds: 30, anchorSec: sessionOpenUtc }
// { mode: 'calendar', unit: 'month' }, with { timezone: 'America/New_York' } as the option

ws.onTrade((t) => {
  const u = agg.onTick({ time: t.timeSec, price: t.price, qty: t.qty });
  series.update(u.bar);   // isNew === true on a boundary
});
```

`onTick` always returns a `BarUpdate` (never null). Bar time is the bucket start in `interval` and `calendar` mode, and the **first tick's time** in `ticks` / `volume` mode.

The four cases are the `Bucketing` union from the interval registry, and `TickTimeframe` still names exactly the three time-agnostic ones. `new TickBarAggregator(bucketing, { timezone })` supplies the zone a calendar bucket resolves in when the rule did not pin its own: a month opens at local midnight on the first, and which instant that is depends on the exchange. See [feeds-and-live](feeds-and-live.md#the-interval-registry).

**Tick and volume bars can collide on time.** Two consecutive count-bars whose first ticks land in the same second get the same `time`, and the DataLayer collapses them last-wins, one bar disappears. If your feed timestamps at second resolution, carry your own monotonic time when building tick bars.

**Tick and volume bars require real trade ticks.** OHLCV history cannot be re-bucketed into them.

For interval bars built from an LTP/quote stream, use `CandleBuilder` instead, see [feeds-and-live](feeds-and-live.md).

## Conflation

Off by default. Enabling it changes nothing until bars fall below the pixel threshold.

```ts
const chart = createChart(el, { conflate: true, conflationFactor: 1 });
```

| Option | Default | Effect |
|---|---|---|
| `conflate` | `false` | Enables OHLC-preserving downsampling at draw time. |
| `conflationFactor` | `1` | Aggressiveness multiplier; raise to 2-4 to merge sooner and harder. |

`conflationGroupSize(barSpacing, dpr, minPx = 0.5, factor = 1)` returns `1` while `barSpacing * dpr >= minPx * max(1, factor)`, otherwise `ceil(threshold / widthPx)`. The pane calls it with `minPx = 0.5`.

Merging is lossless for candle shape: open from the first bar, close from the last, high/low from the extremes, volume summed. Never averaged. The merged bar takes the **first** bar's time; `conflateItems` places x at the group centre.

Conflation is a render-time transform only, the DataLayer, your `getData()`, indicators and autoscale all still see every source bar. What changes is what you see: a group of candles becomes one wider-range candle, so wick counts and per-bar colors no longer correspond 1:1 to your data at extreme zoom-out. The helpers `conflateBars(bars, groupSize)` and `mergeBars(group)` are exported for manual use.

## Related

- [feeds-and-live](feeds-and-live.md), `DataFeed`, the OpenAlgo adapters, `CandleBuilder`.
- [events-and-state](events-and-state.md), `lazy-load`, `pan`/`zoom`, saved layouts.
- [core-api](core-api.md), `createChart`, `addSeries`, viewport methods.
- [scales-and-panes](scales-and-panes.md), logical range, bar spacing, price scales.
- [pitfalls](pitfalls.md), the short list of things that bite.
