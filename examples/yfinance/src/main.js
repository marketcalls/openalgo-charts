// Composition root of the yfinance demo. Creates the shared `app` state, wires
// every module to it in the order the page needs, and owns the two operations
// everything else reaches back to: render() builds the chart from the cached
// bars and load() fetches them.
import * as engine from '/dist/openalgo-charts.mjs';
import { createChart, PaneLegend } from '/dist/openalgo-charts.mjs';
// Lazy tiers. Each registers into the base bundle's registries as a side
// effect of being imported, so `addSeries('point-figure')` and
// `addIndicator('macd')` resolve afterwards. The transform and draw tiers are
// imported by the modules that call into them; the indicators tier is only
// ever registered, so it is imported here.
import '/dist/openalgo-charts.indicators.mjs';
import { el, fmt, round2, initShell, chartTheme, setChartState, toast } from './ui.js';
import { initHover } from './hover.js';
import { fillIntervalSelect, clampPeriod } from './intervals.js';
import { initFeed, fetchBars, fetchNote, feedErrorState } from './feed.js';
import { applyTransform } from './transforms.js';
import { initStatus, nameOf, symbolStatus } from './status.js';
import { DEFAULT_TZ, initTimezone } from './timezone.js';
import { initAxisChrome, applyAxisChrome, applyStatusLineChoice, applyTradeChoice } from './axis-chrome.js';
import { initVolume, volumeShown, setVolumeShown, setLegend } from './volume.js';
import {
  initOrders, saveState, restoreState, cancelOrder, attachOrderLines, removeAllOrders,
  updatePositionLine, restyleTradeChrome, clearPosition,
} from './orders.js';
import { initBracket, attachBracketLines, setBracketPrice, updateBracket, removeBracket } from './bracket.js';
import { initWatermark, placeWatermark } from './watermark.js';
import { initIndicators, fillIndicatorPicker, renderIndicatorChips, openSettings } from './indicators.js';
import { initChartSettings } from './chart-settings.js';
import { initCompare, attachComparison, removeComparison, syncComparisons } from './compare.js';
import { initSnapshot } from './snapshot.js';
import { initReplay, exitReplay, syncReplayBar, lastBar, movePick, startReplayAt } from './replay.js';
import { initSplit, joinLink } from './split.js';
import { initLink } from './link.js';
import { initClipboard } from './clipboard.js';
import { initMenus, openContextMenu } from './menus.js';
import { initPersist, datasetKey, readLayout, applyLayout } from './persist.js';
import { initToolbar, renderToolbar } from './toolbar.js';
import { initRail, buildRail } from './rail.js';
import { mountPropertiesBar } from './properties.js';
import { initDrawing, attachDrawing } from './drawing.js';

// Price-level family (previous close, session extremes, extended hours,
// bid/ask). Read off the namespace rather than named above on purpose: a
// missing named import fails the whole module at link time, and an older
// dist/ should still draw a chart, with the level submenus simply reporting
// themselves unavailable.
const { PriceLevels } = engine;
// 1.3 surfaces: chart linking, the bar cache and the interval registry.
// Same namespace read for the same reason: this page must still draw
// against an older dist/ and say which features that dist cannot serve,
// rather than failing at link time and showing a blank document.
const { createLinkGroup, withBarCache, barCloseSec, registerInterval, bucketStartOf } = engine;

/**
 * A tick size for the demo, by market. yfinance does not report one, and a
 * guess stated openly is better than a silent 0, which the price scale
 * reads as "work the precision out from the range".
 */
const tickFor = (sym) => (/\.(NS|BO)$/i.test(String(sym || '')) ? 0.05 : 0.01);
/**
 * What this dist/ cannot do. Collected rather than thrown so one missing
 * feature does not take the other three down with it, and reported once in
 * the status line: a demo that silently drops a control is exactly the
 * failure mode the controls are here to rule out.
 */
const MISSING = [];
if (!createLinkGroup) MISSING.push('chart linking');
if (!withBarCache || !barCloseSec) MISSING.push('bar cache');
if (!registerInterval || !bucketStartOf) MISSING.push('interval registry');

/**
 * The demo's shared state, created here and handed to every module's init.
 * A chart-type switch destroys and rebuilds the chart, so anything that has
 * to outlive a rebuild (the indicator specs, the zone, the trade chrome, the
 * comparisons) lives here rather than on the chart.
 */
