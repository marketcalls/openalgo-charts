import { expect, it, vi } from 'vitest';
import { fakeContainer, fakeWidgetDocument } from './helpers/fake-dom-widget';
import { createTerminalWorkspace } from '../src/widget/dock/controller';
import { parseTerminalDocument } from '../src/widget/dock/validate-document';
import { TerminalStorage } from '../src/widget/dock/storage';
import { LinkHub } from '../src/widget/dock/link-hub';
import { releasePanel } from '../src/widget/panel-lifetime';
import type { TerminalDocument, TerminalPanel } from '../src/widget/dock/types';
import type { AsyncStorageLike } from '../src/widget/widget-storage';

const document = (): TerminalDocument => ({ version: 1, layout: { type: 'panel', id: 'root', panelId: 'orders' },
  floating: [], panels: { orders: { type: 'orders', title: 'Ticket', linkGroup: 'blue', state: { kind: 'ticket', symbol: 'AAA' } } } });
const panel = (id: string): TerminalPanel => ({ id, type: 'orders', title: 'Ticket', mount: () => ({ destroy() {} }) });

it('retains opaque panel ids while removing credentials and executable drafts', () => {
  const doc = document(); doc.panels.orders!.state = { symbol: 'AAA', kind: 'ticket', qty: 20, draft: { price: 50 }, api_key: 'secret', armed: true };
  expect(parseTerminalDocument(doc)?.panels.orders?.state).toEqual({ symbol: 'AAA', kind: 'ticket' });
  expect((doc.panels.orders!.state as { qty: number }).qty).toBe(20);
});

it.each(['type', 'linkGroup', 'interval', 'groupBy', 'sourceChart'])('rejects invalid %s before factories run', key => {
  const doc = document(); const info = doc.panels.orders!;
  if (key === 'type') (info as { type: string }).type = 'unknown';
  else if (key === 'linkGroup') (info as { linkGroup: string }).linkGroup = 'orange';
  else info.state = { [key]: key === 'groupBy' ? -1 : 'unknown' };
  const createPanel = vi.fn(panel), onRestoreError = vi.fn();
  const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement,
    { persist: true, storage: { getItem: () => JSON.stringify(doc), setItem() {}, removeItem() {} }, createPanel, onRestoreError });
  expect(createPanel).not.toHaveBeenCalled(); expect(onRestoreError).toHaveBeenCalledOnce(); workspace.destroy();
});

it('rejects getters, cycles, duplicate references and invalid ratios without changing panels', () => {
  const getter = vi.fn(); const doc = document(); Object.defineProperty(doc, 'extra', { get: getter, enumerable: true });
  expect(parseTerminalDocument(doc)).toBeNull(); expect(getter).not.toHaveBeenCalled();
  const cyclic = document(); cyclic.panels.orders!.state = cyclic;
  expect(parseTerminalDocument(cyclic)).toBeNull();
  const duplicate = document(); duplicate.layout = { type: 'tabs', id: 'tabs', panels: ['orders', 'orders'], active: 'orders' };
  expect(parseTerminalDocument(duplicate)).toBeNull();
  const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement);
  workspace.addPanel(panel('orders')); const before = workspace.getLayout();
  expect(workspace.restoreLayout(duplicate)).toBe(false); expect(workspace.getLayout()).toBe(before); workspace.destroy();
});

function deferredStore() {
  let resolve!: (entries: readonly (readonly [string, string])[]) => void;
  const rows = new Map<string, string>();
  const store: AsyncStorageLike = { entries: () => new Promise(done => { resolve = done; }),
    setItem: vi.fn(async (key, value) => { rows.set(key, value); }), removeItem: vi.fn(async key => { rows.delete(key); }) };
  return { store, rows, finish: () => resolve([['oac-widget:terminal:test:layout', JSON.stringify(document())]]) };
}

it('awaits asynchronous restoration, flushes changes and persists closing the last panel', async () => {
  const storage = deferredStore(), createPanel = vi.fn(panel);
  const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement,
    { persist: 'test', storage: storage.store, createPanel });
  expect(createPanel).not.toHaveBeenCalled(); await Promise.resolve(); storage.finish(); await workspace.ready;
  expect(createPanel).toHaveBeenCalledOnce(); expect(workspace.getPanel('orders')).toBeDefined();
  workspace.removePanel('orders'); await workspace.flush();
  expect(JSON.parse(storage.rows.get('oac-widget:terminal:test:layout')!)).toMatchObject({ layout: null, panels: {} });
  await workspace.clearSavedLayout(); expect(storage.rows.size).toBe(0); workspace.destroy();
});

