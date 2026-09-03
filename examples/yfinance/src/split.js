import * as engine from '/dist/openalgo-charts.mjs';
import { createChart } from '/dist/openalgo-charts.mjs';
import { DrawingController } from '/dist/openalgo-charts.draw.mjs';
import { el, esc, fmt, UP, DOWN, chartTheme } from './ui.js';
import { clipboardPort } from './clipboard.js';
import { armCursor, magnetMode, stayMode } from './rail.js';
import { fetchBars, fetchNote, feedErrorState } from './feed.js';
import { INTERVALS, intervalLabel, intervalName, clampPeriod } from './intervals.js';
import { tbtn, ticon, renderToolbar } from './toolbar.js';
import { popupMenu } from './menus.js';
import { LONG_NAMES } from './status.js';
import { volumeShown } from './volume.js';

// 1.3 surfaces: chart linking, the bar cache and the interval registry.
// Same namespace read for the same reason: this page must still draw
// against an older dist/ and say which features that dist cannot serve,
// rather than failing at link time and showing a blank document.
const { createLinkGroup } = engine;

let app;
let price2 = null;
let bars2 = [];

// ══ split view: a second chart in the same link group ═══════════════════
//
// Linking needs two charts before any of it can be seen, so the demo grows
// a second one. It is deliberately not a clone: its own instrument and its
// own timeframe are what make the group's one real design decision visible.
// Nothing crosses the boundary as a bar index, so an hourly follower and a
// daily leader sit on the same instant rather than on the same nth bar.
//
// The group is created once and outlives every chart in it: `render()`
// destroys and rebuilds the main chart on a chart-type switch, and the
// group prunes the corpse and takes the replacement.

export function initSplit(a) {
  app = a;
  app.linkGroup = createLinkGroup
    ? createLinkGroup({ crosshair: true, viewport: true, symbol: false, whenMissing: 'nearest' })
    : null;

  /* Drag the divider. Percent rather than pixels, so the split survives a
     window resize as a proportion instead of pinning one side. */
  (function splitDrag() {
    const bar = el('splitbar');
    let dragging = false;
    bar.addEventListener('pointerdown', (e) => {
      dragging = true;
      bar.classList.add('is-drag');
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const box = el('split').getBoundingClientRect();
      const pct = Math.min(78, Math.max(18, ((box.right - e.clientX) / box.width) * 100));
      el('pane2').style.flexBasis = pct + '%';
    });
    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('is-drag');
      if (e.pointerId !== undefined && bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
    };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
  })();
}

export const isSplit = () => app.chart2 !== null;

/**
 * Join (or re-join) both charts. Adding a chart already in the group only
 * refreshes its member options, so this is safe to call on every rebuild,
 * which is exactly what a chart-type switch needs.
 */
export function joinLink() {
  if (!app.linkGroup) return;
  if (app.chart) {
    app.linkGroup.add(app.chart, {
      symbol: app.req.symbol,
      // The group loads nothing itself: it hands the host a symbol and the
      // host fetches. This is the whole of the engine's symbol story.
      onSymbol: (sym) => {
        if (el('symbol').value === sym) return;
        el('symbol').value = sym;
        app.load();
      },
    });
  }
  if (app.chart2) {
    app.linkGroup.add(app.chart2, {
      symbol: app.p2.symbol,
      onSymbol: (sym) => {
        if (app.p2.symbol === sym) return;
        app.p2.symbol = sym;
        loadPane2();
      },
    });
  }
}

export async function openSplit() {
  if (!app.linkGroup) { el('status').textContent = 'this dist/ has no chart linking'; return; }
  if (isSplit()) return;
  el('pane2').hidden = false;
  el('splitbar').hidden = false;
  buildChart2();
  renderPane2Bar();
  renderToolbar();
  await loadPane2();
}

