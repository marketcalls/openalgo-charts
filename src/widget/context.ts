/**
 * The contract between the widget shell and everything mounted inside it.
 *
 * `WidgetContext` is what the shell hands to the rail, the top bar, the
 * status line and every dialog: the chart and the drawing controller, the
 * root element, the theme in force, the keymap, a toast, an overlay opener
 * that positions, focus-traps and Escape-closes whatever it is given, and a
 * small event bus. A dialog module never reaches for the document on its own;
 * everything it needs to place itself or to hand focus back comes from here.
 *
 * The rest of this file is the furniture behind that contract: the bus, the
 * overlay stack, the tooltip, the storage wrapper and the dialog registry
 * through which the dialog tier makes its mount functions known.
 */
import type { Chart, ChartTheme } from 'openalgo-charts';
import type { DrawingController } from 'openalgo-charts/draw';
import type { Keymap } from './keymap';
import type { ToastHandle, ToastKind } from './toast';
import type { WidgetThemeName } from './tokens';

// ── small DOM helpers ───────────────────────────────────────────────────

/** HTML-escape the four characters that matter in text and attribute values. */
export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

/** Create an element with a class and optional attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, className?: string, attrs?: Record<string, string>,
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (attrs) for (const [k, val] of Object.entries(attrs)) el.setAttribute(k, val);
  return el;
}

/**
 * A glyph span. The markup is a string from the draw tier's icon builders,
 * so this is the one place `innerHTML` is written, and it only ever wraps a
 * trusted `<svg>` from the registry.
 */
export function glyph(doc: Document, svg: string, kind: 'tool' | 'chrome'): HTMLSpanElement {
  const span = doc.createElement('span');
  span.className = 'oac-glyph oac-glyph--' + kind;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = svg;
  return span;
}

