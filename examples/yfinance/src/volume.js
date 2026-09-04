import { el, fmt, fmtVol, UP, DOWN } from './ui.js';
import { nameOf, exchangeOf } from './status.js';
import { setCompareLegends } from './compare.js';
import { autosave } from './persist.js';

let app;
export function initVolume(a) { app = a; }

// ── volume visibility ──────────────────────────────────────────────────
// The hidden `volshow` checkbox is the flag itself, not a second copy of
// it: `render()` reads it when it builds a fresh histogram, so every other
// control has to write through here or a chart-type switch would undo them.
export const volumeShown = () => el('volshow').checked;

/**
 * Show or hide the volume histogram on both charts. Hidden, never removed:
 * the series keeps its data and its overlay price scale, so coming back is
 * a repaint rather than a rebuild, and the legend row stays on the pane
 * (dimmed, eye struck through) so there is something left to click.
 */
export function setVolumeShown(on) {
  el('volshow').checked = on;
  if (app.volume) app.volume.applyOptions({ visible: on });
  if (app.volume2) app.volume2.applyOptions({ visible: on });
  if (app.volLegend) app.volLegend.setOptions({ hidden: !on });
  el('status').textContent = on ? 'volume shown' : 'volume hidden';
  autosave();
}

export function setLegend(bar) {
  if (!app.symbolLegend) return;
  app.symbolLegend.setOptions({
    title: nameOf(app.req.symbol || ''),
    params: `${(app.req.interval || '').toUpperCase()} · ${exchangeOf(app.req.symbol || '')}`,
  });
  setCompareLegends(bar);
  if (!bar) { app.symbolLegend.setValues([]); app.volLegend && app.volLegend.setValues([]); return; }
  const i = app.idxByTime.get(bar.time);
  const prevClose = (i != null && i > 0) ? app.currentBars[i - 1].close : bar.open;
  const chg = bar.close - prevClose;
  const pct = prevClose ? (chg / prevClose) * 100 : 0;
  const sign = chg >= 0 ? '+' : '';
  const col = bar.close >= bar.open ? UP : DOWN;
  // Dimmed O/H/L/C labels with colored numbers, one segment each. Each
  // reading names the status-line group that owns it: the settings dialog's
  // "Chart values", "Bar change values" and "Volume" switches hide readings
  // by their `field` tag, so an untagged number falls under "Indicator
  // values" instead and none of the three switches can reach it.
  app.symbolLegend.setValues([
    { label: 'O', text: fmt(bar.open), color: col, field: 'ohlc' },
    { label: 'H', text: fmt(bar.high), color: col, field: 'ohlc' },
    { label: 'L', text: fmt(bar.low), color: col, field: 'ohlc' },
    { label: 'C', text: fmt(bar.close), color: col, field: 'ohlc' },
    { text: `${sign}${fmt(chg)} (${sign}${pct.toFixed(2)}%)`, color: chg >= 0 ? UP : DOWN, field: 'change' },
  ]);
  // Volume gets its own row, the way a volume study would.
  if (app.volLegend) app.volLegend.setValues([{ text: fmtVol(bar.volume ?? 0), color: col, field: 'volume' }]);
}
