import { LogoWatermark } from '/dist/openalgo-charts.mjs';

let app;
export function initWatermark(a) { app = a; }

// The watermark is CHART furniture, not pane furniture, so it is anchored to
// the chart's bottom edge and the engine re-homes it as panes come and go.
//
// This used to be a placeWatermark() that removed and re-added the primitive
// on the last pane, called again after every operation that might have added
// one. That is the boilerplate openalgo-charts#1 was filed about; the anchor
// replaced it, and maximize now works too, which the manual version could
// not handle because maximizing hides the other panes entirely.
export function placeWatermark() {
  if (!app.chart || app.watermark) return;
  app.watermark = new LogoWatermark({
    // The symbol-only asset has a square viewBox tight to the mark, so
    // height alone gives 32x32; 3 of padding puts it in a 38x38 plate.
    src: '/examples/openalgo-glyph.svg', height: 32, opacity: 0.85,
    position: 'bottom-left', margin: 6, padding: 3,
    // Mark alone at rest; the wording unrolls to its right on hover. The
    // mark and text share one colour, so setting either sets both.
    label: 'OpenAlgo Charts',
    labelColor: '#e4e8f4',
    href: 'https://openalgo.in',
  });
  app.chart.addPrimitive(app.watermark, { anchor: 'chart-bottom' });
}
