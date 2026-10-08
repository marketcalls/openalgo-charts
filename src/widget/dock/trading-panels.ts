import type { AccountStateSource, BracketOrderRequest, PlaceRequest, PlaceResult, TradeMode } from 'openalgo-charts/trade';
import type { WidgetContext } from '../context';
import { mountWatchlistPanel, type WatchlistPanelOptions } from '../watchlist-panel';
import type { TerminalPanel, LinkColor, LinkContext } from './types';
import { FrameTask } from './frame-task';
import { checkTradingCapability, darkTheme, lightTheme, type TradingCapabilitySource } from 'openalgo-charts';
import { renderForm, button as createButton, type FormControl } from '../form';
import { widgetText, type WidgetTranslationOptions } from '../localization';
import { applyTokens, widgetTokens, type WidgetThemeName } from '../tokens';
import { injectWidgetStyles, addWidgetStyles } from '../styles';

/** Host state is read again at each action; these controls never grant broker authority. */
export interface TradingPanelUiOptions extends WidgetTranslationOptions {
  theme?: WidgetThemeName;
  context?(): WidgetContext;
  account?: AccountStateSource;
  mode?: TradeMode;
  capabilities?: TradingCapabilitySource;
  /** Notify when provider capabilities change without an account change. */
  subscribeCapabilities?(changed: () => void): () => void;
}

function tradingSurface(root: HTMLElement, options: TradingPanelUiOptions): () => void {
  const doc = root.ownerDocument, ctx = options.context?.();
  injectWidgetStyles(doc);
  addWidgetStyles(doc, `.oac-widget.oac-trading-panel{display:flex;flex-direction:column;gap:10px;padding:12px;height:100%;overflow:auto;box-sizing:border-box;background:var(--oac-panel);color:var(--oac-tx);font:12px var(--oac-font)}.oac-trading-actions{display:flex;gap:8px}.oac-trading-actions>.oac-btn{flex:1}.oac-order-row{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--oac-bd)}`);
  root.classList.add('oac-widget', 'oac-trading-panel');
  const refresh = () => {
    if (ctx) root.style.cssText = ctx.root.style.cssText;
    else applyTokens(root, widgetTokens(options.theme === 'light' ? lightTheme : darkTheme));
  };
  refresh(); return ctx?.bus.on('theme', refresh) ?? (() => {});
}
let nextTicketId = 0;
const text = (options: TradingPanelUiOptions, key: string, fallback: string) => widgetText({ translate: options.translate ?? options.context?.().translate }, `schema.terminal.${key}`, {}, fallback);

function accountBlock(options: TradingPanelUiOptions): string | null {
  if (!options.account) return null;
  const state = options.account.getState();
  if (state.status !== 'ready' || !state.selectedId) return state.reason ?? text(options, 'accountUnavailable', 'Account is not ready');
  const selected = state.accounts.find(account => account.id === state.selectedId);
  if (!selected || selected.mode !== state.mode || (options.mode !== undefined && state.mode !== options.mode)) return text(options, 'accountMode', 'Selected account does not match the trading mode');
  return null;
}

/** The host supplies an OrderEngine or an adapter with the same write methods. */
export interface OrderTicketOptions extends TradingPanelUiOptions {
  id: string;
  symbol: string;
  exchange?: string;
  linkGroup?: LinkColor | null;
  /** Visible execution context, such as the selected account and live or paper mode. */
  label: string;
  /** Prefilled fields; `side` names the action the draft was prepared for (a depth click). */
  draft?: { qty: number; type: 'MARKET' | 'LIMIT'; price?: number; side?: 'BUY' | 'SELL' };
  placeOrder?(request: PlaceRequest): Promise<PlaceResult>;
  /** Supply only when the provider supports native brackets. */
  bracketSupport?(): { supported: boolean; reason?: string };
  placeBracket?(request: BracketOrderRequest): Promise<PlaceResult>;
}

