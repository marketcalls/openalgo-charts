/**
 * The widget keymap: one place every chord the shell, the rail and the
 * dialogs answer to is registered, resolved and listed.
 *
 * The engine has a `ShortcutManager` of its own for chart navigation (arrows,
 * zoom, fit) keyed on physical key codes, and the draw tier answers
 * `matchDrawingShortcut` and `keyToDrawingAction` from `e.key`. Neither knows
 * about the other, about the rail's focus, or about a dialog being open, so
 * the two collide silently: the tier's Alt+V arms a vertical line and the
 * engine's Alt+V toggles the vertical grid, and whichever listener ran first
 * won. This layer runs before both, in the capture phase, with scopes that
 * say where a chord applies, and it records every collision so the shortcuts
 * panel can show the truth rather than the intent.
 *
 * Bindings are written the way the draw tier writes them (`Alt+T`, `Mod+Z`,
 * `?`), from the key the event reports, not the physical code: a chord that
 * has to be read out to a user is a character, and `?` has no code that means
 * the same thing on every layout.
 *
 * The class touches no DOM until `attach`, and `handle` takes any object
 * with the key fields, so every rule is testable without a browser.
 */
import type { ShortcutListItem } from 'openalgo-charts';
import { chromeIconSvg } from 'openalgo-charts/draw';
import { h, inTextField, type WidgetContext } from './context';

/**
 * Where a binding applies. `global` always; `widget` while the pointer or the
 * focus is inside the widget; `chart` while either is on the chart itself;
 * `rail` while the focus is in the tool rail; `overlay` while a dialog or a
 * menu is open, when nothing else fires. The shell decides which are active
 * (see `setScopes`); they are tried narrowest first.
 */
export type KeyScope = 'global' | 'widget' | 'chart' | 'rail' | 'overlay' | (string & {});

/** The event fields the keymap reads. A DOM `KeyboardEvent` satisfies it. */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
  preventDefault?(): void;
  stopPropagation?(): void;
}

/**
 * What runs for a chord. Return `false` to decline: the next binding on the
 * same chord (or the engine, or the browser) gets the key. Anything else
 * claims it, and the event is prevented and stopped.
 */
export type KeyAction = (e: KeyEventLike) => boolean | void;

export interface KeyBindingOptions {
  /** Shown in the shortcuts panel. Defaults to the chord itself. */
  label?: string;
  /** Section of the shortcuts panel. Default `Widget`. */
  group?: string;
  /** Gate read at key time; a false skips the binding without declining for others. */
  when?: () => boolean;
  /** Fire even when the focus is in a text field. Default false. */
  inText?: boolean;
  /** Keep out of the shortcuts panel (a binding that only exists to layer under another). */
  hidden?: boolean;
  /**
   * Declares that this binding shares its chord on purpose: it declines when
   * it does not apply, so an earlier widget binding or the engine's own
   * command on the same chord still fires. Without it a second registration
   * on a chord, or one on a chord the engine binds, is recorded as a conflict.
   */
  layered?: boolean;
}

export interface KeyBinding {
  readonly id: number;
  /** Canonical chord, see `parseKeyCombo`. */
  readonly combo: string;
  readonly scope: KeyScope;
  readonly label: string;
  readonly group: string;
  readonly hidden: boolean;
  readonly inText: boolean;
  /** Shares its chord deliberately; see `KeyBindingOptions.layered`. */
  readonly layered: boolean;
  readonly action: KeyAction;
  readonly when?: () => boolean;
}

export interface KeyConflict {
  readonly combo: string;
  readonly scope: KeyScope;
  /** Label of the binding that fires. */
  readonly kept: string;
  /** Label of the binding that never will while the kept one claims. */
  readonly shadowed: string;
  /** `widget` for two widget bindings, `chart` when the engine's own keymap loses the chord. */
  readonly source: 'widget' | 'chart';
}

