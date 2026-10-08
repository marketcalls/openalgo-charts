import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeContainer, fakeWidgetDocument, FakeEvent, ensureWindowGlobal } from './helpers/fake-dom-widget';
import { PanelDragSession } from '../src/widget/dock/drag-session';
import { createTerminalWorkspace } from '../src/widget/dock/controller';
import { collectPanelIds, insertPanel, movePanel } from '../src/widget/dock/model';
import { createChartPanel } from '../src/widget/dock/panel-adapters';
import { createStandaloneDomPanel, StandaloneDomLadder } from '../src/widget/dock/dom-panel';
import { LinkHub } from '../src/widget/dock/link-hub';
import { TERMINAL_STORAGE_KEY } from '../src/widget/dock/persist';
import type { TerminalDocument, TerminalPanel, LinkContext } from '../src/widget/dock/types';

afterEach(() => vi.unstubAllGlobals());
const panel = (id: string, type: 'chart' | 'dom' = 'chart'): TerminalPanel => ({
  id, type, title: id, mount: () => ({ destroy() {} }),
});
const stored = (document: TerminalDocument) => {
  const data = new Map([[TERMINAL_STORAGE_KEY, JSON.stringify(document)]]);
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }), removeItem: (key: string) => { data.delete(key); } };
};

describe('terminal panel gestures', () => {
  function drag() {
    const doc = fakeWidgetDocument(), container = fakeContainer(doc);
    vi.stubGlobal('window', doc);
    const onDock = vi.fn(), onFloat = vi.fn();
    const rect = container.getBoundingClientRect() as DOMRect;
    const session = new PanelDragSession({ panelId: 'a', title: 'A', container: container as unknown as HTMLElement,
      preview: { show: vi.fn(), hide: vi.fn() } as any,
      getPanes: () => [{ targetNodeId: 'b', rect }], onDock, onFloat });
    session.start(new FakeEvent('pointerdown', { clientX: 100, clientY: 100 }) as unknown as PointerEvent);
    return { doc, onDock, onFloat };
  }
  it('does not dock on a click or a cancelled drag', () => {
    const click = drag();
    click.doc.dispatchEvent(new FakeEvent('pointerup', { clientX: 102, clientY: 100 }));
    expect(click.onDock).not.toHaveBeenCalled();
    const cancel = drag();
    cancel.doc.dispatchEvent(new FakeEvent('pointermove', { clientX: 300, clientY: 100 }));
    cancel.doc.dispatchEvent(new FakeEvent('pointercancel', { clientX: 300, clientY: 100 }));
    expect(cancel.onDock).not.toHaveBeenCalled();
    expect(cancel.onFloat).not.toHaveBeenCalled();
  });
  it('commits a real drop and recomputes the release location', () => {
    const inside = drag();
    inside.doc.dispatchEvent(new FakeEvent('pointermove', { clientX: 400, clientY: 300 }));
    inside.doc.dispatchEvent(new FakeEvent('pointerup', { clientX: 400, clientY: 300 }));
    expect(inside.onDock).toHaveBeenCalledWith('a', 'b', 'center');
    const outside = drag();
    outside.doc.dispatchEvent(new FakeEvent('pointermove', { clientX: 400, clientY: 300 }));
    outside.doc.dispatchEvent(new FakeEvent('pointerup', { clientX: 1000, clientY: 300 }));
    expect(outside.onDock).not.toHaveBeenCalled();
    expect(outside.onFloat).toHaveBeenCalledOnce();
  });
  it('retains both panels after a self drop or a stale target', () => {
    const tree = insertPanel(insertPanel(null, 'a', '', 'center'), 'b', 'a', 'right');
    expect(collectPanelIds(movePanel(tree, 'a', 'a', 'center'))).toEqual(['a', 'b']);
    expect(collectPanelIds(movePanel(tree, 'a', 'missing', 'left'))).toEqual(['a', 'b']);
  });
});

