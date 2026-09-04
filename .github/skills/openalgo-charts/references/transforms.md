# Transforms

*When to read this: you need a movement-driven series (Heikin Ashi, Renko, Range, Line Break, Point & Figure, Kagi) instead of a time-bucketed one, or you are debugging why a transformed chart renders scattered or why an indicator on one looks wrong.*

## Import rule

```ts
import { runTransform, RenkoTransform } from 'openalgo-charts/transform';
```

Importing the tier registers the `'point-figure'` and `'kagi'` chart types as a side effect (`registerTransformChartTypes()`, exported and idempotent for bundlers that tree-shake a bare side-effect import). Heikin Ashi, Renko, Range, and Line Break need no registration, they render as `'candlestick'`.

The tier imports `registerChartType` from `'openalgo-charts'`, never a deep path: a deep import inlines a second copy of the chart-type registry and `createChart` never sees the renderers. Same rule as the indicator tier, see [bundling-and-tiers](./bundling-and-tiers.md).

## The pipeline

```ts
interface ISeriesTransform {
  reset(): void;              // start of a fresh batch
  push(bar: Bar): Bar[];      // 0..n newly completed derived elements
  flush?(): Bar[];            // optional in-progress element at end of data
}

runTransform(transform, bars): Bar[]   // reset -> push each -> flush -> ensureIncreasingTimes
```

`ensureIncreasingTimes(bars)` bumps any colliding timestamp by `+1` second. Several elements can complete inside one source bar; without distinct times the DataLayer collapses them onto one logical index. `runTransform` applies it for you, call it directly only when assembling batches by hand.

Every transform is incremental: `push` is streaming, so live ticks extend the series without recomputing history.

## The six transforms

| Class | Options (defaults) | Emits | Plot as |
|---|---|---|---|
| `HeikinAshiTransform` | none (no constructor arg) | 1 bar per input bar, real times, `volume` carried through | `'candlestick'` |
| `RenkoTransform` | `{ boxSize: number }` required, must be `> 0` | one brick per full box move of the close; up brick `close > open`, down brick `close < open`; no `volume` | `'candlestick'` |
| `RangeBarsTransform` | `{ range: number }` required, must be `> 0` | a bar per `high - low >= range`, built from the close sequence; the partial bar comes out of `flush()` | `'candlestick'` |
| `LineBreakTransform` | `{ lines: number }`, constructor defaults to `{ lines: 3 }`, clamped to `>= 1` | a line only when the close breaks the extreme of the prior N lines; no `flush` | `'candlestick'` |
| `PointFigureTransform` | see below | `PointFigureColumn` (a `Bar` plus `boxSize` and `boxes`) | `'point-figure'` |
| `KagiTransform` | `{ reversal: number }` required, must be `> 0` | one vertex `Bar` per turning point; `volume` encodes thickness (`1` thick/yang, `0` thin/yin); `flush()` emits the live vertex with `time: 0` | `'kagi'` |

```ts
const bricks = runTransform(new RenkoTransform({ boxSize: 5 }), bars);
chart.addSeries('candlestick').setData(bricks);
```

`RenkoTransform`, `RangeBarsTransform`, `KagiTransform`, and `PointFigureTransform` in `fixed`/`percent` mode **throw** on an unusable option, so validate user input before constructing. Renko is a simplified single-box step (no 2x reversal rule) so it stays deterministic and incremental.

### Construction details worth knowing

- Heikin Ashi: `haClose = (o+h+l+c)/4`; `haOpen` is `(o+c)/2` on the first bar and `(prevHaOpen + prevHaClose)/2` after; `haHigh`/`haLow` are the max/min of the real extreme and the two HA prices. It is the only transform that is 1:1 with the input and keeps real times.
- **The first source bar of Renko, Line Break, Kagi, and P&F produces nothing**: it only anchors state (Renko snaps to `floor(close / boxSize) * boxSize`). Expect a shorter output array than a naive box-count estimate, and expect an empty array from a one-bar input.
- Range bars carry the *latest* contributing bar's time, not the opening bar's.
- Line Break opens each new box at the previous line's `close`, so the boxes chain without gaps.
- P&F establishes direction on the first real move, with an outside-bar tie resolving up, and re-derives the column boundary under the new box size on every reversal (which is why `percent`/`atr` modes stay aligned).
- Kagi turns thick when the line exceeds the previous up-turn (shoulder) and thin when it falls below the previous down-turn (waist).

## Live updates

Keep one transform instance alive across the stream rather than re-running `runTransform` over the whole history per tick:

