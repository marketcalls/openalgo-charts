/**
 * The status line: one row under the chart with the engine's status-line
 * fields in HTML, so a host that turns the on-canvas legend off still has a
 * readout, and a screen reader has text to read.
 *
 * The fields are the legend's: the symbol and interval (the title), the O/H/L/C
 * of the bar under the pointer (chart values), the change over that bar (bar
 * change), its volume, and the bar's time in the chart's zone. Each follows
 * the same switch the settings dialog flips on the chart
 * (`chart.statusLineOptions()`), so turning off "chart values" there empties
 * the O/H/L/C here too. A transient message slot at the right takes what the
 * shell has to say (a load in progress, a magnet change, a saved layout).
 *
 * It listens to `crosshair:move`, which the engine emits on the cursor tier;
 * the handler writes text only when a value changed, so an idle pointer
 * touches nothing.
 */
import type { Bar, Chart, CrosshairMoveEvent } from 'openalgo-charts';
import { formatZonedCrosshairLabel } from 'openalgo-charts';
import { h, type WidgetContext } from './context';

export interface StatuslineOptions {
  /** BCP 47 tag for number formatting. Default: the runtime's. */
  locale?: string;
}

export interface StatuslineHandle {
  readonly el: HTMLElement;
  /** Put a transient message at the right. `error` tints it. */
  setMessage(text: string, kind?: 'info' | 'error'): void;
  /** The title: symbol, optional exchange, and the interval code. */
  setSymbol(symbol: string, exchange: string, interval: string): void;
  /** Show a bar's readings; null clears them (the pointer left and there is no last bar). */
  setBar(bar: Bar | null, time: number | null): void;
  /** Re-read the chart's switches and repaint. */
  refresh(): void;
  destroy(): void;
}

/**
 * Decimals a price is printed with: the price scale's own, so the row agrees
 * with the axis, floored at two so a reading a trader compares against a level
 * survives the comparison (the same floor the engine puts under a study pane).
 */
export const MIN_PRICE_DIGITS = 2;
export function priceDigits(chart: Chart): number {
  const pane = chart.panes()[0];
  if (pane === undefined) return MIN_PRICE_DIGITS;
  const p = pane.priceScale.precision();
  return Number.isFinite(p) ? Math.max(MIN_PRICE_DIGITS, Math.min(8, Math.round(p))) : MIN_PRICE_DIGITS;
}

/** A fixed-decimal number formatter for the locale, cached per digit count. */
function numberFormatter(locale: string | undefined, digits: number, cache: Map<number, Intl.NumberFormat>): Intl.NumberFormat {
  let f = cache.get(digits);
  if (f === undefined) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    cache.set(digits, f);
  }
  return f;
}

export function mountStatusline(ctx: WidgetContext, host: HTMLElement, opts: StatuslineOptions = {}): StatuslineHandle {
  const doc = ctx.document;
  const chart = ctx.chart;
  const locale = opts.locale ?? ctx.locale;
  host.classList.add('oac-statusline');
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');

  const title = h(doc, 'span', 'oac-statusline__title');
  const sym = h(doc, 'span', 'oac-statusline__sym');
  const iv = h(doc, 'span', 'oac-statusline__iv');
  title.appendChild(sym);
  title.appendChild(iv);
  host.appendChild(title);

  const field = (label: string, cls: string): { el: HTMLElement; val: HTMLElement } => {
    const el = h(doc, 'span', 'oac-statusline__field ' + cls);
    const i = h(doc, 'i');
    i.textContent = label;
    const b = h(doc, 'b');
    el.appendChild(i);
    el.appendChild(b);
    el.hidden = true;
    host.appendChild(el);
    return { el, val: b };
  };
  const open = field('O', 'oac-statusline__o');
  const high = field('H', 'oac-statusline__h');
  const low = field('L', 'oac-statusline__l');
  const close = field('C', 'oac-statusline__c');
  const chg = field('', 'oac-statusline__chg');
  const vol = field('Vol', 'oac-statusline__vol');
  const time = h(doc, 'span', 'oac-statusline__time');
  host.appendChild(time);
  const msg = h(doc, 'span', 'oac-statusline__msg');
  host.appendChild(msg);
  const tz = h(doc, 'span', 'oac-statusline__tz');
  host.appendChild(tz);

  const formats = new Map<number, Intl.NumberFormat>();
  const pct = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 2 });

  let bar: Bar | null = null;
  let barTime: number | null = null;

  const write = (el: HTMLElement, text: string): void => { if (el.textContent !== text) el.textContent = text; };
  const show = (el: HTMLElement, on: boolean): void => { if (el.hidden === on) el.hidden = !on; };

  const paint = (): void => {
    const sw = chart.statusLineOptions();
    show(title, sw.title !== false);
    const values = sw.chartValues !== false && bar !== null;
    for (const f of [open, high, low, close]) show(f.el, values);
    const digits = priceDigits(chart);
    if (values && bar !== null) {
      const fmt = numberFormatter(locale, digits, formats);
      write(open.val, fmt.format(bar.open));
      write(high.val, fmt.format(bar.high));
      write(low.val, fmt.format(bar.low));
      write(close.val, fmt.format(bar.close));
    }
    const change = sw.barChange !== false && bar !== null;
    show(chg.el, change);
    if (change && bar !== null) {
      const d = bar.close - bar.open;
      const p = bar.open !== 0 ? (d / bar.open) * 100 : 0;
      const sign = d > 0 ? '+' : '';
      write(chg.val, `${sign}${numberFormatter(locale, digits, formats).format(d)} (${sign}${pct.format(p)}%)`);
      chg.el.classList.toggle('is-up', d > 0);
      chg.el.classList.toggle('is-down', d < 0);
    }
    const volume = sw.volume !== false && bar !== null && typeof bar.volume === 'number';
    show(vol.el, volume);
    if (volume && bar !== null) write(vol.val, compact.format(bar.volume as number));
    write(time, barTime !== null && bar !== null ? formatZonedCrosshairLabel(barTime, chart.timezone()) : '');
    write(tz, chart.timezone());
  };

  const lastBar = (): { bar: Bar | null; time: number | null } => {
    const data = chart.primarySeries()?.getData() ?? [];
    const last = data[data.length - 1];
    return last === undefined ? { bar: null, time: null } : { bar: last, time: last.time };
  };

  const setBar = (b: Bar | null, t: number | null): void => {
    if (b === bar && t === barTime) return;
    bar = b;
    barTime = t;
    paint();
  };

  const onMove = (payload: unknown): void => {
    const e = payload as CrosshairMoveEvent;
    if (e.bar !== null && e.bar !== undefined) { setBar(e.bar, e.time); return; }
    // The pointer left: the last bar is what the row shows, as the legend does.
    const l = lastBar();
    setBar(l.bar, l.time);
  };
  const off = chart.on('crosshair:move', onMove);
  const offData = chart.on('resize', () => { if (bar === null) { const l = lastBar(); setBar(l.bar, l.time); } });

  const handle: StatuslineHandle = {
    el: host,
    setMessage: (text, kind = 'info') => {
      write(msg, text);
      msg.classList.toggle('is-error', kind === 'error');
    },
    setSymbol: (symbol, exchange, interval) => {
      write(sym, exchange ? `${exchange}:${symbol}` : symbol);
      write(iv, interval);
    },
    setBar,
    refresh: () => {
      if (bar === null) { const l = lastBar(); bar = l.bar; barTime = l.time; }
      paint();
    },
    destroy: () => {
      off();
      offData();
      host.textContent = '';
    },
  };
  paint();
  return handle;
}
