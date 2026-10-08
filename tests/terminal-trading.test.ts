import { expect, it, vi } from 'vitest';
import { fakeWidgetDocument, fakeContainer, FakeEvent } from './helpers/fake-dom-widget';
import { loadTradingPanels } from '../src/widget/dock/trading-loader';
import { createOrderTicketPanel, createOrdersPanel, createWatchlistDockPanel } from '../src/widget/dock/trading-panels';
import type { PlaceResult } from '../src/trade/order-types';
import type { AccountState, AccountStateSource } from '../src/trade/account';

function mountTicket(placeOrder = vi.fn(async () => ({ ok: true }))) {
  const doc = fakeWidgetDocument(), host = fakeContainer(doc);
  const panel = createOrderTicketPanel({ id: 'ticket', symbol: 'AAA', exchange: 'X', label: 'Paper', placeOrder });
  const handle = panel.mount(host as unknown as HTMLElement);
  return { host, panel, handle, placeOrder };
}

it('loads trading panels separately and exposes the existing watchlist adapter', async () => {
  const module = await loadTradingPanels();
  expect(module.createOrderTicketPanel).toBe(createOrderTicketPanel);
  expect(module.createOrdersPanel).toBe(createOrdersPanel);
  expect(module.createWatchlistDockPanel).toBe(createWatchlistDockPanel);
});

it('takes the instrument from this ticket and rejects invalid input before calling the host', async () => {
  const { host, panel, handle, placeOrder } = mountTicket();
  const quantity = host.querySelector('[aria-label="Quantity"]')!;
  quantity.value = '0'; host.querySelector('button')!.click();
  expect(placeOrder).not.toHaveBeenCalled();
  quantity.value = '3'; panel.onLinkUpdate!({ group: 'blue', symbol: 'BBB', exchange: 'Y' });
  expect(quantity.value).toBe('');
  quantity.value = '3';
  host.querySelector('button')!.click();
  expect(placeOrder).toHaveBeenCalledWith({ symbol: 'BBB', exchange: 'Y', qty: 3, side: 'BUY', type: 'MARKET' });
  await Promise.resolve(); handle.destroy();
});

it('locks both directions while submitting and ignores a response after removal', async () => {
  let finish!: (result: PlaceResult) => void;
  const placeOrder = vi.fn(() => new Promise<PlaceResult>(resolve => { finish = resolve; }));
  const { host, handle } = mountTicket(placeOrder);
  const buttons = host.querySelectorAll('button');
  buttons[0].click(); buttons[1].click(); buttons[0].click();
  expect(placeOrder).toHaveBeenCalledTimes(1);
  expect(buttons.every(button => button.disabled)).toBe(true);
  const status = host.querySelector('[data-terminal-status]')!;
  const before = status.textContent;
  handle.destroy(); finish({ ok: true }); await Promise.resolve(); await Promise.resolve();
  expect(host.children).toHaveLength(0);
  // The late response reaches neither the detached status line nor the buttons.
  expect(status.textContent).toBe(before);
  expect(buttons.every(button => button.disabled)).toBe(true);
});

it('sends bracket prices through the native bracket callback and never as two independent orders', async () => {
  const doc = fakeWidgetDocument(), host = fakeContainer(doc);
  const placeOrder = vi.fn(async () => ({ ok: true })), placeBracket = vi.fn(async () => ({ ok: true }));
  const panel = createOrderTicketPanel({ id: 'bracket', symbol: 'AAA', label: 'Paper', placeOrder, placeBracket });
  const handle = panel.mount(host as unknown as HTMLElement);
  const bracket = host.querySelector('[aria-label="Bracket order"]')!;
  bracket.checked = true; bracket.dispatchEvent(new FakeEvent('change'));
  host.querySelector('[aria-label="Stop loss"]')!.value = '90';
  host.querySelector('[aria-label="Take profit"]')!.value = '110';
  host.querySelector('button')!.click();
  expect(placeBracket).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAA', stopLoss: 90, takeProfit: 110 }));
  expect(placeOrder).not.toHaveBeenCalled(); await Promise.resolve(); handle.destroy();
});

it('blocks retries after an unknown outcome instead of sending a second order', async () => {
  const placeOrder = vi.fn(async () => { throw new Error('Connection lost'); });
  const { host, handle } = mountTicket(placeOrder);
  host.querySelector('button')!.click(); await Promise.resolve(); await Promise.resolve();
  host.querySelector('button')!.click();
  expect(placeOrder).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[data-terminal-status]')!.textContent).toContain('Check the order book');
  handle.destroy();
});

it('identifies a pending response by its original symbol after a chart changes instrument', async () => {
  let finish!: (result: PlaceResult) => void;
  const { host, panel, handle } = mountTicket(vi.fn(() => new Promise<PlaceResult>(resolve => { finish = resolve; })));
  host.querySelector('button')!.click();
  panel.onLinkUpdate!({ group: 'blue', symbol: 'BBB', exchange: 'Y' });
  finish({ ok: true }); await Promise.resolve();
  expect(host.querySelector('[data-terminal-status]')!.textContent).toBe('AAA: Submitted; awaiting broker status.');
  expect(host.querySelector('[aria-label="Quantity"]')!.value).toBe('');
  handle.destroy();
});