```ts
const t = new RenkoTransform({ boxSize: 5 });
const series = chart.addSeries('candlestick');
series.setData(runTransform(t, history));   // runTransform calls reset() first

feed.onBar((bar) => {
  for (const brick of t.push(bar)) series.update(brick); // update-or-append
});
```

**`runTransform` calls `reset()`, so never mix a batch run and a streaming instance.** Use one instance for history and then keep pushing into it, or reset and rebuild, not both.

**`ensureIncreasingTimes` runs only inside `runTransform`.** Elements pushed live can share a timestamp with each other or with the last historical element; de-duplicate before `update` (bump by `+1`s, the same rule) or they collapse onto one logical index.

### Point & Figure options

| Option | Type | Default | Notes |
|---|---|---|---|
| `boxSize` | `number` | none | Required for `mode: 'fixed'`; throws if not `> 0`. |
| `reversal` | `number` | `3` | Boxes of counter-move needed to open a new column. Floored, min 1. |
| `method` | `'hl' \| 'close'` | `'hl'` | `'hl'` extends X columns from each bar's high and O columns from its low, what P&F means on a desk. `'close'` ignores intrabar range entirely. |
| `mode` | `'fixed' \| 'percent' \| 'atr'` | `'fixed'` | How the box is resolved, re-evaluated each time a column opens. |
| `percent` | `number` | none | For `mode: 'percent'`; `0.5` means 0.5% of price. Throws if not `> 0`. |
| `atrPeriod` | `number` | `14` | Wilder ATR lookback for `mode: 'atr'`. |
| `atrMultiplier` | `number` | `1` | ATR multiplier for `mode: 'atr'`. |

`PointFigureColumn` extends `Bar` with `boxSize` (price height of one glyph) and `boxes` (glyph count). `low` is the bottom edge of the lowest box and `high` is the **exclusive top edge** of the highest, so `[low, high)` is exactly the glyph stack's span and `boxes === (high - low) / boxSize`. Up column (X) is `close >= open`. The renderer reads `boxSize` off the column, so variable-box modes render correctly; `style.boxSize` remains a fallback only for hand-built data. Renderer style keys: `upColor` (`#26a69a`), `downColor` (`#ef5350`). Kagi style keys: `thickColor` (`#26a69a`), `thinColor` (`#ef5350`).

## Two rendering paths, not one

**Heikin Ashi / Renko / Range / Line Break produce ordinary bars, feed them to `addSeries('candlestick')`.** Nothing new is registered for them; they are a different array of `Bar`, not a different renderer.

**Point & Figure and Kagi require their tier-registered renderers.** `chart.addSeries('point-figure')` or `chart.addSeries('kagi')` throws if the tier was never imported (or was tree-shaken without calling `registerTransformChartTypes()`). Their emitted bars are not candles: a P&F column is a glyph stack derived from `boxSize`/`boxes`, and a Kagi bar is a single-price vertex whose `volume` is a thickness flag, so drawing either as a candlestick is meaningless.

## Transformed series and real time

A transformed series is indexed by **element**, not by clock. Every element carries its source formation time as a label only, and `ensureIncreasingTimes` may have shifted that time by seconds. Consequences:

- **Every series on a chart shares one time axis.** A transform emits fewer elements than the raw bars, so feeding a companion series (typically a volume pane) the *raw* bars puts all the raw timestamps back onto the shared axis and the bricks render scattered with gaps. Re-bucket companion series onto the transformed times, sum the raw volume behind each element, keyed by `element.time`.
- **Indicators on a transformed series measure elements, not bars.** `chart.addIndicator('rsi')` computes over whatever the primary price series holds, so on Renko an "RSI(14)" is 14 *bricks*, an interval that varies in wall-clock length. Renko, Line Break, and P&F drop `volume` entirely, so `volume`, `obv`, `adl`, `mfi`, and `vwap` read zero or produce nothing. VWAP's session anchor is also meaningless once times are synthetic, whatever zone the chart is on.
- **Drawings anchored in time drift.** A trendline placed on a transformed series is pinned to element positions on the shared axis; the same coordinates over the raw bars land somewhere else. Do not switch a chart between raw and transformed data while keeping drawings and expect them to hold.
- `flush()` output is provisional. `RangeBarsTransform` and `PointFigureTransform` emit an in-progress element and `KagiTransform` emits a live vertex, those change as more data arrives, unlike completed elements, which are stable (an incremental run's prefix equals a batch run's prefix).

Related: [chart-types](./chart-types.md), [data-and-time](./data-and-time.md), [indicators](./indicators.md), [drawing-tools](./drawing-tools.md), [bundling-and-tiers](./bundling-and-tiers.md), [pitfalls](./pitfalls.md).
