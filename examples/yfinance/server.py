#!/usr/bin/env python3
"""Dependency-light server for the yfinance demo.

Serves the package root statically and answers a JSON history endpoint, so
the browser demo and its data come from one origin and there is no CORS to
configure.

Usage:
    pip install -r requirements.txt
    python server.py                    # http://127.0.0.1:8000
    python server.py --port 8123        # another port (a bare 8123 works too)
    python server.py --fixture          # synthetic bars: no yfinance, no network
    python server.py --self-test        # run the built-in checks and exit

Then open:  http://127.0.0.1:8000/examples/yfinance/index.html

History endpoint:
    GET /api/history?symbol=AAPL&interval=1d&period=1y
    GET /api/history?symbol=AAPL&interval=5m&from=<utc_seconds>&to=<utc_seconds>
A success is the Bar array the chart consumes directly:
    [{ "time": <utc_seconds>, "open", "high", "low", "close", "volume" }, ...]
A failure is { "error": <message>, "code": <token> } with the matching status:
    400 bad_symbol, bad_interval, bad_period, bad_range
    404 no_data (the source has no bars for that ask), not_found (no such endpoint)
    429 rate_limited (the source is throttling; Retry-After says when to retry)
    502 upstream_error (the source failed)
    503 not_installed (yfinance is missing and --fixture was not given)

Only the standard library and yfinance are used, and yfinance is imported on
the first real request, so static serving and --fixture work without it.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import re
import signal
import sys
import threading
import time
import traceback
import unittest
import zlib
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# Package root (two levels up from examples/yfinance/), so /dist and /examples resolve.
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# ── the contract ──────────────────────────────────────────────────────────
# A ticker as the source spells it: letters and digits, a venue suffix
# (RELIANCE.NS), a pair (BTC-USD), a future or a rate (GC=F, EURUSD=X), and an
# index (^NSEI). Nothing else, and never long enough to be a sentence: the
# symbol is echoed back in error messages and goes into a request URL.
SYMBOL_RE = re.compile(r"^\^?[A-Za-z0-9][A-Za-z0-9.\-=]{0,23}$")
SYMBOL_RULE = "a symbol is 1 to 24 letters, digits, '.', '-' or '=', with an optional leading '^'"

# The interval tokens the source accepts, with the longest a bar of each can
# last. The calendar ones are upper bounds on purpose: they only decide when
# a pinned range can no longer change, and a bound that is too generous just
# delays the immutable header, never serves a forming bar as closed.
INTERVALS = {
    "1m": 60, "2m": 120, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600, "90m": 5400,
    "1h": 3600, "1d": 86400, "5d": 5 * 86400, "1wk": 7 * 86400, "1mo": 31 * 86400, "3mo": 92 * 86400,
}
INTRADAY = {"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h"}
# Period tokens and their length in days. `ytd` and `max` have no fixed
# length and are resolved against the end of the window when one is needed.
PERIOD_DAYS = {
    "1d": 1, "5d": 5, "1mo": 31, "3mo": 92, "6mo": 186, "1y": 366, "2y": 731,
    "5y": 1830, "10y": 3653, "ytd": None, "max": None,
}
# How far back the source will serve each intraday interval. The fixture
# clamps to the same limits so an offline run has the same shape as a live
# one, where an over-long ask comes back empty.
INTRADAY_MAX_DAYS = {"1m": 7, "2m": 60, "5m": 60, "15m": 60, "30m": 60, "60m": 730, "90m": 60, "1h": 730}
FIXTURE_MAX_DAYS = 20 * 366
# A timestamp past this is not a time anyone can chart, it is a typo or a
# millisecond value; refusing it early keeps the source from being asked for
# a window in the year 50000.
MAX_EPOCH = 4102444800  # 2100-01-01

# A range that ends in the past and whose last possible bar has closed cannot
# change, so the browser may keep it for as long as it likes. Everything
# else contains, or could grow, a forming bar, and a cache that serves a stale
# forming bar is worse than no cache at all: it gets a few seconds, enough to
# fold the double fetch a linked second chart makes into one.
LIVE_CACHE = "private, max-age=5"
CLOSED_CACHE = "public, max-age=31536000, immutable"
GZIP_MIN_BYTES = 512


class ApiError(Exception):
    """A failure the client is told about as JSON, with the status it deserves."""

    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or {}


class HistoryRequest:
    """A validated /api/history ask. `start` and `end` are UTC seconds or None."""

    def __init__(self, symbol: str, interval: str, period: str, start: int | None, end: int | None):
        self.symbol = symbol
        self.interval = interval
        self.period = period
        self.start = start
        self.end = end

    def describe(self) -> str:
        if self.start is not None or self.end is not None:
            return f"{self.interval} bars of {self.symbol} between {self.start or 'the start'} and {self.end or 'now'}"
        return f"{self.interval} bars of {self.symbol} over {self.period}"


def _first(q: dict, key: str) -> str | None:
    values = q.get(key)
    return values[0] if values else None


def _epoch_param(q: dict, key: str) -> int | None:
    raw = _first(q, key)
    if raw is None or raw == "":
        return None
    if not re.fullmatch(r"[0-9]{1,10}", raw):
        raise ApiError(400, "bad_range", f"{key} must be UTC seconds, got {raw!r}")
    value = int(raw)
    if value <= 0 or value >= MAX_EPOCH:
        raise ApiError(400, "bad_range", f"{key} must be UTC seconds before the year 2100, got {raw!r}")
    return value


def parse_history_query(q: dict) -> HistoryRequest:
    """Turn a parsed query string into a request, or raise a 400 that says why."""
    symbol = (_first(q, "symbol") or "").strip()
    if not symbol:
        raise ApiError(400, "bad_symbol", "symbol is required: " + SYMBOL_RULE)
    if not SYMBOL_RE.match(symbol):
        raise ApiError(400, "bad_symbol", f"symbol {symbol[:40]!r} is not valid: " + SYMBOL_RULE)
    interval = _first(q, "interval") or "1d"
    if interval not in INTERVALS:
        raise ApiError(400, "bad_interval", f"interval {interval[:20]!r} is not one of " + ", ".join(INTERVALS))
    period = _first(q, "period") or "1y"
    if period not in PERIOD_DAYS:
        raise ApiError(400, "bad_period", f"period {period[:20]!r} is not one of " + ", ".join(PERIOD_DAYS))
    start = _epoch_param(q, "from")
    end = _epoch_param(q, "to")
    if start is not None and end is not None and start >= end:
        raise ApiError(400, "bad_range", f"from ({start}) must be before to ({end})")
    return HistoryRequest(symbol, interval, period, start, end)


def period_days(period: str, at: int) -> int | None:
    """Days a period covers ending at `at`; None when the source decides (max)."""
    if period == "ytd":
        jan1 = datetime(datetime.fromtimestamp(at, tz=timezone.utc).year, 1, 1, tzinfo=timezone.utc)
        return max(1, math.ceil((at - jan1.timestamp()) / 86400))
    return PERIOD_DAYS[period]


def cache_control_for(req: HistoryRequest, now: int) -> str:
    """The rule from the top of the file: immutable only for a pinned, closed range."""
    if req.end is not None and now >= req.end + INTERVALS[req.interval]:
        return CLOSED_CACHE
    return LIVE_CACHE


# ── the live source ───────────────────────────────────────────────────────

def upstream_error(exc: Exception) -> ApiError:
    """Map whatever the source threw onto a status, without the traceback."""
    name = type(exc).__name__
    text = str(exc).replace("\n", " ").strip()
    if "RateLimit" in name or "Too Many Requests" in text or " 429" in text:
        return ApiError(429, "rate_limited", "the data source is rate limiting this address; try again in a minute",
                        {"Retry-After": "60"})
    return ApiError(502, "upstream_error", f"{name}: {text[:300]}" if text else name)


def yfinance_bars(req: HistoryRequest, now: int) -> list:
    """Fetch OHLCV from yfinance and map it to the chart's Bar shape (UTC seconds)."""
    try:
        import yfinance as yf  # imported lazily so static serving works without it
    except ModuleNotFoundError:
        raise ApiError(503, "not_installed",
                       "yfinance is not installed: pip install -r requirements.txt, or start with --fixture") from None
    try:
        ticker = yf.Ticker(req.symbol)
        if req.start is None and req.end is None:
            df = ticker.history(period=req.period, interval=req.interval)
        else:
            # A pinned window. The source ignores `end` when a period is given,
            # so the period is turned into a start here; `max` leaves the start
            # to the source's own default.
            end = req.end if req.end is not None else now
            start = req.start
            if start is None:
                days = period_days(req.period, end)
                start = None if days is None else end - days * 86400
            df = ticker.history(
                start=None if start is None else datetime.fromtimestamp(start, tz=timezone.utc),
                end=datetime.fromtimestamp(end, tz=timezone.utc),
                interval=req.interval,
            )
    except Exception as exc:  # noqa: BLE001 (the source's failures all become one status)
        raise upstream_error(exc) from None
    return frame_to_bars(df)


