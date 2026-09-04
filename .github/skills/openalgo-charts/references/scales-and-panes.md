# Scales and panes

*When to read this: configuring a price axis, pinning an overlay to part of a pane, controlling zoom or the visible bar range, or building/resizing/removing a multi-pane layout.*

Source of truth: `src/scale/price-scale.ts`, `src/scale/time-scale.ts`, `src/scale/ticks.ts`, `src/core/pane.ts`, `src/core/chart.ts`.

## PriceScaleOptions

```ts
import { DEFAULT_PRICE_SCALE_OPTIONS } from 'openalgo-charts';
// { marginTop: 0.1, marginBottom: 0.1, minMove: 0, mode: 'linear', inverted: false }
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `marginTop` | `number` | `0.1` | Fraction of **pane height** kept empty above the data band. |
| `marginBottom` | `number` | `0.1` | Fraction of **pane height** kept empty below the data band. |
| `minMove` | `number` | `0` | Instrument tick size (e.g. `0.05`). `0` infers precision from the visible range. **A chart-wide setter withholds this from a pane that does not quote the instrument**: see below. |
| `minPrecision` | `number` | `0` | Least decimals a scale with no tick prints. Set to 2 on every study pane; ignored once `minMove` is set. |
| `mode` | `'linear' \| 'logarithmic' \| 'percentage' \| 'indexed-to-100'` | `'linear'` | `logarithmic` maps through `log10`, clamped at `1e-10`. The last two rebase against a baseline, below. |
| `inverted` | `boolean` | `false` | Price increases downward. |

`ChartOptions.priceScale` is applied to each pane's **right** scale as that pane is created; left and overlay scales always start from the defaults. Per scale at runtime:

```ts
series.priceScale().setOptions({ marginTop: 0.82, marginBottom: 0 });
chart.panes()[0].priceScale.setOptions({ minMove: 0.05, mode: 'logarithmic' });
```

**Margins are fractions of pane height, not of the data span.** Since 1.0.26 `autoscaleRange(low, high, marginTop, marginBottom)` gives the data band exactly `1 - marginTop - marginBottom` of the pane: `total = span / visible`, `min = low - total * marginBottom`, `max = high + total * marginTop`. Before 1.0.26 it padded the span, so `marginTop: 0.82` left the series 55% of the pane instead of 18%. Margins summing to 1 or more are clamped to a 0.01 sliver so the range stays finite.

### The rebasing modes

`percentage` and `indexed-to-100` quote every price against a **baseline**: percent change from it (`+3.42%`), or the baseline rebased to 100 (`103.42`). They share one transform, since percent change is the index minus the 100 it rebases to.

```ts
const ps = chart.panes()[0].priceScale;
ps.setOptions({ mode: 'percentage' });
ps.setBaseline(firstVisibleClose);   // data, so the pane supplies it per frame
ps.baseline;                          // number | null
```

- **The baseline is data, not geometry**, so the scale cannot find it alone. The pane's autoscale pass feeds it the first value of the visible range each frame, which is what makes panning re-base: the axis always reads as change measured from the left edge of what is on screen.
- **No baseline means the identity transform**, so the scale behaves exactly like `linear` rather than answering with nonsense before the first frame. `setBaseline(null)` is the deliberate way to say "nothing to measure".
- **Zero and negative baselines are refused** the same way. Percent change from zero is undefined, and a negative baseline flips the sign of the transform, so a rising price would draw downward on an axis still labelling itself normally.
- **Labels switch to the rebased domain and outrank a custom price formatter.** `precision()` comes from the transformed span with two decimals as the floor; `format()` renders `+3.42%` (explicit sign, no `-0.00`) or `103.42`. A currency prefix on a percent change would read as money that is not there.
- **`reset()` drops the baseline** along with the range, so a pane that loses its last series does not keep quoting the next one against a departed price.
- **A rebase relabels the pane, it does not reshape it.** The transform is affine over a price-space range, so one series looks identical to its linear self by definition. Two instruments become comparable only when each sits on its own scale with its own baseline, which is what [replay-and-compare](replay-and-compare.md) builds on.

`PriceScale.ticks(maxTicks = 6)` is the axis ladder and belongs to the scale, not the axis renderer. Linear and log get `niceTicks` over the price range; the rebasing modes get nice values chosen over the **transformed** range and mapped back, because a nice price is an ugly percentage (`+3.47%, +6.94%` instead of `+5.00%, +10.00%`).

**How many rungs the axis asks for changed in 1.8.5.** The renderer used to pass a flat 6 whatever the pane measured, so a 700 px chart read one price every 120 px while a reference terminal read one every 30. It now derives the count from the pane height at a fixed spacing, `priceTickCount(plotHeight)` against `PRICE_LABEL_SPACING` (32 px, clamped to 2..30), which puts about twenty prices on that pane instead of six. Both live in `src/render/axis.ts` and are internal, like the axis renderer itself; the number a host sees is simply the denser ladder. The `maxTicks = 6` default on `ticks()` is untouched, and `ticks()` is public: it is a ceiling for a direct caller, not what the axis uses.

`maxTicks` remains a request rather than a promise. `niceTicks` walks the 1 / 2 / 2.5 / 5 ladder until the count fits, so a range with no round step at that density simply prints fewer.

### Range control

| Member | Notes |
|---|---|
| `autoScale` (getter) | `true` while the range tracks the data. |
| `setAutoScale(on)` | `false` freezes the current range. |
| `setPriceRange({ min, max })` | Sets the range and marks the scale as scaled. |
| `priceRange()` | `{ min, max }`. |
| `autoscale(low, high)` | Applies `autoscaleRange` with the configured margins. |
| `scaleAroundCenter(factor)` | `>1` widens, `<1` narrows. Switches to manual. |
| `panByPixels(dy)` | Shifts in transformed space, honours `inverted`. Switches to manual. |
| `scaled` (getter) | `false` until a real range is applied; the placeholder is `0..1`. |

Freezing a range means both `setPriceRange` and `setAutoScale(false)`:

```ts
const ps = chart.panes()[2].priceScale;
ps.setAutoScale(false);
ps.setPriceRange({ min: 0, max: 100 });   // e.g. an RSI pane
ps.setAutoScale(true);                     // hand it back to the data
```

`chart.resetScale()` (also double-click) re-enables autoscale on every pane and fits content.

Chart-wide equivalents, for a settings dialog: `chart.setPriceScaleOptions(patch, allScales = false)` writes each pane's right scale (`allScales` includes left and overlay), `chart.priceScaleOptions()` reads pane 0's, and `chart.setAutoScale(on)` flips every pane at once. See [settings-and-menus](settings-and-menus.md).

### Conversion and formatting

## Precision follows what a pane measures, not where it sits

`minMove` is a property of the **instrument**, so it is the one field in the
chart-wide block that does not reach every pane. `Chart.setPriceScaleOptions`
withholds it from a pane that does not quote the instrument, whatever `scope` is
asked for; `mode`, `inverted` and the margins still reach every scale that scope
names. Naming an axis outright (`setPriceAxisOptions`, a series' `priceFormat`)
is the caller settling what that axis quotes, and is obeyed.

Which panes quote it:

- **Pane 0** does, from construction. A caller who configures nothing sees
  byte-identical behaviour there, its left axis and its hidden overlay scale
  included: the filter is per pane, not per scale.
- **Any other pane** starts out a study's and holds its own units, until a host
  plots a price series on it (a second symbol on a pane of its own), which
  promotes it and hands it the tick it was not given.
- An indicator's plots never promote their own pane, built in or custom.

So an overlay study (`placement: 'onchart'`) is quoted in the instrument's tick,
because it draws against the price axis and *is* a price: a Supertrend on a 0.05
tick reads `1339.70`, which is the number an order snaps to. A study on a pane of
its own (`placement: 'pane'`) is not: an RSI is a dimensionless 0..100 band and a
Williams VIX Fix is a percentage, so precision comes from that pane's own span.

The span alone reads too coarse, so those panes carry `minPrecision: 2`. A 0..100
band implies a step of one whole point, which would label the ladder `70` and round
a reading of 62.24 to `62`, past the part a trader comparing it to the level is
looking at. Two decimals is the same floor the percent-rebase branch has always
used, for the same reason. The floor lifts above five integer digits, where a
decimal stops being information: an OBV of `1234567` keeps its integer form.

**A custom descriptor gets all of this with nothing to declare.** The rule is
keyed on the pane an indicator is handed, not on anything in the descriptor, so
`registerIndicator` needs no precision field and there is no per-indicator list to
keep in sync.

`priceToY(price)` / `yToPrice(y)` are pane-local media px; `chart.priceToCoordinate` / `chart.coordinateToPrice` add the pane's top offset. `precision()` derives decimals from `minMove` (or `range/100`), `snapToTick(price)` rounds to `minMove`, `format(price)` renders the axis label, `setPriceFormatter(fn | null)` overrides it, `clampY(y)` clamps to the pane. Tick values come from `niceTicks(min, max, maxTicks = 6)` on the 1 / 2 / 2.5 / 5 / 10 ladder.

### Autoscale rules

Per frame, for each active scale on a pane: skip if `autoScale` is false; scan only visible bars of series matching that scale id and not `visible: false`; take `min`/`max` from the chart type's `extents(bar, style)`. **Only the `'right'` scale also folds in primitive `autoscaleInfo()`**: a `PriceLine` widens the right axis but never the left or overlay one.

## The three scale ids

`PriceScaleId` is `'right' | 'left' | ''`.

| Id | Axis drawn | Autoscales | Typical use |
|---|---|---|---|
| `'right'` | Right strip | Independently | Default for every series. |
| `'left'` | Left strip | Independently | A second instrument or spread at a different magnitude. |
| `''` | None (hidden) | Independently | Volume pinned inside the price pane. |

A pane creates the left and overlay scales lazily, on the first `addSeries` that names them (`Pane._scaleFor`). When any pane has a live left scale, the chart reserves a chart-wide left column of `priceAxisWidth` px and shifts every plot right by it.

```ts
const vol = chart.addSeries('histogram', {
  priceScaleId: '',                    // no axis of its own
  priceFormat: { type: 'volume' },
});
vol.priceScale().setOptions({ marginTop: 0.82, marginBottom: 0 });  // bottom ~18%
```

**`pane.priceScale` is the `'right'` scale only.** The left and overlay scales are private; reach them with `series.priceScale()` or `pane.scaleOf(record)`.

**Prices quoted for a pane follow its readout scale**, which is the scale its first visible price series maps to and falls back to the right one. That covers the crosshair price tag, the last-price line and tag, `chart.priceToCoordinate` / `coordinateToPrice`, and the axis drag, so a pane whose series were moved to the left strip is labelled and read in the same scale rather than tagging the cursor with the right scale's untouched `0..1` placeholder. `pane.readoutScale()` returns it.

**`PrimitiveRenderContext.priceScale` and the `getState` snapshot still read the right scale.** A primitive on a pane whose prices live on the left axis therefore draws against a scale nothing has measured. Keep primitives on panes whose values sit on the right scale until that context carries the readout scale too.

## TimeScaleOptions

```ts
import { DEFAULT_TIME_SCALE_OPTIONS } from 'openalgo-charts';
// { barSpacing: 8, minBarSpacing: 1, maxBarSpacing: 80, rightOffset: 4 }
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `barSpacing` | `number` | `8` | Media px per bar. Always clamped to `[minBarSpacing, maxBarSpacing]`. |
| `minBarSpacing` | `number` | `1` | Floor; read once in the constructor, not settable later. |
| `maxBarSpacing` | `number` | `80` | Ceiling; read once in the constructor, not settable later. |
| `rightOffset` | `number` | `4` | Empty bar slots kept right of the latest bar. Unclamped. |

