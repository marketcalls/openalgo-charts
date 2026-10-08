import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument, FakeEvent, type FakeElement } from './helpers/fake-dom-widget';
import { createTerminalWorkspace } from '../src/widget/dock/controller';
import { collectPanelIds } from '../src/widget/dock/model';
import { createChartPanel } from '../src/widget/dock/panel-adapters';
import { buildDomRows, StandaloneDomLadder } from '../src/widget/dock/dom-panel';
import { priceDecimals } from '../src/widget/dock/ladder-view';
import { DockSplitter } from '../src/widget/dock/splitter';
import { FloatingPanelWindow } from '../src/widget/dock/floating';
import { LinkHub } from '../src/widget/dock/link-hub';
import { TERMINAL_STORAGE_KEY } from '../src/widget/dock/persist';
import { TERMINAL_CSS } from '../src/widget/dock/styles';
import { createOrderTicketPanel } from '../src/widget/dock/trading-panels';
import { buildRows } from '../src/trade/dom-ladder';
import { TickSchedule } from '../src/feed/tick-schedule';
import type { PanelHandle, TerminalDocument, TerminalPanel } from '../src/widget/dock/types';

afterEach(() => vi.useRealTimers());

const panel = (id: string, type: TerminalPanel['type'] = 'chart', handle: Partial<PanelHandle> = {}): TerminalPanel => ({
  id, type, title: id, mount: () => ({ destroy() {}, ...handle }),
});
const stored = (document: TerminalDocument) => {
  const data = new Map([[TERMINAL_STORAGE_KEY, JSON.stringify(document)]]);
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }), removeItem: (key: string) => { data.delete(key); } };
};
const savedWithRetiredPanel = (): TerminalDocument => ({ version: 1, floating: [],
  layout: { type: 'split', id: 'root', direction: 'horizontal', ratio: 0.6, children: [
    { type: 'panel', id: 'node_a', panelId: 'a' },
    { type: 'split', id: 'right', direction: 'vertical', ratio: 0.5, children: [
      { type: 'panel', id: 'node_b', panelId: 'b' },
      { type: 'panel', id: 'node_retired', panelId: 'retired' },
    ] },
  ] },
  panels: { a: { type: 'chart', title: 'A' }, b: { type: 'chart', title: 'B' }, retired: { type: 'chart', title: 'Gone' } } });

describe('a saved document naming a panel the application no longer registers', () => {
  it('restores the registered panels after the registering task and keeps addPanel working', async () => {
    vi.useFakeTimers();
    const onRestoreError = vi.fn();
    const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement,
      { persist: true, storage: stored(savedWithRetiredPanel()), onRestoreError });
    workspace.addPanel(panel('a'));
    workspace.addPanel(panel('b'));
    expect(workspace.getLayout()).toBeNull(); // still deferred within the task
    vi.runAllTimers();
    const layout = workspace.getLayout()!;
    expect(collectPanelIds(layout)).toEqual(['a', 'b']);
    expect(layout).toMatchObject({ id: 'root', ratio: 0.6 }); // the saved geometry, not a fresh layout
    expect(onRestoreError).toHaveBeenCalledWith(expect.stringContaining('retired'));
    workspace.addPanel(panel('c'));
    expect(collectPanelIds(workspace.getLayout()!)).toEqual(['a', 'b', 'c']);
    expect(workspace.saveLayout().panels.retired).toBeUndefined();
    workspace.destroy();
  });

  it('waits for a registration when none of the saved panels is registered yet', () => {
    vi.useFakeTimers();
    const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement,
      { persist: true, storage: stored(savedWithRetiredPanel()) });
    vi.runAllTimers();
    workspace.addPanel(panel('a'));
    vi.runAllTimers();
    expect(collectPanelIds(workspace.getLayout()!)).toEqual(['a']);
    workspace.destroy();
  });

  it('places a panel registered during the deferral that the saved document does not mention', () => {
    const document = savedWithRetiredPanel();
    delete document.panels.retired;
    document.layout = { type: 'split', id: 'root', direction: 'horizontal', ratio: 0.6, children: [
      { type: 'panel', id: 'node_a', panelId: 'a' }, { type: 'panel', id: 'node_b', panelId: 'b' }] };
    const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement,
      { persist: true, storage: stored(document) });
    workspace.addPanel(panel('a'));
    workspace.addPanel(panel('extra'));
    workspace.addPanel(panel('b'));
    expect(collectPanelIds(workspace.getLayout()!).sort()).toEqual(['a', 'b', 'extra']);
    workspace.destroy();
  });

  it('lets createPanel decline a panel and restores the rest at once', () => {
    const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement,
      { persist: true, storage: stored(savedWithRetiredPanel()), createPanel: (id, info) => id === 'retired' ? null : panel(id, info.type) });
    expect(collectPanelIds(workspace.getLayout()!)).toEqual(['a', 'b']);
    workspace.addPanel(panel('c'));
    expect(collectPanelIds(workspace.getLayout()!)).toContain('c');
    workspace.destroy();
  });
});

