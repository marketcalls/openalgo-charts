/**
 * The top bar: symbol, interval, chart type, indicators, settings, capture
 * and theme, left to right.
 *
 * Buttons and popup menus rather than native selects: a select cannot group,
 * cannot carry a chord and looks like a form control on a chart. The
 * interval pills come from the list the shell resolves (its own defaults
 * plus every code registered with the engine); the chart type menu is read
 * from the chart-type registry at open time, so a type the transform tier
 * registers appears without a second list to keep in step. The indicators
 * and settings buttons open the dialog tier's panels; without one registered
 * they render disabled, with their state visible, rather than dead.
 */
import { registeredChartTypes, getChartType } from 'openalgo-charts';
import { chromeIconSvg } from 'openalgo-charts/draw';
import { h, glyph, type WidgetContext } from './context';
import type { WidgetThemeName } from './tokens';

/** One hit from a host's symbol search. */
export interface SymbolMatch {
  symbol: string;
  exchange?: string;
  /** Long name, shown muted after the symbol. */
  name?: string;
}

/** A host's symbol lookup, called as the user types. Sync or async. */
export type SymbolSearch = (query: string) => Promise<readonly SymbolMatch[]> | readonly SymbolMatch[];

/** Milliseconds of quiet before the search callback runs. */
export const SEARCH_DEBOUNCE_MS = 150;

/** Labels for the built-in chart types; anything else is read from its id. */
export const CHART_TYPE_LABELS: Readonly<Record<string, string>> = {
  candlestick: 'Candles',
  'hollow-candle': 'Hollow candles',
  bar: 'Bars',
  'high-low': 'High-low',
  'volume-candle': 'Volume candles',
  line: 'Line',
  'line-markers': 'Line with markers',
  step: 'Step line',
  area: 'Area',
  'hlc-area': 'HLC area',
  baseline: 'Baseline',
  'point-figure': 'Point and figure',
  kagi: 'Kagi',
};

