import { widgetText, type WidgetTranslationOptions } from './localization';
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
import { registeredChartTypes, getChartType, exportChartDataCsv } from 'openalgo-charts';
import { chromeIconSvg } from 'openalgo-charts/draw';
import { h, glyph, type WidgetContext } from './context';
import type { WidgetThemeName } from './tokens';
import { mountSymbolPicker, type SymbolPickerHandle } from './symbol-picker';
import { timeBuckets } from './date-navigator';
export { SEARCH_DEBOUNCE_MS } from './symbol-picker';
export type { SymbolMatch, SymbolSearch } from './symbol-picker';
import type { SymbolSearch } from './symbol-picker';
import { openChartDataExportDialog } from './chart-data-export-dialog';
import type { PanelHandle } from './form';

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
      e.textContent = widgetText(ctx, 'No match');
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
  /** A text control for the host's object inventory, omitted without a handler. */
  onObjects?(anchor: HTMLElement): boolean;
  /** Open the docked data window, omitted without a handler. */
  onDataWindow?(anchor: HTMLElement): void | boolean;
  onAlerts?(anchor: HTMLElement): boolean;
  /** Open the docked watchlist, omitted without a handler (the host supplied no lists). */
  onWatchlist?(anchor: HTMLElement): void | boolean;
  /** Open the docked news reader, omitted without a handler (the host supplied no news source). */
  onNews?(anchor: HTMLElement): void | boolean;
  /** Open the date and range navigation panel, omitted without a handler. */
  onGoTo?(anchor: HTMLElement): void | boolean;
  settingsAvailable(): boolean;
  indicatorsAvailable(): boolean;
  /** Refuse CSV export while the host is replacing or recovering its data. */
  dataAvailable?(): boolean;
}

export interface TopbarHandle {
  readonly el: HTMLElement;
  /** Open the shared capture menu from desktop or mobile chrome. */
  openCapture(anchor: HTMLElement): void;
  /** Repaint every control from `state()`. */
  refresh(): void;
  /** Put the caret in the symbol box, text selected. */
  focusSymbol(): void;
  destroy(): void;
}

interface BrandingLinkOptions {
  href?: string;
  label?: string;
}

