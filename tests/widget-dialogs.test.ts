/**
 * The widget's overlay surfaces against a real, measured chart and a real
 * drawing controller: each dialog is generated from the engine's schema,
 * every control it draws writes through to the chart, and closing puts back
 * what a cancel should put back.
 *
 * The DOM is the small one in `widget-form.test.ts`; the overlay stack is the
 * shell's own (`createOverlayStack`), so Escape and the outside press are the
 * real thing rather than a stub of them.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  Chart, darkTheme, readChartSettings, registerIndicator, chartSettingsSchema,
} from 'openalgo-charts';
import type { Bar, ContextMenuEvent, ContextMenuTarget, IndicatorDescriptor } from 'openalgo-charts';
import { DrawingController, registerBuiltinDrawingTools, DEFAULT_FIB, type FibLevel } from 'openalgo-charts/draw';
import { createOverlayStack, WidgetBus, WidgetStorage, type OverlayStack, type WidgetContext } from '../src/widget/context';
import {
  mountSettingsDialog, tabDefaults,
  mountIndicatorPicker, filterIndicators, groupIndicators,
  mountIndicatorSettings, resolveInstance,
  mountDrawingProperties, commonSchema, resolvedDrawingValues,
  mountLevelEditor, nextRatio, FIB_SEQUENCE,
  mountTextEditor, fontOf, wrapLines, textFrame, readEditable, DEFAULT_FONT, TEXT_PAD, LINE_GAP, TEXT_SIZE,
  mountContextMenu, attachContextMenu, contextMenuEntries, drawingIdOf,
  WIDGET_DIALOGS, DIALOG_CSS,
  type MenuEntry, type MenuItem, type OrderRequest,
} from '../src/widget/dialogs/index';
import { registeredWidgetDialogs } from '../src/widget/context';
import { installDom, asDoc, asEl, type FakeElement, type Dom } from './widget-form.test';

const T0 = 1700000000;
const BARS: Bar[] = Array.from({ length: 40 }, (_, i) => {
  const c = 100 + Math.sin(i / 4) * 5;
  return { time: T0 + i * 60, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 100 + i };
});

const TEST_MA: IndicatorDescriptor = {
  id: 'test-ma', name: 'Test MA', category: 'Trend', placement: 'onchart',
  inputs: [
    { key: 'period', type: 'number', label: 'Period', default: 14, min: 1, max: 500, step: 1 },
    { key: 'source', type: 'source', label: 'Source', default: 'close' },
  ],
  plots: [{ key: 'ma', title: 'MA', type: 'line', style: { color: '#4f8cff' } }],
  calc: (bars) => ({ ma: bars.map((b) => b.close) }),
};
const TEST_OSC: IndicatorDescriptor = {
  id: 'test-osc', name: 'Test Oscillator', category: 'Momentum', placement: 'pane',
  inputs: [{ key: 'length', type: 'number', label: 'Length', default: 9 }],
  plots: [{ key: 'osc', title: 'Osc', type: 'histogram' }],
  calc: (bars) => ({ osc: bars.map((b) => b.close - b.open) }),
};

interface Rig {
  ctx: WidgetContext;
  dom: Dom;
  chart: Chart;
  draw: DrawingController;
  toasts: string[];
  stack: OverlayStack;
  /** Every element in the overlay layer with the class. */
  layer(): FakeElement;
  q(sel: string): FakeElement | null;
  qa(sel: string): FakeElement[];
}

const rigs: Rig[] = [];

function makeRig(withSeries = true): Rig {
  const dom = installDom();
  const doc = asDoc(dom.doc);
  const chart = new Chart(asEl(dom.chartEl), {
    document: doc,
    pixelRatio: () => 1,
    shortcuts: false,
    timeNavigator: false,
    raf: { schedule: (cb) => { cb(); return 1; }, cancel: () => {} },
  });
  chart.applySize(958, 660);
  if (withSeries) chart.addSeries('candlestick').setData(BARS);
  const draw = new DrawingController(chart);
  const stack = createOverlayStack(asEl(dom.root), doc);
  const toasts: string[] = [];
  const ctx: WidgetContext = {
    chart, draw, root: asEl(dom.root), document: doc, theme: 'dark', chartTheme: darkTheme,
    keymap: {} as WidgetContext['keymap'],
    bus: new WidgetBus(),
    storage: new WidgetStorage('test', null),
    locale: undefined,
    toast: (message, kind) => { toasts.push(`${kind ?? 'info'}:${message}`); return { node: doc.createElement('div'), dismiss: () => {} }; },
    openOverlay: (el, opts) => stack.open(el, opts),
    status: () => {},
    tips: { attach() {}, refreshLabel() {}, show() {}, hide() {}, target: () => null, destroy() {} },
    overlays: stack,
    symbol: () => ({ symbol: 'TEST', exchange: 'NSE' }),
    interval: () => '5m',
  };
  const layer = (): FakeElement => stack.layer as unknown as FakeElement;
  const rig: Rig = {
    ctx, dom, chart, draw, toasts, stack, layer,
    q: (sel) => layer().querySelector(sel),
    qa: (sel) => layer().querySelectorAll(sel),
  };
  rigs.push(rig);
  return rig;
}

/** Press Escape the way a browser would: on the focused element, up through the document. */
function escape(rig: Rig): void {
  const active = rig.dom.doc.activeElement;
  active.fire('keydown', { key: 'Escape' });
}

