import { expect, it, vi } from 'vitest';
import { fakeContainer, fakeWidgetDocument, FakeEvent, type FakeElement } from './helpers/fake-dom-widget';
import { StandaloneDomLadder } from '../src/widget/dock/dom-panel';
import { DockSplitter } from '../src/widget/dock/splitter';
import { createTerminalWorkspace } from '../src/widget/dock/controller';
import { loadTerminal } from '../src/widget/terminal-loader';
import type { MarketDepth } from '../src/feed/types';

function frameDocument() {
  const doc = fakeWidgetDocument(), callbacks = new Map<number, FrameRequestCallback>();
  let next = 0;
  Object.defineProperty(doc, 'defaultView', { value: {
    requestAnimationFrame(callback: FrameRequestCallback) { callbacks.set(++next, callback); return next; },
    cancelAnimationFrame(id: number) { callbacks.delete(id); },
  } });
  return { doc, callbacks, flush() {
    const work = [...callbacks.values()];
    callbacks.clear();
    for (const callback of work) callback(0);
  } };
}

const depth = (qty: number): MarketDepth => ({ ltp: 1000,
  bids: Array.from({ length: 1000 }, (_, index) => ({ price: 999 - index, qty })),
  asks: Array.from({ length: 1000 }, (_, index) => ({ price: 1001 + index, qty: qty * 2 })),
});

it('bounds a deep book by the viewport and paints only the newest snapshot in a burst', () => {
  const frames = frameDocument();
  const ladder = new StandaloneDomLadder({ document: frames.doc as unknown as Document,
    symbol: 'DEPTH', tickSize: 1, depth: depth(1) });
  const container = ladder.element.querySelector('.oac-dom-ladder-container') as unknown as FakeElement;
  container.clientHeight = 220;
  frames.flush();
  const rows = [...ladder.element.querySelectorAll('.oac-dom-row')];
  expect(rows.length).toBeLessThanOrEqual(22);
  const button = ladder.element.querySelector('.oac-dom-cell-btn--buy') as unknown as FakeElement;
  button.focus();
  for (let qty = 2; qty <= 100; qty++) ladder.setDepth(depth(qty));
  expect(frames.callbacks.size).toBe(1);
  frames.flush();
  expect([...ladder.element.querySelectorAll('.oac-dom-row')]).toEqual(rows);
  expect(frames.doc.activeElement).toBe(button);
  expect(ladder.element.querySelector('.oac-dom-qty-text')!.textContent).toBe('');
  expect(ladder.element.querySelector('.oac-dom-summary')!.textContent).toContain('Bid 100000  Ask 200000');
  ladder.destroy();
});

it('preserves manual scrolling and delegates orders after recycling rows', () => {
  const frames = frameDocument(), onOrder = vi.fn();
  const ladder = new StandaloneDomLadder({ document: frames.doc as unknown as Document,
    symbol: 'DEPTH', tickSize: 1, depth: depth(1), onOrder });
  frames.flush();
  const container = ladder.element.querySelector('.oac-dom-ladder-container') as HTMLElement;
  container.dispatchEvent(new FakeEvent('wheel') as unknown as Event);
  container.scrollTop = 40000;
  container.dispatchEvent(new FakeEvent('scroll') as unknown as Event);
  frames.flush();
  const button = ladder.element.querySelector('.oac-dom-cell-btn--buy') as HTMLButtonElement;
  button.click();
  expect(onOrder).toHaveBeenCalledWith('buy', 'limit', Number(button.dataset.price), 1);
  expect(Number(button.dataset.price)).toBeLessThan(300);
  ladder.setDepth(depth(9));
  frames.flush();
  expect(container.scrollTop).toBe(40000);
  ladder.setLtp(1004);
  expect(frames.callbacks.size).toBe(1);
  ladder.destroy();
  expect(frames.callbacks.size).toBe(0);
});

