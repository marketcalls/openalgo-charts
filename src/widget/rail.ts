/**
 * The drawing rail: the column of tool buttons down the left of the chart.
 *
 * Everything here routes through the controller's public API, and every glyph
 * comes from the draw tier's own registry: the sprite is injected once and
 * each button, flyout row and menu entry is a `<use>` into it, so the rail,
 * its flyouts and the armed cursor cannot drift apart.
 *
 * A group is one button standing for its last-used tool, with a chevron that
 * lists the rest. Favourites are pinned above the groups. The controls block
 * at the bottom carries the magnet mode, the stay toggle, lock, hide, delete,
 * undo and redo, each following the controller's state. Preferences (pins,
 * magnet, stay, each group's last pick) persist through the widget storage.
 */
import type { Chart } from 'openalgo-charts';
import {
  getDrawingTool, hasDrawingTool, drawingShortcuts,
  iconSprite, iconUse, chromeIconSvg, toolCursor, DRAWING_TOOL_ICONS,
  type MagnetMode,
} from 'openalgo-charts/draw';
import { h, glyph, TIP_DWELL_MS, type TipSpec, type WidgetContext } from './context';

export const MAGNET_MODES: readonly MagnetMode[] = ['off', 'weak', 'strong'];

export interface RailGroupItem { head?: string; tool?: string }
export interface RailGroup { id?: string; title?: string; items?: RailGroupItem[]; sep?: boolean }

/**
 * Rail groups. Only registered tools are shown, so a build that predates a
 * tool leaves a gap rather than a dead row. Names come from the descriptors,
 * not from here: the rail cannot spell a tool differently from the registry.
 */
export const RAIL_GROUPS: readonly RailGroup[] = [
  { id: 'lines', title: 'Lines', items: [
    { head: 'Lines' },
    { tool: 'trend-line' }, { tool: 'ray' }, { tool: 'extended-line' }, { tool: 'arrow' },
    { head: 'Horizontal and vertical' },
    { tool: 'horizontal-line' }, { tool: 'horizontal-ray' }, { tool: 'vertical-line' }, { tool: 'cross-line' },
  ] },
  { id: 'channels', title: 'Channels', items: [
    { head: 'Channels' },
    { tool: 'parallel-channel' }, { tool: 'fib-channel' },
  ] },
  { id: 'fib', title: 'Fibonacci and Gann', items: [
    { head: 'Fibonacci' },
    { tool: 'fib-retracement' }, { tool: 'fib-extension' }, { tool: 'fib-time-zone' }, { tool: 'fib-fan' },
    { head: 'Gann' },
    { tool: 'gann-fan' }, { tool: 'gann-box' },
  ] },
  { sep: true },
  { id: 'shapes', title: 'Shapes', items: [
    { head: 'Shapes' },
    { tool: 'rectangle' }, { tool: 'rotated-rectangle' }, { tool: 'ellipse' }, { tool: 'circle' }, { tool: 'triangle' },
    { head: 'Paths' },
    { tool: 'path' }, { tool: 'polyline' }, { tool: 'arc' }, { tool: 'curve' }, { tool: 'double-curve' },
  ] },
  { id: 'cycles', title: 'Cycles', items: [
    { head: 'Cycles' },
    { tool: 'cyclic-lines' }, { tool: 'time-cycles' }, { tool: 'sine-line' },
  ] },
  { id: 'marks', title: 'Arrows and marks', items: [
    { head: 'Arrows' },
    { tool: 'arrow-up' }, { tool: 'arrow-down' }, { tool: 'arrow-left' }, { tool: 'arrow-right' },
    { head: 'Marks' },
    { tool: 'flag-mark' }, { tool: 'price-label' }, { tool: 'signpost' },
  ] },
  { sep: true },
  { id: 'forecast', title: 'Forecasting', items: [
    { head: 'Forecasting' },
    { tool: 'long-position' }, { tool: 'short-position' }, { tool: 'forecast' },
  ] },
  { id: 'measure', title: 'Measurers', items: [
    { head: 'Measurers' },
    { tool: 'price-range' }, { tool: 'date-range' }, { tool: 'measure' },
  ] },
  { sep: true },
  { id: 'text', title: 'Text and notes', items: [
    { head: 'Text and notes' },
    { tool: 'text' }, { tool: 'note' }, { tool: 'callout' }, { tool: 'balloon' }, { tool: 'comment' },
    { tool: 'price-note' }, { tool: 'table' },
    { head: 'Brushes' },
    { tool: 'brush' }, { tool: 'highlighter' },
  ] },
];

