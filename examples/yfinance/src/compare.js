import * as engine from '/dist/openalgo-charts.mjs';
import { PaneLegend } from '/dist/openalgo-charts.mjs';
import { el, esc, fmt, UP, DOWN } from './ui.js';
import { fetchBars } from './feed.js';
import { renderToolbar } from './toolbar.js';
import { autosave } from './persist.js';

// Read off the namespace rather than named above on purpose: a missing named
// import fails the whole module at link time, and a demo served against a
// dist/ built before comparison shipped should still draw a chart and simply
// report the feature as unavailable.
const { addComparison, comparisonController } = engine;

let app;

// ── multi-symbol comparison ────────────────────────────────────────────
// addComparison() is headless like the drawing and replay controllers: it
// owns the series, the timestamp alignment and the rebasing scales. What
// lives here is the symbol list, the legend rows and the scale choice.
export const CMP_COLORS = ['#e6b53c', '#7e57c2', '#29b6f6', '#ec407a', '#8bc34a'];

/** time -> { close, prevClose }, for the legend row under the crosshair. */
export function indexCompare(spec) {
  spec.byTime = new Map();
  let prevClose = null;
  for (const b of spec.bars || []) {
    spec.byTime.set(b.time, { close: b.close, prevClose: prevClose === null ? b.open : prevClose });
    prevClose = b.close;
  }
}

/** Put one instrument on the live chart, with a legend row of its own. */
export function attachComparison(spec) {
  if (!app.chart || !addComparison || !spec.bars || !spec.bars.length) return;
  // Settle the mode before the first add, so the pane is never briefly
  // rebased one way and then the other.
  if (comparisonController) comparisonController(app.chart, { mode: app.cmpMode }).setMode(app.cmpMode);
  try {
    spec.handle = addComparison(app.chart, {
      symbol: spec.symbol, bars: spec.bars, color: spec.color, style: { lineWidth: 1.5 },
    });
  } catch (e) {
    console.warn('[demo] compare failed:', spec.symbol, e.message);
    return;
  }
  // A PaneLegend, exactly like the symbol and volume rows: the comparison is
  // another source on this pane, so it reads as one.
  spec.legend = new PaneLegend({
    id: 'cmp:' + spec.symbol, title: spec.symbol, params: '',
    color: spec.color, actions: ['hide', 'close'], hidden: spec.hidden === true,
  });
  app.chart.addPrimitive(spec.legend, 0);
  if (spec.hidden) spec.handle.series.applyOptions({ visible: false });
}

/** Comparison readings for the hovered bar, in the instrument's own prices. */
export function setCompareLegends(bar) {
  for (const c of app.comparisons) {
    if (!c.legend) continue;
    const hit = bar && c.byTime ? c.byTime.get(bar.time) : null;
    if (!hit) { c.legend.setValues([]); continue; }
    const chg = hit.prevClose ? ((hit.close - hit.prevClose) / hit.prevClose) * 100 : 0;
    c.legend.setValues([
      { text: fmt(hit.close), color: c.color, field: 'ohlc' },
      { text: `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`, color: chg >= 0 ? UP : DOWN, field: 'change' },
    ]);
  }
}

export function removeComparison(spec) {
  if (spec.handle) spec.handle.remove();
  if (spec.legend && app.chart) app.chart.removePrimitive(spec.legend);
  spec.handle = null; spec.legend = null;
  app.comparisons = app.comparisons.filter((c) => c !== spec);
  renderCompareList();
  autosave();
}

/** Fetch what is missing and (re)attach every comparison to the live chart. */
export async function syncComparisons() {
  for (const c of app.comparisons) {
    if (!c.bars || !c.bars.length) {
      try {
        c.bars = await fetchBars(c.symbol, app.req.interval, app.req.period);
      } catch (e) {
        console.warn('[demo] compare fetch failed:', c.symbol, e.message);
        c.bars = [];
      }
    }
    indexCompare(c);
    if (c.handle) c.handle.setBars(c.bars);
    else attachComparison(c);
  }
  renderCompareList();
}

export async function addCompareSymbol(symbol) {
  const sym = String(symbol || '').trim();
  if (!sym || !app.chart) return;
  if (!addComparison) { el('status').textContent = 'compare is not in this build of dist/'; return; }
  if (app.comparisons.some((c) => c.symbol === sym.toUpperCase())) {
    el('status').textContent = `${sym.toUpperCase()} is already on the chart`;
    return;
  }
  el('status').textContent = `loading ${sym}...`;
  let bars;
  try {
    bars = await fetchBars(sym, app.req.interval, app.req.period);
  } catch (e) {
    el('status').textContent = 'compare failed: ' + e.message;
    return;
  }
  const spec = { symbol: sym.toUpperCase(), color: CMP_COLORS[app.comparisons.length % CMP_COLORS.length], bars };
  indexCompare(spec);
  app.comparisons.push(spec);
  attachComparison(spec);
  renderCompareList();
  renderToolbar();
  autosave();
  // Coverage is worth saying out loud: a comparison on a different holiday
  // calendar silently loses prints, and `alignment()` is how you find out.
  const a = spec.handle ? spec.handle.alignment() : null;
  el('status').textContent = a
    ? `${spec.symbol} · ${a.matched} matched · ${a.gaps} gap(s) · ${a.dropped} dropped`
    : `${spec.symbol} could not be added`;
}

export function setCompareMode(mode) {
  app.cmpMode = mode;
  if (app.chart && comparisonController) comparisonController(app.chart).setMode(mode);
  autosave();
}

export function renderCompareList() {
  const host = el('cmp-list');
  if (!host) return;
  host.innerHTML = '';
  if (!app.comparisons.length) {
    const none = document.createElement('div');
    none.className = 'hint';
    none.textContent = 'nothing yet';
    host.appendChild(none);
  }
  for (const c of app.comparisons) {
    const a = c.handle ? c.handle.alignment() : null;
    const row = document.createElement('div');
    row.className = 'cmp-row';
    row.innerHTML =
      '<span class="sw" style="background:' + esc(c.color) + '"></span>' +
      '<b>' + esc(c.symbol) + '</b>' +
      '<span class="cmp-cov">' + (a ? `${a.matched} of ${a.bars}` + (a.dropped ? ` · ${a.dropped} dropped` : '') : 'not on the chart') + '</span>';
    const x = document.createElement('button');
    x.className = 'cmp-del';
    x.textContent = '×';
    x.title = 'remove';
    x.addEventListener('click', () => removeComparison(c));
    row.appendChild(x);
    host.appendChild(row);
  }
  el('cmp-mode').value = app.cmpMode;
}

export function openCompare() {
  if (!addComparison) { el('status').textContent = 'compare is not in this build of dist/'; return; }
  renderCompareList();
  el('cmpmodal').hidden = false;
  el('cmp-sym').value = '';
  el('cmp-sym').focus();
}
export const closeCompare = () => { el('cmpmodal').hidden = true; };

export function initCompare(a) {
  app = a;
  el('cmp-add').addEventListener('click', () => addCompareSymbol(el('cmp-sym').value));
  el('cmp-sym').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addCompareSymbol(el('cmp-sym').value); }
  });
  el('cmp-mode').addEventListener('change', () => setCompareMode(el('cmp-mode').value));
  el('cmp-x').addEventListener('click', closeCompare);
  el('cmp-close').addEventListener('click', closeCompare);
  el('cmpmodal').addEventListener('click', (e) => { if (e.target.id === 'cmpmodal') closeCompare(); });
}