const MOD_ALIASES: Readonly<Record<string, 'Mod' | 'Alt' | 'Shift'>> = {
  mod: 'Mod', ctrl: 'Mod', control: 'Mod', cmd: 'Mod', command: 'Mod', meta: 'Mod', win: 'Mod',
  alt: 'Alt', option: 'Alt', opt: 'Alt',
  shift: 'Shift',
};

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'Escape', escape: 'Escape', del: 'Delete', delete: 'Delete', backspace: 'Backspace',
  enter: 'Enter', return: 'Enter', tab: 'Tab', space: 'Space', spacebar: 'Space',
  left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown',
  arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert',
  plus: '+', minus: '-', question: '?', slash: '/', period: '.', comma: ',',
};

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'OS', 'AltGraph', 'CapsLock', 'Fn']);

const MOD_ORDER = ['Mod', 'Alt', 'Shift'];

/** Canonical key name for one written key part. */
function canonicalKey(raw: string): string {
  const lower = raw.toLowerCase();
  if (KEY_ALIASES[lower] !== undefined) return KEY_ALIASES[lower];
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
  if (raw.length === 1) return /[a-z]/i.test(raw) ? lower : raw;
  return raw;
}

/**
 * Canonical form of a chord (`'shift+alt+t'` -> `'Alt+Shift+t'`), or `''`
 * when the spec is not one. Letters are lower-cased and keep Shift; a symbol
 * or a digit drops it, because the character already says which key was
 * pressed with Shift held. Ctrl, Cmd and Meta all read as `Mod`.
 */
export function parseKeyCombo(spec: string): string {
  const s = spec.trim();
  if (s === '') return '';
  let key: string;
  let modParts: string[];
  // The key itself may be '+': alone, or after a modifier as `Ctrl++`.
  if (s === '+') {
    key = '+';
    modParts = [];
  } else if (s.endsWith('++')) {
    key = '+';
    modParts = s.slice(0, -2).split('+').map((p) => p.trim());
  } else {
    const parts = s.split('+').map((p) => p.trim());
    key = parts[parts.length - 1];
    modParts = parts.slice(0, -1);
  }
  // A bare modifier is not a chord: nothing is pressed with it.
  if (key === '' || MOD_ALIASES[key.toLowerCase()] !== undefined) return '';
  const mods = new Set<string>();
  for (const p of modParts) {
    const m = MOD_ALIASES[p.toLowerCase()];
    if (m === undefined) return '';
    mods.add(m);
  }
  key = canonicalKey(key);
  if (key.length === 1 && !/[a-z]/.test(key)) mods.delete('Shift');
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return [...ordered, key].join('+');
}

/** The canonical chord an event stands for, or `''` for a bare modifier press. */
export function eventKeyCombo(e: KeyEventLike): string {
  let key = e.key ?? '';
  if (key === '' || key === 'Unidentified' || MODIFIER_KEYS.has(key)) return '';
  if (key === ' ' || key === 'Spacebar') key = 'Space';
  if (key === 'Esc') key = 'Escape';
  if (key === 'Del') key = 'Delete';
  // Alt turns a letter into a symbol on some layouts and platforms; the
  // physical key still says which letter was meant.
  const code = e.code ?? '';
  if (e.altKey === true && /^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
  const mods: string[] = [];
  if (e.ctrlKey === true || e.metaKey === true) mods.push('Mod');
  if (e.altKey === true) mods.push('Alt');
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) {
      key = key.toLowerCase();
      if (e.shiftKey === true) mods.push('Shift');
    }
  } else if (e.shiftKey === true) {
    mods.push('Shift');
  }
  return [...mods, key].join('+');
}

const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  Escape: 'Esc', Delete: 'Del', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
};

function detectMac(): boolean {
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  return nav !== undefined && /mac|iphone|ipad/i.test(nav.platform ?? nav.userAgent ?? '');
}

