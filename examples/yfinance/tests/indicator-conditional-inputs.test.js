import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('/dist/openalgo-charts.mjs', () => import('../../../src/index.ts'));
vi.mock('/dist/openalgo-charts.widget.mjs', () => import('../../../src/widget/index.ts'));
vi.mock('openalgo-charts', () => import('../../../src/index.ts'));
vi.mock('openalgo-charts/draw', () => import('../../../src/draw/index.ts'));
vi.mock('../src/persist.js', () => ({ autosave: vi.fn() }));
import { Chart, darkTheme, registerIndicator } from '../../../src/index.ts';
import { DrawingController } from '../../../src/draw/index.ts';
import { createOverlayStack, WidgetBus, WidgetStorage } from '../../../src/widget/context.ts';
import { installDom } from '../../../tests/widget-form.test.ts';
import { renderInputRows, collectInputRows, initIndicators, openSettings, closeSettings, collectSettings } from '../src/indicators.js';
import { validateTypedRows } from '../src/indicator-input-controls.js';
import { openOverlay } from '../src/ui.js';

// The reference host's own form reads the same descriptor rules as the widget:
// rows shown by a setting, rows enabled by one, and neighbours on one row.
const MODES = [{ label: 'Simple', value: 'simple' }, { label: 'Bands', value: 'bands' }];
const inputs = [
  { key: 'length', type: 'number', label: 'Length', default: 14, min: 1, max: 500, inline: 'len' },
  { key: 'source', type: 'source', label: 'Source', default: 'close', inline: 'len' },
  { key: 'mode', type: 'select', label: 'Mode', default: 'simple', options: MODES },
  { key: 'width', type: 'number', label: 'Band width', default: 2, min: 0.5, max: 5, step: 0.5, visibleWhen: { key: 'mode', is: 'bands' } },
  { key: 'level', type: 'price', label: 'Anchor price', default: 10, min: 0, max: 100, visibleWhen: { key: 'mode', is: 'bands' } },
  { key: 'smoothing', type: 'select', label: 'Smoothing', default: 'none', group: 'Smoothing',
    options: [{ label: 'None', value: 'none' }, { label: 'Moving average', value: 'sma' }] },
  { key: 'smoothLength', type: 'number', label: 'Smoothing length', default: 5, min: 1, max: 50, group: 'Smoothing',
    activeWhen: { key: 'smoothing', isNot: 'none' } },
  { key: 'showSignal', type: 'boolean', label: 'Signal', default: false, group: 'Signal', inline: 'signal' },
  { key: 'signalLength', type: 'number', label: 'Length', default: 9, min: 1, max: 50, group: 'Signal', inline: 'signal',
    activeWhen: { key: 'showSignal', is: true } },
  { key: 'signalColor', type: 'color', label: 'Colour', default: '#f59e0b', group: 'Signal', inline: 'signal',
    activeWhen: { key: 'showSignal', is: true } },
];
const defaults = Object.fromEntries(inputs.map(input => [input.key, input.default]));
let serial = 0;
const cleanups = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(dispose => dispose()); vi.unstubAllGlobals(); });

/** False when the node or an ancestor below the host is hidden, which also takes it out of the tab order. */
function shown(node, host) {
  for (let n = node; n && n !== host; n = n.parentElement) if (n.hidden) return false;
  return true;
}

function form(list = inputs, values = defaults) {
  const dom = installDom(); vi.stubGlobal('document', dom.doc); vi.stubGlobal('window', dom.win);
  const host = dom.doc.createElement('div'); host.id = 'set-body'; dom.root.appendChild(host);
  renderInputRows(host, list, values);
  const field = key => host.querySelector('#set-body_' + key);
  const choose = (key, value) => { field(key).value = value; field(key).fire('change'); };
  const live = () => host.querySelector('[role="status"][aria-live="polite"]');
  return { dom, host, field, choose, live, visible: key => shown(field(key), host) };
}