The chart constructs its own `TimeScale` with defaults, **`ChartOptions` has no `timeScale` key**. Tune the live instance:

```ts
chart.timeScale.setBarSpacing(12);
chart.timeScale.setRightOffset(8);
chart.timeScale.fitContent(bars.length);
```

`chart.timeScale` is shared by every pane, which is why panes stay aligned bar-for-bar.

### The logical-index model

`x = width - (baseIndex + rightOffset - index) * barSpacing`. The x of a bar is a function of its **integer position in the series**, never of its timestamp. Bars get consecutive indices regardless of the real elapsed time between them, so weekends, holidays and session breaks have no index and therefore no blank space to draw, the axis is gapless by construction. `xToIndex` is the exact inverse and returns a fractional index.

`visibleRange()` returns `{ from, to }` as fractional logical indices, unclamped to the data (it can run negative or past the last bar). `setVisibleLogicalRange({ from, to })` picks `barSpacing = width / span`, anchors the right edge at `to`, and fires the repaint hook, it is a no-op when width or span is not positive, and an extreme span lands at the nearest clamped zoom. `zoomAtX(focusX, factor)` keeps the index under `focusX` pinned. `fitContent(barCount)` sets `baseIndex = barCount - 1`, resets `rightOffset` to `4`, and sizes bars to `width / (barCount + rightOffset)`.