/** A chord as a user reads it: `Ctrl+Shift+Z`, or `Cmd+Shift+Z` on a Mac. */
export function formatKeyCombo(combo: string, isMac: boolean = detectMac()): string {
  const c = parseKeyCombo(combo);
  if (c === '') return '';
  const parts = c.split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => (m === 'Mod' ? (isMac ? 'Cmd' : 'Ctrl') : m === 'Alt' ? (isMac ? 'Opt' : 'Alt') : 'Shift'));
  const shown = DISPLAY_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...mods, shown].join('+');
}

/**
 * The engine's code-based combo (`Alt+KeyV`, `Mod+Shift+KeyS`, `Equal`) in
 * this keymap's key-based form, so the two can be compared. Layout-specific
 * symbols are read as a US layout would produce them, which is what the
 * engine's own display does too.
 */
export function fromChartCombo(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return '';
  const code = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => (m === 'Alt' ? 'Alt' : m === 'Shift' ? 'Shift' : 'Mod'));
  let key: string;
  const letter = /^Key([A-Z])$/.exec(code);
  const digit = /^Digit([0-9])$/.exec(code);
  if (letter !== null) key = letter[1].toLowerCase();
  else if (digit !== null) key = digit[1];
  else if (code === 'Equal') key = mods.includes('Shift') ? '+' : '=';
  else if (code === 'Minus') key = mods.includes('Shift') ? '_' : '-';
  else if (code === 'NumpadAdd') key = '+';
  else if (code === 'NumpadSubtract') key = '-';
  else if (code === 'Slash') key = mods.includes('Shift') ? '?' : '/';
  else key = code;
  return parseKeyCombo([...mods, key].join('+'));
}

/** The slice of the engine's shortcut manager the keymap reads. */
export interface ChartShortcutSource {
  list(): ShortcutListItem[];
}

export interface KeymapOptions {
  isMac?: boolean;
  /** The chart's shortcut manager, for conflict detection and the panel's Chart section. */
  chart?: ChartShortcutSource | null;
  /** Which scopes are active right now, narrowest first. Default: `['global']`. */
  scopes?: () => readonly KeyScope[];
}

export interface KeymapGroup {
  readonly group: string;
  readonly rows: ReadonlyArray<{ label: string; combo: string; display: string; shadowedBy?: string }>;
}

export class Keymap {
  private readonly _isMac: boolean;
  private readonly _chart: ChartShortcutSource | null;
  private _scopes: () => readonly KeyScope[];
  private readonly _bindings: KeyBinding[] = [];
  private readonly _byCombo = new Map<string, KeyBinding[]>();
  private readonly _conflicts: KeyConflict[] = [];
  private readonly _conflictListeners = new Set<(c: KeyConflict) => void>();
  private _detach: (() => void) | null = null;
  private _nextId = 1;

  public constructor(opts: KeymapOptions = {}) {
    this._isMac = opts.isMac ?? detectMac();
    this._chart = opts.chart ?? null;
    this._scopes = opts.scopes ?? (() => ['global']);
  }

  public get isMac(): boolean { return this._isMac; }

  /** Replace the scope resolver. */
  public setScopes(fn: () => readonly KeyScope[]): void { this._scopes = fn; }

  public activeScopes(): readonly KeyScope[] { return this._scopes(); }

  /**
   * Bind a chord. Returns a disposer. Throws on a chord the grammar cannot
   * read, because a binding that can never fire is a defect at the call site,
   * not at key time.
   */
  public register(binding: string, action: KeyAction, scope: KeyScope = 'global', opts: KeyBindingOptions = {}): () => void {
    const combo = parseKeyCombo(binding);
    if (combo === '') throw new Error(`openalgo-charts widget: "${binding}" is not a key binding`);
    const entry: KeyBinding = {
      id: this._nextId++,
      combo,
      scope,
      label: opts.label ?? formatKeyCombo(combo, this._isMac),
      group: opts.group ?? 'Widget',
      hidden: opts.hidden === true,
      inText: opts.inText === true,
      layered: opts.layered === true,
      action,
      when: opts.when,
    };
    const list = this._byCombo.get(combo) ?? [];
    if (opts.layered !== true) {
      const prior = list.find((b) => b.scope === scope);
      if (prior !== undefined) this._conflict({ combo, scope, kept: prior.label, shadowed: entry.label, source: 'widget' });
    }
    list.push(entry);
    this._byCombo.set(combo, list);
    this._bindings.push(entry);
    return () => this._unregister(entry);
  }

