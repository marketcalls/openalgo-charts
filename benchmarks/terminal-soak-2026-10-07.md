# Terminal browser soak, 2026-10-07

Measured against the architectural revision based on `d1560c3f`.
The [raw result](terminal-soak-2026-10-07.json) records the tested bundle hashes.
This is a three-minute characterization on one machine, without a reference-build comparison.

## Workload and environment

- Eight visible NIFTY 5m charts, with 135 fixture bars each.
- Eight visible virtualized ladders, each receiving 2,000 depth levels at a target 20 snapshots per second.
- The same timer updates the last candle on every chart; a synthetic button click probes the next rendered frame every second.
- 180 measured seconds after a five-second warm-up; snapshot counters include warming and setup time.
- Windows, AMD Ryzen 5 5600X 6-Core Processor, 12 logical CPUs, 31.9 GiB RAM.
- Chromium 149.0.7827.55, viewport 1920x1080, headless browser.
- No concurrent build or test suite ran during the measured interval.

## Results

| Measurement | Result |
| --- | --- |
| Delivered snapshots per ladder | 3,706 |
| Visible depth rows across all eight ladders | 152 |
| Frame interval, 95th percentile | 16.7 ms |
| Synthetic click to next frame, 95th percentile | 24.8 ms |
| Synthetic click to next frame, maximum | 31.6 ms |
| Renderer main-thread task time | 54.38 seconds (30.2% of the interval) |
| JavaScript heap after collection, start | 7.09 MiB |
| JavaScript heap after collection, end | 7.12 MiB |
| Collected heap change | 25.1 KiB |
| DOM nodes, start | 7,011 |
| DOM nodes, minute samples | 7024, 7011, 7011 |
| DOM nodes after workspace destruction | 226 |
| Browser errors | 0 |

All six terminal browser scenarios passed, including this workload, restoration,
lazy loading, chart-scoped tools and row reuse. The suite also checks positive chart
history on every chart, fewer than 400 visible ladder rows, no remaining widget roots,
less than 1,000 extra DOM nodes and less than 16 MiB of collected heap growth.

The DOM-node counts remained bounded during the measured session. The collected heap
change is small over this interval; it does not establish leak freedom over hours.
The teardown heap includes loaded modules and browser caches, so it should not return
to the empty-page value. Renderer task time is not whole-machine CPU utilization.
JavaScript heap excludes native canvas, GPU and operating-system memory. Forced garbage
collection before each minute sample can affect the timing percentiles. Response probes
are synthetic DOM clicks, not physical input or broker-delivery latency.

## Reproduce or extend

Build the package and install the repository's existing Chromium browser before running.
From PowerShell:

```powershell
$env:TERMINAL_SOAK_MS='180000'
node node_modules/@playwright/test/cli.js test terminal-workspace --project=widget-loading-chromium --workers=1 --grep 'extended terminal session'
```

Use `3600000` for a one-hour run. The test writes `terminal-soak.json` beneath its
`test-results` directory and attaches it to the report. Leave other builds and test
suites idle during measurement. Compare revisions on the same machine and workload.

## Bundle cost of this revision

The widget shell measures 123.57 kB Brotli, within its existing 123.65 kB budget.
Chart-only tree shaking remains 87.23 KiB. No runtime dependencies were added.
The optional terminal chunk grows from 15.13 to 17.40 kB for shared service adapters
and bounded restoration; separately requested trading forms grow from 2.15 to 3.13 kB
for shared controls, account state and capability checks. Their explicit budgets are
17.45 and 3.16 kB. The classic-script widget inlines these optional ESM chunks and
therefore grows to 153.23 kB. These are measured costs, rather than unaccounted startup imports.