const app = {
  // The chart and its two series. `volume` is null on a transform chart.
  chart: null,
  price: null,
  volume: null,
  // The price-level primitive on the price pane, plus the level styles as the
  // menu left them. The primitive belongs to the chart and dies with it; the
  // styles are the demo's, the way activeIndicators are, so a chart-type
  // switch does not quietly put every level back to its default.
  priceLevels: null,
  priceLevelState: {},
  // Active indicators, as {indicatorId, settings} specs. They are re-applied on
  // every chart rebuild (a chart-type switch destroys and recreates the chart),
  // which is also exactly what chart.getState()/restoreState() persists.
  activeIndicators: [{ indicatorId: 'halftrend', settings: {} }, { indicatorId: 'rsi', settings: {} }],
  // Resting orders placed by right-click: each is one draggable price line.
  orders: [],            // { id, side, type, price, qty, product, line }
  nextOrderId: 1,
  // Market fills build a net position (avg price) shown as a solid line + arrow markers.
  position: null,        // { netQty, avgPrice }
  posLine: null,         // PriceLine for the position
  fills: [],             // marker list for executed market orders
  markersApi: null,      // SeriesMarkers handle on the price series
  currentBars: [],       // cached so a chart-type switch needs no refetch
  idxByTime: new Map(),  // bar time -> array index (for previous-close lookup)
  req: {},               // last-loaded request (symbol/interval/period)
  // The chart's zone, mirrored: the engine persists it in getState(), but a
  // rebuilt chart starts on the default again unless it is handed back.
  chartTimezone: DEFAULT_TZ,
  // Row 0 of the price pane and the volume row. PaneLegends like every
  // indicator row, not a floating DOM box: an opaque overlay sat on top of the
  // indicator legends and hid them, whereas rows share one stack.
  symbolLegend: null,
  volLegend: null,
  bracket: null,         // { side, entry, target, stop, qty }
  bLines: null,          // { entry, tp, sl } price-line primitives on the current chart
  watermark: null,
  // { symbol, color, bars, handle, legend, byTime, hidden }. The spec survives
  // a chart rebuild and a saved layout; the handle and legend do not.
  comparisons: [],
  cmpMode: 'percentage',
  // Market replay: the controller, and the pick state while the user is
  // choosing the bar to start from. One shade per pane, because the future
  // has to be hidden on all of them.
  replay: null,
  replayPicking: false,
  replayPickIndex: null,
  replayShades: [],
  replayMark: null,
  // The link group and the second chart of the split view. A different
  // instrument AND a different timeframe from the main chart on purpose: an
  // hourly follower beside a daily leader is the only way to see that the
  // group crosses the boundary as an instant, not as a bar index.
  linkGroup: null,
  chart2: null,
  volume2: null,
  draw2: null,
  p2: { symbol: 'MSFT', interval: '1h', period: '1mo', note: '' },
  focusPane: 1,          // which plot the pointer is over, so a clipboard chord knows its target
  // The main chart's drawing controller, and the tool id -> chord table the
  // rail labels its rows from once the draw tier has answered.
  draw: null,
  shortcuts: {},
  cache: null,           // the bar cache wrapping the feed; null on a dist/ without one
  load: null,            // set below: the modules reach the loader through the app
};
app.load = load;

// The e2e suite drives the page through this handle, and only when asked to:
// a demo should not put its internals on window by default.
if (new URLSearchParams(location.search).get('test') === '1') {
  window.__oac = { get chart() { return app.chart; }, get draw() { return app.draw; }, app };
}

