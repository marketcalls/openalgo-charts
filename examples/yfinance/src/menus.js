import * as engine from '/dist/openalgo-charts.mjs';
import { el, fmt, round2, esc, inTextField } from './ui.js';
import { ticon } from './toolbar.js';
import { openSettings } from './indicators.js';
import { openChartSettings } from './chart-settings.js';
import { volumeShown, setVolumeShown } from './volume.js';
import { placeOrder, removeAllOrders, clearPosition, saveState } from './orders.js';
import { removeBracket } from './bracket.js';
import { clipboardAction } from './clipboard.js';
import { autosave } from './persist.js';

// Price-level family (previous close, session extremes, extended hours,
// bid/ask). Read off the namespace for the same reason as the block above:
// an older dist/ should still draw a chart, with the level submenus simply
// reporting themselves unavailable.
const { PRICE_LEVEL_KINDS, lastPriceLevelFromSeriesStyle, seriesStyleForLastPriceLevel } = engine;

let app;
// The three menu hosts. Looked up once the document is ready, in initMenus.
let ctxMenu = null;
let axMenu = null;
let axSub = null;

// ── right-click menu: order entry, drawings, settings ──────────────
// Raised from the chart's own `contextmenu` event rather than a DOM listener
// on the container. The event carries the price, the pane and a classified
// target, which is the part a canvas cannot tell a host by itself: it is how
// the indicator row below knows which instance was under the pointer.
let ctxPrice = 0;
let ctxIndicator = null;   // instance id when the pointer was over an indicator
export const hideCtx = () => { ctxMenu.hidden = true; };

export function openContextMenu(e) {
  const rect = el('chart').getBoundingClientRect();
  const target = e.target || { kind: 'empty' };
  // A price ladder gets its own menu. The chart is what knows a click landed
  // on an axis strip and which of the pane's scales that strip draws, so this
  // is the one branch that cannot be worked out from the pointer alone.
  if (target.kind === 'price-scale') { openAxisMenu(e, target); return; }
  closeAxisMenu();
  // Off the plot (on a scale) there is no price, so the order rows would be
  // offering to trade at nothing.
  const tradable = e.price != null && app.currentBars.length > 0;
  ctxPrice = tradable ? round2(e.price) : 0;
  for (const b of ctxMenu.querySelectorAll('button[data-type]')) {
    b.hidden = !tradable;
    const verb = b.getAttribute('data-side') === 'BUY' ? 'Buy' : 'Sell';
    const type = b.getAttribute('data-type');
    b.textContent = type === 'MARKET' ? `${verb} Market`
      : type === 'LIMIT' ? `${verb} Limit @ ${fmt(ctxPrice)}`
      : `${verb} Stop (SL) @ ${fmt(ctxPrice)}`;
  }
  for (const hr of ctxMenu.querySelectorAll('hr[data-sec="order"]')) hr.hidden = !tradable;

  // Hide the drawing rows when there is nothing to act on, so the menu
  // never offers a dead option.
  const nDraw = app.draw ? app.draw.drawings().length : 0;
  const selId = app.draw ? app.draw.selected() : null;
  const rowAll = ctxMenu.querySelector('[data-act="delall"]');
  const rowSel = ctxMenu.querySelector('[data-act="delsel"]');
  rowAll.hidden = nDraw === 0;
  rowSel.hidden = !selId;
  rowSel.previousElementSibling.hidden = nDraw === 0;   // the separator above the pair
  if (nDraw > 0) rowAll.textContent = `Remove All Drawings (${nDraw})`;

  // Clipboard rows. Copy and cut need a selection; paste does not, because
  // whether there is anything of ours to paste can only be known by asking
  // the clipboard, which is asynchronous. A dist/ whose controller has no
  // copy() hides the three rather than offering three dead options.
  const clipOk = app.draw && typeof app.draw.copy === 'function';
  for (const act of ['copy', 'cut']) {
    ctxMenu.querySelector(`[data-act="${act}"]`).hidden = !clipOk || !selId;
  }
  ctxMenu.querySelector('[data-act="paste"]').hidden = !clipOk;
  ctxMenu.querySelector('hr[data-sec="clip"]').hidden = !clipOk;

  // The indicator row appears only where there is an indicator to settle.
  ctxIndicator = target.kind === 'indicator' ? target.instanceId : null;
  const rowInd = ctxMenu.querySelector('[data-act="indset"]');
  rowInd.hidden = !ctxIndicator;
  ctxMenu.querySelector('hr[data-sec="ind"]').hidden = !ctxIndicator;
  if (ctxIndicator) {
    const inst = app.chart.indicators().find((i) => i.id === ctxIndicator);
    rowInd.textContent = (inst ? inst.name : 'Indicator') + ' settings...';
  }

  // Volume is a fixture of a time-indexed chart only: a Renko brick or a
  // P&F column has no source bar to hang it off, so `render()` leaves the
  // series null and the row would have nothing to switch.
  const rowVol = ctxMenu.querySelector('[data-act="volshow"]');
  rowVol.hidden = !app.volume;
  ctxMenu.querySelector('hr[data-sec="vol"]').hidden = !app.volume;
  rowVol.classList.toggle('is-on', volumeShown());
  rowVol.querySelector('em').textContent = volumeShown() ? 'Shown' : 'Hidden';

  // Unhide first, then measure: the menu's height depends on which rows
  // above survived, so a fixed clamp would be wrong for most of them.
  ctxMenu.hidden = false;
  ctxMenu.style.left = Math.max(4, Math.min(rect.left + e.point.x, window.innerWidth - ctxMenu.offsetWidth - 8)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(rect.top + e.point.y, window.innerHeight - ctxMenu.offsetHeight - 8)) + 'px';
}