function fixture() {
  const h = form(), { dom } = h, doc = dom.doc;
  const modal = doc.createElement('div'); modal.id = 'setmodal'; modal.hidden = true;
  dom.root.appendChild(modal); modal.appendChild(h.host);
  for (const id of ['set-title', 'set-ok', 'set-x', 'set-reset']) {
    const node = doc.createElement(id === 'set-title' ? 'div' : 'button'); node.id = id; modal.appendChild(node);
  }
  for (const id of ['status', 'indlist', 'indadd', 'indpick']) {
    const node = doc.createElement('div'); node.id = id; dom.root.appendChild(node);
  }
  const chart = new Chart(dom.chartEl, { document: doc, pixelRatio: () => 1, shortcuts: false,
    branding: false, timeNavigator: false, raf: { schedule: fn => { fn(); return 1; }, cancel() {} } });
  chart.applySize(900, 600);
  chart.addSeries('line').setData([1, 2, 3].map((close, i) => ({ time: 1700000000 + 60 * i, open: close, high: close, low: close, close })));
  const id = `reference-conditional-${++serial}`;
  registerIndicator({ id, name: 'Reference conditional', placement: 'onchart', inputs,
    plots: [{ key: 'value', type: 'line' }], calc: bars => ({ value: bars.map(bar => bar.close) }) });
  const inst = chart.addIndicator(id), draw = new DrawingController(chart), overlays = createOverlayStack(dom.root, doc);
  const ctx = { chart, draw, root: dom.root, document: doc, theme: 'dark', chartTheme: darkTheme,
    bus: new WidgetBus(), storage: new WidgetStorage('reference-conditional', null), toast: vi.fn(),
    overlays, openOverlay: (node, options) => overlays.open(node, options), symbol: () => ({ symbol: 'PRIMARY' }), interval: () => '1m' };
  const app = { chart, draw, alertUi: { context: ctx }, req: {}, focusPane: 1 };
  initIndicators(app);
  const target = { pane: 1, chart, current: () => app.chart === chart };
  const open = () => { openSettings(inst.id, target); openOverlay(modal); };
  open();
  cleanups.push(() => { closeSettings(); overlays.destroy(); draw.destroy(); chart.destroy(); });
  return { ...h, chart, inst, modal, open, button: id => doc.getElementById(id) };
}