// (Re)build the chart for the currently selected type using cached bars.
function render() {
  // Leave replay first: stop() hands the driven series their real data back,
  // and it has to reach the chart that is about to be thrown away.
  exitReplay();
  if (app.chart) app.chart.destroy();
  // The primitives belonged to the destroyed chart; a stale handle would
  // leave the next selection updating a shade nothing draws.
  app.replayShades = [];
  app.replayMark = null;
  // The watermark too: placeWatermark() returns early while a handle is
  // held, and the one held belongs to the chart just destroyed, so without
  // this a chart-type switch came up with no logo.
  app.watermark = null;
  // The handles belong to the destroyed chart; the specs outlive it.
  for (const c of app.comparisons) { c.handle = null; c.legend = null; }
  el('chart').innerHTML = '';
  app.chart = createChart(el('chart'), {
    // DEFAULT_THEME is the light palette; the shell's switch decides which.
    theme: chartTheme(),
    priceAxisWidth: 72, // free crosshair (follows pointer)
    grid: { vertLines: el('vgrid').checked, horzLines: el('hgrid').checked },
    // A chart-type switch builds a new chart; the zone the user picked is
    // the demo's to carry across, like activeIndicators.
    timezone: app.chartTimezone,
  });
  applyAxisChrome();
  applyStatusLineChoice();   // before the legends: a row added later obeys the switches
  applyTradeChoice();

  // Row 0 of the price pane: symbol + interval + the O/H/L/C/V readout.
  // Added BEFORE any indicator so their legends stack beneath it
  // (`legendRowsOn` counts what is already there).
  // `status` is the host half of the status line: the mark, the two alternate
  // titles, the session state and the change since the previous close. The
  // legend draws nothing for a field with no data, so these switches are live
  // only because this hands them something.
  app.symbolLegend = new PaneLegend({ id: 'symbol', title: '', params: '', row: 0, actions: [], status: symbolStatus });
  app.chart.addPrimitive(app.symbolLegend, 0);

  // Previous close, session high/low and the rest. Off the namespace, so a
  // dist/ built before the family shipped leaves this null and the price-axis
  // menu says so instead of throwing.
  app.priceLevels = null;
  if (PriceLevels) {
    app.priceLevels = new PriceLevels({ timezone: app.chartTimezone, levels: app.priceLevelState });
    app.chart.addPrimitive(app.priceLevels, 0);
  }

  const sel = el('ctype').value;
  const isTransform = sel.startsWith('t:');
  el('pfmode').hidden = sel !== 't:point-figure';

  // Family-B transforms replace the plotted series with derived elements, so
  // the volume pane and trading overlay are hidden for them (a Renko brick or
  // a P&F column has no single source bar to hang volume off).
  const { type, data } = isTransform
    ? applyTransform(sel.slice(2), app.currentBars)
    : { type: sel, data: app.currentBars };

  const style = {};
  if (type === 'baseline') {
    const avg = app.currentBars.reduce((s, b) => s + b.close, 0) / (app.currentBars.length || 1);
    style.baseValue = avg;
  }
  app.price = app.chart.addSeries(type, { style }); // first series -> drives the OHLC legend
  app.price.setData(data);

  // Tell the engine the instrument's tick. Left unset, `minMove` is 0, which
  // means "infer precision from the visible range": the axis then renders a
  // decimal short on many instruments, drawings snap to an invented grid,
  // and an indicator reading `ctx.tickSize` is told nobody knows.
  //
  // yfinance carries no tick size, so this demo picks one by market and says
  // so plainly. A real host reads it from its own instrument master, the way
  // OpenAlgo reads tick_size out of its symbol table, rather than guessing.
  app.chart.setPriceScaleOptions({ minMove: tickFor(app.req.symbol) });
  if (!isTransform) {
    // Volume rides an OVERLAY price scale inside the price pane
    // (priceScaleId: '') rather than a pane of its own: it autoscales
    // independently but draws no axis, so the right-hand column stays a
    // clean price ladder instead of stacking a second numeric scale. The
    // 82% top margin pins the bars to the bottom fifth, and the `volume`
    // price format renders 200M rather than 200000000.
    app.volume = app.chart.addSeries('histogram', {
      paneIndex: 0,
      priceScaleId: '',
      style: { color: '#33415e', base: 0 },
      priceFormat: { type: 'volume' },
    });
    app.volume.priceScale().setOptions({ marginTop: 0.82, marginBottom: 0 });
    // A rebuild makes a fresh series, so the checkbox has to be re-applied
    // rather than assumed -- a chart-type switch would show it again.
    if (!volumeShown()) app.volume.applyOptions({ visible: false });
    app.volume.setData(app.currentBars.map((b) => ({ time: b.time, open: 0, high: b.volume, low: 0, close: b.volume })));
    // The eye is the only control the volume histogram has on the chart
    // itself, and it is the one a reader reaches for: the row is already
    // sitting over the bars it governs. No trash alongside it, because
    // volume here is a fixture of the price pane rather than a study that
    // can be re-added from a list, so a delete would only be a second
    // spelling of hide.
    app.volLegend = new PaneLegend({
      id: 'volume', title: 'Vol', params: '', actions: ['hide'], hidden: !volumeShown(),
    });
    app.chart.addPrimitive(app.volLegend, 0);
    app.markersApi = app.price.createMarkers(); // executed-fill arrows
    app.markersApi.setMarkers(app.fills);
  } else {
    app.volume = null;
    app.markersApi = null; // the old handle belongs to the destroyed chart
    app.volLegend = null;  // transforms have no per-bar volume to report
  }

  // Indicators come from the lazy 'openalgo-charts/indicators' tier. The chart
  // owns the whole lifecycle: it creates one series per plot, picks the pane,
  // draws declared reference levels (RSI 70/30), pins a declared fixed range
  // (RSI 0..100), and recomputes on every data change.
  if (!isTransform) {
    for (const spec of app.activeIndicators) {
      try { app.chart.addIndicator(spec.indicatorId, spec.settings); }
      catch (e) { console.warn('indicator', spec.indicatorId, e.message); }
    }
  }
  renderIndicatorChips();
  // Comparisons go on after the indicators, so their legend rows land under
  // the indicator rows rather than in the middle of them.
  for (const c of app.comparisons) attachComparison(c);
  placeWatermark();
  attachDrawing();

  // Chart trading: one drag handler routes both - drag a bracket leg -> move
  // that leg; drag a resting order line -> re-price that order. Both are redrawn
  // on the freshly-rebuilt chart.
  app.chart.subscribeDrag((externalId, p) => {
    if (externalId.startsWith('bk-')) { setBracketPrice(externalId.slice(3), p); return; }
    if (externalId.startsWith('order:')) {
      const o = app.orders.find((x) => `order:${x.id}` === externalId);
      if (o && o.line) { o.price = round2(p); o.line.setPrice(o.price); el('status').textContent = `${o.side} ${o.type} order -> ${fmt(o.price)}`; saveState(); }
    }
  });
  // Click the cancel box on a line: cancel that order, or close the position.
  app.chart.subscribeClick((id) => {
    // The canvas cannot hold an anchor, so the mark reports the hit and we
    // do the navigating. noopener: the opened tab must not reach back.
    if (id === 'watermark') {
      const href = app.watermark && app.watermark.href();
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    if (id === 'position::close') { clearPosition(); saveState(); el('status').textContent = 'position closed'; return; }
    // The volume row's eye. Ahead of the `::close` fallthrough below, which
    // reads any other `::close` as an order line's cancel box.
    if (id === 'volume::hide') { setVolumeShown(!volumeShown()); return; }
    // A comparison's legend row carries the same hide/close buttons every
    // other source's row does, so route them before the order lines.
    if (id.startsWith('cmp:')) {
      const spec = app.comparisons.find((c) => id.startsWith('cmp:' + c.symbol + '::'));
      if (!spec) return;
      if (id.endsWith('::close')) { removeComparison(spec); el('status').textContent = `removed ${spec.symbol}`; return; }
      if (id.endsWith('::hide')) {
        spec.hidden = spec.hidden !== true;
        spec.handle.series.applyOptions({ visible: !spec.hidden });
        spec.legend.setOptions({ hidden: spec.hidden });
      }
      return;
    }
    if (id.endsWith('::close')) cancelOrder(id.slice(0, -'::close'.length));
  });
  attachOrderLines();
  updatePositionLine(); // redraw the position line on the rebuilt chart
  if (app.bracket) {
    el('bracket').hidden = false;
    el('bk-entry').querySelector('[data-act="place"]').className = app.bracket.side === 'BUY' ? 'bk-buy' : 'bk-sell';
    attachBracketLines(); updateBracket();
  }
  // Fills come back from localStorage carrying the colour they were drawn in,
  // which may predate a Trading-tab edit or a whole release: put the restored
  // chrome on the palette the chart is actually using now.
  restyleTradeChrome();

  // The gear on a pane legend has no built-in dialog (the engine ships no
  // DOM), so it emits and we render the generated form.
  app.chart.on('indicatorSettings', ({ instanceId }) => openSettings(instanceId));
  // The close and trash buttons on a legend removes the indicator inside the chart, so
  // mirror that into our own spec list and refresh the chips.
  app.chart.on('indicatorRemoved', ({ indicatorId }) => {
    app.activeIndicators = app.activeIndicators.filter((s) => s.indicatorId !== indicatorId);
    renderIndicatorChips();
  });
  // Any change to the pane stack moves which pane is the bottom one.

  // Replay is headless: the controller emits, the transport bar and the
  // legend follow. `replay:stop` is here too, so the bar is correct for the
  // instant between stop() and exitReplay() tearing it down.
  for (const ev of ['replay:start', 'replay:frame', 'replay:play', 'replay:pause', 'replay:end', 'replay:stop']) {
    app.chart.on(ev, (s) => { syncReplayBar(); if (s && s.bar) setLegend(s.bar); });
  }

  // Right-click. The chart classifies what is under the pointer and hands
  // over the price, so one menu covers order entry, drawings and settings,
  // and taking this event over replaces the engine's save-image fallback,
  // which is exactly the trade a host raising its own menu wants.
  app.chart.on('contextmenu', (e) => { e.preventDefault(); openContextMenu(e); });

  // OHLC legend tracks the crosshair. The position P&L does NOT - it marks to
  // the LTP (the latest close here; with a live feed, update it on each tick).
  app.chart.subscribeCrosshairMove((e) => {
    setLegend(e.bar ?? lastBar());
    movePick(e.index);
  });
  // The pick is committed on a plain click. `subscribeClick` reports the
  // primitive that was hit, which is the wrong question here: the shade
  // deliberately reports no hit so the bar under it stays reachable.
  el('chart').addEventListener('click', () => {
    if (app.replayPicking && app.replayPickIndex !== null) startReplayAt(app.replayPickIndex);
  });
  setLegend(lastBar());
  // Last, because the chart that just replaced the destroyed one has to be
  // the one in the group: the old entry is a corpse the group prunes on its
  // next broadcast, and a linked grid that stops following after a
  // chart-type switch is the failure this call exists to prevent.
  joinLink();
  window.__chart = () => app.chart;
  window.__draw = () => app.draw;
  window.__chart2 = () => app.chart2;
  window.__link = () => app.linkGroup;
  window.__cache = () => app.cache;
}

async function load(opts) {
  const status = el('status');
  // Clamp here too, not just at the interval buttons: a saved layout or a
  // hand-set select can otherwise ask for a range the interval cannot serve.
  const interval = el('interval').value;
  const wanted = el('period').value;
  const period = clampPeriod(interval, wanted);
  if (period !== wanted) el('period').value = period;
  app.req = { symbol: el('symbol').value.trim(), interval, period };
  // Announced before the fetch, not after it: the follower starts loading
  // the same instrument in parallel instead of a second behind. Recorded
  // even with symbol sync off, so switching it on later converges on this
  // instrument rather than on a stale one.
  if (app.linkGroup && app.chart) app.linkGroup.setSymbol(app.chart, app.req.symbol);
  status.textContent = `loading ${app.req.symbol} ${app.req.interval}...`;
  setChartState('loading', app.req);
  try {
    // The main slot: a newer main load cancels the one in flight, so a
    // quick symbol switch cannot land the older answer on the newer name.
    const bars = await fetchBars(app.req.symbol, app.req.interval, app.req.period, { ...(opts || {}), slot: 'main' });
    // Read the cache verdict now: `syncComparisons()` below fetches too, and
    // `lastFetch` describes whichever load ran most recently, so composing
    // the line at the end would report the comparison's verdict as this
    // symbol's.
    const note = fetchNote();
    app.currentBars = bars;
    app.idxByTime.clear();
    bars.forEach((b, i) => app.idxByTime.set(b.time, i));
    removeBracket(); removeAllOrders(); clearPosition(); // detach old chart's lines + reset vars
    restoreState(app.req.symbol);                            // repopulate this symbol's saved orders/bracket/position
    // A comparison fetched at another interval has timestamps that cannot
    // match these bars, so drop the cache and let syncComparisons() refetch
    // rather than drawing a chart of pure whitespace on the way there.
    for (const c of app.comparisons) c.bars = [];
    render();
    setChartState(bars.length ? 'ready' : 'empty', app.req);
    // Re-apply the saved layout now the series exists: a logical viewport
    // means nothing on an empty chart, and the drawing controller reads its
    // model back out of the restored state. readLayout() upgrades an old
    // document and sets a corrupt one aside, so nothing here can throw.
    const saved = readLayout();
    if (saved) {
      applyLayout(saved, { keepView: saved.dataset === datasetKey(app.req), replaceComparisons: false });
      placeWatermark();
    }
    // After the restore, so a comparison saved in the layout is fetched too.
    await syncComparisons();
    renderToolbar();
    status.textContent = `${app.req.symbol} · ${bars.length} bars · ${app.req.interval}/${app.req.period}`
      + (period !== wanted ? `  (${wanted} unavailable at ${interval})` : '')
      + note
      + (MISSING.length ? `  ·  dist/ predates: ${MISSING.join(', ')}` : '');
  } catch (e) {
    const fault = feedErrorState(e);
    // A superseded load has nothing to report: the newer one owns the readout.
    if (fault.state === 'aborted') return;
    status.textContent = 'error: ' + fault.message;
    setChartState('error', { ...app.req, message: fault.message, retry: () => load(opts) });
    toast('error', `Could not load ${app.req.symbol}: ${fault.message}`);
  }
}

// Module wiring, in the order the original page registered its listeners.
initHover();
// Before the first render(): the shell sets the theme the chart is built in.
initShell(app);
initStatus(app);
initTimezone(app);
initAxisChrome(app);
initFeed(app);
initVolume(app);
initOrders(app);
initBracket(app);
initWatermark(app);
initIndicators(app);
initChartSettings(app);
initCompare(app);
initSnapshot(app);
initReplay(app);
initSplit(app);
initLink(app);
initClipboard(app);
initMenus(app);

// Wrapped, not passed: `load` now takes options, and handing it straight to
// addEventListener would pass a MouseEvent as the options bag.
el('load').addEventListener('click', () => load());
el('fit').addEventListener('click', () => { if (app.chart) app.chart.resetScale(); });
el('symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
// Export the full chart (all layers composited) - native right-click "Save image"
// only grabs the canvas under the pointer (the transparent crosshair overlay).
el('save').addEventListener('click', () => {
  if (!app.chart) return;
  const a = document.createElement('a');
  a.download = `${nameOf(app.req.symbol || 'chart')}_${(app.req.interval || '').toLowerCase()}.png`;
  a.href = app.chart.takeScreenshot().toDataURL('image/png');
  a.click();
});
// switching chart type / P&F box mode re-renders cached bars (no network round-trip)
['ctype', 'pfmode'].forEach((id) => el(id).addEventListener('change', () => { if (app.currentBars.length) render(); }));
// toggle grid lines live (no rebuild needed)
// The second chart is part of the same workspace, so a workspace switch
// reaches it too: a grid that is on in one pane and off in the other looks
// like a bug in the split, not like two charts.
const applyGrid = () => {
  const o = { vertLines: el('vgrid').checked, horzLines: el('hgrid').checked };
  if (app.chart) app.chart.setGridOptions(o);
  if (app.chart2) app.chart2.setGridOptions(o);
};
el('vgrid').addEventListener('change', applyGrid);
el('hgrid').addEventListener('change', applyGrid);
// Volume is hidden, not removed: the series keeps its data and its overlay
// price scale, so switching it back on is instant.
el('volshow').addEventListener('change', () => setVolumeShown(el('volshow').checked));
initPersist(app);

// Escape is the overlay stack's (ui.js): one layer per press, each closed
// through its own close control, so chart settings still revert.
initToolbar(app);
// The rail mounts the properties bar for the selected drawing on the stage,
// so a bar docked to it comes along into chart-only full screen.
initRail(app, { mountPropertiesBar });
initDrawing(app);
fillIntervalSelect();

buildRail();
fillIndicatorPicker();
renderToolbar();
// The symbol box is a floating editor raised by the toolbar button.
el('symbol').addEventListener('blur', () => { el('symbol').classList.remove('is-live'); renderToolbar(); });
el('symbol').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') { el('symbol').classList.remove('is-live'); renderToolbar(); }
});
load();
