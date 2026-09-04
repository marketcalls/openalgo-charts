# Profiles and Order Flow

*When to read this: you are adding a Volume Profile, a Market Profile / TPO, or a Footprint / order-flow ladder, or you need to know whether the user's data can support one at all.*

Source of truth: `src/profile/*.ts`, `dist/profile/index.d.ts`, `tests/profiles.test.ts`, `tests/market-profile.test.ts`, `tests/market-profile-primitive.test.ts`.

## Setup

```ts
import { computeMarketProfile, MarketProfile } from 'openalgo-charts/profile';
```

`openalgo-charts/profile` is a separate entry point (`package.json` `exports["./profile"]`), not part of the base bundle. See [bundling-and-tiers](bundling-and-tiers.md).

**Every profile ships as two halves: a pure compute function and a canvas primitive.** Nothing here is a series type, there is no `chart.addSeries('volumeProfile')`. Compute a result object, attach a primitive with `chart.addPrimitive(primitive, paneIndex = 0)`, detach with `chart.removePrimitive(primitive)`. See [primitives-and-plugins](primitives-and-plugins.md).

**A pane needs a price series before a profile renders.** Every profile primitive maps time to x via `rc.dataLayer.timeToIndex(...)`; with no bars that returns `undefined` and `draw` bails silently.

| Study | Compute | Primitive | Data needed |
|---|---|---|---|
| Volume Profile | `computeVolumeProfile`, `computeVolumeProfileSessions` | `VolumeProfile` | OHLCV (approximate) |
| Market Profile / TPO | `computeTpo`, `computeMarketProfile` | `MarketProfile` | intraday OHLCV |
| Footprint / order flow | `computeFootprint` | `Footprint` | trade-by-trade, classified bid/ask |
| Anything custom | your own | `HorizontalProfile` | whatever you have |

### Price bucketing (shared by every compute)

`bucketPrice(price, step)` snaps to the **nearest** multiple of `step`, rounded to 8 dp against float drift: `bucketPrice(100.003, 0.05) === 100`. `priceBuckets(low, high, step)` is inclusive at both ends: `priceBuckets(100, 100.2, 0.05)` is `[100, 100.05, 100.1, 100.15, 100.2]`.

**Rows are `tickSize * rowTicks`, and the two are deliberately separate.** `tickSize` is the instrument's real tick; `rowTicks` widens the visual row without lying about it. `rowTicksFor(rowSize, tickSize)` does the division and floors at 1, `rowTicksFor(2, 0.1) === 20`. `computeMarketProfile`, `computeFootprint` and `FootprintAggregator` all take that multiplier, so bricks and TPO rows can share one grid. `computeVolumeProfile` / `computeVolumeProfileSessions` have **no** `rowTicks`; pass a coarser `tickSize`.

**Bucketing rounds to nearest, so a profile can extend up to half a row past the bar's true high/low.**

## Volume Profile

### Single profile

`computeVolumeProfile(bars, tickSize, valueAreaPercent = 0.7)` (**positional**, not an options object) returns `VolumeProfileResult` = `{ buckets: { price, volume }[], poc, vah, val, totalVolume }`.

**`VolumeProfileOptions` is exported but no function consumes it.** It only describes `{ tickSize, valueAreaPercent }`; passing an object where `tickSize` is expected yields `NaN` buckets. Use the positional form, or `computeVolumeProfileSessions` for the options-object API.

Semantics, identical in `computeVolumeProfile`, `computeTpo` and the session family:

- Each bar's volume is spread **uniformly** across `priceBuckets(bar.low, bar.high, tickSize)`, `bar.volume / buckets.length` per row. From OHLCV this is an approximation, not a tick-accurate profile.
- `buckets` / `levels` are always sorted **high price first**.
- **POC** is the max-volume row; ties resolve to the **highest** price (strict `>` over a descending list).
- **Value area** starts at the POC and repeatedly absorbs whichever immediate neighbour holds more volume, stopping once accumulated volume reaches `totalVolume * valueAreaPercent`. Ties go **upward**. `vah` / `val` are the extremes reached.
- `valueAreaPercent` is a fraction. Passing `70` puts every row in the value area.

### Session family

`computeVolumeProfileSessions(bars, options?)` returns `VolumeProfileFamilyResult` = `{ sessions, options }`. `VolumeProfileFamilyOptions` / `DEFAULT_VOLUME_PROFILE_FAMILY_OPTIONS`:

