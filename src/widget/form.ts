/**
 * The one control renderer behind every generated dialog in the widget.
 *
 * Three schema vocabularies reach the widget: the chart-settings inputs
 * (`ChartSettingsInput`, which is `IndicatorInput` plus the paired colour
 * row), the indicator descriptors' own `IndicatorInput` lists, and the draw
 * tier's `SettingsField` dot paths. Each dialog would otherwise grow its own
 * switch over control kinds, and three switches drift: one forgets the
 * disabled state, another draws a colour as a 140px block. So the three are
 * folded into one `FormControl` shape here and drawn by one function, and the
 * rules in CLAUDE.md's UI standard are applied in exactly one place: a colour
 * is a small square swatch, a bullish/bearish pair is one row, a control with
 * a reason it cannot act is drawn disabled with its state still readable.
 *
 * DOM-building only. Nothing here knows what a key means or where a value is
 * written: the dialog hands in the values and gets `onChange(key, value)` back
 * with the value already in the type the schema declared.
 */
import { INDICATOR_SOURCES } from 'openalgo-charts';
import type { ChartSettingsInput } from 'openalgo-charts';
import { chromeIconSvg } from 'openalgo-charts/draw';
import type { SettingsField } from 'openalgo-charts/draw';
import type { OverlayOptions } from './context';

// ── the unified control model ─────────────────────────────────────────────

export type FormKind =
  | 'boolean' | 'number' | 'color' | 'text' | 'multiline' | 'select' | 'opacity' | 'colorPair' | 'custom';

/** One row of a generated form, whatever schema it came from. */
export interface FormControl {
  /** The flat key `onChange` reports. A `colorPair` reports its halves' keys instead. */
  key: string;
  kind: FormKind;
  label: string;
  /** Sub-heading the row sits under; consecutive rows with one group share a header. */
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  /** `select` only. Absent means free-form: the control becomes a text box. */
  options?: readonly { label: string; value: string }[];
  /** `colorPair` only: the switch (optional) and the two swatches. */
  pair?: {
    enabled?: { key: string };
    up: { key: string; label: string };
    down: { key: string; label: string };
  };
  /** `custom` only: what the dialog renders in the control column. */
  custom?: string;
}

export type FormValues = Readonly<Record<string, unknown>>;

export interface FormOptions {
  values: FormValues;
  /** Every edit, with the value in the control's declared type. */
  onChange(key: string, value: unknown): void;
  /**
   * Why a control, or one option of a select, cannot act right now, or null
   * when it can. Drawn disabled with the reason as its title, never hidden: a
   * greyed row is information, an absent one is a mystery.
   */
  unavailable?(key: string, option?: string): string | null;
  /** Prefix for element ids, so two forms in one document never share one. */
  idPrefix: string;
  /**
   * Emit colour and slider edits on `input` as well as `change`, for a dialog
   * that previews live. Off, a colour is one edit when the picker closes and a
   * slider one edit on release, which is what a per-edit undo history wants.
   */
  live?: boolean;
  /** Renders the control column of a `custom` row. Null skips the row. */
  custom?(control: FormControl, row: HTMLElement): HTMLElement | null;
}

export interface FormHandle {
  el: HTMLElement;
  /** Re-read `values` into every control the user is not currently in. */
  sync(values: FormValues): void;
  /** Every control's current value, keyed the way `onChange` reports it. */
  values(): Record<string, unknown>;
  /** Focus the first enabled control. */
  focusFirst(): boolean;
}

// ── converters from the three schema vocabularies ─────────────────────────

/**
 * Chart-settings and indicator inputs. `source` becomes a select over the
 * canonical price sources; a `colorPair` keeps its two or three keys.
 */