describe('ladder prices at the instrument precision', () => {
  it('derives the decimals from the tick, never fewer than two', () => {
    expect(priceDecimals(0.05)).toBe(2);
    expect(priceDecimals(0.001)).toBe(3);
    expect(priceDecimals(0.0025)).toBe(4);
    expect(priceDecimals(1)).toBe(2);
  });

  it('labels distinct sub-cent ticks distinctly, in rows, buttons and the spread', () => {
    const doc = fakeWidgetDocument();
    const ladder = new StandaloneDomLadder({ document: doc as unknown as Document, symbol: 'FX', tickSize: 0.001,
      depth: { ltp: 1.2325, bids: [{ price: 1.232, qty: 5 }, { price: 1.231, qty: 5 }], asks: [{ price: 1.233, qty: 5 }, { price: 1.234, qty: 5 }] } });
    const labels = [...ladder.element.querySelectorAll('.oac-dom-row .col-price')].map(cell => cell.textContent);
    expect(labels).toEqual(['1.234', '1.233', '1.232', '1.231']);
    const buy = ladder.element.querySelector('.oac-dom-cell-btn--buy')!;
    expect(buy.getAttribute('aria-label')).toBe('Buy limit at 1.234');
    expect(ladder.element.querySelector('.oac-dom-summary')!.textContent).toContain('Spread 0.001');
    ladder.destroy();
  });

  it('uses a schedule\'s finest grid', () => {
    const doc = fakeWidgetDocument();
    const tickSchedule = new TickSchedule([{ tick: 0.005 }, { from: 10, tick: 0.05 }]);
    const ladder = new StandaloneDomLadder({ document: doc as unknown as Document, symbol: 'S', tickSchedule,
      depth: { ltp: 9.9925, bids: [{ price: 9.99, qty: 1 }], asks: [{ price: 9.995, qty: 1 }] } });
    expect([...ladder.element.querySelectorAll('.oac-dom-row .col-price')].map(cell => cell.textContent)).toEqual(['9.995', '9.990']);
    ladder.destroy();
  });

  it('builds the same rows as the trade tier ladder', () => {
    const depth = { ltp: 100, bids: [{ price: 99.96, qty: 2 }, { price: 99.9, qty: 3 }], asks: [{ price: 100.04, qty: 4 }, { price: 100.11, qty: 1 }] };
    const schedule = new TickSchedule([{ tick: 0.05 }, { from: 100, tick: 0.1 }]);
    expect(buildDomRows(depth, 0.05, 2)).toEqual(buildRows(depth, 0.05, 2));
    expect(buildDomRows(depth, schedule, 3)).toEqual(buildRows(depth, schedule, 3));
  });
});

