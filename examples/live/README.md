# OpenAlgo LIVE demo — history + WebSocket

Streams a real OpenAlgo instance into the chart: historical candles over REST
(`/api/v1/history`) plus live updates over the OpenAlgo WebSocket proxy
(LTP → `CandleBuilder` → forming candle + a live LTP line).

It uses the library's real adapters unchanged: `OpenAlgoDataFeed` (history),
`OpenAlgoWsFeed` (live), and `CandleBuilder` (tick → interval bar).

## Run

1. Have OpenAlgo running locally — REST on `http://127.0.0.1:5000`, WS proxy on
   `ws://127.0.0.1:8765` (the defaults).
2. Start this demo's server (it serves the package + proxies REST so the browser
   isn't blocked by CORS — OpenAlgo sends no `Access-Control-Allow-*` headers):

   ```bash
   python examples/live/server.py            # http://127.0.0.1:8001
   # custom OpenAlgo host:
   OPENALGO_HOST=http://127.0.0.1:5000 python examples/live/server.py
   ```

3. Open `http://127.0.0.1:8001/examples/live/index.html`, paste your **API key**,
   pick symbol / exchange / interval, and click **Connect**.

The toolbar shows `WS live`, a running tick count, and the live LTP; intraday
intervals (1m/5m/15m/1h) aggregate LTP ticks into the forming candle, while `D`
shows the daily history with a moving LTP line.

Like OpenAlgo's `/scalping` chart, a staggered **reconcile loop** re-fetches
history every 20–30s and snaps **completed** bars to the broker's official
OHLC + volume (it never touches the live forming bar). Live OHLC uses **LTP**
mode (reliable across brokers); the forming bar's volume fills in when it
completes and the reconcile corrects it. (Quote-mode live volume exists in the
adapter but is broker-dependent — some brokers return `subscribe partial`.)

## Notes

- **Your API key is never stored in this repo.** It is entered in the page, saved
  only to the browser's `localStorage`, and forwarded in the request body by the
  local proxy. The WebSocket authenticates with it directly from the browser.
- **Live ticks only flow during market hours** — outside them the history loads
  and the WS subscribes, but no `market_data` arrives.
- REST is proxied (same origin); the WebSocket connects straight to OpenAlgo
  (WS upgrades aren't subject to the CORS preflight that blocks REST).
- Validated against a live instance: history returns real bars and the WS streams
  `{type:'market_data', data:{ltp, timestamp}}` ticks that the adapter maps directly.