export function controlsFromInputs(inputs: readonly ChartSettingsInput[]): FormControl[] {
  const out: FormControl[] = [];
  for (const input of inputs) {
    switch (input.type) {
      case 'colorPair':
        out.push({
          key: input.key, kind: 'colorPair', label: input.label, group: input.group,
          pair: {
            enabled: input.enabled === undefined ? undefined : { key: input.enabled.key },
            up: { key: input.up.key, label: input.up.label },
            down: { key: input.down.key, label: input.down.label },
          },
        });
        break;
      case 'number':
        out.push({
          key: input.key, kind: 'number', label: input.label, group: input.group,
          min: input.min, max: input.max, step: input.step,
        });
        break;
      case 'select':
        out.push({ key: input.key, kind: 'select', label: input.label, group: input.group, options: input.options });
        break;
      case 'source':
        out.push({ key: input.key, kind: 'select', label: input.label, group: input.group, options: INDICATOR_SOURCES });
        break;
      case 'boolean':
      case 'color':
      case 'text':
        out.push({ key: input.key, kind: input.type, label: input.label, group: input.group });
        break;
    }
  }
  return out;
}

/** Our words for the draw tier's group ids. */
export const DRAWING_GROUP_LABELS: Readonly<Record<string, string>> = {
  line: 'Line', fill: 'Fill', text: 'Text', levels: 'Levels', behavior: 'Behavior',
};

/**
 * Draw-tier fields. `lineStyle` is a select with a fixed option list, an
 * `opacity` is a slider read in percent, `levels` is left to the dialog (the
 * level editor is its own surface), and the text tool's content is the one
 * multi-line box.
 */
export function controlsFromFields(fields: readonly SettingsField[]): FormControl[] {
  const out: FormControl[] = [];
  for (const f of fields) {
    const group = f.group === undefined ? undefined : (DRAWING_GROUP_LABELS[f.group] ?? f.group);
    const base = { key: f.path, label: f.label, group };
    switch (f.kind) {
      case 'color':
        out.push({ ...base, kind: 'color' });
        break;
      case 'number':
        out.push({ ...base, kind: 'number', min: f.min, max: f.max, step: f.step });
        break;
      case 'opacity':
        out.push({ ...base, kind: 'opacity' });
        break;
      case 'boolean':
        out.push({ ...base, kind: 'boolean' });
        break;
      case 'select':
      case 'lineStyle':
        out.push(f.options === undefined ? { ...base, kind: 'text' } : { ...base, kind: 'select', options: f.options });
        break;
      case 'text':
        out.push({ ...base, kind: f.path === 'text.value' ? 'multiline' : 'text' });
        break;
      case 'levels':
        out.push({ ...base, kind: 'custom', custom: 'levels' });
        break;
    }
  }
  return out;
}

// ── value helpers ─────────────────────────────────────────────────────────

/**
 * A six-digit hex an `<input type=color>` will take, from the forms a theme
 * or a drawing uses. Alpha is dropped: the picker has no channel for it, and
 * the swatch still has to show the colour the chart is drawing. Null for
 * anything else (a named colour), which the caller turns into a fallback.
 */
export function toHexColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex !== null) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) return '#' + h.slice(0, 3).split('').map((c) => c + c).join('').toLowerCase();
    if (h.length === 6 || h.length === 8) return '#' + h.slice(0, 6).toLowerCase();
    return null;
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i.exec(s);
  if (fn === null) return null;
  const part = (v: string): string => Math.round(Math.max(0, Math.min(255, Number(v)))).toString(16).padStart(2, '0');
  return `#${part(fn[1])}${part(fn[2])}${part(fn[3])}`;
}

/** Print a number without float noise: 1.5 stays 1.5, 2.0000000000000004 prints 2. */
export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

const DEFAULT_SWATCH = '#000000';

// ── small DOM kit shared by the dialogs ───────────────────────────────────

/** `doc.createElement` with the class and text most calls want. */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const XMLNS = 'http://www.w3.org/2000/svg';

/**
 * An inline glyph on the chrome grid for the few icons the tier does not
 * carry (a settings tab's picture). Same frame as `chromeIconSvg`, so the two
 * kinds sit side by side at one weight.
 */
