# Guides

## Chart types

Every chart type is a registry descriptor — `addSeries(type)` selects it:

```ts
chart.addSeries('candlestick'); // or: hollow-candle, volume-candle, bar, high-low,
                                // line, line-markers, step, area, hlc-area, baseline, column
```

Family-B (price-driven) types come from the transform tier — run a transform,
then plot the result:

```ts
import { runTransform, RenkoTransform } from 'openalgo-charts/transform';
const bricks = runTransform(new RenkoTransform({ boxSize: 5 }), bars);
chart.addSeries('candlestick').setData(bricks); // Renko renders as candles
```

Point &amp; Figure and Kagi have dedicated renderers registered when you import the
transform tier:

```ts
import { runTransform, PointFigureTransform } from 'openalgo-charts/transform';
const cols = runTransform(new PointFigureTransform({ boxSize: 1, reversal: 3 }), bars);
chart.addSeries('point-figure', { style: { boxSize: 1 } }).setData(cols);
```

## Multi-pane (volume / indicators)

```ts
chart.addSeries('histogram', { paneIndex: 1 }).setData(volumeBars);
```

Panes share one time axis, so they stay perfectly aligned bar-for-bar.

## Markers, events, indicators

```ts
const markers = series.createMarkers();
markers.setMarkers([{ time, position: 'belowBar', shape: 'arrowUp', size: 'medium', color: '#26a69a', text: 'BUY' }]);

chart.addEventMarkers().setEvents([{ time, type: 'earnings', label: 'E' }]);

import { emaSeries } from 'openalgo-charts';
chart.addSeries('line', { style: { color: '#f0a020' } }).setData(emaSeries(bars, 21));
```

## Chart trading

```ts
import { OrderEngine } from 'openalgo-charts/trade';

const eng = new OrderEngine({ feed, constraints: { tickSize: 0.05, priceBand, freezeQty },
  armed: false, gate: (req) => confirm(`Place ${req.side} ${req.qty}?`), mode: 'analyzer' });

await eng.placeMarket('RELIANCE', 'BUY', 10);     // one-click
chart.subscribeDrag((id, price) => eng.requestModify(clientId(id), price),
                    (id, price) => eng.commitModify(clientId(id))); // drag-to-modify
```

The engine enforces tick-size snapping, price-band/freeze validation,
client-token idempotency, OCO (one fill cancels the peer), reconnect→stale, and
an arm/confirm gate. Use `analyzer` mode to route to a sandbox.

## Profiles &amp; order flow

```ts
import { computeVolumeProfile, HorizontalProfile } from 'openalgo-charts/profile';
const vp = computeVolumeProfile(bars, 0.05, 0.7);
chart.addPrimitive(new HorizontalProfile({ buckets: vp.buckets, poc: vp.poc, vah: vp.vah, val: vp.val, width: 140, side: 'right', barColor: '#345', vaColor: '#456' }));
```

Footprint / order flow need classified trade data (bid vs ask) — see the
data-dependency note in `footprint.ts`.

## Writing a custom chart style

```ts
import { registerChartType } from 'openalgo-charts';
registerChartType('my-style', {
  defaultStyle: { color: '#fff' },
  isPriceSeries: true,
  draw: (ctx, items, toY, barSpacing, dpr, style) => { /* … */ },
  extents: (bar) => ({ min: bar.low, max: bar.high }),
});
```

## Writing a custom primitive

Implement `IPrimitive` (`zOrder`, `draw`, optional `hitTest` / `autoscaleInfo` /
lifecycle) and attach it with `chart.addPrimitive(primitive, paneIndex)`. This
is the same API the trade layer, markers, and profiles are built on.

## Performance

Enable conflation for very large, zoomed-out datasets:

```ts
createChart(el, { conflate: true, conflationFactor: 1 });
```

Bars below ~0.5px are merged OHLC-preserving (open=first, close=last, high=max,
low=min, volume=sum) — never a lossy average.