  private _unregister(entry: KeyBinding): void {
    const i = this._bindings.indexOf(entry);
    if (i >= 0) this._bindings.splice(i, 1);
    const list = this._byCombo.get(entry.combo);
    if (list !== undefined) {
      const j = list.indexOf(entry);
      if (j >= 0) list.splice(j, 1);
      if (list.length === 0) this._byCombo.delete(entry.combo);
    }
    for (let k = this._conflicts.length - 1; k >= 0; k--) {
      const c = this._conflicts[k];
      if (c.source === 'widget' && c.combo === entry.combo && (c.kept === entry.label || c.shadowed === entry.label)) {
        this._conflicts.splice(k, 1);
      }
    }
  }

  private _conflict(c: KeyConflict): void {
    this._conflicts.push(c);
    for (const fn of this._conflictListeners) fn(c);
  }

  /** Be told when a registration collides with an earlier one. */
  public onConflict(fn: (c: KeyConflict) => void): () => void {
    this._conflictListeners.add(fn);
    return () => this._conflictListeners.delete(fn);
  }

  /**
   * Resolve and run the binding for an event. True when a binding claimed it,
   * in which case the event has been prevented and stopped.
   */
  public handle(e: KeyEventLike): boolean {
    const combo = eventKeyCombo(e);
    if (combo === '') return false;
    const list = this._byCombo.get(combo);
    if (list === undefined) return false;
    const typing = inTextField(e.target);
    for (const scope of this._scopes()) {
      for (const b of list) {
        if (b.scope !== scope) continue;
        if (typing && !b.inText) continue;
        if (b.when !== undefined && !b.when()) continue;
        if (b.action(e) === false) continue;
        e.preventDefault?.();
        e.stopPropagation?.();
        return true;
      }
    }
    return false;
  }

  /**
   * Listen on `target` in the capture phase, so a claimed chord never reaches
   * the engine's own listener on the document. Returns the detacher; a second
   * call replaces the first.
   */
  public attach(target: { addEventListener(t: string, fn: EventListener, opts?: boolean): void; removeEventListener(t: string, fn: EventListener, opts?: boolean): void }): () => void {
    this._detach?.();
    const fn = ((e: Event) => { this.handle(e as unknown as KeyEventLike); }) as EventListener;
    target.addEventListener('keydown', fn, true);
    this._detach = () => { target.removeEventListener('keydown', fn, true); this._detach = null; };
    return this._detach;
  }

  public list(): readonly KeyBinding[] { return this._bindings.slice(); }

  /** Every collision recorded so far: widget against widget, and widget against the engine's keymap. */
  public conflicts(): readonly KeyConflict[] {
    const out = this._conflicts.slice();
    if (this._chart !== null) {
      for (const item of this._chart.list()) {
        if (item.isDisabled) continue;
        for (const raw of item.combos) {
          const combo = fromChartCombo(raw);
          const claim = (this._byCombo.get(combo) ?? []).find((b) => b.scope !== 'overlay' && b.scope !== 'rail' && !b.layered);
          if (claim !== undefined) out.push({ combo, scope: claim.scope, kept: claim.label, shadowed: item.label, source: 'chart' });
        }
      }
    }
    return out;
  }

  public format(combo: string): string { return formatKeyCombo(combo, this._isMac); }

