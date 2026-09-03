import { el } from './ui.js';
import { renderToolbar } from './toolbar.js';
import { popupMenu } from './menus.js';
import { isSplit, openSplit, closeSplit } from './split.js';

let app;
export function initLink(a) { app = a; }

// ── link switches ──────────────────────────────────────────────────────

export function describeLink() {
  if (!app.linkGroup) return 'unavailable';
  const o = app.linkGroup.options();
  const on = ['crosshair', 'viewport', 'symbol'].filter((k) => o[k]);
  return on.length ? on.join(' + ') : 'nothing synced';
}

export function setLink(patch) {
  if (!app.linkGroup) return;
  app.linkGroup.setOptions(patch);
  renderToolbar();
  el('status').textContent = 'link: ' + describeLink()
    + ' · missing instant: ' + app.linkGroup.options().whenMissing;
}

export function openLinkMenu(anchor) {
  if (!app.linkGroup) {
    el('status').textContent = 'this dist/ has no chart linking';
    return;
  }
  const o = app.linkGroup.options();
  const rows = [
    { group: 'Layout' },
    {
      label: isSplit() ? 'Close the second chart' : 'Open a second chart',
      icon: 'split', on: isSplit(),
      onSelect: () => (isSplit() ? closeSplit() : openSplit()),
    },
    { group: isSplit() ? 'Sync' : 'Sync (open the second chart to see it)' },
    { label: 'Crosshair', on: o.crosshair, onSelect: () => setLink({ crosshair: !o.crosshair }) },
    { label: 'Viewport', on: o.viewport, onSelect: () => setLink({ viewport: !o.viewport }) },
    { label: 'Symbol', on: o.symbol, onSelect: () => setLink({ symbol: !o.symbol }) },
    { group: 'When the follower has no such bar' },
    { label: 'Snap to the nearest bar', on: o.whenMissing === 'nearest', onSelect: () => setLink({ whenMissing: 'nearest' }) },
    { label: 'Draw nothing', on: o.whenMissing === 'hide', onSelect: () => setLink({ whenMissing: 'hide' }) },
  ];
  popupMenu(anchor, rows);
}