it('keeps newer user changes when an asynchronous saved layout arrives', async () => {
  const storage = deferredStore(), createPanel = vi.fn(panel);
  const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement,
    { persist: 'test', storage: storage.store, createPanel });
  workspace.addPanel(panel('new')); await Promise.resolve(); storage.finish(); await workspace.ready; await workspace.flush();
  expect(createPanel).not.toHaveBeenCalled(); expect(workspace.getPanel('new')).toBeDefined(); workspace.destroy();
});

it('migrates legacy layouts from the asynchronous journal and respects a custom state validator', async () => {
  const legacy = JSON.stringify(document());
  const store: AsyncStorageLike = { entries: async () => [], setItem: async () => {}, removeItem: async () => {},
    journal: { getItem: key => key === 'test' ? legacy : null, setItem() {}, removeItem() {} } };
  const storage = new TerminalStorage('test', store, true); await storage.shared.load(); expect(storage.get()).toBe(legacy); storage.shared.close();
  const createPanel = vi.fn(panel);
  const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement,
    { persist: 'test', storage: store, createPanel, validatePanelState: () => false });
  await workspace.ready; expect(createPanel).not.toHaveBeenCalled(); workspace.destroy();
});

it('uses engine convergence once on join, suppresses echoes and drops empty group state', () => {
  const links = new LinkHub(), first = vi.fn(), follower = vi.fn();
  links.setPanelGroup('a', 'blue'); links.registerListener('a', first);
  links.broadcast('blue', 'AAA', '5m', 'a', 'X');
  links.registerListener('b', follower); links.setPanelGroup('b', 'blue');
  expect(follower).toHaveBeenCalledExactlyOnceWith({ symbol: 'AAA', interval: '5m', exchange: 'X', group: 'blue' });
  links.broadcast('blue', 'AAA', '5m', 'a', 'X'); expect(follower).toHaveBeenCalledOnce();
  links.unregisterListener('a'); links.unregisterListener('b'); links.setPanelGroup('c', 'blue'); links.registerListener('c', first);
  expect(first).not.toHaveBeenCalled(); links.destroy();
});

it('releases shared panel handles exactly once even when cleanup is reentrant', () => {
  const handle = { destroy: vi.fn(() => releasePanel(handle)) };
  releasePanel(handle); releasePanel(handle); expect(handle.destroy).toHaveBeenCalledOnce();
});

it('does not overwrite unread asynchronous storage after a failed load', async () => {
  const setItem = vi.fn(async () => {}), onStorageError = vi.fn();
  const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement, { persist: 'test', onStorageError,
    storage: { entries: async () => { throw new Error('Offline'); }, setItem, removeItem: async () => {} } });
  await workspace.ready; workspace.addPanel(panel('new')); await workspace.flush();
  expect(onStorageError).toHaveBeenCalledWith(expect.objectContaining({ operation: 'load' })); expect(setItem).not.toHaveBeenCalled(); workspace.destroy();
});

it('preserves rejected saved state until explicitly cleared, even if its reporter throws', async () => {
  const setItem = vi.fn(), removeItem = vi.fn();
  const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement, { persist: true,
    storage: { getItem: () => 'invalid', setItem, removeItem }, onRestoreError: () => { throw new Error('Host report failed'); } });
  await workspace.ready; workspace.addPanel(panel('new')); await workspace.flush(); expect(setItem).not.toHaveBeenCalled();
  await workspace.clearSavedLayout(); expect(removeItem).toHaveBeenCalled(); workspace.destroy();
});

it('applies an empty saved layout before the host adds new panels', async () => {
  const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement, { persist: true,
    storage: { getItem: () => JSON.stringify({ version: 1, layout: null, panels: {}, floating: [] }), setItem() {}, removeItem() {} } });
  await workspace.ready; workspace.addPanel(panel('new')); expect(workspace.getLayout()).toMatchObject({ panelId: 'new' }); workspace.destroy();
});

it('does not treat corrupt namespaced JSON as missing asynchronous state', async () => {
  const setItem = vi.fn(async () => {}), onRestoreError = vi.fn();
  const workspace = createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement, { persist: 'test', onRestoreError,
    storage: { entries: async () => [['oac-widget:terminal:test:layout', 'invalid']], setItem, removeItem: async () => {} } });
  await workspace.ready; workspace.addPanel(panel('new')); await workspace.flush();
  expect(onRestoreError).toHaveBeenCalledOnce(); expect(setItem).not.toHaveBeenCalled(); workspace.destroy();
});