/** Whether a key event came from a text control, where chords stay out of the way. */
export function inTextField(target: unknown): boolean {
  const t = target as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (t === null || t === undefined) return false;
  if (t.isContentEditable === true) return true;
  const tag = (t.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  // A checkbox or a button-shaped input takes no typing.
  const type = (t.type ?? 'text').toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
}

/** Whether `n` can take focus: a control, enabled, and not under a `hidden`. */
export function focusable(n: Element | null): n is HTMLElement {
  if (n === null) return false;
  const el = n as HTMLElement & { disabled?: boolean };
  if (el.disabled === true) return false;
  const ti = el.getAttribute('tabindex');
  if (ti !== null && Number(ti) < 0) return false;
  const tag = el.tagName;
  const natural = tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
    || (tag === 'A' && el.hasAttribute('href'));
  if (!natural && ti === null) return false;
  for (let p: HTMLElement | null = el; p !== null; p = p.parentElement) if (p.hidden) return false;
  return true;
}

export const focusables = (root: Element): HTMLElement[] =>
  Array.from(root.querySelectorAll('*')).filter(focusable);

export interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
export interface Size { width: number; height: number }

/**
 * Where a panel of `size` goes beside `anchor` without leaving `bounds`: to
 * the right of it by `gap`, its top on the anchor's top, then pulled up (never
 * past `pad`) when it would run off the bottom, and flipped to the left only
 * when the right has no room at all. Coordinates are in whatever space the
 * anchor and the bounds share.
 */
export function placeBeside(anchor: Box, size: Size, bounds: Size, gap = 6, pad = 8): { left: number; top: number; side: 'left' | 'right' } {
  let left = anchor.right + gap;
  let side: 'left' | 'right' = 'right';
  if (left + size.width > bounds.width - pad && anchor.left - gap - size.width >= pad) {
    left = anchor.left - gap - size.width;
    side = 'left';
  }
  left = Math.max(pad, Math.min(left, bounds.width - size.width - pad));
  const top = Math.max(pad, Math.min(anchor.top, bounds.height - size.height - pad));
  return { left, top, side };
}

/** A panel under `anchor`, left-aligned with it, flipped above when there is no room below. */
export function placeBelow(anchor: Box, size: Size, bounds: Size, gap = 4, pad = 8): { left: number; top: number } {
  let top = anchor.bottom + gap;
  if (top + size.height > bounds.height - pad && anchor.top - gap - size.height >= pad) {
    top = anchor.top - gap - size.height;
  }
  return {
    left: Math.max(pad, Math.min(anchor.left, bounds.width - size.width - pad)),
    top: Math.max(pad, Math.min(top, bounds.height - size.height - pad)),
  };
}

export type TipSide = 'right' | 'left' | 'top' | 'bottom';

/** A tip centred on the anchor's edge, flipped across it when its side has no room. */
export function placeTip(anchor: Box, size: Size, bounds: Size, side: TipSide = 'right', gap = 8, pad = 6): { left: number; top: number } {
  let x: number;
  let y: number;
  if (side === 'right' || side === 'left') {
    const wantRight = side === 'right';
    x = wantRight ? anchor.right + gap : anchor.left - gap - size.width;
    if (wantRight ? x + size.width > bounds.width - pad : x < pad) {
      x = wantRight ? anchor.left - gap - size.width : anchor.right + gap;
    }
    y = anchor.top + anchor.height / 2 - size.height / 2;
  } else {
    const wantBelow = side !== 'top';
    y = wantBelow ? anchor.bottom + gap : anchor.top - gap - size.height;
    if (wantBelow ? y + size.height > bounds.height - pad : y < pad) {
      y = wantBelow ? anchor.top - gap - size.height : anchor.bottom + gap;
    }
    x = anchor.left + anchor.width / 2 - size.width / 2;
  }
  return {
    left: Math.max(pad, Math.min(x, bounds.width - size.width - pad)),
    top: Math.max(pad, Math.min(y, bounds.height - size.height - pad)),
  };
}

/** An element's box in the coordinate space of `root` (the widget), not the viewport. */
export function boxIn(root: HTMLElement, el: Element): Box {
  const r = root.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  return {
    left: b.left - r.left, top: b.top - r.top, right: b.right - r.left, bottom: b.bottom - r.top,
    width: b.width, height: b.height,
  };
}

// ── event bus ──────────────────────────────────────────────────────────

export type BusHandler<T = unknown> = (payload: T) => void;

/**
 * A tiny typed event bus. Handlers run in registration order; one that throws
 * does not stop the others, because a host's listener failing must not take
 * the shell's own bookkeeping with it.
 */
export class WidgetBus<Events extends Record<string, unknown> = Record<string, unknown>> {
  private readonly _handlers = new Map<string, Set<BusHandler>>();

  public on<K extends keyof Events & string>(event: K, handler: BusHandler<Events[K]>): () => void {
    let set = this._handlers.get(event);
    if (set === undefined) { set = new Set(); this._handlers.set(event, set); }
    set.add(handler as BusHandler);
    return () => this.off(event, handler);
  }

  public off<K extends keyof Events & string>(event: K, handler?: BusHandler<Events[K]>): void {
    if (handler === undefined) { this._handlers.delete(event); return; }
    this._handlers.get(event)?.delete(handler as BusHandler);
  }

  public emit<K extends keyof Events & string>(event: K, payload: Events[K]): void {
    const set = this._handlers.get(event);
    if (set === undefined) return;
    const errors: unknown[] = [];
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (e) { errors.push(e); }
    }
    if (errors.length > 0) throw errors[0];
  }

  public clear(): void { this._handlers.clear(); }
}

// ── storage ────────────────────────────────────────────────────────────

/** The three calls the widget makes on a store. `localStorage` satisfies it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Every key the widget writes sits under this prefix, so a host on the same origin cannot collide. */
export const STORAGE_PREFIX = 'oac-widget:';

/**
 * Namespaced JSON storage that never throws: a private window, a full quota
 * or a blocked store all read as "nothing saved" and write as "not kept".
 */
export class WidgetStorage {
  private readonly _store: StorageLike | null;
  private readonly _ns: string;

  public constructor(namespace: string, store: StorageLike | null) {
    this._ns = STORAGE_PREFIX + namespace + ':';
    this._store = store;
  }

  public key(name: string): string { return this._ns + name; }