export function chartTypeLabel(id: string): string {
  const known = CHART_TYPE_LABELS[id];
  if (known !== undefined) return known;
  return id.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * The chart types a primary series can be: every registered renderer that
 * declares itself a price series. A volume histogram is registered too and
 * would draw, but it is not a chart type anyone picks for the instrument.
 */
export function chartTypeChoices(): string[] {
  return registeredChartTypes().filter((t) => {
    try { return getChartType(t).isPriceSeries; } catch { return false; }
  });
}

/**
 * A pill label for an interval code: minutes and hours keep their lower-case
 * unit (`5m`, `1h`), days and weeks read as a capital (`D`, `W`, `2W`), and
 * anything else (a registered calendar code) is upper-cased as written.
 */
export function intervalLabel(code: string): string {
  const m = /^(\d*)\s*([smhdwSMHDW])$/.exec(code.trim());
  if (m === null) return code.toUpperCase();
  const n = m[1] === '' || m[1] === '1' ? '' : m[1];
  const unit = m[2];
  if (unit === 'm') return `${m[1] === '' ? '1' : m[1]}m`;
  if (unit === 's') return `${m[1] === '' ? '1' : m[1]}s`;
  if (unit === 'h' || unit === 'H') return `${m[1] === '' ? '1' : m[1]}h`;
  return n + unit.toUpperCase();
}

export interface MenuRow {
  label: string;
  sub?: string;
  /** Shown at the right edge, for a chord. */
  key?: string;
  /** Marks the row as the current choice. */
  on?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export interface MenuOptions {
  /** A search box at the top with this placeholder; rows filter as the user types. */
  find?: string;
  ariaLabel?: string;
}

/**
 * A popup menu under `anchor`. Rows are buttons; a `{ head }` string starts a
 * group. Returns the closer. Exported for the dialog tier, whose context menu
 * and pickers want the same shape.
 */
export function openMenu(ctx: WidgetContext, anchor: HTMLElement, rows: ReadonlyArray<MenuRow | string>, opts: MenuOptions = {}): () => void {
  const doc = ctx.document;
  const m = h(doc, 'div', 'oac-menu', { role: 'menu' });
  if (opts.ariaLabel) m.setAttribute('aria-label', opts.ariaLabel);
  let find: HTMLInputElement | null = null;
  if (opts.find) {
    const wrap = h(doc, 'div', 'oac-menu__find');
    find = h(doc, 'input', undefined, { type: 'text', placeholder: opts.find, 'aria-label': opts.find });
    wrap.appendChild(find);
    m.appendChild(wrap);
  }
  const body = h(doc, 'div', 'oac-menu__body');
  m.appendChild(body);
  let close: () => void = () => {};

  const paint = (q: string): void => {
    const needle = q.trim().toLowerCase();
    body.textContent = '';
    let shown = 0;
    // A group heading is only worth drawing once something under it survives
    // the filter, so it is held back until the first matching row appears.
    let pending: string | null = null;
    for (const r of rows) {
      if (typeof r === 'string') { pending = r; continue; }
      if (needle !== '' && !r.label.toLowerCase().includes(needle) && !(r.sub ?? '').toLowerCase().includes(needle)) continue;
      if (pending !== null) {
        const g = h(doc, 'div', 'oac-head');
        g.textContent = pending;
        body.appendChild(g);
        pending = null;
      }
      const b = h(doc, 'button', 'oac-menu__row' + (r.danger ? ' is-danger' : ''), {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(r.on === true), 'aria-disabled': String(r.disabled === true),
      });
      const label = h(doc, 'span', 'oac-menu__label');
      label.textContent = r.label;
      b.appendChild(label);
      if (r.sub) {
        const s = h(doc, 'span', 'oac-menu__sub');
        s.textContent = r.sub;
        b.appendChild(s);
      }
      if (r.key) {
        const k = h(doc, 'kbd', 'oac-menu__key');
        k.textContent = r.key;
        b.appendChild(k);
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (r.disabled) return;
        close();
        r.onSelect();
      });
      body.appendChild(b);
      shown++;
    }
    if (shown === 0) {
      const e = h(doc, 'div', 'oac-menu__empty');
      e.textContent = 'No match';
      body.appendChild(e);
    }
  };
  paint('');
  if (find !== null) {
    const input = find;
    input.addEventListener('input', () => paint(input.value));
    // Enter picks the only remaining row, so a unique search needs no click.
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return;
      const only = body.querySelectorAll('.oac-menu__row');
      if (only.length === 1) (only[0] as HTMLElement).click();
    });
  }
  m.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    const items = Array.from(body.querySelectorAll('.oac-menu__row')) as HTMLElement[];
    const at = items.indexOf(doc.activeElement as HTMLElement);
    if (ke.key === 'ArrowDown') { items[(at + 1) % items.length]?.focus(); ke.preventDefault(); ke.stopPropagation(); }
    else if (ke.key === 'ArrowUp') { items[(at - 1 + items.length) % items.length]?.focus(); ke.preventDefault(); ke.stopPropagation(); }
  });
  close = ctx.openOverlay(m, { anchor, placement: 'below', initialFocus: find ?? (body.querySelector('.oac-menu__row[aria-checked="true"]') as HTMLElement | null) ?? undefined });
  return close;
}

export interface TopbarState {
  symbol: string;
  exchange: string;
  interval: string;
  chartType: string;
  theme: WidgetThemeName;
}

export interface TopbarOptions {
  intervals: readonly string[];
  /** Show the indicators button. Default true. */
  indicators?: boolean;
  search?: SymbolSearch;
  /** The current facts, read on every refresh. */
  state: () => TopbarState;
  onSymbol(symbol: string, exchange?: string): void;
  onInterval(code: string): void;
  onChartType(id: string): void;
  onTheme(next: WidgetThemeName): void;
  /** Open the settings dialog from `anchor`. Return false when no dialog is registered. */
  onSettings(anchor: HTMLElement): boolean;
  onIndicators(anchor: HTMLElement): boolean;
  settingsAvailable(): boolean;
  indicatorsAvailable(): boolean;
}

export interface TopbarHandle {
  readonly el: HTMLElement;
  /** Repaint every control from `state()`. */
  refresh(): void;
  /** Put the caret in the symbol box, text selected. */
  focusSymbol(): void;
  destroy(): void;
}

