// Small helpers every module reaches for: element lookup, number and text
// formatting, the two candle colours, and the two keyboard conveniences the
// dialogs and the chords share.
//
// The second half is the shell's own furniture, kept here because every
// module raises it and none owns it: toasts, the chart's loading, empty and
// error states, the overlay stack that gives each dialog and menu a focus
// trap and a single Escape, and the theme switch. Nothing below touches the
// document at import time; `initShell()` is where the page is wired.
import { darkTheme, lightTheme } from '/dist/openalgo-charts.mjs';

export const el = (id) => document.getElementById(id);
export const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const round2 = (n) => Math.round(n * 100) / 100;
export function fmtVol(v) {
  if (v == null) return '';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return String(v);
}

export const UP = '#26a69a', DOWN = '#ef5350';
export const rupee = (n) => (n < 0 ? '-' : '+') + '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN');

/** Run `fn` on Escape. Listens on `window` unless a narrower target is given. */
export function onEscape(fn, target = window) {
  target.addEventListener('keydown', (e) => { if (e.key === 'Escape') fn(e); });
}

/** Whether a key event came from a text control, where the page's chords stay out of the way. */
export const inTextField = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable === true;

// The app the shell was wired to. Read at call time, never captured, for
// the same reason every other module does it: the chart is rebuilt on a
// chart-type switch and a copy would go stale.
let app = null;

// ── live region ────────────────────────────────────────────────────────

/**
 * Say `text` to assistive technology without putting it on screen. The
 * region is emptied and refilled a beat later, because a live region only
 * reports a change, and the same message twice in a row is not one.
 */
export function announce(text) {
  const live = el('live');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 40);
}

// ── toasts ─────────────────────────────────────────────────────────────
// The status readout is one line and is overwritten by the next thing that
// happens, so anything a user should not miss (a failed load, a saved
// layout) also gets a toast. Errors stay until dismissed; the rest go on
// their own.

/** How long each kind stays, in ms. 0 keeps it until it is dismissed. */
export const TOAST_MS = { info: 4000, success: 3500, error: 0 };
/** Newest at the bottom; beyond this many the oldest goes. */
export const TOAST_MAX = 5;
export const TOAST_LEAVE_MS = 160;