describe('terminal ownership and restoration', () => {
  it('destroys the entire widget when a chart adapter closes', () => {
    ensureWindowGlobal();
    const doc = fakeWidgetDocument(), host = fakeContainer(doc);
    const chart = createChartPanel({ symbol: 'NIFTY', interval: '5m', feed: { getBars: async () => [] },
      widgetOptions: { document: doc as unknown as Document } });
    const handle = chart.mount(host as unknown as HTMLElement);
    expect(host.querySelector('.oac-widget')).not.toBeNull();
    handle.destroy();
    expect(host.querySelector('.oac-widget')).toBeNull();
  });
  it('recreates docked and floating panels before restoring state without overwriting storage', () => {
    const document: TerminalDocument = { version: 1,
      layout: { type: 'panel', id: 'node_a', panelId: 'a' },
      floating: [{ id: 'float_b', panelId: 'b', x: 120, y: 80, width: 360, height: 320, zIndex: 777 }],
      panels: { a: { type: 'chart', title: 'A', state: { interval: '15m' } },
        b: { type: 'dom', title: 'B', state: { symbol: 'TCS' } } } };
    const storage = stored(document), doc = fakeWidgetDocument();
    const restoreA = vi.fn(), restoreB = vi.fn();
    const workspace = createTerminalWorkspace(fakeContainer(doc) as unknown as HTMLElement, { persist: true, storage,
      createPanel: (id, info) => ({ id, type: info.type, title: info.title,
        mount: () => ({ destroy() {}, restore: id === 'a' ? restoreA : restoreB }) }) });
    expect(workspace.saveLayout().layout).toEqual(document.layout);
    expect(workspace.saveLayout().floating).toEqual(document.floating);
    expect(restoreA).toHaveBeenCalledWith({ interval: '15m' });
    expect(restoreB).toHaveBeenCalledWith({ symbol: 'TCS' });
    expect(storage.setItem).not.toHaveBeenCalled();
    workspace.destroy();
  });
  it('defers restoration until saved IDs are registered and retains inactive tab state', () => {
    const document: TerminalDocument = { version: 1, floating: [],
      layout: { type: 'tabs', id: 'tabs', panels: ['a', 'b'], active: 'a' },
      panels: { a: { type: 'chart', title: 'A', state: { value: 1 } }, b: { type: 'chart', title: 'B', state: { value: 2 } } } };
    const storage = stored(document), doc = fakeWidgetDocument(), restore = vi.fn();
    const workspace = createTerminalWorkspace(fakeContainer(doc) as unknown as HTMLElement, { persist: true, storage });
    workspace.addPanel(panel('a'));
    expect(storage.setItem).not.toHaveBeenCalled();
    workspace.addPanel({ ...panel('b'), mount: () => ({ destroy() {}, restore }) });
    expect(workspace.saveLayout().panels.b?.state).toEqual({ value: 2 });
    expect(restore).not.toHaveBeenCalled();
    workspace.activateTab('b');
    expect(restore).toHaveBeenCalledWith({ value: 2 });
    workspace.destroy();
  });
  it('restores a floating-only document and uses stable DOM IDs', () => {
    const doc = fakeWidgetDocument();
    const workspace = createTerminalWorkspace(fakeContainer(doc) as unknown as HTMLElement);
    const dom = createStandaloneDomPanel({ id: 'dom_stable', symbol: 'TCS', document: doc as unknown as Document });
    workspace.addPanel(dom);
    workspace.floatPanel(dom.id);
    const saved = workspace.saveLayout();
    expect(saved.layout).toBeNull();
    expect(workspace.restoreLayout(saved)).toBe(true);
    expect(workspace.saveLayout().floating[0]?.panelId).toBe('dom_stable');
    workspace.destroy();
  });
  it('rejects an incomplete preset without duplicating a mounted panel', () => {
    const doc = fakeWidgetDocument();
    const workspace = createTerminalWorkspace(fakeContainer(doc) as unknown as HTMLElement);
    workspace.addPanel(panel('a'));
    workspace.addPanel(panel('d', 'dom'));
    const before = workspace.getLayout();
    expect(workspace.loadPreset('two-charts-dom')).toBe(false);
    expect(workspace.getLayout()).toBe(before);
    expect(workspace.loadPreset('chart-dom')).toBe(true);
    workspace.destroy();
  });
});

describe('terminal linked instruments and depth', () => {
  it('preserves the fourth sender argument even when it is not registered', () => {
    const hub = new LinkHub(), receive = vi.fn();
    hub.setPanelGroup('follower', 'red');
    hub.registerListener('follower', receive);
    hub.broadcast('red', 'TCS', '5m', 'unregistered-sender');
    expect(receive).toHaveBeenCalledWith({ group: 'red', symbol: 'TCS', interval: '5m' });
    hub.broadcast('red', 'TCS', '5m', 'unregistered-sender', 'NSE');
    expect(receive).toHaveBeenLastCalledWith({ group: 'red', symbol: 'TCS', interval: '5m', exchange: 'NSE' });
  });
  it('applies a linked change once and does not echo follower events', () => {
    const doc = fakeWidgetDocument(), receive = vi.fn();
    const workspace = createTerminalWorkspace(fakeContainer(doc) as unknown as HTMLElement);
    for (const id of ['a', 'b']) {
      let broadcast: ((ctx: { symbol: string; interval?: string; exchange?: string }) => void) | undefined;
      workspace.addPanel({ ...panel(id), linkGroup: 'red', mount: () => ({ destroy() {},
        onLinkBroadcast(cb) { broadcast = cb; }, onLinkUpdate(ctx: LinkContext) {
          receive(id, ctx);
          broadcast?.({ symbol: ctx.symbol, interval: ctx.interval, exchange: ctx.exchange });
        } }), onLinkUpdate: () => { throw new Error('duplicate link application'); } });
    }
    workspace.broadcastLink('red', 'TCS', '15m', 'NSE');
    expect(receive).toHaveBeenCalledTimes(2);
    workspace.destroy();
  });
  it('moves LTP highlighting after a depth update or explicit price update', () => {
    const doc = fakeWidgetDocument();
    const ladder = new StandaloneDomLadder({ symbol: 'TCS', document: doc as unknown as Document, tickSize: 0.05,
      depth: { ltp: 100, bids: [{ price: 100, qty: 5 }], asks: [{ price: 101, qty: 7 }] } });
    expect((ladder.element.querySelector('.is-ltp') as HTMLElement).dataset.price).toBe('100');
    ladder.setLtp(100.8);
    expect((ladder.element.querySelector('.is-ltp') as HTMLElement).dataset.price).toBe('101');
    ladder.setDepth({ ltp: 102, bids: [{ price: 102, qty: 5 }], asks: [{ price: 103, qty: 7 }] });
    expect((ladder.element.querySelector('.is-ltp') as HTMLElement).dataset.price).toBe('102');
    ladder.destroy();
  });
});
