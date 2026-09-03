import * as engine from '/dist/openalgo-charts.mjs';
import { el, esc } from './ui.js';
import { renderInputRows } from './indicators.js';
import { descriptionOf, exchangeOf, marketStatusReading, previousSessionClose } from './status.js';
import { syncTimezoneFromChart } from './timezone.js';
import { syncAxisChromeFromChart, syncStatusLineFromChart, syncTradeChoiceFromChart } from './axis-chrome.js';
import { foldedInterval } from './intervals.js';
import { loadPane2 } from './split.js';
import { restyleTradeChrome } from './orders.js';
import { autosave } from './persist.js';

// Read off the namespace rather than named above on purpose: a missing named
// import fails the whole module at link time, and a demo served against a
// dist/ built before the settings schema shipped should still draw a chart
// and simply report the feature as unavailable.
const { chartSettingsSchema, readChartSettings, applyChartSettings } = engine;

let app;

// ── generated chart settings ───────────────────────────────────────────
// Nothing below names a control. `chartSettingsSchema(chart)` returns the
// tabs and their inputs, `readChartSettings` the current values and
// `applyChartSettings` takes a patch back, so a control the engine adds
// appears here on its own.
let chartSetTab = null;
let chartSetBefore = null;          // values as they were when the dialog opened
const chartSetDirty = new Set();    // keys this session touched, for Cancel

/**
 * A glyph per tab. Keyed by the schema's tab id rather than by position, so
 * reordering the tabs in the engine cannot silently shuffle the icons; a tab
 * this table does not know simply draws none.
 */
const CSET_ICON = {
  price: '<path d="M6 4v12"/><rect x="4" y="6.5" width="4" height="6.5"/><path d="M14 3v14"/><rect x="12" y="6" width="4" height="8"/>',
  readout: '<path d="M3 5h9M3 9h14M3 13h11"/>',
  axes: '<path d="M5 3v13h12"/><path d="M5 7h2M5 11h2M9 16v-2M13 16v-2"/>',
  appearance: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 9h14M8 4v12"/>',
  trading: '<path d="M3 13l4-4 3 2 6-6"/><path d="M13 5h3v3"/><path d="M4 16h12"/>',
};
const cseticon = (id) => '<svg viewBox="0 0 20 20">' + (CSET_ICON[id] || '') + '</svg>';

export function openChartSettings(tabId) {
  if (!app.chart) return;
  if (!chartSettingsSchema) { el('status').textContent = 'chart settings are not in this build of dist/'; return; }
  const tabs = chartSettingsSchema(app.chart);
  chartSetBefore = readChartSettings(app.chart);
  chartSetDirty.clear();
  chartSetTab = tabId || (tabs[0] && tabs[0].id);
  renderChartSettings();
  el('chartset').hidden = false;
}

export function renderChartSettings() {
  if (!app.chart) return;
  const tabs = chartSettingsSchema(app.chart);
  // Re-read on every paint: edits apply live, so switching tabs and coming
  // back has to show what the chart is actually drawing now.
  const values = readChartSettings(app.chart);
  const nav = el('cset-tabs');
  nav.innerHTML = '';
  for (const t of tabs) {
    const b = document.createElement('button');
    b.className = 'cset-tab' + (t.id === chartSetTab ? ' is-on' : '');
    b.innerHTML = cseticon(t.id) + '<span>' + esc(t.label) + '</span>';
    b.addEventListener('click', () => { chartSetTab = t.id; renderChartSettings(); });
    nav.appendChild(b);
  }
  const tab = tabs.find((t) => t.id === chartSetTab) || tabs[0];
  if (!tab) return;
  renderInputRows(el('cset-body'), tab.inputs, values, (key, value) => {
    chartSetDirty.add(key);
    applyChartSettings(app.chart, { [key]: value });
    afterChartSettingsWrite();
  }, chartSettingUnavailable);
}

/**
 * Why a chart-settings control cannot act on the chart as it stands, or null
 * when it can. Every colour on the Trading tab paints one piece of trade
 * chrome, and a demo with no position on it has no long line to recolour: the
 * swatch is drawn disabled with its value visible, which says "nothing here
 * yet", where an enabled swatch that changes no pixels says "this is broken".
 * Place a bracket or fill a market order and the same swatches come alive.
 */
