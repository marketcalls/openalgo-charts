# yfinance historical demo

Loads historical OHLCV from [yfinance](https://pypi.org/project/yfinance/) and
renders it with OpenAlgo Charts (candles + volume pane), showing how to wire any
OHLCV source through a custom `DataFeed`.

## Run

```bash
# 1. Build the library bundles (from the package root) — the demo imports /dist
npm run build

# 2. Install the one Python dep and start the demo server
cd examples/yfinance
pip install -r requirements.txt
python server.py            # → http://127.0.0.1:8000   (or: python server.py 8123)
```

Open **http://127.0.0.1:8000/examples/yfinance/index.html**, type a Yahoo Finance
symbol, pick an interval/range, and click **Load**.

Symbol examples: `AAPL`, `MSFT`, `RELIANCE.NS` (NSE), `^NSEI` (Nifty 50),
`BTC-USD` (crypto).

## How it connects

```
yfinance (Python)  ──►  server.py /api/history  ──►  YFinanceDataFeed.getBars()  ──►  series.setData()
```

- `server.py` serves the package root statically **and** answers
  `GET /api/history?symbol=&interval=&period=`, mapping the yfinance DataFrame to
  the chart's `Bar` shape (`{ time: <UTC seconds>, open, high, low, close, volume }`).
- `index.html` defines a tiny `YFinanceDataFeed` implementing `getBars()` — the
  same broker-agnostic `DataFeed` interface the OpenAlgo adapter uses. Swapping
  data sources is just a different `getBars()`.

## Notes

- Intraday intervals (`1m`–`90m`, `1h`) are limited by Yahoo to recent history
  (≈7–60 days); daily/weekly go back years. Pick a compatible interval + range.
- Times are converted to **UTC seconds** internally; the chart renders a gapless
  axis (weekends/holidays collapse) and formats labels in IST by default.
- yfinance is unofficial and rate-limited — for production use OpenAlgo's own
  `/api/v1/history` via `OpenAlgoDataFeed`.
