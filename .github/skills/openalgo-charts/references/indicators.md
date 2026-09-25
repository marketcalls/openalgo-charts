# Indicators

## Per-bar open interest

`OPEN_INTEREST`, `OPEN_INTEREST_CHANGE` and `OPEN_INTEREST_BUILDUP` are exported
descriptors in the indicators tier. Their registered ids are `open-interest`,
`open-interest-change` and `open-interest-buildup`. They use the source bar's
optional `oi`; no external alignment or fetch is required. The first plots a
compact position level, the second an adjacent difference, and the third paints
the four price/OI regimes onto the main candles. Missing readings stay null.
See [Open interest](../../../../docs/open-interest.md) for inputs and semantics.

`ChartDataContext.hasOpenInterest?: boolean` and readonly `chart.hasOpenInterest`
are host-supplied capability, not an inference from observed values. False means
unsupported, absent means unknown. Set `statusLine.openInterest: true` to opt in
to the readout. Canvas readings use `field: 'openInterest'`; `PaneLegendOptions`
also accepts `hasOpenInterest`, which the owning chart supplies automatically.
The widget shows available hovered/latest values and disables an unsupported
setting without clearing its preference. A language host reads per-bar `oi`
and this separate capability flag.

## Volume direction and average

The `volume` study keeps its single-colour histogram by default. Set
`colorByDirection: true` and supply `upColor` / `downColor` to follow candle
direction (a doji is up). The host can pass its current candle palette when the
theme changes. Set `showMA: true` and `maPeriod` (default 20) for a simple volume
average on the same scale. It starts after a complete window, recomputes on live
corrections and respects a replay prefix. `maColor` and the generated plot-style
controls configure the line. Turning the average off leaves gaps, not zeroes.

*When to read this: you are adding a built-in indicator to a chart, generating a settings UI from a descriptor, writing a custom indicator, or wiring an indicator whose data does not come from the chart's OHLCV.*

## The one-line import rule

```ts
import { createChart } from 'openalgo-charts';
import 'openalgo-charts/indicators'; // side effect: registers all 105 built-ins
```

- The base bundle ships **only** the registry (`registerIndicator`, `getIndicator`, ...) and the runtime (`IndicatorInstance`). The catalog lives in the lazy `openalgo-charts/indicators` tier.
- The import is a side effect. `src/indicators/index.ts` calls `registerBuiltinIndicators()` at module scope; it is also exported and idempotent, so a bundler that tree-shakes a bare side-effect import can call it explicitly.
- `getIndicator(id)` throws for an unregistered id, with a message naming the id and pointing at the missing `'openalgo-charts/indicators'` import. `chart.addIndicator` calls it, so guard user-supplied ids with `hasIndicator(id)`.
- `registeredIndicators()` reflects what has been registered *so far*. Read it after the tier import.

**A tier must import the registry from the package entry (`'openalgo-charts'`), never a deep path.** Each tier is its own rollup bundle with `openalgo-charts` marked external (`rollup.config.js`, `tierExternal`). A deep import is *inlined* instead (a second, private `Map`), so the tier registers into a registry `createChart` never reads. This applies to any tier bundle you build yourself.

## The 105 built-ins

`onchart` overlays the price pane (pane 0); `pane` claims a fresh pane. Defaults shown are the descriptor's declared `input.default`.

**Colour inputs are omitted from these tables on purpose.** Every descriptor declares its own colour keys (`color`, `upColor`, `macdColor`, `bandColor`, ...), and the only safe way to read one is `plotStyleKeys(plot).color`. Hand-composing `` `${plotKey}:color` `` is the single most common way to write an indicator patch that is silently ignored. See the settings model below.

`category` is one of exactly four strings, used only to group a picker UI: Trend (36), Momentum (29), Volatility (22), Volume (18).

### Trend (36)

| id | Name | Placement | Plot keys | Inputs (defaults) |
|---|---|---|---|---|
| `seasonality` | Seasonality | pane | `seasonality` (all-null; the output is a table) | `startYear` 2015, `cutoffPercent` 10, `tablePosition` `'Center'`, `tableWidth` 100, `tableHeight` 95, `showAvg` `true`, `showStDev` `true`, `showPos` `true`, `ignoredMonths` `'YYYY-MM, YYYY-MM'` |
| `sma` | SMA | onchart | `ma` | `length` 9, `source` `'close'` |
| `ema` | EMA | onchart | `ma` | `length` 9, `source` `'close'` |
| `wma` | WMA | onchart | `ma` | `length` 9, `source` `'close'` |
| `smma` | Smoothed Moving Average | onchart | `smma` | `length` 7, `source` `'close'` |
| `supertrend` | Supertrend | onchart | `up`, `down` | `period` 10, `multiplier` 3 |
| `halftrend` | HalfTrend | onchart | `up`, `down`, `atrHigh`, `atrLow`, `buySignal`, `sellSignal` | `amplitude` 2, `channelDeviation` 2, `atrPeriod` 100, `showChannels` `true`, `showSignals` `true`, `showLabels` `true` |
| `parabolic-sar` | Parabolic SAR | onchart | `sar` | `start` 0.02, `increment` 0.02, `maximum` 0.2 |
| `ichimoku` | Ichimoku Cloud | onchart | `conversion`, `base`, `spanA`, `spanB`, `lagging` | `conversionPeriod` 9, `basePeriod` 26, `laggingSpanPeriod` 52, `displacement` 26 |
| `adx` | ADX / DMI | pane | `plusDi`, `minusDi`, `adx` | `period` 14, `adxPeriod` 14 |
| `alphatrend` | AlphaTrend | onchart | `alphatrend`, `lagged` | `coeff` 1, `AP` 14, `source` `'close'`, `showsignalsk` `true`, `novolumedata` `false` |
| `alma` | Arnaud Legoux Moving Average | onchart | `alma` | `length` 9, `offset` 0.85, `sigma` 6 |
| `dema` | Double EMA | onchart | `dema` | `length` 9, `source` `'close'` |
| `hma` | Hull Moving Average | onchart | `hma` | `length` 9, `source` `'close'` |
| `hull-suite` | Hull Suite | onchart | `mhull`, `shull` | `source` `'close'`, `mode` `'Hma'`, `length` 55, `lengthMult` 1, `switchColor` `true`, `candleCol` `false`, `visualSwitch` `true` |
| `chande-kroll-stop` | Chande Kroll Stop | onchart | `stopLong`, `stopShort` | `p` 10, `x` 1, `q` 9 |
| `chandelier-exit` | Chandelier Exit | onchart | `longExit`, `shortExit` | `length` 22, `atrLength` 22, `atrMultiplier` 3 |
| `aroon` | Aroon | pane | `up`, `down` | `length` 14 |
| `aroon-oscillator` | Aroon Oscillator | pane | `osc` | `length` 14 |
| `kama` | Kaufman's Adaptive Moving Average | onchart | `kama` | `erLength` 10, `fastLength` 2, `slowLength` 30, `source` `'close'` |
| `lsma` | Least Squares Moving Average | onchart | `lsma` | `length` 25, `offset` 0, `source` `'close'` |
| `linreg-slope` | Linear Regression Slope | pane | `slope` | `periods` 14 |
| `ma-cross` | MA Cross | onchart | `short`, `long`, `cross` | `shortLength` 9, `longLength` 26 |
| `cpr` | CPR with Floor Pivot | onchart | 27: `{d,w,m}` x `Pivot`, `S1`-`S3`, `R1`-`R3`, `Bc`, `Tc` | `pivotMode` `'auto'`, `showDaily` `true`, `showWeekly` `false`, `showMonthly` `false`, `displayS1R1` `false` |
| `mcginley-dynamic` | McGinley Dynamic | onchart | `mg` | `length` 14 |
| `median` | Median | onchart | `median`, `upper`, `lower`, `medianEma` | `source` `'hl2'`, `length` 3, `atrLength` 14, `atrMult` 2 |
| `ma-ribbon` | Moving Average Ribbon | onchart | `ma1`, `ma2`, `ma3`, `ma4` | `showMa1` `true`, `ma1Type` `'SMA'`, `ma1Source` `'close'`, `ma1Length` 20, `showMa2` `true`, `ma2Type` `'SMA'`, `ma2Source` `'close'`, `ma2Length` 50, `showMa3` `true`, `ma3Type` `'SMA'`, `ma3Source` `'close'`, `ma3Length` 100, `showMa4` `true`, `ma4Type` `'SMA'`, `ma4Source` `'close'`, `ma4Length` 200 |
| `tema` | Triple EMA | onchart | `tema` | `length` 9 |
| `t3` | T3 Average | onchart | `t3` | `length` 5, `factor` 0.7, `highlightMovements` `true`, `source` `'close'` |
| `twap` | Time Weighted Average Price | onchart | `twap` | `anchor` `'session'`, `source` `'ohlc4'`, `offset` 0 |
| `alligator` | Williams Alligator | onchart | `jaw`, `teeth`, `lips` | `jawLength` 21, `teethLength` 13, `lipsLength` 8, `jawOffset` 8, `teethOffset` 5, `lipsOffset` 3 |
| `vortex` | Vortex Indicator | pane | `vip`, `vim` | `length` 14 |
| `volatility-stop` | Volatility Stop | onchart | `up`, `down` | `length` 20, `source` `'close'`, `factor` 2 |
| `trend-strength-index` | Trend Strength Index | pane | `tsi` | `length` 14 |
| `williams-fractals` | Williams Fractals | onchart | `fractals` | `periods` 2, `showUp` `true`, `showDown` `true` |
| `consolidation-breakout` | Consolidation and Breakout | onchart | `rangeHigh`, `rangeLow` | `markbreakout` `true`, `colorinside` `true` |

### Momentum (29)

| id | Name | Placement | Plot keys | Inputs (defaults) |
|---|---|---|---|---|
| `rsi` | RSI | pane | `rsi` | `length` 14, `source` `'close'`, `overbought` 70, `oversold` 30 |
| `macd` | MACD | pane | `histogram`, `macd`, `signal` | `fastPeriod` 12, `slowPeriod` 26, `signalPeriod` 9, `source` `'close'` |
| `stochastic` | Stochastic | pane | `k`, `d` | `kPeriod` 14, `kSmoothing` 1, `dPeriod` 3 |
| `cci` | CCI | pane | `cci`, `ma`, `bbUpper`, `bbLower` | `period` 20, `constant` 0.015, `maType` `'SMA'`, `maLength` 20, `bbMult` 2 |
| `mfi` | Money Flow Index | pane | `mfi` | `period` 14 |
| `awesome-oscillator` | Awesome Oscillator | pane | `ao` | (none) |
| `balance-of-power` | Balance of Power | pane | `bop` | (none) |
| `chande-momentum` | Chande Momentum Oscillator | pane | `cmo` | `length` 9, `source` `'close'` |
| `coppock-curve` | Coppock Curve | pane | `curve` | `wmaLength` 10, `longRoCLength` 14, `shortRoCLength` 11 |
| `dpo` | Detrended Price Oscillator | pane | `dpo` | `period` 21, `isCentered` `false` |
| `fisher-transform` | Fisher Transform | pane | `fisher`, `trigger` | `length` 9 |
| `connors-rsi` | Connors RSI | pane | `crsi` | `lenrsi` 3, `lenupdown` 2, `lenroc` 100 |
| `know-sure-thing` | Know Sure Thing | pane | `kst`, `signal` | `roclen1` 10, `roclen2` 15, `roclen3` 20, `roclen4` 30, `smalen1` 10, `smalen2` 10, `smalen3` 10, `smalen4` 15, `siglen` 9 |
| `momentum` | Momentum | pane | `mom` | `len` 10, `source` `'close'` |
| `roc` | Rate Of Change | pane | `roc` | `length` 9, `source` `'close'` |
| `ppo` | Percentage Price Oscillator | pane | `hist`, `ppo`, `signal` | `source` `'close'`, `fastLength` 12, `slowLength` 26, `signalLength` 9, `oscType` `'EMA'`, `sigType` `'EMA'` |
| `trix` | TRIX | pane | `trix` | `length` 18 |
| `tsi` | True Strength Index | pane | `tsi`, `signal` | `long` 25, `short` 13, `signal` 13 |
| `smi-ergodic-indicator` | SMI Ergodic Indicator | pane | `erg`, `sig` | `longlen` 20, `shortlen` 5, `siglen` 5 |
| `smi-ergodic-oscillator` | SMI Ergodic Oscillator | pane | `osc` | `longlen` 20, `shortlen` 5, `siglen` 5 |
| `smi` | Stochastic Momentum Index | pane | `smi`, `ema` | `lengthK` 10, `lengthD` 3, `lengthEMA` 3 |
| `stochastic-rsi` | Stochastic RSI | pane | `k`, `d` | `smoothK` 3, `smoothD` 3, `lengthRSI` 14, `lengthStoch` 14, `source` `'close'` |
| `wavetrend` | WaveTrend Pro | pane | `mom`, `wt1`, `wt2` | `source` `'hlc3'`, `n1` 10, `n2` 21, `sigLen` 4, `obLevel1` 60, `obLevel2` 53, `osLevel1` -60, `osLevel2` -53, `filterZone` `true`, `useInner` `true`, `showMom` `true`, `showRegDiv` `true`, `showHidDiv` `false`, `lbL` 3, `lbR` 3, `rangeUpper` 60, `rangeLower` 5 |
| `williams-percent-r` | Williams Percent Range | pane | `percentR` | `length` 14, `source` `'close'` |
| `ultimate-oscillator` | Ultimate Oscillator | pane | `uo` | `length1` 7, `length2` 14, `length3` 28 |
| `relative-vigor-index` | Relative Vigor Index | pane | `rvgi`, `signal` | `length` 10, `offset` 0 |
| `woodies-cci` | Woodies CCI | pane | `hist`, `turbo`, `cci14` | `cciTurboLength` 6, `cci14Length` 14 |
| `special-k` | Pring's Special K | pane | `specialK`, `signal` | `source` `'close'`, `length1` 100, `length2` 100 |
| `rsi-divergence` | RSI Divergence Indicator | pane | `rsi` | `length` 14, `source` `'close'`, `lbR` 5, `lbL` 5, `rangeUpper` 60, `rangeLower` 5, `plotBull` `true`, `plotHiddenBull` `false`, `plotBear` `true`, `plotHiddenBear` `false` |

### Volatility (22)

| id | Name | Placement | Plot keys | Inputs (defaults) |
|---|---|---|---|---|
| `bollinger` | Bollinger Bands | onchart | `upper`, `basis`, `lower` | `length` 20, `stdDev` 2, `source` `'close'` |
| `atr` | ATR | pane | `atr` | `period` 14 |
| `williams-vix-fix` | William VIX FIX | pane | `wvf`, `rangeHigh`, `rangeLow`, `upperBand` | `pd` 22, `bbl` 20, `mult` 2, `lb` 50, `ph` 0.85, `pl` 1.01, `hp` `false`, `sd` `false` |
| `envelope` | Envelope | onchart | `upper`, `basis`, `lower` | `length` 20, `percent` 10, `source` `'close'`, `exponential` `false` |
| `donchian` | Donchian Channels | onchart | `upper`, `basis`, `lower` | `length` 20, `offset` 0 |
| `bollinger-percent-b` | Bollinger Bands %b | pane | `percentB` | `length` 20, `source` `'close'`, `mult` 2 |
| `bollinger-bandwidth` | Bollinger BandWidth | pane | `bandwidth`, `expansion`, `contraction` | `length` 20, `source` `'close'`, `mult` 2, `expansionLength` 125, `contractionLength` 125 |
| `bb-trend` | BBTrend | pane | `bbtrend` | `shortLength` 20, `longLength` 50, `stdDevMult` 2 |
| `choppiness-index` | Choppiness Index | pane | `chop` | `length` 14, `offset` 0 |
| `historical-volatility` | Historical Volatility | pane | `hv` | `length` 10, `per` 1 |
| `chaikin-volatility` | Chaikin Volatility | pane | `chaikinVolatility` | `periods` 10, `rocLookback` 10 |
| `standard-deviation` | Standard Deviation | pane | `stdDev` | `periods` 5, `deviations` 1 |
| `standard-error` | Standard Error | pane | `stdErr` | `length` 14 |
| `average-daily-range` | Average Daily Range | pane | `adr` | `length` 14 |
| `chop-zone` | Chop Zone | pane | `chopZone` | (none) |
| `keltner-channel` | Keltner Channels | onchart | `upper`, `basis`, `lower` | `length` 20, `mult` 2, `source` `'close'`, `exp` `true`, `bandsStyle` `'Average True Range'`, `atrlength` 10 |
| `standard-error-bands` | Standard Error Bands | onchart | `upper`, `basis`, `lower` | `periods` 21, `errors` 2, `method` `'Simple'`, `averagePeriods` 3 |
| `ma-channel` | Moving Average Channel | onchart | `upper`, `lower` | `upperLength` 20, `lowerLength` 20, `upperOffset` 0, `lowerOffset` 0 |
| `mass-index` | Mass Index | pane | `mi` | `length` 10 |
| `ulcer-index` | Ulcer Index | pane | `ui` | `source` `'close'`, `length` 14 |
| `range-analysis` | Range Analysis | pane | `range`, `avgRange` | `showAverage` `false`, `avgLength` 3 |
| `relative-volatility-index` | Relative Volatility Index | pane | `rvi`, `ma`, `bbUpper`, `bbLower` | `length` 10, `offset` 0, `maType` `'SMA'`, `maLength` 14, `bbMult` 2 |

