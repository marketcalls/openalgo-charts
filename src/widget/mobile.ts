import { widgetText } from './localization';
import { registeredDrawingTools } from 'openalgo-charts/draw';
import { h, editableIds, historyPress, historyReady, type WidgetContext } from './context';
import type { RailHandle } from './rail';
import {
  chartTypeChoices, chartTypeLabel, intervalLabel,
  brandingLink, type SymbolSearch, type TopbarState,
} from './topbar';
import { mountSymbolPicker, type SymbolPickerHandle } from './symbol-picker';
import { timeBuckets } from './date-navigator';

export type MobileMode = 'auto' | 'always' | 'never';

export interface MobileOptions {
  mode?: MobileMode;
  container: HTMLElement;
  intervals: readonly string[];
  topbar: boolean;
  rail: RailHandle | null;
  tools?: readonly string[];
  indicators: boolean;
  search?: SymbolSearch;
  state(): TopbarState;
  onSymbol(symbol: string, exchange?: string): void;
  onInterval(code: string): void;
  onChartType(id: string): void;
  onTheme(): void;
  onSettings(anchor: HTMLElement): boolean;
  onIndicators(anchor: HTMLElement): boolean;
  onObjects(anchor: HTMLElement): boolean;
  onDataWindow?(anchor: HTMLElement): void | boolean;
  onAlerts?(anchor: HTMLElement): boolean;
  onWatchlist?(anchor: HTMLElement): void | boolean;
  onNews?(anchor: HTMLElement): void | boolean;
  onCapture?(anchor: HTMLElement): void;
  onGoTo?(anchor: HTMLElement): void | boolean;
  onProperties(anchor: HTMLElement): boolean;
  settingsAvailable(): boolean;
  indicatorsAvailable(): boolean;
}

export interface MobileHandle {
  readonly el: HTMLElement;
  active(): boolean;
  refresh(): void;
  destroy(): void;
}

interface OpenSheet {
  close(): void;
  repaint(): void;
}

interface ActionIdentity {
  action: string;
  tool?: string;
  interval?: string;
  chartType?: string;
}