// ── price-axis menu ────────────────────────────────────────────────────
// Everything here reads `chart.priceAxisState(pane, scale)` and writes back
// through the matching `priceAxis*` calls, so the menu can never claim a
// state the axis is not in. Nothing is hardcoded per axis: the same code
// serves the price ladder, a left-hand scale, and an indicator pane's.
// Which axis the menu (and the chords, which have no pointer) act on. The
// price ladder of the main pane until a right-click names another.
let axTarget = { paneIndex: 0, scaleId: 'right' };
let axSubHalf = null;   // 'line' | 'label' while a level flyout is open

const AX_TICK = '<svg viewBox="0 0 20 20"><path d="M4 10.5l4 4 8-9"/></svg>';
/**
 * The four modes as one choice. A radio group and not four switches: the
 * scale holds exactly one mode, and four checkboxes would let a user ask for
 * a state the engine cannot be in.
 */
export const AX_MODES = [
  { value: 'linear', label: 'Linear', chord: 'Alt+R' },
  { value: 'logarithmic', label: 'Logarithmic', chord: 'Alt+L' },
  { value: 'percentage', label: 'Percent', chord: 'Alt+P' },
  { value: 'indexed-to-100', label: 'Indexed to 100', chord: 'Alt+1' },
];
const AX_AUTOFIT_CHORD = 'Alt+A';
const AX_INVERT_CHORD = 'Alt+I';
/** Our wording for the level family, in the order the engine lists it. */
export const LEVEL_LABEL = {
  previousClose: 'Previous close',
  sessionHigh: 'Session high',
  sessionLow: 'Session low',
  lastPrice: 'Last price',
  preMarketOpen: 'Pre-market open',
  preMarketClose: 'Pre-market close',
  postMarketOpen: 'Post-market open',
  postMarketClose: 'Post-market close',
  bid: 'Bid',
  ask: 'Ask',
};
const levelKinds = () => PRICE_LEVEL_KINDS || Object.keys(LEVEL_LABEL);

export const axisState = () => (app.chart && typeof app.chart.priceAxisState === 'function')
  ? app.chart.priceAxisState(axTarget.paneIndex, axTarget.scaleId)
  : null;

/**
 * One menu row. `mark` picks the marker column: a tick for a switch, a dot
 * for one option of a choice. The column is drawn either way, so the labels
 * keep one left edge whether anything is set or not.
 */