it('coalesces splitter movement and flushes the release position before saving', () => {
  const frames = frameDocument(), ratios: number[] = [], end = vi.fn();
  const parent = fakeContainer(frames.doc, 1000, 600);
  const splitter = new DockSplitter({ document: frames.doc as unknown as Document,
    currentRatio: 0.5, direction: 'horizontal', onRatioChange: value => ratios.push(value), onRatioEnd: end });
  parent.appendChild(splitter.element as unknown as FakeElement);
  const fire = (type: string, x: number) => splitter.element.dispatchEvent(new FakeEvent(type,
    { clientX: x, clientY: 0, button: 0, pointerId: 1 }) as unknown as Event);
  fire('pointerdown', 500);
  for (let x = 510; x < 700; x += 10) fire('pointermove', x);
  expect(ratios).toEqual([]);
  expect(frames.callbacks.size).toBe(1);
  fire('pointerup', 700);
  expect(ratios).toEqual([0.7]);
  expect(end).toHaveBeenCalledOnce();
  expect(frames.callbacks.size).toBe(0);
  splitter.destroy();
});

it('keeps tab chrome and focus while switching panels or link groups', () => {
  const doc = fakeWidgetDocument(), root = fakeContainer(doc);
  const workspace = createTerminalWorkspace(root as unknown as HTMLElement);
  for (const id of ['a', 'b']) workspace.addPanel({ id, type: 'custom', title: id, mount: () => ({ destroy() {} }) });
  workspace.dockPanel('b', 'a', 'center');
  const tabs = root.querySelector('.oac-dock-tabs-header');
  const first = root.querySelector('.oac-dock-tab')!;
  first.focus();
  workspace.activateTab('a');
  expect(root.querySelector('.oac-dock-tabs-header')).toBe(tabs);
  expect(doc.activeElement).toBe(first);
  const badge = first.querySelector('.oac-dock-link-badge')!;
  badge.focus();
  workspace.setPanelLinkGroup('a', 'blue');
  expect(first.querySelector('.oac-dock-link-badge')).toBe(badge);
  expect(doc.activeElement).toBe(badge);
  expect(badge.dataset.group).toBe('blue');
  workspace.destroy();
});

it('coalesces panel size measurements and suppresses unchanged resize callbacks', () => {
  const frames = frameDocument(), resize = vi.fn();
  const workspace = createTerminalWorkspace(fakeContainer(frames.doc) as unknown as HTMLElement);
  for (const id of ['a', 'b']) workspace.addPanel({ id, type: 'custom', title: id, mount(host) {
    const measured = host as unknown as FakeElement;
    measured.clientWidth = 200; measured.clientHeight = 300;
    return { destroy() {}, resize };
  } });
  for (let index = 0; index < 10; index++) workspace.resize();
  frames.flush();
  expect(resize).toHaveBeenCalledTimes(2);
  workspace.resize();
  frames.flush();
  expect(resize).toHaveBeenCalledTimes(2);
  workspace.destroy();
});

it('returns synchronous terminal factories through an asynchronous loader', async () => {
  const request = loadTerminal();
  expect(request).toBeInstanceOf(Promise);
  const tools = await request;
  const workspace = tools.createTerminalWorkspace(fakeContainer(fakeWidgetDocument()) as unknown as HTMLElement);
  expect(workspace).not.toBeInstanceOf(Promise);
  const destroy = vi.fn();
  workspace.addPanel(tools.createSimpleDockPanel({ id: 'custom', type: 'custom', title: 'Custom',
    mountContent(host) { host.textContent = 'Loaded on request'; return { destroy }; } }));
  workspace.destroy();
  expect(destroy).toHaveBeenCalledOnce();
});

it('repaints a reparented ladder even when its viewport dimensions are unchanged', () => {
  const frames = frameDocument(), resize = vi.fn();
  const workspace = createTerminalWorkspace(fakeContainer(frames.doc) as unknown as HTMLElement);
  workspace.addPanel({ id: 'depth', type: 'dom', title: 'Depth', mount(host) {
    const element = host as unknown as FakeElement;
    element.clientWidth = 400; element.clientHeight = 600;
    return { resize, destroy() {} };
  } });
  frames.flush(); expect(resize).toHaveBeenCalledTimes(1);
  workspace.addPanel({ id: 'new', type: 'custom', title: 'New', mount() { return { destroy() {} }; } });
  frames.flush(); expect(resize).toHaveBeenCalledTimes(2);
  workspace.resize(); frames.flush(); expect(resize).toHaveBeenCalledTimes(2);
  workspace.destroy();
});