### Volume (18)

| id | Name | Placement | Plot keys | Inputs (defaults) |
|---|---|---|---|---|
| `open-interest` | Open Interest | pane | `oi` | (none besides appearance) |
| `open-interest-change` | Open Interest Change | pane | `change` | (none besides appearance) |
| `open-interest-buildup` | Open Interest Buildup | onchart | none; candle colors, `state` output | `unchanged` `'neutral'` (`'up'` also supported) |
| `vwap` | VWAP | onchart | `vwap`, `upper1`, `lower1`, `upper2`, `lower2`, `upper3`, `lower3` | `anchor` `'session'`, `source` `'hlc3'`, `offset` 0, `calcMode` `'stdev'`, `showBand1` `true`, `bandMult1` 1, `showBand2` `false`, `bandMult2` 2, `showBand3` `false`, `bandMult3` 3 |
| `volume` | Volume | pane | `volume` | (none) |
| `net-volume` | Net Volume | pane | `net` | (none) |
| `obv` | On-Balance Volume | pane | `obv`, `ma`, `bbUpper`, `bbLower` | `maType` `'None'`, `maLength` 9, `bbMult` 2 |
| `adl` | Accumulation/Distribution | pane | `adl` | (none) |
| `chaikin-money-flow` | Chaikin Money Flow | pane | `cmf` | `length` 20 |
| `chaikin-oscillator` | Chaikin Oscillator | pane | `osc` | `short` 3, `long` 10 |
| `ease-of-movement` | Ease of Movement | pane | `eom` | `length` 14, `divisor` 10000 |
| `elder-force-index` | Elder Force Index | pane | `efi` | `length` 13 |
| `klinger-oscillator` | Klinger Oscillator | pane | `kvo`, `signal` | (none) |
| `vwma` | Volume Weighted Moving Average | onchart | `vwma` | `length` 20, `source` `'close'`, `offset` 0 |
| `nvi` | Negative Volume Index | pane | `nvi`, `ema` | `maLength` 255 |
| `pvi` | Positive Volume Index | pane | `pvi`, `ema` | `maLength` 255 |
| `pvt` | Price Volume Trend | pane | `pvt` | (none) |
| `pvo` | Percentage Volume Oscillator | pane | `hist`, `pvo`, `signal` | `fastLength` 12, `slowLength` 26, `signalLength` 9, `oscType` `'EMA'`, `sigType` `'EMA'` |

Notes that bite:

- **Ids are hyphenated lowercase and are not derivable from the display name.** `williams-percent-r`, not `willr`. `bollinger-percent-b`, not `bbpercentb`. `special-k` is named `Pring's Special K`. `momentum` takes `len`, not `length`. Resolve an id with `hasIndicator(id)` before calling `addIndicator`.
- Plot keys are namespaced per instance, not globally. `ma` is a plot key on `sma`, `ema`, `wma`, `cci`, `obv` and `relative-volatility-index`; `up`/`down` on `supertrend`, `halftrend`, `aroon` and `volatility-stop`; `signal` on `macd`, `ppo`, `pvo`, `tsi`, `klinger-oscillator`, `know-sure-thing`, `relative-vigor-index` and `special-k`. Style patches are per-instance, so this is not a collision, but do not key host state on the plot key alone.
- `hma` uses `max(1, floor(length / 2))` for its fast weighted window and
  `max(1, round(sqrt(length)))` for its final weighted window. It first emits at
  zero-based index `length + round(sqrt(length)) - 2`. Length 1 returns the source.
  Hull Suite's Hma mode uses the same kernel. Odd and non-square lengths differ
  from the fractional-half and floored-root convention used before 2.5.4.
- `cpr` requires finite highs and lows for every observation in its prior period.
  A nonfinite extreme invalidates that period until the next existing session or
  calendar boundary. A complete later period recovers. Only the period's final
  close is used; the schedule, display controls and pivot formulas are unchanged.