| Key | Type | Default | Notes |
|---|---|---|---|
| `tickSize` | `number` | `0.05` | Row size. Non-positive falls back to the default. |
| `session` | `VolumeProfileSession` | `'composite'` | `'composite' \| 'day' \| 'week' \| 'month'`. |
| `valueAreaPercent` | `number` | `0.7` | Clamped to 0..1. |
| `deltaFromBarDirection` | `boolean` | `true` | Split volume buy/sell by `close >= open`. |
| `timezone` | `string` | `'Asia/Kolkata'` | IANA zone the day / week / month buckets resolve on. Pass `chart.timezone()` to keep a profile and its chart on one clock. |

`VolumeProfileSessionResult`: `{ startTime, endTime, levels, poc, vah, val, totalVolume, buyVolume, sellVolume, delta }`. `VolumeProfileLevel`: `{ price, volume, buyVolume, sellVolume, delta }`, high to low.

Sessions group on the calendar of the `timezone` option, which **defaults to `Asia/Kolkata`** rather than being fixed to it, weeks starting Monday (see [data-and-time](data-and-time.md)). The module is a pure calculation and is never handed the chart, so pass `chart.timezone()` yourself if the two must agree. A visible-range profile is just the visible slice with `session: 'composite'`.

**`buyVolume` / `sellVolume` are not bid/ask delta.** An up bar's entire volume is called buying, a down bar's entire volume selling. `deltaFromBarDirection: false` leaves all three at zero.

### `VolumeProfile` primitive

`new VolumeProfile(result: VolumeProfileFamilyResult | null, opts?: Partial<VolumeProfilePrimitiveOptions>)`, then `setData(result)` / `setOptions(patch)`. `autoscaleInfo()` reports the price extent across all sessions. `DEFAULT_VOLUME_PROFILE_PRIMITIVE_OPTIONS`:

| Key | Default | Notes |
|---|---|---|
| `displayMode` | `'total'` | `VolumeDisplayMode` = `'total' \| 'buySell' \| 'delta'`. |
| `side` | `'right'` | `VolumeProfileSide`; anchors bars at the session's left or right edge. |
| `width` / `opacity` | `90` / `0.85` | Max bar length in media px. |
| `barColor` / `buyColor` / `sellColor` | `#3b5168` / `#26a69a` / `#ef5350` | |
| `showPoc` / `pocColor` / `showPocLabel` | `true` / `#f0a020` / `true` | |
| `showValueArea` / `vahColor` / `valColor` / `showValueAreaLabels` | `true` / `#8892a6` / `#8892a6` / `true` | |
| `highlightValueArea` / `valueAreaFillColor` / `valueAreaFillOpacity` | `true` / `#4a6fa5` / `0.08` | |
| `valueAreaOpacityDim` | `0.4` | Alpha multiplier for rows outside the value area. |
| `labelSide` / `zOrder` | `'right'` / `'bottom'` | Label edge; draw behind or over the series. |

`'delta'` scales bars by `|delta|` and colours by sign; `'buySell'` splits each row into a buy then a sell segment. Both are empty when `deltaFromBarDirection` was off.

## Market Profile (TPO)

### The session and period model

0. One clock is chosen for the whole profile: the `window`'s own `zone` when it names one, otherwise `options.timezone` (default `Asia/Kolkata`). A window's zone wins so that a preset selects the same real instants and forms the same sessions however the chart is displayed.
1. Bars are dropped if a `window` is set and `inWindow(bar.time, window, zone)` is false.
2. Surviving bars group into sessions by calendar key on that clock (`day` / `week` / `month`), or one group for `composite`. `compositeSessions: N` then folds every N consecutive groups into one profile.
3. Within a session, each bar's **period index** is `floor((bar.time - anchor) / (blockMinutes * 60))`. `anchor` is the session's first bar time, unless a real window is set, in which case it is that day's window open resolved as **wall clock** in the window's zone, so a session whose first bar arrives late does not shift every letter, and a daylight-saving changeover does not shift them either.
4. Period index maps to a letter via `tpoLetter`: `0..25` to `A..Z`, `26..51` to `a..z`, then wraps (`tpoLetter(52) === 'A'`).
5. For each bar, every row in `priceBuckets(bar.low, bar.high, tickSize * rowTicks)` records the period index in a **Set** and accumulates `bar.volume / rowCount`. A level's `count` is therefore the number of **distinct periods** at that price, not the number of bars.

