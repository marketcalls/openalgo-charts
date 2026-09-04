# Getting started

OpenAlgo Charts is a dependency-free, canvas-based financial charting engine.
The base engine is **66.42 KB Brotli**; the full package (all eight tiers) is **182.37 KB Brotli**, measured with `size-limit` on the 2.0.1 build.

## Install

```bash
npm install openalgo-charts
```

## A chart in ~10 lines

```ts
import { createChart } from 'openalgo-charts';

const chart = createChart(document.getElementById('chart'));
const series = chart.addSeries('candlestick');
series.setData([
  { time: 1705286700, open: 100, high: 101, low: 99.5, close: 100.6, volume: 1200 },
  { time: 1705286760, open: 100.6, high: 101.4, low: 100.2, close: 101.1, volume: 900 },
  // ...
]);
```

Time is **UTC seconds** internally. Feed adapters convert broker formats at the
edge (IST date strings, epoch milliseconds); see the OpenAlgo adapter below.

## Live updates

```ts
import { CandleBuilder } from 'openalgo-charts';

const builder = new CandleBuilder({ intervalSec: 60, volumeMode: 'ltq-sum' });
builder.seed(lastHistoricalBar);

ws.onTick(({ price, ltq, timeSec }) => {
  const u = builder.onTick({ time: timeSec, price, ltq });
  if (u) series.update(u.bar); // mutates the last candle or appends a new one
});
```

## Loadable tiers

Only pay for what you use: each tier is a separate entry point.

| Import | Contents |
|---|---|
| `openalgo-charts` | base engine + all standard chart types + markers/events/EMA |
| `openalgo-charts/trade` | order/position/bracket lines, DOM ladder, order engine |
| `openalgo-charts/transform` | Renko, Range, Point &amp; Figure, Kagi, Line Break, Heikin Ashi |
| `openalgo-charts/profile` | Volume Profile, Market Profile (TPO), Footprint, order flow |
| `openalgo-charts/indicators` | 102 built-in indicators (SMA/EMA/MACD/Bollinger/RSI/ADX/...) + the Tier-2 contract |
| `openalgo-charts/draw` | 51 drawing tools + a headless drawing controller |
| `openalgo-charts/webgl` | the WebGL2 series backend behind `renderer: 'auto'` |
| `openalgo-charts/widget` | the chart with its chrome in one `createWidget` call: top bar, drawing rail, status line, dialogs, shortcuts, persistence. The only tier that ships DOM |

## OpenAlgo data

```ts
import { OpenAlgoDataFeed } from 'openalgo-charts';

const feed = new OpenAlgoDataFeed({ baseUrl: 'http://127.0.0.1:5000', apiKey: 'YOUR_KEY' });
// from/to are UTC seconds; the adapter converts them to IST YYYY-MM-DD for OpenAlgo.
const day = 86400;
const bars = await feed.getBars({
  symbol: 'RELIANCE', exchange: 'NSE', interval: '1m',
  from: Math.floor(Date.now() / 1000) - 7 * day, to: Math.floor(Date.now() / 1000),
});
series.setData(bars);
```

Live LTP / Quote / Depth come from the WS adapter. Feed its LTP ticks through a
`CandleBuilder` and call `series.update()`:

```ts
import { OpenAlgoWsFeed, CandleBuilder } from 'openalgo-charts';
const ws = new OpenAlgoWsFeed({ url: 'ws://127.0.0.1:8765', apiKey: 'YOUR_KEY' });
const builder = new CandleBuilder({ intervalSec: 60, volumeMode: 'ltq-sum' });
ws.connect();
ws.onLtp((e) => { const u = builder.onTick({ time: e.timeSec, price: e.ltp, ltq: e.ltq }); if (u) series.update(u.bar); });
ws.subscribe('LTP', 'RELIANCE', 'NSE');
```

The chart depends only on the `DataFeed` / `TradeFeed` interfaces, so any broker
can be wired with a small adapter. Verify the exact REST paths against your
running OpenAlgo build before production use.

See [guides.md](./guides.md) for chart types, trading, profiles, and writing
custom chart styles / primitives, [widget.md](./widget.md) for the one-call terminal,
and [migrating-to-2.md](./migrating-to-2.md) if you are coming from 1.9.x. Runnable
demos live in [`../examples`](../examples/index.html).
