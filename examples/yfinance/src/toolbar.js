import { el, esc, currentTheme, toggleTheme } from './ui.js';
import { attachTip, hideTip } from './hover.js';
import { cycleMagnet, magnetMode } from './rail.js';
import { INTERVALS, intervalLabel, intervalName, periodsFor, clampPeriod } from './intervals.js';
import { popupMenu } from './menus.js';
import { openCompare } from './compare.js';
import { enterReplay, askExitReplay } from './replay.js';
import { openSnapMenu } from './snapshot.js';
import { isSplit, openSplit, closeSplit } from './split.js';
import { describeLink, openLinkMenu } from './link.js';
import { openCacheMenu } from './feed.js';
import { openChartSettings } from './chart-settings.js';

let app;

// ══ toolbar shell ══════════════════════════════════════════════════════
// Buttons and popup menus rather than native <select>s: a select cannot show
// an icon per row, cannot group, and looks like a form control on a chart.
// The old fields still exist (hidden) so every existing handler keeps working;
// the shell just drives them.
export const TOOLBAR_ICON = {
  search: '<circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/>',
  download: '<path d="M10 3v9m0 0 3.2-3.2M10 12 6.8 8.8"/><path d="M3.5 14v2.5h13V14"/>',
  copy: '<rect x="6.5" y="6.5" width="9" height="9" rx="1.5"/><path d="M13 4.5H5A1.5 1.5 0 0 0 3.5 6v8"/>',
  candles: '<path d="M6 4v12M6 6h0"/><rect x="4" y="6" width="4" height="7"/><path d="M14 3v14"/><rect x="12" y="6" width="4" height="8"/>',
  bars: '<path d="M6 4v12M6 7h3M3 10h3"/><path d="M14 4v12M14 7h3M11 10h3"/>',
  line: '<path d="M3 14l4-5 4 3 6-8"/>',
  area: '<path d="M3 15l4-5 4 3 6-8v10z"/>',
  baseline: '<path d="M3 10h14"/><path d="M3 13l4-5 4 3 6-6"/>',
  renko: '<rect x="3" y="10" width="4" height="5"/><rect x="8" y="6" width="4" height="5"/><rect x="13" y="3" width="4" height="5"/>',
  pnf: '<path d="M3 4l4 4M7 4l-4 4"/><circle cx="10" cy="12" r="2"/><path d="M14 4l4 4M18 4l-4 4"/>',
  indicators: '<path d="M3 15l3-6 3 3 3-7 3 5 2-2"/>',
  save: '<path d="M4 4h9l3 3v9H4z"/><path d="M7 4v4h6V4M7 16v-5h6v5"/>',
  restore: '<path d="M4 10a6 6 0 1 1 2 4.5"/><path d="M3 6v4h4"/>',
  camera: '<rect x="3" y="6" width="14" height="10" rx="2"/><circle cx="10" cy="11" r="3"/><path d="M7 6l1.5-2h3L13 6"/>',
  fit: '<path d="M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4"/>',
  grid: '<path d="M3 8h14M3 12h14M8 3v14M12 3v14"/>',
  magnet: '<path d="M6 4v6a4 4 0 008 0V4"/><path d="M6 4h3v6M11 4h3v6"/>',
  chevron: '<path d="M6 8l4 4 4-4"/>',
  // Diagonal expand/collapse arrows, deliberately unlike `fit` (four corner
  // brackets), which is a different action and sits two buttons away.
  fullscreen: '<path d="M11 4h5v5"/><path d="M9 16H4v-5"/><path d="M16 4l-5.5 5.5"/><path d="M4 16l5.5-5.5"/>',
  fullscreenExit: '<path d="M16 9h-5V4"/><path d="M4 11h5v5"/><path d="M11 9l5-5"/><path d="M9 11l-5 5"/>',
  // Replay transport. A clock inside a rewinding arrow, then the four
  // buttons the bar itself uses.
  replay: '<path d="M3.2 10a6.8 6.8 0 1 1 2.2 5"/><path d="M3.2 6v4h4"/><path d="M10 7.5V10l1.8 1.2"/>',
  play: '<path d="M7.5 4.6l7.4 5.4-7.4 5.4z"/>',
  pause: '<path d="M7.6 4.6v10.8M12.4 4.6v10.8"/>',
  stepfwd: '<path d="M5.8 4.6l6.6 5.4-6.6 5.4z"/><path d="M14.6 4.6v10.8"/>',
  stepback: '<path d="M14.2 4.6l-6.6 5.4 6.6 5.4z"/><path d="M5.4 4.6v10.8"/>',
  exit: '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>',
  // Two series diverging from one another: the point of a comparison.
  compare: '<path d="M3 15.5l4-4.5 3.5 2.5L17 5"/><path d="M3 9.5l4 3 3.5-5.5L17 12"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4M15.2 15.2l-1.4-1.4M6.2 6.2L4.8 4.8"/>',
  // Two chain links: the group, not the layout.
  link: '<path d="M8.4 11.6a3 3 0 0 1 0-4.2l1.8-1.8a3 3 0 1 1 4.2 4.2l-.9.9"/><path d="M11.6 8.4a3 3 0 0 1 0 4.2l-1.8 1.8a3 3 0 1 1-4.2-4.2l.9-.9"/>',
  // One frame divided: the layout, not the group.
  split: '<rect x="2.5" y="4" width="15" height="12" rx="1.6"/><path d="M10 4v12"/>',
  // A stack of stored rows with a tick: something held, and held valid.
  cache: '<ellipse cx="10" cy="5.4" rx="6.2" ry="2.4"/><path d="M3.8 5.4v4.6c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4V5.4"/><path d="M3.8 10v4.6c0 1.3 2.8 2.4 6.2 2.4"/><path d="M13 15l1.8 1.8L18 13"/>',
  // The mirror of `download`: a layout file going the other way.
  upload: '<path d="M10 12V3m0 0 3.2 3.2M10 3 6.8 6.2"/><path d="M3.5 14v2.5h13V14"/>',
  // Sun and moon for the theme switch: the glyph shown is the theme you would switch to.
  sun: '<circle cx="10" cy="10" r="3.6"/><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1L4.7 4.7"/>',
  moon: '<path d="M16.5 12.2A6.6 6.6 0 0 1 7.8 3.5a6.6 6.6 0 1 0 8.7 8.7z"/>',
};
export const ticon = (k) => '<svg viewBox="0 0 20 20">' + (TOOLBAR_ICON[k] || '') + '</svg>';

