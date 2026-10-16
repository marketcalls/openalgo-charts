import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerDrawingTool } from '../src/draw/index';
import { createWidget, type StorageLike, type Widget, type WidgetOptions } from '../src/widget/index';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument, fire, fireKey, type FakeElement } from './helpers/fake-dom-widget';

beforeAll(() => {
  ensureWindowGlobal();
  registerDrawingTool({
    id: 'mobile-custom-tool', name: 'Host study', points: 1, draw: () => {}, distance: () => 0,
  });
});

const widgets: Widget[] = [];
afterEach(() => { for (const widget of widgets.splice(0)) widget.destroy(); });

class MemoryStorage implements StorageLike {
  private readonly _values = new Map<string, string>();
  public getItem(key: string): string | null { return this._values.get(key) ?? null; }
  public setItem(key: string, value: string): void { this._values.set(key, value); }
  public removeItem(key: string): void { this._values.delete(key); }
}

function make(options: WidgetOptions = {}) {
  const doc = fakeWidgetDocument();
  const widget = createWidget(fakeContainer(doc, 390, 700) as unknown as HTMLElement, {
    document: doc as unknown as Document, mobile: 'always', pixelRatio: () => 1,
    raf: { schedule: callback => { callback(); return 1; }, cancel: () => {} }, ...options,
  });
  widgets.push(widget);
  widget.chart.applySize(390, 700);
  widget.series.setData([{ time: 1_700_000_000, open: 100, high: 102, low: 98, close: 101 }]);
  const root = widget.root as unknown as FakeElement;
  const opener = root.querySelector('[data-mobile-action="draw"]')!;
  opener.focus();
  opener.click();
  return { widget, doc, root, opener };
}

const tools = (root: FakeElement): string[] => root.querySelectorAll('.oac-mobile__tool').map(row => row.dataset.tool!);
const search = (root: FakeElement): FakeElement => root.querySelector('.oac-mobile-drawings__search')!;
const groups = (root: FakeElement): FakeElement => root.querySelector('.oac-mobile-drawings__groups')!;
const pin = (root: FakeElement, tool: string): FakeElement => root.querySelector(`[data-mobile-action="favorite"][data-tool="${tool}"]`)!;