describe('workspace commands', () => {
  it('refuses inherited object keys as preset names', () => {
    const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement);
    workspace.addPanel(panel('a'));
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(() => workspace.loadPreset(name)).not.toThrow();
      expect(workspace.loadPreset(name)).toBe(false);
    }
    workspace.destroy();
  });

  it('reports the rebuilt layout after a reset without a default preset', async () => {
    const onLayoutChange = vi.fn();
    const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement, { onLayoutChange });
    workspace.addPanel(panel('a'));
    workspace.addPanel(panel('b'), 'a', 'center');
    await workspace.flush();
    onLayoutChange.mockClear();
    workspace.resetLayout();
    await workspace.flush();
    expect(onLayoutChange).toHaveBeenCalledOnce();
    expect(onLayoutChange.mock.lastCall![0].layout).toMatchObject({ type: 'split' });
    workspace.destroy();
  });

  it('updates a title whose panel ID holds selector characters', () => {
    let changeTitle!: (title: string) => void;
    const root = fakeContainer(fakeWidgetDocument());
    const workspace = createTerminalWorkspace(root as unknown as HTMLElement);
    const id = 'chart "quoted"] .x';
    workspace.addPanel(panel(id, 'chart', { onTitleChange(callback) { changeTitle = callback; } }));
    workspace.addPanel(panel('other'), id, 'center');
    expect(() => changeTitle('Renamed')).not.toThrow();
    workspace.activateTab(id);
    const titles = root.querySelectorAll('.oac-dock-tab').filter(tab => tab.dataset.panelId === id)
      .map(tab => tab.querySelector('.oac-dock-title-text')!.textContent);
    expect(titles).toEqual(['Renamed']);
    workspace.destroy();
  });

  it('renders a missing panel\'s ID as text, never as markup', () => {
    const root = fakeContainer(fakeWidgetDocument());
    const workspace = createTerminalWorkspace(root as unknown as HTMLElement);
    // Every public layout path validates panel IDs, so an orphan leaf is planted directly.
    const id = '<img src=x onerror="alert(1)">';
    const internals = workspace as unknown as { _layout: unknown; render(): void };
    internals._layout = { type: 'panel', id: 'orphan', panelId: id };
    internals.render();
    const empty = root.querySelector('.oac-dom-empty')!;
    expect(empty.textContent).toBe(`Panel not found (${id})`);
    expect(empty.innerHTML).toBe(`Panel not found (${id})`);
    expect(empty.children).toHaveLength(0);
    expect(root.querySelector('img')).toBeNull();
    workspace.destroy();
  });

  it.each([[0.01, 0.05, '5'], [0.99, 0.95, '95']])('clamps a restored split ratio of %s to the divider bounds', (saved, ratio, now) => {
    const root = fakeContainer(fakeWidgetDocument());
    const workspace = createTerminalWorkspace(root as unknown as HTMLElement);
    workspace.addPanel(panel('a')); workspace.addPanel(panel('b'), 'a', 'right');
    expect(workspace.restoreLayout({ version: 1, floating: [], panels: { a: { type: 'chart', title: 'a' }, b: { type: 'chart', title: 'b' } },
      layout: { type: 'split', id: 'root', direction: 'horizontal', ratio: saved, children: [
        { type: 'panel', id: 'na', panelId: 'a' }, { type: 'panel', id: 'nb', panelId: 'b' }] } })).toBe(true);
    expect(workspace.getLayout()).toMatchObject({ type: 'split', ratio });
    const splitter = root.querySelector('.oac-dock-splitter')!;
    expect(splitter.getAttribute('aria-valuenow')).toBe(now);
    expect(Number(now)).toBeGreaterThanOrEqual(Number(splitter.getAttribute('aria-valuemin')));
    expect(Number(now)).toBeLessThanOrEqual(Number(splitter.getAttribute('aria-valuemax')));
    workspace.destroy();
  });
});

describe('tab semantics', () => {
  it('keeps the close and link controls outside the tab and labels the panel by the active tab', () => {
    const root = fakeContainer(fakeWidgetDocument());
    const workspace = createTerminalWorkspace(root as unknown as HTMLElement);
    workspace.addPanel(panel('a'));
    workspace.addPanel(panel('b'), 'a', 'center');
    const tabs = root.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      expect(tab.querySelector('button')).toBeNull();
      expect(tab.querySelector('.oac-dock-link-badge')).toBeNull();
      expect(tab.parentElement!.querySelector('.oac-dock-tab-close')).not.toBeNull();
    }
    const body = root.querySelector('[role="tabpanel"]')!;
    const active = tabs.find(tab => tab.getAttribute('aria-selected') === 'true')!;
    expect(body.getAttribute('aria-labelledby')).toBe(active.id);
    expect(tabs.every(tab => tab.getAttribute('aria-controls') === body.id)).toBe(true);
    const other = tabs.find(tab => tab !== active)!;
    workspace.activateTab(other.parentElement!.dataset.panelId!);
    expect(body.getAttribute('aria-labelledby')).toBe(other.id);
    expect(other.getAttribute('tabindex')).toBe('0');
    workspace.destroy();
  });
});