## How interaction mutates the scales

Details in [interactions](interactions.md); what matters here is which gesture leaves a scale in **manual** mode.

| Gesture | Effect | Leaves manual? |
|---|---|---|
| Wheel | `timeScale.zoomAtX(x, 1.1 or 1/1.1)` | no |
| Drag inside the plot | horizontal: `setRightOffset`; vertical: `panByPixels` on the pressed pane | **yes** (price scale) |
| Drag either price axis strip (right, or the reserved left column) | `setPriceRange` around the centre by `exp(dy * 0.005)` on **that strip's** scale, then `setAutoScale(false)` | **yes** |
| Drag the time axis strip (bottom pane, last `timeAxisHeight` px) | `setBarSpacing(start * exp(dx * 0.005))` | no |
| Two-finger pinch | zoom time, pan time, `panByPixels` on the pinched pane | **yes** (price scale) |
| Double-click | `chart.resetScale()` | no, restores autoscale everywhere |
| `panUp` / `panDown` shortcuts | `panByPixels(±20)` on **pane 0 only** | **yes** |

**Once a pane goes manual it stops tracking new data.** A live feed that keeps printing highs will run off the top of a pane whose axis the user dragged. Call `pane.priceScale.setAutoScale(true)` or `chart.resetScale()` to recover.