function axRow(o) {
  const b = document.createElement('button');
  b.className = 'axrow' + (o.on ? ' is-on' : '');
  b.disabled = o.disabled === true;
  const mark = document.createElement('span');
  mark.className = 'axmark';
  if (o.mark === 'radio') {
    const dot = document.createElement('span');
    dot.className = 'axdot';
    mark.appendChild(dot);
  } else if (o.on) {
    mark.innerHTML = AX_TICK;
  }
  const name = document.createElement('span');
  name.className = 'axname';
  name.textContent = o.label;
  b.append(mark, name);
  // Why a row is dead is worth a word: an empty greyed row reads as a bug.
  if (o.note) {
    const note = document.createElement('span');
    note.className = 'axnote';
    note.textContent = o.note;
    b.appendChild(note);
  }
  if (o.chord) {
    const chord = document.createElement('span');
    chord.className = 'chord';
    chord.textContent = o.chord;
    b.appendChild(chord);
  }
  if (o.submenu) {
    const arrow = document.createElement('span');
    arrow.className = 'axarrow';
    arrow.textContent = '>';
    b.appendChild(arrow);
    b.dataset.submenu = o.submenu;   // so a repaint can find the open row again
    b.addEventListener('pointerenter', () => openAxisSub(o.submenu, b));
    b.addEventListener('click', () => openAxisSub(o.submenu, b));
  } else {
    // Only rows of the parent menu dismiss the flyout on hover. Wiring this
    // to every row would make the flyout close the moment the pointer
    // reached one of its own, which is what a level row is for.
    if (o.closesSub) b.addEventListener('pointerenter', closeAxisSub);
    if (o.onSelect) b.addEventListener('click', o.onSelect);
  }
  return b;
}

const axSeparator = () => document.createElement('hr');
function axHead(text) {
  const h = document.createElement('div');
  h.className = 'axhead';
  h.textContent = text;
  return h;
}

function paintAxisMenu() {
  const s = axisState();
  axMenu.innerHTML = '';
  if (!s) {
    axMenu.appendChild(axRow({
      label: 'Price-axis controls', disabled: true, note: 'not in this build of dist/',
    }));
    return;
  }
  const add = (o) => axMenu.appendChild(axRow({ closesSub: true, ...o }));

  add({
    label: 'Auto-fit to the data', on: s.autoFit, chord: AX_AUTOFIT_CHORD,
    onSelect: () => runAxis(() => setAxisAutoFit(!s.autoFit)),
  });
  add({
    label: 'Invert', on: s.inverted, chord: AX_INVERT_CHORD,
    onSelect: () => runAxis(() => setAxisInvert(!s.inverted)),
  });
  // Our own words for holding the price-per-bar ratio while the time axis
  // zooms. Nothing has been measured on an empty pane, so there is no ratio
  // to hold: the row stays, greyed, saying why.
  add({
    label: 'Pin price per bar', on: s.lockRatio, disabled: !s.scaled,
    note: s.scaled ? '' : 'nothing measured',
    onSelect: () => runAxis(() => setAxisLockRatio(!s.lockRatio)),
  });

  axMenu.appendChild(axSeparator());
  axMenu.appendChild(axHead('Scale'));
  for (const m of AX_MODES) {
    add({
      mark: 'radio', label: m.label, on: s.mode === m.value, chord: m.chord,
      onSelect: () => runAxis(() => setAxisMode(m.value)),
    });
  }

  axMenu.appendChild(axSeparator());
  add({
    label: s.side === 'right' ? 'Move the scale to the left' : 'Move the scale to the right',
    disabled: !s.movable,
    note: s.movable ? '' : (s.active ? 'other side taken' : 'nothing on this side'),
    onSelect: () => runAxis(moveAxisToOtherSide),
  });

  axMenu.appendChild(axSeparator());
  axMenu.appendChild(axHead('Price levels'));
  add({ label: 'Lines on the plot', submenu: 'line' });
  add({ label: 'Tags on the axis', submenu: 'label' });

  axMenu.appendChild(axSeparator());
  add({
    label: 'Axis settings...',
    onSelect: () => { closeAxisMenu(); openChartSettings('axes'); },
  });
}

/** Run an axis action, then repaint whatever is on screen showing its state. */
function runAxis(action) {
  action();
  if (!axMenu.hidden) paintAxisMenu();
  if (!axSub.hidden) { paintAxisSub(); markOpenSubRow(); }
  autosave();
}