### `computeMarketProfile(bars, options?)`

Returns `MarketProfileResult` = `{ sessions: MarketProfileSessionResult[], options }`. `MarketProfileOptions` / `DEFAULT_MARKET_PROFILE_OPTIONS`:

| Key | Type | Default | Notes |
|---|---|---|---|
| `tickSize` | `number` | `0.05` | Instrument tick. |
| `rowTicks` | `number` | `1` | Row = `tickSize * rowTicks`. Floored at 1. |
| `session` | `MarketProfileSession` | `'day'` | `'day' \| 'week' \| 'month' \| 'composite'`. |
| `blockMinutes` | `number` | `30` | One letter per block. |
| `valueAreaPercent` | `number` | `0.7` | Clamped to 0..1. |
| `initialBalancePeriods` | `number` | `2` | Opening periods forming the IB. |
| `window` | `SessionWindow \| undefined` | none | Drops out-of-window bars and anchors letters. Its own `zone` outranks `timezone`. |
| `timezone` | `string` | `'Asia/Kolkata'` | IANA zone for the window test and the day / week / month keys, when the window names none. |
| `compositeSessions` | `number` | `1` | Merge N consecutive sessions. |
| `tailEdges` | `number` | `0` | Min run of single prints promoting a tail. 0 disables. |

`result.options` echoes the merged options with `rowTicks` normalised; `result.options.tickSize` stays the instrument tick. `computeTpo(bars, periodBars, tickSize, valueAreaPercent = 0.7, ibPeriods = 2)` is the cut-down alternative: one profile over the whole array, periods counted in **bars** rather than minutes, returning `TpoResult` = `{ buckets: { price, count }[], poc, vah, val, ib: { high, low } }` with no letters, sessions or analytics.

`MarketProfileSessionResult` fields worth knowing:

| Field | Meaning |
|---|---|
| `levels` | `MarketProfileLevel[]` high to low: `{ price, count, letters, periods, volume }`. |
| `poc` / `vah` / `val` | Same expansion algorithm as the volume profile, over TPO counts. |
| `periodDetail` / `periods` | `MarketProfilePeriod[]` = `{ index, letter, startTime, endTime, high, low, volume }`; `periods` is `maxIndex + 1` and can exceed `periodDetail.length` when a period had no bars. |
| `initialBalance` / `rangeExtension` | IB from bars with period index `< initialBalancePeriods`; extension is `{ up: max(0, high - ib.high), down: max(0, ib.low - low) }`. |
| `singlePrints` | Interior levels with `count === 1`; both extremes excluded by construction. |
| `buyingTail` / `sellingTail` | `null` unless `tailEdges > 0`. A run at the **top** yields `sellingTail`, at the **bottom** `buyingTail`. |
| `poorHigh` / `poorLow` | The extreme level printed more than one TPO. |
| `developing` | `DevelopingValue[]` = `{ periodIndex, time, poc, vah, val }`, one per period, recomputed from periods `<= index`; `time` is that period's last bar time. |
| `dayType` | `'normal' \| 'normal-variation' \| 'trend' \| 'double-distribution' \| 'neutral'`. Heuristic: extension both ways is `neutral`; a second node `>= 0.7 * peak` with a middle `<= 0.35 * peak` is `double-distribution`; then `range / ibRange >= 2.5` is `trend`, `>= 1.4` is `normal-variation`. |
| `openType` | `'drive' \| 'test-drive' \| 'rejection-reverse' \| 'auction'`, from the open's position in the range plus the first two periods' probes. |
| `volumePoc` / `totalVolume` / `label` | Volume-weighted POC, session volume, and `window?.name`. |

### Helpers

| Function | Contract |
|---|---|
| `tpoLetter(period)` | Period index to `A-Z`/`a-z`, mod 52. |
| `rowTicksFor(rowSize, tickSize)` | `max(1, round(rowSize / tickSize))`; returns 1 on non-positive input. |
| `rowOf(price, options)` | Snaps a price onto the profile's row grid, use it to hit-test against `levels`. |
| `inWindow(utcSeconds, window, zone?)` | Wrap-aware; `startMinute === endMinute` means all hours. `zone` (default `Asia/Kolkata`) is consulted only when the window names none of its own. |
| `nakedLevels(result)` | Prior `poc`/`vah`/`val` no later session traded through, oldest first, tagged `{ time, price, kind }`. The last session's three levels are always naked. |