def frame_to_bars(df) -> list:
    bars = []
    for idx, row in df.iterrows():
        # idx is a (tz-aware) Timestamp; .timestamp() yields UTC epoch seconds.
        # A row with no price is not a bar. yfinance emits them for suspensions
        # and some holidays (RELIANCE.NS over a year has four), and json.dumps
        # writes a bare NaN, which is not valid JSON: the browser then fails to
        # parse the whole response and the symbol looks broken rather than
        # gappy. Volume was already guarded here; OHLC was not.
        if any(_isnan(row[c]) for c in ("Open", "High", "Low", "Close")):
            continue
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


# ── the fixture source ────────────────────────────────────────────────────
# Deterministic synthetic bars for any symbol, so the demo runs with no
# network and no yfinance, and a test can assert on what it sees. Every value
# is a pure function of (symbol, bar time): the same URL answers with the same
# bytes from any machine on any day, as long as the window is pinned with
# `to`. Three symbols are reserved so the error paths can be exercised too.
FIXTURE_SENTINELS = {
    "FAIL": ApiError(502, "upstream_error", "fixture: FAIL always fails upstream"),
    "EMPTY": ApiError(404, "no_data", "fixture: EMPTY has no bars"),
    "BUSY": ApiError(429, "rate_limited", "fixture: BUSY is always rate limited", {"Retry-After": "30"}),
}
# Bars sit in a 09:15 to 15:30 IST session, spelled in UTC. IST is this
# library's default zone and has no daylight saving, so the window is the
# same number every day of the year.
SESSION_OPEN = 3 * 3600 + 45 * 60
SESSION_CLOSE = 10 * 3600
DAY = 86400