/** A tool's display name from the registry, or the id itself for one the registry lacks. */
export const toolName = (id: string | null): string =>
  (id !== null && hasDrawingTool(id) ? getDrawingTool(id).name : String(id ?? 'Cursor'));

export interface RailPrefs {
  favorites: string[];
  magnet: MagnetMode;
  stay: boolean;
  /** Group id to the tool its button stands for. */
  last: Record<string, string>;
}

export interface RailOptions {
  /** Restrict the rail to these tool ids. Default: every registered tool the groups know. */
  tools?: readonly string[];
  /** Pins to start with when nothing is stored. */
  favorites?: readonly string[];
  /**
   * The element the armed tool's cursor goes on: the chart container. The
   * cursor rides a custom property the stylesheet reads, not the inline
   * cursor, which the engine owns for its own hover hints.
   */
  cursorTarget?: HTMLElement;
}

export interface RailHandle {
  readonly el: HTMLElement;
  /** Reflect the armed tool on the buttons. The controller's `draw:tool` event drives it; a host may call it too. */
  sync(tool: string | null): void;
  /** Re-read the controller for the controls block (selection, history). */
  refresh(): void;
  prefs(): RailPrefs;
  restorePrefs(prefs: unknown): void;
  magnetMode(): MagnetMode;
  setMagnetMode(mode: MagnetMode): void;
  /** off -> weak -> strong -> off. Returns the new mode. */
  cycleMagnet(): MagnetMode;
  stayMode(): boolean;
  setStayMode(on: boolean): void;
  favorites(): string[];
  isFavorite(id: string): boolean;
  toggleFavorite(id: string, on?: boolean): void;
  /** The double-click hold: one tool kept armed until something leaves it. */
  setDrawLock(on: boolean): void;
  drawLocked(): boolean;
  /** Open a group's flyout beside its button. */
  openGroup(groupId: string, viaKeyboard?: boolean): void;
  closeFlyout(): void;
  flyoutOpen(): boolean;
  destroy(): void;
}

/** Storage key the preferences live under. */
export const RAIL_PREFS_KEY = 'rail';

const SPRITE_ID = 'oac-rail-sprite';

/** The icon sprite, once per document, on the body so it outlives any one widget. */
function ensureSprite(doc: Document): void {
  if (doc.getElementById(SPRITE_ID) !== null) return;
  const w = doc.createElement('div');
  w.id = SPRITE_ID;
  w.hidden = true;
  w.innerHTML = iconSprite();
  (doc.body ?? doc.documentElement).appendChild(w);
}

/**
 * A tool's glyph as a `<use>` into the sprite. A tool the tier has no glyph
 * for (a host-registered one) gets its initial instead of a throw, so one
 * custom tool cannot blank the rail.
 */
export function toolGlyph(doc: Document, id: string): HTMLElement {
  if (DRAWING_TOOL_ICONS[id] !== undefined) return glyph(doc, iconUse(id), 'tool');
  const span = h(doc, 'span', 'oac-glyph oac-glyph--text', { 'aria-hidden': 'true' });
  span.textContent = String(id).charAt(0).toUpperCase();
  return span;
}

const chromeGlyph = (doc: Document, id: string): HTMLElement => glyph(doc, chromeIconSvg(id), 'chrome');

/** Validate a stored preference object field by field, dropping what this build cannot honour. */
export function sanitizeRailPrefs(raw: unknown, groups: readonly RailGroup[], toolsOf: (g: RailGroup) => string[]): RailPrefs {
  const out: RailPrefs = { favorites: [], magnet: 'off', stay: false, last: {} };
  if (raw === null || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.favorites)) {
    out.favorites = (r.favorites as unknown[]).filter((id, i, a): id is string =>
      typeof id === 'string' && hasDrawingTool(id) && a.indexOf(id) === i);
  }
  if (typeof r.magnet === 'string' && (MAGNET_MODES as readonly string[]).includes(r.magnet)) out.magnet = r.magnet as MagnetMode;
  out.stay = r.stay === true;
  if (r.last !== null && typeof r.last === 'object') {
    const last = r.last as Record<string, unknown>;
    for (const g of groups) {
      if (g.id !== undefined && typeof last[g.id] === 'string' && toolsOf(g).includes(last[g.id] as string)) out.last[g.id] = last[g.id] as string;
    }
  }
  return out;
}

interface Selectionish {
  selection(): readonly string[];
}