- `select` inputs carry their own `options`. The recurring ones: `maType` on `cci`/`obv`/`relative-volatility-index` is `None | SMA | SMA + Bollinger Bands | EMA | SMMA (RMA) | WMA | VWMA`; `ma1Type`..`ma4Type` on `ma-ribbon` drop the first two; `oscType`/`sigType` on `ppo`/`pvo` are `EMA | SMA`; `bandsStyle` on `keltner-channel` is `Average True Range | True Range | Range`; `calcMode` on `vwap` is `stdev | percent`. `mode` on `hull-suite` is `Hma | Thma | Ehma`. Its labels (HMA / THMA / EHMA) are not its values, as is also true of `anchor` on `vwap` and `twap`, `calcMode` on `vwap` and `pivotMode` on `cpr`: store `option.value`, render `option.label`, and never round-trip the label back into settings.
- `vwap` defaults to `source: 'hlc3'`, not `'close'`. **Its `session` anchor is the trading session read back from the bar gaps** (`sessionStartFlags`), not a calendar day: see [Trading sessions](#trading-sessions) below. The coarser anchors (`week`, `month`, `quarter`, `year`) are calendar boundaries tested on the chart's `timezone` (default `Asia/Kolkata`) and compared at session opens, so a Friday session that ends after midnight in that zone is not split. `anchor` accepts `session | week | month | quarter | year | continuous`. It also declares six band plots (`upper1`/`lower1` .. `upper3`/`lower3`) with only band 1 shown by default. `twap` has the shorter `session | continuous`, with the same gap-read session.
- The other calendar-anchored built-ins follow the same rule: `cpr`'s Daily frame comes from the bar gaps while its Weekly and Monthly frames are calendar boundaries in the chart's zone, and `seasonality` attributes a bar's close to the month it closed in **in that zone**, which is why the last ninety minutes of a 30 April New York session count as April on `America/New_York` and as May on the IST default.
- `supertrend` splits one band into two plots. Each carries `null` while the other is active so the line renderer breaks at flips. Direction convention: `-1` = uptrend (`up` plot), `+1` = downtrend (`down` plot). `halftrend` and `volatility-stop` use the same two-plot split.
- **A `calc` result may carry columns that no plot names.** `williams-vix-fix` returns `alertUpper`/`alertHigh` so `colorBy` keeps working when `sd`/`hp` hide the bands; `supertrend` returns `bodyMid`; `consolidation-breakout` returns `breakUp`, `breakDown` and `insideAge` for its markers and its bar tint to read; the shaded-band indicators return constant `upperLevel`/`lowerLevel`/`bandHigh`/`bandLow`/`zero` columns purely so a fill has something to reference. They appear in `values()` and are never drawn.
- Twelve plots use `colorBy` for per-bar colour: `macd:histogram`, `williams-vix-fix:wvf`, `wavetrend:mom`, `woodies-cci:hist`, `awesome-oscillator:ao`, `bb-trend:bbtrend`, `chop-zone:chopZone`, `ppo:hist`, `pvo:hist`, `t3:t3`, `hull-suite:mhull`, `hull-suite:shull`. **Line plots honour it too**, not only `histogram` and `column`: the colour reaches the renderer as the point's `color` and the line is stroked in same-colour runs, which is how `t3` and `hull-suite` recolour a *continuous* line instead of splitting into two series with a gap at every flip. `colorBy` is called only on finite slots, and returning `undefined` falls back to the plot's declared colour.
- **Ten input defaults moved in 1.8.3 to match the standard definitions.** `sma`, `ema` and `wma` `length` 20 to 9; `stochastic` `kSmoothing` 3 to 1; `cci` `maLength` 14 to 20; `obv` `maLength` 14 to 9; `ma-cross` `longLength` 21 to 26; `alligator` `jawLength` / `teethLength` / `lipsLength` 13 / 8 / 5 to 21 / 13 / 8. A host that persisted a user's settings keeps the stored value, so only a fresh instance picks up the new default. Read `indicatorDefaults(descriptor)` rather than hard-coding a number the release can move.
- **`net-volume` has no warmup gap at all: bar 0 is `0`, not `null`.** It signs the bar's own volume by the sign of the close change, and bar 0 has no previous close, so neither the up nor the down arm holds and the value falls through to zero. Code that assumes every indicator opens with a run of nulls, or that trims leading nulls to find the first real reading, gets bar 0 wrong here.
- `standard-error` and `standard-error-bands` fit a least-squares line and divide by `length - 2`, so their length input is floored at 3, not 1. `standard-deviation` is the population form (divide by `n`), which is why it reads lower than a sample standard deviation over the same window.
- **`t3` is six exponential averages deep, so it starts far later than its length suggests.** One layer is two chained averages and the layers nest three deep, so the first printed value lands at `6 * (length - 1)`: index 24 at the default `length` 5, not index 4. `factor` (0.7) is how much of each layer's own lag it trades away; at 1 a layer is a plain double EMA, at 0 the study collapses to three chained averages. `highlightMovements` paints the one `t3` line through `colorBy`, rising against falling, so turning it off leaves the same continuous line in its plain colour rather than a second series.
- **`hull-suite` plots one hull average twice, the second copy displaced two bars.** `mhull` is the average, `shull` is that same series shifted two bars right, and the fill between them is the band: "first plot above second" is exactly "the hull is above where it stood two bars ago", which is what lets a two-colour fill carry the trend without a second study. `mode` picks the variation (`Hma`, `Thma`, `Ehma`) and `length` 55 times `lengthMult` 1 is the effective length, except that the `Thma` branch is handed **half** of it, a quirk of the published definition kept deliberately so the line matches the one users compare against. Warmup at the defaults is 60 bars for `Hma` and `Ehma` and 52 for `Thma`. `visualSwitch: false` nulls `shull` outright so the displaced line and its band disappear together, and `switchColor: false` returns both lines to `neutralColor`. Every colour decision reads `values.mhull`, never each line's own column, so the lines, the band and the candles cannot disagree.
- **`consolidation-breakout` is a state machine, not a formula, and it has no warmup.** A carried "mother" bar defines the range; every later bar whose *body* (open to close, wicks ignored) sits inside that range extends the consolidation, and the first body to escape it fires a marker and becomes the new mother on the same bar. `rangeHigh` and `rangeLow` are `null` wherever no consolidation is running, so the two rails break between one range and the next instead of joining them, and that gap is the reading. A range is breakable only from the second bar after its mother and only for 250 bars: both are constants of the definition, not inputs, because neither has a setting a user would tune. Bar 0 prints its own high and low and opens the first range.
- **`hull-suite` and `consolidation-breakout` are the only built-ins that recolour the price candles.** See `barColors` below. `hull-suite` claims them only when `candleCol` is exactly `true`, so an absent key never repaints someone else's candles; `consolidation-breakout` tints every inside bar unless `colorinside` is off, and leaves the mother bar its own colour because the mother is the range, not something inside it. Only one indicator's colours can be on the candles at a time, so these two fight each other.
- `ma-channel` is a mean of the highs and a mean of the lows, each with its own length and its own plot-time offset, not a mean of the close with a spread. Its two legs therefore warm up independently: at `upperLength` 34 and `lowerLength` 13 the lower plot prints 21 bars before the upper one does.
- No built-in implements `calcTail`, so each recomputes over the loaded history; window helpers can add a period-dependent cost. **Since 1.8.4 that is paid once per animation frame, not once per tick**: a data update marks the indicators stale and the flush runs before the next paint, so a burst of ticks between two frames costs one pass rather than one per tick. Measured on a 1875-bar chart with 50 ticks between frames, that took a ten-indicator pane from 643 ms of blocked main thread to 21 ms. Cost is now bounded by the display refresh and by how much history is loaded, not by how fast the feed ticks.
- Source values: `'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4' | 'volume'`. `INDICATOR_SOURCES` is the option list for a UI and deliberately omits `'volume'`.
- The descriptors implement published mathematical formulas with explicit initialization and missing-value conventions. Check those conventions when comparing outputs. They live in `src/indicators/` split by family: `trend.ts`, `momentum.ts`, `volume.ts`, `overlay.ts`, `oscillators.ts`, `volatility.ts`, `flow.ts`, `adaptive.ts`, `averages.ts`, `strength.ts`, `indices.ts`, `ranges.ts`, `signals.ts`, plus `external.ts` for the Tier-2 contract and `calc.ts` for the shared math. `index.ts` is a manifest that concatenates them into `BUILTIN_INDICATORS`.

## `chart.addIndicator`

```ts
addIndicator(
  indicatorId: string,
  settings?: Readonly<IndicatorSettings>,
  options?: { paneIndex?: number },
): IndicatorApi
```

`options.paneIndex` overrides placement entirely: a `pane` indicator can be dropped onto pane 0, or a second indicator onto an existing pane. An instance that did **not** create its own pane never applies `range()`; a shared pane belongs to whoever created it.

```ts
const macd = chart.addIndicator('macd', { fastPeriod: 8 });
const rsi = chart.addIndicator('rsi', {}, { paneIndex: macd.paneIndex }); // share the pane
```

`IndicatorApi` (`src/model/indicator-instance.ts`):

| Member | Type | Notes |
|---|---|---|
| `id` | `string` | Instance id, `` `${descriptorId}-${n}` ``. Pass this to `chart.removeIndicator`. |
| `indicatorId` | `string` | Descriptor id, e.g. `'macd'`. |
| `name` | `string` | Display name. |
| `paneIndex` | `number` | Mutable: the chart re-indexes it when panes move or are removed. |
| `settings()` | `IndicatorSettings` | A **copy**. Mutating it does nothing. |
| `setSettings(patch)` | `void` | Merge, restyle, recompute, re-run `attach`. |
| `series(plotKey)` | `SeriesApi \| undefined` | Backing series, for direct styling. |
| `values()` | `IndicatorValues` | Live **reference** into the last `calc` result. Do not mutate. |
| `visible()` / `setVisible(on)` | `boolean` / `void` | The legend eye toggle; hides plots and fills without removing. |
| `legend()` | `PaneLegend \| null` | This indicator's legend row. |
| `updateLegendValues(index?)` | `void` | Refresh readings for a bar index; omit for the latest bar. |
| `remove()` | `void` | Tears down series, levels, fills, legend. Idempotent. |

`recompute()` exists on `IndicatorInstance` but is **not** on the `IndicatorApi` type: the runtime calls it. Since 1.8.4 a data change only *marks* the indicators stale and requests a frame; the recompute happens in that frame, before the paint.

**Deferring the maths does not defer the answer.** Both read paths flush anything pending first: `chart.indicators()` and an instance's `values()`. So a host that updates a bar and reads a value back in the same turn still gets the fresh number, and needs no change. A host implementing `IndicatorHost` itself may supply the optional `flushIndicators()` hook; omit it and nothing breaks, because a host that recomputes eagerly has nothing to flush.

One consequence for a descriptor author: **`calc` must be a pure function of `(bars, settings)`**. It always had to be, but running per tick used to disguise an indicator that counted its own calls or accumulated into `store`. The number of calls is now a property of the frame rate. If you need per-tick work, that is what `attach` and its own subscription are for.

`chart.indicators()` lists live instances in display order; `chart.removeIndicator(instanceId)` returns `boolean` and prunes the pane if it emptied.

**Repeated instances get rotated colours.** The 2nd and later instances of the same descriptor id fill any *unset* plot colour key from `INSTANCE_PALETTE` (`#f5a623`, `#26a69a`, `#ab47bc`, `#ef5350`, `#26c6da`, `#8bc34a`, `#ff7043`, `#5c6bc0`), strided by plot count. An explicit colour in `settings` always wins, and the first instance is never touched. Three EMAs in one blue are indistinguishable on the chart and in the legend alike.

## Study outputs as inputs

`IndicatorStudySource` is a stable scalar-output reference with exactly three own
data fields: `{ kind: 'indicator', instanceId, plotKey }`. The two identifiers must
be nonempty strings; plain and null-prototype objects are accepted. Accessors,
extra fields, self references and cycles are rejected before settings or chart
resources change. The descriptor must declare the setting as a `type: 'source'`
input with `allowStudyOutputs: true`. Other inputs remain unchanged.

`sma`, `ema` and `wma` currently opt in. Each exposes the scalar plot key `ma`:

```ts
const first = chart.addIndicator('sma', { length: 2 });
const second = chart.addIndicator('sma', {
  length: 2,
  source: { kind: 'indicator', instanceId: first.id, plotKey: 'ma' },
});
// Price closes [1, 3, 5, 7] produce [null, null, 3, 5] in second.values().ma.
first.setSettings({ length: 3 }); // second becomes [null, null, null, 4].
```

For custom descriptors, add `allowStudyOutputs: true` to the source input and call
`sourceValues(bars, settings.source as IndicatorSource | IndicatorStudySource, ctx)`
inside `calc(bars, settings, store, ctx)`. `IndicatorCalcContext.resolveSource`
resolves only references tracked through declared, opted-in settings. A reference
without a resolver throws `IndicatorInputError`. Do not read another instance's
`values()` from inside `calc` or invent references dynamically outside those inputs.

`sourceValues` returns a detached, bar-aligned column with its `null`, `NaN` and
infinite entries preserved. A resolved column must have exactly `bars.length`
entries. Choose a missing-value policy explicitly; never coerce a gap to zero.
For study references, the three moving averages require consecutive finite
observations for a full window, and EMA reseeds after a gap. Their ordinary
price-string inputs retain their existing outputs and initialization.

Alignment follows the primary bar index. Hiding or moving a producer, changing its
scale or plot offset, and changing display order do not change its input column.
The chart calculates producers before consumers, independently of display order;
settings and external-data changes also refresh consumers without a price tick.
Only a proven unchanged output prefix permits an incremental downstream pass.

Select a declared scalar plot. An OHLC plot requires a separately declared scalar
output, and an undeclared calculation column is not selectable. A missing producer
retains its reference, clears dependent output, reports an error through
`dataStatus()` and suppresses dependent alerts. Failed or unavailable producer
output is also unavailable to consumers, even if older producer visuals remain.
Adding a different instance never retargets a reference. Rebind deliberately with
`second.setSettings({ source: { kind: 'indicator', instanceId: replacement.id, plotKey: 'ma' } })`.
Accepted references and references returned from `settings()` are detached.

`IndicatorState.instanceId` preserves identity across `getState()` / `restoreState()`.
Restore validates the graph before mutation, creates producers before consumers,
and retains saved display order even when the consumer is listed first. Unknown
descriptors keep the existing skip behavior; their consumers remain unavailable.
`IndicatorState.studyInputs?: readonly string[]` identifies reference-bearing
settings for portable templates. It is remapping metadata, not permission to read
a study: the current descriptor still controls which inputs opt in. Dependency
templates must include their producers; the workspace `planIndicatorTemplate`
allocates fresh identities and rewrites internal references when copying them.
Template references outside the copied group are rejected.

### Custom hosts

The base types `IndicatorHost` and `IndicatorStudyOutput` describe the optional
integration for a host using `IndicatorInstance` directly. Old hosts can omit the
hooks and retain ordinary independent calculations. A host supporting dependencies
must validate and schedule the graph, then expose committed snapshots:

| Optional host hook | Responsibility |
|---|---|
| `validateIndicatorSettings(id, descriptor, settings)` | Validate the proposed whole graph before accepting settings. |
| `studyOutput(reference)` | Return a committed `Readonly<IndicatorStudyOutput>`, or `undefined` for a missing source. Do not recursively flush through `values()`. |
| `indicatorOutputChanged(id, refresh)` | Invalidate downstream calculations after output or availability changes. |
| `indicatorRecompute(id, refresh, fallback)` | Schedule the requested recalculation with its producers; invoke the supplied calculation callback at the correct point. |

An `IndicatorStudyOutput` carries `generation` (producer lifetime), `revision`
(output changes), `historyRevision` (the earlier prefix may have changed), optional
`source: Readonly<SeriesDataState>`, `available` and readonly `values`. Advance
metadata when the corresponding guarantee changes, supply current primary-source
identity/revisions when known, and set `available: false` while an output cannot
be consumed. The chart implements these hooks itself. This native opt-in does not
change the existing compiled-script descriptor boundary or automatically add
study-reference inputs to a script adapter.

## Source access and legend sizing (2.4.6)

`IndicatorDescriptor.hasSource: true` adds a source button beside the legend's settings
button. It emits `indicatorSource` with `{ instanceId, indicatorId, paneIndex }`.
The host owns the code and must handle the event to display it; the engine neither
stores code nor opens a dialog. Omit the flag when source is unavailable. Built-in
descriptors omit it.

```ts
chart.on('indicatorSource', ({ instanceId, indicatorId, paneIndex }) => {
  showIndicatorSource({ instanceId, indicatorId, paneIndex });
});
chart.setLegendIconSize(24);
```

`showIndicatorSource` is a host callback. `ChartOptions.legendIconSize`,
`chart.applyOptions({ legendIconSize })` and `chart.setLegendIconSize(size)` apply one
size to every existing and later legend, overriding an explicit per-primitive size.
`chart.legendIconSize()` reads the configured value, or `undefined` if unset.
Nonfinite chart values are ignored. `PaneLegendOptions.iconSize` defaults to 16 media
pixels and is held to 12..28 when drawn; the row grows to fit it. Prefer the chart
setting when several legends share a pane, since their row heights must agree.

A fully transparent plot color contributes no legend reading: this covers
`transparent`, zero-alpha hex and supported comma-separated `rgba()` syntax.
Unknown color syntax is retained. The plot's data and marker anchors remain intact.

## Help text on an input (2.2.1)

Every `IndicatorInput` variant takes an optional `tooltip`. A label has to stay
short enough for a dense panel, which leaves nowhere to say what a parameter
actually does, so put the explanation here rather than in a parenthetical that
stretches the row:

```ts
inputs: [
  { key: 'length', type: 'number', label: 'Length', default: 20, min: 1 },
  {
    key: 'per', type: 'number', label: 'Days per bar unit', default: 1, min: 1,
    tooltip: 'Calendar days each bar covers, used to annualise: 1 for intraday and daily, 7 for weekly and above.',
  },
]
```

The core ignores it; a settings UI renders it as a hover mark beside the label.
The packaged widget and the reference host both draw a small `?` ring that is
focusable, so the help is reachable without a pointer. An empty string draws
nothing, which is the difference between no help and a mark with nothing behind
it. `ChartSettingsColorPairInput` carries the same field.

## The settings model

Two families of keys live in one flat `IndicatorSettings` bag:

1. **Declared inputs**, `descriptor.inputs`, keyed however the descriptor chose (`length`, `fastPeriod`, `anchor`, `color`).
2. **Generated per-plot style keys**, produced by `plotStyleKeys(plot)` for every plot, with no per-descriptor boilerplate:

| Key | Type | Default |
|---|---|---|
| `plot.colorKey ?? '<plotKey>:color'` | color | declared colour input's default, else `plot.style.color`, else `#4f8cff` |
| `'<plotKey>:opacity'` | number 0..100 | `100` |
| `'<plotKey>:width'` | number 0.5..8 step 0.5 | `plot.style.lineWidth ?? 1.5` |
| `'<plotKey>:lineStyle'` | select | `plot.style.lineStyle ?? 'solid'` (`INDICATOR_LINE_STYLES`: solid / dashed / dotted) |
| `'<plotKey>:type'` | select | `plot.type` (line, line-markers, step, area, histogram, column) |

**A descriptor that declares `colorKey` owns the colour key.** `plotStyleKeys` returns `plot.colorKey` in the `color` slot rather than `<plotKey>:color`, so a generated key would shadow the declared one and setting the declared key would silently stop working. Always read the key from `plotStyleKeys(plot).color`, never hand-build `` `${plot.key}:color` ``.

Opacity folds into the colour as alpha (a canvas stroke has no opacity channel). Changing `:type` **rebuilds the series**: a chart type belongs to the series, not the style bag.

Generating a dialog from a descriptor:

```ts
import { indicatorStyleInputs, plotStyleKeys } from 'openalgo-charts';

const descriptor = getIndicator(instance.indicatorId);
const current = instance.settings();
for (const input of [...descriptor.inputs, ...indicatorStyleInputs(descriptor)]) {
  // input.type: 'number' | 'boolean' | 'color' | 'text' | 'select' | 'source'
  // 'select' carries input.options; 'source' should render INDICATOR_SOURCES
  renderField(input, current[input.key] ?? input.default);
}
instance.setSettings(collectedPatch); // partial patch; untouched keys keep their value
```

The engine is canvas-only and ships no DOM, so the form is the host's. The legend's gear button emits an event instead of opening anything:

```ts
chart.on('indicatorSettings', (p) => {
  const { instanceId, indicatorId, paneIndex } = p as {
    instanceId: string; indicatorId: string; paneIndex: number;
  };
  openMyDialog(chart.indicators().find((i) => i.id === instanceId)!);
});
```

`chart.on` returns an unsubscribe function and payloads are `unknown`, so cast at the boundary. Legend actions `close`, `hide`, `up`, `down`, `collapse`, `maximize` are handled **inside** the chart; `settings` and `source` are delegated (`indicatorSettings`, `indicatorSource`). `removeIndicator` also emits `indicatorRemoved` with the same payload shape. See [events-and-state](./events-and-state.md).

`indicatorStyleInputs`, `plotStyleKeys`, `indicatorDefaults`, `INDICATOR_SOURCES`, `INDICATOR_LINE_STYLES` and `INDICATOR_PLOT_STYLES` are all exported from the package entry (`src/model/indicator-registry.ts`). `INDICATOR_PLOT_STYLES` is the `{ label, value }[]` behind the generated `<plotKey>:type` input, so a settings UI can render the plot-style dropdown without reading the input's `options`.

## Levels, fixed ranges, fills

`levels(ctx)` returns horizontal reference lines drawn as `PriceLine`s in the indicator's pane (`{ price, color?, title?, dashed?, lineWidth?, lineStyle? }`, defaults `#8892a6` and dashed; `lineStyle` is `'solid' | 'dashed' | 'dotted'` and overrides `dashed`). `range(settings)` pins the pane's price scale.

**Since 1.7.1** `ctx` carries the settings keys directly (so every existing `levels(settings)` descriptor is unchanged) plus `ctx.bars` and `ctx.values`, and levels recompute after each `calc` rather than only on a settings change. That is what lets a level be derived from the data: a previous-day high, an anchored VWAP band, the last close. Write `ctx.bars ?? []`, since both are optional. 39 built-ins declare `levels`, 12 declare `range`, and levels are computed from the live settings, so `rsi`'s are `overbought` / 50 / `oversold`, not the literals below.

| id | Levels (at default settings) | Fixed range |
|---|---|---|
| `rsi` | 70, 50, 30 | 0..100 |
| `macd` | 0 | none |
| `stochastic` | 80, 20 | 0..100 |
| `adx` | 25 | none |
| `cci` | 100, 0, -100 | none |
| `mfi` | 80, 20 | 0..100 |
| `aroon` | 50 | 0..100 |
| `aroon-oscillator` | 90, 0, -90 | -100..100 |
| `awesome-oscillator` | 0 | none |
| `balance-of-power` | 0 | none |
| `chande-momentum` | 0 | none |
| `dpo` | 0 | none |
| `fisher-transform` | 1.5, 0.75, 0, -0.75, -1.5 | none |
| `connors-rsi` | 70, 50, 30 | 0..100 |
| `bollinger-percent-b` | 1, 0.5, 0 | none |
| `bb-trend` | 0 | none |
| `choppiness-index` | 61.8, 50, 38.2 | 0..100 |
| `chop-zone` | none | 0..1 |
| `chaikin-volatility` | 0 | none |
| `chaikin-money-flow` | 0 | none |
| `chaikin-oscillator` | 0 | none |
| `elder-force-index` | 0 | none |
| `klinger-oscillator` | 0 | none |
| `know-sure-thing` | 0 | none |
| `roc` | 0 | none |
| `ppo` | 0 | none |
| `trix` | 0 | none |
| `tsi` | 0 | none |
| `smi` | 40, 0, -40 | none |
| `wavetrend` | 60, 53, 0, -53, -60 | none |
| `pvo` | 0 | none |
| `ulcer-index` | 0 | none |
| `stochastic-rsi` | 80, 50, 20 | 0..100 |
| `williams-percent-r` | -20, -50, -80 | -100..0 |
| `relative-volatility-index` | 80, 50, 20 | none |
| `woodies-cci` | 100, 0, -100 | none |
| `special-k` | 0 | none |
| `linreg-slope` | 0 | none |
| `trend-strength-index` | 1, 0, -1 | -1..1 |
| `rsi-divergence` | 70, 50, 30 | 0..100 |

**`range()` is applied only when the instance created its own pane.** Two indicators sharing a pane would otherwise fight over it, so an RSI added with `{ paneIndex: 1 }` onto someone else's pane will not pin 0..100.

### Fills

`fills` shade a band between two columns. 28 built-ins declare one, 38 fills in total. The band draws at `zOrder: 'bottom'`, returns `null` from `autoscaleInfo` (the plots already drive the scale), splits at the exact crossing rather than the nearest bar, and breaks across a gap in either column instead of bridging it. Default opacity when unset is `0.12`; default colours `#26a69a` / `#ef5350`. See `src/primitives/indicator-fill.ts`.

**`IndicatorFillSpec.between` resolves against `calc` output columns, not against declared plots.** That is the idiom behind every shaded overbought/oversold band in the catalogue: the descriptor returns two constant columns that no plot names, and fills between them.

```ts
// RSI: a shaded 70..30 band, drawn without plotting either edge.
plots: [{ key: 'rsi', type: 'line', title: 'RSI', colorKey: 'color' }],
fills: [{ between: ['upperLevel', 'lowerLevel'], colorUpKey: 'bandColor', colorDownKey: 'bandColor', opacity: 0.1 }],
calc: (bars, s) => ({
  rsi: /* ... */,
  upperLevel: bars.map(() => num(s, 'overbought', 70)),  // never plotted
  lowerLevel: bars.map(() => num(s, 'oversold', 30)),    // never plotted
}),
```

The three shapes actually used by the built-ins:

| Shape | Between | Used by |
|---|---|---|
| Background band between two constant columns | `upperLevel`/`lowerLevel`, `bandHigh`/`bandLow`, or a series against a constant `zero` | `rsi`, `stochastic`, `cci`, `mfi`, `connors-rsi`, `bollinger-percent-b`, `choppiness-index`, `smi`, `stochastic-rsi`, `williams-percent-r`, `relative-volatility-index`, `aroon-oscillator`, `ulcer-index` |
| Channel between two plotted edges | `upper`/`lower`, `spanA`/`spanB`, `bbUpper`/`bbLower`, `median`/`medianEma` | `ichimoku`, `envelope`, `donchian`, `keltner-channel`, `standard-error-bands`, `ma-channel`, `median`, `cci`, `obv`, `relative-volatility-index`, `vwap` (three band pairs) |
| Trend ribbon between a stop line and a reference column | `bodyMid`/`up`, `bodyMid`/`down`, `up`/`atrLow`, `down`/`atrHigh` | `supertrend`, `halftrend` |
| A series against its own displaced copy | `mhull`/`shull` | `hull-suite` |

`colorUpKey` and `colorDownKey` are settings keys, so a fill is restyleable like anything else. Setting them to the same key (which most of these do) gives a single-colour band rather than a two-tone one.

## Signal markers

`IndicatorDescriptor.markers` is an optional hook returning bar-anchored `IndicatorMarker[]` (a `SeriesMarker` that may also carry an `IndicatorOutputTarget`, so a plain `SeriesMarker[]` still type-checks). It runs after every `calc` and reads the values `calc` just produced, so it recomputes nothing.

```ts
markers?(ctx: {
  bars: readonly Bar[];
  values: IndicatorValues;
  settings: Readonly<IndicatorSettings>;
}): readonly IndicatorMarker[];
```

A plot cannot express this: a plot is a column of prices drawn as a line or a histogram, whereas a signal is a discrete named event at one bar.

- Six built-ins use it: `halftrend` (Buy/Sell plates at flips, suppressed by `showLabels: false`), `williams-fractals` (up/down triangles at pivots), `rsi-divergence` (Bull / H Bull / Bear / H Bear plates at pivots), `alphatrend` (BUY/SELL plates at crossovers, suppressed by `showsignalsk: false`), `wavetrend` (circles at band crossings plus R / H divergence plates), `consolidation-breakout` (a `triangleUp` below the bar that breaks the range up, a `triangleDown` above the one that breaks it down, suppressed by `markbreakout: false`).
- Returning `[]` clears the layer. That is how a `showLabels`-style boolean input turns markers off without a rebuild.
- The layer is created lazily on the **first plot's** series by default (`markerAnchor: 'plot'`), so a no-marker indicator costs no extra primitive.
- `markerAnchor: 'price'` selects the primary series for an indicator on pane 0. `aboveBar` uses its high, `belowBar` its low and `inBar` its body midpoint. A study on another pane or a chart without a primary series falls back to the first plot. The layer follows its series' own scale and is recreated when that selected series changes.
- Missing or NaN plot values use the instrument bar at the same time only when the indicator is on pane 0 and its marker series shares the primary series' price scale. Finite plot points retain precedence. Own-pane oscillators and independent scales never receive instrument-price fallback; without an anchor their bar-relative marker is skipped.
- `series.createMarkers(fallbackBars)` and `new SeriesMarkers(seriesId, fallbackBars, priceScale)` accept optional callbacks. `fallbackBars` returns current `readonly Bar[]`; the optional constructor `priceScale` returns the current `PriceScale`. Series-created layers supply that scale callback automatically, including after an axis move. Missing shared-axis times are skipped even when a fallback bar exists. `atPrice`, `paneTop` and `paneBottom` do not require a series bar.
- **Markers are a separate primitive from the plots.** `setVisible(false)` hides both because the runtime re-runs the hook with an empty result, but a plot-level style patch does not touch them.
- **Marker groups.** A marker can name an `IndicatorOutputTarget`: `overlay: true` anchors it to the instrument's candles on the price pane (so `belowBar` sits under the low) even from a study in its own pane, and `plot: key` anchors it to that declared plot's series, pane and scale. Each target is its own `SeriesMarkers` layer created on that series: it follows the series through `setPlotPriceScales`, `setPriceScale` and `moveIndicator` (a price-pane group stays on pane 0), is cleared while the study is hidden and refilled in place when shown, is released when a visible pass returns nothing for it, and goes with the study or its pane. A target that resolves to the series the study's own marks anchor to (`overlay: true` from an on-price study with `markerAnchor: 'price'`, or `plot` naming the first plot) is not a separate layer: those marks join the study's own layer in the order returned, so marks at one bar stack, and they split out again if a move changes that anchor. A `plot` group fills a missing or NaN value from the instrument bar whenever that plot is on pane 0 and shares the primary series' price scale, whether or not it is the first plot, so marks naming an `overlay` first plot of a study in its own pane keep a layer of their own: the study's own marks there never take the instrument bar. A study's layers stack as: its own marks, its marker groups, its own shapes, its drawing targets, each kind's targets in target order (price pane, then plots in declaration order), which is also the order a pass creates them in. A group created after the first pass (a target returned again, or for the first time) is restacked through the host's `resourcesChanged`, called from inside the pass: during that call every instance reports its targeted layers alone, so the host puts the targeted layers on each pane back in study order, each study's in the order above, and moves nothing else. The runtime republishes no study's bar colours during that call, since study order has not changed. A study's own layer created on a later pass is never restacked, and neither is anything of a study that names no target, even when another study routes on the same pass: it stays where it landed, exactly as before targets. Marks with no target keep `markerAnchor` and the first plot byte for byte. An overlay group waits for a primary series. An unknown plot, or `plot` together with `overlay: true`, throws before any marker layer changes, and so does an invalid style on any mark: `addIndicator` throws, and a later pass publishes an error status while every marker layer keeps the last good pass. The rest of the pass is not rolled back: a pass syncs plots and fills, markers, the table, drawings, then background, bar colours, levels and alerts, so outputs before the failing one stay applied and those after it wait for the next good pass. Marks in groups on different series (the candles and a plot, or two plots) do not stack against each other at a shared bar: each is measured against a different value.

```ts
markers: ({ bars, values }) => crossings(values.momentum).map(i => ({
  time: bars[i].time, position: 'belowBar', shape: 'labelUp', size: 'small',
  color: '#26a69a', text: 'Buy', overlay: true,        // on the candles
})),
```

`MarkerShape` includes two label shapes for named signals: `labelUp` and `labelDown` are rounded text plates with a tail that points **at** the anchor price, so the body sits clear of the bar. `labelUp`'s tail is on the top edge and its body hangs below the anchor; `labelDown` is the mirror. Both require `text`. The renderer is exported as `drawLabel(ctx, up, cx, anchorY, text, color, fontPx)` alongside `drawShape`, `markerSizePx` and `effectiveMarkerPx`, all in bitmap px with dpr already applied by the caller.

Each label begins its own canvas path, so later plates do not refill earlier tails.

`SeriesMarker` accepts independent `textColor`, `fontSize`, `fontFamily`, `bold`,
`italic` and `textAlign`. Glyph color and preset size stay independent of the text.
Omitted text color still contrasts with a label plate and matches the glyph for
other shapes. Label plates retain their semibold default; other marker text stays
normal. `bold: false` explicitly removes the plate's semibold weight. Omitted size
is `max(9, markerSizePx(size))` CSS px; the default family is `system-ui, sans-serif`.
`textAlign: 'left' | 'center' | 'right'` aligns rows within their measured block,
which remains centered on the marker; default is center. Opted-in text styling
uses measured bounds and clips ink/hits to the plot. Marker hit targets otherwise
remain the existing 8px anchor radius. Invalid new fields reject the entire
`setMarkers` replacement before mutation; accepted replacement or detach clears
old hit positions immediately. The public `drawLabel` signature is unchanged.

```ts
{ time: bar.time, position: 'atPrice', price, shape: 'labelUp', size: 'small', color: '#2962ff', text: 'Buy' }
```

## Tables

`table` is an optional hook beside `markers`, for an indicator whose output is a matrix
rather than a column of prices: a plot is one price per bar, and a monthly return heatmap
is neither. It runs after every `calc`, so it reads the values it just produced. Return
`null` to draw nothing.

```ts
registerIndicator({
  id: 'my-scoreboard',
  name: 'My Scoreboard',
  placement: 'pane',
  inputs: [],
  // A pane needs a plot to exist. An all-null column draws nothing and
  // contributes nothing to autoscale, so the pane gets no price axis at all.
  plots: [{ key: 'placeholder', type: 'line', title: 'Scoreboard' }],
  calc: (bars) => ({ placeholder: new Array(bars.length).fill(null) }),
  table: ({ bars, values, settings }) => ({
    rows: [
      [{ text: 'Metric', bold: true }, { text: 'Value', bold: true }],
      [{ text: 'Bars' }, { text: String(bars.length) }],
    ],
    options: { position: 'top-right', cellWidth: [80, 60], cellHeight: 18 },
  }),
});
```

Cells take `text`, `bgColor`, `textColor`, `align`, `fontSize` and `bold`; `textColor` is
derived from `bgColor` for contrast when omitted. Options take `position` (nine keywords),
`margin`, `cellWidth` (number, per-column array, or `'auto'`), `cellHeight`, `widthPercent`,
`heightPercent`, `rowWeights`, `fontSize`, `borderColor`, `borderWidth`, `background` and
`id`. The percentage sizes stretch the grid to a share of the plot while preserving the
column proportions; `rowWeights` keeps a separator row thin when it does.


From 2.5.0, `cellWidth: 'auto'` measures each column at its rendered font size,
including bold and per-cell overrides. Short rows clamp the measured font just
as they clamp drawing. Empty columns retain 28 px. With `fontSize: 'auto'`,
unoverridden cells use an 11 px baseline for width measurement to avoid circular
sizing; drawing can still shrink to the final cell. `widthPercent` scales those
measured proportions. Text always clips to its own cell, including fixed widths.

One built-in uses the hook: `seasonality`, whose entire output is the grid.

## Trading sessions

Anything that accumulates within a trading day (VWAP, TWAP, daily pivots) has to know
where the day ends, and a calendar midnight is the wrong answer for every exchange but
the one whose zone you picked. 00:00 in `Asia/Kolkata` is 18:30 UTC, which is the middle
of a New York session: anchoring there restarts a VWAP every afternoon and builds a
"daily" range out of one session's tail plus the next session's head across the overnight
gap.

Read the session out of the bar gaps instead:

```ts
import { sessionStartFlags, calendarPeriodFlags, isNewZonedPeriod } from 'openalgo-charts';

const times = bars.map((b) => b.time);
const zone = chart.timezone();                                  // 'Asia/Kolkata' by default
const newSession = sessionStartFlags(times, zone);              // boolean per bar
const newWeek = calendarPeriodFlags(times, (a, b) => isNewZonedPeriod(a, b, 'week', zone));
```

| Export | Returns |
|---|---|
| `sessionStartIndices(times)` | Bar indices that open a session, or `null` when unreadable. Zone-free: a gap is a gap in any zone. |
| `sessionStartFlags(times, zone?)` | One flag per bar. `zone` (default `Asia/Kolkata`) is used **only** for the calendar-day fallback when the gaps are unreadable. |
| `calendarPeriodFlags(times, isNew)` | A week/month/year boundary tested on session opens, so a session is never cut in half. Put the zone inside the `isNew` you pass. |

Unreadable means bars already a day or coarser, a market that never closes, or a feed
whose only gaps are weekends. An intraday lunch break is under the four-hour floor, so it
is not mistaken for a close.

### A window you state, not one you read (1.8.1)

The helpers above answer "where does the trading day start". They cannot answer which *part*
of a session you meant: an opening range, the cash hours inside an extended session, one
exchange's hours drawn on another exchange's chart. State those instead.

```ts
import { parseSessionSpec, inSessionAt, sessionFlags } from 'openalgo-charts';

parseSessionSpec('0915-1015');        // { start: 555, end: 615 }
parseSessionSpec('0930-1600:23456');  // { start: 570, end: 960, days: [2,3,4,5,6] }
parseSessionSpec('2500-1000');        // null

const opening = sessionFlags(bars.map((b) => b.time), '0915-1015', zone);   // boolean per bar
inSessionAt(bar.time, spec, zone);                                          // one instant
```

Grammar: `HHMM-HHMM`, optionally `:` then the days the window runs on, **1 = Sunday** through
7 = Saturday. Whitespace around the parts is ignored. Semantics that are decided and worth
not re-deriving:

- **Half-open.** Start minute in, end minute out, so a bar stamped exactly 10:15 is outside a
  `0915-1015` window. That is what an opening-range comparison needs.
- **An end at or before the start wraps past midnight**, so `'2330-0030'` is a one-hour
  overnight window and `'0000-0000'` is the whole day, not nothing.
- **The day filter names the day the window OPENS on.** For `'2330-0030:2'` (Monday), Monday
  23:45 and Tuesday 00:15 are one session; Tuesday 23:45 is not in it.
- `zone` defaults to `Asia/Kolkata` like every other zoned helper. Pass `ctx.timezone` from
  the calc context, or the reserved `settings.timezone` key.
- **An unparseable string marks nothing**: `sessionFlags` returns all-false rather than
  throwing, because the spec is normally a settings field mid-keystroke. Call
  `parseSessionSpec` yourself to tell a bad spec from an empty window.

### The zone inside a `calc`

A descriptor is handed `(bars, settings, store)` and **never the chart**, so the chart's
timezone travels on the settings blob under a reserved `timezone` key that the chart
populates. A custom indicator with a calendar anchor should read it the same way the
built-ins do:

```ts
import { DEFAULT_TIMEZONE, isValidTimezone } from 'openalgo-charts';

const zoneOf = (s: Readonly<Record<string, unknown>>): string => {
  const v = s.timezone;
  if (typeof v !== 'string' || v === '' || v === DEFAULT_TIMEZONE) return DEFAULT_TIMEZONE;
  return isValidTimezone(v) ? v : DEFAULT_TIMEZONE;   // fall back, never throw in a calc
};
```

Three rules behind that shape:

- **Fall back, do not throw.** `chart.setTimezone` already rejects a bad name at the call
  site; a `calc` that throws takes the whole repaint down with it.
- **Treat a missing key as the default.** Every settings blob written before the option
  existed has no `timezone`, and must keep computing what it always computed.
- **Do not write the zone into your own settings.** It is injected per recompute and
  deliberately absent from `settings()` and `getState()`, so a layout saved on a New York
  chart does not carry New York onto the IST chart that restores it.

## Writing a custom indicator

### Typed native inputs

`IndicatorInput` also supports these scalar kinds:

| Type | Saved value | Contract |
| --- | --- | --- |
| `symbol` | string | Opaque instrument identifier; empty can mean the chart symbol. Optional `exchangeKey` names a string setting and defaults to empty text if undeclared. |
| `session` | string | Existing `parseSessionSpec` grammar, including overnight and weekday filters. Accepted spelling is retained. |
| `multiline` | string | Newlines, whitespace and markup remain literal text. |
| `price` | number | Finite value within optional `min`/`max`. `step` is editor metadata and never rounds stored values. |
| `timestamp` | number | Absolute UTC seconds, including fractional or negative values. Independent of chart timezone. |

`price.pick` is a boolean or `{ paneIndex?, priceScaleId? }`; `timestamp.pick` is
a boolean. The host exposes chart selection and keeps manual entry available.
Mixed-scale price studies require an unambiguous actual target or an explicit
one. Symbol search uses the existing host provider and never changes the primary
chart instrument. Missing search leaves manual entry available.

New kinds validate defaults and settings before registration, calculation or
restoration. Invalid values raise `IndicatorInputError` without replacing the
current study state. Settings accessors reject without executing. Existing
`time` inputs remain wall-clock strings; migrating them to `timestamp` requires
the original timezone and an explicit host migration.

The widget and reference host retain invalid drafts, restore the same dialog
after chart picking, and cancel pending selection on teardown. Existing compiled
adapters keep their current input types and compiled format.

An indicator is data, not code in the core: the chart never switches on an id, and each plot names a registered chart type, so you add no drawing code. `calc` must return one array per plot key, exactly `bars.length` long, with `null` in warmup slots (the line renderer breaks across them and autoscale skips them).

```ts
import { registerIndicator, sourceValues, type IndicatorSource } from 'openalgo-charts';

registerIndicator({
  id: 'my-momentum',                 // `momentum` is taken: registering it would replace the built-in
  name: 'My Momentum',
  category: 'Momentum',
  placement: 'pane',
  inputs: [
    { key: 'length', type: 'number', label: 'Length', default: 10, min: 1, max: 500, step: 1 },
    { key: 'source', type: 'source', label: 'Source', default: 'close' },
    { key: 'color', type: 'color', label: 'Color', default: '#4f8cff' },
  ],
  plots: [{ key: 'mom', type: 'line', title: 'Momentum', colorKey: 'color', style: { lineWidth: 1.5 } }],
  calc: (bars, s) => {
    const v = sourceValues(bars, (s.source as IndicatorSource) ?? 'close');
    const n = typeof s.length === 'number' ? s.length : 10;
    return { mom: v.map((x, i) => (i >= n ? x - v[i - n] : null)) };
  },
  levels: () => [{ price: 0, color: '#5a6b8c', dashed: true }],
});

chart.addIndicator('my-momentum', { length: 14 });
```

Optional descriptor members: `fills`, `markers`, `markerAnchor` / `hasSource` (2.4.6), `levels`, `range`, `attach`, `calcTail`, `table`, `tables`, `draws` (1.7.1), and `background` / `barColors` / `alerts` (1.7.1), plus `colorBy` (per-bar colour), `priceScaleId` / `overlay`, and `ohlc` (1.8.1) on an individual plot. Returned drawings and markers can carry `overlay` / `plot` output targets (see the markers and drawings sections).

### Assigning scales to study plots

`chart.addIndicator(id, settings, { priceScaleId, plotPriceScaleIds })` accepts an
optional whole-study scale and an optional map of declared plot keys to
`PriceScaleId`. The handle exposes `plotPriceScaleId(key)` for the effective ID
(null for an unknown plot), `plotPriceScaleIds()` for a detached override map,
and `setPlotPriceScales(patch)` for an atomic partial update. A null patch value
clears one override; omitted keys are unchanged.

Precedence is per-plot override, local whole-study override, descriptor scale,
then `right`. An explicit `overlay: true` plot ignores the whole-study override
and stays on the price pane, where its per-plot assignment still applies. A
successful `setPriceScale(id)` clears local per-plot overrides, including when
id is null to restore local descriptor defaults. Explicit price-overlay
overrides survive; clear them individually with `setPlotPriceScales`.

Move both fill endpoints in one patch to keep their pane and scale identical.
Unknown keys, invalid IDs, accessors, incompatible fills and empty/unchanged
patches return false without moving resources. Invalid creation maps throw before
allocation. Levels and unbound price drawings follow the first local plot;
drawings that name a `plot` follow that plot, and price-pane drawings stay on the candles' scale;
plot markers follow their bound series. The operation keeps handles, values and
provider attachments, and does not recalculate or evaluate alerts.

`IndicatorState.plotPriceScaleIds` saves explicit overrides. Known descriptors
are validated before chart restore mutates resources; workspace and legacy
template parsing retain structurally valid maps. Use `setPriceAxisPlacement`
to expose a named scale's column without changing its ID. See
[scales and panes](scales-and-panes.md#reassign-individual-study-plots) for shared
formatting, range ownership and the conservative legacy `movePriceAxis` guard.

### Computed fills and multiple grids

`IndicatorFillSpec.colorBy({ index, a, b, values, settings })` returns a per-bar
color or `undefined`. The index addresses the original calculation columns; the
fill still follows the first plot's offset. `gradientBy` accepts the same context
and returns a `FillGradient` or `undefined` for that bar. Precedence is point color,
point gradient, whole-band gradient, then the existing up/down colors.
`gradient` accepts a `FillGradient` or a
callback `({ bars, values, settings }) => FillGradient | undefined`. Its price
anchors and colors apply to the entire band. All callbacks refresh after every
calculation, including settings changes and same-bar updates.

`FillGradient` has `topColor`, `bottomColor`, and optional `topValue`/`bottomValue`.
Omitted anchors use the whole band's finite maximum/minimum. Return `a` and `b`
as explicit anchors for a local range. Changed gradients share the bar edge;
simultaneous plot crossings split at the intersection. Missing plot values break
the run. Stops follow their prices during pan, inversion and scale changes.
Direct primitive users set `FillPoint.gradient`; `FillPoint.color` still wins.

`IndicatorDescriptor.tables({ bars, values, settings })` returns a list of
`IndicatorTableSpec`: `{ id, rows, options?, overlay? }`. Each ID must be a nonempty
string unique within that indicator instance. Stable IDs retain their table
objects across updates and reordering; omitted IDs are removed. An empty list
removes all grids. `options` patches `ChartTableOptions`; `rows` replaces the grid.
`overlay: true` pins that grid to the price pane. Otherwise it follows its owner
when the indicator moves. Changing overlay placement recreates that grid.

Hiding the indicator clears its grids until shown again; removing it disposes
them. Duplicate or empty IDs reject the entire table update before changing
existing grids and publish an indicator error status. An invalid initial list
rejects `addIndicator` and cleans up the resources it created. The existing
single `table` hook is unchanged; when both hooks exist, `tables` takes precedence.

**`overlay: true` on a plot** (1.7.1) draws that one column on the price pane even when the descriptor is `placement: 'pane'`. An oscillator whose stop line belongs on the candles no longer has to ship as two indicators that duplicate the same inputs.

**`colorBy` now reaches line, area and step** as well as histogram and column (1.7.1). Return `undefined` to fall back to the plot colour. A uniform column still strokes once, so an ordinary series pays nothing.

**`calcTail` is worth far less since 1.8.4 than it used to be.** It existed because a recompute ran on every tick; recompute is now scheduled with the frame, so a full `calc` is paid once per paint however fast the feed ticks. Reach for `calcTail` when one pass over the loaded history is itself slow, which means deep history rather than a busy symbol, and not by default. No built-in implements it. Return values for `[fromIndex, bars.length)` and the runtime splices them onto the previous result; return `null` to fall back. Since 1.7.1 the tail path is gated on **times**, not on a bar count: the first bar's time must be unchanged, and the last bar must be either that same bar replaced in place or one appended directly after it. A symbol change landing on a matching count, or one older bar paged in at the left edge, falls back to a full `calc` instead of splicing onto a history that no longer exists. `fromIndex` is `previousCount - 1` because the previously-last bar may have been replaced. Any settings change or external-data arrival resets the tail state to force a full recompute.

`registerIndicator` overwrites an existing id, later registration wins. With 105 built-ins the id space is crowded, so namespace a custom id (`my-momentum`, `acme-vwap`) unless you intend to replace a built-in. Register before `addIndicator`.

## The calculation context (1.8.1, extended 1.8.2)

`calc` and `calcTail` take an optional trailing context:

```ts
calc(bars, settings, store, ctx) {
  ctx.barState   // { isNew, isConfirmed, isRealtime, lastIndex }
  ctx.symbol     // may be undefined: the core is handed bars, not an instrument
  ctx.interval   // same
  ctx.timezone
  ctx.now()
  ctx.tickSize   // the instrument's minMove, or undefined
}
```

`ctx.tickSize` is the number `snapToTick` snaps to, so an indicator sizing a range
in ticks reads it rather than adding an input for it. It is `undefined` when the
host has not set `minMove`: the scale treats 0 as "infer precision from the
visible range", which is not a tick size, and guessing one would be worse than
saying nothing.

It is the **instrument's** tick, read from the price pane, not from whatever pane
the study happens to draw in. `calc` runs on the instrument's bars whether the
plot lands on the candles or on a pane of its own, so a study on its own pane
still gets a real tick to size a range against.

### What precision your plots print at

Nothing to declare: it follows the pane, so a custom descriptor behaves exactly
like a built-in.

| `placement` | Where it draws | Precision |
| --- | --- | --- |
| `'onchart'` | The price pane | The instrument's tick. The plot **is** a price and has to agree with the axis it is drawn against, so a Supertrend on a 0.05 tick reads `1339.70`. |
| `'pane'` | Its own pane | That pane's own span, floored at two decimals. An RSI reads `70.00` and a percentage study reads `0.61`. |

A study pane does not inherit the instrument's tick, because it is not quoted in
it: an RSI is a dimensionless 0..100 band. The two-decimal floor is there because
the span alone is too coarse for a bounded oscillator, which would otherwise be
labelled in whole points and round 62.24 to `62`. Above five integer digits the
floor lifts, so a cumulative study like OBV keeps its integer form.

If a plot of yours is a price but sits on its own pane, the honest fix is
`overlay: true` on that plot so it draws on the candles, not a precision override.

### Labelling a plot's axis as something other than a price (2.2.1)

`IndicatorPlot.priceFormat` sets the axis and crosshair formatting of the scale
the plot maps to. It takes the same `PriceFormat` union as `addSeries`:

```ts
plots: [{
  key: 'hv', type: 'line', title: 'HV',
  priceFormat: { type: 'percent' },            // 18.4 reads "18.40%"
}]
```

| `type` | Reads |
| --- | --- |
| `'price'` | Tick-size precision, with optional `precision` / `minMove`. |
| `'volume'` | Compact `1.2K` / `3.4M` / `5.6B`. |
| `'percent'` | The value with a `%` suffix, `precision` decimals (default 2). |
| `'custom'` | Whatever `formatter(value)` returns. |

**`percent` suffixes and does not scale.** A study returning 0..100 reads
`62.24%`; one returning a 0..1 fraction reads `0.62%`. Multiplying inside `calc`
to make the axis read better changes the plotted value, and the legend, the
crosshair and every downstream calculation with it. Keep the value and label it.

Like `style.precision`, this is a property of the **price scale**, not the
series, so it belongs to a plot that owns its pane. Setting it on an `'onchart'`
plot reformats the instrument's own axis, which is almost never wanted. Two
built-ins use it: `historical-volatility` and `bollinger-bandwidth`, both of
which already multiply by 100.

## Free-standing geometry: `draws` (1.7.1)

A plot is one value per bar and a level is a horizontal line across the pane, so a pivot-to-pivot
trendline, a supply zone or a measured-move projection had nowhere to live. `draws(ctx)` returns
shapes anchored to `{ time, price }`:

```ts
draws: ({ bars, values, settings }) => ([
  { kind: 'line', from: { time: t0, price: p0 }, to: { time: t1, price: p1 },
    color: '#4f8cff', lineWidth: 2, lineStyle: 'dashed', extendRight: true },
  { kind: 'box', from: { time: t0, price: hi }, to: { time: t1, price: lo },
    fillColor: '#26a69a', opacity: 0.18, color: '#26a69a', text: 'demand' },
  { kind: 'label', at: { time: t1, price: p1 }, text: 'first line\nsecond line', color: '#ef5350' },
  { kind: 'polyline', points: [...], color: '#ffa726', closed: false },
])
```

- Anchors are **times, never logical indices.** Paging history in at the left edge shifts every index,
  and a trendline pinned to one would slide off its pivots. A time between bars resolves fractionally.
- `extendLeft` / `extendRight` solve the segment for the pane edge along its own slope, so a ray keeps
  its angle instead of flattening.
- The layer contributes **nothing to autoscale**: a projection reaching far above the data would
  otherwise squash the study it annotates.
- A `label`, and a `box` caption, split on `\n`. Marker text does too, since 1.7.1.
- Shapes entirely off-pane are culled before any path work.

Labels and box captions accept `fontSize` (positive finite CSS px), `fontFamily`
(nonempty CSS family list), `bold`, `italic`, and `textAlign` (left/center/right).
Defaults retain the normal 11px `ui-sans-serif, system-ui, sans-serif` font and
left-aligned rows. Measuring and drawing use the same font. `textAlign` changes
rows inside the measured plate, independently of plate placement.

For labels, existing `align` chooses the plate's horizontal edge on its anchor;
`verticalAlign: 'top' | 'middle' | 'bottom'` chooses the vertical edge, default
middle. Boxes add `align` and `verticalAlign` to position the caption plate within
their rectangle, default center/middle. A caption may still exceed its box.
Opted-in typography or placement measures before culling and clips paint and hits
to the plot, including in SVG. Omitted fields retain the original rendering.
Invalid new fields reject `setItems` atomically; replacement, hide and detach clear
old hit rectangles. Tooltip text keeps its separate default font. CSS families and
colors remain canvas text, with no HTML parsing or DOM font loading.

Polylines accept `curve: 'linear' | 'smooth'`; omitted keeps straight segments.
Smooth interpolates mapped screen anchors with cubic half-chord tangents, using
one-sixth neighbor differences for its controls. Open endpoint tangents repeat
the endpoint; closed paths wrap their neighbors. Overshoot is allowed and does
not affect autoscale. Smooth stroke/fill is plot-clipped in canvas and SVG, with
control-hull and stroke-width culling. Consecutive duplicates collapse, two
surviving points stay straight, and only a closed path drops a repeated last
endpoint. An open fill closes by a chord without closing the stroked curve.
Nonfinite source or mapped anchors omit a whole polyline in either mode.

The list is rebuilt on every recompute, exactly like `markers`. There are no retained handles to
mutate or leak, and a symbol change cannot strand a drawing.

### Drawing targets

Every `IndicatorDrawing` also accepts the `IndicatorOutputTarget` fields. With neither set the shape
stays in the study's own layer on its first local plot's scale, exactly as before.

- `overlay: true` draws the shape on pane 0 in the instrument's units, measured on the scale that
  pane quotes prices on (`PrimitiveRenderContext.readoutPriceScale`: its first visible price series,
  the candles, on whichever axis or overlay scale that is). It is read from pane 0 itself, so a host
  that puts its candles on another pane gets pane 0's own scale, never a scale from another pane. The layer binds no scale, so it
  never reserves an axis column and never stops `movePriceAxis` or `setSeriesPriceScale` from moving
  the candles; the shape goes with them. It stays on pane 0 through `moveIndicator` and ignores
  whole-study scale moves.
- `plot: key` draws it on that declared plot's pane and effective scale (per-plot assignment, then
  whole-study override, then descriptor, then `right`), and rebinds it when `setPlotPriceScales` or
  `setPriceScale` changes that plot's scale. An `overlay` plot takes the shape to the price pane.
- Each target is its own `IndicatorDrawings` layer owned by the instance: hidden with the study,
  released when a pass returns nothing for it, released on `remove()` or when the study's pane is
  removed, and recreated on `restoreState` from the descriptor (targets are descriptor data, not
  saved state). A layer created after the first pass is restacked into its study's place among the
  targeted layers on its pane, and nothing else moves (see the marker groups bullet for the order).
  Hit ids and tooltips report on the pane and scale the shape is drawn on.
- An unknown plot, or `plot` together with `overlay: true`, throws before any drawing layer changes,
  and so does an invalid style on any shape. Only the drawing layers are protected: the plots,
  fills, markers and table synced earlier in that pass stay applied, and the background, bar colours,
  levels and alerts wait for the next good pass. The error is published as the study's status.
- `new IndicatorDrawings(priceScale?)` takes an optional
  `(rc: PrimitiveRenderContext) => PriceScale | null | undefined`, read on every frame with that
  frame's context; without it, or when it returns nothing, the layer uses the scale its pane binds it
  to. The runtime passes `rc => rc.readoutPriceScale` for price-pane targets. A host can pass
  `() => series.priceScale()` to follow one series on that series' own pane.

```ts
draws: ({ bars }) => [
  { kind: 'box', from: { time: t0, price: hi }, to: { time: t1, price: lo },
    fillColor: '#26a69a', id: 'range', overlay: true },               // on the candles
  { kind: 'label', at: { time: t1, price: last }, text: 'Now', plot: 'momentum' },  // on that plot's axis
]
```

## The calc context (1.8.1)

`calc` takes an optional **fourth** argument and `calcTail` an optional **sixth**: what the calculation cannot read off the bars. It is optional and trailing on purpose, so every descriptor written against `calc(bars, settings, store)` keeps its exact signature and behaviour.

```ts
calc: (bars, settings, store, ctx) => {
  const confirmed = ctx?.barState.isConfirmed ?? true;   // default to "act", not "wait"
  ...
}
```

| Member | Meaning |
|---|---|
| `barState.isNew` | The last update **appended** a bar rather than replacing one. False on a full history load: there was no update to append. |
| `barState.isConfirmed` | Replay/provider confirmation takes precedence, then interval/calendar clock inference. |
| `barState.isRealtime` | This calculation follows a live mutation. Native initial/history/settings/replay executions are false. |
| `barState.lastIndex` | `bars.length - 1`, and `-1` when there are none. |
| `execution` | Optional `IndicatorExecutionContext`: provenance, change kind, revision, historyRevision and confirmationSource. |
| `symbol` / `interval` | Supplied by `chart.setDataContext`, or by a custom `IndicatorHost`. Undefined when the host has not supplied them. |
| `timezone` | The chart's IANA zone, the calendar its axis is labelled in. Same value as the reserved `settings.timezone` key. |
| `now()` | Chart wall clock in UTC seconds, the clock the countdown row reads. |

`isConfirmed` uses the declared interval when available. Fixed intervals close at the
recorded opening plus their duration; calendar intervals use the next boundary in the
configured timezone. A session gap does not extend the following bar's duration.
Unknown and count-driven intervals remain unconfirmed. Without an interval, the legacy
last-gap estimate remains, including a confirmed single bar. Empty history is confirmed.
Explicit series metadata (`confirmation: 'forming' | 'confirmed' | 'auto'`) overrides
the clock; replay's forming/completed state overrides provider state while active.

Native `execution.sourceId` identifies the source series within its chart/host.
`execution.provenance` is `history`, `live` or `replay`; `change` is `initial`,
`reset`, `prepend`, `append`, `replace`, `correction` or `refresh`. The source
`revision` counts mutations, while `historyRevision` invalidates cached prefixes.
Same-shaped historical replacements and corrections followed by a coalesced tail
update therefore take a full calculation. `confirmationSource` is `provider`,
`replay`, `clock`, `unknown` or `empty`. Native live alerts are suppressed for
history and replay; `now()` remains wall-clock time. Updates may coalesce, so do
not equate these revisions or script executions with provider tick counts.

Older custom `IndicatorHost` implementations may omit `sourceState` and execution
metadata; they retain the prior timestamp heuristic and sticky realtime flag.

## Alerts (1.8.1)

A crossover of an indicator's own columns is something only that indicator can name, so the condition is declared as data and the runtime watches it.

```ts
alerts: [{
  id: 'cross-up',                                 // stable within the descriptor
  title: 'MACD crossed up',
  frequency: 'oncePerBar',
  message: 'MACD histogram turned positive',      // optional, defaults to `title`
  when: ({ bars, values, settings, index }) => {
    const h = values.histogram;
    return index > 0 && (h[index - 1] ?? 0) <= 0 && (h[index] ?? 0) > 0;
  },
}],
```

A trigger emits `'indicator:alert'` on the chart's own bus with `{ indicatorId, instanceId, alertId, title, message, time, index }`.

`IndicatorAlertSpec.frequency` accepts the public `IndicatorAlertFrequency` union:

| Frequency | Delivery on native live source calculations |
| --- | --- |
| omitted | Existing behavior: evaluate newly appended bars once, using the original tail-only gate. Same-time updates do not trigger. |
| `everyUpdate` | Every observed live calculation where the condition is true, after chart batching. Superseded ticks are not separate executions. |
| `oncePerBar` | The first true live evaluation for each bar, including a condition that was false when the bar opened. |
| `onBarClose` | Once when a bar becomes confirmed and its close condition is true. A false close condition is final. |
| `once` | The first matching live result during this indicator instance's lifetime. Source changes, history resets and replay do not rearm it; removing and recreating the instance does. |

Historical loads, settings changes, repaint, asynchronous requested-data refresh
and replay do not emit or spend a `once` alert. Source/history replacement and
replay restoration seed checkpoints silently. `when` judges one bar using
`{ bars, values, settings, index }`; previous-bar comparisons read `index - 1`.

Close confirmation follows the native calculation context: the chart's own
clock and interval, explicit provider `confirmation`, or a newer appended bar.
Appending also closes the previous count bar; a new tail's `forming` override
does not reopen earlier bars. Coalesced appends evaluate each newly completed
bar. Same-time provider confirmation can close a bar without changing its price.
Clock closure waits for an eligible live source calculation; there is no alert
polling timer. Settings, repaint and asynchronous refresh alone cannot close it.

For `onBarClose`, predicate and message contexts contain only bar/output prefixes
through the evaluated index. Calculations must still be causal. Native dispatch
is at most once for a reserved delivery, including synchronous callback reentry;
it is not a notification acknowledgement or transport guarantee. Predicate or
message errors leave delivery unspent, surface through `dataStatus()`, and may
retry on a later eligible live revision, not a repeated read. Independent
successful alerts keep their checkpoints. Subscriber exceptions occur after
native dispatch is committed and do not retry that delivery.

For a signal arriving from outside the calculation entirely (a subscription your `attach(ctx)` opened), use `ctx.emit(event, payload)` on the attach context instead. That is the imperative half, it puts anything on the same bus, and it has no watermark.

## Pane shading and price-bar colours (1.8.1)

Two hooks that state something about a bar rather than about a price. Both run after every `calc` like `markers` and `draws`, both take `{ bars, values, settings }`, and both return one entry per bar with `null` meaning "leave this bar alone".

```ts
// Shading behind THIS indicator's own pane.
background: ({ values }) => values.trend.map((v) =>
  v === null ? null : v > 0 ? 'rgba(38,166,154,0.10)' : 'rgba(239,83,80,0.10)'),

// Recolouring the MAIN PRICE candles.
barColors: ({ values }) => values.bias.map((v) =>
  v === null ? null : v > 0 ? '#26a69a' : '#ef5350'),
```

`background` rules:

- **Pass a translucent `rgba()`.** The layer sits below the series but **above the grid**, so an opaque colour hides the grid lines inside its band.
- Contributes nothing to autoscale, is anchored to the first bar's **time** (so a page of history does not slide it off its bars), coalesces adjacent same-colour bars into one fill, and culls everything outside the visible range. Return `[]` to clear the layer.
- `IndicatorBackground` is exported and works as a plain primitive: `new IndicatorBackground()`, `chart.addPrimitive(p, paneIndex)`, `setColors(colors, bars)`, `setVisible(on)`.

`barColors` rules:

- Distinct from `colorBy`, which paints the indicator's **own** series. Use `barColors` only for a claim about the price bars themselves (a trend filter, a volatility regime, a higher-timeframe bias).
- Two built-ins use it, both added in 1.8.3: `hull-suite` behind its `candleCol` input (off by default), and `consolidation-breakout` behind `colorinside` (on by default). Both apply the toggle in the hook rather than in `calc`, so flipping it restyles what is already computed and the columns stay the study's own answer.
- **Only one indicator's colours can be on the candles at a time.** Last writer wins, deterministically: publishers run in `addIndicator` order. Hiding or removing the indicator withdraws them.
- The engine clones only the bars whose colour changes, so it never writes into the array the host handed `setData`.
- Two known gaps: removing the winner while a second publisher is live drops the bars back to their own colours until that publisher's next recompute; and prepending older history retakes the "own colour" snapshot from bars that already carry the overlay, so removing the indicator afterwards leaves the pre-prepend region tinted.

## A plot drawn as candles (1.8.1)

A single column cannot express a bar. `plot.ohlc` names **four `calc` columns in the same `IndicatorValues`**, so `calc` keeps one return shape:

```ts
plots: [{
  key: 'ha', type: 'candlestick', title: 'Heikin-Ashi',   // or 'hollow-candle', 'bar', 'high-low'
  ohlc: { open: 'haOpen', high: 'haHigh', low: 'haLow', close: 'haClose' },
}],
calc: (bars) => ({ haOpen: [], haHigh: [], haLow: [], haClose: [] }),   // four ordinary columns
```

`key` stays the series identity (`instance.series('ha')`, the style keys); the legend reading falls back to the `close` column. All four columns must exist and be exactly `bars.length` long or `chart.addIndicator` **throws**, because the first `calc` runs inside the instance constructor. `colorBy` still applies, judged on the close. A user overriding the plot's chart type through `<plotKey>:type` degrades quietly: line, area and histogram read `close`.

## Interval introspection (1.8.1)

Do not branch on the interval string. A study written against `'1m'`, `'5m'` and `'15m'` misbehaves on `'3m'`, and a host's own registered code was never in the list.

```ts
import { intervalParts, isIntradayInterval, isDailyInterval, isSecondsInterval, isTickInterval } from 'openalgo-charts';

intervalParts('120m');   // { multiplier: 2, unit: 'h' }   canonical, the same answer as '2h'
intervalParts('zz');     // null
isIntradayInterval(ctx.interval ?? '');   // true, so anchor to the session open
```

Answers are read off the **bucketing rule**, not the code's spelling, so any registered code answers. `unit` is `'s' | 'm' | 'h' | 'D' | 'W' | 'M' | 'tick' | 'other'`; `M` is months (a quarter reads 3, a year 12), and `'other'` is volume bars. `isIntradayInterval` is a fixed length under a day, so a registrable `25h` is false despite decomposing into hours; a calendar or count-driven code has **no** clock length rather than a long one, so it is false too. `isDailyInterval` is exactly one day (`D`, `24h`, `1440m`). `isSecondsInterval` is "not a whole number of minutes". `isTickInterval` is trade-count bars only; volume bars answer false.

## Colour helpers (1.8.1)

```ts
import { withAlpha, fromGradient } from 'openalgo-charts';

withAlpha('#26a69a', 0.12);                        // 'rgba(38,166,154,0.12)'
fromGradient(v, 30, 70, '#ef5350', '#26a69a');     // sRGB blend, alpha included, clamped
```

Use these in a `colorBy`, `background` or `barColors` rather than hand-rolling a hex parser. They read `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; **CSS colour names are not parsed**. Neither throws: an unparseable input comes back untouched from `withAlpha`, and `fromGradient` falls back to `low`. A not-available value, and a zero-width range, both resolve to `low` rather than to `rgba(NaN,...)`, which matters because canvas ignores an unparseable `fillStyle` and silently repaints the previous colour. `min > max` is a legitimate way to flip the scale.

## Tier 2: indicators with their own data

Use Tier 2 when the series has its own timestamps: cumulative volume delta, PCR,
or an external analytics feed. Per-bar open interest uses the built-ins above.
`createTier2Indicator` (exported from `openalgo-charts/indicators`) wraps a
fetch/subscribe lifecycle into an ordinary `IndicatorDescriptor`: the runtime,
settings model, panes, levels, and removal are identical.

```ts
import { registerIndicator } from 'openalgo-charts';
import { createTier2Indicator } from 'openalgo-charts/indicators';

registerIndicator(createTier2Indicator({
  id: 'external-position-index',
  name: 'External Position Index',
  category: 'Volume',
  placement: 'pane',
  inputs: [{ key: 'symbol', type: 'text', label: 'Symbol', default: 'NIFTY' }],
  plots: [{ key: 'position', type: 'line', title: 'Position', style: { lineWidth: 1.5 } }],
  refetchOn: ['symbol'],                       // only these keys invalidate the data
  fetch: async ({ settings, from, to }) => {   // from/to are UTC seconds of first/last bar
    const rows = await loadPositionIndex(String(settings.symbol), from, to);
    return rows.map((r) => ({ time: r.time, values: { position: r.value } }));
  },
  subscribe: (ctx, push) =>                    // returns an unsubscribe function
    streamPositionIndex(String(ctx.settings.symbol), (r) => push({ time: r.time, values: { position: r.value } })),
}));
```

`Tier2Point` is `{ time: UTCSeconds, values: Record<plotKey, number | null> }`.
`Tier2Context` carries `{ settings, bars, from, to }`; `from`/`to` are `0` when
there are no bars. It also has optional `dataContext`, `signal`, `requestBars`,
native `requestState: Readonly<IndicatorRequestState>` and `asOf`. The last is a
finite replay knowledge cutoff, separate from the source-bar time window.

### Native revisions and replay

On native charts, provider replacement, source identity changes, historical
corrections/reset and changed dataset settings clear obsolete values and cancel
pending requests. History-only descriptors refetch the forming overlap on a
same-time source update, including when the first/last timestamps are unchanged.
One request stays active and repeated updates coalesce into the latest desired
window. Covering newly prepended and appended history can require separate prefix
and tail requests. A proven unchanged suffix preserves loaded history on prepend;
overlap or unproven historical changes reset the complete window.
Style-only settings changes retain an unchanged dataset's request and values.
Live descriptors use their subscription for ordinary price ticks;
`chart.invalidateRequestedData()` explicitly refetches the full visible window
even with a live subscription. Live arrivals after that refresh starts can
override its response at matching timestamps; old cached live values cannot.

`Tier2Descriptor.supportsReplay` defaults to false when native `requestState`
identifies replay. Such a study becomes unsupported, clears values and stops live
callbacks. Opt in only when `fetch(context)` honors finite `context.asOf`, returns
the value versions known then, and stamps each point with its availability time.
The wrapper filters points beyond the cutoff but cannot recover value versions
from a current-data cache. Native legacy replay without a finite availability
clock remains unsupported even after opting in.

```ts
supportsReplay: true,
fetch: async ({ from, to, asOf, signal }) =>
  analytics.loadPoints({ from, to, asOf, signal }),
```

Replay entry, exit and backward seeks cancel obsolete work and clear the old
dataset. Forward movement fetches the complete window and replaces its response;
it does not merge a previous replay frame's points. No live subscription runs
during replay. A response can be empty when no observations were available.
The ordinary alignment rule still selects at or before each source opening.

The replay guard applies only when request state explicitly identifies native
replay. Hand-built contexts without that state retain their legacy behavior.
The raw `requestBars` API is unchanged and does not enforce point-in-time versions
for your `fetch`; forward `asOf` to an analytics/snapshot source that can honor it.
For requested OHLC expressions with confirmation metadata, use
`createRequestedIndicator` instead.

**Alignment rule, stated exactly.** Each bar takes the most recent external point whose time is **at or before** that bar's time. Values are last-known-value: never interpolated between points, never forward-looking. Bars before the first point are `null`, and so is any value that is not a finite number. Both arrays are time-sorted, so alignment is one linear merge.

Lifecycle facts:

- `attach` re-runs on **every** `setSettings`. `refetchOn` forms the data key; include all settings that identify the source dataset, such as symbol, exchange and resolution. A changed key immediately clears prior values and starts a new request. A pending or failed request must not display another key's observations.
- A style-only change with the same key reuses loaded data or the pending history request. An empty successful result counts as loaded. Omitting `refetchOn` uses no settings-derived key; supplied chart context still identifies the dataset.
- Live points arriving out of order are upserted into time order; a point with an existing time replaces it. Points received while history is pending are merged after history, so live observations win at matching timestamps.
- A rejected `fetch` retains live observations for the current key. `retryData()` or a context/settings change can retry history; failure never restores points from an earlier key.
- Teardown closes the subscription and invalidates the attachment. Late history completions and callbacks from previous attachments cannot publish after a settings change or removal.

Tier-2 points are aligned onto the source bars before plot data is written; an external
observation between bars or beyond the newest bar does not add a timestamp to the chart.
Do not bypass that alignment by adding a separate raw external series when timeline
isolation matters. For concurrent module registration and host CSP boundaries, see
[host-integration](host-integration.md#registration-and-csp).

## Higher timeframes: `securitySeries` (2.4.0)

The one fold from the chart's own bars to a coarser interval, one value per source bar, so a study can read the daily high on a 5-minute chart without a second data source. Exported from `openalgo-charts/indicators`.

```ts
import { securitySeries } from 'openalgo-charts/indicators';

const day = securitySeries(bars, '1d', { timezone: String(settings.timezone ?? '') || undefined });
// day.open / high / low / close / volume / oi: (number | null)[] aligned to bars
// day.bucketStart: first source bar time of the bucket; day.isNew: first bar of each bucket
```

`SecurityOptions` selects one of three readings, and the difference is the whole reason the helper exists:

`oi` is the latest defined open-interest level within the selected bucket, never
a sum. It remains `null` when that bucket has no readings. Developing buckets
cannot use a later source bar's level; zero remains a real observation.

| Option | What bar `i` reads | Repaints live? |
|---|---|---|
| default (`offset: 0`) | The bucket **as it stood at bar i**: open so far, high and low so far, the bar's own close, volume so far. | No. Never uses a later bar. |
| `offset: k` | The bucket completed `k` buckets before, held constant across the current one. The non-repainting reference, `close[1]` on the higher timeframe. `null` until one exists. | No. |
| `lookahead: true` | The current bucket's **final** values on all of its bars. | Yes. Uses bars that had not happened yet; here so a source that did this can be reproduced, not recommended. |

Buckets follow the chart's calendar: a day is a day in `timezone`, a week starts on Monday there, a registered calendar interval (`{ mode: 'calendar' }`) cuts on its own period, and a sub-day interval is anchored to the epoch unless `session: '0915-1530'` is given, which anchors it to the session open the way an exchange cuts hourly bars (a 30-minute bucket on a 09:15 open then runs 09:15 to 09:45, not 09:00 to 09:30). A tick or volume interval throws `IndicatorInputError`, and so do a negative `offset` and an unreadable `session`. `volume` is `null` on a bucket none of whose bars carried one.

## Calculate before timeframe alignment

`securityExpression(bars, interval, expression, options?)` folds OHLC, volume and
open interest into requested bars, evaluates the expression there, then aligns
its named result columns to the original bars. Import it and
`SecurityExpressionOptions` from `openalgo-charts/indicators`. Applying an average
to `securitySeries(...).close` instead counts repeated aligned values as separate
observations and gives a different result.

```ts
import { securityExpression, sma, nulls } from 'openalgo-charts/indicators';

const result = securityExpression(bars, '1h', requested => ({
  mean: nulls(sma(requested.map(bar => bar.close), 20)),
}), { timezone: 'Asia/Kolkata', session: '0915-1530', mode: 'confirmed' });
```

`SecurityExpressionOptions` accepts `timezone`, `session` and `mode`:

| Mode | Alignment |
| --- | --- |
| `confirmed` (default) | Hold the previous observed bucket's result starting at the next bucket's first source bar. Initial values are null. |
| `developing` | Recalculate every source prefix, using the current partial bucket without later source bars. |
| `lookahead` | Put the current bucket's final result on all its source bars, including earlier ones. Historical values use future observations. |

The expression must be pure and causal, returning one array per named column,
each exactly as long as the requested bars. Confirmed and lookahead modes call it
once with the complete folded history; the helper cannot prevent an expression
from deliberately reading later indices. Developing mode calls it once per source
bar and requires stable column names. The callback receives frozen copies of bars.
Non-finite results become null. Empty input returns an empty object without calling
the expression. Input timestamps must be finite and strictly increasing.

Supply source bars at the requested interval or finer. This helper neither fetches
another instrument nor reconstructs intrabar data from coarse bars. Missing buckets
are absent; the last bucket is not confirmed by wall-clock time. Session anchors
use local wall-clock time across offset changes. Tick and volume intervals are
rejected because time bars cannot determine their closes.

## Requested data with explicit availability

Use `alignRequestedExpression` or `requestedIntrabars` when the requested bars
already come from another symbol or interval. Both are pure helpers: the host
supplies the observations and metadata. Neither fetches data, registers a
provider, aggregates candles or changes the existing `securitySeries` and
`securityExpression` defaults.

These exports come from `openalgo-charts/indicators`; `RequestedBarsSnapshot`
is also exported from base for provider implementations:

| Export | Contract |
| --- | --- |
| `alignRequestedExpression` | `(targetTimes, snapshot, expression, options?) -> IndicatorValues` |
| `requestedIntrabars` | `(targetWindows, snapshot, expression, options?) -> RequestedIntrabarValues` |
| `RequestedBarsSnapshot` | Aligned `bars`, `availableAt: (number \| null)[]`, and `confirmed: boolean[]`. |
| `RequestedExpression` | Pure, causal callback over readonly requested bars, returning one named column per result. |
| `RequestedAlignmentOptions` | `gaps?: 'carry' \| 'missing'`, default `carry`. |
| `RequestedTimeWindow` | `{ start: number, end: number }` in UTC seconds. |
| `RequestedIntrabarOptions` | Optional finite inclusive availability cutoff `asOf`. |
| `RequestedIntrabarValues` | `{ times: number[][], values: Record<string, (number \| null)[][]> }`. |

`availableAt[i]` is when observation `i` became known, at or after its opening.
Null means unknown. An unconfirmed bar or unknown availability ends the eligible
prefix: that row and every later row cannot emit. The observations stay in the
expression input, with their original indices. Earlier eligible rows can still
carry. Each result waits for the greatest availability timestamp in its prefix,
so a delayed earlier observation cannot expose a dependent result prematurely.
Confirmation is explicit, including for count-driven bars; no clock infers it.

The callback runs once on frozen copies of the entire requested history, before
alignment or grouping. Each output column must match that history's length.
Output at index `i` must use only observations through `i`; causality is the
callback author's responsibility. Null, NaN and infinities become null. A newer
null result replaces an older finite value. Empty requested history returns no
columns without calling the expression. Empty targets with nonempty requested
history still evaluate to obtain named empty columns.

For scalar alignment, evaluation times are finite and strictly increasing.
`carry` reads the latest eligible row at or before each target time. `missing`
emits only when that selected row changes; the first target is an initial
reading. Several rows becoming available together select the latest row.

```ts
import { alignRequestedExpression, type RequestedExpression } from 'openalgo-charts/indicators';

const snapshot = {
  bars: [10, 20, 30].map((close, i) => ({ time: i * 120, open: close, high: close, low: close, close })),
  availableAt: [60, 180, 300], confirmed: [true, true, true],
};
const expression: RequestedExpression = bars => ({
  mean: bars.map((bar, i) => i === 0 ? null : (bar.close + bars[i - 1].close) / 2),
});
const times = [0, 60, 120, 180, 240, 300];
alignRequestedExpression(times, snapshot, expression).mean; // [null, null, null, 15, 15, 25]
alignRequestedExpression(times, snapshot, expression, { gaps: 'missing' }).mean; // [null, null, null, 15, null, 25]
```

Intrabar windows must be finite, ordered and nonoverlapping, with `start < end`.
Opening-time membership is `[start, end)`; effective availability must also be at
or before `end` and optional `asOf`. Delayed observations are not moved into later
windows. Results retain timestamps, null positions and requested order. Empty
windows return empty arrays. A rolling expression spans the entire requested
history and does not restart at each window. Build session windows explicitly
from the desired calendar; a missing next candle does not define a session close.
There is no timezone or session inference in these helpers.

Malformed snapshots, metadata, target order, options or expression output throw
`IndicatorInputError`. All input rows are validated before the callback, including
rows beyond an ineligible prefix. These helpers cannot reconstruct historical
forming-bar updates or availability metadata from final OHLC alone.

## Managed requested snapshots

`createRequestedIndicator(descriptor)` returns an ordinary `IndicatorDescriptor`.
Register it, then use `chart.addIndicator` and the existing settings, status,
retry, pane and removal APIs. It calculates on requested observations before
aligning results to the source chart, and owns the asynchronous snapshot lifecycle.
The chart's provider must expose `requestSnapshot`; a raw bar provider remains
valid for raw requests but cannot supply explicit availability automatically.

```ts
import { registerIndicator } from 'openalgo-charts';
import { createRequestedIndicator } from 'openalgo-charts/indicators';

registerIndicator(createRequestedIndicator({
  id: 'benchmark-close', name: 'Benchmark close', placement: 'pane', inputs: [],
  plots: [{ key: 'close', type: 'line', style: { color: '#e8a23a' } }],
  request: ({ bars }) => ({ symbol: 'BENCHMARK', interval: '1h',
    from: bars[0]?.time ?? 0, to: bars[bars.length - 1]?.time ?? 0 }),
  expression: requested => ({ close: requested.map(bar => bar.close) }),
}));
```

`RequestedIndicatorDescriptor` supports `id`, `name`, optional `category`,
`placement`, `inputs`, `plots`, optional `levels`/`range`, plus:

| Member | Contract |
| --- | --- |
| `request(context)` | A complete `IndicatorSnapshotRequest` without `signal`, or null for unsupported. Include any calculation warmup in the opening-time window. The helper owns cancellation. |
| `expression(bars, settings, context)` | Named columns, each matching requested-bar count and including every scalar plot key or declared OHLC source column. Frozen copied input; pure and causal through each result index. Nonfinite results become null. |
| `gaps` | `carry` by default, or `missing`, using the pure alignment helper's rules. |
| `targetTimes(context)` | Optional finite strictly increasing query times, one per source bar; defaults to source openings. |

`RequestedIndicatorContext` carries source `bars`, current `settings`, optional
`dataContext`, optional native `requestState`, and the calculation context when
called during calculation. It does not infer target evaluation times from bar
closure. To let the final source bar observe requested releases after its opening,
explicitly use the replay playhead for that final target:

```ts
targetTimes: ({ bars, requestState }) => bars.map((bar, index) =>
  index === bars.length - 1 ? Math.max(bar.time, requestState?.replay?.asOf ?? bar.time) : bar.time),
```

The maximum keeps targets ordered while replay changes its clock before replacing
the source bars. The snapshot's own cutoff still bounds requested availability.

Snapshots are validated in full and copied before use. With an `asOf` cutoff,
only the confirmed known prefix available by that cutoff reaches the expression.
Without one, all requested observations reach the expression and alignment
enforces the eligibility prefix. Neither path can prove callback causality or
reconstruct historical value versions: the provider must return what was known
at `asOf`, or reject it. `RequestedBarsSnapshot`, `IndicatorSnapshotRequest`,
`IndicatorBarsProviderAccess` and `IndicatorRequestState` are native base types;
the snapshot type is re-exported from indicators.

Provider replacement, source identity/history changes, request instrument or
explicit selector cutoff changes, replay entry/exit and backward replay clear
obsolete output and cancel work. Tail revisions, `invalidateRequestedData()` and
forward replay retain one active request and coalesce one latest follow-up;
they do not queue every tick. Style reattachment preserves a pending request
when its selection is unchanged. The helper stores raw snapshots, then reruns
the expression and alignment when calculation is required.

Read `dataStatus()` or subscribe with `subscribeDataStatus`; `retryData()` retries
the current request. States are `loading`, `ready`, `empty`, `unsupported` or
`error`. A nonempty valid snapshot can be ready while all aligned results are
null. Provider capability absence, a null selector and legacy replay without
an availability clock report unsupported and clear values. Removal and chart
destruction cancel requests and prevent stale publication. This helper adds no
transport, page merging or live subscription; the host announces external changes.

## Optional missing-value policies on established helpers

`sma`, `wma`, `rma`, `smaSeededEma`, `stdev`, `dev`, `highest`, `lowest`,
`highestBars`, `lowestBars` and `percentRank` accept a final
`NumericalWindowOptions` argument. With a scalar period, omitting it preserves each
helper's default calculation and warmup behavior. Passing `{}` selects
`missing: 'propagate'`.

For positive safe-integer scalar periods, default `sma(values, period)` and
`rollingSum(values, period)` sum each current window chronologically and require
finite inputs and a finite sum. SMA divides once after the sum. Old gaps and
overflow stop affecting output once they leave the window. These paths cost
O(bars * period) time and O(1) extra space excluding output. Explicit SMA options,
including `{}`, and varying-length SMA use their separate compensated policy.
Unsupported scalar periods retain their existing behavior.

Default scalar `wma`, `stdev` and `dev` with valid periods accumulate window terms
oldest first and omit nonfinite final results. Their explicit-options,
varying-length and unsupported-period behavior is unchanged.

Default scalar `rma` and `smaSeededEma` with positive safe-integer periods seek
the first complete finite window with a finite chronological sum. A missing or
overflowing seed window can expire and recover. After seeding, a missing input
emits NaN while retaining the previous running state. Overflow from a finite
running update stays committed and unavailable; it does not trigger reseeding.
Ordinary work is O(bars + period); repeated overflowing seed windows can require
O(bars * period). Explicit options keep the policies below. The base tier's
first-value `ema` and the EMA descriptor's resolved study-source propagation
remain unchanged.

ADX/DMI treats unavailable high/low changes as absent observations. Each smoother
retains its state across gaps. Zero or unavailable smoothed true range leaves
directional ratios and strength absent; an old displayed ratio is not substituted
into the strength calculation. Finite observations resume the retained states.

With options, NaN and infinities are missing. Propagation requires a complete
chronological finite window. Skip mode collects the last `period` finite
observations and holds numeric window results across gaps. Extremum offsets keep
original bar indices and therefore age across gaps; ties choose the latest bar.
Rank examines prior observations, excludes the current subject, and produces NaN
when that subject is missing. Recursive smoothers reset on a propagated gap and
reseed from a full consecutive SMA window; skip mode retains their previous state.
Option-path periods must be positive safe integers. Invalid periods throw
`RangeError`; invalid policies throw `TypeError`.

```ts
sma([1, 3, NaN, 5], 2, { missing: 'skip' }); // [NaN, 2, 2, 4]
highestBars([5, 1, NaN, NaN], 2, { missing: 'skip' }); // [NaN, -1, -2, -3]
```

## Varying window lengths

`sma`, `wma`, `stdev`, `dev`, `highest`, `lowest`, `highestBars`,
`lowestBars` and `percentRank` also accept a `readonly number[]` for `period`.
Every existing scalar call keeps its calculation, including calls with missing-value
options. With an array, bar `i` uses `period[i]`; omitted options and `{}` both select
`missing: 'propagate'`. A constant length array matches the scalar call with `{}`.

Length arrays must match the source length exactly. Each element must be a positive
safe integer or `NaN`. A `NaN` length produces a gap at that bar, without forgetting
its source observation. Insufficient history also produces `NaN`. Zero, negative,
fractional, infinite and unsafe lengths throw `RangeError`; nonnumeric elements
and array holes throw `TypeError`. A length mismatch throws `RangeError`. The entire
parameter array is validated even when the source is empty or still warming up.

Propagation uses a complete chronological window. Skip mode collects the requested
number of finite observations, keeping their original order and bar indices. A
changed length reevaluates that history even on a missing source bar. Earlier
observations remain available when a length grows after shrinking. Extremum offsets
stay negative into the original history, and ties select the latest bar. Rank uses
previous observations only, counts equality and requires a finite current subject.

```ts
import { barsSince, sma, highestBars, nulls } from 'openalgo-charts/indicators';

const values = [100, 2, 4, 6, 8, 10];
const resets = [false, true, false, false, true, false];
const lengths = barsSince(resets).map(distance => distance + 1);
const mean = sma(values, lengths);
// [NaN, 2, 3, 4, 8, 9]: average since the latest reset, including that bar.
const plotColumn = nulls(mean);

sma([2, 4, NaN], [1, 2, 1], { missing: 'skip' }); // [2, 3, 4]
highestBars([5, NaN, 5, 4], [1, 1, 2, 2], { missing: 'skip' }); // [0, -1, 0, -1]
```

These array overloads preserve output length and never mutate inputs. Work is
proportional to the input plus the total evaluated window lengths, with linear
working storage; choosing long windows on every bar can take quadratic time.
`rma`, `smaSeededEma` and the statistics helpers below still take scalar periods.

## Varying pivot widths

`pivotHigh(values, left, right)` and `pivotLow(values, left, right)` accept each
width independently as a scalar or `readonly number[]`. Calls with two scalar
widths keep their existing behavior. When either width is an array, arrays must
align with the source, and widths must be nonnegative safe integers. `NaN` array
elements give local gaps; a scalar companion cannot be `NaN`. Invalid numbers
or mismatched lengths throw `RangeError`; malformed arrays or elements throw
`TypeError`. Both sides are validated before calculation, including warmup bars.

At confirmation index `i`, both widths come from that index. The candidate is
`i - right[i]`, using the scalar right width when supplied. Its left neighbors and
all bars through `i` must be available and finite. A high must be strictly greater
than every neighbor; a low must be strictly smaller. Ties on either side reject the
candidate. Zero widths are valid; two zero widths return the finite current value.

```ts
import { pivotHigh } from 'openalgo-charts/indicators';

const highs = [1, 5, 2, 1, 0];
const right = [1, 1, 1, 2, 3];
const confirmed = pivotHigh(highs, 1, right);
// [NaN, NaN, 5, 5, 5]
// Confirmation indices 2, 3 and 4 all refer to candidate index 1.
```

Results stay on confirmation bars. A varying right width can confirm the same
candidate more than once; the helpers do not deduplicate those results. Missing
widths invalidate only the current evaluation. Candidate-bar widths do not control
a later confirmation. To anchor a marker or drawing at the candidate, recover its
index as `i - right[i]` and use that source bar's time. A single `plot.offset` cannot
represent varying right widths. Numerical confirmation requires the supplied bars;
it does not additionally check whether the current market bar has closed.

## Coverage additions (2.4.0)

Every item is optional and additive: a descriptor written against 2.3.2 computes and draws what it did, existing built-ins retain their calculations, and `colorBy` keeps its string return type.

- **`IndicatorPlot.offset`** paints a column `offset` bars to the right of its data (negative: left). The column stays one value per bar and the shared axis gains no bars; the last `offset` values land in the right margin past the newest candle, which is the displaced Ichimoku cloud or `plot(x, offset = n)`. A `fills` band between two plots follows the **first** plot's offset, autoscale ranges over what is painted in view, and the legend reads the value drawn under the cursor. The series-level form is `SeriesStyle.barOffset`, which `series.applyOptions({ barOffset: 6 })` sets on any series.
- **Recompute guard and `IndicatorInputError`.** A `calc` (or hook) that throws once the indicator is on the chart no longer throws into the render loop or leaves the studies behind it stale for that frame. The runtime catches it, publishes `{ state: 'error', error }` on the instance's data status (`dataStatus()`, `subscribeDataStatus`, and the `indicator:data-status` chart event, the same channel a Tier-2 fetch failure uses), keeps the previous plots up, and publishes `ready` on the next pass that succeeds. The constructor's own pass is still unguarded on purpose: a descriptor that cannot compute at all is refused by `addIndicator`. Throw `new IndicatorInputError('Period must be greater than 0')` for a condition the user can fix, so a host can tell it from a bug; it is exported from the base entry.
- **`IndicatorAlertSpec.message`** may be a function of the same context `when` judged (`{ bars, values, settings, index }`), so a message can carry the bar's own numbers or a JSON body for a webhook. It runs only for a bar `when` accepted.
- **`MarkerShape`** gains `cross` and `xcross`; **`MarkerPosition`** gains `paneTop` and `paneBottom`, which pin the glyph to the plot edge (stacking inward) rather than to a price, need no bar under them and no `price`, and put marker `text` on the inward side.
- **`IndicatorFillSpec.overlay`** draws the band on the price pane, the pair with `IndicatorPlot.overlay`: a pane study whose two edge plots are `overlay: true` can shade between them beside the candles. Ignored for an `'onchart'` descriptor.
- **`IndicatorPlot.colorParts`** returns `{ body?, wick?, border? }` per bar (`PlotBarColor`), which is how a study paints a solid wick over a translucent body. It takes precedence over `colorBy` for the parts it names; a part it leaves undefined falls back to `colorBy`, then the plot colour. A value plot reads `body` only. The bar carries them as **`Bar.wickColor`** and **`Bar.borderColor`**, honoured by both the 2D and the WebGL2 candle paths, and any series can set them on its own bars.
- **Drawing `tooltip` and `id`** on `label` and `box` items of `draws()`. A shape carrying either becomes hit-testable: the chart reports it through `subscribeClick` (by `id`, defaulting to the tooltip text) and, while the pointer rests on it, the layer paints the tooltip on a plate clear of the shape, above it when there is room. Lines and shapes with neither stay ink only, so a busy study does not light the cursor on every ray.
- **`IndicatorInput` types `interval` and `time`.** `interval` holds a timeframe code the engine can bucket by; the widget renders it as a select over the built-in tokens and the registered codes, with an empty first entry meaning the chart's own interval. `time` holds a wall-clock string in the chart's zone, `YYYY-MM-DD HH:MM` (time optional), rendered as text and turned into a bar time with `zonedStringToUtcSeconds`; it is a string rather than UTC seconds so a saved layout restores to the same wall clock in another zone.
- **`ChartTableOptions.fontSize: 'auto'`** fits each cell: as large as its row allows, shrunk until its text also fits its column, so one long label sizes only itself down. A `TableCell.fontSize` still wins for that cell.
- **A bars provider for other instruments.** `ChartOptions.barsProvider`, `chart.setBarsProvider(provider | null)` and `chart.hasBarsProvider()` register where an indicator gets another symbol's (or interval's) bars; the engine owns no transport, so the host answers from wherever it keeps history. The attach context gains `requestBars(request)` (`IndicatorBarsRequest`: `symbol`, `exchange?`, `interval`, `from`, `to`, `signal?`; the instance lifetime is the default signal), read at request time so an indicator added before the provider still gets served, and rejecting with a clear message when there is none, which a study should publish as `unsupported`. `Tier2Context.requestBars` carries the same function into `fetch`, **`Tier2Descriptor.series`** names external columns to align besides the plots, and **`Tier2Descriptor.calc(bars, external, settings, store, ctx)`** combines the aligned columns with the chart's bars, so a relative strength or a beta against a benchmark is one Tier-2 descriptor. Without `calc` the wrapper returns the aligned plot columns exactly as before.

## Standalone calculators in the base bundle

`ema`, `rsi`, `atr`/`trueRange`, and `supertrend` ship in the **base** bundle: the tier imports them rather than reimplementing them. Use these when you want to compute a value and plot it yourself, and skip the managed runtime (no legend row, no auto-recompute, no settings dialog, no pane management).

```ts
import { ema, emaSeries, rsi, rsiSeries, atr, trueRange, supertrend, supertrendSeries } from 'openalgo-charts';
```

| Function | Signature | Warmup |
|---|---|---|
| `ema` | `(values, period) => number[]` | none; seeds from `values[0]`, `k = 2/(period+1)`. Throws if `period <= 0`. |
| `emaSeries` | `(bars, period) => Bar[]` | O/H/L/C all set to the EMA, so feed a `line` series. |
| `rsi` | `(values, period = 14) => number[]` | Wilder. `NaN` for indices `< period`. |
| `rsiSeries` | `(bars, period = 14) => Bar[]` | as above, plottable. |
| `trueRange` | `(high, low, close) => number[]` | none; `tr[0] = high[0] - low[0]`. |
| `atr` | `(high, low, close, period = 14) => number[]` | Wilder. First value at index `period - 1`. |
| `supertrend` | `(bars, period = 10, multiplier = 3) => SupertrendPoint[]` | `{ value, direction }`; `value` is `NaN` during ATR warmup. `direction` `-1` = uptrend, `+1` = downtrend. |
| `supertrendSeries` | `(bars, period, multiplier) => { up: Bar[]; down: Bar[] }` | inactive leg carries `NaN` so the line breaks at flips. |

The tier exports the pure helpers from `src/indicators/calc.ts`, including `sma`, `wma`, `rma`, `stdev`, `highest`, `lowest`, `nulls`, `connorsStreak`, `rollingSum`, `correlation`, `pivotHigh`, `pivotLow`, `barsSince` and `valueWhen`. Read each signature before composing it; these helpers do not all return the same shape. `nulls` converts `NaN` to `null` for a plot column. Default scalar `sma` sums each finite current window independently, so expired gaps or overflow cannot poison later windows. `correlation` takes two passes over each window, oldest first, finishing both means before any deviation, so it keeps its precision at high price levels where a single-pass sum of squares cancels; a window with a missing value, no spread or an overflowing step is `NaN`.

The tier also exports every descriptor by name in SCREAMING_SNAKE form (`RSI`, `MACD`, `HALFTREND`, ...), the per-family arrays (`OVERLAY_INDICATORS`, `OSCILLATOR_INDICATORS`, `VOLATILITY_INDICATORS`, `FLOW_INDICATORS`, `ADAPTIVE_INDICATORS`, `AVERAGE_INDICATORS`, `STRENGTH_INDICATORS`, `INDEX_INDICATORS`, `RANGE_INDICATORS`, `SIGNAL_INDICATORS`), and the flat `BUILTIN_INDICATORS`. Read `BUILTIN_INDICATORS` rather than hard-coding a list of ids.

Related: [core-api](./core-api.md), [chart-types](./chart-types.md), [scales-and-panes](./scales-and-panes.md), [events-and-state](./events-and-state.md), [bundling-and-tiers](./bundling-and-tiers.md), [transforms](./transforms.md), [pitfalls](./pitfalls.md).

## Every built-in is also a named export

The tier's import side effect registers all 105. You do not have to take all
105. Each descriptor is exported individually under the UPPER_SNAKE form of its
id, so a bundle can register only what it draws:

```ts
import { registerIndicator } from 'openalgo-charts';
import { BOLLINGER, RSI, SUPERTREND } from 'openalgo-charts/indicators';

for (const d of [BOLLINGER, RSI, SUPERTREND]) registerIndicator(d);
```

A descriptor is plain data plus a `calc`, so a named export also doubles as a
calculation with no chart attached:

```ts
const out = BOLLINGER.calc(bars, indicatorDefaults(BOLLINGER), {});
// -> { upper, basis, lower }, each bars.length long
```

Reuse beats reimplementation here: calling a built-in's own `calc` cannot drift from
the version the user has on the chart, and the plot keys are the built-in's, not its id
(`ema` plots `ma`; `bollinger` plots `upper` / `basis` / `lower`). Read
`getIndicator(id).plots` rather than guessing.

| Export &rarr; id | Export &rarr; id | Export &rarr; id |
|---|---|---|
| `ADL` &rarr; `adl` | `ADX` &rarr; `adx` | `ALLIGATOR` &rarr; `alligator` |
| `ALMA` &rarr; `alma` | `ALPHATREND` &rarr; `alphatrend` | `AROON` &rarr; `aroon` |
| `AROON_OSCILLATOR` &rarr; `aroon-oscillator` | `ATR` &rarr; `atr` | `AVERAGE_DAILY_RANGE` &rarr; `average-daily-range` |
| `AWESOME_OSCILLATOR` &rarr; `awesome-oscillator` | `BALANCE_OF_POWER` &rarr; `balance-of-power` | `BB_TREND` &rarr; `bb-trend` |
| `BOLLINGER` &rarr; `bollinger` | `BOLLINGER_BANDWIDTH` &rarr; `bollinger-bandwidth` | `BOLLINGER_PERCENT_B` &rarr; `bollinger-percent-b` |
| `CCI` &rarr; `cci` | `CHAIKIN_MONEY_FLOW` &rarr; `chaikin-money-flow` | `CHAIKIN_OSCILLATOR` &rarr; `chaikin-oscillator` |
| `CHAIKIN_VOLATILITY` &rarr; `chaikin-volatility` | `CHANDELIER_EXIT` &rarr; `chandelier-exit` | `CHANDE_KROLL_STOP` &rarr; `chande-kroll-stop` |
| `CHANDE_MOMENTUM` &rarr; `chande-momentum` | `CHOPPINESS_INDEX` &rarr; `choppiness-index` | `CHOP_ZONE` &rarr; `chop-zone` |
| `CONNORS_RSI` &rarr; `connors-rsi` | `CONSOLIDATION_BREAKOUT` &rarr; `consolidation-breakout` | `COPPOCK_CURVE` &rarr; `coppock-curve` |
| `CPR` &rarr; `cpr` | `DEMA` &rarr; `dema` | `DONCHIAN` &rarr; `donchian` |
| `DPO` &rarr; `dpo` | `EASE_OF_MOVEMENT` &rarr; `ease-of-movement` | `ELDER_FORCE_INDEX` &rarr; `elder-force-index` |
| `EMA` &rarr; `ema` | `ENVELOPE` &rarr; `envelope` | `FISHER_TRANSFORM` &rarr; `fisher-transform` |
| `HALFTREND` &rarr; `halftrend` | `HISTORICAL_VOLATILITY` &rarr; `historical-volatility` | `HMA` &rarr; `hma` |
| `HULL_SUITE` &rarr; `hull-suite` | `ICHIMOKU` &rarr; `ichimoku` | `KAMA` &rarr; `kama` |
| `KELTNER_CHANNEL` &rarr; `keltner-channel` | `KLINGER_OSCILLATOR` &rarr; `klinger-oscillator` | `KNOW_SURE_THING` &rarr; `know-sure-thing` |
| `LINREG_SLOPE` &rarr; `linreg-slope` | `LSMA` &rarr; `lsma` | `MACD` &rarr; `macd` |
| `MASS_INDEX` &rarr; `mass-index` | `MA_CHANNEL` &rarr; `ma-channel` | `MA_CROSS` &rarr; `ma-cross` |
| `MA_RIBBON` &rarr; `ma-ribbon` | `MCGINLEY_DYNAMIC` &rarr; `mcginley-dynamic` | `MEDIAN` &rarr; `median` |
| `MFI` &rarr; `mfi` | `MOMENTUM` &rarr; `momentum` | `NET_VOLUME` &rarr; `net-volume` |
| `NVI` &rarr; `nvi` | `OBV` &rarr; `obv` | `PARABOLIC_SAR` &rarr; `parabolic-sar` |
| `PPO` &rarr; `ppo` | `PVI` &rarr; `pvi` | `PVO` &rarr; `pvo` |
| `PVT` &rarr; `pvt` | `RANGE_ANALYSIS` &rarr; `range-analysis` | `RELATIVE_VIGOR_INDEX` &rarr; `relative-vigor-index` |
| `RELATIVE_VOLATILITY_INDEX` &rarr; `relative-volatility-index` | `ROC` &rarr; `roc` | `RSI` &rarr; `rsi` |
| `RSI_DIVERGENCE` &rarr; `rsi-divergence` | `SEASONALITY` &rarr; `seasonality` | `SMA` &rarr; `sma` |
| `SMI` &rarr; `smi` | `SMI_ERGODIC_INDICATOR` &rarr; `smi-ergodic-indicator` | `SMI_ERGODIC_OSCILLATOR` &rarr; `smi-ergodic-oscillator` |
| `SMMA` &rarr; `smma` | `SPECIAL_K` &rarr; `special-k` | `STANDARD_DEVIATION` &rarr; `standard-deviation` |
| `STANDARD_ERROR` &rarr; `standard-error` | `STANDARD_ERROR_BANDS` &rarr; `standard-error-bands` | `STOCHASTIC` &rarr; `stochastic` |
| `STOCHASTIC_RSI` &rarr; `stochastic-rsi` | `SUPERTREND` &rarr; `supertrend` | `T3` &rarr; `t3` |
| `TEMA` &rarr; `tema` | `TREND_STRENGTH_INDEX` &rarr; `trend-strength-index` | `TRIX` &rarr; `trix` |
| `TSI` &rarr; `tsi` | `TWAP` &rarr; `twap` | `ULCER_INDEX` &rarr; `ulcer-index` |
| `ULTIMATE_OSCILLATOR` &rarr; `ultimate-oscillator` | `VOLATILITY_STOP` &rarr; `volatility-stop` | `VOLUME` &rarr; `volume` |
| `VORTEX` &rarr; `vortex` | `VWAP` &rarr; `vwap` | `VWMA` &rarr; `vwma` |
| `WAVETREND` &rarr; `wavetrend` | `WILLIAMS_FRACTALS` &rarr; `williams-fractals` | `WILLIAMS_PERCENT_R` &rarr; `williams-percent-r` |
| `WILLIAMS_VIX_FIX` &rarr; `williams-vix-fix` | `WMA` &rarr; `wma` | `WOODIES_CCI` &rarr; `woodies-cci` |

`INDICATORS_TIER` is the tier's identity constant (`'indicators'`), for feature
detection without a bare string.

## Calc helpers not covered above

All exported from `openalgo-charts/indicators`, all returning a full-length array:

```ts
highestBars(values, period)                  // bars since the period high
lowestBars(values, period)                   // bars since the period low
linreg(values, period, offset?)              // linear-regression value
percentRank(values, period)                  // rank of the current value in its window
percentileNearestRank(values, period, pct)   // nearest-rank percentile
swma(values)                                 // symmetric weighted moving average
```

`highestBars` and `lowestBars` answer *when*, not *what*: use them for "N bars since
the high", where `highest` / `lowest` give the value itself.

## Statistics with explicit missing-value policies

The indicator tier exports `NumericalWindowOptions` with
`missing?: 'propagate' | 'skip'`, and `RollingVarianceOptions`, which additionally
accepts `sample?: boolean`. These options belong to the helpers below; existing
helpers keep their established behavior.

| Helper | Result |
| --- | --- |
| `rollingMedian(values, period, options?)` | Sorted middle value, or average of the middle pair. |
| `rollingMode(values, period, options?)` | Most frequent value; ties choose the smallest. |
| `rollingVariance(values, period, options?)` | Population variance, or sample variance with `sample: true`. A one-value sample is undefined. |
| `rollingRange(values, period, options?)` | Maximum minus minimum. |
| `percentileLinear(values, period, percentage, options?)` | Linear interpolation at sorted rank `(period - 1) * percentage / 100`. |
| `rankCorrelation(values, period, options?)` | Rank correlation against chronological order, in -100..100 units; ties receive average ranks. Constant windows are undefined. |
| `centerOfGravity(values, period, options?)` | Negative weighted sum divided by sum, with weight 1 on newest and `period` on oldest. A zero denominator is undefined. |
| `runningMin(values, options?)` / `runningMax(values, options?)` | Extreme over all history through the current observation. |
| `crossesAbove(a, b, options?)` / `crossesBelow(a, b, options?)` / `crosses(a, b, options?)` | Strict crossing from an inclusive previous comparison; a previous equality qualifies, a current equality does not. |
| `rising(values, period, options?)` / `falling(values, period, options?)` | Current value strictly beyond every one of `period` prior values. Consecutive monotonic steps are not required. |

Results retain the input length and never mutate the arrays. Numeric warmup and
undefined statistics are `NaN`; boolean warmup is `false`. Periods must be positive
safe integers, percentages finite in 0..100, and crossing arrays equal in length.
Invalid numbers throw `RangeError`; invalid option values throw `TypeError`.

NaN and infinities count as missing. By default, rolling functions require a full
chronological window including the current bar. `{ missing: 'skip' }` instead uses
the last `period` finite observations and holds its result across missing bars.
Running extrema default to propagating any missing observation through the rest
of history; skip mode holds the last finite extreme. Crossings require two adjacent
finite pairs by default; skip mode compares the current pair with the latest jointly
finite pair. Rising and falling exclude the current bar from their history window.
All predicates return false when the current observation is missing.

## Numerical contract with the companion scripting language

The built-ins are compared cell by cell with the companion scripting language.
Thirteen differences are documented choices that stay as they are; the website
indicators page (Numerical contract) and `docs/reference-coverage/numerical-audit.md`
state each one with the studies and cells it affects. What a downstream author
needs from them:

- **Extremes skip a missing bar (K1).** `highest`, `lowest`, `highestBars` and
  `lowestBars` without options report the extreme of the present bars. Pass
  `{ missing: 'propagate' }` when a window with a gap must have no reading.
- **No volume is no trade (K2).** Every built-in reads an `undefined` volume as
  zero traded, and money-flow studies count a missing price as no flow.
- **CCI reads 0 on a flat window (K3)**, and only there: a window holding a
  missing bar or an overflowing deviation has no reading.
- **One bar early (K4):** Supertrend on its ATR seed bar, PVT on bar 0 and
  Choppiness from its first high-low range.
- **Last-bit only (K5, K6, K7):** host `Math.exp` and `Math.log` in ALMA,
  Choppiness and Fisher; percent Historical Volatility and per-bar scaled Ease
  of Movement; the one-step Aroon Oscillator.
- **Parabolic SAR (K8)** clamps its stop to the previous two bars and includes
  the reversal bar; the language stop is the unclamped recurrence.
- **Overflow (K9)** near 1.8e308 follows IEEE infinities; **negative zero (K10)**
  can appear in Chop Zone and Net Volume, so compare with `=== 0`.
- **Klinger (K11)** skips a bar with a `NaN` volume and reads `undefined` as
  zero.
- **RVI warmup (K12).** The Relative Volatility Index's two averages restart
  after every missing value until the standard deviation has its first reading,
  as they always have, so complete data reads unchanged at every Length. After
  that a missing close is held across. The language also holds a seed made
  inside the warmup, so above Length 16 its first reading can come earlier.
- **PVO signal (K13)** restarts after a stretch where the slow volume average
  is exactly 0 (the SMA oscillator over a window with no volume); the language
  would hold it.

A `NaN` volume has no single rule yet. It reads as zero (like `undefined`) in
Chaikin Money Flow, Chaikin Oscillator, Ease of Movement, Elder Force Index,
Net Volume, VWMA, MA Ribbon's VWMA lines, NVI, PVI, PVT, PVO, OBV (with its
smoothing and bands) and A/D; and as a missing bar that the study recovers from
in Volume, MFI, Klinger, AlphaTrend, the VWMA smoothing of CCI and RVI, and
VWAP with its bands, whose running totals leave that bar out. Map missing or
unparseable feed volume to `undefined` before it reaches the chart.

## Grouped descriptor exports

Three subsets are exported as arrays, for registering a family without naming each
member. They are already included in the tier's own registration.

| Export | Contents |
|---|---|
| `STUDY_INDICATORS` | `cpr`, `alphatrend`, `range-analysis` |
| `SEASONALITY_INDICATORS` | `seasonality` |
| `WAVETREND_INDICATORS` | `wavetrend` |

## Managed source status (2.1.6)

Base exports `ChartDataContext`, `IndicatorDataChange` and `IndicatorDataStatus`.
`ChartDataContext` has optional symbol/exchange/interval/hasOpenInterest; `IndicatorDataChange`
is context/range. `Tier2Context.dataContext` and `signal` are optional. A descriptor
may implement `supports(ctx)` to decline unavailable data before fetching.

Native request state also observes provider/source revisions, explicit external
invalidation and replay cutoff changes. History-only studies refresh same-time
tail revisions; live studies use subscription updates unless explicitly
invalidated. Native replay requires the capability and availability contract
above. Style-only updates retain fetched data. Removal aborts pending work.
`IndicatorApi.dataStatus()` returns null for ordinary indicators or a status with
loading/ready/empty/unsupported/error. Subscribe with `subscribeDataStatus`, release
the returned cleanup, and use `retryData()` for explicit retry. The chart bus emits
`indicator:data-status` with id, indicatorId and status. The widget displays it.

Custom attach hooks can use optional `dataContext()`, `subscribeDataChanges()`,
`setDataStatus()` and `setDataRetry()` from `IndicatorAttachContext`; the lifetime
signal is aborted on removal. Keep these optional for older synthetic hosts.

## Collapse indicator legends

```ts
chart.setIndicatorLegendCollapsed(true);
chart.indicatorLegendCollapsed(); // true
```

The constructor option `indicatorLegendCollapsed` defaults to `false`. Collapse
suppresses study legend rows and their hit areas across panes. The persistent
**Indicators N** control in the top visible pane expands them with a click or
touch. The count includes every applied study, including individually hidden
ones, and disappears when no studies remain. Expanded legends retain a control
for collapsing them again.

Plots, study visibility, calculations, live subscriptions and alerts stay active.
Host OHLC and custom legend rows retain their display. The count respects the
reserved `legendOffset` and follows the top visible pane when a pane is maximized.

Both hosts expose **Collapse indicator legends** in Readout settings for keyboard
access. The stable schema key is `statusLine.indicatorsCollapsed`. Native chart
state and portable workspaces retain this chart-local preference; study templates
do not replace it and appearance linking does not synchronize it.