**Both strips are draggable.** The gesture reads and writes the scale the strip actually draws, so dragging a left axis rescales the prices labelled there.

## One axis at a time

`setPriceScaleOptions` and `setAutoScale` are chart-wide. A menu or an inspector raised on one strip wants one scale, and wants to read every item back so it can draw its own ticks:

```ts
const st = chart.priceAxisState(paneIndex, scaleId);   // PriceAxisState | null
chart.setPriceAxisOptions(paneIndex, scaleId, { mode: 'logarithmic' });
chart.setPriceAxisAutoFit(paneIndex, scaleId, true);   // also releases the ratio lock
chart.setPriceAxisLockRatio(paneIndex, scaleId, true); // false when it could not be taken
chart.movePriceAxis(paneIndex, 'right', 'left');       // false when the move is impossible
```

`PriceAxisState` is `{ paneIndex, scaleId, side, active, autoFit, inverted, mode, scaled, lockRatio, movable }`, and `PRICE_SCALE_MODES` lists the four modes in menu order. `scaleId` comes straight off a `contextmenu` target, including the `''` overlay case.

- **Moving an axis swaps the two side scales** rather than copying their state, so range, mode, margins and formatter travel with it. The vacated strip restarts from the chart-wide defaults, the axis columns are recomputed so a strip no pane uses any more is released and the plot reclaims its width, a `priceAxisMoved` event is emitted, and a move onto an occupied side is refused: one strip draws one axis.
- **The ratio lock pins price-per-bar.** The pane remembers the geometry the lock was taken at and rescales the visible span by height over bar spacing each frame, in transformed space, so a logarithmic axis keeps its angle too. Auto-fit and `resetScale` release it, and it is refused on a scale nothing has measured (`scaled: false`), because there is no ratio to hold.
- **`active: false`** means no series maps to that scale. It is a row to render disabled with its state showing, not one to leave out.

See [settings-and-menus](settings-and-menus.md) for the menu around these.

## Axis chrome

Two optional readings on the axis strips, both **off** unless a chart asks for them, so a chart that omits the block draws the axes it always drew.

```ts
const chart = createChart(el, {
  axisChrome: {
    sessionClock: true,                    // or { showOffset: false }
    barCountdown: true,
    clock: () => feedTimeUtcSeconds(),     // defaults to the system clock
  },
});

chart.setAxisChromeOptions({ barCountdown: false });   // merged field by field
chart.axisChromeOptions();
```

| Option | Draws |
|---|---|
| `sessionClock` | A live clock in the corner where the price and time strips meet, formatted in the **chart's** timezone with that zone's offset from UTC on a second row. `{ showOffset: false }` drops the row, and it drops itself in a strip too short to carry it. Nothing is drawn when either strip is hidden. |
| `barCountdown` | A second row inside the last-price tag counting down to the current bar's close. The tag grows from 16 to 28 media px and its width follows the wider row. |
| `clock` | Wall-clock **UTC seconds**, not a monotonic animation clock. Pass the feed's clock to keep a delayed or replayed chart honest about the time its data thinks it is. |