/** Re-mark the parent row a flyout belongs to; a repaint replaced the node. */
function markOpenSubRow() {
  for (const r of axMenu.querySelectorAll('.axrow')) {
    r.classList.toggle('is-open', r.dataset.submenu === axSubHalf);
  }
}

// ── the actions themselves ─────────────────────────────────────────────
export function setAxisMode(mode) {
  const s = axisState();
  if (!s) return;
  app.chart.setPriceAxisOptions(s.paneIndex, s.scaleId, { mode });
  const m = AX_MODES.find((x) => x.value === mode);
  el('status').textContent = 'price scale: ' + (m ? m.label.toLowerCase() : mode);
}

export function setAxisInvert(on) {
  const s = axisState();
  if (!s) return;
  app.chart.setPriceAxisOptions(s.paneIndex, s.scaleId, { inverted: on });
  el('status').textContent = on ? 'price scale inverted' : 'price scale upright';
}

export function setAxisAutoFit(on) {
  const s = axisState();
  if (!s) return;
  app.chart.setPriceAxisAutoFit(s.paneIndex, s.scaleId, on);
  el('status').textContent = on ? 'price scale auto-fits the data' : 'price scale pinned where it is';
}

export function setAxisLockRatio(on) {
  const s = axisState();
  if (!s) return;
  // The engine reports whether the axis is now in the state asked for:
  // locking fails on a scale nothing has measured, and saying so beats a
  // row that flips back on the next repaint with no explanation.
  const ok = app.chart.setPriceAxisLockRatio(s.paneIndex, s.scaleId, on);
  el('status').textContent = ok
    ? (on ? 'price per bar pinned' : 'price per bar released')
    : 'nothing measured on this scale yet';
}

export function moveAxisToOtherSide() {
  const s = axisState();
  if (!s) return;
  const to = s.side === 'right' ? 'left' : 'right';
  if (!app.chart.movePriceAxis(s.paneIndex, s.side, to)) {
    el('status').textContent = 'that side is already in use';
    return;
  }
  axTarget = { paneIndex: s.paneIndex, scaleId: to };  // the menu follows the axis
  el('status').textContent = 'price scale moved to the ' + to;
}

// ── price levels ───────────────────────────────────────────────────────
// A level is a line and an axis tag that toggle independently, so the two
// submenus are the same ten rows read through different halves of one style.

/**
 * The last price is the one level the core already owns: `priceLineVisible`
 * and `lastValueVisible` are this level's two halves under older names, and
 * letting the primitive draw it as well would put two lines on one price.
 * The engine ships the translation both ways, so the row still reads and
 * writes like every other.
 */
const isLastPriceLevel = (kind) => kind === 'lastPrice' && Boolean(lastPriceLevelFromSeriesStyle);

function levelStyle(kind) {
  if (isLastPriceLevel(kind)) {
    const info = app.chart && app.chart.primarySeriesInfo ? app.chart.primarySeriesInfo() : null;
    return lastPriceLevelFromSeriesStyle((info && info.style) || {});
  }
  return app.priceLevels ? app.priceLevels.level(kind) : { line: false, label: false };
}

/** Whether the level has a price in the current context. */
function levelAvailable(kind) {
  return Boolean(app.priceLevels) && app.priceLevels.available(kind);
}

function setLevelHalf(kind, half, on) {
  const next = { ...levelStyle(kind), [half]: on };
  if (isLastPriceLevel(kind)) {
    if (app.price) app.price.applyOptions(seriesStyleForLastPriceLevel(next));
  } else if (app.priceLevels) {
    app.priceLevels.setLevel(kind, { [half]: on });
    // Kept outside the primitive because a chart-type switch destroys it.
    app.priceLevelState[kind] = { ...app.priceLevels.level(kind) };
  }
  el('status').textContent = LEVEL_LABEL[kind] + ' '
    + (half === 'line' ? 'line' : 'tag') + (on ? ' on' : ' off');
}

