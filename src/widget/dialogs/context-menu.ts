/**
 * The right-click menu, built from what the chart says was under the pointer.
 *
 * The chart's `contextmenu` event carries the price, the pane and a classified
 * target, which is the part a canvas cannot tell a host by itself. The menu
 * reads that target and offers only what applies: order entry where a host
 * has wired it and there is a price to trade at, the drawing actions on a
 * drawing, an indicator's settings on an indicator, the axis switches on a
 * price scale. A row with nothing to act on is not drawn; a row whose action
 * exists but has no data right now (pin the price per bar on an unmeasured
 * scale) is drawn disabled with a word on why.
 *
 * The axis switches read `priceAxisState` and write back through the matching
 * `priceAxis*` calls, so the menu can never claim a state the axis is not in,
 * and the same rows serve the price ladder, a left-hand scale and an indicator
 * pane's.
 */
import { PRICE_SCALE_MODES } from 'openalgo-charts';
import type { Chart, ContextMenuEvent, ContextMenuTarget, PriceScaleId, PriceScaleMode } from 'openalgo-charts';
import { drawingSettingsSchema } from 'openalgo-charts/draw';
import type { Drawing } from 'openalgo-charts/draw';
import type { WidgetContext } from '../context';
import { boxInRoot, chromeGlyph, el, glyphSvg, openPanel, placePanel, stopOwnKeys, type PanelHandle } from '../form';
import { mountDrawingProperties } from './drawing-properties';
import { mountIndicatorPicker } from './indicator-picker';
import { mountIndicatorSettings } from './indicator-settings';
import { mountLevelEditor } from './level-editor';
import { mountSettingsDialog } from './settings';
import { chartContainer, isTextContent, mountTextEditor } from './text-editor';

/** What the menu asks a host to do when an order row is picked. */
export interface OrderRequest {
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'SL';
  /** The price under the pointer; null for a market order raised off the plot. */
  price: number | null;
  paneIndex: number;
}

export interface MenuItem {
  kind?: 'item';
  label: string;
  /** Chrome icon id, or inline SVG markup starting with `<svg`. */
  icon?: string;
  /** Chord hint, shown at the right. */
  chord?: string;
  /** A switch (tick) or one option of a choice (dot). */
  mark?: 'check' | 'radio';
  on?: boolean;
  disabled?: boolean;
  /** Why a disabled row is disabled; an empty greyed row reads as a bug. */
  note?: string;
  danger?: boolean;
  /** Keep the menu up after running (a switch the user may flip twice). */
  keepOpen?: boolean;
  /** Stable id, for tests and for a host that wants to find a row. */
  id?: string;
  run?(): void;
}

export type MenuEntry = MenuItem | { kind: 'separator' } | { kind: 'header'; label: string };

export interface ContextMenuHooks {
  /** Order entry. Without it no trade rows are drawn: the engine places no orders itself. */
  onOrder?(order: OrderRequest): void;
  /** Extra rows a host appends, built per event. */
  items?(e: ContextMenuEvent): MenuEntry[];
}

export interface ContextMenuOptions {
  /** The chart's event. Without one the menu is the chart-level menu at the anchor. */
  event?: ContextMenuEvent;
  hooks?: ContextMenuHooks;
}

const SEP: MenuEntry = { kind: 'separator' };
const header = (label: string): MenuEntry => ({ kind: 'header', label });

const ABOVE_GLYPH = 'M3 4h10M8 14V6M5 9l3-3 3 3';
const BEHIND_GLYPH = 'M3 12h10M8 2v8M5 7l3 3 3-3';
const FIT_GLYPH = 'M2 8h12M4 5l-2 3 2 3M12 5l2 3-2 3';
const TICK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 4"/></svg>';

/** Our words for the four scale modes, in the engine's order. */
export const SCALE_MODE_LABELS: Readonly<Record<PriceScaleMode, string>> = {
  linear: 'Linear',
  logarithmic: 'Logarithmic',
  percentage: 'Percent',
  'indexed-to-100': 'Indexed to 100',
};

