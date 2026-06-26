#!/usr/bin/env python3
"""Tiny dependency-light server for the yfinance demo.

Serves the openalgo-charts package root statically AND exposes a JSON history
endpoint backed by yfinance, so the browser demo and its data come from one
origin (no CORS hassles).

Usage:
    pip install -r requirements.txt
    python server.py            # serves on http://127.0.0.1:8000
    python server.py 8123       # custom port

Then open:  http://127.0.0.1:8000/examples/yfinance/index.html

History endpoint:
    GET /api/history?symbol=AAPL&interval=1d&period=1y
Returns Bar JSON the chart consumes directly:
    [{ "time": <utc_seconds>, "open", "high", "low", "close", "volume" }, ...]
"""
import json
import os
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Package root (two levels up from examples/yfinance/), so /dist and /examples resolve.
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def fetch_bars(symbol: str, interval: str, period: str):
    """Fetch OHLCV from yfinance and map to the chart's Bar shape (UTC seconds)."""
    import yfinance as yf  # imported lazily so static serving works without it

    df = yf.Ticker(symbol).history(period=period, interval=interval)
    bars = []
    for idx, row in df.iterrows():
        # idx is a (tz-aware) Timestamp; .timestamp() yields UTC epoch seconds.
        bars.append(
            {
                "time": int(idx.timestamp()),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": int(row["Volume"]) if not _isnan(row["Volume"]) else 0,
            }
        )
    return bars


def _isnan(v) -> bool:
    try:
        return v != v
    except Exception:
        return False


class Handler(SimpleHTTPRequestHandler):
    # Serve ES modules with a JS MIME type — browsers reject `text/plain` modules
    # under strict MIME checking, which would block `import ... from '.mjs'`.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "application/javascript",
        ".js": "application/javascript",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):  # noqa: N802 (stdlib naming)
        parsed = urlparse(self.path)
        if parsed.path == "/api/history":
            return self._history(parse_qs(parsed.query))
        return super().do_GET()

    def _history(self, q):
        symbol = q.get("symbol", ["AAPL"])[0]
        interval = q.get("interval", ["1d"])[0]
        period = q.get("period", ["1y"])[0]
        try:
            bars = fetch_bars(symbol, interval, period)
            self._json(200, bars)
        except ModuleNotFoundError:
            self._json(500, {"error": "yfinance not installed — run: pip install -r requirements.txt"})
        except Exception as e:  # noqa: BLE001 — surface any fetch error to the browser
            self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"openalgo-charts yfinance demo -> http://127.0.0.1:{port}/examples/yfinance/index.html")
    print(f"serving package root: {ROOT}")
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