/** Hand `text` to the browser as a file. False when the runtime has no way to (no `Blob`, no object URLs). */
export function downloadText(doc: Document, filename: string, text: string, mime: string): boolean {
  const g = globalThis as { Blob?: typeof Blob; URL?: typeof URL };
  if (g.Blob === undefined || g.URL === undefined || typeof g.URL.createObjectURL !== 'function') return false;
  const url = g.URL.createObjectURL(new g.Blob([text], { type: mime }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  (doc.body ?? doc.documentElement).appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next turn: revoking synchronously races the download in
  // some browsers, which then save an empty file.
  setTimeout(() => g.URL?.revokeObjectURL(url), 0);
  return true;
}

/** `SYMBOL-5m-2026-01-31-09-15` with the characters a filename cannot carry removed. */
export function captureName(symbol: string, interval: string, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `${(symbol || 'chart').replace(/[^A-Za-z0-9._-]/g, '')}-${interval || 'chart'}-${stamp}`;
}

export function mountTopbar(ctx: WidgetContext, host: HTMLElement, opts: TopbarOptions): TopbarHandle {
  const doc = ctx.document;
  host.classList.add('oac-topbar');
  host.setAttribute('role', 'toolbar');
  host.setAttribute('aria-label', 'Chart toolbar');

  const btn = (label: string, cls = ''): HTMLButtonElement => h(doc, 'button', 'oac-btn' + (cls ? ' ' + cls : ''), { type: 'button', 'aria-label': label });
  const chev = (): HTMLElement => {
    const s = h(doc, 'span', 'oac-chev', { 'aria-hidden': 'true' });
    s.innerHTML = chromeIconSvg('chevron-down');
    return s;
  };
  const sep = (): HTMLElement => h(doc, 'span', 'oac-sep', { role: 'separator' });
  const setOff = (b: HTMLButtonElement, off: boolean): void => {
    b.classList.toggle('is-off', off);
    b.setAttribute('aria-disabled', String(off));
  };

  // ── symbol ───────────────────────────────────────────────────────────
  const symWrap = h(doc, 'div', 'oac-sym');
  symWrap.appendChild(glyph(doc, chromeIconSvg('search'), 'chrome'));
  const symInput = h(doc, 'input', 'oac-sym__input', {
    type: 'text', 'aria-label': 'Symbol', placeholder: 'Symbol', autocomplete: 'off', spellcheck: 'false',
  });
  symWrap.appendChild(symInput);
  const symEx = h(doc, 'span', 'oac-sym__ex');
  symWrap.appendChild(symEx);
  host.appendChild(symWrap);
  host.appendChild(sep());

  let results: { close: () => void; rows: HTMLElement[]; matches: readonly SymbolMatch[] } | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let searchSeq = 0;
  const closeResults = (): void => { results?.close(); results = null; };
  const commit = (symbol: string, exchange?: string): void => {
    closeResults();
    const s = symbol.trim().toUpperCase();
    if (s === '') { refresh(); return; }
    opts.onSymbol(s, exchange);
    symInput.blur();
  };
  const showResults = (matches: readonly SymbolMatch[]): void => {
    closeResults();
    if (matches.length === 0) return;
    const m = h(doc, 'div', 'oac-menu oac-sym__results', { role: 'listbox', 'aria-label': 'Symbols' });
    const rows: HTMLElement[] = [];
    matches.forEach((hit, i) => {
      const b = h(doc, 'button', 'oac-menu__row' + (i === 0 ? ' is-active' : ''), { type: 'button', role: 'option' });
      const label = h(doc, 'span', 'oac-menu__label');
      label.textContent = hit.exchange ? `${hit.exchange}:${hit.symbol}` : hit.symbol;
      b.appendChild(label);
      if (hit.name) {
        const sub = h(doc, 'span', 'oac-menu__sub');
        sub.textContent = hit.name;
        b.appendChild(sub);
      }
      b.addEventListener('click', (e) => { e.stopPropagation(); commit(hit.symbol, hit.exchange); });
      rows.push(b);
      m.appendChild(b);
    });
    // The input keeps the caret: the list is driven from the keyboard there.
    const close = ctx.openOverlay(m, { anchor: symWrap, placement: 'below', initialFocus: null, onClose: () => { if (results !== null && results.rows === rows) results = null; } });
    results = { close, rows, matches };
  };
  const activeIndex = (): number => (results === null ? -1 : results.rows.findIndex((r) => r.classList.contains('is-active')));
  const setActive = (i: number): void => {
    if (results === null) return;
    const n = results.rows.length;
    const k = ((i % n) + n) % n;
    results.rows.forEach((r, j) => r.classList.toggle('is-active', j === k));
  };
  const runSearch = (q: string): void => {
    if (!opts.search) return;
    const seq = ++searchSeq;
    Promise.resolve(opts.search(q)).then((hits) => {
      // A slower answer for an earlier query must not land under a later one.
      if (seq !== searchSeq || doc.activeElement !== symInput) return;
      showResults(hits);
    }).catch(() => { closeResults(); });
  };
  symInput.addEventListener('input', () => {
    if (!opts.search) return;
    if (searchTimer !== 0) clearTimeout(searchTimer);
    const q = symInput.value.trim();
    if (q === '') { closeResults(); return; }
    searchTimer = setTimeout(() => { searchTimer = 0; runSearch(q); }, SEARCH_DEBOUNCE_MS);
  });
  symInput.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter') {
      ke.preventDefault();
      const at = activeIndex();
      if (results !== null && at >= 0) { const hit = results.matches[at]; commit(hit.symbol, hit.exchange); return; }
      commit(symInput.value);
    } else if (ke.key === 'ArrowDown' && results !== null) { ke.preventDefault(); setActive(activeIndex() + 1); }
    else if (ke.key === 'ArrowUp' && results !== null) { ke.preventDefault(); setActive(activeIndex() - 1); }
    else if (ke.key === 'Escape') {
      // With the list open the overlay stack takes this; with it closed the
      // typed text is abandoned and the box shows the symbol again.
      if (results === null) { refresh(); symInput.blur(); }
    }
  });
  symInput.addEventListener('focus', () => { symInput.select(); });
  symInput.addEventListener('blur', () => { if (results === null) refresh(); });

  // ── intervals ────────────────────────────────────────────────────────
  const pills = h(doc, 'div', 'oac-pills', { role: 'radiogroup', 'aria-label': 'Interval' });
  const pillByCode = new Map<string, HTMLButtonElement>();
  for (const code of opts.intervals) {
    const b = h(doc, 'button', undefined, { type: 'button', role: 'radio', 'aria-pressed': 'false', 'aria-label': `Interval ${code}` });
    b.textContent = intervalLabel(code);
    b.dataset.interval = code;
    b.addEventListener('click', () => opts.onInterval(code));
    pills.appendChild(b);
    pillByCode.set(code, b);
  }
  host.appendChild(pills);
  host.appendChild(sep());

  // ── chart type ───────────────────────────────────────────────────────
  const typeBtn = btn('Chart type', 'oac-topbar__type');
  const typeLabel = h(doc, 'span');
  typeBtn.appendChild(typeLabel);
  typeBtn.appendChild(chev());
  typeBtn.setAttribute('aria-haspopup', 'menu');
  typeBtn.addEventListener('click', () => {
    const cur = opts.state().chartType;
    openMenu(ctx, typeBtn, chartTypeChoices().map((id) => ({
      label: chartTypeLabel(id), on: id === cur, onSelect: () => opts.onChartType(id),
    })), { ariaLabel: 'Chart type' });
  });
  host.appendChild(typeBtn);

  // ── indicators ───────────────────────────────────────────────────────
  let indBtn: HTMLButtonElement | null = null;
  if (opts.indicators !== false) {
    indBtn = btn('Indicators');
    indBtn.appendChild(glyph(doc, chromeIconSvg('plus'), 'chrome'));
    const t = h(doc, 'span');
    t.textContent = 'Indicators';
    indBtn.appendChild(t);
    indBtn.addEventListener('click', () => {
      if (indBtn !== null && indBtn.classList.contains('is-off')) return;
      if (indBtn !== null) opts.onIndicators(indBtn);
    });
    host.appendChild(indBtn);
  }

  host.appendChild(h(doc, 'span', 'oac-topbar__spacer'));

  // ── capture ──────────────────────────────────────────────────────────
  const snapBtn = btn('Capture chart', 'oac-btn--icon');
  snapBtn.appendChild(glyph(doc, chromeIconSvg('camera'), 'chrome'));
  snapBtn.setAttribute('aria-haspopup', 'menu');
  ctx.tips.attach(snapBtn, { title: 'Capture', sub: 'PNG, SVG, or the clipboard', side: 'bottom' });
  snapBtn.addEventListener('click', () => {
    const s = opts.state();
    const clip = (globalThis as { navigator?: { clipboard?: { write?: unknown } }; ClipboardItem?: unknown });
    const canCopy = clip.navigator?.clipboard?.write !== undefined && clip.ClipboardItem !== undefined;
    openMenu(ctx, snapBtn, [
      { label: 'Download PNG', onSelect: () => {
        ctx.chart.downloadScreenshot(captureName(s.symbol, s.interval) + '.png');
        ctx.status('Saved a PNG of the chart');
      } },
      { label: 'Download SVG', sub: 'text stays text', onSelect: () => {
        const ok = downloadText(doc, captureName(s.symbol, s.interval) + '.svg', ctx.chart.exportSVG(), 'image/svg+xml');
        ctx.status(ok ? 'Saved an SVG of the chart' : 'This runtime cannot save files', ok ? 'info' : 'error');
      } },
      { label: 'Copy image', sub: canCopy ? 'paste it anywhere' : 'needs https or localhost', disabled: !canCopy, onSelect: () => {
        const canvas = ctx.chart.takeScreenshot();
        canvas.toBlob((blob) => {
          if (blob === null) { ctx.status('The canvas produced no image', 'error'); return; }
          const Item = (globalThis as { ClipboardItem: new (parts: Record<string, Blob>) => unknown }).ClipboardItem;
          (globalThis.navigator.clipboard as unknown as { write(items: unknown[]): Promise<void> })
            .write([new Item({ 'image/png': blob })])
            .then(() => ctx.status('Chart copied'), (err: unknown) => ctx.status('Copy failed: ' + String((err as Error)?.message ?? err), 'error'));
        }, 'image/png');
      } },
    ], { ariaLabel: 'Capture' });
  });
  host.appendChild(snapBtn);

  // ── settings ─────────────────────────────────────────────────────────
  const setBtn = btn('Chart settings', 'oac-btn--icon');
  setBtn.appendChild(glyph(doc, chromeIconSvg('settings'), 'chrome'));
  ctx.tips.attach(setBtn, () => ({
    title: 'Chart settings',
    sub: opts.settingsAvailable() ? undefined : 'The settings dialog is not in this build',
    side: 'bottom',
  }));
  setBtn.addEventListener('click', () => { if (!setBtn.classList.contains('is-off')) opts.onSettings(setBtn); });
  host.appendChild(setBtn);

  // ── theme ────────────────────────────────────────────────────────────
  // A word rather than a glyph: the chrome set has no sun or moon, and the
  // name of the theme the click would switch to says more than either.
  const themeBtn = btn('Theme', 'oac-topbar__theme');
  const themeLabel = h(doc, 'span');
  themeBtn.appendChild(themeLabel);
  ctx.tips.attach(themeBtn, () => ({ title: opts.state().theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme', side: 'bottom' }));
  themeBtn.addEventListener('click', () => opts.onTheme(opts.state().theme === 'dark' ? 'light' : 'dark'));
  host.appendChild(themeBtn);

  if (indBtn !== null) {
    ctx.tips.attach(indBtn, () => ({
      title: 'Indicators',
      sub: opts.indicatorsAvailable() ? 'Add a study to the chart' : 'The indicator picker is not in this build',
      side: 'bottom',
    }));
  }

  const refresh = (): void => {
    const s = opts.state();
    if (doc.activeElement !== symInput) symInput.value = s.symbol;
    symEx.textContent = s.exchange;
    symEx.hidden = s.exchange === '';
    for (const [code, b] of pillByCode) {
      const on = code === s.interval;
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-checked', String(on));
    }
    typeLabel.textContent = chartTypeLabel(s.chartType);
    setOff(setBtn, !opts.settingsAvailable());
    if (indBtn !== null) setOff(indBtn, !opts.indicatorsAvailable());
    themeBtn.dataset.theme = s.theme;
    themeLabel.textContent = s.theme === 'dark' ? 'Light' : 'Dark';
    ctx.tips.refreshLabel(themeBtn);
    ctx.tips.refreshLabel(setBtn);
    if (indBtn !== null) ctx.tips.refreshLabel(indBtn);
  };
  refresh();

  return {
    el: host,
    refresh,
    focusSymbol: () => { symInput.focus(); },
    destroy: () => {
      if (searchTimer !== 0) clearTimeout(searchTimer);
      closeResults();
      host.textContent = '';
    },
  };
}