  /**
   * The bindings as the shortcuts panel shows them: the widget's own groups,
   * then the engine's chart commands, with any chord the widget claims first
   * marked as shadowed.
   */
  public describe(): KeymapGroup[] {
    const groups = new Map<string, { label: string; combo: string; display: string; shadowedBy?: string }[]>();
    for (const b of this._bindings) {
      if (b.hidden) continue;
      const rows = groups.get(b.group) ?? [];
      rows.push({ label: b.label, combo: b.combo, display: this.format(b.combo) });
      groups.set(b.group, rows);
    }
    const out: KeymapGroup[] = Array.from(groups, ([group, rows]) => ({ group, rows }));
    if (this._chart !== null) {
      const shadow = new Map<string, string>();
      for (const c of this.conflicts()) if (c.source === 'chart') shadow.set(c.shadowed + '|' + c.combo, c.kept);
      const rows: { label: string; combo: string; display: string; shadowedBy?: string }[] = [];
      for (const item of this._chart.list()) {
        if (item.isDisabled || item.combos.length === 0) continue;
        const combo = fromChartCombo(item.combos[0]);
        const row: { label: string; combo: string; display: string; shadowedBy?: string } = { label: item.label, combo, display: this.format(combo) };
        const by = shadow.get(item.label + '|' + combo);
        if (by !== undefined) row.shadowedBy = by;
        rows.push(row);
      }
      if (rows.length > 0) out.push({ group: 'Chart', rows });
    }
    return out;
  }

  public destroy(): void {
    this._detach?.();
    this._bindings.length = 0;
    this._byCombo.clear();
    this._conflicts.length = 0;
    this._conflictListeners.clear();
  }
}

/**
 * The shortcuts panel: every group from `keymap.describe()`, two columns,
 * closed by Escape or its button. Returns the closer.
 */
export function openShortcutsPanel(ctx: WidgetContext): () => void {
  const doc = ctx.document;
  const el = h(doc, 'div', 'oac-keys-dialog', { 'aria-label': 'Keyboard shortcuts' });
  const head = h(doc, 'div', 'oac-dialog__head');
  const title = h(doc, 'div', 'oac-dialog__title');
  title.textContent = 'Keyboard shortcuts';
  const x = h(doc, 'button', 'oac-btn oac-btn--icon', { type: 'button', 'aria-label': 'Close' });
  x.innerHTML = chromeIconSvg('close');
  head.appendChild(title);
  head.appendChild(x);
  const body = h(doc, 'div', 'oac-dialog__body');
  const cols = h(doc, 'div', 'oac-keys');
  let shadowed = 0;
  for (const g of ctx.keymap.describe()) {
    const box = h(doc, 'div', 'oac-keys__group');
    const gh = h(doc, 'div', 'oac-head');
    gh.textContent = g.group;
    box.appendChild(gh);
    for (const r of g.rows) {
      const row = h(doc, 'div', 'oac-keys__row');
      const label = h(doc, 'span');
      label.textContent = r.label;
      const kbd = h(doc, 'kbd');
      kbd.textContent = r.display;
      row.appendChild(label);
      row.appendChild(kbd);
      if (r.shadowedBy !== undefined) {
        row.classList.add('is-shadowed');
        row.title = `Claimed by ${r.shadowedBy}`;
        shadowed++;
      }
      box.appendChild(row);
    }
    cols.appendChild(box);
  }
  body.appendChild(cols);
  if (shadowed > 0) {
    const note = h(doc, 'div', 'oac-keys__note');
    note.textContent = `${shadowed} chart shortcut${shadowed === 1 ? '' : 's'} struck through: the same chord arms a drawing tool here and takes precedence.`;
    body.appendChild(note);
  }
  el.appendChild(head);
  el.appendChild(body);
  const close = ctx.openOverlay(el, { placement: 'center', dismissOnOutside: true });
  x.addEventListener('click', close);
  return close;
}