/** The drawing id behind a `drawing` target: `draw:<id>` for the body, `draw:<id>#<n>` for an anchor. */
export function drawingIdOf(target: ContextMenuTarget): string | null {
  if (target.kind !== 'drawing' || target.id === null || !target.id.startsWith('draw:')) return null;
  const rest = target.id.slice('draw:'.length);
  const hash = rest.indexOf('#');
  return hash < 0 ? rest : rest.slice(0, hash);
}

/** A price the way the pane's own axis prints it. */
function priceText(chart: Chart, paneIndex: number, price: number): string {
  const pane = chart.panes()[paneIndex];
  return pane === undefined ? String(price) : pane.readoutScale().format(price);
}

/** The rows for a drawing under the pointer, acting on the whole selection it belongs to. */
function drawingEntries(ctx: WidgetContext, primary: Drawing, ids: readonly string[]): MenuEntry[] {
  const { draw } = ctx;
  const schema = drawingSettingsSchema(primary.tool);
  const out: MenuEntry[] = [];
  const locked = primary.locked === true;
  const hidden = primary.visible === false;
  const behind = primary.zIndex < 0;
  const many = ids.length > 1;
  const noun = many ? `${ids.length} drawings` : 'drawing';
  out.push({ id: 'draw-props', label: many ? 'Properties of the selection...' : 'Properties...', icon: 'settings',
    run: () => { mountDrawingProperties(ctx, undefined, { ids }); } });
  if (!many && isTextContent(primary)) {
    out.push({ id: 'draw-text', label: 'Edit text', icon: 'text', chord: 'Enter', run: () => { mountTextEditor(ctx, undefined, { id: primary.id }); } });
  }
  if (schema.fields.some((f) => f.kind === 'levels')) {
    out.push({ id: 'draw-levels', label: 'Edit levels...', run: () => { mountLevelEditor(ctx, undefined, { ids }); } });
  }
  out.push(SEP);
  out.push({ id: 'draw-copy', label: `Copy ${noun}`, icon: 'copy', chord: 'Ctrl+C', run: () => { void draw.copy(ids); } });
  out.push({ id: 'draw-cut', label: `Cut ${noun}`, chord: 'Ctrl+X', disabled: locked, note: locked ? 'locked' : undefined,
    run: () => { void draw.cut(ids); } });
  out.push({ id: 'draw-duplicate', label: 'Duplicate', icon: 'duplicate', chord: 'Ctrl+D', run: () => { draw.duplicate(ids); } });
  out.push(SEP);
  out.push({ id: 'draw-lock', label: locked ? 'Unlock' : 'Lock', icon: locked ? 'lock' : 'unlock', mark: 'check', on: locked,
    run: () => { draw.updateMany(ids.map((id) => ({ id, patch: { locked: !locked } }))); } });
  out.push({ id: 'draw-hide', label: hidden ? 'Show' : 'Hide', icon: hidden ? 'eye-off' : 'eye', mark: 'check', on: hidden,
    run: () => { draw.updateMany(ids.map((id) => ({ id, patch: { visible: hidden } }))); } });
  out.push(SEP);
  out.push(header('Order'));
  // The controller reorders one drawing at a time (the list position is part
  // of the order), so a multi-selection is several calls.
  out.push({ id: 'draw-front', label: 'Bring to front', icon: 'front', run: () => { for (const id of ids) draw.bringToFront(id); } });
  out.push({ id: 'draw-back', label: 'Send to back', icon: 'back', run: () => { for (const id of ids) draw.sendToBack(id); } });
  out.push({ id: 'draw-above', label: 'In front of the series', icon: glyphSvg(ABOVE_GLYPH), mark: 'radio', on: !behind,
    run: () => { for (const id of ids) draw.bringAboveSeries(id); } });
  out.push({ id: 'draw-behind', label: 'Behind the series', icon: glyphSvg(BEHIND_GLYPH), mark: 'radio', on: behind,
    run: () => { for (const id of ids) draw.sendBehindSeries(id); } });
  out.push(SEP);
  out.push({ id: 'draw-delete', label: many ? `Delete ${noun}` : 'Delete', icon: 'trash', chord: 'Del', danger: true,
    disabled: locked, note: locked ? 'locked' : undefined, run: () => { draw.removeMany(ids); } });
  return out;
}