describe('splitter keyboard and naming', () => {
  function splitter(direction: 'horizontal' | 'vertical' = 'horizontal') {
    const doc = fakeWidgetDocument(), ratios: number[] = [];
    const instance = new DockSplitter({ direction, currentRatio: 0.5, document: doc as unknown as Document, onRatioChange: ratio => ratios.push(ratio) });
    return { instance, ratios, element: instance.element as unknown as FakeElement };
  }

  it('names the panes it resizes and exposes its range', () => {
    const { element } = splitter('vertical');
    expect(element.getAttribute('aria-label')).toBe('Resize top and bottom panes');
    expect(element.getAttribute('aria-valuemin')).toBe('5');
    expect(element.getAttribute('aria-valuemax')).toBe('95');
  });

  it('moves to the endpoints on Home and End and keeps the value and the key to itself', () => {
    const { element, ratios } = splitter();
    const home = new FakeEvent('keydown', { key: 'Home' });
    element.dispatchEvent(home);
    expect(ratios[ratios.length - 1]).toBe(0.05);
    expect(element.getAttribute('aria-valuenow')).toBe('5');
    expect(home.propagationStopped).toBe(true);
    element.dispatchEvent(new FakeEvent('keydown', { key: 'End' }));
    expect(ratios[ratios.length - 1]).toBe(0.95);
    expect(element.getAttribute('aria-valuenow')).toBe('95');
    element.dispatchEvent(new FakeEvent('dblclick'));
    expect(element.getAttribute('aria-valuenow')).toBe('50');
    const other = new FakeEvent('keydown', { key: 'a' });
    element.dispatchEvent(other);
    expect(other.propagationStopped).toBe(false);
  });
});

describe('floating windows', () => {
  function windowIn(container: FakeElement, onActivate = vi.fn()) {
    return new FloatingPanelWindow({ panel: panel('f', 'custom'), container: container as unknown as HTMLElement, linkHub: new LinkHub(),
      initialBounds: { x: 10, y: 10, width: 300, height: 200 }, onDock() {}, onClose() {}, onBoundsChange() {}, onActivate });
  }

  it('raises an older window when a pointer goes down in it', () => {
    const root = fakeContainer(fakeWidgetDocument());
    const workspace = createTerminalWorkspace(root as unknown as HTMLElement);
    workspace.addPanel(panel('a', 'custom'));
    workspace.addPanel(panel('b', 'custom'));
    workspace.floatPanel('a');
    workspace.floatPanel('b');
    const z = (id: string) => workspace.saveLayout().floating.find(item => item.panelId === id)!.zIndex;
    expect(z('a')).toBeLessThan(z('b'));
    const windows = root.querySelectorAll('.oac-dock-floating');
    windows[0]!.dispatchEvent(new FakeEvent('pointerdown', { button: 0 }));
    expect(z('a')).toBeGreaterThan(z('b'));
    workspace.destroy();
  });

  it('keeps a dragged window inside the workspace', () => {
    const container = fakeContainer(fakeWidgetDocument(), 800, 600);
    const win = windowIn(container);
    const header = container.querySelector('.oac-dock-floating-header')!;
    header.dispatchEvent(new FakeEvent('pointerdown', { button: 0, clientX: 100, clientY: 20 }));
    header.dispatchEvent(new FakeEvent('pointermove', { clientX: 5000, clientY: 5000 }));
    expect(win.state).toMatchObject({ x: 500, y: 400 });
    header.dispatchEvent(new FakeEvent('pointermove', { clientX: -5000, clientY: -5000 }));
    expect(win.state).toMatchObject({ x: 0, y: 0 });
    win.destroy();
  });

  it('opens inside the workspace when dropped at its far corner or restored from a larger screen', () => {
    const container = fakeContainer(fakeWidgetDocument(), 800, 600);
    const win = new FloatingPanelWindow({ panel: panel('f', 'custom'), container: container as unknown as HTMLElement, linkHub: new LinkHub(),
      initialBounds: { x: 790, y: 590, width: 360, height: 300 }, onDock() {}, onClose() {}, onBoundsChange() {} });
    expect(win.state).toMatchObject({ x: 440, y: 300 });
    win.destroy();
    const negative = new FloatingPanelWindow({ panel: panel('g', 'custom'), container: container as unknown as HTMLElement, linkHub: new LinkHub(),
      initialBounds: { x: -50, y: -20, width: 360, height: 300 }, onDock() {}, onClose() {}, onBoundsChange() {} });
    expect(negative.state).toMatchObject({ x: 0, y: 0 });
    negative.destroy();
  });
});