function paintAxisSub() {
  axSub.innerHTML = '';
  const half = axSubHalf;
  axSub.appendChild(axHead(half === 'line' ? 'Lines on the plot' : 'Tags on the axis'));
  if (!app.priceLevels) {
    axSub.appendChild(axRow({
      label: 'Price levels', disabled: true, note: 'not in this build of dist/',
    }));
    return;
  }
  for (const kind of levelKinds()) {
    const ok = levelAvailable(kind);
    const style = levelStyle(kind);
    axSub.appendChild(axRow({
      label: LEVEL_LABEL[kind] || kind,
      on: style[half] === true,
      // Disabled, not hidden: "no previous session yet" and "no live quote"
      // are information. The switch keeps showing the state it is in.
      disabled: !ok,
      note: ok ? '' : 'no data',
      onSelect: () => runAxis(() => setLevelHalf(kind, half, style[half] !== true)),
    }));
  }
}

function openAxisSub(half, anchor) {
  if (axSubHalf === half && !axSub.hidden) return;
  axSubHalf = half;
  paintAxisSub();
  axSub.hidden = false;
  const a = anchor.getBoundingClientRect();
  const m = axMenu.getBoundingClientRect();
  const w = axSub.offsetWidth;
  // Flip to the left of the parent when the right side has no room, which is
  // the usual case for a menu raised on a right-hand price ladder.
  const right = m.right + 2;
  axSub.style.left = (right + w + 8 > window.innerWidth ? Math.max(4, m.left - w - 2) : right) + 'px';
  axSub.style.top = Math.max(4, Math.min(a.top - 6, window.innerHeight - axSub.offsetHeight - 8)) + 'px';
  markOpenSubRow();
}

function closeAxisSub() {
  axSub.hidden = true;
  axSubHalf = null;
  for (const r of axMenu.querySelectorAll('.axrow')) r.classList.remove('is-open');
}

export function closeAxisMenu() {
  axMenu.hidden = true;
  closeAxisSub();
}

export function openAxisMenu(e, target) {
  hideCtx();
  axTarget = {
    paneIndex: e.paneIndex || 0,
    // An older dist/ classifies the strip but does not say which scale it
    // draws; the side's own scale is the right guess in that case.
    scaleId: target.scaleId !== undefined ? target.scaleId : (target.side || 'right'),
  };
  paintAxisMenu();
  axMenu.hidden = false;
  const rect = el('chart').getBoundingClientRect();
  axMenu.style.left = Math.max(4, Math.min(rect.left + e.point.x, window.innerWidth - axMenu.offsetWidth - 8)) + 'px';
  axMenu.style.top = Math.max(4, Math.min(rect.top + e.point.y, window.innerHeight - axMenu.offsetHeight - 8)) + 'px';
}


/**
 * Price-axis chords, in the same `Alt+<key>` grammar the drawing tier uses
 * and matched the same way: modifiers exactly, never a bare letter, so
 * nothing here can shadow a browser chord. They act on the axis the menu
 * last named, which is the price ladder until a right-click says otherwise.
 *
 * `code` as well as `key`, unlike the tier's matcher: on macOS Alt+L arrives
 * as a typographic character and the letter is only recoverable from `code`.
 */
const AX_CHORDS = [
  { chord: AX_AUTOFIT_CHORD, run: () => setAxisAutoFit(!(axisState() || {}).autoFit) },
  { chord: AX_INVERT_CHORD, run: () => setAxisInvert(!(axisState() || {}).inverted) },
  ...AX_MODES.map((m) => ({ chord: m.chord, run: () => setAxisMode(m.value) })),
];

export function matchAxisShortcut(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  const key = String(e.key || '').toLowerCase();
  const code = String(e.code || '').replace(/^(Key|Digit)/, '').toLowerCase();
  for (const c of AX_CHORDS) {
    const want = c.chord.split('+').pop().toLowerCase();
    if (want === key || want === code) return c;
  }
  return null;
}