export function closeSplit() {
  if (app.chart2) {
    if (app.linkGroup) app.linkGroup.remove(app.chart2);
    if (app.draw2) { app.draw2.destroy(); app.draw2 = null; }
    app.chart2.destroy();
    app.chart2 = null; price2 = null; app.volume2 = null;
  }
  el('pane2').hidden = true;
  el('splitbar').hidden = true;
  el('chart2').innerHTML = '';
  el('p2legend').innerHTML = '';
  app.focusPane = 1;
  renderToolbar();
}

export function buildChart2() {
  if (app.chart2) { if (app.linkGroup) app.linkGroup.remove(app.chart2); app.chart2.destroy(); }
  if (app.draw2) { app.draw2.destroy(); app.draw2 = null; }
  el('chart2').innerHTML = '';
  app.chart2 = createChart(el('chart2'), {
    theme: chartTheme(),
    priceAxisWidth: 62,
    grid: { vertLines: el('vgrid').checked, horzLines: el('hgrid').checked },
    timezone: app.chartTimezone,
  });
  price2 = app.chart2.addSeries('candlestick');
  price2.setData(bars2);
  app.volume2 = app.chart2.addSeries('histogram', {
    paneIndex: 0, priceScaleId: '',
    style: { color: '#33415e', base: 0 }, priceFormat: { type: 'volume' },
  });
  app.volume2.priceScale().setOptions({ marginTop: 0.85, marginBottom: 0 });
  app.volume2.setData(bars2.map((b) => ({ time: b.time, open: 0, high: b.volume, low: 0, close: b.volume })));
  if (!volumeShown()) app.volume2.applyOptions({ visible: false });
  app.chart2.subscribeCrosshairMove((e) => setPane2Legend(e.bar ?? bars2[bars2.length - 1]));
  setPane2Legend(bars2[bars2.length - 1]);
  // A second drawing controller, so paste has somewhere else to land: the
  // in-memory clipboard is shared by every controller on the page, which is
  // what makes chart-to-chart paste work with the OS permission refused.
  // Seeded from the rail's modes, which the rail re-asserts on any
  // controller it later observes; the seed only keeps the first drawing on
  // this side from landing before that.
  app.draw2 = new DrawingController(app.chart2, { magnet: magnetMode(), stayInDrawingMode: stayMode(), clipboard: clipboardPort });
  app.chart2.on('draw:tool', ({ tool }) => armCursor(el('chart2'), tool));
  app.chart2.on('draw:add', () => { el('status').textContent = 'chart 2: ' + app.draw2.drawings().length + ' drawings'; });
  // No properties widget over here (it is glued to the main chart's box),
  // but the chords apply to whichever plot the pointer is over, so the
  // selection has to say so on this side too.
  app.chart2.on('draw:select', ({ id }) => {
    const d = id ? app.draw2.get(id) : null;
    if (d && typeof app.draw2.copy === 'function') {
      el('status').textContent = `chart 2: ${d.tool} selected · Ctrl+C copy · Ctrl+X cut · Ctrl+V paste`;
    }
  });
  joinLink();
}

export async function loadPane2() {
  if (!app.chart2) return;
  app.p2.period = clampPeriod(app.p2.interval, app.p2.period);
  setPane2Note('loading ' + app.p2.symbol + ' ' + intervalLabel(app.p2.interval) + '...');
  try {
    bars2 = await fetchBars(app.p2.symbol, app.p2.interval, app.p2.period, { slot: 'pane2' });
    const note = `${bars2.length} bars${fetchNote()}`;
    price2.setData(bars2);
    if (app.volume2) {
      app.volume2.setData(bars2.map((b) => ({ time: b.time, open: 0, high: b.volume, low: 0, close: b.volume })));
    }
    placePane2View();
    setPane2Legend(bars2[bars2.length - 1]);
    setPane2Note(note);
    renderPane2Bar();
    renderToolbar();   // this load counts towards the cache chip too
  } catch (e) {
    const fault = feedErrorState(e);
    if (fault.state === 'aborted') return;   // a newer load of this pane owns the note
    setPane2Note('error: ' + fault.message);
  }
}

