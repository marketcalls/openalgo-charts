# yfinance historical demo

Loads historical OHLCV from [yfinance](https://pypi.org/project/yfinance/) and
renders it with OpenAlgo Charts (candles plus volume), showing how to wire any
OHLCV source through a custom `DataFeed`. It is the reference host: the place a
feature is proved usable, not just present.

## Run

```bash
# 1. Build the library bundles (from the package root): the demo imports /dist
npm run build

# 2. Install the one Python dependency and start the demo server
cd examples/yfinance
pip install -r requirements.txt
python server.py                 # http://127.0.0.1:8000
python server.py --port 8123     # another port (the 1.x form, python server.py 8123, still works)
```

Open **http://127.0.0.1:8000/examples/yfinance/index.html**, type a Yahoo Finance
symbol, pick an interval and range, and the chart loads.

Symbol examples: `AAPL`, `MSFT`, `RELIANCE.NS` (NSE), `^NSEI` (Nifty 50),
`BTC-USD` (crypto).

### Without yfinance, or without a network

```bash
python server.py --fixture       # synthetic bars for any symbol; nothing is imported, nothing is fetched
```

Everything else is the same page and the same URL. The server needs only the
Python standard library in this mode, so a fresh clone can run the demo before
`pip install` and without a connection. See [Offline fixture mode](#offline-fixture-mode)
for what the bars look like and how to reach the error states.

### Every flag

| Flag | Meaning |
|---|---|
| `--port N` | Listen on N (default 8000). `0` picks a free port and prints it. A bare positional `N` means the same. |
| `--host H` | Bind address (default `127.0.0.1`). |
| `--fixture` | Serve deterministic synthetic bars instead of yfinance. |
| `--quiet` | No request log. |
| `--self-test` | Run the server's own checks against an in-process fixture server, then exit 0 or 1. |

## The server

`server.py` serves the package root statically (so `/dist` and `/examples`
resolve from one origin, and `.mjs` gets a JavaScript MIME type) and answers
one JSON endpoint. It is the standard library plus yfinance, and yfinance is
imported on the first real request, so static serving and fixture mode work
without it.

```
GET /api/history?symbol=AAPL&interval=1d&period=1y
GET /api/history?symbol=AAPL&interval=5m&from=<utc seconds>&to=<utc seconds>
```

| Parameter | Rule |
|---|---|
| `symbol` | Required. 1 to 24 characters of letters, digits, `.`, `-` or `=`, with an optional leading `^`. That covers a ticker, a venue suffix (`RELIANCE.NS`), a pair (`BTC-USD`), a future or rate (`GC=F`, `EURUSD=X`) and an index (`^NSEI`), and nothing that could be a sentence. |
| `interval` | One of `1m 2m 5m 15m 30m 60m 90m 1h 1d 5d 1wk 1mo 3mo` (default `1d`). |
| `period` | One of `1d 5d 1mo 3mo 6mo 1y 2y 5y 10y ytd max` (default `1y`). |
| `from`, `to` | Optional UTC seconds that pin the window. `to` alone ends the period there; `from` overrides the period's length. Both must be positive, before the year 2100, and `from` before `to`. |

A success is the `Bar[]` the chart consumes directly, `{ time: <UTC seconds>,
open, high, low, close, volume }`, with any row the source left without a
price dropped (yfinance emits them for suspensions and some holidays, and a
bare `NaN` is not JSON). A failure is `{ "error": <sentence>, "code": <token> }`
with the status that matches, and never a traceback: that goes to the terminal.

| Status | `code` | When |
|---|---|---|
| 400 | `bad_symbol`, `bad_interval`, `bad_period`, `bad_range` | A parameter failed the rule above. The message names the rule. |
| 404 | `no_data` | The source has no bars for that ask: an unknown symbol, or a range it does not serve. |
| 404 | `not_found` | No such endpoint under `/api/`. |
| 429 | `rate_limited` | The source is throttling this address. `Retry-After` says when to try again. |
| 502 | `upstream_error` | The source failed: no network, a changed API, a symbol it choked on. The message is the exception's name and text, truncated. |
| 503 | `not_installed` | yfinance is not installed and the server was not started with `--fixture`. |
| 500 | `internal_error` | A bug in this file. The traceback is printed on the server side only. |

**Cache-Control.** Static files are `no-store`: this is a dev server for a
library you are rebuilding, and the browser's module map would otherwise keep
running the previous bundle after a rebuild. History responses follow the
forming-bar rule from `CLAUDE.md`. A window that could still contain a bar that
has not closed gets `private, max-age=5`, enough to fold the double fetch a
linked second chart makes into one and no longer. A window pinned with `to`
whose last possible bar has closed (`now >= to + one interval`) gets
`public, max-age=31536000, immutable`, because the same URL can never answer
differently. A period request always ends now, so it is never immutable.
Errors are `no-store`.

**gzip.** JSON bodies of 512 bytes or more are gzip-compressed when the
request's `Accept-Encoding` lists `gzip` with a non-zero quality; every JSON
response carries `Vary: Accept-Encoding`. A history body goes to about a
quarter of its size on the wire.

**Log line.** One line per request on stderr, `time client method path status
bytes ms`, so a slow symbol or a 4xx storm is visible without a debugger.
`--quiet` turns it off.

**Shutdown.** Ctrl+C (or SIGTERM where the platform delivers it) stops the
listener, closes the socket and prints `stopped`. Requests are handled on
daemon threads, so a yfinance call that hangs cannot hold the process open.

## Offline fixture mode

`--fixture` answers `/api/history` for any symbol from a pure function of
(symbol, bar time): the same URL returns the same bytes on any machine on any
day, as long as the window is pinned with `to`. It is what the end-to-end
suite runs against, and what a fresh clone can run before installing anything.

- Each symbol has its own base price, drift and three waves whose periods the
  symbol's hash picks, so two symbols never move together and a comparison
  overlay has something to show. Every bar's open is the previous bar's close.
- Bars sit on a 09:15 to 15:30 IST session on weekdays, spelled in UTC. IST is
  the library's default zone and has no daylight saving, so the grid is the
  same number every day of the year. Daily bars land at the session open,
  weekly bars on Mondays, monthly and quarterly bars on the first of the month.
- Intraday ranges are clamped to the limits the real source enforces (`1m`
  seven days, `5m` to `90m` sixty days, `1h` two years), so the bar counts
  match a live run. The live source answers an over-long ask with nothing,
  which the server turns into 404 `no_data`; the fixture clamps instead.
- The last bar is the one whose start is at or before now. Its values are
  fixed for the length of the bar rather than moving with every request:
  determinism was the point.

Three symbols are reserved so the page's error handling can be exercised
without breaking a network:

| Symbol | Answer |
|---|---|
| `FAIL` | 502 `upstream_error`, the state a dead source puts the page in |
| `EMPTY` | 404 `no_data`, an unknown symbol |
| `BUSY` | 429 `rate_limited` with `Retry-After: 30` |

The case does not matter (`fail` works too). Every other symbol that passes
the validation rule gets bars.

`python server.py --self-test` starts a fixture server on a free port in the
process and checks the contract above: the bar shape and grid, determinism
across two server instances, every validation and error path, that a bug in
the source is a 500 with no traceback in the body, the cache and gzip
headers, static serving, the log line, and that shutdown returns promptly and
frees the port.

## Layout

The demo is a plain native-ESM host: no bundler, no build step, relative
imports, and the library imported from `/dist/openalgo-charts.mjs` and its
tier files exactly as a page would.

```
examples/yfinance/
  index.html          markup only: the shell, the dialogs, the menus
  styles.css          every rule the page uses
  server.py           static server, /api/history (yfinance or fixture), the self-test
  requirements.txt    yfinance, the one dependency, needed only outside --fixture
  src/
    main.js           composition root: the shared app state, render(), load(), boot
    ui.js             el(), number and text formatting, the candle palette, toasts, the overlay stack (focus trap, one Escape per layer), the chart loading, empty and error card, the theme switch
    hover.js          the one hover label every icon-only control shares
    intervals.js      interval registry, the picker's codes, period clamping
    feed.js           YFinanceDataFeed and its typed errors, the bar cache wrapper, the cache menu
    transforms.js     Heikin Ashi, Renko, Range, Line Break, P&F, Kagi
    status.js         venue, session hours, long names, the status-line readings
    timezone.js       the chart zone the demo carries across a rebuild
    axis-chrome.js    clock and countdown, status-line and trade palette choices
    volume.js         volume visibility and the symbol legend row
    bracket.js        the bracket panel: entry, target and stop pills
    orders.js         resting orders, market fills, the net position, trade state
    watermark.js      the chart watermark
    indicators.js     the indicator picker and the generated settings form
    chart-settings.js the chart settings dialog, built from chartSettingsSchema()
    compare.js        multi-symbol comparison
    replay.js         market replay: the bar picker and the transport
    snapshot.js       save or copy the chart as a PNG
    split.js          the linked second chart and its divider
    link.js           the link-group switches
    clipboard.js      the drawing clipboard and its chords
    menus.js          the right-click menu, the price-axis menu, the popup menu
    toolbar.js        the shell bar, chart types, chart-only full screen
    rail.js           the drawing rail: groups, pins, magnet, stay mode, selection controls, keyboard
    rail-flyout.js    the rail's flyout, context menu and dwell tooltip
    properties.js     the floating properties bar, generated from drawingSettingsSchema
    level-editor.js   the level editor popover for ladder tools (fibs, channels, fans, Gann)
    text-editor.js    inline text editing for a drawing, laid over the painted text
    drawing.js        the drawing controller, the tool picker, the clipboard chords
    persist.js        the layout document, its schema and migrations, storage, export and import
  tests/              vitest specs for the modules that can run without a browser
  vitest.config.ts    the config those specs run under (see Tests)
```

Shared mutable state (the chart, the loaded bars, the orders, the replay, the
second chart) lives on one `app` object that `main.js` creates and hands to
every module's `init*(app)`. Nothing is a global: a module keeps the reference
it was given and reads `app.chart` rather than a copy, because a chart-type
switch destroys and rebuilds the chart and a copy would go stale. The two
operations everything reaches back to, `load()` and `render()`, live in
`main.js`; modules call the loader as `app.load()`.

Module top level is declarations only. Listeners, the animation loop and the
link group are created inside the `init*` functions, which `main.js` calls in
the order the page registers them, so the import graph can have cycles (the
toolbar opens the compare dialog, the compare dialog refreshes the toolbar)
without any module reading another's binding before it exists.

Opening the page with `?test=1` puts `window.__oac = { chart, draw, app }` on
the window for the end-to-end suite; `chart` and `draw` are getters, so they
follow a rebuild.

## How it connects

```
yfinance (Python)  ->  server.py /api/history  ->  YFinanceDataFeed.getBars()  ->  series.setData()
```

- `server.py` maps the yfinance DataFrame (or the fixture) to the chart's
  `Bar` shape and answers with the status codes above.
- `src/feed.js` defines a small `YFinanceDataFeed` implementing `getBars()`,
  the same broker-agnostic `DataFeed` interface the OpenAlgo adapter uses,
  turns the status codes into typed errors the shell can act on, and wraps the
  feed in the engine's bar cache. Swapping data sources is a different
  `getBars()`.

## What each module proves

The engine ships no DOM, so every control here is host code; each module
exists to show one engine surface carrying real use, not just being present.

| Module | Proves |
|---|---|
| `feed.js` | A `DataFeed` is one method. The bar cache wrapper (`withBarCache`) keys on symbol, exchange and interval, snaps `from` to the bar grid so a reload inside the same bar hits, stops `to` at the last seen bar while the venue is shut, and refetches only the forming bar. A 404, 429 or 5xx becomes a typed error (`NotFoundError`, `RateLimitedError`, `NetworkError`) with a deadline and one retry, so the readout can say "check the symbol" or "try again in a minute" rather than printing whatever the server wrote. A staleness badge says when the newest bar is older than the venue's clock allows. |
| `intervals.js` | The interval registry accepts codes the built-in grammar does not (`1wk`, a calendar month, a quarter). Monthly and quarterly bars are folded from daily ones through `bucketStartOf`, so a month runs first-to-first in the chart's zone and February is 29 days long in 2024. Ranges are clamped to what the interval can serve. |
| `indicators.js` | The picker is built from `registeredIndicators()`, not a hardcoded list, so anything registered shows up grouped by category, and the count is the tier's rather than the demo's. The gear opens a form generated from the descriptor's `inputs`; the same code renders MACD, Bollinger or your own indicator. |
| `chart-settings.js` | The settings dialog is generated from `chartSettingsSchema()`, including the paired up and down colour control on one row, and a control the current context cannot back is drawn disabled with its state visible. |
| `transforms.js` | Heikin Ashi, Renko, Range Bars, Line Break, Point and Figure and Kagi from the transform tier; P&F reveals its box-sizing mode (ATR, percent, fixed). |
| `volume.js` | Volume rides an overlay price scale (`priceScaleId: ''`) inside the price pane, pinned to the bottom fifth, so the right-hand axis stays a clean price ladder. It hides and shows from the legend eye and the right-click menu, and the choice survives a reload and a chart-type switch. |
| `status.js`, `axis-chrome.js`, `timezone.js` | The status line, the clock and the countdown are fed by the host: venue, session hours by IANA zone (never a fixed offset), and long names. The chart zone is a runtime setting the demo carries across a rebuild. |
| `orders.js`, `bracket.js` | Chart trading: right-click for single orders, Buy and Sell brackets with OCO target and stop, drag any line to re-price it, and per-symbol trade state that survives a symbol switch. |
| `replay.js` | Market replay picks a start bar with everything to its right greyed out across every pane, then walks forward. On an interval with a finer one below it the displayed bar forms rather than landing complete, the transport counts the steps, and a mark stays on the plot the whole time. |
| `compare.js`, `split.js`, `link.js` | Comparison overlays and their scale mode, a linked second chart, and the link-group switches for crosshair, viewport and symbol. |
| `drawing.js`, `rail.js`, `rail-flyout.js` | The 2.0 drawing model from the host's side: the controller, the tool picker built from `BUILTIN_DRAWING_TOOLS` with the tier's own icon sprite and cursors, keyboard chords from `drawingShortcuts()`, and a rail whose flyouts and tooltips are host chrome built from the shipped glyphs. |
| `properties.js` | The floating properties bar is generated from `drawingSettingsSchema`, which declares only the fields a tool's `draw` reads: a field in the schema is a control with something behind it, a field absent from it is a control not shown. With several drawings selected it edits the fields their schemas share, as one undo entry. |
| `clipboard.js` | One in-memory clipboard shared by both charts' controllers, so copy here and paste there works even when the browser refuses the OS clipboard; the OS read is bounded so a paste never hangs on a permission popup. |
| `level-editor.js` | A ladder tool's levels (retracement, extension, channel, fan, time zones, the Gann pair) edited one row each: enable, ratio, colour, label, add, remove, reset. Every edit is one undo entry through the controller. |
| `text-editor.js` | Inline text editing over the painted text, sized by the same rules the text tool paints with, with every pointer and key event stopped at the box so the chart under it does not pan. |
| `menus.js`, `toolbar.js`, `hover.js` | Host chrome to the standard in `CLAUDE.md`: styled scrollbars, no native form controls on a dark panel, real tooltips that flip inside the window, and dialog furniture in one arrangement. |
| `snapshot.js` | `chart.takeScreenshot()` saved as a PNG or copied to the clipboard, with the watermark and the replay mark in the image because they are on the canvas. |
| `persist.js` | A versioned layout document with migrations, quarantine instead of deletion, memory-only degradation when storage refuses a write, and export and import as a file. See the next section. |

## Persistence

The layout is one JSON document under the key `oa-charts:layout` (every key
the page writes starts with `oa-charts:`, so another host on the same origin
cannot collide with it). A 1.x page kept it under `oa-charts-layout`; that
key is read once on boot, upgraded, moved, and removed.

**Schema version.** The document carries `schema: 2` (`LAYOUT_SCHEMA` in
`src/persist.js`). Inside it ride two versions the demo does not own: the
engine's `version` (`CHART_STATE_VERSION`, what `chart.getState()` produced)
and, under `drawings`, the draw tier's document with its own `version`
(`DRAWING_STATE_VERSION`). The demo's number says what shape the wrapper is;
the engine's numbers say what shape the parts are.

```
{
  schema: 2,
  version: <CHART_STATE_VERSION>,   ...chart.getState(): viewport, panes, price scales, indicators
  drawings: { version: <DRAWING_STATE_VERSION>, drawings: [...] },
  dataset: "AAPL|1d|1y",            what the view was captured on
  comparisons: [{ symbol, color }],
  compareMode, volume
}
```

**Where migrations live.** `MIGRATIONS` in `src/persist.js`, one step per
schema version keyed by the version it upgrades from; `upgradeLayout()` runs
them in order until the document is at `LAYOUT_SCHEMA`. Step 1 stamps the
schema, stamps a missing chart-state version, and hands `drawings` to the draw
tier's own `migrateDrawings()` (`src/draw/migrate.ts` in the engine), which
is the one place the 1.x drawing shape is understood: text moved out of the
style bag, fib levels became objects, every drawing gained a z-order. The
chart state itself is checked by `chart.restoreState()`, which refuses a
state without a version or with one newer than the engine's. A document
written by a newer demo, or carrying a chart state newer than this engine, is
refused rather than guessed at, before anything has been applied.

**What happens to a document that cannot be read.** It is not deleted. It is
renamed under `oa-charts:quarantine:layout:<timestamp>` (the newest five are
kept), the page says so in a notice that outlives the status line, and the
session starts clean. The layout is the user's own work, and the fault may be
in the reader.

**When storage refuses a write** (quota, a private window), the layout is
kept in memory for the session, the user is told once, and Save tries storage
again. Autosave is debounced 250 ms, skipped during replay (a viewport over a
truncated session would restore the user into a truncated chart), and flushed
on `pagehide`. Restoring onto a different dataset keeps the workspace
(indicators, drawings, pane sizes, styles) and drops the view (viewport and
pinned price ranges), because a bar-index range means nothing on other bars.

**Files.** `exportLayout()` wraps the document with what wrote it and when;
`parseLayoutFile()` accepts that wrapper or a bare document and upgrades
either. The page's Export and Import buttons are optional markup: a page
without them still saves.

## Tests

The repository's vitest config collects `tests/**` only, so the demo carries
its own. From the package root:

```bash
npm run test:demo                                             # the modules (also part of npm run verify)
python examples/yfinance/server.py --self-test                # the server
npx playwright test --project=yfinance-demo                   # the page, in a real browser against the fixture server
```

The specs cover what runs without a browser: every module evaluates outside a
DOM (a module that touched `document` at import time would be a blank page),
the interval registry and period clamping, the feed's request window, error
classification and cache verdict, the layout schema, migrations and
quarantine, the feed's typed errors, retry, cancellation and staleness, the
shell furniture (toasts, the overlay stack, the chart-state card, the theme),
the rail, the properties bar and its editors, the venue and session readings,
order and position arithmetic, the bracket, and the transforms. The server's own checks
are described under [Offline fixture mode](#offline-fixture-mode). Anything
that draws is checked in a real browser against `index.html`, and the fixture
server is what that browser talks to: `tests/e2e/yfinance.spec.ts` drives the
page through the rail, the mouse and the transport, and reads the result back
through the `?test=1` handle.

## Notes

- Intraday intervals (`1m` to `90m`, `1h`) are limited by Yahoo to recent history
  (about 7 to 60 days, two years for `1h`); daily and weekly go back years.
  The range menu only offers what the interval can serve, and the server
  answers an over-long ask with 404 `no_data` rather than an empty chart.
- Times are converted to **UTC seconds** internally; the chart renders a gapless
  axis (weekends and holidays collapse) and formats labels in IST by default.
- yfinance is unofficial and rate-limited. A throttle surfaces as 429 with a
  `Retry-After`, and the page says to wait rather than retrying at once. For
  production use OpenAlgo's own `/api/v1/history` via `OpenAlgoDataFeed`.
- An error from the feed lands in the status readout, in an error card over the
  chart with a retry, and in a toast; the shell, the rail and the last chart stay
  up. An unknown symbol (yfinance answers with an empty frame) reads as
  `SYMBOL: no bars` rather than an empty chart; a throttle says so and is not
  retried; a dropped connection is retried once. A `STALE` badge beside the
  readout means the newest bar has closed while the venue is open: the feed is
  behind, or the load was warm and the cache holds only closed bars (reload
  ignoring the cache from the cache menu).
