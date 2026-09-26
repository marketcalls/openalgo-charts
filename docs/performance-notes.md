# Performance notes

Findings for the release that adds a render benchmark and per-size budgets. Each
one was found by reading the code while the 2.5.5 measurements in
[browser endurance](browser-endurance.md) were recorded. None has been measured on
its own yet, so none is quoted as a cost. Read these before setting a budget, and
remove an entry once a change has dealt with it.

## Markers map the whole history on every paint

`SeriesMarkers.draw` in `src/primitives/markers.ts` builds a map from bar
time to bar on every paint. It fills the map from `dataLayer.indexedBars(seriesId)`,
which allocates one object per bar in the series' whole history, and from the
fallback bars when a marker set has them. It then tests every marker against the
visible range one at a time. The work therefore grows with the history length and
the marker count, not with the bars in view, and it repeats on every base repaint
of the pane, which includes every live tick (ARCHITECTURE.md §3.2).

The endurance workload attaches no markers, so the recorded frame times do not
include this cost. To see it, add a marker set of realistic size to a benchmark
workload and compare frame times at 2,000 and 50,000 bars with the view held at
150 bars. A fix would read only the visible range (`visibleBars`), plus the styled
markers that are laid out whatever their position, or keep the map until the
series data changes.

## The painted-chart gate also hashes the price axis

`paintProbe` in `scripts/fixtures/browser-endurance.html` hashes every pixel of each
chart's first canvas, which is the price pane's base canvas. The price-axis strip
is painted on that same canvas, so a moving last-price tag changes the hash while
the plot itself stays frozen. The canvas-changed gate can therefore pass on the
axis alone; only the candle-pixel count shows that candles were painted. The
comment in `paintProbe` says the axis has its own canvas, which has not been true
since the axes moved onto the base canvas.

The fixture belongs to the harness, and this change leaves it as it is. The fix is
to hash only the plot rectangle, excluding the axis strip's width, and to correct
the comment. A report produced before that fix still stands for its candle-pixel
and screenshot evidence.