**The bar interval is read back off the bars**, as a median of the recent gaps, not configured: the chart is never told its own timeframe, and one that switches mid-session has to follow. A median rather than a minimum, so a backfilled duplicate two seconds apart cannot halve the cadence; and only the tail is sampled, so a year of daily history does not outvote the intraday feed running now. Past a bar's close the count rolls into the next bar's cycle instead of stalling at `00:00:00`, because a feed a second late with the new bar should still show a running clock. With no readable cadence the row reads `--:--:--` rather than vanishing.

**Price-axis ticks give way to the labels above them.** The pane reserves the band the last-price tag will occupy before the ladder is drawn, and a tick colliding with it is dropped instead of drawn through. The priority order is crosshair, then last price, then a price line, then a session level, then previous close, then a plain tick, on the principle that the label a reader could interpolate from its neighbours is the one to lose.

Since the ladder became denser in 1.8.5 this is no longer a rare event: rungs sit about a tag-height apart, so the last-price tag now essentially always suppresses the label beside it. That matches a reference terminal, which hides the prices either side of its own tag for the same reason. The rule did not change, only how often it fires.

**A host drawing its own last-price line should stop.** The engine already draws a dashed line across the plot and a filled axis tag at that price, coloured by the forming candle's direction. A second `PriceLine` at the same price puts two tags on one pixel row, printed through each other. The engine's is also the one to keep: it reserves its band before the ladder is drawn, so neighbouring prices yield to it rather than being painted over, and it carries the bar-close countdown. A `PriceLine` takes part in neither, since its tag is drawn straight onto the strip.

## Panes

A pane is one stacked drawing region with its own scales and canvases. Reference a `paneIndex` in `addSeries` (or `addIndicator`) and every missing pane up to it is created: pane 0 with weight `1`, later panes with weight `0.32`.

```ts
chart.addSeries('candlestick');                       // pane 0
chart.addSeries('histogram', { paneIndex: 1 });       // pane 1, created here
chart.addSeries('line', { paneIndex: 2 });            // pane 2
```

Heights are **relative weights**, not pixels: pane height is `chartHeight * weight / sumOfWeights`.

| Method | Returns | Notes |
|---|---|---|
| `chart.setPaneWeight(index, weight)` | `void` | Clamped to a minimum of `0.05`. Unknown index is a silent no-op. |
| `chart.paneWeight(index)` | `number` | `0` for an unknown index. |
| `chart.removePane(index)` | `boolean` | Removes its series, data rows and indicators. |
| `chart.movePane(index, -1 \| 1)` | `boolean` | Swaps with the neighbour and re-appends the DOM in order. |
| `chart.maximizePane(index)` | `boolean` | Toggle: one pane takes the whole chart and the rest are **hidden**, not shrunk. Stored weights are untouched, so un-maximizing restores the stack exactly. |
| `chart.maximizedPane()` | `number \| null` | |
| `chart.panes()` | `readonly Pane[]` | Live array. |

Each call emits an event: `paneRemoved`, `paneMoved`, `paneMaximized`, and `paneResized` after a divider drag.

**Pane 0 is pinned.** `removePane(0)` and any `movePane` that would displace pane 0 return `false`, including `movePane(1, -1)`. Both also return `false` for an out-of-range index, so check the boolean rather than assuming success.

**Removing a pane re-indexes everything below it.** Indicators shift with their pane, but any `paneIndex` a host has cached is stale afterwards.

Panes with no series left are pruned automatically: `removeIndicator` drops an emptied pane above index 0, and `restoreState` sweeps every empty pane backwards.

### Divider dragging

Pressing within `4` media px of a boundary starts a resize; the cursor becomes `row-resize` on hover. The drag moves height between the two adjacent panes only, conserving their summed weight so the rest of the stack is untouched, and clamps each side to at least `min(24px, total/4)`. A pane boundary wins over a primitive hit, because legend rows sit directly below one.

`chart.getState()` persists every pane's `weight` plus its right scale's `marginTop`, `marginBottom`, `minMove`, `mode`, `inverted`, `autoScale` and (when manual) `range`. See [events-and-state](events-and-state.md).