export const CHART_TYPES = [
  { group: 'Time-indexed' },
  { v: 'candlestick', label: 'Candles', icon: 'candles' },
  { v: 'hollow-candle', label: 'Hollow candles', icon: 'candles' },
  { v: 'bar', label: 'Bars (OHLC)', icon: 'bars' },
  { v: 'high-low', label: 'High-Low', icon: 'bars' },
  { v: 'volume-candle', label: 'Volume candles', icon: 'candles' },
  { v: 'line', label: 'Line', icon: 'line' },
  { v: 'line-markers', label: 'Line + markers', icon: 'line' },
  { v: 'step', label: 'Step line', icon: 'line' },
  { v: 'area', label: 'Area', icon: 'area' },
  { v: 'hlc-area', label: 'HLC area', icon: 'area' },
  { v: 'baseline', label: 'Baseline', icon: 'baseline' },
  { group: 'Transforms' },
  { v: 't:heikin-ashi', label: 'Heikin Ashi', icon: 'candles' },
  { v: 't:renko', label: 'Renko', icon: 'renko' },
  { v: 't:range', label: 'Range bars', icon: 'renko' },
  { v: 't:line-break', label: 'Line break', icon: 'renko' },
  { v: 't:point-figure', label: 'Point & Figure', icon: 'pnf' },
  { v: 't:kagi', label: 'Kagi', icon: 'line' },
];

export const chartTypeLabel = (v) => (CHART_TYPES.find((t) => t.v === v) || { label: 'Candles' }).label;
export const chartTypeIcon = (v) => (CHART_TYPES.find((t) => t.v === v) || { icon: 'candles' }).icon;

/* ── chart-only full screen ────────────────────────────────────────────
   Full-screens the stage (rail + chart + legend) rather than the page, so
   the toolbar and the hint strip drop away and the plot gets the whole
   display. The chart's own ResizeObserver picks up the new box, so there is
   nothing to re-measure by hand. */
export const stageEl = () => document.querySelector('main.stage');
export const isChartFull = () => document.fullscreenElement === stageEl();