export function mountRail(ctx: WidgetContext, host: HTMLElement, opts: RailOptions = {}): RailHandle {
  const doc = ctx.document;
  const draw = ctx.draw;
  const chart: Chart = ctx.chart;
  ensureSprite(doc);

  const allowed = opts.tools === undefined ? null : new Set(opts.tools);
  const toolsOf = (g: RailGroup): string[] =>
    (g.items ?? []).filter((i) => i.tool !== undefined && hasDrawingTool(i.tool) && (allowed === null || allowed.has(i.tool)))
      .map((i) => i.tool as string);
  const groupById = (id: string): RailGroup | undefined => RAIL_GROUPS.find((g) => g.id === id);

  // ── preferences ──────────────────────────────────────────────────────
  let prefs = sanitizeRailPrefs(ctx.storage.get(RAIL_PREFS_KEY), RAIL_GROUPS, toolsOf);
  if (ctx.storage.get(RAIL_PREFS_KEY) === null && opts.favorites) {
    prefs.favorites = opts.favorites.filter((id, i, a) => hasDrawingTool(id) && a.indexOf(id) === i);
  }
  let latch = false;   // a double-click's hold on one tool
  const savePrefs = (): void => { ctx.storage.set(RAIL_PREFS_KEY, prefs); };
  const lastOf = (g: RailGroup): string | null => prefs.last[g.id ?? ''] ?? toolsOf(g)[0] ?? null;

  let chords: Record<string, string> | null = null;
  const chordOf = (id: string | null): string | undefined => {
    if (id === null) return undefined;
    if (chords === null) chords = drawingShortcuts();
    const c = chords[id];
    return c === undefined ? undefined : ctx.keymap.format(c);
  };

  // ── controller plumbing ──────────────────────────────────────────────
  const selectionOf = (): string[] => {
    const d = draw as unknown as Partial<Selectionish>;
    if (typeof d.selection === 'function') return d.selection().slice();
    const one = draw.selected();
    return one === null ? [] : [one];
  };
  const allLocked = (ids: readonly string[]): boolean => ids.length > 0 && ids.every((id) => draw.get(id)?.locked === true);
  const allHidden = (ids: readonly string[]): boolean => ids.length > 0 && ids.every((id) => draw.get(id)?.visible === false);

  const armCursor = (tool: string | null): void => {
    const target = opts.cursorTarget;
    if (!target) return;
    if (tool !== null && DRAWING_TOOL_ICONS[tool] !== undefined) target.style.setProperty('--oac-tool-cursor', toolCursor(tool));
    else target.style.removeProperty('--oac-tool-cursor');
  };

  const applyMagnet = (): void => { draw.setOptions({ magnet: prefs.magnet }); };
  const applyStay = (): void => { draw.setOptions({ stayInDrawingMode: prefs.stay || latch }); };

  const setMagnetMode = (mode: MagnetMode): void => {
    if (!MAGNET_MODES.includes(mode)) throw new Error(`openalgo-charts widget: unknown magnet mode "${String(mode)}"`);
    prefs.magnet = mode;
    savePrefs();
    applyMagnet();
    refreshControls();
  };
  const cycleMagnet = (): MagnetMode => {
    const next = MAGNET_MODES[(MAGNET_MODES.indexOf(prefs.magnet) + 1) % MAGNET_MODES.length];
    setMagnetMode(next);
    ctx.status(next === 'off' ? 'Magnet off'
      : next === 'weak' ? 'Magnet weak: snaps when O/H/L/C is within a few pixels'
      : 'Magnet strong: every anchor lands on the nearest O/H/L/C');
    return next;
  };
  const setStayMode = (on: boolean): void => {
    prefs.stay = on === true;
    savePrefs();
    applyStay();
    refreshControls();
    ctx.status(prefs.stay ? 'Tools stay armed after each drawing' : 'One drawing per pick');
  };
  const setDrawLock = (on: boolean): void => {
    latch = on === true;
    applyStay();
    sync(draw.activeTool());
  };

  const arm = (tool: string | null): void => {
    draw.setTool(tool);
    // The event drives sync; a controller that emits nothing still leaves the rail truthful.
    sync(tool);
  };
  const hold = (tool: string): void => {
    setDrawLock(true);
    arm(tool);
    ctx.status(`${toolName(tool)} stays armed until Escape`);
  };

  // ── building ─────────────────────────────────────────────────────────
  host.classList.add('oac-rail');
  host.setAttribute('role', 'toolbar');
  host.setAttribute('aria-orientation', 'vertical');
  host.setAttribute('aria-label', 'Drawing tools');

  interface BtnSpec {
    cls?: string;
    glyphEl: HTMLElement;
    tip: () => TipSpec | null;
    onClick: (e: MouseEvent) => void;
    onContext?: (e: MouseEvent) => void;
  }
  const makeBtn = (spec: BtnSpec): HTMLButtonElement => {
    const b = h(doc, 'button', 'oac-rail__btn' + (spec.cls ? ' ' + spec.cls : ''), { type: 'button' });
    b.tabIndex = -1;
    b.appendChild(spec.glyphEl);
    ctx.tips.attach(b, spec.tip, TIP_DWELL_MS);
    b.addEventListener('click', (e) => { if (!b.classList.contains('is-off')) spec.onClick(e as MouseEvent); });
    if (spec.onContext) {
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); spec.onContext?.(e as MouseEvent); });
    }
    return b;
  };
  const setGlyph = (b: HTMLElement, next: HTMLElement): void => {
    const cur = b.querySelector('.oac-glyph');
    if (cur) cur.replaceWith(next); else b.insertBefore(next, b.firstChild);
  };
  const sep = (): HTMLElement => h(doc, 'div', 'oac-rail__sep', { role: 'separator' });

  const cursorButton = (): HTMLButtonElement => {
    const b = makeBtn({
      cls: 'oac-rail__tool',
      glyphEl: toolGlyph(doc, 'cursor'),
      tip: () => ({ title: 'Cursor', chord: 'Esc', side: 'right' }),
      onClick: () => { setDrawLock(false); arm(null); },
    });
    b.dataset.tools = '';
    return b;
  };

  const favoriteButton = (id: string): HTMLButtonElement => {
    const b = makeBtn({
      cls: 'oac-rail__tool oac-rail__fav',
      glyphEl: toolGlyph(doc, id),
      tip: () => ({ title: toolName(id), chord: chordOf(id), sub: 'Pinned. Right-click to unpin', side: 'right' }),
      onClick: (e) => {
        if (e.detail >= 2 && !prefs.stay) { hold(id); return; }
        setDrawLock(false);
        arm(id);
      },
      onContext: () => openRailMenu(b, [{ label: 'Unpin from rail', icon: 'star', onSelect: () => toggleFavorite(id, false) }]),
    });
    b.dataset.tools = id;
    return b;
  };

  const groupButton = (g: RailGroup): HTMLButtonElement => {
    const tools = toolsOf(g);
    const b = makeBtn({
      cls: 'oac-rail__tool oac-rail__group',
      glyphEl: toolGlyph(doc, lastOf(g) ?? tools[0]),
      tip: () => ({
        title: toolName(lastOf(g)),
        chord: chordOf(lastOf(g)),
        sub: (g.title ?? '') + ': chevron for the rest' + (prefs.stay ? '' : '. Double-click keeps it armed'),
        side: 'right',
      }),
      onClick: (e) => {
        const target = e.target as HTMLElement | null;
        const onChevron = target !== null && typeof target.closest === 'function' && target.closest('.oac-rail__chev') !== null;
        if (fly !== null && b.getAttribute('aria-expanded') === 'true') { closeFlyout(); return; }
        if (onChevron) { openGroupFlyout(g, b, false); return; }
        if (e.detail >= 2 && !prefs.stay) { const t = lastOf(g); if (t !== null) hold(t); return; }
        // A click on a tool that is already armed is a request for the list:
        // arming it again would do nothing the user could see.
        if (draw.activeTool() === lastOf(g)) { openGroupFlyout(g, b, false); return; }
        setDrawLock(false);
        arm(lastOf(g));
      },
      onContext: () => openGroupFlyout(g, b, false),
    });
    b.dataset.tools = tools.join(',');
    b.dataset.group = g.id ?? '';
    b.dataset.face = lastOf(g) ?? '';
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    const chev = h(doc, 'span', 'oac-rail__chev', { 'aria-hidden': 'true' });
    chev.innerHTML = chromeIconSvg('chevron-right');
    b.appendChild(chev);
    return b;
  };

  // ── flyout ───────────────────────────────────────────────────────────
  let fly: { el: HTMLElement; close: () => void } | null = null;
  const closeFlyout = (): void => { fly?.close(); };

  const openGroupFlyout = (g: RailGroup, anchor: HTMLElement, viaKeyboard: boolean): void => {
    closeFlyout();
    ctx.tips.hide();
    const m = h(doc, 'div', 'oac-fly', { role: 'menu', 'aria-label': g.title ?? 'Tools' });
    const armed = draw.activeTool();
    const rows: HTMLElement[] = [];
    for (const it of g.items ?? []) {
      if (it.head !== undefined) {
        const head = h(doc, 'div', 'oac-head');
        head.textContent = it.head;
        m.appendChild(head);
        continue;
      }
      const tool = it.tool;
      if (tool === undefined || !hasDrawingTool(tool) || (allowed !== null && !allowed.has(tool))) continue;
      const row = h(doc, 'div', 'oac-fly__row', { role: 'menuitemradio', 'aria-checked': String(armed === tool) });
      row.tabIndex = -1;
      row.dataset.tool = tool;
      row.appendChild(toolGlyph(doc, tool));
      const name = h(doc, 'span', 'oac-fly__name');
      name.textContent = toolName(tool);
      row.appendChild(name);
      const pinned = isFavorite(tool);
      const star = h(doc, 'button', 'oac-fly__star', {
        type: 'button', 'aria-pressed': String(pinned), 'aria-label': pinned ? 'Unpin from rail' : 'Pin to rail',
      });
      star.tabIndex = -1;
      star.innerHTML = chromeIconSvg(pinned ? 'star-filled' : 'star');
      row.appendChild(star);
      const chord = h(doc, 'kbd', 'oac-fly__chord');
      chord.textContent = chordOf(tool) ?? '';
      row.appendChild(chord);
      const togglePin = (): void => {
        const on = !isFavorite(tool);
        toggleFavorite(tool, on);
        star.setAttribute('aria-pressed', String(on));
        star.setAttribute('aria-label', on ? 'Unpin from rail' : 'Pin to rail');
        star.innerHTML = chromeIconSvg(on ? 'star-filled' : 'star');
      };
      star.addEventListener('click', (e) => { e.stopPropagation(); togglePin(); });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        pick(tool);
      });
      row.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' || ke.key === ' ') {
          ke.preventDefault();
          ke.stopPropagation();
          if ((ke.target as HTMLElement).closest('.oac-fly__star') !== null) togglePin();
          else { pick(tool); anchor.focus(); }
        }
      });
      rows.push(row);
      m.appendChild(row);
    }
    const pick = (tool: string): void => {
      if (g.id !== undefined) { prefs.last[g.id] = tool; savePrefs(); }
      closeFlyout();
      setDrawLock(false);   // a pick from the list is one placement, like a single click
      arm(tool);
    };
    // Arrows walk the rows, ArrowRight reaches the row's star and ArrowLeft
    // comes back; Escape is the overlay stack's and returns focus to the button.
    m.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      const cur = (ke.target as HTMLElement).closest('.oac-fly__row') as HTMLElement | null;
      const at = cur === null ? -1 : rows.indexOf(cur);
      const go = (i: number): void => { rows[(i + rows.length) % rows.length]?.focus(); };
      switch (ke.key) {
        case 'ArrowDown': go(at + 1); break;
        case 'ArrowUp': go(at - 1); break;
        case 'Home': go(0); break;
        case 'End': go(rows.length - 1); break;
        case 'ArrowRight': (cur?.querySelector('.oac-fly__star') as HTMLElement | null)?.focus(); break;
        case 'ArrowLeft': cur?.focus(); break;
        default: return;
      }
      ke.preventDefault();
      ke.stopPropagation();
    });
    const first = rows.find((r) => r.getAttribute('aria-checked') === 'true') ?? rows[0] ?? null;
    const close = ctx.openOverlay(m, {
      anchor, placement: 'beside', edge: host,
      initialFocus: viaKeyboard ? first : m,
      onClose: () => { if (fly !== null && fly.el === m) fly = null; },
    });
    fly = { el: m, close };
  };

  // ── small context menu ───────────────────────────────────────────────
  interface MenuRow { label: string; icon?: string; tool?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  const openRailMenu = (anchor: HTMLElement, rows: MenuRow[]): void => {
    ctx.tips.hide();
    const m = h(doc, 'div', 'oac-menu', { role: 'menu' });
    let close: () => void = () => {};
    for (const r of rows) {
      const b = h(doc, 'button', 'oac-menu__row' + (r.danger ? ' is-danger' : ''), {
        type: 'button', role: 'menuitem', 'aria-disabled': String(r.disabled === true),
      });
      b.appendChild(r.tool !== undefined ? toolGlyph(doc, r.tool) : r.icon !== undefined ? chromeGlyph(doc, r.icon) : h(doc, 'span', 'oac-glyph'));
      const label = h(doc, 'span', 'oac-menu__label');
      label.textContent = r.label;
      b.appendChild(label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (r.disabled) return;
        close();
        r.onSelect();
      });
      m.appendChild(b);
    }
    close = ctx.openOverlay(m, { anchor, placement: 'beside', edge: host });
  };

  // ── controls block ───────────────────────────────────────────────────
  const ctl: Record<string, HTMLButtonElement> = {};
  const controlsBlock = (): HTMLElement => {
    const box = h(doc, 'div', 'oac-rail__ctl');
    ctl.magnet = makeBtn({
      cls: 'oac-rail__btn--magnet',
      glyphEl: toolGlyph(doc, 'magnet'),
      tip: () => ({
        title: 'Magnet: ' + prefs.magnet,
        sub: prefs.magnet === 'off' ? 'Click for weak: snaps when O/H/L/C is within a few pixels'
          : prefs.magnet === 'weak' ? 'Click for strong: every anchor lands on the nearest O/H/L/C'
          : 'Click to switch the magnet off',
        side: 'right',
      }),
      onClick: () => { cycleMagnet(); },
    });
    box.appendChild(ctl.magnet);
    ctl.stay = makeBtn({
      cls: 'oac-rail__btn--chrome',
      glyphEl: chromeGlyph(doc, 'link'),
      tip: () => ({
        title: 'Keep tool armed',
        sub: prefs.stay ? 'On: the tool stays armed after each drawing' : 'Off: one drawing per pick',
        side: 'right',
      }),
      onClick: () => setStayMode(!prefs.stay),
    });
    box.appendChild(ctl.stay);
    box.appendChild(sep());
    ctl.lock = makeBtn({
      cls: 'oac-rail__btn--chrome',
      glyphEl: chromeGlyph(doc, 'lock'),
      tip: () => {
        const sel = selectionOf();
        if (sel.length === 0) return { title: 'Lock drawing', sub: 'Select a drawing first', side: 'right' };
        return { title: allLocked(sel) ? 'Unlock drawing' : 'Lock drawing', side: 'right' };
      },
      onClick: () => {
        const sel = selectionOf();
        const locked = !allLocked(sel);
        for (const id of sel) draw.update(id, { locked });
        refreshControls();
      },
    });
    box.appendChild(ctl.lock);
    ctl.eye = makeBtn({
      cls: 'oac-rail__btn--chrome',
      glyphEl: chromeGlyph(doc, 'eye'),
      tip: () => {
        const sel = selectionOf();
        if (sel.length === 0) return { title: 'Hide drawing', sub: 'Select a drawing first', side: 'right' };
        return allHidden(sel)
          ? { title: 'Show drawing', side: 'right' }
          : { title: 'Hide drawing', sub: 'Stays selected, so the eye brings it back', side: 'right' };
      },
      onClick: () => {
        const sel = selectionOf();
        const visible = allHidden(sel);
        for (const id of sel) draw.update(id, { visible });
        refreshControls();
      },
    });
    box.appendChild(ctl.eye);
    ctl.trash = makeBtn({
      cls: 'oac-rail__btn--chrome oac-rail__btn--danger',
      glyphEl: chromeGlyph(doc, 'trash'),
      tip: () => {
        const sel = selectionOf();
        return sel.length > 0
          ? { title: sel.length > 1 ? `Delete ${sel.length} drawings` : 'Delete drawing', chord: 'Del', sub: 'Right-click to remove all', side: 'right' }
          : { title: 'Delete drawing', chord: 'Del', sub: 'Select one first. Right-click to remove all', side: 'right' };
      },
      onClick: () => {
        for (const id of selectionOf()) draw.remove(id);
        refreshControls();
      },
      onContext: () => {
        const n = draw.drawings().length;
        openRailMenu(ctl.trash, [
          { label: `Select all (${n})`, icon: 'cursor', disabled: n === 0, onSelect: () => {
            draw.select(draw.drawings().map((d) => d.id));
            refreshControls();
          } },
          { label: `Remove all drawings (${n})`, icon: 'trash', danger: true, disabled: n === 0, onSelect: () => {
            draw.clear();   // one undo step, so it is recoverable
            refreshControls();
            ctx.status(n > 0 ? `Removed ${n} drawing${n === 1 ? '' : 's'}` : 'No drawings to remove');
          } },
        ]);
      },
    });
    box.appendChild(ctl.trash);
    box.appendChild(sep());
    ctl.undo = makeBtn({
      cls: 'oac-rail__btn--chrome',
      glyphEl: chromeGlyph(doc, 'undo'),
      tip: () => ({ title: 'Undo', chord: ctx.keymap.format('Mod+Z'), side: 'right' }),
      onClick: () => { draw.undo(); refreshControls(); },
    });
    box.appendChild(ctl.undo);
    ctl.redo = makeBtn({
      cls: 'oac-rail__btn--chrome',
      glyphEl: chromeGlyph(doc, 'redo'),
      tip: () => ({ title: 'Redo', chord: ctx.keymap.format('Mod+Y'), side: 'right' }),
      onClick: () => { draw.redo(); refreshControls(); },
    });
    box.appendChild(ctl.redo);
    return box;
  };

  interface BtnState { on?: boolean; off?: boolean; glyph?: string; pressed?: boolean }
  const setState = (b: HTMLButtonElement | undefined, s: BtnState): void => {
    if (b === undefined) return;
    b.classList.toggle('is-on', s.on === true);
    b.classList.toggle('is-off', s.off === true);
    b.setAttribute('aria-disabled', s.off === true ? 'true' : 'false');
    if (s.pressed !== undefined) b.setAttribute('aria-pressed', String(s.pressed));
    if (s.glyph !== undefined && b.dataset.glyph !== s.glyph) {
      b.dataset.glyph = s.glyph;
      setGlyph(b, chromeGlyph(doc, s.glyph));
    }
  };

  /** The controls follow the controller: cheap class flips, no rebuild. */
  const refreshControls = (): void => {
    if (ctl.magnet === undefined) return;
    setState(ctl.magnet, { on: prefs.magnet === 'strong', pressed: prefs.magnet !== 'off' });
    ctl.magnet.classList.toggle('is-weak', prefs.magnet === 'weak');
    ctl.magnet.dataset.mode = prefs.magnet;
    setState(ctl.stay, { on: prefs.stay, pressed: prefs.stay });
    const sel = selectionOf();
    const none = sel.length === 0;
    const locked = !none && allLocked(sel);
    const hidden = !none && allHidden(sel);
    setState(ctl.lock, { off: none, on: locked, pressed: locked, glyph: locked ? 'unlock' : 'lock' });
    setState(ctl.eye, { off: none, on: hidden, pressed: hidden, glyph: hidden ? 'eye-off' : 'eye' });
    setState(ctl.trash, { off: none });
    setState(ctl.undo, { off: !draw.canUndo() });
    setState(ctl.redo, { off: !draw.canRedo() });
    // The accessible name says what the button would do now, not what it
    // said when it was built or last hovered.
    for (const b of Object.values(ctl)) ctx.tips.refreshLabel(b);
  };

  // ── favourites ───────────────────────────────────────────────────────
  let favWrap: HTMLElement | null = null;
  const favorites = (): string[] => prefs.favorites.slice();
  const isFavorite = (id: string): boolean => prefs.favorites.includes(id);
  const renderFavorites = (): void => {
    if (favWrap === null) return;
    favWrap.textContent = '';
    const favs = prefs.favorites.filter((id) => hasDrawingTool(id));
    if (favs.length === 0) return;
    favWrap.appendChild(sep());
    for (const id of favs) favWrap.appendChild(favoriteButton(id));
  };
  const toggleFavorite = (id: string, on: boolean = !isFavorite(id)): void => {
    if (!hasDrawingTool(id)) return;
    const has = isFavorite(id);
    if (on && !has) prefs.favorites.push(id);
    if (!on && has) prefs.favorites.splice(prefs.favorites.indexOf(id), 1);
    savePrefs();
    renderFavorites();
    sync(draw.activeTool());
  };

  // ── the rail itself ──────────────────────────────────────────────────
  const buttons = (): HTMLElement[] => Array.from(host.querySelectorAll('.oac-rail__btn')) as HTMLElement[];
  /** One tab stop for the whole rail: the arrow keys do the rest. */
  const setRoving = (target: HTMLElement): void => {
    for (const b of buttons()) b.tabIndex = b === target ? 0 : -1;
  };

  const build = (): void => {
    host.textContent = '';
    host.appendChild(cursorButton());
    favWrap = h(doc, 'div', 'oac-rail__favs');
    host.appendChild(favWrap);
    renderFavorites();
    host.appendChild(sep());
    for (const g of RAIL_GROUPS) {
      if (g.sep) { host.appendChild(sep()); continue; }
      if (toolsOf(g).length > 0) host.appendChild(groupButton(g));
    }
    host.appendChild(controlsBlock());
    sync(draw.activeTool());
  };

  const sync = (toolIn: string | null): void => {
    const tool = toolIn ?? null;
    let armed: HTMLElement | null = null;
    for (const b of Array.from(host.querySelectorAll('.oac-rail__tool')) as HTMLElement[]) {
      const tools = (b.dataset.tools ?? '').split(',').filter(Boolean);
      const on = tool === null ? tools.length === 0 : tools.includes(tool);
      b.classList.toggle('is-on', on);
      b.classList.toggle('is-held', on && latch && tools.length > 0);
      b.setAttribute('aria-pressed', String(on));
      if (on && armed === null) armed = b;
      // A group stands for whichever of its tools was armed last, however it
      // was armed: a chord or a restored layout counts as a pick.
      if (on && b.dataset.group && tools.length > 0 && tool !== null) {
        if (prefs.last[b.dataset.group] !== tool) { prefs.last[b.dataset.group] = tool; savePrefs(); }
        if (b.dataset.face !== tool) {
          b.dataset.face = tool;
          setGlyph(b, toolGlyph(doc, tool));
        }
      }
      ctx.tips.refreshLabel(b);
    }
    const active = doc.activeElement;
    if (armed !== null && !(active !== null && host.contains(active))) setRoving(armed);
    armCursor(tool);
    refreshControls();
  };

  // ── keyboard ─────────────────────────────────────────────────────────
  // Arrow keys walk the rail, ArrowRight opens a group, Escape hands focus
  // back to the chart. Registered in the rail scope, so they fire only while
  // a rail button has focus and never shadow the editing keys elsewhere.
  const current = (): HTMLElement | null => {
    const a = doc.activeElement as HTMLElement | null;
    return a !== null && host.contains(a) ? (a.closest('.oac-rail__btn') as HTMLElement | null) : null;
  };
  const go = (i: number): void => {
    const all = buttons();
    if (all.length === 0) return;
    const b = all[((i % all.length) + all.length) % all.length];
    setRoving(b);
    b.focus();
  };
  const unbind: Array<() => void> = [];
  const bind = (combo: string, fn: () => boolean | void, label: string): void => {
    unbind.push(ctx.keymap.register(combo, fn, 'rail', { label, group: 'Tool rail' }));
  };
  bind('ArrowDown', () => { go(buttons().indexOf(current() as HTMLElement) + 1); }, 'Next tool');
  bind('ArrowUp', () => { go(buttons().indexOf(current() as HTMLElement) - 1); }, 'Previous tool');
  bind('Home', () => { go(0); }, 'First tool');
  bind('End', () => { go(buttons().length - 1); }, 'Last tool');
  bind('ArrowRight', () => {
    const cur = current();
    const g = cur?.dataset.group ? groupById(cur.dataset.group) : undefined;
    if (cur === null || g === undefined) return false;
    openGroupFlyout(g, cur, true);
    return true;
  }, 'Open the group');
  bind('Escape', () => {
    const hadFlyout = fly !== null;
    closeFlyout();
    ctx.tips.hide();
    const chartEl = opts.cursorTarget;
    if (chartEl !== undefined && typeof chartEl.focus === 'function') chartEl.focus();
    else current()?.blur();
    // A click leaves focus on the button it armed, so with no flyout to close
    // the key is declined once focus has moved: the shell's Escape then
    // disarms the tool in the same press instead of asking for a second one.
    return hadFlyout;
  }, 'Back to the chart');
  const onFocusIn = (e: Event): void => {
    const t = e.target as HTMLElement | null;
    const b = t !== null && typeof t.closest === 'function' ? (t.closest('.oac-rail__btn') as HTMLElement | null) : null;
    if (b !== null) setRoving(b);
  };
  host.addEventListener('focusin', onFocusIn);

  // ── follow the controller ────────────────────────────────────────────
  const offs: Array<() => void> = [];
  offs.push(chart.on('draw:tool', (p) => { sync((p as { tool: string | null }).tool); }));
  for (const ev of ['draw:select', 'drawing:select', 'drawing:change', 'draw:add', 'draw:remove', 'draw:update', 'draw:paste', 'draw:cut']) {
    offs.push(chart.on(ev, refreshControls));
  }

  applyMagnet();
  applyStay();
  build();

  return {
    el: host,
    sync,
    refresh: refreshControls,
    prefs: () => ({ favorites: prefs.favorites.slice(), magnet: prefs.magnet, stay: prefs.stay, last: { ...prefs.last } }),
    restorePrefs: (raw) => {
      prefs = sanitizeRailPrefs(raw, RAIL_GROUPS, toolsOf);
      savePrefs();
      applyMagnet();
      applyStay();
      build();
    },
    magnetMode: () => prefs.magnet,
    setMagnetMode,
    cycleMagnet,
    stayMode: () => prefs.stay,
    setStayMode,
    favorites,
    isFavorite,
    toggleFavorite,
    setDrawLock,
    drawLocked: () => latch,
    openGroup: (groupId, viaKeyboard = false) => {
      const g = groupById(groupId);
      const b = host.querySelector(`.oac-rail__group[data-group="${groupId}"]`) as HTMLElement | null;
      if (g !== undefined && b !== null) openGroupFlyout(g, b, viaKeyboard);
    },
    closeFlyout,
    flyoutOpen: () => fly !== null,
    destroy: () => {
      closeFlyout();
      for (const off of offs) off();
      for (const u of unbind) u();
      host.removeEventListener('focusin', onFocusIn);
      armCursor(null);
      host.textContent = '';
    },
  };
}