export function glyphSvg(path: string): string {
  return `<svg xmlns="${XMLNS}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"`
    + ` stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}

/** A chrome glyph wrapped for the stylesheet's `.oac-glyph--chrome` sizing. */
export function chromeGlyph(doc: Document, id: string): HTMLElement {
  const span = el(doc, 'span', 'oac-glyph oac-glyph--chrome');
  span.innerHTML = chromeIconSvg(id);
  return span;
}

export type ButtonVariant = 'ghost' | 'primary' | 'danger';

export interface ButtonSpec {
  label: string;
  /** Chrome icon id. With `iconOnly` the label becomes the accessible name. */
  icon?: string;
  /** Inline SVG markup for a glyph the chrome set does not carry; used instead of `icon`. */
  svg?: string;
  iconOnly?: boolean;
  variant?: ButtonVariant;
  onClick?: (e: MouseEvent) => void;
  /** Chord hint for the title, as `Ctrl+D`. */
  chord?: string;
}

/** A flat `.oac-btn`. Icon-only buttons carry their label as `aria-label` and `title`. */
export function button(doc: Document, spec: ButtonSpec): HTMLButtonElement {
  const b = el(doc, 'button');
  b.type = 'button';
  const classes = ['oac-btn'];
  if (spec.iconOnly === true) classes.push('oac-btn--icon');
  if (spec.variant === 'primary') classes.push('oac-btn--primary');
  if (spec.variant === 'danger') classes.push('oac-btn--danger');
  b.className = classes.join(' ');
  if (spec.icon !== undefined) b.appendChild(chromeGlyph(doc, spec.icon));
  else if (spec.svg !== undefined) {
    const g = el(doc, 'span', 'oac-glyph oac-glyph--chrome');
    g.innerHTML = spec.svg;
    b.appendChild(g);
  }
  if (spec.iconOnly === true) {
    b.setAttribute('aria-label', spec.label);
    b.title = spec.chord === undefined ? spec.label : `${spec.label} (${spec.chord})`;
  } else {
    b.appendChild(doc.createTextNode(spec.label));
    if (spec.chord !== undefined) b.title = spec.chord;
  }
  if (spec.onClick !== undefined) {
    const onClick = spec.onClick;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e as MouseEvent); });
  }
  return b;
}

/** A select wrapped for the stylesheet's custom chevron. */
export function selectBox(doc: Document): { wrap: HTMLElement; select: HTMLSelectElement } {
  const wrap = el(doc, 'span', 'oac-select');
  const select = el(doc, 'select');
  wrap.appendChild(select);
  const chev = el(doc, 'span', 'oac-chev');
  chev.innerHTML = chromeIconSvg('chevron-down');
  wrap.appendChild(chev);
  return { wrap, select };
}

/**
 * Keys typed inside a dialog are the dialog's. The widget's chords (Delete
 * for a drawing, a letter arming a tool) live on the root and must not read a
 * Backspace in a number box as a delete. Escape and Tab still travel: the
 * shell's overlay stack owns closing and the focus trap.
 */
export function stopOwnKeys(node: HTMLElement): void {
  node.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k !== 'Escape' && k !== 'Tab') e.stopPropagation();
  });
  // A press inside a panel is never a pan on the chart underneath: the chart
  // captures the pointer on pointerdown, so the event has to stop here.
  node.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
}

// ── dialog furniture ──────────────────────────────────────────────────────

export interface DialogFrame {
  /** The card (`role="dialog"`), handed to `openOverlay` as is. */
  el: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  /** Left slot of the footer, for a secondary control. */
  lead: HTMLElement;
  /** Right slot of the footer; the confirming action goes last. */
  actions: HTMLElement;
  closeButton: HTMLButtonElement;
  setTitle(title: string): void;
}

export interface DialogFrameSpec {
  title: string;
  /** Extra class on the card. */
  className?: string;
  /** The close affordance top right. Escape and the scrim are the overlay stack's. */
  onClose(): void;
}

let frameSeq = 0;

/**
 * The furniture every dialog shares: title left, close top right, a
 * scrolling body, and a footer with a lead slot on the left and the actions
 * on the right. The card is `.oac-panel`; the overlay stack adds `.oac-dialog`
 * (centred, over a scrim) or `.oac-pop` (anchored) when it opens the card,
 * so one frame serves a modal and a popover.
 */
export function dialogFrame(doc: Document, spec: DialogFrameSpec): DialogFrame {
  const card = el(doc, 'div', 'oac-panel' + (spec.className === undefined ? '' : ' ' + spec.className));
  card.setAttribute('role', 'dialog');
  card.tabIndex = -1;
  const titleId = `oac-dlg-title-${++frameSeq}`;
  card.setAttribute('aria-labelledby', titleId);

  const head = el(doc, 'div', 'oac-dialog__head');
  const title = el(doc, 'span', 'oac-dialog__title', spec.title);
  title.id = titleId;
  const closeButton = button(doc, { label: 'Close', icon: 'close', iconOnly: true, onClick: () => spec.onClose() });
  head.appendChild(title);
  head.appendChild(closeButton);

  const body = el(doc, 'div', 'oac-dialog__body');
  const foot = el(doc, 'div', 'oac-dialog__foot');
  const lead = el(doc, 'div', 'oac-dialog__lead');
  const spacer = el(doc, 'div', 'oac-spacer');
  const actions = el(doc, 'div', 'oac-dialog__actions');
  foot.appendChild(lead);
  foot.appendChild(spacer);
  foot.appendChild(actions);

  card.appendChild(head);
  card.appendChild(body);
  card.appendChild(foot);
  stopOwnKeys(card);

  return {
    el: card, head, body, foot, lead, actions, closeButton,
    setTitle: (t) => { title.textContent = t; },
  };
}

// ── the overlay session ───────────────────────────────────────────────────

/** What every mount function returns: the shell's `DialogHandle` plus the node and a liveness probe. */
export interface PanelHandle {
  el: HTMLElement;
  close(): void;
  isOpen(): boolean;
}

/** The slice of the widget context a panel needs to show itself. */
export interface PanelHost {
  openOverlay(el: HTMLElement, opts?: OverlayOptions): () => void;
}

/**
 * Put `panel` on the shell's overlay stack and return the handle.
 *
 * The stack owns focus, Escape, the outside press and the node's removal, and
 * reports each through `onClose`; the dialog owns what closing means (a
 * settings dialog reverts, a text editor cancels). The two meet here so that
 * whichever side closes first, the other runs exactly once: a dialog closing
 * itself must not have the stack call it back into a second close, and the
 * stack closing the dialog must not have the dialog ask the stack again.
 */
export function openPanel(host: PanelHost, panel: HTMLElement, opts: OverlayOptions, onDismiss: () => void): PanelHandle {
  let closed = false;
  let byShell = false;
  const closer = host.openOverlay(panel, {
    ...opts,
    onClose: () => {
      opts.onClose?.();
      if (closed) return;
      byShell = true;
      onDismiss();
      finish();
    },
  });
  function finish(): void {
    if (closed) return;
    closed = true;
    if (!byShell) closer();
    panel.remove();
  }
  return { el: panel, close: finish, isOpen: () => !closed };
}

/** An element's box in root coordinates, for placing a panel by hand. */
export function boxInRoot(root: HTMLElement, node: Element): { left: number; top: number; right: number; bottom: number } {
  const r = root.getBoundingClientRect();
  const b = node.getBoundingClientRect();
  return { left: b.left - r.left, top: b.top - r.top, right: b.right - r.left, bottom: b.bottom - r.top };
}

/** The slice of a chart a popover needs to sit beside a drawing. */
export interface AnchorChart {
  timeToCoordinate(time: number): number;
  priceToCoordinate(price: number, paneIndex?: number): number | null;
  panes(): ReadonlyArray<{ element: HTMLElement }>;
}

/**
 * Where a popover about `drawings` goes, in root px: just below the lowest
 * anchor of the selection, or a little way in from the corner when no anchor
 * is on screen. Chart coordinates are container-relative, and the container
 * sits to the right of the rail, so its offset inside the root is added.
 */
export function selectionPoint(
  root: HTMLElement, chart: AnchorChart, drawings: ReadonlyArray<{ paneIndex: number; points: ReadonlyArray<{ time: number; price: number }> }>,
): { x: number; y: number } {
  const container = chart.panes()[0]?.element.parentElement ?? null;
  const off = container === null ? { left: 0, top: 0 } : boxInRoot(root, container);
  let x0 = Infinity;
  let y1 = -Infinity;
  for (const d of drawings) {
    for (const p of d.points) {
      const cx = chart.timeToCoordinate(p.time);
      const cy = chart.priceToCoordinate(p.price, d.paneIndex);
      if (!Number.isFinite(cx) || cy === null || !Number.isFinite(cy)) continue;
      x0 = Math.min(x0, cx);
      y1 = Math.max(y1, cy);
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y1)) return { x: off.left + 60, y: off.top + 60 };
  return { x: off.left + x0, y: off.top + y1 + 12 };
}

export interface TabSpec {
  id: string;
  label: string;
  /** Inline SVG markup for the glyph beside the label. */
  icon?: string;
}

export interface TabListHandle {
  el: HTMLElement;
  /** Mark `id` as the selected tab. The buttons stay put, so a focused one keeps its focus. */
  setActive(id: string): void;
}

/**
 * A tab list, as a vertical rail (`rail`) or a row. Every tab carries its
 * glyph, per the UI standard; `onPick` runs on click and on arrow keys, and
 * the list marks the pick itself.
 */
export function tabList(
  doc: Document, tabs: readonly TabSpec[], active: string, layout: 'rail' | 'row', onPick: (id: string) => void,
): TabListHandle {
  const nav = el(doc, 'div', `oac-tabs oac-tabs--${layout}`);
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-orientation', layout === 'rail' ? 'vertical' : 'horizontal');
  const buttons: HTMLButtonElement[] = [];
  const setActive = (id: string): void => {
    tabs.forEach((t, i) => {
      const on = t.id === id;
      buttons[i].setAttribute('aria-selected', on ? 'true' : 'false');
      buttons[i].tabIndex = on ? 0 : -1;
    });
  };
  const pick = (id: string): void => { setActive(id); onPick(id); };
  tabs.forEach((t, i) => {
    const b = el(doc, 'button', 'oac-tab');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.tab = t.id;
    if (t.icon !== undefined) {
      const g = el(doc, 'span', 'oac-glyph oac-glyph--chrome');
      g.innerHTML = t.icon;
      b.appendChild(g);
    }
    b.appendChild(el(doc, 'span', 'oac-tab__label', t.label));
    b.addEventListener('click', (e) => { e.stopPropagation(); pick(t.id); });
    b.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      const fwd = layout === 'rail' ? 'ArrowDown' : 'ArrowRight';
      const back = layout === 'rail' ? 'ArrowUp' : 'ArrowLeft';
      let next = -1;
      if (k === fwd) next = (i + 1) % tabs.length;
      else if (k === back) next = (i - 1 + tabs.length) % tabs.length;
      else if (k === 'Home') next = 0;
      else if (k === 'End') next = tabs.length - 1;
      if (next < 0) return;
      e.preventDefault();
      buttons[next].focus();
      pick(tabs[next].id);
    });
    buttons.push(b);
    nav.appendChild(b);
  });
  setActive(active);
  return { el: nav, setActive };
}

// ── placement ─────────────────────────────────────────────────────────────

export interface PlaceAt {
  /** Below this control, left edges aligned; above it when the bottom has no room. */
  anchor?: HTMLElement;
  /** At this point, in root px (a context menu at the pointer). */
  point?: { x: number; y: number };
}

/**
 * Position an absolutely placed panel inside `root`. Measured after the
 * panel is in the document, so it has a size; clamped so it never runs past
 * the widget's edge, which on a right-hand price axis is the usual case.
 */
export function placePanel(root: HTMLElement, panel: HTMLElement, at: PlaceAt): void {
  const rr = root.getBoundingClientRect();
  const w = panel.offsetWidth || 200;
  const h = panel.offsetHeight || 100;
  const pad = 4;
  let x = pad;
  let y = pad;
  if (at.anchor !== undefined) {
    const ar = at.anchor.getBoundingClientRect();
    x = ar.left - rr.left;
    y = ar.bottom - rr.top + 6;
    if (y + h > rr.height - pad) y = Math.max(pad, ar.top - rr.top - h - 6);
  } else if (at.point !== undefined) {
    x = at.point.x;
    y = at.point.y;
    if (y + h > rr.height - pad) y = Math.max(pad, rr.height - h - pad);
  }
  x = Math.max(pad, Math.min(x, rr.width - w - pad));
  y = Math.max(pad, Math.min(y, rr.height - h - pad));
  panel.style.left = `${Math.round(x)}px`;
  panel.style.top = `${Math.round(y)}px`;
}

// ── the renderer ──────────────────────────────────────────────────────────

interface Bound {
  key: string;
  read(): unknown;
  /** Show `value`; `undefined` shows the control's empty state. */
  write(value: unknown): void;
  control: HTMLElement;
}

/**
 * Render `controls` into `host` (emptied first). Rows sit under small
 * uppercase group headers; a boolean sits in the switch column in front of its
 * label; everything else sits in the control column on the right.
 */
export function renderForm(host: HTMLElement, controls: readonly FormControl[], opts: FormOptions): FormHandle {
  const doc = host.ownerDocument;
  host.innerHTML = '';
  host.classList.add('oac-form');
  const bound: Bound[] = [];
  const unavailable = opts.unavailable ?? ((): null => null);
  const idFor = (key: string): string => `${opts.idPrefix}-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  // The last value each control reported, so a `change` after a live `input`
  // of the same value is not a second edit.
  const last = new Map<string, unknown>();
  const emit = (key: string, value: unknown): void => {
    if (last.has(key) && Object.is(last.get(key), value)) return;
    last.set(key, value);
    opts.onChange(key, value);
  };

  const disable = (ctl: HTMLElement, why: string | null): void => {
    if (why === null) return;
    (ctl as HTMLInputElement).disabled = true;
    ctl.title = why;
  };

  /** One input of the kinds a single value covers. */
  function field(key: string, kind: FormKind, spec: FormControl, value: unknown): { ctl: HTMLElement; b: Bound } {
    const why = unavailable(key);
    let ctl: HTMLElement;
    let b: Bound;
    switch (kind) {
      case 'boolean': {
        const input = el(doc, 'input');
        input.type = 'checkbox';
        input.checked = value === true;
        input.addEventListener('change', () => emit(key, input.checked));
        ctl = input;
        b = { key, control: input, read: () => input.checked, write: (v) => { input.checked = v === true; } };
        break;
      }
      case 'number': {
        const input = el(doc, 'input', 'oac-input--num');
        input.type = 'number';
        if (spec.min !== undefined) input.min = String(spec.min);
        if (spec.max !== undefined) input.max = String(spec.max);
        if (spec.step !== undefined) input.step = String(spec.step);
        const show = (v: unknown): void => { input.value = typeof v === 'number' && Number.isFinite(v) ? formatNumber(v) : ''; };
        show(value);
        input.addEventListener('change', () => {
          const raw = input.value.trim();
          const n = raw === '' ? NaN : Number(raw);
          // A blank or unparseable box is not an edit; the last good value comes back.
          if (!Number.isFinite(n)) { show(last.has(key) ? last.get(key) : value); return; }
          const lo = spec.min ?? -Infinity;
          const hi = spec.max ?? Infinity;
          const clamped = Math.min(hi, Math.max(lo, n));
          if (clamped !== n) show(clamped);
          emit(key, clamped);
        });
        ctl = input;
        b = {
          key, control: input,
          read: () => { const n = Number(input.value); return input.value.trim() === '' || !Number.isFinite(n) ? undefined : n; },
          write: show,
        };
        break;
      }
      case 'color': {
        const input = el(doc, 'input', 'oac-swatch-input');
        input.type = 'color';
        const show = (v: unknown): void => { input.value = toHexColor(v) ?? DEFAULT_SWATCH; };
        show(value);
        input.addEventListener('change', () => emit(key, input.value));
        if (opts.live === true) input.addEventListener('input', () => emit(key, input.value));
        ctl = input;
        b = { key, control: input, read: () => input.value, write: show };
        break;
      }
      case 'opacity': {
        const range = el(doc, 'input', 'oac-range');
        range.type = 'range';
        range.min = '0'; range.max = '100'; range.step = '1';
        const out = el(doc, 'output', 'oac-out');
        const pct = (v: unknown): number => Math.round((typeof v === 'number' ? Math.min(1, Math.max(0, v)) : 0) * 100);
        const show = (v: unknown): void => { range.value = String(pct(v)); out.textContent = `${pct(v)}%`; };
        show(value);
        range.addEventListener('input', () => {
          out.textContent = `${range.value}%`;
          if (opts.live === true) emit(key, Number(range.value) / 100);
        });
        range.addEventListener('change', () => emit(key, Number(range.value) / 100));
        const wrap = el(doc, 'span', 'oac-opacity');
        wrap.appendChild(range);
        wrap.appendChild(out);
        disable(range, why);
        ctl = wrap;
        b = { key, control: range, read: () => Number(range.value) / 100, write: show };
        return { ctl, b };
      }
      case 'select': {
        const { wrap, select } = selectBox(doc);
        const options = spec.options ?? [];
        const fill = (v: unknown): void => {
          select.innerHTML = '';
          const list = options.slice();
          const cur = typeof v === 'string' ? v : v === undefined ? undefined : String(v);
          // A value outside the list (a font stack the user typed) stays
          // selectable as its own entry rather than snapping to the first.
          if (cur !== undefined && cur !== '' && !list.some((o) => o.value === cur)) list.push({ value: cur, label: 'Custom' });
          for (const o of list) {
            const opt = el(doc, 'option', undefined, o.label);
            opt.value = o.value;
            const reason = unavailable(key, o.value);
            if (reason !== null) { opt.disabled = true; opt.title = reason; }
            select.appendChild(opt);
          }
          select.value = cur === undefined || cur === '' ? (list[0]?.value ?? '') : cur;
        };
        fill(value);
        select.addEventListener('change', () => emit(key, select.value));
        disable(select, why);
        ctl = wrap;
        b = { key, control: select, read: () => select.value, write: fill };
        return { ctl, b };
      }
      case 'multiline': {
        const area = el(doc, 'textarea', 'oac-input--multi');
        area.rows = 3;
        area.setAttribute('spellcheck', 'false');
        const show = (v: unknown): void => { area.value = v === undefined || v === null ? '' : String(v); };
        show(value);
        area.addEventListener('change', () => emit(key, area.value));
        ctl = area;
        b = { key, control: area, read: () => area.value, write: show };
        break;
      }
      case 'text':
      default: {
        const input = el(doc, 'input');
        input.type = 'text';
        input.setAttribute('spellcheck', 'false');
        const show = (v: unknown): void => { input.value = v === undefined || v === null ? '' : String(v); };
        show(value);
        input.addEventListener('change', () => emit(key, input.value));
        ctl = input;
        b = { key, control: input, read: () => input.value, write: show };
        break;
      }
    }
    disable(ctl, why);
    return { ctl, b };
  }

  let lastGroup: string | undefined;
  for (const c of controls) {
    if (c.group !== undefined && c.group !== lastGroup) {
      host.appendChild(el(doc, 'div', 'oac-head', c.group));
    }
    lastGroup = c.group ?? lastGroup;

    const row = el(doc, 'div', 'oac-row');
    row.dataset.key = c.key;
    const label = el(doc, 'label', 'oac-row__label', c.label);

    if (c.kind === 'custom') {
      const body = opts.custom === undefined ? null : opts.custom(c, row);
      if (body === null) continue;
      row.appendChild(el(doc, 'span', 'oac-row__sw'));
      row.appendChild(label);
      const ctl = el(doc, 'div', 'oac-row__ctl');
      ctl.appendChild(body);
      row.appendChild(ctl);
      host.appendChild(row);
      continue;
    }

    if (c.kind === 'colorPair' && c.pair !== undefined) {
      const pair = c.pair;
      const whyUp = unavailable(pair.up.key);
      const whyDown = unavailable(pair.down.key);
      // Inert only when both halves are: one live half keeps the row live and
      // dims the swatch with nothing to paint.
      if (whyUp !== null && whyDown !== null) { row.classList.add('oac-row--off'); row.title = whyUp; }
      if (pair.enabled !== undefined) {
        const sw = field(pair.enabled.key, 'boolean', c, opts.values[pair.enabled.key]);
        sw.ctl.classList.add('oac-row__sw');
        sw.ctl.id = idFor(pair.enabled.key);
        label.htmlFor = sw.ctl.id;
        bound.push(sw.b);
        row.appendChild(sw.ctl);
      } else {
        row.appendChild(el(doc, 'span', 'oac-row__sw'));
      }
      row.appendChild(label);
      const ctl = el(doc, 'div', 'oac-row__ctl');
      for (const half of [pair.up, pair.down]) {
        const f = field(half.key, 'color', c, opts.values[half.key]);
        f.ctl.id = idFor(half.key);
        // Which swatch is which is not obvious at 26px, and the row is too
        // tight for two more labels, so the name rides on the control.
        f.ctl.title = (f.ctl as HTMLInputElement).disabled ? `${half.label}: ${f.ctl.title}` : half.label;
        f.ctl.setAttribute('aria-label', `${c.label} ${half.label}`);
        bound.push(f.b);
        ctl.appendChild(f.ctl);
      }
      if (pair.enabled === undefined) label.htmlFor = idFor(pair.up.key);
      row.appendChild(ctl);
      host.appendChild(row);
      continue;
    }

    const f = field(c.key, c.kind, c, opts.values[c.key]);
    const why = unavailable(c.key);
    if (why !== null) { row.classList.add('oac-row--off'); row.title = why; }
    f.b.control.id = idFor(c.key);
    label.htmlFor = f.b.control.id;
    bound.push(f.b);
    if (c.kind === 'boolean') {
      f.ctl.classList.add('oac-row__sw');
      row.appendChild(f.ctl);
      row.appendChild(label);
    } else if (c.kind === 'multiline') {
      row.classList.add('oac-row--block');
      row.appendChild(label);
      row.appendChild(f.ctl);
    } else {
      row.appendChild(el(doc, 'span', 'oac-row__sw'));
      row.appendChild(label);
      const ctl = el(doc, 'div', 'oac-row__ctl');
      ctl.appendChild(f.ctl);
      row.appendChild(ctl);
    }
    host.appendChild(row);
  }

  return {
    el: host,
    sync: (values) => {
      const active = doc.activeElement;
      for (const b of bound) {
        if (b.control === active) continue;
        if (!(b.key in values)) continue;
        b.write(values[b.key]);
      }
    },
    values: () => {
      const out: Record<string, unknown> = {};
      for (const b of bound) out[b.key] = b.read();
      return out;
    },
    focusFirst: () => {
      for (const b of bound) {
        if ((b.control as HTMLInputElement).disabled) continue;
        b.control.focus();
        return true;
      }
      return false;
    },
  };
}
