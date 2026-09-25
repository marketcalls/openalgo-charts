// The grid view of the reference host: the widget tier's chart grid over the
// same /api/history feed as the main page. It opens the portable layouts the
// main page saves, including the ones with more than two charts or with rows,
// which the main page hands over here instead of refusing. grid.html calls
// initGridView(); like every module but main.js, importing this one builds
// nothing.
import '/dist/openalgo-charts.indicators.mjs';
import { createChartGrid, CHART_GRID_PRESETS } from '/dist/openalgo-charts.widget.mjs';
import {
  GRID_INTERVALS, GRID_PRESET_LABELS, gridFeeds, presetGlyph, takeGridHandoff, readGridFile, gridDocument,
} from './grid-view.js';
import { THEME_KEY } from './ui.js';

const PERSIST = 'yfinance-grid';
const LINKS = [['crosshair', 'Crosshair'], ['viewport', 'Viewport'], ['symbol', 'Symbol'], ['interval', 'Interval']];
const FIRST_VISIT = ['AAPL', 'MSFT', 'RELIANCE.NS', '^NSEI'];

/** Build the grid view in `doc` and return the grid. */
export function initGridView(doc = document) {
  const $ = id => doc.getElementById(id);
  const view = doc.defaultView;
  const storage = (() => { try { return view.localStorage; } catch { return null; } })();
  const read = key => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const paintPage = name => {
    doc.documentElement.dataset.theme = name;
    doc.documentElement.style.colorScheme = name;
    try { storage?.setItem(THEME_KEY, name); } catch { /* private mode */ }
  };
  const theme = read(THEME_KEY) === 'light' ? 'light' : 'dark';
  const fresh = read(`oac-widget:${PERSIST}:grid`) === null;
  paintPage(theme);

  // The grid restores its own last layout as it is built, and a hand-off then
  // replaces those charts. Their requests wait until the hand-off is applied;
  // by then the replaced charts have cancelled them, so none reaches the source.
  const handed = takeGridHandoff((() => { try { return view.sessionStorage; } catch { return null; } })());
  let release = () => {};
  const ready = handed === null ? undefined : new Promise(resolve => { release = resolve; });
  const coarse = view.matchMedia?.('(pointer: coarse)').matches === true;
  const grid = createChartGrid($('grid'), {
    // Each chart loads the history period its layout saved.
    document: doc, feed: gridFeeds({ ready }), symbol: 'AAPL', exchange: '', interval: '1d', intervals: GRID_INTERVALS,
    theme, preset: '2x2', persist: PERSIST, links: { crosshair: true, viewport: true },
    // Touch devices get the phone controls in each chart; a mouse keeps the
    // desktop bar even when a chart in a four-way split is narrow.
    mobile: coarse ? 'auto' : 'never',
    // Nothing here passes pane 0 for the price, so a chart may keep its price
    // pane below its studies, and a layout the main page saved that way opens.
    movablePrimaryPane: true,
  });
  // A first visit shows four different instruments rather than one repeated.
  if (fresh && handed === null) grid.cells().forEach((cell, i) => cell.widget.setSymbol(FIRST_VISIT[i] || 'AAPL'));

  const status = text => { $('grid-status').textContent = text; };
  const renderBar = () => {
    const { preset } = grid.layout();
    for (const button of $('grid-presets').children) {
      button.setAttribute('aria-pressed', String(button.dataset.preset === preset));
      button.classList.toggle('is-on', button.dataset.preset === preset);
    }
    const on = grid.linkOptions();
    for (const button of $('grid-links').querySelectorAll('button')) {
      const pressed = on[button.dataset.link] === true;
      button.setAttribute('aria-pressed', String(pressed));
      button.classList.toggle('is-on', pressed);
    }
  };
  const button = (className, onClick) => {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = className;
    node.addEventListener('click', onClick);
    return node;
  };

  for (const name of Object.keys(CHART_GRID_PRESETS)) {
    const node = button('tbtn tbtn--icon', () => { grid.setPreset(name); status(`${GRID_PRESET_LABELS[name]}: ${grid.cells().length} charts`); });
    node.dataset.preset = name;
    node.title = GRID_PRESET_LABELS[name];
    node.setAttribute('aria-label', GRID_PRESET_LABELS[name]);
    node.innerHTML = presetGlyph(name);
    $('grid-presets').appendChild(node);
  }
  for (const [key, label] of LINKS) {
    const node = button('tbtn', () => grid.setLinks({ [key]: !grid.linkOptions()[key] }));
    node.dataset.link = key;
    node.textContent = label;
    node.title = `Link ${label.toLowerCase()} across the charts`;
    $('grid-links').appendChild(node);
  }
  grid.on('layout', renderBar);
  grid.on('links', renderBar);
  grid.on('theme', ({ theme: name }) => paintPage(name));
  renderBar();

  /** Validate the whole file, then apply it all or not at all. */
  const openLayout = (text, from) => {
    let payload;
    try { payload = readGridFile(text); }
    catch (error) { status(`Could not open the layout from ${from}: ${error.message}`); return false; }
    const report = grid.applyWorkspace(payload);
    status(report.applied ? `Opened the layout from ${from}: ${grid.cells().length} charts`
      : `Could not open the layout from ${from}, nothing changed: ${report.reason}`);
    return report.applied;
  };

  $('grid-import').addEventListener('click', () => { $('grid-file').value = ''; $('grid-file').click(); });
  $('grid-file').addEventListener('change', async () => {
    const file = $('grid-file').files?.[0];
    if (file) openLayout(await file.text(), file.name);
  });
  $('grid-export').addEventListener('click', () => {
    const text = JSON.stringify(gridDocument(grid.getWorkspace()), null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = 'openalgo-grid-layout.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('Layout exported');
  });

  const restored = grid.restored();
  if (handed !== null) openLayout(handed, 'the main view');
  else if (restored?.applied === false) status(`The saved grid could not be restored and is kept until you change this one: ${restored.reason}`);
  else status(`${grid.cells().length} charts. Click a chart to make it active; drag the gaps to resize.`);
  release();
  if (new URLSearchParams(view.location.search).get('test') === '1') view.__grid = grid;
  return grid;
}