`SessionWindow` is `{ startMinute, endMinute, name?, zone? }`. The minutes are **minutes from midnight in the window's own zone**, falling back to the profile's `timezone` (default `Asia/Kolkata`) when `zone` is absent; `end <= start` means an overnight window, which is kept as one session.

`TRADING_HOURS` presets, each carrying the zone its numbers are written in:

| Key | Window | Zone |
|---|---|---|
| `all-hours` | 0 to 0 (all hours) | none needed |
| `india` | 09:15 to 15:30 | `Asia/Kolkata` |
| `asia` | 09:00 to 15:00 | `Asia/Tokyo` |
| `london` | 07:00 to 13:00 | `Europe/London` |
| `new-york` | 08:00 to 15:30 | `America/New_York` |
| `us-regular` | 09:30 to 16:00 | `America/New_York` |

**A window's own zone outranks the display zone, for the window test and for the session keys alike.** Bucketing on the display zone would cut a 09:15-15:30 Kolkata session in half when the chart is read from New York, because that session genuinely straddles New York midnight. A preset therefore selects the same real instants on any display; only labels move.

**These presets changed instants in 1.3.0 for the DST markets.** They were previously written as fixed IST minutes authored in EDT terms, so `london`, `new-york` and `us-regular` were an hour wrong for the months either side of summer. They now reproduce the old instants through a summer week and are deliberately an hour later in winter, which is the point. `india`, `asia` and `all-hours` are unchanged year-round.

A window you write by hand should name its own zone for the same reason:

```ts
import { computeMarketProfile } from 'openalgo-charts/profile';

const result = computeMarketProfile(bars, {
  window: { startMinute: 9 * 60 + 30, endMinute: 16 * 60, zone: 'America/New_York', name: 'RTH' },
  timezone: chart.timezone(),   // only settles a window with no zone of its own
});
```

### `MarketProfile` primitive

`new MarketProfile(result | null, opts?)`; `setData`, `setOptions`, `options()`, `autoscaleInfo()`, `hitTest(x, y)` returning `mp:<sessionIndex>`, and `hoverAt(x, y, rc?)` returning `MarketProfileHover` = `{ sessionIndex, price, level, session, isPoc, inValueArea, isSinglePrint }`. `hoverAt` reuses the last paint's render context, so a `crosshair:move` handler can call `mp.hoverAt(e.point.x, e.point.y)` directly. Both need a prior `draw`.

Selected `MarketProfilePrimitiveOptions`; `DEFAULT_MARKET_PROFILE_PRIMITIVE_OPTIONS` supplies every key (full list in `src/profile/market-profile-primitive.ts`):

| Key | Default | Notes |
|---|---|---|
| `blockDisplay` | `'auto'` | `MpBlockDisplay` = `'auto' \| 'blocks+letters' \| 'letters' \| 'blocks'`. |
| `minLetterHeight` / `letterFade` | `7` / `4` | In `'auto'`, letters fade in over `letterFade` px above `minLetterHeight`; the block always draws. |
| `letterWidth` / `font` | `8` / `10` | Font auto-shrinks to `rowHeight * 0.95`. |
| `colorMode` / `periodColors` | `'period'` / `TPO_PERIOD_COLORS` | `MpColorMode` = `'period' \| 'valueArea' \| 'count' \| 'volume' \| 'uniform'`; 12 hues indexed `periodIndex % length`. |
| `color` / `vaColor` | `#5a6b8c` / `#4a8f7a` | |
| `opacity` / `outsideVaOpacity` | `0.92` / `0.45` | |
| `split` / `profileSpacing` | `false` / `4` | `split` gives each period its own column slot, so gaps show which periods missed a row. |
| `showPoc` / `pocColor` / `pocThickness` / `showPocLabel` | `true` / `#f0a020` / `2` / `true` | |
| `showValueArea` / `fillValueArea` / `valueAreaFillOpacity` / `showValueAreaLabels` | `true` / `true` / `0.07` / `true` | |
| `showInitialBalance` / `showSinglePrints` / `showTails` | all `true` | Tails need `tailEdges > 0` in the compute. |
| `showPoorHighLow` / `showNakedLevels` / `showDevelopingPoc` / `showDevelopingVa` / `showTpoCounts` | all `false` | |
| `showSessionLabel` / `showDayType` / `showOpenType` | `true` / `false` / `false` | The session label only appears when a `window` set `label`. |
| `showVolumeProfile` / `volumeProfileWidth` / `volumeProfileSide` / `showVolumeValues` | `false` / `60` / `'right'` / `false` | |
| `zOrder` | `'top'` | |