/** The rows for one price axis, every one read off `priceAxisState`. */
function axisEntries(ctx: WidgetContext, paneIndex: number, scaleId: PriceScaleId): MenuEntry[] {
  const { chart } = ctx;
  const state = (): ReturnType<Chart['priceAxisState']> => chart.priceAxisState(paneIndex, scaleId);
  const s = state();
  if (s === null) return [];
  const out: MenuEntry[] = [];
  out.push({ id: 'axis-autofit', label: 'Auto-fit to the data', mark: 'check', on: s.autoFit, keepOpen: true,
    run: () => { const now = state(); if (now !== null) chart.setPriceAxisAutoFit(paneIndex, scaleId, !now.autoFit); } });
  out.push({ id: 'axis-invert', label: 'Invert', mark: 'check', on: s.inverted, keepOpen: true,
    run: () => { const now = state(); if (now !== null) chart.setPriceAxisOptions(paneIndex, scaleId, { inverted: !now.inverted }); } });
  // Holding the price-per-bar ratio while the time axis zooms needs a measured
  // scale. Nothing has been measured on an empty pane, so the row stays,
  // greyed, saying why.
  out.push({ id: 'axis-lock', label: 'Pin price per bar', mark: 'check', on: s.lockRatio, keepOpen: true,
    disabled: !s.scaled, note: s.scaled ? undefined : 'nothing measured',
    run: () => {
      const now = state();
      if (now === null) return;
      if (!chart.setPriceAxisLockRatio(paneIndex, scaleId, !now.lockRatio)) ctx.toast('Nothing measured on this scale yet', 'info');
    } });
  out.push(SEP);
  out.push(header('Scale'));
  for (const mode of PRICE_SCALE_MODES) {
    out.push({ id: `axis-mode-${mode}`, label: SCALE_MODE_LABELS[mode], mark: 'radio', on: s.mode === mode, keepOpen: true,
      run: () => { chart.setPriceAxisOptions(paneIndex, scaleId, { mode }); } });
  }
  out.push(SEP);
  out.push({ id: 'axis-move', label: s.side === 'right' ? 'Move the scale to the left' : 'Move the scale to the right',
    disabled: !s.movable, note: s.movable ? undefined : (s.active ? 'other side taken' : 'nothing on this side'),
    run: () => {
      const now = state();
      if (now === null) return;
      if (!chart.movePriceAxis(paneIndex, now.side, now.side === 'right' ? 'left' : 'right')) ctx.toast('That side is already in use', 'info');
    } });
  out.push(SEP);
  out.push({ id: 'axis-settings', label: 'Axis settings...', icon: 'settings', run: () => { mountSettingsDialog(ctx, undefined, { tab: 'axes' }); } });
  return out;
}

/**
 * Every row the menu shows for `e`, in order. Pure apart from the closures:
 * nothing is rendered, so a test (or a host building its own menu) can read
 * the list.
 */