export function chartSettingUnavailable(key, option) {
  if (key === 'statusLine.titleMode' && option === 'description') {
    return descriptionOf(app.req.symbol || '') ? null
      : 'no long name for ' + (app.req.symbol || 'this symbol').toUpperCase() + ' in this demo';
  }
  if (key === 'statusLine.marketStatus' && marketStatusReading() === undefined) {
    return 'no session hours for ' + exchangeOf(app.req.symbol || '');
  }
  if (key === 'statusLine.lastDayChange' && previousSessionClose() == null) {
    return 'no previous session in the loaded range';
  }
  const longPos = app.position && app.position.netQty > 0;
  const shortPos = app.position && app.position.netQty < 0;
  switch (key) {
    case 'trading.longColor': return longPos ? null : 'no long position on the chart';
    case 'trading.shortColor': return shortPos ? null : 'no short position on the chart';
    case 'trading.orderColor':
      return app.orders.length || app.bracket ? null : 'no resting order or bracket on the chart';
    case 'trading.tpColor': case 'trading.slColor':
      return app.bracket ? null : 'no bracket on the chart';
    case 'trading.buyColor':
      return app.fills.some((f) => f.shape === 'arrowUp') ? null : 'no buy execution on the chart';
    case 'trading.sellColor':
      return app.fills.some((f) => f.shape === 'arrowDown') ? null : 'no sell execution on the chart';
    default: return null;
  }
}

/**
 * What has to follow a settings write because it lives outside the schema.
 * The zone and the axis chrome are the engine's, but a chart-type switch
 * throws the chart away and rebuilds it, so the demo has to remember what
 * the controls chose. Reading them back beats mirroring the control, because
 * `setTimezone` refuses a zone the runtime does not know.
 */
export function afterChartSettingsWrite() {
  const zoneBefore = app.chartTimezone;
  syncTimezoneFromChart();
  const zoneMoved = app.chartTimezone !== zoneBefore;
  syncAxisChromeFromChart();
  syncStatusLineFromChart();
  syncTradeChoiceFromChart();
  if (app.priceLevels) app.priceLevels.setOptions({ timezone: app.chartTimezone });
  // A timezone change moves a calendar bucket's boundary, so a folded frame
  // has to be recomputed rather than relabelled: a month that starts at
  // local midnight in Kolkata does not start at local midnight in New York.
  // Guarded on the zone actually moving, or every colour edit would refetch.
  if (zoneMoved) {
    if (app.chart2 && typeof app.chart2.setTimezone === 'function') {
      try { app.chart2.setTimezone(app.chartTimezone); } catch (_) { /* zone the runtime rejects */ }
      if (foldedInterval(app.p2.interval)) loadPane2();
    }
    if (foldedInterval(el('interval').value)) app.load();
  }
  // The demo draws its own orders, bracket and position, so a Trading-tab
  // edit reaches them only because this asks it to.
  restyleTradeChrome();
}

/**
 * Restore the visible tab to the defaults the schema declares. The defaults
 * come off the same input descriptors the rows were built from, including
 * both halves and the switch of a paired colour, so this cannot drift from
 * what is on screen.
 */
export function restoreChartSettingsTab() {
  if (!app.chart) return;
  const tab = chartSettingsSchema(app.chart).find((t) => t.id === chartSetTab);
  if (!tab) return;
  const patch = {};
  for (const input of tab.inputs) {
    if (input.type === 'colorPair') {
      patch[input.up.key] = input.up.default;
      patch[input.down.key] = input.down.default;
      if (input.enabled) patch[input.enabled.key] = input.enabled.default;
    } else {
      patch[input.key] = input.default;
    }
  }
  // Marked dirty so Cancel still undoes it: a restore is an edit like any
  // other, not a new baseline.
  for (const key of Object.keys(patch)) chartSetDirty.add(key);
  applyChartSettings(app.chart, patch);
  afterChartSettingsWrite();
  renderChartSettings();
  el('status').textContent = tab.label.toLowerCase() + ' settings restored to defaults';
}

/**
 * Cancel puts back only the controls this session touched, rather than
 * replaying the whole snapshot: a wholesale write would also undo an axis
 * the user dragged or a scale they switched while the dialog was open.
 */
export function closeChartSettings(revert) {
  if (revert && app.chart && chartSetBefore) {
    const back = {};
    for (const key of chartSetDirty) back[key] = chartSetBefore[key];
    applyChartSettings(app.chart, back);
    afterChartSettingsWrite();
  }
  // The toolbar's grid switches drive a fresh chart's `grid` option, so they
  // have to follow whatever the Appearance tab left behind.
  if (app.chart && readChartSettings) {
    const now = readChartSettings(app.chart);
    el('vgrid').checked = now['canvas.grid.vertLines'] !== false;
    el('hgrid').checked = now['canvas.grid.horzLines'] !== false;
  }
  el('chartset').hidden = true;
  chartSetBefore = null;
  chartSetDirty.clear();
  autosave();
}

export function initChartSettings(a) {
  app = a;
  el('cset-defaults').addEventListener('click', restoreChartSettingsTab);
  el('cset-ok').addEventListener('click', () => closeChartSettings(false));
  el('cset-cancel').addEventListener('click', () => closeChartSettings(true));
  el('cset-x').addEventListener('click', () => closeChartSettings(true));
  el('chartset').addEventListener('click', (e) => { if (e.target.id === 'chartset') closeChartSettings(true); });
}