describe('mobile drawing discovery', () => {
  it('finds allowed drawings by id, registry name and localized label', () => {
    const { root } = make({
      rail: { tools: ['trend-line', 'rectangle'] },
      translate: (key, fallback) => key === 'schema.drawing.trend-line.name' ? 'Ligne de tendance' : fallback,
    });
    expect(search(root)).not.toBeNull();
    for (const query of ['  TrEnD-LiNe  ', 'trend line', 'LIGNE DE']) {
      search(root).value = query;
      fire(search(root), 'input');
      expect(tools(root)).toEqual(['trend-line']);
    }
    search(root).value = 'not a drawing';
    fire(search(root), 'input');
    expect(tools(root)).toEqual([]);
    expect(root.querySelector('.oac-mobile-drawings__empty')?.textContent).toContain('No drawing tools found');
    search(root).value = '';
    fire(search(root), 'input');
    expect(tools(root)).toEqual(['trend-line', 'rectangle']);
  });

  it('browses existing translated groups without hiding host registered drawings', () => {
    const { widget, root } = make({
      rail: { tools: ['trend-line', 'rectangle', 'mobile-custom-tool', 'missing-tool'] },
      translate: (key, fallback) => key === 'schema.rail.shapes.title' ? 'Formes' : fallback,
    });
    expect(groups(root)).not.toBeNull();
    expect(groups(root).querySelectorAll('option').map(option => option.getAttribute('value'))).toEqual(['all', 'favorites', 'lines', 'shapes']);
    expect(groups(root).querySelector('[value="shapes"]')?.textContent).toBe('Formes');
    groups(root).value = 'shapes';
    fire(groups(root), 'change');
    expect(tools(root)).toEqual(['rectangle']);
    groups(root).value = 'all';
    fire(groups(root), 'change');
    search(root).value = 'host study';
    fire(search(root), 'input');
    expect(tools(root)).toEqual(['mobile-custom-tool']);
    root.querySelector('.oac-mobile__tool')!.click();
    expect(widget.draw.activeTool()).toBe('mobile-custom-tool');
    expect(root.querySelector('.oac-mobile-sheet')).toBeNull();
  });

  it('shows a named tool beside the shared glyph and a separate pin action', () => {
    const { root } = make({ rail: { tools: ['trend-line', 'mobile-custom-tool'] } });
    const tool = root.querySelector('.oac-mobile__tool[data-tool="trend-line"]')!;
    expect(tool.querySelector('.oac-glyph--tool')).not.toBeNull();
    expect(tool.textContent).toContain('Trend Line');
    expect(pin(root, 'trend-line')).not.toBeNull();
    expect(pin(root, 'trend-line').parentNode).toBe(tool.parentNode);
    expect(tool.contains(pin(root, 'trend-line'))).toBe(false);
    expect(root.querySelector('.oac-mobile__tool[data-tool="mobile-custom-tool"]')?.textContent).toContain('Host study');
  });

  it('finds a host drawing registered after the sheet opened', () => {
    const { widget, root } = make();
    registerDrawingTool({ id: 'mobile-late-tool', name: 'Late host tool', points: 1, draw: () => {}, distance: () => 0 });
    search(root).value = 'late host';
    fire(search(root), 'input');
    expect(tools(root)).toEqual(['mobile-late-tool']);
    root.querySelector('.oac-mobile__tool')!.click();
    expect(widget.draw.activeTool()).toBe('mobile-late-tool');
  });

  it('pins through rail preferences and restores the same favorites on reload', () => {
    const storage = new MemoryStorage();
    const { widget, root } = make({ persist: true, storage, rail: { tools: ['trend-line', 'rectangle'], favorites: ['rectangle'] } });
    expect(pin(root, 'trend-line')).not.toBeNull();
    pin(root, 'trend-line').click();
    expect(widget.draw.activeTool()).toBeNull();
    expect(widget.getState().rail?.favorites).toEqual(['rectangle', 'trend-line']);
    expect(root.querySelector('.oac-rail__fav[data-tools="trend-line"]')).not.toBeNull();
    expect(pin(root, 'trend-line').getAttribute('aria-pressed')).toBe('true');
    groups(root).value = 'favorites';
    fire(groups(root), 'change');
    expect(tools(root)).toEqual(['trend-line', 'rectangle']);
    widget.destroy();
    widgets.splice(widgets.indexOf(widget), 1);

    const restored = make({ persist: true, storage, rail: { tools: ['trend-line', 'rectangle'] } });
    groups(restored.root).value = 'favorites';
    fire(groups(restored.root), 'change');
    expect(tools(restored.root)).toEqual(['trend-line', 'rectangle']);
    pin(restored.root, 'rectangle').click();
    expect(restored.widget.getState().rail?.favorites).toEqual(['trend-line']);
    expect(tools(restored.root)).toEqual(['trend-line']);
  });

  it('keeps query, input selection and scroll through controller driven repaint', () => {
    const { widget, doc, root } = make({ rail: { tools: ['trend-line', 'rectangle'] } });
    expect(search(root)).not.toBeNull();
    const input = search(root);
    input.focus();
    input.value = 'trend';
    Object.assign(input, { selectionStart: 1, selectionEnd: 4 });
    fire(input, 'input');
    const body = root.querySelector('.oac-mobile-sheet__body')!;
    Object.assign(body, { scrollTop: 120 });
    widget.draw.add({ tool: 'horizontal-line', points: [{ time: 1_700_000_000, price: 100 }], style: {}, paneIndex: 0 });
    expect(search(root)).toBe(input);
    expect(input.value).toBe('trend');
    expect((input as unknown as HTMLInputElement).selectionStart).toBe(1);
    expect((input as unknown as HTMLInputElement).selectionEnd).toBe(4);
    expect(doc.activeElement).toBe(input);
    expect((body as unknown as HTMLElement).scrollTop).toBe(120);
    expect(tools(root)).toEqual(['trend-line']);
  });

  it('honors the allowlist in favorites and preserves focused pin state through repaint', () => {
    const { widget, doc, root } = make({ rail: { tools: ['rectangle'], favorites: ['trend-line', 'rectangle'] } });
    expect(groups(root)).not.toBeNull();
    groups(root).value = 'favorites';
    fire(groups(root), 'change');
    expect(tools(root)).toEqual(['rectangle']);
    pin(root, 'rectangle').focus();
    widget.draw.add({ tool: 'horizontal-line', points: [{ time: 1_700_000_000, price: 100 }], style: {}, paneIndex: 0 });
    expect(doc.activeElement).toBe(pin(root, 'rectangle'));
    expect(groups(root).value).toBe('favorites');
    pin(root, 'rectangle').click();
    expect(tools(root)).toEqual([]);
    expect(root.querySelector('.oac-mobile-sheet__body')!.contains(doc.activeElement)).toBe(true);
  });

  it('keeps cursor and overlay dismissal on the existing controller and focus paths', () => {
    const { widget, doc, root, opener } = make({ rail: { tools: ['trend-line'] } });
    widget.draw.setTool('trend-line');
    const cursor = root.querySelector('[data-mobile-action="cursor"]');
    expect(cursor).not.toBeNull();
    cursor!.click();
    expect(widget.draw.activeTool()).toBeNull();
    expect(root.querySelector('.oac-mobile-sheet')).toBeNull();
    opener.click();
    expect(search(root)).not.toBeNull();
    search(root).focus();
    fireKey(doc, 'Escape');
    expect(root.querySelector('.oac-mobile-sheet')).toBeNull();
    expect(doc.activeElement).toBe(opener);
  });
});