**`colorMode: 'count'` and `'volume'` change alpha, not hue.** Both fall through to `color`; the heat is `0.3 + 0.7 * share` applied to opacity.

**`showNakedLevels: true` recomputes `nakedLevels(result)` on every frame.** It is O(sessions squared); precompute and draw your own lines if the session count is large.

## Footprint and order flow

**Footprint and order flow require trade-by-trade data classified bid/ask**: was each print at the bid (sell-initiated) or the ask (buy-initiated)? OpenAlgo serves live depth and tick LTP but **does not store historical classified trades by default**, so footprint is a **live-session-only** study unless the host runs a tick recorder that persists classified prints. The compute layer is pure and broker-agnostic; feeding it is the integration step. `ARCHITECTURE.md` section 6A gives the two paths: classify live WS prints against the live bid/ask and keep a rolling session buffer, or add an OpenAlgo-side tick/depth recorder. **`FootprintAggregator` is the live path.** See [feeds-and-live](feeds-and-live.md).

Nothing else in this file has that dependency, Volume Profile and Market Profile derive from plain OHLCV.

`computeFootprint(time, trades, tickSize, rowTicks = 1)` returns a `FootprintBar`. `ClassifiedTrade` is `{ price, qty, side: 'bid' | 'ask' }`; `FootprintCell` is `{ price, bidVol, askVol }`; `FootprintBar` is `{ time, cells, delta }`, cells high to low, `delta = sum(askVol - bidVol)`.

| Function | Contract |
|---|---|
| `diagonalImbalances(cells, ratio = 3)` | `Imbalance[]` of `{ price, side }`. Buy when `askVol[P] >= ratio * max(1, bidVol[P - 1 row])`; sell when `bidVol[P] >= ratio * max(1, askVol[P + 1 row])`. |
| `cumulativeDelta(bars)` | `number[]`, running total of `bar.delta`, same length as input. |
| `stackedImbalances(cells, ratio = 3, minStack = 3)` | `StackedImbalance[]` of `{ startPrice, endPrice, side, count }`, runs of `minStack`+ consecutive same-side diagonal imbalances. |

**The `max(1, ...)` in the imbalance test means an empty neighbour counts as volume 1.** A single ask print of 3 against an untouched row below is already a buy imbalance at the default ratio. Raise `ratio`, or filter with the primitive's `imbalanceThreshold`.

### `Footprint` primitive

`new Footprint(opts?: Partial<FootprintOptions>)`, then `setBars(FootprintBar[])`. Also `setOptions(patch)`, `options()`, `stats()`, `autoscaleInfo()`, `hitTest(x, y)` returning `footprint:<time>`, `hoverAt(x, y, rc?)` returning `FootprintHover` = `{ time, price, cell, stats }` with `cell === null` when the pointer is over the stats table.

`autoscaleInfo()` reports the cell price extent so top and bottom rows are not clipped, same as `VolumeProfile` and `MarketProfile`. Only `HorizontalProfile` returns `null` and never participates in autoscale. `DEFAULT_FOOTPRINT_OPTIONS`:

| Key | Default | Notes |
|---|---|---|
| `cellWidth` | *(unset)* | Media px. Omitted means `max(24, barSpacing * widthFactor)`. |
| `widthFactor` | `0.9` | Fraction of the bar slot when auto-sizing. |
| `tickSize` | *(unset)* | Row height source. Omitted means the smallest gap between adjacent cells. |
| `font` | `10` | |
| `minTextHeight` / `textFade` | `11` / `4` | Below the threshold numbers fade out and the column becomes a heatmap. |
| `displayMode` | `'bidask'` | `FootprintDisplayMode` = `'bidask' \| 'delta' \| 'volume'`. |
| `imbalanceRatio` / `imbalanceThreshold` | `3` / `0` | Threshold ignores cells below that volume when flagging. |
| `stackedImbalances` | `3` | Bracket runs of N+ same-side imbalances. 0 disables. |
| `statsRows` | `['volume','delta','deltaPct','cvd']` | `FootprintStatRow[]`; `'trades'` also available. `[]` hides the table. |
| `statsRowHeight` | `15` | Media px. |
| `showCandle` / `showPoc` / `pocColor` | `true` / `true` / `#f0a020` | |
| `buyColor` / `sellColor` | *(unset)* | Fall back to `theme.upColor` / `theme.downColor`. |
| `radius` | `2` | Cell corner radius, media px. |