def _weekday(t: int) -> int:
    # 1970-01-01 was a Thursday; Monday is 0 to match datetime.weekday().
    return ((t // DAY) + 3) % 7


def _month_start(year: int, month: int) -> int:
    return int(datetime(year, month, 1, tzinfo=timezone.utc).timestamp())


def fixture_grid(interval: str, start: int, end: int) -> list:
    """Ascending bar start times in [start, end) on the interval's calendar."""
    out = []
    if interval in INTRADAY:
        step = INTERVALS[interval]
        day = (start // DAY) * DAY
        while day < end:
            if _weekday(day) < 5:
                t = day + SESSION_OPEN
                while t < day + SESSION_CLOSE and t < end:
                    if t >= start:
                        out.append(t)
                    t += step
            day += DAY
    elif interval == "1d":
        day = (start // DAY) * DAY
        while day + SESSION_OPEN < end:
            t = day + SESSION_OPEN
            if t >= start and _weekday(day) < 5:
                out.append(t)
            day += DAY
    elif interval in ("5d", "1wk"):
        day = (start // DAY) * DAY
        while day + SESSION_OPEN < end:
            t = day + SESSION_OPEN
            if t >= start and _weekday(day) == 0:
                out.append(t)
            day += DAY
    else:
        months = 1 if interval == "1mo" else 3
        d = datetime.fromtimestamp(start, tz=timezone.utc)
        year, month = d.year, ((d.month - 1) // months) * months + 1
        while True:
            t = _month_start(year, month) + SESSION_OPEN
            if t >= end:
                break
            if t >= start:
                out.append(t)
            month += months
            if month > 12:
                month -= 12
                year += 1
    return out


def _noise(symbol: str, t: int, salt: str) -> float:
    """A stable number in [0, 1) for one bar of one symbol. crc32, not hash(): hash() is salted per process."""
    return (zlib.crc32(f"{symbol}|{t}|{salt}".encode()) & 0xFFFFFFFF) / 2 ** 32


def fixture_level(symbol: str, t: int) -> float:
    """The synthetic close at time t: a base per symbol, a slow drift and three waves whose periods the symbol picks."""
    seed = zlib.crc32(symbol.encode()) & 0xFFFFFFFF
    base = 20 + seed % 2000
    slow = DAY * (40 + seed % 50)
    mid = DAY * (7 + (seed >> 8) % 20)
    fast = 3600 * (3 + (seed >> 16) % 30)
    phase = ((seed >> 4) % 628) / 100
    years = (t - 1_600_000_000) / 31_557_600
    drift = years * 0.02 * (seed % 7 - 3)
    wave = 0.12 * math.sin(2 * math.pi * t / slow + phase) \
        + 0.05 * math.sin(2 * math.pi * t / mid + 2 * phase) \
        + 0.02 * math.sin(2 * math.pi * t / fast + 3 * phase)
    jitter = (_noise(symbol, t, "c") - 0.5) * 0.01
    return base * math.exp(drift + wave + jitter)


def fixture_bars(req: HistoryRequest, now: int) -> list:
    symbol = req.symbol.upper()
    if symbol in FIXTURE_SENTINELS:
        raise FIXTURE_SENTINELS[symbol]
    end = min(req.end, now) if req.end is not None else now
    start = req.start
    if start is None:
        days = period_days(req.period, end)
        start = end - (FIXTURE_MAX_DAYS if days is None else days) * DAY
    if req.interval in INTRADAY:
        start = max(start, end - INTRADAY_MAX_DAYS[req.interval] * DAY)
    # One bar before the window, so the first bar's open is the close of the
    # bar before it rather than a number the chart never saw.
    lead = INTERVALS[req.interval] * (10 if req.interval in INTRADAY else 2)
    grid = fixture_grid(req.interval, start - lead, end + 1)
    bars = []
    prev_close = None
    for t in grid:
        close = fixture_level(symbol, t)
        if t < start or t > end:
            prev_close = close
            continue
        open_ = prev_close if prev_close is not None else close
        span = abs(close - open_)
        high = max(open_, close) + _noise(symbol, t, "h") * 0.004 * close
        low = min(open_, close) - _noise(symbol, t, "l") * 0.004 * close
        volume = int(1000 + _noise(symbol, t, "v") * 100000 * (1 + 30 * span / close))
        bars.append({
            "time": t,
            "open": round(open_, 2),
            "high": round(high, 2),
            "low": round(low, 2),
            "close": round(close, 2),
            "volume": volume,
        })
        prev_close = close
    return bars


# ── the server ────────────────────────────────────────────────────────────

def accepts_gzip(header: str | None) -> bool:
    """True when Accept-Encoding lists gzip with a non-zero quality."""
    for part in (header or "").split(","):
        token, _, params = part.strip().partition(";")
        if token.strip().lower() != "gzip":
            continue
        quality = 1.0
        for param in params.split(";"):
            key, _, value = param.strip().partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        return quality > 0
    return False


def pick_port(flag: int | None, legacy: int | None) -> int:
    """--port wins, then the bare positional the 1.x README taught, then 8000."""
    if flag is not None:
        return flag
    if legacy is not None:
        return legacy
    return 8000


def format_log_line(client: str, method: str, path: str, status, size, ms: float) -> str:
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    return f"{stamp} {client} {method} {path} {status if status is not None else '-'} {size if size is not None else '-'} {ms:.0f}ms"


class Handler(SimpleHTTPRequestHandler):
    server_version = "openalgo-charts-demo/2.0"
    # Serve ES modules with a JS MIME type: browsers reject `text/plain` modules
    # under strict MIME checking, which would block `import ... from '.mjs'`.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "application/javascript",
        ".js": "application/javascript",
    }

    def __init__(self, *args, **kwargs):
        self._status = None
        self._size = None
        self._cache_set = False
        super().__init__(*args, directory=ROOT, **kwargs)

    # -- bookkeeping for the log line ---------------------------------------
    def send_response(self, code, message=None):  # noqa: N802 (stdlib naming)
        self._status = code
        super().send_response(code, message)

    def send_header(self, keyword, value):  # noqa: N802 (stdlib naming)
        if keyword.lower() == "content-length":
            self._size = value
        super().send_header(keyword, value)

    def end_headers(self):  # noqa: N802 (stdlib naming)
        # A dev server for a library you are actively rebuilding must not cache
        # its files. The browser keeps ES modules in its own module map, so a
        # reload does not re-fetch /dist: you edit the source, rebuild, reload,
        # and still run the previous bundle with no sign anything is stale. The
        # history endpoint sets its own policy and is left alone here.
        if not self._cache_set:
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        # Replaced by the one line per call written at the end of do_GET,
        # which also knows how long the call took.
        pass

    def log_message(self, fmt, *args):
        if getattr(self.server, "quiet", False):
            return
        sys.stderr.write(fmt % args + "\n")
        sys.stderr.flush()

    # -- routing --------------------------------------------------------------
    def do_GET(self):  # noqa: N802 (stdlib naming)
        t0 = time.monotonic()
        self._status = None
        self._size = None
        self._cache_set = False
        try:
            parsed = urlparse(self.path)
            if parsed.path.startswith("/api/"):
                self._api(parsed)
            else:
                super().do_GET()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self._status = "client-gone"
        finally:
            self.log_message("%s", format_log_line(
                self.client_address[0], self.command, self.path, self._status, self._size,
                (time.monotonic() - t0) * 1000,
            ))

    def _api(self, parsed):
        now = int(time.time())
        try:
            if parsed.path != "/api/history":
                raise ApiError(404, "not_found", f"no endpoint at {parsed.path[:80]}")
            req = parse_history_query(parse_qs(parsed.query, keep_blank_values=True))
            bars = self.server.source(req, now)
            if not bars:
                raise ApiError(404, "no_data", "no " + req.describe())
            self._json(200, bars, cache=cache_control_for(req, now))
        except ApiError as e:
            self._json(e.status, {"error": e.message, "code": e.code}, headers=e.headers)
        except Exception as e:  # noqa: BLE001 (a bug here must not take the connection down)
            # The traceback is for the terminal. The browser gets a sentence.
            self.log_message("unhandled %s in %s", type(e).__name__, self.path)
            if not getattr(self.server, "quiet", False):
                traceback.print_exc()
            self._json(500, {"error": "internal error, see the server log", "code": "internal_error"})

    def _json(self, code, payload, headers=None, cache="no-store"):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        encoding = None
        if len(body) >= GZIP_MIN_BYTES and accepts_gzip(self.headers.get("Accept-Encoding")):
            body = gzip.compress(body, compresslevel=6)
            encoding = "gzip"
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", cache)
        self._cache_set = True
        self.send_header("Vary", "Accept-Encoding")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class DemoServer(ThreadingHTTPServer):
    # A thread per request, so a slow upstream fetch never blocks the static
    # files the page is loading alongside it; daemon threads, so a fetch that
    # hangs cannot hold the process open after Ctrl+C.
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, source, quiet=False):
        self.source = source
        self.quiet = quiet
        super().__init__(address, Handler)


def make_server(host: str, port: int, fixture: bool = False, quiet: bool = False, source=None) -> DemoServer:
    return DemoServer((host, port), source or (fixture_bars if fixture else yfinance_bars), quiet=quiet)


def serve(server: DemoServer) -> None:
    """Run until Ctrl+C or SIGTERM, then close the socket and return."""
    def stop(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if not server.quiet:
            print("\nstopped", flush=True)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="openalgo-charts yfinance demo server")
    p.add_argument("legacy_port", nargs="?", type=int, help=argparse.SUPPRESS)
    p.add_argument("--port", type=int, default=None, help="port to listen on (default 8000; 0 picks a free one)")
    p.add_argument("--host", default="127.0.0.1", help="address to bind (default 127.0.0.1)")
    p.add_argument("--fixture", action="store_true", help="serve deterministic synthetic bars; no yfinance, no network")
    p.add_argument("--quiet", action="store_true", help="no request log")
    p.add_argument("--self-test", action="store_true", help="run the built-in checks against the fixture and exit")
    args = p.parse_args(argv)
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(SelfTest)
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        return 0 if result.wasSuccessful() else 1
    server = make_server(args.host, pick_port(args.port, args.legacy_port), fixture=args.fixture, quiet=args.quiet)
    bound = server.server_address[1]
    print(f"openalgo-charts yfinance demo -> http://{args.host}:{bound}/examples/yfinance/index.html")
    print(f"serving package root: {ROOT}")
    print("bars: " + ("synthetic fixture, no network" if args.fixture else "yfinance"), flush=True)
    serve(server)
    return 0


# ── self-test ─────────────────────────────────────────────────────────────
# `python server.py --self-test`. Runs against an in-process fixture server on
# a free port, so it needs neither yfinance nor a network, and is the check a
# change to this file is held to.

def _get(base: str, path: str, headers: dict | None = None):
    import urllib.error
    import urllib.request
    request = urllib.request.Request(base + path, headers=headers or {})
    # The headers come back as the case-insensitive message object: the
    # static route spells Content-type the stdlib way, the JSON route ours.
    try:
        with urllib.request.urlopen(request, timeout=10) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def _start(source=None, fixture=True):
    server = make_server("127.0.0.1", 0, fixture=fixture, quiet=True, source=source)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    return server, thread, "http://127.0.0.1:%d" % server.server_address[1]


class SelfTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.thread, cls.base = _start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path, headers=None):
        return _get(self.base, path, headers)

    def json(self, path, headers=None):
        status, hdrs, body = self.get(path, headers)
        if hdrs.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return status, hdrs, json.loads(body)

    # -- bars ------------------------------------------------------------------
    def test_history_returns_bars_in_the_chart_shape(self):
        status, hdrs, bars = self.json("/api/history?symbol=AAPL&interval=1d&period=1y")
        self.assertEqual(status, 200)
        self.assertTrue(hdrs["Content-Type"].startswith("application/json"))
        self.assertGreater(len(bars), 200)
        for b in bars:
            self.assertEqual(set(b), {"time", "open", "high", "low", "close", "volume"})
            self.assertLessEqual(b["low"], min(b["open"], b["close"]))
            self.assertGreaterEqual(b["high"], max(b["open"], b["close"]))
            self.assertGreater(b["volume"], 0)
        times = [b["time"] for b in bars]
        self.assertEqual(times, sorted(times))
        self.assertEqual(len(set(times)), len(times))
        self.assertLessEqual(times[-1], int(time.time()))

    def test_fixture_is_deterministic_and_differs_by_symbol(self):
        pinned = "&from=1700000000&to=1710000000"
        a1 = self.get("/api/history?symbol=INFY.NS&interval=1d" + pinned)[2]
        a2 = self.get("/api/history?symbol=INFY.NS&interval=1d" + pinned)[2]
        b = self.get("/api/history?symbol=TCS.NS&interval=1d" + pinned)[2]
        self.assertEqual(a1, a2)
        self.assertNotEqual(a1, b)
        # A second server instance answers with the same bytes: nothing about
        # the values depends on process state.
        other, thread, base = _start()
        try:
            self.assertEqual(_get(base, "/api/history?symbol=INFY.NS&interval=1d" + pinned)[2], a1)
        finally:
            other.shutdown()
            other.server_close()

    def test_bars_connect_open_to_previous_close(self):
        _, _, bars = self.json("/api/history?symbol=AAPL&interval=1d&from=1700000000&to=1710000000")
        for prev, cur in zip(bars, bars[1:]):
            self.assertEqual(cur["open"], prev["close"])

    def test_intraday_grid_sits_in_the_session_on_weekdays(self):
        _, _, bars = self.json("/api/history?symbol=AAPL&interval=5m&from=1700000000&to=1700600000")
        self.assertGreater(len(bars), 300)
        for b in bars:
            day_sec = b["time"] % DAY
            self.assertGreaterEqual(day_sec, SESSION_OPEN)
            self.assertLess(day_sec, SESSION_CLOSE)
            self.assertLess(_weekday(b["time"]), 5)
            self.assertEqual((b["time"] - SESSION_OPEN) % 300, 0)
        # Consecutive bars inside a day are one interval apart.
        gaps = {cur["time"] - prev["time"] for prev, cur in zip(bars, bars[1:]) if cur["time"] // DAY == prev["time"] // DAY}
        self.assertEqual(gaps, {300})

    def test_calendar_intervals_land_on_their_boundaries(self):
        _, _, weekly = self.json("/api/history?symbol=AAPL&interval=1wk&from=1690000000&to=1710000000")
        self.assertTrue(all(_weekday(b["time"]) == 0 for b in weekly))
        self.assertGreater(len(weekly), 25)
        _, _, monthly = self.json("/api/history?symbol=AAPL&interval=1mo&from=1600000000&to=1710000000")
        self.assertTrue(all(datetime.fromtimestamp(b["time"], tz=timezone.utc).day == 1 for b in monthly))
        self.assertGreater(len(monthly), 40)
        _, _, quarterly = self.json("/api/history?symbol=AAPL&interval=3mo&from=1600000000&to=1710000000")
        self.assertTrue(all(datetime.fromtimestamp(b["time"], tz=timezone.utc).month in (1, 4, 7, 10) for b in quarterly))

    def test_intraday_period_is_clamped_like_the_source(self):
        _, _, bars = self.json("/api/history?symbol=AAPL&interval=1m&period=1y")
        self.assertGreaterEqual(bars[0]["time"], int(time.time()) - 8 * DAY)
        self.assertLess(len(bars), 3000)

    def test_period_days_resolves_ytd(self):
        mid_feb = int(datetime(2024, 2, 15, tzinfo=timezone.utc).timestamp())
        self.assertEqual(period_days("ytd", mid_feb), 45)
        self.assertIsNone(period_days("max", mid_feb))
        self.assertEqual(period_days("1y", mid_feb), 366)

    # -- validation ------------------------------------------------------------
    def test_symbol_is_validated(self):
        for path in ("/api/history", "/api/history?symbol=", "/api/history?symbol=AA%20PL",
                     "/api/history?symbol=" + "A" * 25, "/api/history?symbol=.AAPL", "/api/history?symbol=%3Cb%3E"):
            status, _, body = self.json(path)
            self.assertEqual(status, 400, path)
            self.assertEqual(body["code"], "bad_symbol", path)
            self.assertIn("symbol", body["error"])
        for ok in ("AAPL", "RELIANCE.NS", "%5ENSEI", "BTC-USD", "GC%3DF", "BRK-B", "EURUSD%3DX"):
            self.assertEqual(self.get("/api/history?symbol=" + ok + "&from=1700000000&to=1701000000")[0], 200, ok)

    def test_interval_and_period_are_allowlisted(self):
        status, _, body = self.json("/api/history?symbol=AAPL&interval=7m")
        self.assertEqual((status, body["code"]), (400, "bad_interval"))
        status, _, body = self.json("/api/history?symbol=AAPL&period=3y")
        self.assertEqual((status, body["code"]), (400, "bad_period"))
        status, _, body = self.json("/api/history?symbol=AAPL&interval=1d&period=1y")
        self.assertEqual(status, 200)

    def test_range_is_validated(self):
        for q in ("to=abc", "from=-5", "to=1.5", "from=99999999999", "from=1700000000&to=1700000000",
                  "from=1700000001&to=1700000000"):
            status, _, body = self.json("/api/history?symbol=AAPL&" + q)
            self.assertEqual((status, body["code"]), (400, "bad_range"), q)

    def test_unknown_endpoint_is_json_404(self):
        status, hdrs, body = self.json("/api/quote?symbol=AAPL")
        self.assertEqual((status, body["code"]), (404, "not_found"))
        self.assertTrue(hdrs["Content-Type"].startswith("application/json"))

    # -- error states ----------------------------------------------------------
    def test_sentinel_symbols_exercise_the_error_paths(self):
        status, _, body = self.json("/api/history?symbol=FAIL")
        self.assertEqual((status, body["code"]), (502, "upstream_error"))
        status, _, body = self.json("/api/history?symbol=fail")
        self.assertEqual(status, 502)
        status, _, body = self.json("/api/history?symbol=EMPTY")
        self.assertEqual((status, body["code"]), (404, "no_data"))
        status, hdrs, body = self.json("/api/history?symbol=BUSY")
        self.assertEqual((status, body["code"]), (429, "rate_limited"))
        self.assertEqual(hdrs["Retry-After"], "30")

    def test_upstream_errors_map_to_429_or_502_without_a_traceback(self):
        class YFRateLimitError(Exception):
            pass
        e = upstream_error(YFRateLimitError("Too Many Requests. Rate limited."))
        self.assertEqual((e.status, e.code, e.headers.get("Retry-After")), (429, "rate_limited", "60"))
        e = upstream_error(ConnectionError("name resolution failed\nsecond line"))
        self.assertEqual((e.status, e.code), (502, "upstream_error"))
        self.assertEqual(e.message, "ConnectionError: name resolution failed second line")
        e = upstream_error(RuntimeError("x" * 1000))
        self.assertLess(len(e.message), 400)

    def test_a_source_with_no_bars_is_a_404(self):
        server, thread, base = _start(source=lambda req, now: [])
        try:
            status, hdrs, body = _get(base, "/api/history?symbol=AAPL&interval=5m&period=1mo")
            self.assertEqual((status, json.loads(body)["code"]), (404, "no_data"))
            self.assertIn("5m bars of AAPL over 1mo", json.loads(body)["error"])
            self.assertEqual(hdrs["Cache-Control"], "no-store")
        finally:
            server.shutdown()
            server.server_close()

    def test_a_bug_in_the_source_is_a_500_that_leaks_nothing(self):
        def broken(req, now):
            raise RuntimeError("boom in C:\\private\\path\\server.py")
        server, thread, base = _start(source=broken)
        try:
            status, hdrs, body = _get(base, "/api/history?symbol=AAPL")
            self.assertEqual(status, 500)
            text = body.decode()
            self.assertEqual(json.loads(text)["code"], "internal_error")
            self.assertNotIn("Traceback", text)
            self.assertNotIn("private", text)
            self.assertNotIn("boom", text)
            self.assertEqual(hdrs["Cache-Control"], "no-store")
        finally:
            server.shutdown()
            server.server_close()

    def test_missing_yfinance_is_a_503(self):
        real = sys.modules.get("yfinance")
        sys.modules["yfinance"] = None  # makes `import yfinance` raise ModuleNotFoundError
        try:
            server, thread, base = _start(fixture=False)
            try:
                status, _, body = _get(base, "/api/history?symbol=AAPL")
                self.assertEqual((status, json.loads(body)["code"]), (503, "not_installed"))
            finally:
                server.shutdown()
                server.server_close()
        finally:
            if real is None:
                del sys.modules["yfinance"]
            else:
                sys.modules["yfinance"] = real

    # -- headers ---------------------------------------------------------------
    def test_cache_control_is_short_for_live_and_immutable_for_closed_ranges(self):
        _, hdrs, _ = self.get("/api/history?symbol=AAPL&interval=1d&period=1mo")
        self.assertEqual(hdrs["Cache-Control"], LIVE_CACHE)
        _, hdrs, _ = self.get("/api/history?symbol=AAPL&interval=1d&from=1700000000&to=1701000000")
        self.assertEqual(hdrs["Cache-Control"], CLOSED_CACHE)
        # A window that ends now still holds a forming bar.
        now = int(time.time())
        _, hdrs, _ = self.get(f"/api/history?symbol=AAPL&interval=1d&period=1mo&to={now}")
        self.assertEqual(hdrs["Cache-Control"], LIVE_CACHE)
        # And so does one that ended a minute ago on a daily interval, whose
        # last bar can still be open; the same minute on 1m bars has closed.
        _, hdrs, _ = self.get(f"/api/history?symbol=AAPL&interval=1d&period=1mo&to={now - 60}")
        self.assertEqual(hdrs["Cache-Control"], LIVE_CACHE)
        _, hdrs, _ = self.get(f"/api/history?symbol=AAPL&interval=1m&period=5d&to={now - 120}")
        self.assertEqual(hdrs["Cache-Control"], CLOSED_CACHE)
        # Errors are never cached.
        _, hdrs, _ = self.get("/api/history?symbol=FAIL&from=1700000000&to=1701000000")
        self.assertEqual(hdrs["Cache-Control"], "no-store")

    def test_gzip_only_when_the_client_accepts_it(self):
        path = "/api/history?symbol=AAPL&interval=1d&from=1700000000&to=1710000000"
        status, plain_hdrs, plain = self.get(path)
        self.assertEqual(status, 200)
        self.assertNotIn("Content-Encoding", plain_hdrs)
        status, gz_hdrs, gz = self.get(path, {"Accept-Encoding": "gzip, deflate, br"})
        self.assertEqual(gz_hdrs["Content-Encoding"], "gzip")
        self.assertEqual(gz_hdrs["Vary"], "Accept-Encoding")
        self.assertEqual(int(gz_hdrs["Content-Length"]), len(gz))
        self.assertLess(len(gz), len(plain))
        self.assertEqual(gzip.decompress(gz), plain)
        _, hdrs, _ = self.get(path, {"Accept-Encoding": "gzip;q=0, identity"})
        self.assertNotIn("Content-Encoding", hdrs)
        # A short error body is not worth the header.
        _, hdrs, _ = self.get("/api/history?symbol=FAIL", {"Accept-Encoding": "gzip"})
        self.assertNotIn("Content-Encoding", hdrs)

    def test_static_files_are_served_uncached(self):
        status, hdrs, body = self.get("/examples/yfinance/server.py")
        self.assertEqual(status, 200)
        self.assertEqual(hdrs["Cache-Control"], "no-store, must-revalidate")
        self.assertIn(b"openalgo-charts", body)
        status, hdrs, _ = self.get("/examples/yfinance/src/main.js")
        self.assertEqual(status, 200)
        self.assertTrue(hdrs["Content-Type"].startswith("application/javascript"))
        self.assertEqual(self.get("/examples/yfinance/no-such-file")[0], 404)

    # -- operations ------------------------------------------------------------
    def test_log_line_carries_method_path_status_size_and_duration(self):
        line = format_log_line("127.0.0.1", "GET", "/api/history?symbol=AAPL", 200, "1234", 12.4)
        self.assertRegex(line, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d 127\.0\.0\.1 GET /api/history\?symbol=AAPL 200 1234 12ms$")
        self.assertTrue(format_log_line("::1", "GET", "/", None, None, 0).endswith(" GET / - - 0ms"))

    def test_shutdown_is_prompt_and_frees_the_port(self):
        server, thread, base = _start()
        port = server.server_address[1]
        self.assertEqual(_get(base, "/api/history?symbol=AAPL&period=5d")[0], 200)
        t0 = time.monotonic()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertLess(time.monotonic() - t0, 2)
        again = make_server("127.0.0.1", port, fixture=True, quiet=True)
        again.server_close()

    def test_serve_returns_on_ctrl_c(self):
        import _thread
        server = make_server("127.0.0.1", 0, fixture=True, quiet=True)
        # Ctrl+C is a KeyboardInterrupt in the main thread; this is that, on a timer.
        threading.Timer(0.2, _thread.interrupt_main).start()
        t0 = time.monotonic()
        serve(server)
        self.assertLess(time.monotonic() - t0, 3)
        with self.assertRaises(OSError):
            server.socket.getsockname()  # closed: the socket is gone

    def test_cli_port_forms(self):
        self.assertEqual(pick_port(None, None), 8000)
        self.assertEqual(pick_port(None, 8123), 8123)
        self.assertEqual(pick_port(9000, 8123), 9000)
        self.assertEqual(pick_port(0, None), 0)

    def test_gzip_negotiation(self):
        self.assertTrue(accepts_gzip("gzip"))
        self.assertTrue(accepts_gzip("gzip, deflate, br"))
        self.assertTrue(accepts_gzip("GZIP;q=0.5"))
        self.assertFalse(accepts_gzip("gzip;q=0"))
        self.assertFalse(accepts_gzip("identity"))
        self.assertFalse(accepts_gzip(None))


if __name__ == "__main__":
    sys.exit(main())