/** Mount the narrow widget controls against the same chart and controllers as the desktop chrome. */
export function mountMobile(ctx: WidgetContext, opts: MobileOptions): MobileHandle {
  const doc = ctx.document;
  const mode = opts.mode ?? 'auto';
  const root = h(doc, 'div', 'oac-mobile');
  ctx.root.appendChild(root);

  let destroyed = false;
  let mobile = false;
  let modeApplied = false;
  let picker: SymbolPickerHandle | null = null;
  let symbolInput: HTMLInputElement | null = null;
  let sheet: OpenSheet | null = null;
  const offs: Array<() => void> = [];

  const stopPointer = (event: Event): void => { event.stopPropagation(); };
  root.addEventListener('pointerdown', stopPointer);

  const makeAction = (name: string, label: string, run: (button: HTMLButtonElement) => void): HTMLButtonElement => {
    const button = h(doc, 'button', 'oac-mobile__action', { type: 'button' });
    button.dataset.mobileAction = name;
    button.textContent = label;
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') !== 'true') run(button);
    });
    return button;
  };

  /**
   * Undo and redo for the whole chart, shown disabled with nothing to take
   * back: the same timeline as the desktop chords and rail.
   */
  const historyActions = (): HTMLButtonElement[] => (['undo', 'redo'] as const).map((direction) => {
    const button = makeAction(direction, widgetText(ctx, direction === 'undo' ? 'Undo' : 'Redo'), () => { historyPress(ctx, direction); refresh(); });
    button.setAttribute('aria-disabled', String(!historyReady(ctx, direction)));
    return button;
  });

  const identityOf = (element: HTMLElement): ActionIdentity | null => {
    const button = element.closest('[data-mobile-action]') as HTMLElement | null;
    const action = button?.dataset.mobileAction;
    if (button === null || action === undefined) return null;
    return {
      action,
      ...(button.dataset.tool === undefined ? {} : { tool: button.dataset.tool }),
      ...(button.dataset.interval === undefined ? {} : { interval: button.dataset.interval }),
      ...(button.dataset.chartType === undefined ? {} : { chartType: button.dataset.chartType }),
    };
  };

  const findIdentity = (host: HTMLElement, identity: ActionIdentity): HTMLElement | null => {
    const candidates = Array.from(host.querySelectorAll('[data-mobile-action]')) as HTMLElement[];
    return candidates.find((button) => button.dataset.mobileAction === identity.action
      && button.dataset.tool === identity.tool
      && button.dataset.interval === identity.interval
      && button.dataset.chartType === identity.chartType) ?? null;
  };

  const closeSheet = (): void => {
    const current = sheet;
    sheet = null;
    current?.close();
  };

  const clearSearch = (): void => picker?.close();

  const openSheet = (
    title: string,
    anchor: HTMLElement,
    paint: (body: HTMLElement, close: () => void) => void,
    initialFocus: HTMLElement | null | undefined = undefined,
  ): void => {
    closeSheet();
    const panel = h(doc, 'section', 'oac-mobile-sheet', { 'aria-label': title });
    const head = h(doc, 'div', 'oac-mobile-sheet__head oac-dialog__head');
    const heading = h(doc, 'strong', 'oac-mobile-sheet__title');
    heading.textContent = title;
    const closeButton = makeAction('close', widgetText(ctx, 'Close'), () => closeSheet());
    head.append(heading, closeButton);
    const body = h(doc, 'div', 'oac-mobile-sheet__body');
    panel.append(head, body);
    const repaint = (): void => {
      if (destroyed || sheet?.repaint !== repaint) return;
      const focused = doc.activeElement as HTMLElement | null;
      const hadBodyFocus = focused !== null && body.contains(focused);
      const identity = hadBodyFocus ? identityOf(focused) : null;
      const scrollTop = body.scrollTop;
      body.textContent = '';
      paint(body, closeSheet);
      body.scrollTop = scrollTop;
      if (hadBodyFocus) {
        const next = identity === null ? null : findIdentity(body, identity);
        (next ?? body.querySelector<HTMLElement>('[data-mobile-action]'))?.focus();
      }
    };
    let closeOverlay: () => void = () => {};
    const entry: OpenSheet = {
      close: () => closeOverlay(),
      repaint,
    };
    sheet = entry;
    paint(body, closeSheet);
    closeOverlay = ctx.openOverlay(panel, {
      anchor,
      placement: 'center',
      dismissOnOutside: true,
      initialFocus,
      onClose: () => { if (sheet === entry) sheet = null; },
    });
  };

  let intervalButton: HTMLButtonElement | null = null;
  if (opts.topbar) {
    const header = h(doc, 'div', 'oac-mobile__header', { role: 'toolbar', 'aria-label': widgetText(ctx, 'Chart header') });
    symbolInput = h(doc, 'input', 'oac-mobile__symbol', {
      type: 'text', 'aria-label': widgetText(ctx, 'Symbol'), placeholder: widgetText(ctx, 'Symbol'), autocomplete: 'off', spellcheck: 'false',
    });
    intervalButton = makeAction('interval', '', (anchor) => {
      openSheet(widgetText(ctx, 'Interval'), anchor, (body, close) => {
        for (const code of opts.intervals) {
          const button = makeAction('pick-interval', intervalLabel(code), () => {
            opts.onInterval(code);
            close();
          });
          button.dataset.interval = code;
          const selected = opts.state().interval === code;
          button.setAttribute('aria-pressed', String(selected));
          body.appendChild(button);
        }
      });
    });
    const commitSymbol = (symbol: string, exchange?: string): void => {
      const value = symbol.trim().toUpperCase();
      clearSearch();
      if (value !== '') opts.onSymbol(value, exchange);
      refresh();
      symbolInput?.blur();
    };
    if (opts.search !== undefined) picker = mountSymbolPicker(ctx, symbolInput, {
      search: opts.search,
      onSelect: commitSymbol,
      context: () => `${opts.state().exchange}:${opts.state().symbol}:${opts.state().interval}`,
      variant: 'mobile',
    });
    symbolInput.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        event.preventDefault();
        commitSymbol(symbolInput?.value ?? '');
      }
    });
    header.append(symbolInput, intervalButton);
    root.appendChild(header);
  }

  const footer = h(doc, 'div', 'oac-mobile__footer');
  const selection = h(doc, 'div', 'oac-mobile__selection', { role: 'toolbar', 'aria-label': widgetText(ctx, 'Selected drawing') });
  let propertiesButton: HTMLButtonElement | null = null;
  let lockButton: HTMLButtonElement | null = null;
  let deleteButton: HTMLButtonElement | null = null;
  if (opts.rail !== null) {
    propertiesButton = makeAction('properties', widgetText(ctx, 'Properties'), (anchor) => { opts.onProperties(anchor); });
    lockButton = makeAction('lock', widgetText(ctx, 'Lock'), () => {
      const ids = ctx.draw.selection();
      const lock = !ids.every((id) => ctx.draw.get(id)?.locked === true);
      for (const id of ids) ctx.draw.update(id, { locked: lock });
      refresh();
    });
    deleteButton = makeAction('delete', widgetText(ctx, 'Delete'), () => {
      ctx.draw.removeMany(ctx.draw.selection());
      refresh();
    });
    selection.append(propertiesButton, lockButton, deleteButton);
    footer.appendChild(selection);
  }

  const bar = h(doc, 'nav', 'oac-mobile__bar', { 'aria-label': widgetText(ctx, 'Chart controls') });
  let drawButton: HTMLButtonElement | null = null;
  let studiesButton: HTMLButtonElement | null = null;
  if (opts.rail !== null) {
    drawButton = makeAction('draw', widgetText(ctx, 'Draw'), (anchor) => {
      openSheet(widgetText(ctx, 'Drawing'), anchor, (body) => {
        const active = ctx.draw.activeTool();
        if (active !== null) {
          const controls = h(doc, 'div', 'oac-mobile-sheet__controls');
          controls.append(
            makeAction('finish', widgetText(ctx, 'Finish'), () => { ctx.draw.finish(); refresh(); }),
            makeAction('cancel', widgetText(ctx, 'Cancel'), () => { ctx.draw.cancel(); refresh(); }),
            ...historyActions(),
            makeAction('magnet', widgetText(ctx, 'Magnet: {mode}', { mode: widgetText(ctx, `schema.magnet.${opts.rail?.magnetMode() ?? 'off'}`, {}, opts.rail?.magnetMode() ?? 'off') }), () => { opts.rail?.cycleMagnet(); refresh(); }),
            makeAction('stay', widgetText(ctx, 'Stay: {mode}', { mode: opts.rail?.stayMode() ? widgetText(ctx, 'on') : widgetText(ctx, 'off') }), () => {
              if (opts.rail !== null) opts.rail.setStayMode(!opts.rail.stayMode());
              refresh();
            }),
          );
          body.appendChild(controls);
        }
        const allowed = opts.tools === undefined ? null : new Set(opts.tools);
        for (const tool of registeredDrawingTools()) {
          if (allowed !== null && !allowed.has(tool.id)) continue;
          const button = makeAction('tool', widgetText(ctx, `schema.drawing.${tool.id}.name`, {}, tool.name), () => {
            ctx.draw.setTool(tool.id);
            closeSheet();
          });
          button.classList.add('oac-mobile__tool');
          button.dataset.tool = tool.id;
          button.setAttribute('aria-pressed', String(active === tool.id));
          body.appendChild(button);
        }
      });
    });
    bar.appendChild(drawButton);
  }
  if (opts.topbar && opts.indicators) {
    studiesButton = makeAction('studies', widgetText(ctx, 'Studies'), (anchor) => { opts.onIndicators(anchor); });
    bar.appendChild(studiesButton);
  }
  if (opts.topbar) {
    bar.appendChild(makeAction('objects', widgetText(ctx, 'Objects'), (anchor) => { opts.onObjects(anchor); }));
    if (opts.onDataWindow) bar.appendChild(makeAction('data-window', widgetText(ctx, 'schema.ui.dataWindow', {}, 'Data'), (anchor) => { opts.onDataWindow?.(anchor); }));
    bar.appendChild(makeAction('more', widgetText(ctx, 'More'), (anchor) => {
      openSheet(widgetText(ctx, 'More'), anchor, (body, close) => {
        // First: a step taken on a narrow screen needs a way back that does not depend on a tool being armed.
        body.append(...historyActions());
        if (opts.onCapture) body.appendChild(makeAction('capture', widgetText(ctx, 'Capture'), () => {
          close();
          opts.onCapture?.(anchor);
        }));
        for (const [key, label, handler] of [['watchlist', 'Watchlist', opts.onWatchlist], ['news', 'News', opts.onNews]] as const) {
          if (handler) body.appendChild(makeAction(key, widgetText(ctx, `schema.ui.dock.${key}`, {}, label), () => { close(); handler(anchor); }));
        }
        if (opts.onAlerts) body.appendChild(makeAction('alerts', widgetText(ctx, 'Alerts'), () => {
          close();
          opts.onAlerts?.(anchor);
        }));
        if (opts.onGoTo) {
          const goTo = makeAction('go-to', widgetText(ctx, 'Go to'), () => {
            close();
            opts.onGoTo?.(anchor);
          });
          goTo.setAttribute('aria-disabled', String(timeBuckets(opts.state().interval) === null));
          body.appendChild(goTo);
        }
        const theme = makeAction('theme', opts.state().theme === 'dark' ? widgetText(ctx, 'Light theme') : widgetText(ctx, 'Dark theme'), () => {
          opts.onTheme();
          close();
        });
        body.appendChild(theme);
        const settings = makeAction('settings', widgetText(ctx, 'Chart settings'), () => {
          close();
          opts.onSettings(anchor);
        });
        settings.setAttribute('aria-disabled', String(!opts.settingsAvailable()));
        body.appendChild(settings);
        const link = brandingLink(ctx.chart, ctx);
        if (link !== null) {
          const branding = h(doc, 'a', 'oac-mobile__action oac-mobile__branding', {
            href: link.href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': link.label,
          });
          branding.dataset.mobileAction = 'branding';
          branding.textContent = link.label;
          body.appendChild(branding);
        }
        const heading = h(doc, 'div', 'oac-head');
        heading.textContent = widgetText(ctx, 'Chart type');
        body.appendChild(heading);
        for (const id of chartTypeChoices()) {
          const button = makeAction('chart-type', widgetText(ctx, `schema.chartType.${id}`, {}, chartTypeLabel(id)), () => {
            opts.onChartType(id);
            close();
          });
          button.dataset.chartType = id;
          button.setAttribute('aria-pressed', String(opts.state().chartType === id));
          body.appendChild(button);
        }
      });
    }));
  }
  if (bar.children.length > 0) footer.appendChild(bar);
  if (footer.children.length > 0) root.appendChild(footer);

  function refresh(): void {
    if (destroyed) return;
    const state = opts.state();
    if (symbolInput !== null && doc.activeElement !== symbolInput) symbolInput.value = state.symbol;
    if (intervalButton !== null) intervalButton.textContent = intervalLabel(state.interval);
    if (drawButton !== null) drawButton.setAttribute('aria-pressed', String(ctx.draw.activeTool() !== null));
    if (studiesButton !== null) studiesButton.setAttribute('aria-disabled', String(!opts.indicatorsAvailable()));
    if (selection.parentNode !== null) {
      const ids = ctx.draw.selection();
      selection.hidden = ids.length === 0;
      // Lock and delete have nothing to act on in a read-only selection.
      const fixed = String(editableIds(ctx.draw, ids).length === 0);
      if (ids.length > 0 && lockButton !== null) {
        const locked = ids.every((id) => ctx.draw.get(id)?.locked === true);
        lockButton.textContent = locked ? widgetText(ctx, 'Unlock') : widgetText(ctx, 'Lock');
        lockButton.setAttribute('aria-pressed', String(locked));
        lockButton.setAttribute('aria-disabled', fixed);
      }
      if (propertiesButton !== null) propertiesButton.setAttribute('aria-disabled', String(ids.length === 0));
      if (deleteButton !== null) deleteButton.setAttribute('aria-disabled', fixed);
    }
    sheet?.repaint();
  }

  const pointerQuery = mode === 'auto' ? doc.defaultView?.matchMedia?.('(pointer: coarse)') ?? null : null;
  const width = (): number => opts.container.getBoundingClientRect().width || opts.container.clientWidth;
  const applyMode = (): void => {
    const next = mode === 'always' || (mode === 'auto' && (width() <= 640 || pointerQuery?.matches === true));
    if (modeApplied && next === mobile) return;
    modeApplied = true;
    mobile = next;
    ctx.root.classList.toggle('is-mobile', mobile);
    ctx.root.dataset.mobile = String(mobile);
    root.hidden = !mobile;
    if (!mobile) { closeSheet(); clearSearch(); }
  };

  const Observer = (doc.defaultView as (Window & typeof globalThis) | null)?.ResizeObserver;
  let observer: ResizeObserver | null = null;
  if (mode === 'auto' && Observer !== undefined) {
    observer = new Observer(applyMode);
    observer.observe(opts.container);
  } else if (mode === 'auto') {
    const win = doc.defaultView;
    if (win !== null && typeof win.addEventListener === 'function') {
      win.addEventListener('resize', applyMode);
      offs.push(() => win.removeEventListener('resize', applyMode));
    }
  }
  if (pointerQuery !== null) {
    if (typeof pointerQuery.addEventListener === 'function') {
      pointerQuery.addEventListener('change', applyMode);
      offs.push(() => pointerQuery.removeEventListener('change', applyMode));
    } else {
      pointerQuery.addListener(applyMode);
      offs.push(() => pointerQuery.removeListener(applyMode));
    }
  }

  for (const event of ['draw:tool', 'draw:select', 'drawing:select', 'drawing:change', 'draw:add', 'draw:remove', 'draw:update']) {
    offs.push(ctx.chart.on(event, refresh));
  }
  if (ctx.history !== undefined) offs.push(ctx.history.subscribe(refresh));
  offs.push(ctx.bus.on('symbol', refresh));
  offs.push(ctx.bus.on('interval', refresh));
  offs.push(ctx.bus.on('theme', refresh));
  offs.push(ctx.chart.on('branding:changed', refresh));
  applyMode();
  refresh();

  return {
    el: root,
    active: () => mobile,
    refresh,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      picker?.destroy();
      closeSheet();
      observer?.disconnect();
      observer = null;
      for (const off of offs.splice(0)) off();
      root.removeEventListener('pointerdown', stopPointer);
      root.remove();
      ctx.root.classList.remove('is-mobile');
      delete ctx.root.dataset.mobile;
    },
  };
}