  public get(name: string): unknown {
    if (this._store === null) return null;
    try {
      const raw = this._store.getItem(this.key(name));
      return raw === null ? null : JSON.parse(raw);
    } catch { return null; }
  }

  /** True when the write landed. */
  public set(name: string, value: unknown): boolean {
    if (this._store === null) return false;
    try { this._store.setItem(this.key(name), JSON.stringify(value)); return true; } catch { return false; }
  }

  public remove(name: string): void {
    if (this._store === null) return;
    try { this._store.removeItem(this.key(name)); } catch { /* nothing to remove, or no store */ }
  }

  /** Whether writes can land at all. */
  public get enabled(): boolean { return this._store !== null; }
}

/** The page's `localStorage` when it exists and works, else null. */
export function defaultStorage(): StorageLike | null {
  try {
    const g = globalThis as { localStorage?: StorageLike };
    return g.localStorage !== undefined && typeof g.localStorage.getItem === 'function' ? g.localStorage : null;
  } catch { return null; }
}

// ── dialog registry ────────────────────────────────────────────────────

/** What a dialog module's mount function returns. */
export interface DialogHandle { close(): void }

/** The mount signature every dialog exports: `(ctx, anchor?) => { close }`. */
export type DialogMount = (ctx: WidgetContext, anchor?: HTMLElement) => DialogHandle;

/**
 * The dialogs the shell knows how to ask for. Each is mounted by the dialog
 * tier and registered here; a shell built without one renders the control
 * that would open it disabled, with its state visible, rather than dead.
 */
export type WidgetDialogName =
  | 'settings' | 'indicatorPicker' | 'indicatorSettings' | 'drawingProperties'
  | 'contextMenu' | 'levelEditor' | 'textEditor';

const DIALOGS = new Map<WidgetDialogName, DialogMount>();

/** Make a dialog's mount function known to every shell. Returns a disposer. */
export function registerWidgetDialog(name: WidgetDialogName, mount: DialogMount): () => void {
  DIALOGS.set(name, mount);
  return () => { if (DIALOGS.get(name) === mount) DIALOGS.delete(name); };
}

/** Register several at once, from a module's exports. */
export function registerWidgetDialogs(mounts: Partial<Record<WidgetDialogName, DialogMount>>): () => void {
  const undo = Object.entries(mounts).map(([n, m]) => registerWidgetDialog(n as WidgetDialogName, m as DialogMount));
  return () => { for (const u of undo) u(); };
}

/** Take a dialog out of the registry. False when nothing was registered under the name. */
export function unregisterWidgetDialog(name: WidgetDialogName): boolean {
  return DIALOGS.delete(name);
}

/** The registered mount for a dialog, or null. */
export function widgetDialog(name: WidgetDialogName): DialogMount | null {
  return DIALOGS.get(name) ?? null;
}

export function registeredWidgetDialogs(): WidgetDialogName[] {
  return Array.from(DIALOGS.keys());
}

// ── overlay stack ──────────────────────────────────────────────────────

export interface OverlayOptions {
  /** The control the panel opens from; positions the panel and keeps a click on it from counting as outside. */
  anchor?: HTMLElement;
  /** Where the panel goes relative to the anchor. Default `below`; `center` ignores the anchor. */
  placement?: 'below' | 'beside' | 'center';
  /** A second element the panel should clear when placed beside (the rail, not just the button in it). */
  edge?: HTMLElement;
  /** Draw a scrim and refuse outside dismissal. Default false; `center` placement implies it. */
  modal?: boolean;
  /** Where focus lands: an element, `null` to leave focus where it is, or the first control (default). */
  initialFocus?: HTMLElement | null;
  /** Close on a press outside the panel and its anchor. Default: not modal. */
  dismissOnOutside?: boolean;
  /** Close on Escape. Default true. */
  dismissOnEscape?: boolean;
  /** Give focus back to the opener on close. Default true. */
  restoreFocus?: boolean;
  onClose?: () => void;
}

interface OverlayEntry {
  el: HTMLElement;
  opts: OverlayOptions;
  scrim: HTMLElement | null;
  restore: HTMLElement | null;
  closed: boolean;
}