/**
 * A freshly loaded follower fits its own content, and does so with sync
 * suspended, because a fit is not a pan. Two things went wrong without
 * this. Letting the fit broadcast threw the main chart off whatever window
 * the user had it on and replaced it with a month of the follower's
 * history, which reads as the split having broken the chart underneath it.
 * Adopting the leader's window instead is time-correct and looks broken for
 * the opposite reason: a year of daily bars mapped onto one month of hourly
 * ones leaves the follower's data as a sliver in the middle of an empty
 * plot. So the two windows start independent and converge on the first pan
 * or zoom, which is exactly what the group documents viewport sync to do.
 */
export function placePane2View() {
  withoutViewportSync(() => app.chart2.fitContent());
}

/** Run `fn` with viewport mirroring off, then put it back as it was. */
export function withoutViewportSync(fn) {
  if (!app.linkGroup || !app.linkGroup.options().viewport) { fn(); return; }
  app.linkGroup.setOptions({ viewport: false });
  try { fn(); } finally { app.linkGroup.setOptions({ viewport: true }); }
}

/* Kept on `p2` as well as on the node: renderPane2Bar() rebuilds the header
   from scratch, and the note would otherwise blank on every interval click. */
export function setPane2Note(text) {
  app.p2.note = text;
  const n = el('p2bar').querySelector('.p2note');
  if (n) n.textContent = text;
}

export function setPane2Legend(bar) {
  const host = el('p2legend');
  if (!bar) { host.innerHTML = ''; return; }
  const up = bar.close >= bar.open;
  host.innerHTML = '<b>' + esc(app.p2.symbol) + '</b> <span class="meta">' + esc(intervalLabel(app.p2.interval))
    + '</span> <span style="color:' + (up ? UP : DOWN) + '">' + fmt(bar.close) + '</span>'
    + ' <span class="meta">O ' + fmt(bar.open) + ' H ' + fmt(bar.high) + ' L ' + fmt(bar.low) + '</span>';
}

/** The second chart's own header: symbol, timeframe, bar count, close. */
export function renderPane2Bar() {
  const bar = el('p2bar');
  bar.innerHTML = '';
  const sym = tbtn(ticon('search') + '<b>' + esc(app.p2.symbol) + '</b>', 'Change this chart\'s symbol');
  sym.addEventListener('click', () => {
    const rows = Object.keys(LONG_NAMES).map((s) => ({
      label: s + '  ' + LONG_NAMES[s],
      on: s === app.p2.symbol,
      onSelect: () => {
        app.p2.symbol = s;
        // Announce first: with symbol sync on, the group carries it to the
        // main chart, and this member is already where it needs to be.
        if (app.linkGroup) app.linkGroup.setSymbol(app.chart2, s);
        renderPane2Bar();
        loadPane2();
      },
    }));
    popupMenu(sym, rows, { find: 'Search ' + rows.length + ' symbols' });
  });
  bar.appendChild(sym);

  const pills = document.createElement('div');
  pills.className = 'pills';
  for (const iv of INTERVALS) {
    const b = document.createElement('button');
    b.textContent = intervalLabel(iv);
    b.title = intervalName(iv);
    b.className = app.p2.interval === iv ? 'is-on' : '';
    b.addEventListener('click', () => {
      app.p2.interval = iv;
      app.p2.period = clampPeriod(iv, app.p2.period);
      renderPane2Bar();
      loadPane2();
    });
    pills.appendChild(b);
  }
  bar.appendChild(pills);

  const note = document.createElement('span');
  note.className = 'p2note';
  note.textContent = app.p2.note || '';
  bar.appendChild(note);

  const x = tbtn('&times;', 'Close the split view');
  x.classList.add('tbtn--icon');
  x.addEventListener('click', closeSplit);
  bar.appendChild(x);
}