`FootprintBarStats` is `{ time, volume, delta, deltaPct, cvd, trades, poc }`, recomputed on `setBars` because `cvd` needs bar order. `compactVol(v)` formats to three significant figures with a `K`/`M`/`B` suffix (`compactVol(4_530_000) === '4.53M'`).

**`FootprintBarStats.trades` counts price rows, not prints.** `_recomputeStats` increments once per cell. Treat the `'trades'` stats row as "rows touched" until that is fixed in `src/profile/footprint-primitive.ts`.

**The stats table eats the bottom of the pane.** Cells are clipped above `plotHeight - statsRows.length * statsRowHeight`; a tall `statsRows` list on a short pane leaves no room for the ladder.

### `FootprintAggregator` (the live path)

`new FootprintAggregator(tf: TickTimeframe, tickSize: number, rowTicks = 1)`. `TickTimeframe` (from `src/feed/tick-aggregator.ts`) is `{ mode: 'interval'; seconds; anchorSec? } | { mode: 'ticks'; count } | { mode: 'volume'; perBar }`. `onTick(tick: FootprintTick)` returns `FootprintUpdate` = `{ bar, isNew }`, push when `isNew`, otherwise replace the last element. `FootprintTick` is `ClassifiedTrade & { time: number }`; `current()` returns the forming bar or `null`.

**The boundary is evaluated before the incoming tick is applied.** For `'ticks'` and `'volume'` modes the bar rolls on the tick *after* the limit is reached, so a 100-tick bar holds 101 prints. Nothing closes a bar on a timer either, with no ticks, the last bar stays open indefinitely.

**Snapshots of the forming bar alias live cell objects.** `onTick` returns a fresh array but the same `FootprintCell` instances until the bar rolls, so keep only the latest snapshot for the current bar. Cells of already-closed bars are safe, a roll allocates a new map.

## `HorizontalProfile` (generic)

```ts
chart.addPrimitive(new HorizontalProfile({
  buckets: levels,   // ProfileLevel[] = { price, value }[]
  poc, vah, val, width: 150, side: 'right', barColor: '#3b5168', vaColor: '#4a6fa5',
}));
```

`HorizontalProfileOptions` has no defaults object, every key is required. `setData(opts)` replaces the whole option object; there is no `setOptions` patch. `autoscaleInfo()` returns `null`, so it never drives the price range. Row height comes from `plotHeight / buckets.length`, not from a tick size, so rows always fill the pane.

Use it for a price-keyed distribution the built-ins do not model, delivery volume at price, open interest at strike, a broker-supplied profile, or `computeTpo` output drawn as a plain histogram rather than letters. Use `VolumeProfile` or `MarketProfile` for anything they already compute: they handle multiple sessions, tick-accurate row height, value-area dimming and hit-testing, none of which `HorizontalProfile` does.

## Known gaps (verified against current source)

The README's "Known gaps" list is written against 1.0.8; the package is at 1.0.28 and **all four footprint-renderer claims are now stale**:

| README claim | Status | Reality |
|---|---|---|
| "hardcoded colours (not theme-aware)" | Stale, with a caveat | `Footprint.draw` reads `rc.theme.upColor`, `downColor`, `background`, `axisText`; `buyColor` / `sellColor` are optional overrides. Cell and stats **text** ink is still hardcoded `#ffffff` / `#0d0f14`, and `pocColor` defaults to a fixed `#f0a020`. |
| "a single display mode" | Stale | `FootprintDisplayMode` is `'bidask' \| 'delta' \| 'volume'`. |
| "no `setOptions`" | Stale | `setOptions(patch)` plus an `options()` getter, covered by `tests/profiles.test.ts`. |
| "`stackedImbalances` computed but not drawn" | Stale | Runs of `>= options.stackedImbalances` draw an edge bracket (default 3). |