function toastHost() {
  let host = el('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.className = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Raise a toast. `kind` is info, success or error; `opts.ms` overrides the
 * kind's stay. Returns the node and a `dismiss()` for callers that want to
 * take it down early (a "loading" toast once the load lands).
 */
export function toast(kind, message, opts = {}) {
  const host = toastHost();
  const node = document.createElement('div');
  node.className = 'toast toast--' + (TOAST_MS[kind] === undefined ? 'info' : kind);
  const msg = document.createElement('span');
  msg.className = 'toast__msg';
  msg.textContent = message;
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'toast__x';
  x.setAttribute('aria-label', 'Dismiss');
  x.innerHTML = '&times;';
  node.append(msg, x);

  const ms = opts.ms !== undefined ? opts.ms : (TOAST_MS[kind] === undefined ? TOAST_MS.info : TOAST_MS[kind]);
  let timer = 0;
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    node.classList.add('is-out');
    setTimeout(() => node.remove(), TOAST_LEAVE_MS);
  };
  const arm = () => { if (ms > 0) timer = setTimeout(dismiss, ms); };
  x.addEventListener('click', dismiss);
  // The clock stops while the pointer is on the toast, so a message can be
  // read at the reader's pace rather than the timer's.
  node.addEventListener('pointerenter', () => clearTimeout(timer));
  node.addEventListener('pointerleave', arm);

  host.appendChild(node);
  while (host.children.length > TOAST_MAX) host.children[0].remove();
  arm();
  return { node, dismiss };
}

// ── overlay stack ──────────────────────────────────────────────────────
// Every dialog and menu on the page is opened by its own module and closed
// by its own module; what none of them can know is what else is open. The
// stack knows: Escape closes only the newest thing, Tab stays inside it,
// and focus goes back to where it came from when it closes.
//
// Nothing registers itself. The page's overlays are found by watching the
// document: a dialog opens when its `hidden` comes off, a popup menu when
// its node is appended, and each closes the opposite way.

/**
 * How Escape closes each overlay. A selector names the control whose click
 * runs the owning module's close (so a live-preview dialog reverts, the way
 * its Cancel does); `hide` is for the menus whose own close is nothing more
 * than `hidden = true`. Menus that exist only while open are removed.
 */
export const OVERLAY_CLOSE = {
  setmodal: '#set-x', cmpmodal: '#cmp-x', chartset: '#cset-x',
  replayleave: '#rp-leave-stay',
  snapmenu: 'hide', ctxmenu: 'hide', axmenu: 'hide',
};
/**
 * Menus that are created to open and removed to close. The rail's flyouts
 * are not here on purpose: they keep their own keyboard and hand focus back
 * to their button themselves.
 */
export const OVERLAY_CLASSES = ['menu'];

export const isOverlayNode = (n) => Boolean(n) && n.nodeType === 1 && (
  Object.prototype.hasOwnProperty.call(OVERLAY_CLOSE, n.id || '')
  || OVERLAY_CLASSES.some((c) => n.classList && n.classList.contains(c)));

const stack = [];          // { node, close, restore }, newest last
const focusHistory = [];   // the last few things focused, newest last

/** Whether `n` can take focus: a control, enabled, and not under a `hidden`. */
export function focusable(n) {
  if (!n || n.disabled) return false;
  const ti = n.getAttribute ? n.getAttribute('tabindex') : null;
  if (ti !== null && Number(ti) < 0) return false;
  const tag = n.tagName;
  const natural = tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
    || (tag === 'A' && n.hasAttribute && n.hasAttribute('href'));
  if (!natural && ti === null) return false;
  for (let p = n; p; p = p.parentElement) if (p.hidden) return false;
  return true;
}
export const focusables = (root) => Array.from(root.querySelectorAll('*')).filter(focusable);

/**
 * Where Tab lands inside a trap, as an index into the focusables, or null
 * when the browser's own move stays inside. `index` is -1 when focus is
 * somewhere outside the overlay (the document body after a hide).
 */
export function tabTarget(count, index, backwards) {
  if (backwards) return index <= 0 ? count - 1 : null;
  return index === -1 || index >= count - 1 ? 0 : null;
}

function closerFor(node) {
  const how = OVERLAY_CLOSE[node.id || ''];
  if (how === 'hide') {
    return () => {
      node.hidden = true;
      // The level flyout belongs to the axis menu and goes with it.
      if (node.id === 'axmenu') { const sub = el('axsub'); if (sub) sub.hidden = true; }
    };
  }
  if (typeof how === 'string') {
    return () => { const b = node.querySelector(how); if (b) b.click(); else node.hidden = true; };
  }
  return () => node.remove();
}

/**
 * Put `node` on top of the stack. Focus moves inside unless the opener
 * already put it there (the compare dialog focuses its symbol box itself).
 * `opts.close` overrides how Escape closes it; `opts.initialFocus` names
 * the control to land on.
 */
export function openOverlay(node, opts = {}) {
  if (stack.some((o) => o.node === node)) return;
  const active = document.activeElement;
  // The element to hand focus back to is the newest thing focused outside
  // the overlay: what is focused now, or failing that the history, because
  // the module that opened this dialog may already have focused a field
  // inside it.
  let restore = null;
  for (const f of [active, ...focusHistory.slice().reverse()]) {
    if (f && f !== document.body && !node.contains(f)) { restore = f; break; }
  }
  stack.push({ node, close: opts.close || closerFor(node), restore });
  if (!(active && node.contains(active))) {
    const first = opts.initialFocus || firstControl(node);
    if (first) first.focus();
  }
}

/**
 * Where focus lands in a freshly opened overlay: the first control of its
 * body. A dialog's close button comes first in the markup, and landing on
 * it reads as "press Enter to leave", which is not what a dialog is for.
 */
function firstControl(node) {
  const all = focusables(node);
  return all.find((n) => !(n.closest && n.closest('.set-head'))) || all[0];
}

/** Take `node` off the stack, wherever it sits, and hand focus back. */
export function closeOverlay(node) {
  const i = stack.findIndex((o) => o.node === node);
  if (i < 0) return;
  const [o] = stack.splice(i, 1);
  const active = document.activeElement;
  // Only if focus is still in the overlay, or was lost with it: a click that
  // opened something else has already decided where focus goes next.
  if (active && active !== document.body && !node.contains(active)) return;
  restoreFocus(o.restore);
}

function restoreFocus(target) {
  if (!target) return;
  if (!target.isConnected) {
    // The toolbar rebuilds itself on most changes, so the button that opened
    // a menu is often gone by the time the menu closes. Its replacement
    // carries the same accessible name.
    const label = target.getAttribute ? target.getAttribute('aria-label') : null;
    target = label ? document.querySelector('[aria-label="' + label.replace(/["\\]/g, '\\$&') + '"]') : null;
  }
  if (target && focusable(target)) target.focus();
}

export const topOverlay = () => (stack.length ? stack[stack.length - 1].node : null);
export const openOverlays = () => stack.map((o) => o.node);

/** Close the newest overlay. False when nothing is open. */
export function closeTopOverlay() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  closeOverlay(top.node);
  return true;
}

/**
 * The one keyboard handler, on the capture phase so it runs before every
 * module's own. With nothing open it does nothing and the page's chords see
 * the key as before. With something open, Escape closes that and only
 * that, and Tab stays inside it.
 */
export function overlayKeydown(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    closeTopOverlay();
    return;
  }
  if (e.key !== 'Tab') return;
  const f = focusables(top.node);
  if (!f.length) { e.preventDefault(); return; }
  const next = tabTarget(f.length, f.indexOf(document.activeElement), e.shiftKey);
  if (next !== null) { e.preventDefault(); f[next].focus(); }
}

/** Feed the stack from mutation records: `hidden` flips and menu nodes coming and going. */
export function overlayMutations(records) {
  for (const r of records) {
    if (r.type === 'attributes') {
      if (!isOverlayNode(r.target)) continue;
      if (r.target.hidden) closeOverlay(r.target); else openOverlay(r.target);
      continue;
    }
    for (const n of r.removedNodes) if (isOverlayNode(n)) closeOverlay(n);
    for (const n of r.addedNodes) if (isOverlayNode(n) && !n.hidden) openOverlay(n);
  }
}

let overlaysWired = false;
export function initOverlays() {
  if (overlaysWired) return;
  overlaysWired = true;
  document.addEventListener('focusin', (e) => {
    focusHistory.push(e.target);
    if (focusHistory.length > 4) focusHistory.shift();
  }, true);
  window.addEventListener('keydown', overlayKeydown, true);
  if (typeof MutationObserver !== 'function') return;
  const observer = new MutationObserver(overlayMutations);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
}

// ── chart state ────────────────────────────────────────────────────────
// A chart with nothing on it has to say why. The stage carries one overlay
// with a ghost of a chart behind it and a card in front: bars on their way,
// no bars for this request, or a request that failed and can be retried. A
// failed load therefore never leaves a blank stage.

export const CHART_STATES = ['ready', 'loading', 'empty', 'error'];
/** A warm load lands in a few ms; the skeleton only shows for a slow one. */
export const LOADING_DELAY_MS = 120;
let chartStateName = 'ready';
let loadingTimer = 0;
let retryFn = null;
export const chartState = () => chartStateName;

function showChartState(state, detail) {
  const host = el('chartstate');
  if (!host) return;
  const sym = String(detail.symbol || '').toUpperCase();
  const iv = String(detail.interval || '').toUpperCase();
  const title = el('cs-title');
  const text = el('cs-text');
  const card = el('cs-card');
  host.dataset.state = state;
  if (state === 'loading') {
    title.textContent = 'Loading ' + (sym || 'bars') + (iv ? ' ' + iv : '') + '...';
    text.textContent = '';
    card.setAttribute('role', 'status');
  } else if (state === 'empty') {
    title.textContent = 'No data for ' + (sym || 'this symbol') + (iv ? ' on ' + iv : '');
    text.textContent = detail.message || 'Try a longer range, another interval, or check the symbol.';
    card.setAttribute('role', 'status');
  } else {
    title.textContent = 'Could not load ' + (sym || 'the chart') + (iv ? ' ' + iv : '');
    text.textContent = detail.message || 'The request failed.';
    card.setAttribute('role', 'alert');
  }
  const retry = el('cs-retry');
  const dismiss = el('cs-dismiss');
  if (retry) retry.hidden = state === 'loading';
  if (dismiss) dismiss.hidden = state !== 'error';
  // The ghost bars stand in for a chart that is not there. Behind a failed
  // reload the last chart still is, and the card alone says what happened.
  const sk = el('cs-skeleton');
  const chart = el('chart');
  if (sk) sk.hidden = state !== 'loading' && Boolean(chart && chart.children.length);
  host.hidden = false;
}

/**
 * Put the stage in `state`. `detail` carries `symbol` and `interval` for the
 * wording, `message` for an error or an empty reply, and `retry`, the
 * function the card's button runs (the page's loader when absent).
 */
export function setChartState(state, detail = {}) {
  chartStateName = CHART_STATES.includes(state) ? state : 'ready';
  clearTimeout(loadingTimer);
  retryFn = detail.retry || null;
  if (chartStateName === 'ready') {
    const host = el('chartstate');
    if (host) host.hidden = true;
    return;
  }
  if (chartStateName === 'loading') {
    loadingTimer = setTimeout(() => showChartState('loading', detail), LOADING_DELAY_MS);
    return;
  }
  showChartState(chartStateName, detail);
}

function retryLoad() {
  if (retryFn) { retryFn(); return; }
  if (app && typeof app.load === 'function') { app.load(); return; }
  const load = el('load');
  if (load) load.click();
}

/** The ghost chart behind the state card: a row of bars, drawn once. */
function buildSkeleton() {
  const sk = el('cs-skeleton');
  if (!sk || sk.children.length) return;
  for (let i = 0; i < 48; i++) {
    const bar = document.createElement('i');
    // A wave with a little noise, so it reads as a chart and not as a comb.
    const h = 34 + Math.round(22 * Math.sin(i / 3.1)) + (i % 5) * 4;
    bar.style.setProperty('--h', h + '%');
    bar.style.setProperty('--i', String(i));   // staggers the loading pulse
    sk.appendChild(bar);
  }
}

// ── theme ──────────────────────────────────────────────────────────────
// The shell's palette is CSS custom properties keyed on `data-theme`; the
// chart's is an engine object. Both flip here, and the choice is kept so a
// reload comes back in it.

export const THEME_KEY = 'oa-charts-theme';
export const THEMES = ['dark', 'light'];
let themeName = 'dark';
export const currentTheme = () => themeName;
/** The engine palette that goes with the shell's current theme. */
export const chartTheme = () => (themeName === 'light' ? lightTheme : darkTheme);

export function setTheme(name, opts = {}) {
  themeName = THEMES.includes(name) ? name : 'dark';
  const root = document.documentElement;
  root.dataset.theme = themeName;
  // `color-scheme` is what the browser's own pieces read: the list a select
  // drops down, a scrollbar the stylesheet cannot reach, a date field.
  root.style.colorScheme = themeName;
  try { localStorage.setItem(THEME_KEY, themeName); } catch (_) { /* private mode */ }
  // Both charts follow, when they exist: the second chart is part of the
  // same workspace, and a dark follower under a light leader is a bug.
  for (const c of [app && app.chart, app && app.chart2]) {
    if (c && typeof c.setTheme === 'function') c.setTheme(chartTheme());
  }
  if (typeof CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('oac:theme', { detail: { theme: themeName } }));
  }
  if (!opts.silent) announce(themeName + ' theme');
}
export const toggleTheme = () => setTheme(themeName === 'dark' ? 'light' : 'dark');

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (_) { /* private mode */ }
  setTheme(saved || 'dark', { silent: true });
}

// ── shell ──────────────────────────────────────────────────────────────

/**
 * Wire the shell to the page: the theme (before the first render, so the
 * chart is built in it), the overlay stack, and the chart-state card's two
 * buttons. `a` is the shared app, read at call time like everywhere else.
 */
export function initShell(a) {
  app = a;
  initTheme();
  initOverlays();
  buildSkeleton();
  const retry = el('cs-retry');
  if (retry) retry.addEventListener('click', retryLoad);
  const dismiss = el('cs-dismiss');
  if (dismiss) dismiss.addEventListener('click', () => setChartState('ready'));
  // The card sits over the chart, and the chart captures the pointer on
  // pointerdown: a press that reached it would start a pan under the card.
  const host = el('chartstate');
  if (host) host.addEventListener('pointerdown', (e) => e.stopPropagation());
}
