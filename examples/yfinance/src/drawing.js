import { DrawingController, BUILTIN_DRAWING_TOOLS, drawingShortcuts } from '/dist/openalgo-charts.draw.mjs';
import { el, inTextField } from './ui.js';
import { clipboardPort, activeDraw, canClip, clipboardAction } from './clipboard.js';
import { buildRail, syncRail, armCursor, setDrawLock, magnetMode, stayMode } from './rail.js';
import { autosave } from './persist.js';

let app;

// ── drawing tools ──────────────────────────────────────────────────────
// The controller is headless: it owns the model and the interactions, and
// this module is just a host driving setTool / undo / remove. Drawings
// persist through chart.getState(), so Layout > Save keeps them.
export function attachDrawing() {
  if (app.draw) app.draw.destroy();
  // Seeded from the rail's modes rather than the legacy checkbox: the rail
  // re-asserts both on any controller it observes, so the seed only keeps
  // the first anchor after a rebuild from landing unsnapped.
  app.draw = new DrawingController(app.chart, { magnet: magnetMode(), stayInDrawingMode: stayMode(), clipboard: clipboardPort });
  // The chord table comes from the tier, so the rail can only label its rows
  // once this point is reached.
  if (!Object.keys(app.shortcuts).length) {
    app.shortcuts = drawingShortcuts();
    buildRail();
  }
  app.chart.on('draw:tool', ({ tool }) => { syncRail(tool); armCursor(el('chart'), tool); });
  app.chart.on('draw:add', ({ drawing }) => { el('status').textContent = `drew ${drawing.tool}`; });
  // The properties bar follows the selection on its own (it subscribes to
  // the chart when the rail hands it the rebuilt one). What is left for the
  // status line is the chords, at the one moment they apply: the engine
  // ships no keys, so nothing else on screen would ever mention them.
  app.chart.on('draw:select', ({ id }) => {
    const d = id ? app.draw.get(id) : null;
    if (d && canClip()) {
      el('status').textContent = `${d.tool} selected · Ctrl+C copy · Ctrl+X cut · Ctrl+V paste`;
    }
  });
  for (const ev of ['draw:add', 'draw:remove', 'draw:update']) app.chart.on(ev, autosave);
  for (const ev of ['paneResized', 'paneMoved', 'paneMaximized', 'paneRemoved', 'indicatorRemoved']) {
    app.chart.on(ev, autosave);
  }
  syncRail(app.draw.activeTool());
}

export function fillToolPicker() {
  const sel = el('drawtool');
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'Cursor';
  sel.appendChild(none);
  for (const t of BUILTIN_DRAWING_TOOLS) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    sel.appendChild(o);
  }
}

export function initDrawing(a) {
  app = a;
  fillToolPicker();
  el('drawtool').addEventListener('change', () => { if (!app.draw) return; setDrawLock(false); app.draw.setTool(el('drawtool').value || null); });
  el('drawundo').addEventListener('click', () => app.draw && app.draw.undo());
  el('drawredo').addEventListener('click', () => app.draw && app.draw.redo());
  el('drawdel').addEventListener('click', () => {
    const id = app.draw && app.draw.selected();
    if (id) app.draw.remove(id);
  });
  el('drawclear').addEventListener('click', () => app.draw && app.draw.clear());
  // The legacy magnet checkbox is the rail's to follow (it owns the
  // three-way mode); nothing here reads it any more.
  // Which plot the chords act on. The two charts have separate controllers
  // and separate selections, so "the one the pointer is over" is the only
  // answer that does not need a focus ring the canvas cannot draw.
  el('chart').addEventListener('pointerenter', () => { app.focusPane = 1; });
  el('chart2').addEventListener('pointerenter', () => { app.focusPane = 2; });

  // Keyboard. The rail claims the drawing chords (tool chords, undo and
  // redo, delete, nudges, placement keys) in the capture phase; what
  // reaches here is the clipboard, which the rail leaves alone on purpose.
  window.addEventListener('keydown', (e) => {
    const d = activeDraw();
    if (!d || inTextField(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // Copy and cut only claim the chord when there is a drawing under it:
    // with nothing selected, Ctrl+C still belongs to the page's text.
    if (mod && (key === 'c' || key === 'x') && d.selected() && canClip()) {
      clipboardAction(key === 'c' ? 'copy' : 'cut');
      e.preventDefault();
      return;
    }
    if (mod && key === 'v' && canClip()) {
      clipboardAction('paste');
      e.preventDefault();
    }
  });
}