export function createOrderTicketPanel(options: OrderTicketOptions): TerminalPanel {
  let symbol = options.symbol, exchange = options.exchange ?? '';
  let update: ((changed?: boolean) => void) | undefined;
  const setInstrument = (ctx: LinkContext) => {
    const changed = symbol !== ctx.symbol || exchange !== (ctx.exchange ?? '');
    symbol = ctx.symbol; exchange = ctx.exchange ?? ''; update?.(changed);
  };
  return {
    id: options.id, type: 'orders', title: `Trade ${symbol}`, minWidth: 260, minHeight: 300,
    linkGroup: options.linkGroup ?? null,
    state: () => ({ symbol, exchange, kind: 'ticket' }),
    restore(raw) {
      const state = raw as { symbol?: unknown; exchange?: unknown } | null;
      setInstrument({ group: options.linkGroup ?? 'blue', symbol: typeof state?.symbol === 'string' ? state.symbol : symbol, exchange: typeof state?.exchange === 'string' ? state.exchange : exchange });
    },
    onLinkUpdate: setInstrument,
    mount(host) {
      const doc = host.ownerDocument, root = doc.createElement('div');
      root.className = 'oac-order-ticket';
      const removeTheme = tradingSurface(root, options);
      const heading = doc.createElement('strong'), account = doc.createElement('span'), availability = doc.createElement('div');
      availability.setAttribute('role', 'note'); root.append(heading, account, availability);
      const idPrefix = `terminal-ticket-${++nextTicketId}`;
      const formHost = doc.createElement('div'); root.appendChild(formHost);
      const controls: FormControl[] = [
        { key: 'qty', kind: 'number', label: text(options, 'quantity', 'Quantity'), min: 0 },
        { key: 'type', kind: 'select', label: text(options, 'orderType', 'Order type'), options: [{ value: 'MARKET', label: text(options, 'market', 'Market') }, { value: 'LIMIT', label: text(options, 'limit', 'Limit') }] },
        { key: 'price', kind: 'number', label: text(options, 'limitPrice', 'Limit price'), min: 0 },
        { key: 'bracket', kind: 'boolean', label: text(options, 'bracket', 'Bracket order') },
        { key: 'stop', kind: 'number', label: text(options, 'stopLoss', 'Stop loss'), min: 0 },
        { key: 'target', kind: 'number', label: text(options, 'takeProfit', 'Take profit'), min: 0 },
      ];
      let pending = false, destroyed = false, uncertain = false;
      let refreshForm = () => {};
      const capability = (type: 'MARKET' | 'LIMIT') => checkTradingCapability(options.capabilities, {
        operation: 'place', symbol, exchange, type, mode: options.mode ?? options.account?.getState().mode,
      });
      const bracketReason = () => {
        if (!options.placeBracket) return text(options, 'noBracket', 'Native brackets are unavailable');
        try { const support = options.bracketSupport?.(); return support && !support.supported ? support.reason ?? text(options, 'noBracket', 'Native brackets are unavailable') : null; }
        catch { return text(options, 'noBracket', 'Native brackets are unavailable'); }
      };
      const form = renderForm(formHost, controls, {
        idPrefix, values: { qty: options.draft?.qty ?? 1, type: options.draft?.type ?? 'MARKET', price: options.draft?.price, bracket: false },
        translate: options.translate ?? options.context?.().translate,
        preserveInvalidNumbers: true, onChange: () => refreshForm(),
        unavailable(key, option) {
          if (pending) return text(options, 'submitting', 'Submitting...');
          if (key === 'type' && option) { const result = capability(option as 'MARKET' | 'LIMIT'); return result.supported ? null : result.reason; }
          if (key === 'bracket') return bracketReason();
          if (key === 'price' && root.querySelector<HTMLInputElement>(`#${idPrefix}-type`)?.value !== 'LIMIT') return text(options, 'limitOnly', 'Used for limit orders');
          if ((key === 'stop' || key === 'target') && !root.querySelector<HTMLInputElement>(`#${idPrefix}-bracket`)?.checked) return text(options, 'bracketOnly', 'Used for bracket orders');
          return null;
        },
      });
      const input = (key: string) => root.querySelector<HTMLInputElement>(`#${idPrefix}-${key}`)!;
      const quantity = input('qty'), type = input('type'), price = input('price'), bracket = input('bracket'), stop = input('stop'), target = input('target');
      for (const control of controls) input(control.key).setAttribute('aria-label', control.label);
      const status = doc.createElement('div'); status.setAttribute('role', 'status'); status.setAttribute('data-terminal-status', '');
      const actions = doc.createElement('div'); actions.className = 'oac-trading-actions';
      let titleChange: ((title: string) => void) | undefined;
      const buttons: HTMLButtonElement[] = [];
      const sync = (changed = false) => {
        if (changed) {
          quantity.value = price.value = stop.value = target.value = '';
          bracket.checked = false;
          status.textContent = text(options, 'changed', 'Instrument or account changed. Enter a new order.');
        }
        const state = options.account?.getState();
        const selected = state?.accounts.find(item => item.id === state.selectedId);
        account.textContent = state ? `${selected?.name ?? state.selectedId ?? options.label} / ${state.mode} / ${state.status}` : options.label;
        const support = capability(type.value === 'LIMIT' ? 'LIMIT' : 'MARKET');
        const reason = accountBlock(options) ?? (!support.supported ? support.reason : null) ?? (bracket.checked ? bracketReason() : null);
        availability.textContent = reason ?? '';
        form.sync(form.values());
        heading.textContent = `${symbol}${exchange ? ` / ${exchange}` : ''}`;
        titleChange?.(`Trade ${symbol}`);
        price.disabled = type.value !== 'LIMIT' || pending;
        stop.disabled = target.disabled = !bracket.checked || pending;
        quantity.disabled = type.disabled = pending;
        bracket.disabled = pending || bracketReason() !== null;
        for (const button of buttons) button.disabled = pending || uncertain || !options.placeOrder || reason !== null;
      };
      const send = async (side: 'BUY' | 'SELL') => {
        sync();
        if (pending || uncertain || destroyed || !options.placeOrder || accountBlock(options)) return;
        const support = capability(type.value === 'LIMIT' ? 'LIMIT' : 'MARKET');
        if (!support.supported || (bracket.checked && bracketReason())) return;
        const qty = Number(quantity.value), limit = Number(price.value);
        const sl = Number(stop.value), tp = Number(target.value);
        if (!symbol || !(qty > 0) || !Number.isFinite(qty) || (type.value === 'LIMIT' && (!(limit > 0) || !Number.isFinite(limit)))
          || (bracket.checked && (!(sl > 0) || !(tp > 0) || !Number.isFinite(sl) || !Number.isFinite(tp)))) {
          status.textContent = text(options, 'invalid', 'Enter a valid quantity and required prices.'); return;
        }
        const request: PlaceRequest = { symbol, exchange, side, qty, type: type.value === 'LIMIT' ? 'LIMIT' : 'MARKET' };
        if (request.type === 'LIMIT') request.price = limit;
        const executionAccount = options.account?.getState();
        if (executionAccount?.selectedId) request.account = executionAccount.selectedId;
        pending = true; status.textContent = text(options, 'submitting', 'Submitting...'); sync();
        try {
          const result = bracket.checked && options.placeBracket
            ? await options.placeBracket({ ...request, stopLoss: sl, takeProfit: tp })
            : await options.placeOrder(request);
          uncertain = result.intent === 'AMBIGUOUS';
          if (!destroyed) {
            const message = result.ok ? text(options, 'submitted', 'Submitted; awaiting broker status.') : result.reason ?? text(options, 'refused', 'Order refused.');
            const accountChanged = executionAccount && executionAccount.generation !== options.account?.getState().generation;
            status.textContent = symbol === request.symbol && exchange === request.exchange && !accountChanged ? message : `${request.symbol}${accountChanged ? ` / ${executionAccount.selectedId}` : ''}: ${message}`;
          }
        } catch {
          uncertain = true;
          if (!destroyed) status.textContent = text(options, 'unknown', 'Submission outcome unavailable. Check the order book before retrying.');
        } finally { pending = false; if (!destroyed) sync(); }
      };
      for (const side of ['BUY', 'SELL'] as const) {
        const action = createButton(doc, { label: text(options, side.toLowerCase(), side === 'BUY' ? 'Buy' : 'Sell'), variant: side === 'BUY' ? 'primary' : 'danger', onClick: () => { void send(side); } });
        buttons.push(action); actions.appendChild(action);
      }
      type.addEventListener('change', () => sync()); bracket.addEventListener('change', () => sync());
      refreshForm = () => sync();
      let generation = options.account?.getState().generation;
      const unsubscribe = options.account?.subscribe(state => { const changed = state.generation !== generation; generation = state.generation; sync(changed); });
      const unsubscribeCapabilities = options.subscribeCapabilities?.(() => sync());
      root.append(actions, status); host.appendChild(root); update = sync; sync();
      const draftSide = options.draft?.side;
      if (draftSide === 'BUY' || draftSide === 'SELL') {
        // Never submitted from here: the prepared side is announced and its button focused.
        const label = draftSide === 'BUY' ? text(options, 'buy', 'Buy') : text(options, 'sell', 'Sell');
        status.textContent = text(options, 'prepared', `Prepared to ${label.toLowerCase()}. Review, then press ${label}.`);
        root.dataset.draftSide = draftSide;
        // The workspace mounts into a detached host and attaches the tree after rendering it.
        const prepared = buttons[draftSide === 'BUY' ? 0 : 1];
        queueMicrotask(() => { if (!destroyed && prepared?.isConnected) prepared.focus(); });
      }
      return { onTitleChange(callback) { titleChange = callback; }, destroy() { destroyed = true; update = undefined; unsubscribe?.(); unsubscribeCapabilities?.(); removeTheme(); form.destroy(); root.remove(); } };
    },
  };
}