/** Read safe link metadata from the chart's active branding. */
export function brandingLink(chart: WidgetContext['chart'], translation: WidgetTranslationOptions = {}): { href: string; label: string } | null {
  const options = (chart as unknown as {
    brandingOptions?(): false | BrandingLinkOptions;
  }).brandingOptions?.();
  if (!options || typeof options.href !== 'string' || !/^https?:\/\//i.test(options.href)) return null;
  const label = typeof options.label === 'string' && options.label.trim() !== ''
    ? options.label.trim()
    : widgetText(translation, 'Chart branding');
  return { href: options.href, label };
}

/** Hand `text` to the browser as a file. False when the runtime has no way to (no `Blob`, no object URLs). */
export function downloadText(doc: Document, filename: string, text: string, mime: string): boolean {
  const g = globalThis as { Blob?: typeof Blob; URL?: typeof URL };
  if (g.Blob === undefined || g.URL === undefined || typeof g.URL.createObjectURL !== 'function') return false;
  const a = doc.createElement('a');
  const url = g.URL.createObjectURL(new g.Blob([text], { type: mime }));
  try {
    a.href = url;
    a.download = filename;
    (doc.body ?? doc.documentElement).appendChild(a);
    a.click();
  } finally {
    a.remove();
    // Revoking synchronously races browser downloads, including successful handoff.
    setTimeout(() => g.URL?.revokeObjectURL(url), 0);
  }
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
  host.setAttribute('aria-label', widgetText(ctx, 'Chart toolbar'));

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
    type: 'text', 'aria-label': widgetText(ctx, 'Symbol'), placeholder: widgetText(ctx, 'Symbol'), autocomplete: 'off', spellcheck: 'false',
  });
  symWrap.appendChild(symInput);
  const symEx = h(doc, 'span', 'oac-sym__ex');
  symWrap.appendChild(symEx);
  host.appendChild(symWrap);
  host.appendChild(sep());

  let picker: SymbolPickerHandle | null = null;
  const commit = (symbol: string, exchange?: string): void => {
    picker?.close();
    const s = symbol.trim().toUpperCase();
    if (s === '') { refresh(); return; }
    opts.onSymbol(s, exchange);
    symInput.blur();
  };
  if (opts.search) picker = mountSymbolPicker(ctx, symInput, {
    search: opts.search, onSelect: commit,
    context: () => `${opts.state().exchange}:${opts.state().symbol}:${opts.state().interval}`,
  });
  symInput.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter') {
      ke.preventDefault();
      commit(symInput.value);
    } else if (ke.key === 'Escape') { refresh(); symInput.blur(); }
  });
  symInput.addEventListener('focus', () => { symInput.select(); });
  symInput.addEventListener('blur', () => { refresh(); });

  // ── intervals ────────────────────────────────────────────────────────
  const pills = h(doc, 'div', 'oac-pills', { role: 'radiogroup', 'aria-label': widgetText(ctx, 'Interval') });
  const pillByCode = new Map<string, HTMLButtonElement>();
  for (const code of opts.intervals) {
    const b = h(doc, 'button', undefined, { type: 'button', role: 'radio', 'aria-pressed': 'false', 'aria-label': widgetText(ctx, 'Interval {code}', { code }) });
    b.textContent = intervalLabel(code);
    b.dataset.interval = code;
    b.addEventListener('click', () => opts.onInterval(code));
    pills.appendChild(b);
    pillByCode.set(code, b);
  }
  host.appendChild(pills);
  host.appendChild(sep());

  // ── chart type ───────────────────────────────────────────────────────
  const typeBtn = btn(widgetText(ctx, 'Chart type'), 'oac-topbar__type');
  const typeLabel = h(doc, 'span');
  typeBtn.appendChild(typeLabel);
  typeBtn.appendChild(chev());
  typeBtn.setAttribute('aria-haspopup', 'menu');
  typeBtn.addEventListener('click', () => {
    const cur = opts.state().chartType;
    openMenu(ctx, typeBtn, chartTypeChoices().map((id) => ({
      label: widgetText(ctx, `schema.chartType.${id}`, {}, chartTypeLabel(id)), on: id === cur, onSelect: () => opts.onChartType(id),
    })), { ariaLabel: widgetText(ctx, 'Chart type') });
  });
  host.appendChild(typeBtn);

  // ── indicators ───────────────────────────────────────────────────────
  let indBtn: HTMLButtonElement | null = null;
  if (opts.indicators !== false) {
    indBtn = btn(widgetText(ctx, 'Indicators'));
    indBtn.appendChild(glyph(doc, chromeIconSvg('plus'), 'chrome'));
    const t = h(doc, 'span');
    t.textContent = widgetText(ctx, 'Indicators');
    indBtn.appendChild(t);
    indBtn.addEventListener('click', () => {
      if (indBtn !== null && indBtn.classList.contains('is-off')) return;
      if (indBtn !== null) opts.onIndicators(indBtn);
    });
    host.appendChild(indBtn);
  }

  host.appendChild(h(doc, 'span', 'oac-topbar__spacer'));

  // The canvas mark can be activated by pointer. This host link gives the
  // same destination to keyboard and assistive-technology users without
  // placing transparent chrome over the chart.
  const brandingSlot = h(doc, 'span', 'oac-topbar__branding-slot');
  let brandingAnchor: HTMLAnchorElement | null = null;
  host.appendChild(brandingSlot);

  // Tick and volume bars have no date to go to: greyed with the reason, not dead.
  const goTo = opts.onGoTo ? btn(widgetText(ctx, 'Go to'), 'oac-topbar__goto') : null;
  if (goTo !== null) {
    goTo.textContent = widgetText(ctx, 'Go to');
    goTo.setAttribute('aria-haspopup', 'dialog');
    ctx.tips.attach(goTo, () => ({
      title: widgetText(ctx, 'Go to'),
      sub: timeBuckets(opts.state().interval) === null ? widgetText(ctx, 'Go to needs a time-based interval') : undefined,
      side: 'bottom',
    }));
    goTo.addEventListener('click', () => { if (!goTo.classList.contains('is-off')) opts.onGoTo?.(goTo); });
    host.appendChild(goTo);
  }
  if (opts.onObjects) {
    const objects = btn(widgetText(ctx, 'Objects'), 'oac-topbar__objects');
    objects.textContent = widgetText(ctx, 'Objects');
    objects.setAttribute('aria-haspopup', 'dialog');
    objects.addEventListener('click', () => { opts.onObjects?.(objects); });
    host.appendChild(objects);
  }
  if (opts.onDataWindow) {
    const data = btn(widgetText(ctx, 'schema.ui.dataWindow', {}, 'Data'), 'oac-topbar__data');
    data.textContent = widgetText(ctx, 'schema.ui.dataWindow', {}, 'Data');
    data.addEventListener('click', () => { opts.onDataWindow?.(data); });
    host.appendChild(data);
  }
  for (const [key, label, handler] of [['watchlist', 'Watchlist', opts.onWatchlist], ['news', 'News', opts.onNews]] as const) {
    if (!handler) continue;
    const control = btn(widgetText(ctx, `schema.ui.dock.${key}`, {}, label), `oac-topbar__${key}`);
    control.textContent = widgetText(ctx, `schema.ui.dock.${key}`, {}, label);
    control.addEventListener('click', () => { handler(control); });
    host.appendChild(control);
  }
  if (opts.onAlerts) {
    const alerts = btn(widgetText(ctx, 'Alerts'), 'oac-topbar__alerts');
    alerts.textContent = widgetText(ctx, 'Alerts');
    alerts.setAttribute('aria-haspopup', 'dialog');
    alerts.addEventListener('click', () => { opts.onAlerts?.(alerts); });
    host.appendChild(alerts);
  }

  // ── capture ──────────────────────────────────────────────────────────
  const snapBtn = btn(widgetText(ctx, 'Capture chart'), 'oac-btn--icon');
  snapBtn.appendChild(glyph(doc, chromeIconSvg('camera'), 'chrome'));
  snapBtn.setAttribute('aria-haspopup', 'menu');
  ctx.tips.attach(snapBtn, { title: widgetText(ctx, 'Capture'), sub: widgetText(ctx, 'PNG, SVG, CSV or the clipboard'), side: 'bottom' });
  let dataDialog: PanelHandle | null = null;
  const openCapture = (anchor: HTMLElement): void => {
    const s = { ...opts.state() };
    const capturedChart = ctx.chart;
    const capturedPrimary = capturedChart.primarySeries();
    const source = capturedChart.getDataContext();
    const dataAvailable = (): boolean => !capturedChart.isDestroyed && opts.dataAvailable?.() !== false && capturedChart.primaryBars().length > 0;
    const checkSource = (): void => {
      const current = opts.state(), context = ctx.chart.getDataContext();
      if (ctx.chart !== capturedChart || capturedChart.primarySeries() !== capturedPrimary
        || current.symbol !== s.symbol || current.exchange !== s.exchange || current.interval !== s.interval || current.chartType !== s.chartType
        || context !== source) {
        throw new Error(widgetText(ctx, 'The chart changed; reopen Capture for its current source'));
      }
      if (!dataAvailable()) throw new Error(widgetText(ctx, 'Wait for this chart to finish loading its data'));
    };
    const clip = (globalThis as { navigator?: { clipboard?: { write?: unknown } }; ClipboardItem?: unknown });
    const canCopy = clip.navigator?.clipboard?.write !== undefined && clip.ClipboardItem !== undefined;
    openMenu(ctx, anchor, [
      { label: widgetText(ctx, 'Download PNG'), onSelect: () => {
        ctx.chart.downloadScreenshot(captureName(s.symbol, s.interval) + '.png');
        ctx.status(widgetText(ctx, 'Saved a PNG of the chart'));
      } },
      { label: widgetText(ctx, 'Download SVG'), sub: widgetText(ctx, 'text stays text'), onSelect: () => {
        const ok = downloadText(doc, captureName(s.symbol, s.interval) + '.svg', ctx.chart.exportSVG(), 'image/svg+xml');
        ctx.status(ok ? widgetText(ctx, 'Saved an SVG of the chart') : widgetText(ctx, 'This runtime cannot save files'), ok ? 'info' : 'error');
      } },
      { label: widgetText(ctx, 'Copy image'), sub: canCopy ? widgetText(ctx, 'paste it anywhere') : widgetText(ctx, 'needs https or localhost'), disabled: !canCopy, onSelect: () => {
        const canvas = ctx.chart.takeScreenshot();
        canvas.toBlob((blob) => {
          if (blob === null) { ctx.status(widgetText(ctx, 'The canvas produced no image'), 'error'); return; }
          const Item = (globalThis as { ClipboardItem: new (parts: Record<string, Blob>) => unknown }).ClipboardItem;
          (globalThis.navigator.clipboard as unknown as { write(items: unknown[]): Promise<void> })
            .write([new Item({ 'image/png': blob })])
            .then(() => ctx.status(widgetText(ctx, 'Chart copied')), (err: unknown) => ctx.status(widgetText(ctx, 'Copy failed: {error}', { error: String((err as Error)?.message ?? err) }), 'error'));
        }, 'image/png');
      } },
      { label: widgetText(ctx, 'Download chart data (CSV)'), disabled: !dataAvailable(), onSelect: () => {
        try {
          checkSource();
          dataDialog?.close();
          dataDialog = openChartDataExportDialog(ctx, anchor, options => {
            checkSource();
            const csv = exportChartDataCsv(capturedChart, options);
            checkSource();
            if (!downloadText(doc, captureName(s.symbol, s.interval) + '.csv', csv, 'text/csv;charset=utf-8')) {
              throw new Error(widgetText(ctx, 'This runtime cannot save files'));
            }
            ctx.status(widgetText(ctx, 'Chart data download started'));
          });
        } catch (error) { ctx.status(widgetText(ctx, 'Data export failed: {error}', { error: String((error as Error)?.message ?? error) }), 'error'); }
      } },
    ], { ariaLabel: widgetText(ctx, 'Capture') });
  };
  snapBtn.addEventListener('click', () => openCapture(snapBtn));
  host.appendChild(snapBtn);

  // ── settings ─────────────────────────────────────────────────────────
  const setBtn = btn(widgetText(ctx, 'Chart settings'), 'oac-btn--icon');
  setBtn.appendChild(glyph(doc, chromeIconSvg('settings'), 'chrome'));
  ctx.tips.attach(setBtn, () => ({
    title: widgetText(ctx, 'Chart settings'),
    sub: opts.settingsAvailable() ? undefined : widgetText(ctx, 'The settings dialog is not in this build'),
    side: 'bottom',
  }));
  setBtn.addEventListener('click', () => { if (!setBtn.classList.contains('is-off')) opts.onSettings(setBtn); });
  host.appendChild(setBtn);

  // ── theme ────────────────────────────────────────────────────────────
  // A word rather than a glyph: the chrome set has no sun or moon, and the
  // name of the theme the click would switch to says more than either.
  const themeBtn = btn(widgetText(ctx, 'Theme'), 'oac-topbar__theme');
  const themeLabel = h(doc, 'span');
  themeBtn.appendChild(themeLabel);
  ctx.tips.attach(themeBtn, () => ({ title: opts.state().theme === 'dark' ? widgetText(ctx, 'Switch to the light theme') : widgetText(ctx, 'Switch to the dark theme'), side: 'bottom' }));
  themeBtn.addEventListener('click', () => opts.onTheme(opts.state().theme === 'dark' ? 'light' : 'dark'));
  host.appendChild(themeBtn);

  if (indBtn !== null) {
    ctx.tips.attach(indBtn, () => ({
      title: widgetText(ctx, 'Indicators'),
      sub: opts.indicatorsAvailable() ? widgetText(ctx, 'Add a study to the chart') : widgetText(ctx, 'The indicator picker is not in this build'),
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
    typeLabel.textContent = widgetText(ctx, `schema.chartType.${s.chartType}`, {}, chartTypeLabel(s.chartType));
    setOff(setBtn, !opts.settingsAvailable());
    if (indBtn !== null) setOff(indBtn, !opts.indicatorsAvailable());
    if (goTo !== null) setOff(goTo, timeBuckets(s.interval) === null);
    themeBtn.dataset.theme = s.theme;
    themeLabel.textContent = s.theme === 'dark' ? widgetText(ctx, 'Light') : widgetText(ctx, 'Dark');
    ctx.tips.refreshLabel(themeBtn);
    ctx.tips.refreshLabel(setBtn);
    if (indBtn !== null) ctx.tips.refreshLabel(indBtn);
    const link = brandingLink(ctx.chart, ctx);
    if (link === null) {
      brandingAnchor?.remove();
      brandingAnchor = null;
    } else {
      if (brandingAnchor === null) {
        brandingAnchor = h(doc, 'a', 'oac-topbar__branding', {
          target: '_blank', rel: 'noopener noreferrer',
        });
        brandingSlot.appendChild(brandingAnchor);
      }
      brandingAnchor.setAttribute('href', link.href);
      brandingAnchor.textContent = link.label;
      brandingAnchor.setAttribute('aria-label', link.label);
    }
  };
  const offBranding = ctx.chart.on('branding:changed', refresh);
  refresh();

  return {
    el: host,
    openCapture,
    refresh,
    focusSymbol: () => { symInput.focus(); },
    destroy: () => {
      dataDialog?.close();
      offBranding();
      picker?.destroy();
      host.textContent = '';
    },
  };
}