const line = (draw: DrawingController, extra: Record<string, unknown> = {}) => draw.add({
  tool: 'trend-line', paneIndex: 0, style: {},
  points: [{ time: T0 + 600, price: 100 }, { time: T0 + 1200, price: 104 }],
  ...extra,
});
const rect = (draw: DrawingController) => draw.add({
  tool: 'rectangle', paneIndex: 0, style: {},
  points: [{ time: T0 + 600, price: 98 }, { time: T0 + 1800, price: 103 }],
});
const fib = (draw: DrawingController) => draw.add({
  tool: 'fib-retracement', paneIndex: 0, style: {},
  points: [{ time: T0 + 600, price: 96 }, { time: T0 + 1800, price: 104 }],
});
const text = (draw: DrawingController, value = 'Hello') => draw.add({
  tool: 'text', paneIndex: 0, style: {},
  points: [{ time: T0 + 600, price: 100 }],
  text: { value },
});

beforeAll(() => {
  registerBuiltinDrawingTools();
  registerIndicator(TEST_MA);
  registerIndicator(TEST_OSC);
});

afterEach(() => {
  for (const r of rigs.splice(0)) { r.stack.destroy(); r.chart.destroy(); }
});

// ── registration and stylesheet ───────────────────────────────────────────

describe('the dialog tier as the shell sees it', () => {
  it('registers all seven mounts under the names the shell knows', () => {
    expect(registeredWidgetDialogs().sort()).toEqual(Object.keys(WIDGET_DIALOGS).sort());
    expect(Object.keys(WIDGET_DIALOGS).sort()).toEqual(
      ['contextMenu', 'drawingProperties', 'indicatorPicker', 'indicatorSettings', 'levelEditor', 'settings', 'textEditor'],
    );
  });

  it('styles only through tokens, under the widget scope, with no icon fonts or em dashes', () => {
    const rules = DIALOG_CSS.split('\n').filter((l) => l.trim().startsWith('.'));
    for (const r of rules) expect(r.trim().startsWith('.oac-widget ')).toBe(true);
    // Every colour is a token: no literal hex outside a var() fallback.
    expect(/#[0-9a-f]{3,8}\b/i.test(DIALOG_CSS)).toBe(false);
    expect(DIALOG_CSS.includes('\u2014') || DIALOG_CSS.includes('\u2013')).toBe(false);
    expect(DIALOG_CSS).toContain('.oac-widget .oac-panel');
    expect(DIALOG_CSS).toContain('.oac-widget .oac-ctx__row');
  });
});

// ── chart settings ────────────────────────────────────────────────────────

describe('mountSettingsDialog', () => {
  it('draws one tab per non-empty schema tab, each with a glyph, and the active tab as a generated form', () => {
    const rig = makeRig();
    const handle = mountSettingsDialog(rig.ctx);
    const tabs = rig.qa('[role="tab"]');
    const expected = chartSettingsSchema(rig.chart).filter((t) => t.inputs.length > 0);
    expect(tabs.map((t) => t.textContent)).toEqual(expected.map((t) => t.label));
    for (const t of tabs) expect(t.querySelector('svg') !== null || t.innerHTML.includes('<svg')).toBe(true);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    // The Price tab of a candlestick chart: three paired rows, one row each.
    const bodyRow = rig.q('[data-key="symbol.body"]') as FakeElement;
    expect(bodyRow.querySelectorAll('input[type="color"]').length).toBe(2);
    expect(bodyRow.querySelector('input[type="checkbox"]')).not.toBeNull();
    // Furniture: title left, close top right, lead left, OK last.
    expect(rig.q('.oac-dialog__title')?.textContent).toBe('Chart settings');
    const actions = (rig.q('.oac-dialog__actions') as FakeElement).querySelectorAll('button');
    expect(actions.map((b) => b.textContent)).toEqual(['Cancel', 'OK']);
    expect(rig.q('.oac-dialog__lead button')?.textContent).toBe('Restore this tab');
    expect(rig.stack.size()).toBe(1);
    handle.close();
    expect(rig.stack.size()).toBe(0);
  });

  it('hides the Price tab on a chart with no series rather than showing it empty', () => {
    const rig = makeRig(false);
    mountSettingsDialog(rig.ctx);
    expect(rig.qa('[role="tab"]').map((t) => t.dataset.tab)).not.toContain('price');
  });

  it('applies edits live, and Cancel puts back only the keys this session touched', () => {
    const rig = makeRig();
    const before = readChartSettings(rig.chart);
    mountSettingsDialog(rig.ctx, undefined, { tab: 'appearance' });
    const vert = rig.q('#oac-cset-canvas-grid-vertLines') as FakeElement;
    expect(vert.checked).toBe(true);
    vert.checked = false;
    vert.fire('change');
    expect(rig.chart.gridOptions().vertLines).toBe(false);
    // Something the user did outside the dialog while it was open.
    rig.chart.setGridOptions({ horzLines: false });
    (rig.qa('.oac-dialog__actions button')[0]).click();
    expect(rig.chart.gridOptions().vertLines).toBe(before['canvas.grid.vertLines']);
    expect(rig.chart.gridOptions().horzLines).toBe(false);
    expect(rig.stack.size()).toBe(0);
  });

  it('keeps edits on OK, reverts on Escape through the overlay stack, and reports which', () => {
    const rig = makeRig();
    const closes: boolean[] = [];
    mountSettingsDialog(rig.ctx, undefined, { tab: 'appearance', onClose: (c) => closes.push(c) });
    const vert = rig.q('#oac-cset-canvas-grid-vertLines') as FakeElement;
    vert.checked = false;
    vert.fire('change');
    (rig.qa('.oac-dialog__actions button')[1]).click();
    expect(rig.chart.gridOptions().vertLines).toBe(false);
    expect(closes).toEqual([true]);

    mountSettingsDialog(rig.ctx, undefined, { tab: 'appearance', onClose: (c) => closes.push(c) });
    const vert2 = rig.q('#oac-cset-canvas-grid-vertLines') as FakeElement;
    vert2.checked = true;
    vert2.fire('change');
    expect(rig.chart.gridOptions().vertLines).toBe(true);
    escape(rig);
    expect(rig.chart.gridOptions().vertLines).toBe(false);
    expect(closes).toEqual([true, false]);
    expect(rig.stack.size()).toBe(0);
  });

  it('restores the visible tab to the schema defaults as an undoable edit', () => {
    const rig = makeRig();
    rig.chart.setGridOptions({ spacing: 120 });
    mountSettingsDialog(rig.ctx, undefined, { tab: 'appearance' });
    (rig.q('.oac-dialog__lead button') as FakeElement).click();
    const tab = chartSettingsSchema(rig.chart).find((t) => t.id === 'appearance');
    expect(tab).toBeDefined();
    expect(rig.chart.gridOptions().spacing).toBe(tabDefaults(tab as NonNullable<typeof tab>)['canvas.grid.spacing']);
    (rig.qa('.oac-dialog__actions button')[0]).click();
    expect(rig.chart.gridOptions().spacing).toBe(120);
  });

  it('greys a control the host says has nothing behind it, with the reason on it', () => {
    const rig = makeRig();
    mountSettingsDialog(rig.ctx, undefined, {
      tab: 'trading', unavailable: (key) => (key === 'trading.longColor' ? 'no long position on the chart' : null),
    });
    const long = rig.q('#oac-cset-trading-longColor') as FakeElement;
    expect(long.disabled).toBe(true);
    expect(long.title).toBe('Long: no long position on the chart');
    const short = rig.q('#oac-cset-trading-shortColor') as FakeElement;
    expect(short.disabled).toBe(false);
  });

  it('exposes the same mount through the registry', () => {
    const rig = makeRig();
    const handle = WIDGET_DIALOGS.settings(rig.ctx);
    expect(rig.q('.oac-dialog__title')?.textContent).toBe('Chart settings');
    handle.close();
  });
});

// ── indicator picker ──────────────────────────────────────────────────────

describe('mountIndicatorPicker', () => {
  it('lists the registry by category, filters as you type, and adds on click or Enter', () => {
    const rig = makeRig();
    const added: string[] = [];
    mountIndicatorPicker(rig.ctx, undefined, { onAdd: (inst) => added.push(inst.indicatorId) });
    const heads = rig.qa('.oac-pick__list .oac-head').map((h) => h.textContent);
    expect(heads).toContain('Trend');
    expect(heads).toContain('Momentum');
    const rows = rig.qa('.oac-pick__row');
    expect(rows.some((r) => r.dataset.id === 'test-ma')).toBe(true);
    const find = rig.q('.oac-pick__find') as FakeElement;
    expect(rig.dom.doc.activeElement).toBe(find);
    find.value = 'oscill';
    find.fire('input');
    expect(rig.qa('.oac-pick__row').map((r) => r.dataset.id)).toEqual(['test-osc']);
    find.fire('keydown', { key: 'Enter' });
    expect(added).toEqual(['test-osc']);
    expect(rig.chart.indicators().map((i) => i.indicatorId)).toEqual(['test-osc']);
    expect(rig.toasts).toEqual(['success:Added Test Oscillator']);
    // Still open, and the row now says the study is on the chart.
    expect(rig.stack.size()).toBe(1);
    expect(rig.q('.oac-pick__count')?.textContent).toBe('on chart');
    find.value = '';
    find.fire('input');
    (rig.qa('.oac-pick__row').find((r) => r.dataset.id === 'test-ma') as FakeElement).click();
    expect(added).toEqual(['test-osc', 'test-ma']);
    find.value = 'zzz-nothing';
    find.fire('input');
    expect(rig.q('.oac-empty')?.textContent).toBe('No match');
  });

  it('closes after the first add when asked, and anchors below a button when given one', () => {
    const rig = makeRig();
    const btn = rig.dom.doc.createElement('button');
    btn.rect = { left: 300, top: 8, width: 90, height: 28 };
    rig.dom.root.appendChild(btn);
    mountIndicatorPicker(rig.ctx, asEl(btn), { closeOnAdd: true });
    const panel = rig.q('.oac-pick') as FakeElement;
    expect(panel.classList.contains('oac-pop')).toBe(true);
    expect(panel.style.left).toBe('300px');
    (rig.qa('.oac-pick__row')[0]).click();
    expect(rig.stack.size()).toBe(0);
    expect(rig.chart.indicators().length).toBe(1);
  });

  it('sorts and groups descriptors the way the list is drawn', () => {
    const list = filterIndicators([TEST_OSC, TEST_MA], '');
    expect(list.map((d) => d.id)).toEqual(['test-ma', 'test-osc']);
    expect(filterIndicators([TEST_OSC, TEST_MA], 'trend').map((d) => d.id)).toEqual(['test-ma']);
    expect(groupIndicators(list).map(([c, items]) => [c, items.length])).toEqual([['Momentum', 1], ['Trend', 1]]);
    expect(groupIndicators([{ ...TEST_MA, category: undefined }])[0][0]).toBe('Other');
  });
});

// ── indicator settings ────────────────────────────────────────────────────

describe('mountIndicatorSettings', () => {
  it('renders the inputs tab from the descriptor and the style tab from the generated inputs, applying live', () => {
    const rig = makeRig();
    const inst = rig.chart.addIndicator('test-ma');
    mountIndicatorSettings(rig.ctx, undefined, { instanceId: inst.id });
    expect(rig.q('.oac-dialog__title')?.textContent).toBe('Test MA settings');
    expect(rig.qa('[role="tab"]').map((t) => t.textContent)).toEqual(['Inputs', 'Style']);
    const period = rig.q(`#oac-ind-${inst.id}-period`) as FakeElement;
    expect(period.value).toBe('14');
    period.value = '20';
    period.fire('change');
    expect(inst.settings().period).toBe(20);
    const source = rig.q(`#oac-ind-${inst.id}-source`) as FakeElement;
    expect(source.tagName).toBe('SELECT');
    expect(source.querySelectorAll('option').map((o) => o.value)).toContain('hlc3');
    (rig.qa('[role="tab"]')[1]).click();
    const color = rig.q(`#oac-ind-${inst.id}-ma-color`) as FakeElement;
    expect(color.value).toBe('#4f8cff');
    color.value = '#ff0000';
    color.fire('change');
    expect(inst.settings()['ma:color']).toBe('#ff0000');
    // Through to the series the pane paints, not only the settings bag.
    expect(rig.chart.panes()[0].series().some((s) => s.style.color === '#ff0000')).toBe(true);
  });

  it('Cancel puts back the touched keys, Defaults restores the tab, OK keeps', () => {
    const rig = makeRig();
    const inst = rig.chart.addIndicator('test-ma', { period: 30 });
    mountIndicatorSettings(rig.ctx, undefined, { instanceId: inst.id });
    const period = rig.q(`#oac-ind-${inst.id}-period`) as FakeElement;
    period.value = '5';
    period.fire('change');
    expect(inst.settings().period).toBe(5);
    (rig.q('.oac-dialog__lead button') as FakeElement).click();
    expect(inst.settings().period).toBe(14);
    (rig.qa('.oac-dialog__actions button')[0]).click();
    expect(inst.settings().period).toBe(30);
    expect(rig.stack.size()).toBe(0);

    mountIndicatorSettings(rig.ctx, undefined, { instanceId: inst.id });
    const p2 = rig.q(`#oac-ind-${inst.id}-period`) as FakeElement;
    p2.value = '7';
    p2.fire('change');
    (rig.qa('.oac-dialog__actions button')[1]).click();
    expect(inst.settings().period).toBe(7);
  });

  it('finds the instance from the anchor, or the only one, and declines with a toast otherwise', () => {
    const rig = makeRig();
    expect(resolveInstance(rig.ctx, undefined, {}).why).toBe('No indicator on the chart to configure');
    const a = rig.chart.addIndicator('test-ma');
    expect(resolveInstance(rig.ctx, undefined, {}).inst).toBe(a);
    const b = rig.chart.addIndicator('test-osc');
    expect(resolveInstance(rig.ctx, undefined, {}).why).toBe('Pick an indicator from the legend first');
    const gear = rig.dom.doc.createElement('button');
    gear.dataset.instanceId = b.id;
    expect(resolveInstance(rig.ctx, asEl(gear), {}).inst).toBe(b);
    const h = mountIndicatorSettings(rig.ctx, undefined, { instanceId: 'nope' });
    expect(h.isOpen()).toBe(false);
    expect(rig.toasts).toEqual(['info:That indicator is no longer on the chart']);
  });
});

// ── drawing properties ────────────────────────────────────────────────────

describe('mountDrawingProperties', () => {
  it('generates the rows from the tool schema and writes one undo entry per edit', () => {
    const rig = makeRig();
    const r = rect(rig.draw);
    rig.draw.select(r.id);
    mountDrawingProperties(rig.ctx);
    expect(rig.q('.oac-dialog__title')?.textContent).toBe('Rectangle');
    const keys = rig.qa('.oac-row').map((row) => row.dataset.key);
    expect(keys).toContain('style.color');
    expect(keys).toContain('style.fillColor');
    expect(keys).toContain('style.fillOpacity');
    // A rectangle never declares levels, so no levels control is drawn.
    expect(rig.q('[data-act="edit-levels"]')).toBeNull();
    const color = rig.q('#oac-props-style-color') as FakeElement;
    color.value = '#ff00ff';
    color.fire('change');
    expect(rig.draw.get(r.id)?.style.color).toBe('#ff00ff');
    const op = rig.q('input[type="range"]') as FakeElement;
    op.value = '50';
    op.fire('change');
    expect(rig.draw.get(r.id)?.style.fillOpacity).toBe(0.5);
    expect(rig.draw.undo()).toBe(true);
    expect(rig.draw.get(r.id)?.style.fillOpacity).toBeUndefined();
    expect(rig.draw.get(r.id)?.style.color).toBe('#ff00ff');
  });

  it('carries the lock, visibility, order, duplicate and delete actions and follows the selection', () => {
    const rig = makeRig();
    const a = line(rig.draw);
    const b = rect(rig.draw);
    let closed = 0;
    mountDrawingProperties(rig.ctx, undefined, { ids: [a.id], onClose: () => { closed++; } });
    expect(rig.draw.selection()).toEqual([a.id]);
    const act = (name: string): FakeElement => rig.q(`[data-act="${name}"]`) as FakeElement;
    act('lock').click();
    expect(rig.draw.get(a.id)?.locked).toBe(true);
    expect(act('lock').getAttribute('aria-pressed')).toBe('true');
    act('visible').click();
    expect(rig.draw.get(a.id)?.visible).toBe(false);
    act('behind').click();
    expect(rig.draw.get(a.id)?.zIndex).toBeLessThan(0);
    expect(act('behind').getAttribute('aria-pressed')).toBe('true');
    act('above').click();
    expect(rig.draw.get(a.id)?.zIndex).toBeGreaterThanOrEqual(0);
    // A new selection rebuilds the dialog in place.
    rig.draw.select(b.id);
    expect(rig.q('.oac-dialog__title')?.textContent).toBe('Rectangle');
    act('duplicate').click();
    expect(rig.draw.drawings().length).toBe(3);
    // Duplicate selects the copy; deleting it empties the selection and closes the dialog.
    act('delete').click();
    expect(rig.draw.drawings().length).toBe(2);
    expect(closed).toBe(1);
    expect(rig.stack.size()).toBe(0);
  });

  it('edits the fields two tools share when both are selected, and titles the count', () => {
    const rig = makeRig();
    const a = line(rig.draw);
    const b = rect(rig.draw);
    rig.draw.select([a.id, b.id]);
    mountDrawingProperties(rig.ctx);
    expect(rig.q('.oac-dialog__title')?.textContent).toBe('2 drawings');
    const shared = commonSchema(['trend-line', 'rectangle']).fields.map((f) => f.path);
    expect(shared).toContain('style.color');
    expect(shared).not.toContain('style.fillColor');
    expect(rig.qa('.oac-row').map((r) => r.dataset.key)).toEqual(shared);
    const width = rig.q('#oac-props-style-lineWidth') as FakeElement;
    width.value = '3';
    width.fire('change');
    expect(rig.draw.get(a.id)?.style.lineWidth).toBe(3);
    expect(rig.draw.get(b.id)?.style.lineWidth).toBe(3);
  });

  it('opens the level editor from a ladder tool and the text editor from a text tool', () => {
    const rig = makeRig();
    const f = fib(rig.draw);
    rig.draw.select(f.id);
    mountDrawingProperties(rig.ctx);
    (rig.q('[data-act="edit-levels"]') as FakeElement).click();
    expect(rig.q('.oac-levels')).not.toBeNull();
    expect(rig.stack.size()).toBe(2);
    rig.stack.closeAll();
    const t = text(rig.draw);
    rig.draw.select(t.id);
    mountDrawingProperties(rig.ctx);
    expect(rig.q('[data-key="text.value"] textarea')).not.toBeNull();
    (rig.q('[data-act="edit-text"]') as FakeElement).click();
    expect(rig.q('.oac-textedit')).not.toBeNull();
  });

  it('shows resolved values so no control is blank before the first edit', () => {
    const d = { id: 'x', tool: 'trend-line', paneIndex: 0, zIndex: 0, points: [], style: {} };
    const v = resolvedDrawingValues(d, commonSchema(['trend-line']), null, '#4f8cff');
    expect(v['style.color']).toBe('#4f8cff');
    expect(v['style.lineWidth']).toBe(1.5);
    expect(v['style.lineStyle']).toBe('solid');
  });

  it('declines with a toast when nothing is selected', () => {
    const rig = makeRig();
    const h = mountDrawingProperties(rig.ctx);
    expect(h.isOpen()).toBe(false);
    expect(rig.toasts).toEqual(['info:Select a drawing first']);
  });
});

// ── level editor ──────────────────────────────────────────────────────────

describe('mountLevelEditor', () => {
  it('draws one row per level and writes the whole list back on every edit', () => {
    const rig = makeRig();
    const f = fib(rig.draw);
    rig.draw.select(f.id);
    mountLevelEditor(rig.ctx);
    const rows = rig.qa('.oac-levels__row');
    expect(rows.length).toBe(DEFAULT_FIB.length);
    expect((rows[0].querySelector('input[type="number"]') as FakeElement).value).toBe(String(DEFAULT_FIB[0].ratio));
    const ratio = rows[1].querySelector('input[type="number"]') as FakeElement;
    ratio.value = '0.25';
    ratio.fire('change');
    const levels = (): FibLevel[] => rig.draw.get(f.id)?.style.levels ?? [];
    expect(levels()[1].ratio).toBe(0.25);
    expect((rows[1].querySelector('input[type="text"]') as FakeElement).placeholder).toBe('25.0%');
    const on = rows[2].querySelector('input[type="checkbox"]') as FakeElement;
    on.checked = false;
    on.fire('change');
    expect(levels()[2].enabled).toBe(false);
    expect(rows[2].classList.contains('is-off')).toBe(true);
    const label = rows[3].querySelector('input[type="text"]') as FakeElement;
    label.value = 'Half';
    label.fire('change');
    expect(levels()[3].label).toBe('Half');
    // A blank ratio is not an edit; the box shows the last good value.
    ratio.value = '';
    ratio.fire('change');
    expect(ratio.value).toBe('0.25');
    expect(levels()[1].ratio).toBe(0.25);
    // Every edit was one undo step.
    rig.draw.undo();
    expect(levels()[3].label).toBeUndefined();
  });

  it('adds the next conventional ratio, removes a row, resets to the tool defaults, and toggles labels', () => {
    const rig = makeRig();
    const f = fib(rig.draw);
    rig.draw.select(f.id);
    mountLevelEditor(rig.ctx);
    const levels = (): FibLevel[] => rig.draw.get(f.id)?.style.levels ?? [];
    const foot = rig.q('.oac-levels__foot') as FakeElement;
    foot.querySelectorAll('button')[0].click();
    expect(levels().length).toBe(DEFAULT_FIB.length + 1);
    expect(levels()[levels().length - 1].ratio).toBe(nextRatio(DEFAULT_FIB));
    (rig.qa('.oac-levels__x')[0]).click();
    expect(levels().length).toBe(DEFAULT_FIB.length);
    expect(levels()[0].ratio).toBe(DEFAULT_FIB[1].ratio);
    foot.querySelectorAll('button')[1].click();
    expect(levels()).toEqual(DEFAULT_FIB.map((l) => ({ ...l })));
    const labels = rig.q('.oac-levels__labels input') as FakeElement;
    labels.checked = false;
    labels.fire('change');
    expect(rig.draw.get(f.id)?.style.showLabels).toBe(false);
  });

  it('walks the conventional ladder for a new level, then goes past the largest', () => {
    expect(nextRatio([])).toBe(0);
    expect(nextRatio([{ ratio: 0 }, { ratio: 0.2360000001 }])).toBe(0.382);
    expect(nextRatio(FIB_SEQUENCE.map((ratio) => ({ ratio })))).toBe(FIB_SEQUENCE[FIB_SEQUENCE.length - 1] + 1);
  });

  it('declines on a tool with no levels', () => {
    const rig = makeRig();
    const l = line(rig.draw);
    rig.draw.select(l.id);
    expect(mountLevelEditor(rig.ctx).isOpen()).toBe(false);
    expect(rig.toasts).toEqual(['info:Select a drawing with levels first']);
  });
});

// ── text editor ───────────────────────────────────────────────────────────

describe('mountTextEditor', () => {
  const measure7 = (s: string): number => s.length * 7;

  it('typesets the frame the way the tier does', () => {
    expect(fontOf({}, 14)).toBe(`14px ${DEFAULT_FONT}`);
    expect(fontOf({ bold: true, italic: true, fontFamily: 'serif' }, 12)).toBe('italic 700 12px serif');
    expect(wrapLines(measure7, {}, 'one two\nthree', 20)).toEqual(['one two', 'three']);
    expect(wrapLines(measure7, { wrap: true }, 'aa bb cc\n\ndd', 6 * 7)).toEqual(['aa bb', 'cc', '', 'dd']);
    const chart = { timeToCoordinate: (t: number) => t, priceToCoordinate: (p: number) => p };
    const d = { id: 'd', tool: 'text', points: [{ time: 100, price: 200 }], paneIndex: 0, zIndex: 0, style: {}, text: { value: 'ab\ncdef', fontSize: 10 } };
    const f = textFrame(chart, d, measure7);
    expect(f).toMatchObject({ x: 100, y: 200, width: 4 * 7 + TEXT_PAD * 2, height: 2 * 10 * LINE_GAP + TEXT_PAD * 2, lineHeight: 13.5 });
    const empty = textFrame(chart, { ...d, text: { value: '' } }, measure7, 'Note');
    expect(empty?.lines).toEqual(['Note']);
    expect(empty?.size).toBe(TEXT_SIZE);
    expect(textFrame(chart, { ...d, points: [] }, measure7)).toBeNull();
  });

  it('reads a contentEditable back with its line structure folded to newlines', () => {
    const { doc } = installDom();
    const box = doc.createElement('div');
    box.appendChild(doc.createTextNode('one'));
    box.appendChild(doc.createElement('br'));
    const div = doc.createElement('div');
    div.appendChild(doc.createTextNode('two'));
    box.appendChild(div);
    box.appendChild(doc.createElement('br'));
    expect(readEditable(box as unknown as Node)).toBe('one\ntwo');
  });

  it('lays the box over the painted text, commits on blur, and cancels on Escape', () => {
    const rig = makeRig();
    const t = text(rig.draw, 'Hello');
    rig.draw.select(t.id);
    const done: boolean[] = [];
    const h = mountTextEditor(rig.ctx, undefined, { onDone: (c) => done.push(c) });
    const box = rig.q('.oac-textedit') as FakeElement;
    expect(box).not.toBeNull();
    expect(box.getAttribute('contenteditable')).toBe('plaintext-only');
    expect(box.textContent).toBe('Hello');
    // Chart coordinates plus the container's offset inside the root.
    const x = rig.chart.timeToCoordinate(T0 + 600);
    const y = rig.chart.priceToCoordinate(100, 0) as number;
    expect(box.style.left).toBe(`${Math.round(x + 42)}px`);
    expect(box.style.top).toBe(`${Math.round(y + 40)}px`);
    expect(rig.dom.doc.activeElement).toBe(box);
    box.textContent = 'Changed';
    box.blur();
    expect(rig.draw.get(t.id)?.text?.value).toBe('Changed');
    expect(done).toEqual([true]);
    expect(h.isOpen()).toBe(false);
    expect(rig.stack.size()).toBe(0);

    const h2 = mountTextEditor(rig.ctx, undefined, { id: t.id, onDone: (c) => done.push(c) });
    const box2 = rig.q('.oac-textedit') as FakeElement;
    box2.textContent = 'Discarded';
    escape(rig);
    expect(rig.draw.get(t.id)?.text?.value).toBe('Changed');
    expect(done).toEqual([true, false]);
    expect(h2.isOpen()).toBe(false);
  });

  it('keeps every key inside the box, and commits on Ctrl+Enter', () => {
    const rig = makeRig();
    const t = text(rig.draw, 'A');
    const seen: string[] = [];
    rig.dom.root.addEventListener('keydown', (e) => seen.push(String(e.key)));
    mountTextEditor(rig.ctx, undefined, { id: t.id });
    const box = rig.q('.oac-textedit') as FakeElement;
    box.fire('keydown', { key: 'Backspace' });
    box.textContent = 'B';
    box.fire('keydown', { key: 'Enter', ctrlKey: true });
    expect(seen).toEqual([]);
    expect(rig.draw.get(t.id)?.text?.value).toBe('B');
  });

  it('declines for a shape label, whose text is edited in the properties dialog', () => {
    const rig = makeRig();
    const r = rect(rig.draw);
    rig.draw.select(r.id);
    expect(mountTextEditor(rig.ctx).isOpen()).toBe(false);
    expect(rig.toasts).toEqual(['info:Select a text drawing first']);
  });
});

// ── context menu ──────────────────────────────────────────────────────────

const items = (entries: MenuEntry[]): MenuItem[] => entries.filter((e): e is MenuItem => e.kind === undefined || e.kind === 'item');
const ids = (entries: MenuEntry[]): string[] => items(entries).map((i) => i.id ?? '');

function event(rig: Rig, target: ContextMenuTarget, extra: Partial<ContextMenuEvent> = {}): ContextMenuEvent {
  let prevented = 0;
  const e: ContextMenuEvent & { prevented(): number } = {
    paneIndex: 0, point: { x: 200, y: 150 }, price: 101.25, time: T0 + 600, index: 10, target,
    preventDefault: () => { prevented++; }, prevented: () => prevented, ...extra,
  };
  void rig;
  return e;
}

describe('contextMenuEntries', () => {
  it('offers no trade rows without a host hook, and the full set at a price with one', () => {
    const rig = makeRig();
    const plain = contextMenuEntries(rig.ctx, event(rig, { kind: 'empty', id: null }));
    expect(ids(plain).some((i) => i.startsWith('order-'))).toBe(false);
    expect(ids(plain)).toEqual(['draw-paste', 'chart-fit', 'chart-indicators', 'chart-settings']);
    const orders: OrderRequest[] = [];
    const traded = contextMenuEntries(rig.ctx, event(rig, { kind: 'series', id: null, seriesType: 'candlestick' }), { onOrder: (o) => orders.push(o) });
    expect(ids(traded).filter((i) => i.startsWith('order-'))).toEqual([
      'order-buy-market', 'order-sell-market', 'order-buy-limit', 'order-sell-limit', 'order-buy-sl', 'order-sell-sl',
    ]);
    const limit = items(traded).find((i) => i.id === 'order-sell-limit') as MenuItem;
    expect(limit.label).toBe(`Sell limit at ${rig.chart.panes()[0].readoutScale().format(101.25)}`);
    limit.run?.();
    expect(orders).toEqual([{ side: 'SELL', type: 'LIMIT', price: 101.25, paneIndex: 0 }]);
    // Off the plot there is no price, so only the market rows remain.
    const off = contextMenuEntries(rig.ctx, event(rig, { kind: 'empty', id: null }, { price: null }), { onOrder: () => {} });
    expect(ids(off).filter((i) => i.startsWith('order-'))).toEqual(['order-buy-market', 'order-sell-market']);
  });

  it('acts on the drawing under the pointer: it becomes the selection and every action reaches the controller', () => {
    const rig = makeRig();
    const a = line(rig.draw);
    const other = rect(rig.draw);
    rig.draw.select(other.id);
    const entries = contextMenuEntries(rig.ctx, event(rig, { kind: 'drawing', id: `draw:${a.id}#1` }));
    expect(rig.draw.selection()).toEqual([a.id]);
    expect(ids(entries)).toEqual([
      'draw-props', 'draw-copy', 'draw-cut', 'draw-duplicate', 'draw-lock', 'draw-hide',
      'draw-front', 'draw-back', 'draw-above', 'draw-behind', 'draw-delete',
      'draw-paste', 'draw-clear', 'chart-fit', 'chart-indicators', 'chart-settings',
    ]);
    const by = (id: string): MenuItem => items(entries).find((i) => i.id === id) as MenuItem;
    expect(by('draw-above').on).toBe(true);
    expect(by('draw-behind').on).toBe(false);
    expect(by('draw-clear').label).toBe('Remove all drawings (2)');
    by('draw-lock').run?.();
    expect(rig.draw.get(a.id)?.locked).toBe(true);
    by('draw-behind').run?.();
    expect((rig.draw.get(a.id)?.zIndex ?? 0) < 0).toBe(true);
    // Locked: cut and delete are drawn disabled with the reason, not hidden.
    const again = contextMenuEntries(rig.ctx, event(rig, { kind: 'drawing', id: `draw:${a.id}` }));
    const del = items(again).find((i) => i.id === 'draw-delete') as MenuItem;
    expect(del.disabled).toBe(true);
    expect(del.note).toBe('locked');
    expect((items(again).find((i) => i.id === 'draw-lock') as MenuItem).label).toBe('Unlock');
    (items(again).find((i) => i.id === 'draw-duplicate') as MenuItem).run?.();
    expect(rig.draw.drawings().length).toBe(3);
  });

  it('adds text and level rows only for tools that have them', () => {
    const rig = makeRig();
    const t = text(rig.draw);
    const f = fib(rig.draw);
    expect(ids(contextMenuEntries(rig.ctx, event(rig, { kind: 'drawing', id: `draw:${t.id}` })))).toContain('draw-text');
    const fibIds = ids(contextMenuEntries(rig.ctx, event(rig, { kind: 'drawing', id: `draw:${f.id}` })));
    expect(fibIds).toContain('draw-levels');
    expect(fibIds).not.toContain('draw-text');
    expect(drawingIdOf({ kind: 'drawing', id: 'draw:abc#2' })).toBe('abc');
    expect(drawingIdOf({ kind: 'primitive', id: 'order:1' })).toBeNull();
  });

  it('offers an indicator its settings, visibility and removal', () => {
    const rig = makeRig();
    const inst = rig.chart.addIndicator('test-ma');
    const entries = contextMenuEntries(rig.ctx, event(rig, { kind: 'indicator', id: `indicator:${inst.id}:ma`, instanceId: inst.id }));
    expect(ids(entries).slice(0, 3)).toEqual(['ind-settings', 'ind-visible', 'ind-remove']);
    const by = (id: string): MenuItem => items(entries).find((i) => i.id === id) as MenuItem;
    expect(by('ind-settings').label).toBe('Test MA settings...');
    by('ind-visible').run?.();
    expect(inst.visible()).toBe(false);
    by('ind-remove').run?.();
    expect(rig.chart.indicators().length).toBe(0);
  });

  it('builds the axis menu off priceAxisState and writes back through the axis calls', () => {
    const rig = makeRig();
    const entries = contextMenuEntries(rig.ctx, event(rig, { kind: 'price-scale', id: null, side: 'right', scaleId: 'right' }));
    expect(ids(entries)).toEqual([
      'axis-autofit', 'axis-invert', 'axis-lock', 'axis-mode-linear', 'axis-mode-logarithmic', 'axis-mode-percentage',
      'axis-mode-indexed-to-100', 'axis-move', 'axis-settings',
    ]);
    const by = (id: string): MenuItem => items(entries).find((i) => i.id === id) as MenuItem;
    expect(by('axis-autofit').on).toBe(true);
    expect(by('axis-mode-linear').on).toBe(true);
    expect(by('axis-mode-linear').mark).toBe('radio');
    expect(by('axis-lock').disabled).toBe(false);
    by('axis-invert').run?.();
    expect(rig.chart.priceAxisState(0, 'right')?.inverted).toBe(true);
    by('axis-mode-logarithmic').run?.();
    expect(rig.chart.priceAxisState(0, 'right')?.mode).toBe('logarithmic');
    by('axis-autofit').run?.();
    expect(rig.chart.priceAxisState(0, 'right')?.autoFit).toBe(false);
    // Nothing on the left, so there is nothing to move there: greyed, with the reason.
    const left = contextMenuEntries(rig.ctx, event(rig, { kind: 'price-scale', id: null, side: 'left', scaleId: 'left' }));
    const move = items(left).find((i) => i.id === 'axis-move') as MenuItem;
    expect(move.disabled).toBe(true);
    expect(move.note).toBe('nothing on this side');
  });

  it('appends a host\'s own rows after everything else', () => {
    const rig = makeRig();
    const entries = contextMenuEntries(rig.ctx, event(rig, { kind: 'empty', id: null }), { items: () => [{ id: 'host-x', label: 'Alert here' }] });
    expect(ids(entries)[ids(entries).length - 1]).toBe('host-x');
  });
});

describe('mountContextMenu', () => {
  it('renders the rows at the pointer, marks switches and choices, runs a row and closes', () => {
    const rig = makeRig();
    const a = line(rig.draw);
    mountContextMenu(rig.ctx, undefined, { event: event(rig, { kind: 'drawing', id: `draw:${a.id}` }) });
    const menu = rig.q('.oac-ctx') as FakeElement;
    expect(menu.getAttribute('role')).toBe('menu');
    // The pointer sat at 200,150 in chart px; the chart starts at 42,40 in the root.
    expect([menu.style.left, menu.style.top]).toEqual(['242px', '190px']);
    const row = (act: string): FakeElement => menu.querySelector(`[data-act="${act}"]`) as FakeElement;
    expect(row('draw-above').getAttribute('role')).toBe('menuitemradio');
    expect(row('draw-above').getAttribute('aria-checked')).toBe('true');
    expect(row('draw-lock').getAttribute('role')).toBe('menuitemcheckbox');
    expect(row('draw-copy').querySelector('kbd')?.textContent).toBe('Ctrl+C');
    expect(rig.dom.doc.activeElement).toBe(row('draw-props'));
    row('draw-hide').click();
    expect(rig.draw.get(a.id)?.visible).toBe(false);
    expect(rig.stack.size()).toBe(0);
  });

  it('keeps the axis menu up while a switch is flipped, repainting its state in place', () => {
    const rig = makeRig();
    mountContextMenu(rig.ctx, undefined, { event: event(rig, { kind: 'price-scale', id: null, side: 'right', scaleId: 'right' }) });
    const row = (act: string): FakeElement => rig.q(`[data-act="${act}"]`) as FakeElement;
    expect(row('axis-invert').getAttribute('aria-checked')).toBe('false');
    row('axis-invert').click();
    expect(rig.stack.size()).toBe(1);
    expect(row('axis-invert').getAttribute('aria-checked')).toBe('true');
    expect(rig.chart.priceAxisState(0, 'right')?.inverted).toBe(true);
    row('axis-mode-percentage').click();
    expect(row('axis-mode-percentage').getAttribute('aria-checked')).toBe('true');
    expect(row('axis-mode-linear').getAttribute('aria-checked')).toBe('false');
    row('axis-settings').click();
    expect(rig.q('.oac-settings')).not.toBeNull();
    expect(rig.q('[role="tab"][aria-selected="true"]')?.dataset.tab).toBe('axes');
  });

  it('moves with the arrow keys over enabled rows only, and a second menu replaces the first', () => {
    const rig = makeRig();
    const a = line(rig.draw, { locked: true });
    mountContextMenu(rig.ctx, undefined, { event: event(rig, { kind: 'drawing', id: `draw:${a.id}` }) });
    const menu = rig.q('.oac-ctx') as FakeElement;
    const row = (act: string): FakeElement => menu.querySelector(`[data-act="${act}"]`) as FakeElement;
    expect(row('draw-cut').getAttribute('aria-disabled')).toBe('true');
    row('draw-props').focus();
    menu.fire('keydown', { key: 'ArrowDown' });
    expect(rig.dom.doc.activeElement).toBe(row('draw-copy'));
    menu.fire('keydown', { key: 'ArrowDown' });
    expect(rig.dom.doc.activeElement).toBe(row('draw-duplicate'));
    menu.fire('keydown', { key: 'End' });
    expect(rig.dom.doc.activeElement).toBe(row('chart-settings'));
    mountContextMenu(rig.ctx, undefined, { event: event(rig, { kind: 'empty', id: null }) });
    expect(rig.qa('.oac-ctx').length).toBe(1);
    expect(rig.q('[data-act="draw-props"]')).toBeNull();
  });

  it('wires the chart event, suppresses the native menu, and unwires on the returned function', () => {
    const rig = makeRig();
    const off = attachContextMenu(rig.ctx);
    const e = event(rig, { kind: 'empty', id: null });
    rig.chart.emit('contextmenu', e);
    expect((e as unknown as { prevented(): number }).prevented()).toBe(1);
    expect(rig.q('.oac-ctx')).not.toBeNull();
    rig.stack.closeAll();
    off();
    rig.chart.emit('contextmenu', event(rig, { kind: 'empty', id: null }));
    expect(rig.q('.oac-ctx')).toBeNull();
  });

  it('opens the chart-level menu below a button when raised without an event', () => {
    const rig = makeRig();
    const btn = rig.dom.doc.createElement('button');
    btn.rect = { left: 500, top: 8, width: 30, height: 28 };
    rig.dom.root.appendChild(btn);
    WIDGET_DIALOGS.contextMenu(rig.ctx, asEl(btn));
    const menu = rig.q('.oac-ctx') as FakeElement;
    expect(menu.style.left).toBe('500px');
    expect(menu.querySelectorAll('[data-act]').map((r) => r.dataset.act)).toEqual(['draw-paste', 'chart-fit', 'chart-indicators', 'chart-settings']);
  });
});