it('reuses order rows, guards repeated cancel clicks and unsubscribes on removal', async () => {
  const doc = fakeWidgetDocument(), host = fakeContainer(doc), unsubscribe = vi.fn();
  let notify!: Parameters<Parameters<typeof createOrdersPanel>[0]['subscribe']>[0];
  const cancel = vi.fn(async () => { throw new Error('Connection lost'); });
  const panel = createOrdersPanel({ id: 'book', label: 'Paper', cancel, subscribe(callback) { notify = callback; return unsubscribe; } });
  const handle = panel.mount(host as unknown as HTMLElement);
  notify([{ id: 'one', symbol: 'AAA', qty: 1, price: 100, side: 'BUY', status: 'working', cancellable: true }]);
  const button = host.querySelector('button')!;
  notify([{ id: 'one', symbol: 'AAA', qty: 1, price: 100, side: 'BUY', status: 'partial', cancellable: true }]);
  expect(host.querySelector('button')).toBe(button);
  button.click(); button.click(); expect(cancel).toHaveBeenCalledTimes(1);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(host.querySelector('[data-terminal-status]')!.textContent).toContain('Check broker status');
  handle.destroy(); expect(unsubscribe).toHaveBeenCalledOnce();
  notify([]); expect(host.children).toHaveLength(0);
});

it('shows translated shared controls, gates provider support and rechecks it at submission', async () => {
  const doc = fakeWidgetDocument(), host = fakeContainer(doc), placeOrder = vi.fn(async () => ({ ok: true }));
  let supported = true;
  const panel = createOrderTicketPanel({ id: 'translated', symbol: 'AAA', label: 'Paper', theme: 'light', placeOrder,
    translate: (key, fallback) => key === 'schema.terminal.quantity' ? 'Amount' : fallback,
    capabilities: () => ({ place: supported, orderTypes: ['MARKET'] }) });
  const handle = panel.mount(host as unknown as HTMLElement);
  expect(host.querySelector('[aria-label="Amount"]')).not.toBeNull();
  expect(host.querySelector('.oac-form')).not.toBeNull();
  supported = false; host.querySelector('button')!.click();
  expect(placeOrder).not.toHaveBeenCalled(); expect(host.querySelector('[role="note"]')!.textContent).toContain('not supported');
  handle.destroy();
});

it('clears account drafts, refuses stale state and stamps the selected account on writes', async () => {
  const doc = fakeWidgetDocument(), host = fakeContainer(doc), placeOrder = vi.fn(async () => ({ ok: true })), unsubscribe = vi.fn();
  let state: AccountState = { status: 'loading', mode: 'analyzer', selectedId: 'paper', generation: 1, snapshot: null,
    accounts: [{ id: 'paper', name: 'Paper account', mode: 'analyzer' }] };
  let changed!: (state: AccountState) => void;
  const account: AccountStateSource = { getState: () => state, select: async () => ({ ok: false, reason: 'Read only' }), subscribe(listener) { changed = listener; return unsubscribe; } };
  const handle = createOrderTicketPanel({ id: 'account', symbol: 'AAA', label: 'Paper', account, mode: 'analyzer', placeOrder }).mount(host as unknown as HTMLElement);
  host.querySelector('button')!.click(); expect(placeOrder).not.toHaveBeenCalled();
  state = { ...state, status: 'ready', generation: 2 }; changed(state);
  expect(host.querySelector('[aria-label="Quantity"]')!.value).toBe('');
  host.querySelector('[aria-label="Quantity"]')!.value = '2'; host.querySelector('button')!.click();
  expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ account: 'paper', qty: 2 }));
  await Promise.resolve(); state = { ...state, status: 'stale', generation: 3 }; changed(state);
  expect(host.querySelector('button')!.disabled).toBe(true); handle.destroy(); expect(unsubscribe).toHaveBeenCalledOnce();
});

it('refuses cancellation of stale rows belonging to another account', () => {
  const doc = fakeWidgetDocument(), host = fakeContainer(doc), cancel = vi.fn(async () => {});
  const state: AccountState = { status: 'ready', mode: 'analyzer', selectedId: 'paper', generation: 1, snapshot: null,
    accounts: [{ id: 'paper', mode: 'analyzer' }] };
  let notify!: Parameters<Parameters<typeof createOrdersPanel>[0]['subscribe']>[0];
  const account: AccountStateSource = { getState: () => state, select: async () => ({ ok: false, reason: 'Read only' }), subscribe: () => () => {} };
  const handle = createOrdersPanel({ id: 'scoped', label: 'Paper', account, cancel, subscribe(callback) { notify = callback; return () => {}; } }).mount(host as unknown as HTMLElement);
  notify([{ id: 'old', account: 'different', symbol: 'AAA', qty: 1, price: 100, side: 'BUY', status: 'working', cancellable: true }]);
  expect(host.querySelector('button')!.disabled).toBe(true); host.querySelector('button')!.click(); expect(cancel).not.toHaveBeenCalled();
  handle.destroy();
});