/** One popup menu at a time, anchored under its button. */
let openMenu = null;
export function popupMenu(anchor, rows, opts) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  const find = opts && opts.find
    ? Object.assign(document.createElement('input'), { type: 'text', placeholder: opts.find })
    : null;
  if (find) {
    const wrap = document.createElement('div');
    wrap.className = 'menu-find';
    wrap.appendChild(find);
    m.appendChild(wrap);
  }
  const body = document.createElement('div');
  m.appendChild(body);

  function paint(q) {
    const needle = q.trim().toLowerCase();
    body.innerHTML = '';
    let shown = 0;
    // A group heading is only worth drawing once something under it survives
    // the filter, so it is held back until the first matching row appears.
    let pending = null;
    for (const r of rows) {
      if (r.group) { pending = r.group; continue; }
      if (needle && !r.label.toLowerCase().includes(needle)) continue;
      if (pending) {
        const g = document.createElement('div');
        g.className = 'menu-group';
        g.textContent = pending;
        body.appendChild(g);
        pending = null;
      }
      const b = document.createElement('button');
      b.innerHTML = (r.icon ? ticon(r.icon) : '<span style="width:20px"></span>') +
        '<span>' + esc(r.label) + '</span>' + (r.on ? '<em>&#10003;</em>' : '');
      b.addEventListener('click', () => { closeMenu(); r.onSelect(); });
      body.appendChild(b);
      shown += 1;
    }
    if (shown === 0) {
      const e = document.createElement('div');
      e.className = 'menu-empty';
      e.textContent = 'No match';
      body.appendChild(e);
    }
  }
  paint('');

  if (find) {
    find.addEventListener('input', () => paint(find.value));
    // Enter picks the only remaining row, so a unique search needs no click.
    find.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const only = body.querySelectorAll('button');
      if (only.length === 1) only[0].click();
    });
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8) + 'px';
  m.style.top = (r.bottom + 4) + 'px';
  openMenu = m;
  if (find) find.focus();
}
export function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }

export function initMenus(a) {
  app = a;
  ctxMenu = el('ctxmenu');
  axMenu = el('axmenu');
  axSub = el('axsub');

  window.addEventListener('click', hideCtx);
  window.addEventListener('blur', hideCtx);
  el('chart').addEventListener('wheel', hideCtx, { passive: true });
  ctxMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    e.stopPropagation();
    hideCtx();
    const act = btn.getAttribute('data-act');
    if (act === 'cancelall') {
      removeAllOrders(); removeBracket(); clearPosition(); saveState(); el('status').textContent = 'all orders cancelled / flat'; return;
    }
    if (act === 'delall') {
      if (!app.draw) return;
      const n = app.draw.drawings().length;
      app.draw.clear();                 // one undo step, so it is recoverable
      autosave();
      el('status').textContent = n ? `removed ${n} drawing${n === 1 ? '' : 's'}` : 'no drawings to remove';
      return;
    }
    if (act === 'delsel') {
      if (!app.draw) return;
      const id = app.draw.selected();
      if (id) { app.draw.remove(id); autosave(); el('status').textContent = 'drawing deleted'; }
      return;
    }
    if (act === 'copy' || act === 'cut' || act === 'paste') {
      // Always the main chart: this menu is raised from the main chart's own
      // contextmenu event, so routing it through the pointer-focused pane
      // would act on the other chart if the pointer had moved on.
      app.focusPane = 1;
      clipboardAction(act);
      return;
    }
    if (act === 'volshow') { setVolumeShown(!volumeShown()); return; }
    if (act === 'chartset') { openChartSettings(); return; }
    if (act === 'indset') { if (ctxIndicator) openSettings(ctxIndicator); return; }
    placeOrder(btn.getAttribute('data-side'), btn.getAttribute('data-type'), ctxPrice);
  });

  // The menu stays up while levels are toggled, so it closes on a press
  // outside it rather than on any click at all, the way the order menu does.
  window.addEventListener('pointerdown', (e) => {
    if (axMenu.hidden) return;
    if (axMenu.contains(e.target) || axSub.contains(e.target)) return;
    closeAxisMenu();
  }, true);
  window.addEventListener('blur', closeAxisMenu);
  el('chart').addEventListener('wheel', closeAxisMenu, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (inTextField(e)) return;
    if (!el('chartset').hidden || !el('setmodal').hidden) return;  // a dialog owns the keyboard
    const hit = matchAxisShortcut(e);
    if (!hit || !axisState()) return;
    e.preventDefault();
    runAxis(hit.run);
  });

  window.addEventListener('pointerdown', (e) => {
    if (openMenu && !openMenu.contains(e.target) && !e.target.closest('.tbtn')) closeMenu();
  }, true);
}