Gaps that are real today:

- **The profile overlays are the ones that ignore the theme.** `VolumeProfile`, `MarketProfile` and `HorizontalProfile` never touch `rc.theme`; their defaults are fixed hexes tuned for a dark background and look wrong on `lightTheme` until you pass explicit colours. Only `Footprint` adapts.
- The renderer's imbalance detection is a private reimplementation (`_imbalances` / `_runs`) that honours `imbalanceThreshold`; the exported `diagonalImbalances` / `stackedImbalances` do not. They agree only at `imbalanceThreshold: 0`.
- `VolumeProfile` has no `hitTest`, `hoverAt` or `options()`, `MarketProfile` and `Footprint` have all three.
- `HorizontalProfile` has no `setOptions` and hardcodes its POC (`#f0a020`) and VA line (`#5a6b8c`) colours.
- Only `FootprintAggregator` is incremental. Volume and market profiles are full recomputes; on live bars call the compute again and hand the result to `setData`.

## Worked examples

### Volume profile over the visible range

```ts
import { computeVolumeProfileSessions, VolumeProfile } from 'openalgo-charts/profile';

chart.addSeries('candlestick').setData(bars);
const profile = new VolumeProfile(null, { displayMode: 'buySell', width: 110 });
chart.addPrimitive(profile);

const refresh = (p: unknown): void => {
  const { logicalFrom, logicalTo } = p as { logicalFrom: number; logicalTo: number };
  const slice = bars.slice(Math.max(0, Math.floor(logicalFrom)), Math.ceil(logicalTo) + 1);
  profile.setData(computeVolumeProfileSessions(slice, { tickSize: 1, session: 'composite' }));
};
chart.on('pan', refresh);
chart.on('zoom', refresh);
chart.fitContent();
```

`'pan'` and `'zoom'` both carry `{ from, to, logicalFrom, logicalTo }`. See [events-and-state](events-and-state.md).

### Market profile for one Indian cash session

```ts
import { computeMarketProfile, MarketProfile, TRADING_HOURS, rowTicksFor } from 'openalgo-charts/profile';

const result = computeMarketProfile(oneMinuteBars, {
  tickSize: 0.05,
  rowTicks: rowTicksFor(1, 0.05),   // 1-point rows
  session: 'day',
  blockMinutes: 30,
  window: TRADING_HOURS['india'],   // 09:15-15:30 IST, letters anchored to the open
  tailEdges: 3,
});

const mp = new MarketProfile(result, { showDayType: true, showTails: true });
chart.addPrimitive(mp);

chart.on('crosshair:move', (e) => {
  const p = (e as { point?: { x: number; y: number } }).point;
  const hit = p ? mp.hoverAt(p.x, p.y) : null;
  tooltip.textContent = hit ? `${hit.level.letters}, ${hit.level.count} TPO @ ${hit.price}` : '';
});
```

### Footprint from a live classified tick stream

```ts
import { Footprint, FootprintAggregator, type FootprintBar } from 'openalgo-charts/profile';

const TICK = 0.05;
const footprint = new Footprint({ tickSize: TICK, statsRows: ['volume', 'delta', 'cvd'] });
chart.addPrimitive(footprint);

const agg = new FootprintAggregator({ mode: 'interval', seconds: 60, anchorSec: 0 }, TICK);
const bars: FootprintBar[] = [];

ws.onTrade((t) => {
  // `atBid` must come from the feed's own classification, never a price guess.
  const { bar, isNew } = agg.onTick({ time: t.timeSec, price: t.price, qty: t.qty, side: t.atBid ? 'bid' : 'ask' });
  if (isNew) bars.push(bar); else bars[bars.length - 1] = bar;
  if (bars.length > 40) bars.shift();
  footprint.setBars(bars.slice());
});
```

Full host wiring (tooltip, controls, synthetic tape) is in `examples/orderflow/index.html` and `examples/market-profile/index.html`; minimal versions in `examples/phase11-profiles.html`.

Related: [primitives-and-plugins](primitives-and-plugins.md), [feeds-and-live](feeds-and-live.md), [data-and-time](data-and-time.md), [bundling-and-tiers](bundling-and-tiers.md), [pitfalls](pitfalls.md).