export function toggleChartFullscreen() {
  const stage = stageEl();
  if (!stage) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (stage.requestFullscreen) {
    // Fullscreen is user-gesture gated and blocked outright in some embeds.
    stage.requestFullscreen().catch((e) => {
      el('status').textContent = 'full screen unavailable: ' + (e && e.message ? e.message : e);
    });
  } else {
    el('status').textContent = 'full screen not supported by this browser';
  }
}

// The toolbar goes with the page, so the only way back would be Esc. Put a
// matching exit chip inside the stage, which is the part still on screen.
export function syncFullscreenChrome() {
  const stage = stageEl();
  if (!stage) return;
  let chip = el('fsexit');
  if (isChartFull()) {
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'fsexit';
      chip.className = 'fsexit';
      chip.innerHTML = ticon('fullscreenExit');
      attachTip(chip, { title: 'Exit full screen', chord: 'Esc', side: 'bottom' });
      chip.addEventListener('click', toggleChartFullscreen);
      stage.appendChild(chip);
    }
  } else if (chip) {
    chip.remove();
  }
}


/** Rebuild the top toolbar from the current state of the hidden controls. */
export function renderToolbar() {
  const bar = el('shellbar');
  const ctype = el('ctype').value;
  // #status starts in the hidden legacy bar and gets moved in here on the
  // first render -- so from the second call on it is a child of `bar`, and
  // wiping the bar would destroy it. Every el('status') after that returns
  // null, and load()'s first line is a write to it, so changing symbol /
  // timeframe / range silently did nothing. Detach it first, and recreate
  // it if an earlier render already ate it.
  const statusText = el('status') || Object.assign(document.createElement('span'), { id: 'status' });
  if (statusText.parentElement) statusText.parentElement.removeChild(statusText);
  bar.innerHTML = '';

  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.tabIndex = 0;
  brand.title = 'OpenAlgo Charts · yfinance demo';
  brand.innerHTML =
    '<span class="brand-mark"><svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M3 17.5 9 7l4 6.5L21 3v4.2l-8 10.3-4-6.5-3.6 6.5z"/></svg></span>'
    + '<span class="brand-name">OpenAlgo <em>yfinance</em></span>';
  bar.appendChild(brand);
  bar.appendChild(divider());

  // symbol
  const sym = tbtn(ticon('search') + '<b>' + esc((el('symbol').value || '').toUpperCase()) + '</b>', 'Change symbol');
  sym.addEventListener('click', () => {
    const box = el('symbol');
    box.classList.add('is-live');
    box.focus();
    box.select();
  });
  bar.appendChild(sym);
  bar.appendChild(divider());

  // interval pills
  const ig = document.createElement('div');
  ig.className = 'pills';
  for (const iv of INTERVALS) {
    const b = document.createElement('button');
    b.textContent = intervalLabel(iv);
    b.title = intervalName(iv);
    b.className = el('interval').value === iv ? 'is-on' : '';
    b.addEventListener('click', () => {
      el('interval').value = iv;
      el('period').value = clampPeriod(iv, el('period').value);
      app.load();
      renderToolbar();
    });
    ig.appendChild(b);
  }
  bar.appendChild(ig);

  // range menu
  const range = tbtn('<span>' + esc(el('period').value) + '</span>' + ticon('chevron'), 'History range');
  // Only offer ranges this interval can actually serve: an unavailable one
  // comes back empty from Yahoo, which reads as a broken chart.
  range.addEventListener('click', () => popupMenu(range, periodsFor(el('interval').value).map((p) => ({
    label: p, on: p === el('period').value,
    onSelect: () => { el('period').value = p; app.load(); renderToolbar(); },
  }))));
  bar.appendChild(range);
  bar.appendChild(divider());

  // chart type menu
  const ct = tbtn(ticon(chartTypeIcon(ctype)) + '<span>' + esc(chartTypeLabel(ctype)) + '</span>' + ticon('chevron'), 'Chart type');
  ct.addEventListener('click', () => popupMenu(ct, CHART_TYPES.map((t) => (t.group ? { group: t.group } : {
    label: t.label, icon: t.icon, on: t.v === ctype,
    onSelect: () => { el('ctype').value = t.v; el('ctype').dispatchEvent(new Event('change')); renderToolbar(); },
  }))));
  bar.appendChild(ct);

  // P&F box mode, only when it applies
  if (ctype === 't:point-figure') {
    const pf = tbtn('<span>' + esc(el('pfmode').selectedOptions[0].textContent) + '</span>' + ticon('chevron'), 'P&F box sizing');
    pf.addEventListener('click', () => popupMenu(pf, [...el('pfmode').options].map((o) => ({
      label: o.textContent, on: o.selected,
      onSelect: () => { el('pfmode').value = o.value; el('pfmode').dispatchEvent(new Event('change')); renderToolbar(); },
    }))));
    bar.appendChild(pf);
  }

  // indicators
  const ind = tbtn(ticon('indicators') + '<span>Indicators</span>', 'Add an indicator');
  ind.addEventListener('click', () => {
    const rows = [];
    let group = null;
    for (const o of el('indpick').options) {
      const g = o.parentElement.label;
      if (g && g !== group) { group = g; rows.push({ group: g }); }
      rows.push({
        label: o.textContent,
        onSelect: () => { el('indpick').value = o.value; el('indadd').click(); },
      });
    }
    popupMenu(ind, rows, { find: 'Search ' + (rows.length - new Set(rows.filter((r) => r.group).map((r) => r.group)).size) + ' indicators' });
  });
  bar.appendChild(ind);

  // compare: a second instrument on the price pane
  const cmp = tbtn(ticon('compare') + '<span>Compare</span>',
    app.comparisons.length ? `Comparing ${app.comparisons.map((c) => c.symbol).join(', ')}` : 'Compare a second symbol');
  if (app.comparisons.length) cmp.classList.add('is-on');
  cmp.addEventListener('click', openCompare);
  bar.appendChild(cmp);

  // replay: enter the session bar by bar, or leave and get the chart back
  const rp = tbtn(ticon('replay') + '<span>Replay</span>',
    app.replay ? 'Exit replay' : app.replayPicking ? 'Cancel bar selection' : 'Replay this session bar by bar');
  if (app.replay || app.replayPicking) rp.classList.add('is-on');
  rp.addEventListener('click', () => ((app.replay || app.replayPicking) ? askExitReplay() : enterReplay()));
  bar.appendChild(rp);

  // Snapshot. The chart is a picture people share, and the two things they
  // do with it are save it and paste it, so both are one click from here.
  const snap = tbtn(ticon('camera'), 'Chart snapshot');
  snap.addEventListener('click', (e) => { e.stopPropagation(); openSnapMenu(snap); });
  bar.appendChild(snap);

  // Split view and the link switches. Two controls over one group: the
  // toggle opens the second chart, the menu decides what crosses between
  // them. Both report "unavailable" against a dist/ without linking rather
  // than sitting there dead.
  const sp = iconBtn('split', app.linkGroup
    ? (isSplit() ? 'Close the second chart' : 'Open a second, linked chart')
    : 'Split view needs a dist/ with chart linking',
    () => (isSplit() ? closeSplit() : openSplit()));
  if (isSplit()) sp.classList.add('is-on');
  bar.appendChild(sp);

  const lk = iconBtn('link', app.linkGroup
    ? 'Chart linking (' + describeLink() + ')'
    : 'Chart linking needs a newer dist/',
    () => openLinkMenu(lk));
  if (app.linkGroup && isSplit() && describeLink() !== 'nothing synced') lk.classList.add('is-on');
  bar.appendChild(lk);

  // Bar cache. The counter is the point: a feature you can only feel as
  // "that seemed quicker" is a feature nobody can check.
  if (app.cache) {
    const s = app.cache.stats();
    const cc = tbtn(ticon('cache') + '<span>' + s.hits + '/' + (s.hits + s.misses) + '</span>',
      `Bar cache: ${s.hits} warm of ${s.hits + s.misses} loads, ${s.entries} series held`);
    if (s.hits > 0) cc.classList.add('is-on');
    cc.addEventListener('click', () => openCacheMenu(cc));
    bar.appendChild(cc);
  }
  bar.appendChild(divider());

  // view + layout icons
  bar.appendChild(iconBtn('fit', 'Reset view', () => app.chart && app.chart.resetScale()));
  // Anchor on the button that was clicked: by the time the handler runs,
  // bar.lastChild is whatever the toolbar appended last, not this button.
  bar.appendChild(iconBtn('grid', 'Grid', (ev) => {
    const v = el('vgrid'), h = el('hgrid');
    popupMenu(ev.currentTarget, [
      { label: 'Both', on: v.checked && h.checked, onSelect: () => { v.checked = h.checked = true; v.dispatchEvent(new Event('change')); h.dispatchEvent(new Event('change')); } },
      { label: 'Horizontal', on: !v.checked && h.checked, onSelect: () => { v.checked = false; h.checked = true; v.dispatchEvent(new Event('change')); h.dispatchEvent(new Event('change')); } },
      { label: 'Vertical', on: v.checked && !h.checked, onSelect: () => { v.checked = true; h.checked = false; v.dispatchEvent(new Event('change')); h.dispatchEvent(new Event('change')); } },
      { label: 'None', on: !v.checked && !h.checked, onSelect: () => { v.checked = h.checked = false; v.dispatchEvent(new Event('change')); h.dispatchEvent(new Event('change')); } },
    ]);
  }));
  // The magnet is the rail's three-way mode (off, weak, strong); this button
  // cycles it, so the shell and the rail can never disagree.
  const mg = iconBtn('magnet', 'Magnet: ' + magnetMode(), () => { cycleMagnet(); renderToolbar(); },
    'snaps anchors to O/H/L/C; off, weak, strong');
  if (magnetMode() !== 'off') mg.classList.add('is-on');
  bar.appendChild(mg);
  bar.appendChild(iconBtn('camera', 'Save PNG', () => el('save').click()));
  const fs = iconBtn(isChartFull() ? 'fullscreenExit' : 'fullscreen',
    isChartFull() ? 'Exit full screen (Esc)' : 'Full screen chart', toggleChartFullscreen);
  if (isChartFull()) fs.classList.add('is-on');
  bar.appendChild(fs);
  const light = currentTheme() === 'light';
  bar.appendChild(iconBtn(light ? 'moon' : 'sun', light ? 'Dark theme' : 'Light theme', () => { toggleTheme(); renderToolbar(); }));

  // Bracket entry. The buttons that own this live in the legacy sub-bar,
  // which is display:none, and a hidden ancestor takes its whole subtree out
  // of the box tree: they still fire when clicked programmatically, but a
  // user had no way to reach them, which also stranded the Trading tab's
  // entry and exit colours with nothing on the chart to recolour.
  bar.appendChild(divider());
  const buy = tbtn('<b>Buy</b>', 'Place a Buy OCO bracket: entry, target and stop');
  buy.classList.add('tbtn--buy');
  buy.addEventListener('click', () => el('buy').click());
  bar.appendChild(buy);
  const sell = tbtn('<b>Sell</b>', 'Place a Sell OCO bracket: entry, target and stop');
  sell.classList.add('tbtn--sell');
  sell.addEventListener('click', () => el('sell').click());
  bar.appendChild(sell);

  bar.appendChild(divider());
  bar.appendChild(iconBtn('gear', 'Chart settings (or right-click the chart)', () => openChartSettings()));
  bar.appendChild(iconBtn('save', 'Save layout', () => el('lsave').click()));
  bar.appendChild(iconBtn('restore', 'Restore layout', () => el('lload').click()));
  // The layout as a file, both ways. The legacy buttons own the work
  // (persist.js wires them); these only reach them, since the legacy bar
  // is display:none and a hidden button is one nobody can click.
  bar.appendChild(iconBtn('download', 'Export layout file', () => el('lexport').click()));
  bar.appendChild(iconBtn('upload', 'Import layout file', () => el('limport').click()));

  const status = document.createElement('div');
  status.className = 'status';
  status.innerHTML = '<span class="status-dot"></span>';
  status.appendChild(statusText);
  // The readout truncates on a narrow window, so the full line has to be
  // reachable. Copied on hover rather than on write: a dozen call sites
  // assign to #status directly and every one of them would have to remember.
  status.addEventListener('pointerenter', () => { status.title = statusText.textContent; });
  bar.appendChild(status);
}

export function tbtn(html, title, sub) {
  const b = document.createElement('button');
  b.className = 'tbtn';
  b.innerHTML = html;
  // Styled label rather than `title`: half of these buttons are a bare
  // glyph, and the native box arrives a second late in the wrong theme.
  attachTip(b, { title, sub, side: 'bottom' });
  return b;
}
export function iconBtn(icon, title, onClick, sub) {
  const b = tbtn(ticon(icon), title, sub);
  b.classList.add('tbtn--icon');
  b.addEventListener('click', onClick);
  return b;
}
export function divider() {
  const d = document.createElement('span');
  d.className = 'divider';
  return d;
}

export function initToolbar(a) {
  app = a;
  document.addEventListener('fullscreenchange', () => { hideTip(); syncFullscreenChrome(); renderToolbar(); });
}