describe('terminal stylesheet', () => {
  it('limits selection blocking to draggable chrome and lets touch drags through', () => {
    // Every rule whose whole selector is `selector`, joined.
    const block = (selector: string) => [...TERMINAL_CSS.matchAll(/\n([^{}\n]+) \{([^}]*)\}/g)]
      .filter(match => match[1] === selector).map(match => match[2]).join('\n');
    expect(block('.oac-terminal')).not.toContain('user-select');
    expect(TERMINAL_CSS).toMatch(/\.oac-dock-panel-header,[^{]*\.oac-dock-floating-header,[^{]*\{\s*user-select: none/);
    expect(block('.oac-dock-floating-header')).toContain('touch-action: none');
    expect(block('.oac-dock-resize-handle')).toContain('touch-action: none');
    expect(block('.oac-dock-splitter')).toContain('touch-action: none');
    expect(TERMINAL_CSS).toContain('.oac-dock-splitter:focus-visible {');
    expect(TERMINAL_CSS).toMatch(/\.oac-dom-btn--secondary,\s*\.oac-dom-btn--cancel/);
    expect(TERMINAL_CSS).not.toMatch(/font:\s*11px inherit/);
  });
});

describe('panel adapters and trading drafts', () => {
  it('keeps a chart\'s exchange when a link update names none', () => {
    ensureWindowGlobal();
    const doc = fakeWidgetDocument(), host = fakeContainer(doc);
    const chart = createChartPanel({ symbol: 'NIFTY', interval: '5m', feed: { getBars: async () => [] },
      widgetOptions: { document: doc as unknown as Document, exchange: 'NSE' } });
    const handle = chart.mount(host as unknown as HTMLElement);
    handle.onLinkUpdate!({ group: 'red', symbol: 'TCS' });
    expect(chart.widget()!.symbol()).toBe('TCS');
    expect(chart.widget()!.exchange()).toBe('NSE');
    chart.onLinkUpdate!({ group: 'red', symbol: 'INFY' });
    expect(chart.widget()!.exchange()).toBe('NSE');
    handle.onLinkUpdate!({ group: 'red', symbol: 'SENSEX', exchange: 'BSE' });
    expect(chart.widget()!.exchange()).toBe('BSE');
    handle.destroy();
  });

  it('announces and focuses the side a depth click prepared, without submitting', async () => {
    const doc = fakeWidgetDocument(), host = fakeContainer(doc);
    const placeOrder = vi.fn(async () => ({ ok: true }));
    const ticket = createOrderTicketPanel({ id: 't', symbol: 'AAA', label: 'Paper', placeOrder,
      draft: { qty: 2, type: 'LIMIT', price: 99.5, side: 'SELL' } });
    const handle = ticket.mount(host as unknown as HTMLElement);
    expect(host.querySelector('[data-terminal-status]')!.textContent).toBe('Prepared to sell. Review, then press Sell.');
    await Promise.resolve();
    const buttons = host.querySelectorAll('.oac-trading-actions button');
    expect(doc.activeElement).toBe(buttons[1]);
    expect(placeOrder).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('focuses the prepared side of a ticket the workspace mounts before attaching its tree', async () => {
    const doc = fakeWidgetDocument(), root = fakeContainer(doc);
    const workspace = createTerminalWorkspace(root as unknown as HTMLElement);
    workspace.addPanel(createOrderTicketPanel({ id: 't', symbol: 'AAA', label: 'Paper', placeOrder: async () => ({ ok: true }),
      draft: { qty: 1, type: 'LIMIT', price: 99.5, side: 'BUY' } }));
    await Promise.resolve();
    const buttons = root.querySelectorAll('.oac-trading-actions button');
    expect(buttons[0]!.isConnected).toBe(true);
    expect(doc.activeElement).toBe(buttons[0]);
    workspace.destroy();
  });
});