export interface OverlayStack {
  open(el: HTMLElement, opts?: OverlayOptions): () => void;
  /** Close the newest overlay. False when nothing is open. */
  closeTop(): boolean;
  closeAll(): void;
  top(): HTMLElement | null;
  size(): number;
  /** The layer element overlays are appended to. */
  readonly layer: HTMLElement;
  destroy(): void;
}

/**
 * One stack per widget. Each module opens and closes its own panel; what none
 * of them can know is what else is open. The stack knows: Escape closes only
 * the newest thing, Tab stays inside it, a press outside closes a popover but
 * not a dialog, and focus goes back where it came from.
 */
export function createOverlayStack(root: HTMLElement, doc: Document): OverlayStack {
  const layer = h(doc, 'div', 'oac-layer');
  root.appendChild(layer);
  const stack: OverlayEntry[] = [];

  const close = (entry: OverlayEntry): void => {
    if (entry.closed) return;
    entry.closed = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    const active = doc.activeElement as HTMLElement | null;
    const inside = active !== null && entry.el.contains(active);
    entry.el.remove();
    entry.scrim?.remove();
    entry.opts.anchor?.setAttribute('aria-expanded', 'false');
    // Only when focus was still in the overlay, or was lost with it: a click
    // that opened something else has already decided where focus goes next.
    const lost = active === null || active === doc.body || inside;
    if (entry.opts.restoreFocus !== false && lost && entry.restore !== null && entry.restore.isConnected) {
      entry.restore.focus();
    }
    entry.opts.onClose?.();
    if (stack.length === 0) unlisten();
  };

  const onKey = (e: KeyboardEvent): void => {
    const top = stack[stack.length - 1];
    if (top === undefined) return;
    if (e.key === 'Escape') {
      if (top.opts.dismissOnEscape === false) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(top);
      return;
    }
    if (e.key !== 'Tab') return;
    const f = focusables(top.el);
    if (f.length === 0) { e.preventDefault(); return; }
    const at = f.indexOf(doc.activeElement as HTMLElement);
    // Outside the overlay (index -1) or past either end wraps; anywhere else
    // the browser's own move stays inside and is left alone.
    let next: number | null = null;
    if (e.shiftKey) { if (at <= 0) next = f.length - 1; } else if (at === -1 || at >= f.length - 1) next = 0;
    if (next !== null) { e.preventDefault(); f[next].focus(); }
  };

  const onPointerDown = (e: Event): void => {
    const target = e.target as Node | null;
    // Newest first: an outside press closes every popover above the one it
    // landed in, and stops at a modal.
    for (let i = stack.length - 1; i >= 0; i--) {
      const o = stack[i];
      if (target !== null && (o.el.contains(target) || o.opts.anchor?.contains(target) === true)) break;
      if (o.opts.dismissOnOutside === false || (o.opts.modal === true && o.opts.dismissOnOutside !== true)) break;
      close(o);
    }
  };

  let listening = false;
  const listen = (): void => {
    if (listening) return;
    listening = true;
    doc.addEventListener('keydown', onKey as EventListener, true);
    doc.addEventListener('pointerdown', onPointerDown, true);
  };
  const unlisten = (): void => {
    if (!listening) return;
    listening = false;
    doc.removeEventListener('keydown', onKey as EventListener, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
  };

  const open = (el: HTMLElement, opts: OverlayOptions = {}): (() => void) => {
    const placement = opts.placement ?? (opts.anchor ? 'below' : 'center');
    const modal = opts.modal ?? placement === 'center';
    const active = doc.activeElement as HTMLElement | null;
    const restore = active !== null && active !== doc.body && !el.contains(active) ? active : null;
    let scrim: HTMLElement | null = null;
    const entry: OverlayEntry = { el, opts: { ...opts, modal }, scrim: null, restore, closed: false };
    if (modal) {
      scrim = h(doc, 'div', 'oac-scrim');
      if (opts.dismissOnOutside === true) scrim.addEventListener('pointerdown', () => close(entry));
      layer.appendChild(scrim);
      entry.scrim = scrim;
    }
    // The chart captures the pointer on press and would start a pan under a
    // panel that let the event through.
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    if (placement === 'center') {
      el.classList.add('oac-dialog');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
    } else {
      el.classList.add('oac-pop');
    }
    if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
    layer.appendChild(el);
    if (placement !== 'center' && opts.anchor) {
      const bounds = root.getBoundingClientRect();
      let anchorBox = boxIn(root, opts.anchor);
      if (placement === 'beside' && opts.edge) {
        const edge = boxIn(root, opts.edge);
        const right = Math.max(anchorBox.right, edge.right);
        anchorBox = { ...anchorBox, right, width: right - anchorBox.left };
      }
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      const at = placement === 'beside'
        ? placeBeside(anchorBox, size, bounds)
        : placeBelow(anchorBox, size, bounds);
      el.style.left = at.left + 'px';
      el.style.top = at.top + 'px';
      opts.anchor.setAttribute('aria-expanded', 'true');
    }
    stack.push(entry);
    listen();
    if (opts.initialFocus !== null) {
      const first = opts.initialFocus ?? firstControl(el);
      (first ?? el).focus();
    }
    return () => close(entry);
  };

  return {
    open,
    closeTop: () => {
      const top = stack[stack.length - 1];
      if (top === undefined) return false;
      close(top);
      return true;
    },
    closeAll: () => { for (const o of stack.slice().reverse()) close(o); },
    top: () => stack[stack.length - 1]?.el ?? null,
    size: () => stack.length,
    layer,
    destroy: () => {
      for (const o of stack.slice().reverse()) close(o);
      unlisten();
      layer.remove();
    },
  };
}

/**
 * Where focus lands in a freshly opened overlay: the first control of its
 * body. A dialog's close button comes first in the markup, and landing on it
 * reads as "press Enter to leave", which is not what a dialog is for.
 */
function firstControl(node: HTMLElement): HTMLElement | null {
  const all = focusables(node);
  return all.find((n) => n.closest('.oac-dialog__head') === null) ?? all[0] ?? null;
}

// ── tooltip ────────────────────────────────────────────────────────────

export interface TipSpec {
  title: string;
  /** The chord, shown in monospace after the title. */
  chord?: string;
  /** A second, muted line. */
  sub?: string;
  side?: TipSide;
}

/** A spec, or a function read at show time for a control whose label follows its state. */
export type TipSource = TipSpec | (() => TipSpec | null);

export interface TipController {
  /** Give `target` a hover label. `dwellMs` delays it; 0 shows on entry. */
  attach(target: HTMLElement, spec: TipSource, dwellMs?: number): void;
  /** Re-read a control's spec into its accessible name. */
  refreshLabel(target: HTMLElement): void;
  show(target: HTMLElement): void;
  hide(): void;
  /** The control the tip is up for, or null. */
  target(): HTMLElement | null;
  destroy(): void;
}

/** How long the pointer rests on a rail control before its label appears. */
export const TIP_DWELL_MS = 600;

/**
 * One tip node per widget. A `title` waits about a second, cannot be styled
 * and cannot carry a second line, which is no use on a rail of near-identical
 * glyphs or on a bar of bare icons. Specs are read at show time, because a
 * group button stands for whichever tool was last picked from it.
 */
export function createTipController(root: HTMLElement, layer: HTMLElement, doc: Document): TipController {
  const specs = new WeakMap<HTMLElement, TipSource>();
  let node: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let tipFor: HTMLElement | null = null;

  const read = (raw: TipSource): TipSpec | null => (typeof raw === 'function' ? raw() : raw);

  const hide = (): void => {
    if (timer !== 0) clearTimeout(timer);
    timer = 0;
    tipFor = null;
    node?.classList.remove('is-on');
  };

  const show = (target: HTMLElement): void => {
    const raw = specs.get(target);
    if (raw === undefined || !target.isConnected) return;
    const spec = read(raw);
    if (spec === null || !spec.title) { hide(); return; }
    if (typeof raw === 'function') target.setAttribute('aria-label', spec.title);
    if (node === null) {
      node = h(doc, 'div', 'oac-tip', { role: 'presentation' });
    }
    if (node.parentNode !== layer) layer.appendChild(node);
    tipFor = target;
    node.textContent = '';
    node.appendChild(doc.createTextNode(spec.title));
    if (spec.chord) {
      const k = h(doc, 'kbd', 'oac-tip__chord');
      k.textContent = spec.chord;
      node.appendChild(k);
    }
    if (spec.sub) {
      const s = h(doc, 'span', 'oac-tip__sub');
      s.textContent = spec.sub;
      node.appendChild(s);
    }
    const bounds = root.getBoundingClientRect();
    const at = placeTip(boxIn(root, target), { width: node.offsetWidth, height: node.offsetHeight }, bounds, spec.side ?? 'right');
    node.style.left = at.left + 'px';
    node.style.top = at.top + 'px';
    node.classList.add('is-on');
  };

  return {
    attach: (target, spec, dwellMs = 0) => {
      specs.set(target, spec);
      const first = read(spec);
      if (first !== null && first.title && !target.getAttribute('aria-label')) target.setAttribute('aria-label', first.title);
      target.removeAttribute('title');
      const arm = (): void => {
        if (timer !== 0) clearTimeout(timer);
        if (dwellMs > 0) timer = setTimeout(() => show(target), dwellMs);
        else show(target);
      };
      target.addEventListener('pointerenter', arm);
      target.addEventListener('focus', arm);
      target.addEventListener('pointerleave', hide);
      target.addEventListener('blur', hide);
      // A press means the user has decided; a label left over a menu that
      // just opened reads as part of the menu.
      target.addEventListener('pointerdown', hide);
      target.addEventListener('keydown', hide);
    },
    refreshLabel: (target) => {
      const raw = specs.get(target);
      if (typeof raw !== 'function') return;
      const spec = raw();
      if (spec !== null && spec.title) target.setAttribute('aria-label', spec.title);
    },
    show,
    hide,
    target: () => tipFor,
    destroy: () => { hide(); node?.remove(); node = null; },
  };
}

// ── the context ────────────────────────────────────────────────────────

/** The events the shell publishes on `ctx.bus`. */
export interface WidgetBusEvents {
  symbol: { symbol: string; exchange: string };
  interval: { interval: string };
  theme: { theme: WidgetThemeName; chartTheme: ChartTheme };
  /** Something about the workspace changed: the chart type, a restored layout, a pane. */
  layout: { reason: string; chartType?: string };
  /** The status line's transient message changed. */
  status: { text: string; kind: 'info' | 'error' };
  /** A keymap registration collided with another binding. */
  'keymap:conflict': { combo: string; kept: string; shadowed: string };
  /** Bars finished loading, or failed to. */
  data: { symbol: string; interval: string; bars: number; error?: string };
  [key: string]: unknown;
}

export interface WidgetContext {
  readonly chart: Chart;
  readonly draw: DrawingController;
  /** The `.oac-widget` element every piece of chrome lives in. */
  readonly root: HTMLElement;
  readonly document: Document;
  /** `dark` or `light`, following the chart theme in force. */
  readonly theme: WidgetThemeName;
  /** The engine palette the chart is drawing with. */
  readonly chartTheme: ChartTheme;
  readonly keymap: Keymap;
  readonly bus: WidgetBus<WidgetBusEvents>;
  /** Per-widget persisted preferences; `enabled` is false when `persist` is off. */
  readonly storage: WidgetStorage;
  readonly locale: string | undefined;
  toast(message: string, kind?: ToastKind): ToastHandle;
  /**
   * Show `el` over the widget: positioned from `opts.anchor` (or centred as a
   * dialog), focus-trapped, closed by Escape and by a press outside. Returns
   * the closer.
   */
  openOverlay(el: HTMLElement, opts?: OverlayOptions): () => void;
  /** Put a transient message on the status line. */
  status(text: string, kind?: 'info' | 'error'): void;
  /** Hover labels for controls. */
  readonly tips: TipController;
  /** The overlay stack behind `openOverlay`, for a module that needs to ask what is open. */
  readonly overlays: OverlayStack;
  /** The current symbol and interval, for dialogs that name them. */
  symbol(): { symbol: string; exchange: string };
  interval(): string;
}