export function contextMenuEntries(ctx: WidgetContext, e: ContextMenuEvent, hooks: ContextMenuHooks = {}): MenuEntry[] {
  const { chart, draw } = ctx;
  const target = e.target;
  const out: MenuEntry[] = [];
  const sep = (): void => { if (out.length > 0 && out[out.length - 1].kind !== 'separator') out.push(SEP); };

  if (target.kind === 'price-scale') {
    out.push(...axisEntries(ctx, e.paneIndex, target.scaleId ?? target.side ?? 'right'));
    return out;
  }

  // Order entry: only through a host hook, and only at a price when there is
  // one. Off the plot the order rows would be offering to trade at nothing.
  const onOrder = hooks.onOrder;
  if (onOrder !== undefined && target.kind !== 'time-scale') {
    const price = e.price;
    const order = (side: OrderRequest['side'], type: OrderRequest['type']): MenuItem => ({
      id: `order-${side.toLowerCase()}-${type.toLowerCase()}`,
      label: type === 'MARKET'
        ? `${side === 'BUY' ? 'Buy' : 'Sell'} market`
        : `${side === 'BUY' ? 'Buy' : 'Sell'} ${type === 'LIMIT' ? 'limit' : 'stop'} at ${priceText(chart, e.paneIndex, price as number)}`,
      run: () => onOrder({ side, type, price: type === 'MARKET' ? null : price, paneIndex: e.paneIndex }),
    });
    out.push(header('Trade'));
    out.push(order('BUY', 'MARKET'), order('SELL', 'MARKET'));
    if (price !== null) {
      out.push(order('BUY', 'LIMIT'), order('SELL', 'LIMIT'), order('BUY', 'SL'), order('SELL', 'SL'));
    }
  }

  const hitId = drawingIdOf(target);
  const hit = hitId === null ? undefined : draw.get(hitId);
  if (hit !== undefined) {
    // A right-click picks the drawing the way a click does, so the actions
    // read on the thing under the pointer and not on a stale selection.
    if (!draw.selection().includes(hit.id)) draw.select(hit.id);
    const ids = draw.selection().includes(hit.id) ? draw.selection().slice() : [hit.id];
    sep();
    out.push(...drawingEntries(ctx, hit, ids));
  }

  if (target.kind === 'indicator' && target.instanceId !== undefined) {
    const inst = chart.indicators().find((i) => i.id === target.instanceId);
    if (inst !== undefined) {
      sep();
      out.push({ id: 'ind-settings', label: `${inst.name} settings...`, icon: 'settings',
        run: () => { mountIndicatorSettings(ctx, undefined, { instanceId: inst.id }); } });
      out.push({ id: 'ind-visible', label: inst.visible() ? `Hide ${inst.name}` : `Show ${inst.name}`, icon: inst.visible() ? 'eye' : 'eye-off',
        run: () => { inst.setVisible(!inst.visible()); } });
      out.push({ id: 'ind-remove', label: `Remove ${inst.name}`, icon: 'trash', danger: true,
        run: () => { chart.removeIndicator(inst.id); } });
    }
  }

  if (target.kind !== 'time-scale') {
    sep();
    out.push({ id: 'draw-paste', label: 'Paste', icon: 'paste', chord: 'Ctrl+V',
      run: () => { void draw.paste().then((made) => { if (made.length === 0) ctx.toast('Nothing to paste', 'info'); }); } });
    const n = draw.drawings().length;
    if (n > 0) {
      out.push({ id: 'draw-clear', label: `Remove all drawings (${n})`, icon: 'trash', danger: true, run: () => { draw.clear(); } });
    }
  }

  sep();
  out.push({ id: 'chart-fit', label: 'Fit all bars', icon: glyphSvg(FIT_GLYPH), run: () => { chart.fitContent(); } });
  if (target.kind !== 'time-scale') {
    out.push({ id: 'chart-indicators', label: 'Indicators...', run: () => { mountIndicatorPicker(ctx); } });
  }
  out.push({ id: 'chart-settings', label: 'Settings...', icon: 'settings', run: () => { mountSettingsDialog(ctx); } });

  const extra = hooks.items?.(e) ?? [];
  if (extra.length > 0) { sep(); out.push(...extra); }
  return out;
}

/** A chart-level event for a menu raised from a button rather than the canvas. */
function syntheticEvent(): ContextMenuEvent {
  return {
    paneIndex: 0, point: { x: 0, y: 0 }, price: null, time: null, index: null,
    target: { kind: 'empty', id: null }, preventDefault: () => {},
  };
}

/** One menu per widget; a second right-click replaces the first. */
const OPEN = new WeakMap<HTMLElement, PanelHandle>();

/**
 * Show the menu for `opts.event` at the pointer, or the chart-level menu below
 * `anchor` when no event is given.
 */
