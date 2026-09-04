import { el } from './ui.js';
import { ticon } from './toolbar.js';

let app;

/* ── chart snapshot ──────────────────────────────────────────────────
 * `chart.takeScreenshot()` returns a canvas with everything on it, the
 * watermark and the replay mark included, because they are drawn on the
 * chart rather than laid over it in HTML.
 */

/** A PNG blob of the chart as it stands. */
export function snapshotBlob() {
  return new Promise((resolve, reject) => {
    if (!app.chart || !app.chart.takeScreenshot) { reject(new Error('no screenshot in this build')); return; }
    const canvas = app.chart.takeScreenshot();
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas produced no image'))), 'image/png');
  });
}

export function snapshotName() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${(app.req.symbol || 'chart').replace(/[^A-Za-z0-9._-]/g, '')}-${app.req.interval}-${stamp}.png`;
}

export async function downloadSnapshot() {
  closeSnapMenu();
  try {
    const blob = await snapshotBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = snapshotName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next turn: revoking synchronously races the download in
    // some browsers, which then saves an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    el('status').textContent = 'saved ' + a.download;
  } catch (err) {
    el('status').textContent = 'snapshot failed: ' + err.message;
  }
}

export async function copySnapshot() {
  closeSnapMenu();
  try {
    const blob = await snapshotBlob();
    // The clipboard image API is the only one that pastes into a post
    // composer. It needs a secure context and a user gesture, both of which
    // a click on this menu item supplies.
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      throw new Error('clipboard images need https or localhost');
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    el('status').textContent = 'chart copied, paste it anywhere';
  } catch (err) {
    el('status').textContent = 'copy failed: ' + err.message;
  }
}

export function openSnapMenu(anchor) {
  let menu = el('snapmenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'snapmenu';
    menu.innerHTML =
      '<div class="head">Chart snapshot</div>'
      + '<button id="snap-save">' + ticon('download') + '<span>Download image</span>'
      + '<span class="key">Ctrl+Alt+S</span></button>'
      + '<button id="snap-copy">' + ticon('copy') + '<span>Copy image</span>'
      + '<span class="key">Ctrl+Shift+S</span></button>';
    document.body.appendChild(menu);
    el('snap-save').addEventListener('click', downloadSnapshot);
    el('snap-copy').addEventListener('click', copySnapshot);
  }
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  // Placed after unhiding so the measured width is the real one, and pulled
  // back inside the window rather than opening off the right edge.
  const w = menu.offsetWidth;
  menu.style.top = (r.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
}

export function closeSnapMenu() {
  const menu = el('snapmenu');
  if (menu) menu.hidden = true;
}

export function initSnapshot(a) {
  app = a;
  document.addEventListener('click', (e) => {
    const menu = el('snapmenu');
    if (menu && !menu.hidden && !menu.contains(e.target)) closeSnapMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.key.toLowerCase() !== 's') return;
    if (e.altKey) { e.preventDefault(); downloadSnapshot(); }
    else if (e.shiftKey) { e.preventDefault(); copySnapshot(); }
  });
}
