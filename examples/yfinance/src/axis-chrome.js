let app;
export function initAxisChrome(a) { app = a; }

// ── axis chrome ────────────────────────────────────────────────────────
// The corner clock and the countdown row inside the last-price tag are
// engine options: a chart that upgrades should keep drawing the axes it
// always drew, so neither turns itself on. The reference host is exactly
// where they should be visible, so the demo asks for both, and then carries
// whatever the settings dialog leaves behind across a chart rebuild the same
// way it carries the timezone.
const axisChrome = { sessionClock: true, barCountdown: true };
export function applyAxisChrome() {
  if (app.chart && typeof app.chart.setAxisChromeOptions === 'function') app.chart.setAxisChromeOptions(axisChrome);
}
export function syncAxisChromeFromChart() {
  if (app.chart && typeof app.chart.axisChromeOptions === 'function') Object.assign(axisChrome, app.chart.axisChromeOptions());
}

// The status-line switches and the trade palette are the chart's, and a
// chart-type switch throws the chart away: without these two copies, every
// Readout and Trading choice silently reverted the moment someone picked
// Heikin Ashi. Same contract as the timezone above - read back from the
// chart after a settings write, hand it back on the next build.
const statusLineChoice = {};
export function applyStatusLineChoice() {
  if (app.chart && Object.keys(statusLineChoice).length) app.chart.setStatusLineOptions(statusLineChoice);
}
export function syncStatusLineFromChart() {
  if (app.chart && typeof app.chart.statusLineOptions === 'function') Object.assign(statusLineChoice, app.chart.statusLineOptions());
}

// `tradingSettings()` answers in resolved names (`long`) and
// `setTradingSettings` takes patch names (`longColor`), so carrying the
// choice across a rebuild means translating between the two.
const TRADE_PATCH_KEY = {
  long: 'longColor', short: 'shortColor', order: 'orderColor',
  tp: 'tpColor', sl: 'slColor', buy: 'buyColor', sell: 'sellColor',
};
const tradeChoice = {};
export function applyTradeChoice() {
  if (app.chart && Object.keys(tradeChoice).length) app.chart.setTradingSettings(tradeChoice);
}
export function syncTradeChoiceFromChart() {
  if (!app.chart || typeof app.chart.tradingSettings !== 'function') return;
  const resolved = app.chart.tradingSettings();
  for (const key in TRADE_PATCH_KEY) tradeChoice[TRADE_PATCH_KEY[key]] = resolved[key];
}