export function mountContextMenu(ctx: WidgetContext, anchor?: HTMLElement, opts: ContextMenuOptions = {}): PanelHandle {
  const doc = ctx.document;
  OPEN.get(ctx.root)?.close();
  const e = opts.event ?? syntheticEvent();
  const hooks = opts.hooks ?? {};

  const menu = el(doc, 'div', 'oac-panel oac-ctx');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Chart menu');
  menu.tabIndex = -1;
  stopOwnKeys(menu);

  let rows: HTMLButtonElement[] = [];

  const focusRow = (i: number): void => {
    const live = rows.filter((r) => r.getAttribute('aria-disabled') !== 'true');
    if (live.length === 0) return;
    live[((i % live.length) + live.length) % live.length].focus();
  };

  function paint(focusIndex = -1): void {
    menu.innerHTML = '';
    rows = [];
    const entries = contextMenuEntries(ctx, e, hooks);
    for (const entry of entries) {
      if (entry.kind === 'separator') { menu.appendChild(el(doc, 'div', 'oac-ctx__hr')); continue; }
      if (entry.kind === 'header') { menu.appendChild(el(doc, 'div', 'oac-head', entry.label)); continue; }
      const item = entry;
      const row = el(doc, 'button', 'oac-ctx__row' + (item.danger === true ? ' is-danger' : ''));
      row.type = 'button';
      row.setAttribute('role', item.mark === 'check' ? 'menuitemcheckbox' : item.mark === 'radio' ? 'menuitemradio' : 'menuitem');
      if (item.mark !== undefined) row.setAttribute('aria-checked', item.on === true ? 'true' : 'false');
      if (item.id !== undefined) row.dataset.act = item.id;
      row.tabIndex = -1;
      // The marker column is drawn either way, so the labels keep one left
      // edge whether anything is set or not.
      const mark = el(doc, 'span', 'oac-ctx__mark');
      if (item.mark === 'radio' && item.on === true) mark.appendChild(el(doc, 'span', 'oac-ctx__dot'));
      else if (item.mark === 'check' && item.on === true) mark.innerHTML = TICK;
      else if (item.icon !== undefined) {
        if (item.icon.startsWith('<svg')) { const g = el(doc, 'span', 'oac-glyph oac-glyph--chrome'); g.innerHTML = item.icon; mark.appendChild(g); }
        else mark.appendChild(chromeGlyph(doc, item.icon));
      }
      row.appendChild(mark);
      row.appendChild(el(doc, 'span', 'oac-ctx__label', item.label));
      if (item.note !== undefined && item.note !== '') row.appendChild(el(doc, 'span', 'oac-ctx__note', item.note));
      if (item.chord !== undefined) row.appendChild(el(doc, 'kbd', 'oac-ctx__key', item.chord));
      if (item.disabled === true) {
        row.setAttribute('aria-disabled', 'true');
      } else {
        row.addEventListener('click', (ev) => {
          ev.stopPropagation();
          item.run?.();
          if (item.keepOpen === true) paint(rows.indexOf(row));
          else handle.close();
        });
      }
      menu.appendChild(row);
      rows.push(row);
    }
    if (focusIndex >= 0 && rows[focusIndex] !== undefined) rows[focusIndex].focus();
  }
  paint();

  menu.addEventListener('keydown', (ev) => {
    const k = (ev as KeyboardEvent).key;
    const live = rows.filter((r) => r.getAttribute('aria-disabled') !== 'true');
    const at = live.indexOf(doc.activeElement as HTMLButtonElement);
    if (k === 'ArrowDown') { ev.preventDefault(); focusRow(at + 1); }
    else if (k === 'ArrowUp') { ev.preventDefault(); focusRow(at <= 0 ? live.length - 1 : at - 1); }
    else if (k === 'Home') { ev.preventDefault(); focusRow(0); }
    else if (k === 'End') { ev.preventDefault(); focusRow(live.length - 1); }
  });

  const first = rows.find((r) => r.getAttribute('aria-disabled') !== 'true') ?? menu;
  const handle = openPanel(
    ctx, menu,
    anchor !== undefined && opts.event === undefined
      ? { anchor, placement: 'below', initialFocus: first }
      : { placement: 'below', modal: false, dismissOnOutside: true, initialFocus: first },
    () => {},
  );
  if (anchor === undefined || opts.event !== undefined) {
    const container = chartContainer(ctx.chart);
    const off = container === null ? { left: 0, top: 0 } : boxInRoot(ctx.root, container);
    placePanel(ctx.root, menu, { point: { x: e.point.x + off.left, y: e.point.y + off.top } });
  }
  OPEN.set(ctx.root, handle);
  return handle;
}

/**
 * Wire the chart's `contextmenu` event to the menu. Returns the unsubscriber.
 * The browser's own menu is suppressed only once ours is up, so a host that
 * detaches this gets the native one back.
 */
export function attachContextMenu(ctx: WidgetContext, hooks: ContextMenuHooks = {}): () => void {
  return ctx.chart.on('contextmenu', (payload) => {
    const e = payload as ContextMenuEvent;
    e.preventDefault();
    mountContextMenu(ctx, undefined, { event: e, hooks });
  });
}
