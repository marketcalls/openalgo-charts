import { registeredDrawingTools } from 'openalgo-charts/draw';
import { h, type WidgetContext } from './context';
import type { RailHandle } from './rail';
import {
  SEARCH_DEBOUNCE_MS, chartTypeChoices, chartTypeLabel, intervalLabel,
  brandingLink, type SymbolMatch, type SymbolSearch, type TopbarState,
} from './topbar';

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

let mobileSearchId = 0;

/** Mount the narrow widget controls against the same chart and controllers as the desktop chrome. */
export function mountMobile(ctx: WidgetContext, opts: MobileOptions): MobileHandle {
  const doc = ctx.document;
  const mode = opts.mode ?? 'auto';
  const root = h(doc, 'div', 'oac-mobile');
  ctx.root.appendChild(root);

  let destroyed = false;
  let mobile = false;
  let modeApplied = false;
  let searchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let searchSequence = 0;
  let searchQuery: string | null = null;
  let searchPanel: HTMLElement | null = null;
  let searchList: HTMLElement | null = null;
  let searchClose: (() => void) | null = null;
  let closingSearch = false;
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

  const invalidateSearch = (): void => {
    if (searchTimer !== 0) { clearTimeout(searchTimer); searchTimer = 0; }
    searchSequence++;
    searchQuery = null;
  };

  const clearSearch = (): void => {
    invalidateSearch();
    const close = searchClose;
    searchClose = null;
    searchPanel = null;
    searchList = null;
    symbolInput?.setAttribute('aria-expanded', 'false');
    symbolInput?.removeAttribute('aria-controls');
    if (close !== null) {
      closingSearch = true;
      close();
      closingSearch = false;
    }
  };

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
    const closeButton = makeAction('close', 'Close', () => closeSheet());
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
    const header = h(doc, 'div', 'oac-mobile__header', { role: 'toolbar', 'aria-label': 'Chart header' });
    symbolInput = h(doc, 'input', 'oac-mobile__symbol', {
      type: 'text', 'aria-label': 'Symbol', placeholder: 'Symbol', autocomplete: 'off', spellcheck: 'false',
    });
    if (opts.search !== undefined) {
      symbolInput.setAttribute('aria-autocomplete', 'list');
      symbolInput.setAttribute('aria-haspopup', 'listbox');
      symbolInput.setAttribute('aria-expanded', 'false');
    }
    intervalButton = makeAction('interval', '', (anchor) => {
      openSheet('Interval', anchor, (body, close) => {
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
    const ensureSearchPanel = (): HTMLElement => {
      if (searchPanel !== null) return searchPanel;
      const panel = h(doc, 'section', 'oac-mobile-results', { role: 'region', 'aria-label': 'Symbol search results' });
      const head = h(doc, 'div', 'oac-mobile-results__head');
      const title = h(doc, 'strong');
      title.textContent = 'Symbols';
      head.append(title, makeAction('close-search', 'Close', () => clearSearch()));
      const list = h(doc, 'div', 'oac-mobile-results__list', { role: 'listbox' });
      list.id = `oac-mobile-results-${++mobileSearchId}`;
      panel.append(head, list);
      searchPanel = panel;
      searchList = list;
      symbolInput?.setAttribute('aria-controls', list.id);
      let entryClose: () => void = () => {};
      entryClose = ctx.openOverlay(panel, {
        anchor: symbolInput ?? undefined,
        placement: 'below',
        initialFocus: null,
        dismissOnOutside: true,
        onClose: () => {
          if (searchPanel === panel) {
            searchPanel = null;
            searchList = null;
            searchClose = null;
          }
          symbolInput?.setAttribute('aria-expanded', 'false');
          symbolInput?.removeAttribute('aria-controls');
          if (!closingSearch) invalidateSearch();
        },
      });
      searchClose = entryClose;
      return panel;
    };
    const showSearching = (): void => {
      ensureSearchPanel();
      if (searchList === null) return;
      searchList.textContent = '';
      const status = h(doc, 'div', 'oac-mobile-results__status', { role: 'status' });
      status.textContent = 'Searching';
      searchList.appendChild(status);
    };
    const showMatches = (matches: readonly SymbolMatch[]): void => {
      if (matches.length === 0) { clearSearch(); return; }
      ensureSearchPanel();
      if (searchList === null) return;
      searchList.textContent = '';
      for (const match of matches) {
        const label = match.exchange ? `${match.exchange}:${match.symbol}` : match.symbol;
        const button = makeAction('pick-symbol', label, () => commitSymbol(match.symbol, match.exchange));
        button.setAttribute('role', 'option');
        if (match.name) {
          const detail = h(doc, 'small');
          detail.textContent = match.name;
          button.appendChild(detail);
        }
        searchList.appendChild(button);
      }
    };
    symbolInput.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        event.preventDefault();
        commitSymbol(symbolInput?.value ?? '');
      }
    });
    if (opts.search !== undefined) {
      symbolInput.addEventListener('input', () => {
        invalidateSearch();
        const query = symbolInput?.value.trim() ?? '';
        if (query === '') { clearSearch(); return; }
        const sequence = ++searchSequence;
        searchQuery = query;
        showSearching();
        searchTimer = setTimeout(() => {
          searchTimer = 0;
          Promise.resolve(opts.search?.(query) ?? []).then((matches) => {
            const active = doc.activeElement as HTMLElement | null;
            const interactionActive = active === symbolInput || (active !== null && searchPanel?.contains(active) === true);
            if (!destroyed && mobile && sequence === searchSequence && searchQuery === query
              && symbolInput?.value.trim() === query && interactionActive) showMatches(matches);
          }).catch(() => {
            if (sequence === searchSequence && searchQuery === query) clearSearch();
          });
        }, SEARCH_DEBOUNCE_MS);
      });
      symbolInput.addEventListener('blur', (event) => {
        const next = (event as FocusEvent).relatedTarget as Node | null;
        if (next === null || searchPanel?.contains(next) !== true) clearSearch();
      });
    }
    header.append(symbolInput, intervalButton);
    root.appendChild(header);
  }

  const footer = h(doc, 'div', 'oac-mobile__footer');
  const selection = h(doc, 'div', 'oac-mobile__selection', { role: 'toolbar', 'aria-label': 'Selected drawing' });
  let propertiesButton: HTMLButtonElement | null = null;
  let lockButton: HTMLButtonElement | null = null;
  let deleteButton: HTMLButtonElement | null = null;
  if (opts.rail !== null) {
    propertiesButton = makeAction('properties', 'Properties', (anchor) => { opts.onProperties(anchor); });
    lockButton = makeAction('lock', 'Lock', () => {
      const ids = ctx.draw.selection();
      const lock = !ids.every((id) => ctx.draw.get(id)?.locked === true);
      for (const id of ids) ctx.draw.update(id, { locked: lock });
      refresh();
    });
    deleteButton = makeAction('delete', 'Delete', () => {
      ctx.draw.removeMany(ctx.draw.selection());
      refresh();
    });
    selection.append(propertiesButton, lockButton, deleteButton);
    footer.appendChild(selection);
  }

  const bar = h(doc, 'nav', 'oac-mobile__bar', { 'aria-label': 'Chart controls' });
  let drawButton: HTMLButtonElement | null = null;
  let studiesButton: HTMLButtonElement | null = null;
  if (opts.rail !== null) {
    drawButton = makeAction('draw', 'Draw', (anchor) => {
      openSheet('Drawing', anchor, (body) => {
        const active = ctx.draw.activeTool();
        if (active !== null) {
          const controls = h(doc, 'div', 'oac-mobile-sheet__controls');
          controls.append(
            makeAction('finish', 'Finish', () => { ctx.draw.finish(); refresh(); }),
            makeAction('cancel', 'Cancel', () => { ctx.draw.cancel(); refresh(); }),
            makeAction('undo', 'Undo', () => { ctx.draw.undo(); refresh(); }),
            makeAction('magnet', `Magnet: ${opts.rail?.magnetMode() ?? 'off'}`, () => { opts.rail?.cycleMagnet(); refresh(); }),
            makeAction('stay', `Stay: ${opts.rail?.stayMode() ? 'on' : 'off'}`, () => {
              if (opts.rail !== null) opts.rail.setStayMode(!opts.rail.stayMode());
              refresh();
            }),
          );
          body.appendChild(controls);
        }
        const allowed = opts.tools === undefined ? null : new Set(opts.tools);
        for (const tool of registeredDrawingTools()) {
          if (allowed !== null && !allowed.has(tool.id)) continue;
          const button = makeAction('tool', tool.name, () => {
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
    studiesButton = makeAction('studies', 'Studies', (anchor) => { opts.onIndicators(anchor); });
    bar.appendChild(studiesButton);
  }
  if (opts.topbar) {
    bar.appendChild(makeAction('objects', 'Objects', (anchor) => { opts.onObjects(anchor); }));
    bar.appendChild(makeAction('more', 'More', (anchor) => {
      openSheet('More', anchor, (body, close) => {
        const theme = makeAction('theme', opts.state().theme === 'dark' ? 'Light theme' : 'Dark theme', () => {
          opts.onTheme();
          close();
        });
        body.appendChild(theme);
        const settings = makeAction('settings', 'Chart settings', () => {
          close();
          opts.onSettings(anchor);
        });
        settings.setAttribute('aria-disabled', String(!opts.settingsAvailable()));
        body.appendChild(settings);
        const link = brandingLink(ctx.chart);
        if (link !== null) {
          const branding = h(doc, 'a', 'oac-mobile__action oac-mobile__branding', {
            href: link.href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': link.label,
          });
          branding.dataset.mobileAction = 'branding';
          branding.textContent = link.label;
          body.appendChild(branding);
        }
        const heading = h(doc, 'div', 'oac-head');
        heading.textContent = 'Chart type';
        body.appendChild(heading);
        for (const id of chartTypeChoices()) {
          const button = makeAction('chart-type', chartTypeLabel(id), () => {
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
      if (ids.length > 0 && lockButton !== null) {
        const locked = ids.every((id) => ctx.draw.get(id)?.locked === true);
        lockButton.textContent = locked ? 'Unlock' : 'Lock';
        lockButton.setAttribute('aria-pressed', String(locked));
      }
      if (propertiesButton !== null) propertiesButton.setAttribute('aria-disabled', String(ids.length === 0));
      if (deleteButton !== null) deleteButton.setAttribute('aria-disabled', String(ids.length === 0));
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
      clearSearch();
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