describe('reference host conditional inputs', () => {
  it('shows a row only while its condition holds and re-reads it on every draft change', () => {
    const h = form();
    expect(h.visible('width')).toBe(false);
    expect(h.visible('level')).toBe(false);
    h.choose('mode', 'bands');
    expect(h.visible('width')).toBe(true);
    expect(h.visible('level')).toBe(true);
    h.choose('mode', 'simple');
    expect(h.visible('width')).toBe(false);
  });

  it('disables an inactive row with a reason, then enables it when its controller changes', () => {
    const h = form();
    const row = h.field('smoothLength').closest('.set-row');
    expect(h.field('smoothLength').disabled).toBe(true);
    expect(h.field('smoothLength').title).toBe('Depends on Smoothing');
    expect(row.classList.contains('set-row--off')).toBe(true);
    h.choose('smoothing', 'sma');
    expect(h.field('smoothLength').disabled).toBe(false);
    expect(row.classList.contains('set-row--off')).toBe(false);
  });

  it('keeps a hidden draft and still sends it when it is valid', () => {
    const h = form();
    h.choose('mode', 'bands');
    h.field('width').value = '3.5'; h.field('width').fire('input');
    h.choose('mode', 'simple');
    expect(h.field('width').value).toBe('3.5');
    expect(collectInputRows(h.host)).toMatchObject({ mode: 'simple', width: 3.5 });
    h.choose('mode', 'bands');
    expect(h.field('width').value).toBe('3.5');
  });

  it('drops an invalid draft that is hidden, so the stored value stands and Apply is not blocked', () => {
    const h = form();
    h.choose('mode', 'bands');
    h.field('level').value = '-3'; h.field('level').fire('input');
    expect(validateTypedRows(h.host)).toBe(false);
    h.choose('mode', 'simple');
    expect(validateTypedRows(h.host)).toBe(true);
    expect(collectInputRows(h.host)).not.toHaveProperty('level');
    const error = h.host.querySelector('#set-body_level-error');
    expect(error.hidden).toBe(true);
    h.choose('mode', 'bands');
    expect(h.field('level').value).toBe('-3');
    expect(error.hidden).toBe(false);
    expect(validateTypedRows(h.host)).toBe(false);
  });

  it('announces shown, hidden and newly editable rows in a polite live region', () => {
    const h = form();
    expect(h.live().textContent).toBe('');
    h.choose('mode', 'bands');
    expect(h.live().textContent).toBe('Shown: Band width, Anchor price');
    h.choose('smoothing', 'sma');
    expect(h.live().textContent).toBe('Available: Smoothing length');
    h.choose('mode', 'simple');
    expect(h.live().textContent).toBe('Hidden: Band width, Anchor price');
  });

  it('moves focus from a field that its own form hides', () => {
    const h = form();
    h.choose('mode', 'bands');
    h.field('width').focus();
    h.field('mode').value = 'simple'; h.field('mode').fire('change');
    expect(h.dom.doc.activeElement).toBe(h.field('mode'));
  });

  it('puts inline inputs on one row with their own labels, and dims one member alone', () => {
    const h = form();
    const len = h.host.querySelector('[data-inline="len"]');
    expect(len.classList.contains('set-row--inline')).toBe(true);
    expect(len.querySelector('#set-body_length')).toBe(h.field('length'));
    expect(len.querySelector('#set-body_source')).toBe(h.field('source'));
    expect(len.querySelectorAll('label').map(label => label.textContent)).toEqual(['Length', 'Source']);
    const signal = h.host.querySelector('[data-inline="signal"]');
    expect(signal.querySelector('#set-body_showSignal')).toBe(h.field('showSignal'));
    expect(signal.querySelector('#set-body_signalLength')).toBe(h.field('signalLength'));
    const item = h.field('signalLength').closest('.set-inline');
    expect(item.classList.contains('set-inline--off')).toBe(true);
    expect(h.field('signalColor')._colorPicker.trigger.disabled).toBe(true);
    h.field('showSignal').checked = true; h.field('showSignal').fire('change');
    expect(item.classList.contains('set-inline--off')).toBe(false);
    expect(h.field('signalColor')._colorPicker.trigger.disabled).toBe(false);
    // Items carry no data-key of their own, so collecting reads fields only.
    expect(Object.keys(collectInputRows(h.host)).sort()).toEqual(Object.keys(defaults).sort());
  });

  it('adds no live region and no listeners to a form without conditions', () => {
    const h = form([{ key: 'n', type: 'number', label: 'N', default: 1 }], { n: 1 });
    expect(h.live()).toBeNull();
  });

  it('applies the drafts, a hidden valid one included, and Close discards them', () => {
    const h = fixture();
    h.choose('mode', 'bands');
    h.field('width').value = '4'; h.field('width').fire('input');
    h.choose('mode', 'simple');
    closeSettings();
    expect(h.inst.settings()).toMatchObject({ mode: 'simple', width: 2 });
    h.open();
    expect(h.visible('width')).toBe(false);
    expect(h.field('width').value).toBe('2');
    h.choose('mode', 'bands');
    h.field('width').value = '4'; h.field('width').fire('input');
    h.choose('smoothing', 'sma');
    expect(collectSettings()).toBe(true);
    expect(h.inst.settings()).toMatchObject({ mode: 'bands', width: 4, smoothing: 'sma' });
  });

  it('applies past a hidden invalid draft and keeps the stored value', () => {
    const h = fixture();
    h.choose('mode', 'bands');
    h.field('level').value = '-1'; h.field('level').fire('input');
    expect(collectSettings()).toBe(false);
    h.choose('mode', 'simple');
    expect(collectSettings()).toBe(true);
    expect(h.inst.settings()).toMatchObject({ mode: 'simple', level: 10 });
  });

  it('restores every default, hidden inputs included', () => {
    const h = fixture();
    h.choose('mode', 'bands'); h.field('width').value = '4'; h.field('width').fire('input');
    expect(collectSettings()).toBe(true);
    h.open();
    h.button('set-reset').click();
    expect(h.inst.settings()).toMatchObject({ mode: 'simple', width: 2, smoothing: 'none' });
    h.open();
    expect(h.visible('width')).toBe(false);
    expect(h.field('smoothLength').disabled).toBe(true);
  });
});
