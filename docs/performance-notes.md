# Performance notes

Findings for the release that adds a render benchmark and per-size budgets. Each
one was found by reading the code while the 2.5.5 measurements in
[browser endurance](browser-endurance.md) were recorded. None has been measured on
its own yet, so none is quoted as a cost. Read these before setting a budget, and
remove an entry once a change has dealt with it.

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