export interface OrdersPanelRow {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  triggerPrice?: number;
  status: string;
  cancellable?: boolean;
  /** Required to enable cancellation when an account source is configured. */
  account?: string;
}
export interface OrdersPanelOptions extends TradingPanelUiOptions {
  id: string;
  label: string;
  /** Subscribe to authoritative snapshots; return the unsubscribe. */
  subscribe(callback: (orders: readonly OrdersPanelRow[]) => void): () => void;
  cancel?(id: string): Promise<void>;
}

export function createOrdersPanel(options: OrdersPanelOptions): TerminalPanel {
  return { id: options.id, type: 'orders', title: options.label, minWidth: 300, minHeight: 180,
    state: () => ({ kind: 'book' }),
    mount(host) {
      const doc = host.ownerDocument, root = doc.createElement('div'), status = doc.createElement('div');
      const removeTheme = tradingSurface(root, options);
      status.setAttribute('role', 'status'); status.setAttribute('data-terminal-status', ''); root.appendChild(status); host.appendChild(root);
      let latest: readonly OrdersPanelRow[] = [], destroyed = false, notice = '';
      const rows = new Map<string, { element: HTMLElement; text: HTMLElement; button: HTMLButtonElement }>();
      const cancelling = new Set<string>();
      const paint = () => {
        const ids = new Set(latest.map(order => order.id));
        for (const [id, row] of rows) if (!ids.has(id)) { row.element.remove(); rows.delete(id); }
        status.textContent = notice || accountBlock(options) || (latest.length ? '' : text(options, 'noOrders', 'No orders'));
        for (const order of latest) {
          let row = rows.get(order.id);
          if (!row) {
            const element = doc.createElement('div'), rowText = doc.createElement('span'), button = createButton(doc, { label: text(options, 'cancel', 'Cancel') });
            element.className = 'oac-order-row';

            button.addEventListener('click', () => {
              const current = latest.find(item => item.id === order.id);
              if (!current?.cancellable || !options.cancel || cancelling.has(order.id) || destroyed || accountBlock(options)
                || (options.account && current.account !== options.account.getState().selectedId)
                || !checkTradingCapability(options.capabilities, { operation: 'cancel', orderId: order.id }).supported) return;
              notice = ''; cancelling.add(order.id); frame.schedule();
              void options.cancel(order.id).catch(() => {
                if (!destroyed) notice = text(options, 'cancelUnknown', 'Cancel outcome unavailable. Check broker status.');
              }).finally(() => { cancelling.delete(order.id); if (!destroyed) frame.schedule(); });
            });
            element.append(rowText, button); root.appendChild(element); row = { element, text: rowText, button }; rows.set(order.id, row);
          }
          const price = order.price === 0 && order.triggerPrice !== undefined ? `stop ${order.triggerPrice}` : order.price;
          row.text.textContent = `${order.symbol} ${order.side} ${order.qty} @ ${price} / ${order.status}`;
          const support = checkTradingCapability(options.capabilities, { operation: 'cancel', orderId: order.id });
          const wrongAccount = options.account && order.account !== options.account.getState().selectedId;
          row.button.title = accountBlock(options) ?? (wrongAccount ? text(options, 'orderAccount', 'Order does not belong to the selected account') : !support.supported ? support.reason : '');
          row.button.disabled = !order.cancellable || !options.cancel || cancelling.has(order.id) || accountBlock(options) !== null || !support.supported || !!wrongAccount;
        }
      };
      const frame = new FrameTask(doc, paint);
      const unsubscribe = options.subscribe(orders => { if (!destroyed) { latest = orders; frame.schedule(); } });
      const removeAccount = options.account?.subscribe(() => frame.schedule());
      const removeCapabilities = options.subscribeCapabilities?.(() => frame.schedule());
      return { destroy() { destroyed = true; unsubscribe(); removeAccount?.(); removeCapabilities?.(); removeTheme(); frame.cancel(); root.remove(); } };
    },
  };
}

/** Reuses the existing watchlist. The host owns the supplied widget context's lifetime. */
export function createWatchlistDockPanel(options: {
  id: string;
  context(): WidgetContext;
  watchlist: WatchlistPanelOptions;
}): TerminalPanel {
  return { id: options.id, type: 'watchlist', title: 'Watchlist', minWidth: 280, minHeight: 220,
    mount(host) {
      const ctx = options.context(), root = host.ownerDocument.createElement('div');
      root.className = 'oac-widget'; root.style.cssText = ctx.root.style.cssText;
      root.style.display = 'flex'; root.style.flexDirection = 'column';
      host.appendChild(root);
      const handle = mountWatchlistPanel(ctx, root, options.watchlist);
      return { destroy() { handle.destroy(); root.remove(); } };
    },
  };
}
