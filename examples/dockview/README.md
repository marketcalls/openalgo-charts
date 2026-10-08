# Dockview Multi-Chart Terminal

A multi-chart docking and snapping terminal example written in TypeScript using `dockview-core` and `openalgo-charts`.

## Key Capabilities

- **Drag-and-Drop Docking**: Hovering tab headers toward pane edges highlights snap targets (top, bottom, left, right, or tabbed grouping) to arrange multi-pane layouts flexibly.
- **Canvas Size Isolation**: A `ResizeObserver` bound directly to each chart container isolates splitter drag reflows, ensuring each canvas repaints smoothly without distortion.
- **Layout Rehydration & Persistence**: Panel parameters (symbol, interval, positions) are serialized to `localStorage` under `mmt_terminal_layout_v1` on every layout change, restoring state on page reload.
- **Dynamic Title Synchronization**: Each panel updates its tab title dynamically when an instrument symbol changes.
- **Offline data**: The shared `SampleMarketDataFeed` parses the bundled OpenAlgo history responses and aggregates minute OHLCV bars into the requested interval. Unsupported instruments fail instead of displaying another instrument's bars.
- The examples use `SAMPLE_NOW` and a 10,000-bar history window so every bundled instrument remains visible after its recorded session. They are recorded-data examples, not live market connections.

## Running the Example

1. Build the library from repository root:
   ```bash
   npm run build
   ```
2. Start any local static web server from the repository root:
   ```bash
   node tests/e2e/serve.cjs
   ```
3. Open `http://localhost:4173/examples/dockview/index.html` in your browser.

The build emits the browser modules from TypeScript; generated JavaScript and preview
screenshots are ignored by Git. After changing example TypeScript alone, run
`npm run build:terminal-examples`. The five data fixtures retain every recorded bar,
formatted with one bar per line; no combined duplicate dataset is needed.
