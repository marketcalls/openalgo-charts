/**
 * The chart grid: several widgets in one workspace.
 *
 * `createChartGrid(container, options)` lays one widget out per cell on a rows
 * by columns grid, puts splitters between the tracks, keeps one cell active,
 * links the charts through the engine's link group, and reads and writes the
 * portable payload of `openalgo-charts/workspace`, so a saved desk opens here
 * with the geometry, weights, focus and links it was saved with.
 *
 * Four decisions worth recording:
 *
 * - **Every cell is an ordinary widget.** The grid adds layout, focus and
 *   linking around them and reaches each one through its public API, so a
 *   cell loads, cancels and tears down its own feed exactly as a lone widget.
 * - **One active cell answers the keyboard.** Every widget listens on the
 *   document, so without a referee one chord reaches each chart the pointer or
 *   the focus happens to touch. Other cells are silenced through
 *   `keyboardRoute`, and a key pressed with the focus on the page itself goes
 *   to the active chart while the pointer is over the grid.
 * - **Applying a workspace is all or nothing.** The new cells are built and
 *   restored off to the side; the first failure destroys them, which cancels
 *   their history requests, and the charts on screen are never touched.
 * - **A view set by data is not a pan.** A chart fitting bars it has just
 *   received moves its window, and broadcasting that to a follower on another
 *   timeframe would squeeze the follower's data into a sliver. Data-driven
 *   moves stay local; linked views converge on the next real pan or zoom.
 */
import {
  applyChartSettings, createLinkGroup, isKnownInterval, readChartSettings, registeredChartTypes, registeredIndicators,
  type ChartTheme, type DataFeed, type DataVariant, type LinkChart, type LinkOptions, type ResolvedLinkOptions,
} from 'openalgo-charts';
import type { WorkspaceChartState, WorkspacePane, WorkspacePayload } from 'openalgo-charts/workspace';
import { WidgetBus, WidgetStorage, defaultStorage, h, type StorageLike } from './context';
import { widgetText } from './localization';
import { applyTokens, widgetTokens, type WidgetThemeName } from './tokens';
import { createWidget, resolveTheme, SAVE_DEBOUNCE_MS, type Widget, type WidgetOptions } from './widget';

/** Rows by columns. Every preset fills its grid without spans. */
export type ChartGridPreset = '1x1' | '1x2' | '1x3' | '2x1' | '3x1' | '2x2';

/** Rows and columns of each preset, in the order a picker lists them. */
export const CHART_GRID_PRESETS: Readonly<Record<ChartGridPreset, readonly [rows: number, columns: number]>> = {
  '1x1': [1, 1], '1x2': [1, 2], '1x3': [1, 3], '2x1': [2, 1], '3x1': [3, 1], '2x2': [2, 2],
};

export interface ChartGridOptions extends Omit<WidgetOptions, 'persist' | 'storage' | 'keyboardRoute' | 'feed'> {
  /**
   * Where the charts load bars: one feed for every chart, or a function that
   * builds each chart's feed from its pane id and the `historyPeriod` its
   * workspace pane carries, for a host whose source answers by period.
   */
  feed?: DataFeed | ((chart: { readonly id: string; readonly historyPeriod?: string }) => DataFeed);
  /** The layout to start with when nothing is restored. Default `1x1`. */
  preset?: ChartGridPreset;
  /** Link channels to start with. Default: crosshair and viewport on, the rest off. */
  links?: LinkOptions;
  /** At or below this width in CSS px only the active chart shows, with tabs to switch. 0 turns it off. Default 640. */
  compactWidth?: number;
  /** Keep the workspace between visits: `true` for one shared namespace, a string to name one. Default off. */
  persist?: boolean | string;
  /** The store behind `persist`. Default: the page's `localStorage`. */
  storage?: StorageLike | null;
}

export interface ChartGridCell {
  /** The workspace pane id. */
  readonly id: string;
  readonly widget: Widget;
  /** The `.oac-grid__cell` element the widget lives in. */
  readonly element: HTMLElement;
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  /**
   * The host's name for how much history the chart loads, from the applied
   * workspace pane or the active chart a preset copied. The grid only keeps it
   * and writes it back; a `feed` function is what honours it.
   */
  readonly historyPeriod?: string;
}

export interface ChartGridLayout {
  rows: number;
  columns: number;
  /** The preset or saved preset name the layout came from, or null. */
  preset: string | null;
  rowWeights: number[];
  columnWeights: number[];
}

export interface ChartGridApplyReport {
  applied: boolean;
  reason?: string;
}

export interface ChartGridEvents {
  active: { id: string };
  /** `preset`, `weights`, `workspace` or `compact`. */
  layout: { reason: string };
  links: ResolvedLinkOptions;
  /** Every chart changed theme, through `setTheme` or one chart's own control. */
  theme: { theme: WidgetThemeName };
  [key: string]: unknown;
}

export type ChartGridEventName = 'active' | 'layout' | 'links' | 'theme';

export interface ChartGrid {
  /** The `.oac-grid` element. */
  readonly root: HTMLElement;
  readonly isDestroyed: boolean;
  /** The cells in reading order: by row, then by column. */
  cells(): readonly ChartGridCell[];
  active(): ChartGridCell;
  /** Make a cell the one the keyboard and shared controls act on. False for an unknown id. */
  setActive(id: string, options?: { focus?: boolean }): boolean;
  layout(): ChartGridLayout;
  /**
   * What restoring the persisted workspace did when the grid was built: null
   * when nothing was stored. A refused desk stays stored, untouched, until the
   * user changes the grid.
   */
  restored(): ChartGridApplyReport | null;
  /** Reflow into a preset: surviving charts keep their state, new ones copy the active chart's instrument. */
  setPreset(preset: ChartGridPreset): void;
  linkOptions(): ResolvedLinkOptions;
  /** Switching symbol or interval linking on adopts the active chart's choice. */
  setLinks(patch: LinkOptions): void;
  theme(): WidgetThemeName;
  setTheme(theme: WidgetThemeName | ChartTheme): void;
  /** Whether the grid is narrow enough to show one chart at a time. */
  compact(): boolean;
  getWorkspace(): WorkspacePayload;
  /** Replace every chart with a validated payload, or change nothing and say why. */
  applyWorkspace(payload: WorkspacePayload): ChartGridApplyReport;
  on<K extends ChartGridEventName>(event: K, cb: (payload: ChartGridEvents[K]) => void): () => void;
  destroy(): void;
}

interface Cell {
  id: string;
  widget: Widget;
  element: HTMLElement;
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  historyPeriod?: string;
  member: LinkChart;
  offs: Array<() => void>;
  /** Bars across the window the chart showed last, 0 while it had no plot. */
  span: number;
}

interface Source { symbol?: string; exchange?: string; interval?: string; variant?: DataVariant; chartType?: string; historyPeriod?: string }
type Axis = 'row' | 'column';

/** Pixels between tracks, and the track a splitter sits in. */
const GUTTER = 4;
/** The smaller of two resized tracks keeps at least this share of the pair. */
const MIN_SHARE = 0.15;
const STATE_KEY = 'grid';
const THEME_SETTING = 'widget.theme';
const GRID_ONLY_KEYS = ['preset', 'links', 'compactWidth', 'persist', 'storage'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown, lo: number, hi: number): boolean => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const round = (v: number): number => Math.round(v * 1e4) / 1e4;
const ones = (n: number): number[] => Array.from({ length: n }, () => 1);
const tracks = (weights: readonly number[]): string => weights.map(w => `minmax(0,${w}fr)`).join(` ${GUTTER}px `);
/**
 * An instrument as the one string the link group compares. The exchange rides
 * inside it: one ticker on two exchanges is two instruments, and a bare ticker
 * would let a change of exchange alone pass the followers by.
 */
const instrument = (symbol: string, exchange: string): string => JSON.stringify([symbol, exchange]);

/** What a grid cannot honour, checked before anything is built. Empty when the payload is usable. */
function check(p: WorkspacePayload): string {
  if (!isRecord(p) || !isRecord(p.layout) || !Array.isArray(p.layout.slots) || !Array.isArray(p.panes) || !isRecord(p.sync)) {
    return 'not a workspace payload';
  }
  const { rows, columns, slots } = p.layout;
  if (!int(rows, 1, 8) || !int(columns, 1, 8) || !int(p.panes.length, 1, 16)) return 'unsupported grid size';
  for (const [weights, count] of [[p.layout.rowWeights, rows], [p.layout.columnWeights, columns]] as const) {
    if (weights !== undefined && (!Array.isArray(weights) || weights.length !== count
      || !weights.every(w => typeof w === 'number' && w > 0 && w <= 1000))) return 'invalid track weights';
  }
  const studies = new Set(registeredIndicators().map(d => d.id));
  const ids = new Set<string>();
  for (const pane of p.panes) {
    if (!isRecord(pane) || typeof pane.id !== 'string' || pane.id === '' || ids.has(pane.id)) return 'invalid or duplicate chart id';
    ids.add(pane.id);
    if (typeof pane.symbol !== 'string' || typeof pane.exchange !== 'string' || !isRecord(pane.chart)
      || !['string', 'undefined'].includes(typeof pane.historyPeriod)) return `${pane.id}: invalid chart`;
    if (!isKnownInterval(pane.interval)) return `${pane.id}: unknown interval ${String(pane.interval)}`;
    if (!registeredChartTypes().includes(pane.chartType)) return `${pane.id}: unknown chart type ${String(pane.chartType)}`;
    if (Array.isArray(pane.comparisons) && pane.comparisons.length > 0) return `${pane.id}: comparison symbols are not supported in a grid chart`;
    for (const study of Array.isArray(pane.chart.indicators) ? pane.chart.indicators : []) {
      if (!studies.has(study?.indicatorId)) return `${pane.id}: unavailable study ${String(study?.indicatorId)}`;
    }
  }
  const placed = new Set<string>();
  const taken = new Set<number>();
  for (const slot of slots) {
    const rowSpan = slot?.rowSpan ?? 1, columnSpan = slot?.columnSpan ?? 1;
    if (!isRecord(slot) || !ids.has(slot.paneId) || placed.has(slot.paneId) || !int(slot.row, 0, rows - 1) || !int(slot.column, 0, columns - 1)
      || !int(rowSpan, 1, rows - slot.row) || !int(columnSpan, 1, columns - slot.column)) return 'invalid layout slot';
    placed.add(slot.paneId);
    for (let r = slot.row; r < slot.row + rowSpan; r++) for (let c = slot.column; c < slot.column + columnSpan; c++) {
      if (taken.has(r * columns + c)) return 'layout slots overlap';
      taken.add(r * columns + c);
    }
  }
  if (placed.size !== ids.size) return 'every chart needs one layout slot';
  if (!ids.has(p.activePaneId)) return 'the active chart is missing';
  // Joining a linked group converges its members, which would overwrite a
  // chart saved on another instrument, so a disagreeing document is refused.
  if (p.sync.symbol && new Set(p.panes.map(x => instrument(x.symbol, x.exchange))).size > 1) return 'linked symbols differ between charts';
  if (p.sync.interval && new Set(p.panes.map(x => x.interval)).size > 1) return 'linked intervals differ between charts';
  return '';
}

/**
 * Build a chart grid inside `container`: an element, or a selector resolved
 * against `options.document` or the page.
 */
export function createChartGrid(container: HTMLElement | string, options: ChartGridOptions = {}): ChartGrid {
  if (typeof container === 'string') {
    const found = (options.document ?? (globalThis as { document?: Document }).document)?.querySelector<HTMLElement>(container);
    if (!found) throw new Error(`openalgo-charts grid: no element matches "${container}"`);
    container = found;
  }
  const doc = options.document ?? container.ownerDocument;
  const cellOptions = { ...options } as Record<string, unknown>;
  for (const key of GRID_ONLY_KEYS) delete cellOptions[key];
  // A cell in a two-column grid is often narrower than the phone threshold,
  // so cells keep desktop chrome unless the host asks for touch controls.
  Object.assign(cellOptions, { document: doc, mobile: options.mobile ?? 'never' });
  const store = options.persist ? (options.storage === undefined ? defaultStorage() : options.storage) : null;
  const storage = new WidgetStorage(typeof options.persist === 'string' ? options.persist : 'default', store);
  const bus = new WidgetBus<ChartGridEvents>();
  const links = createLinkGroup(options.links);
  const offs: Array<() => void> = [];
  let cells: Cell[] = [];
  let active: Cell | null = null;
  const splits: HTMLElement[] = [];
  let rows = 1, cols = 1, rowW = [1], colW = [1];
  let preset: string | null = null;
  let theme: WidgetThemeName | ChartTheme = options.theme ?? 'dark';
  let themeSync = false, compact = false, pointerIn = false, destroyed = false;
  /** True while the grid itself moves a chart's window, which is no user navigation. */
  let syncing = false;
  /**
   * The linked window as wall-clock times, set by the last navigation while
   * viewports were linked, and the chart it is read from: new bars there move
   * it along, so it never goes stale behind a chart following the right edge.
   */
  let view: { from: number; to: number } | null = null;
  let keeper: Cell | null = null;
  let nextId = 0;
  let saveTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let saveQueued = false;
  /** A stored desk this grid refused to restore, kept until the user changes something. */
  let held = false;
  let restored: ChartGridApplyReport | null = null;

  const root = h(doc, 'div', 'oac-grid');
  const tabs = h(doc, 'div', 'oac-grid__tabs', { role: 'tablist', 'aria-label': widgetText(options, 'Charts') });
  const body = h(doc, 'div', 'oac-grid__cells');
  tabs.hidden = true;
  root.append(tabs, body);

  const emit = <K extends ChartGridEventName>(event: K, payload: ChartGridEvents[K]): void => bus.emit(event, payload);
  /** A stream of changes (a pan, a zoom, a drag) settles before it is written. */
  const scheduleSave = (): void => {
    held = false;
    if (!storage.enabled || destroyed) return;
    if (saveTimer !== 0) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  };
  /**
   * A discrete change (a preset, a link, an instrument) is written before the
   * task ends. A write left to a timer or to the unload flush can be lost when
   * the page reloads at once: one browser engine was seen to drop storage
   * writes made while the page unloads.
   */
  const saveSoon = (): void => {
    held = false;
    if (!storage.enabled || destroyed || saveQueued) return;
    saveQueued = true;
    queueMicrotask(() => { saveQueued = false; saveNow(); });
  };
  function saveNow(): void {
    if (saveTimer !== 0) { clearTimeout(saveTimer); saveTimer = 0; }
    if (storage.enabled && !destroyed && !held && active !== null) storage.set(STATE_KEY, grid.getWorkspace());
  }
  const paintTheme = (): void => {
    const t = resolveTheme(theme);
    root.dataset.theme = t.name;
    applyTokens(root, widgetTokens(t.theme, t.name));
  };

  // ── focus ──────────────────────────────────────────────────────────────
  /**
   * Who answers a key. A cell that is not active never does. The active one
   * takes the key outright when the focus is on the page itself and the
   * pointer is over the grid; a focused splitter or tab keeps its own keys;
   * anything else is the widget's usual pointer-or-focus decision.
   */
  const route = (cell: Cell): boolean | undefined => {
    if (cell !== active) return false;
    const focus = doc.activeElement;
    if (focus === null || focus === doc.body || focus === doc.documentElement) return pointerIn ? true : undefined;
    return root.contains(focus) && !cells.some(c => c.element.contains(focus)) ? false : undefined;
  };

  const syncCompact = (): void => {
    for (const c of cells) c.element.hidden = compact && c !== active;
    for (const split of splits) split.hidden = compact;
    tabs.hidden = !compact || cells.length < 2;
    tabs.replaceChildren(...(tabs.hidden ? [] : cells.map(c => {
      const tab = h(doc, 'button', 'oac-grid__tab', { type: 'button', role: 'tab', 'aria-selected': String(c === active) });
      tab.textContent = `${c.widget.symbol()} ${c.widget.interval()}`.trim();
      tab.addEventListener('click', () => grid.setActive(c.id, { focus: true }));
      return tab;
    })));
  };

  const markActive = (): void => {
    for (const c of cells) {
      c.element.dataset.active = String(c === active);
      if (c === active) c.element.setAttribute('aria-current', 'true');
      else c.element.removeAttribute('aria-current');
    }
    syncCompact();
  };

  const measure = (): void => {
    if (destroyed) return;
    const width = root.getBoundingClientRect().width;
    const limit = options.compactWidth ?? 640;
    // Zero means not laid out yet (hidden, or not in the document): no verdict.
    const next = limit > 0 && width > 0 && width <= limit;
    root.dataset.compact = String(next);
    if (next === compact) return;
    compact = next;
    syncCompact();
    emit('layout', { reason: 'compact' });
  };

  // ── splitters ──────────────────────────────────────────────────────────
  const valueNow = (split: HTMLElement): void => {
    const w = split.dataset.axis === 'column' ? colW : rowW;
    const b = Number(split.dataset.index);
    split.setAttribute('aria-valuenow', String(Math.round(w[b] / (w[b] + w[b + 1]) * 100)));
  };

  const resize = (axis: Axis, b: number, first: number, dragging = false): void => {
    const w = (axis === 'column' ? colW : rowW).slice();
    const pair = w[b] + w[b + 1];
    const next = round(Math.min(pair * (1 - MIN_SHARE), Math.max(pair * MIN_SHARE, first)));
    if (next === w[b]) return;
    w[b] = next;
    w[b + 1] = round(pair - next);
    if (axis === 'column') { colW = w; body.style.gridTemplateColumns = tracks(w); }
    else { rowW = w; body.style.gridTemplateRows = tracks(w); }
    splits.forEach(valueNow);
    if (dragging) scheduleSave();
    else saveSoon();
    emit('layout', { reason: 'weights' });
  };

  const splitter = (axis: Axis, b: number, area: string): void => {
    const col = axis === 'column';
    const split = h(doc, 'div', 'oac-grid__split', {
      role: 'separator', tabindex: '0', 'aria-orientation': col ? 'vertical' : 'horizontal',
      'aria-label': widgetText(options, col ? 'Resize columns {first} and {second}' : 'Resize rows {first} and {second}', { first: b + 1, second: b + 2 }),
      'aria-valuemin': '15', 'aria-valuemax': '85',
    });
    split.dataset.axis = axis;
    split.dataset.index = String(b);
    split.style.gridArea = area;
    const weights = (): number[] => (col ? colW : rowW);
    split.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = body.getBoundingClientRect();
      const w = weights();
      const size = (col ? rect.width : rect.height) - GUTTER * (w.length - 1);
      const total = w.reduce((a, v) => a + v, 0);
      const start = col ? e.clientX : e.clientY;
      const first = w[b];
      split.setPointerCapture?.(e.pointerId);
      split.classList.add('is-drag');
      const move = (m: PointerEvent): void => {
        if (size > 0) resize(axis, b, first + ((col ? m.clientX : m.clientY) - start) / size * total, true);
      };
      const end = (): void => {
        // The drag is over, so its last weights are written now, not after the debounce.
        if (saveTimer !== 0) saveNow();
        split.classList.remove('is-drag');
        split.removeEventListener('pointermove', move);
        split.removeEventListener('pointerup', end);
        split.removeEventListener('pointercancel', end);
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', end);
      split.addEventListener('pointercancel', end);
    });
    split.addEventListener('keydown', (e: KeyboardEvent) => {
      const dir = (col ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']).indexOf(e.key);
      if (dir < 0) return;
      // Claimed here so neither the charts' keymaps nor the engine pan with it.
      e.preventDefault();
      e.stopPropagation();
      const w = weights();
      resize(axis, b, w[b] + (dir * 2 - 1) * (w[b] + w[b + 1]) * (e.shiftKey ? 0.2 : 0.05));
    });
    split.addEventListener('dblclick', () => { const w = weights(); resize(axis, b, (w[b] + w[b + 1]) / 2); });
    split.hidden = compact;
    body.appendChild(split);
    splits.push(split);
    valueNow(split);
  };

  /** One splitter per run of tracks a boundary separates; a spanning chart interrupts the run. */
  const splitters = (axis: Axis): void => {
    const col = axis === 'column';
    const across = col ? rows : cols;
    for (let b = 0; b < (col ? cols : rows) - 1; b++) {
      let start = -1;
      for (let i = 0; i <= across; i++) {
        const open = i < across && !cells.some(c => {
          const [lo, len, at, span] = col ? [c.column, c.columnSpan, c.row, c.rowSpan] : [c.row, c.rowSpan, c.column, c.columnSpan];
          return lo <= b && lo + len > b + 1 && at <= i && at + span > i;
        });
        if (open && start < 0) start = i;
        if (!open && start >= 0) {
          // Grid lines, with a gutter track between every two chart tracks.
          const [from, to, gap] = [2 * start + 1, 2 * i, 2 * b + 2];
          splitter(axis, b, (col ? [from, gap, to, gap + 1] : [gap, from, gap + 1, to]).join(' / '));
          start = -1;
        }
      }
    }
  };

  const render = (): void => {
    body.style.gridTemplateColumns = tracks(colW);
    body.style.gridTemplateRows = tracks(rowW);
    cells.forEach((c, i) => {
      c.element.style.gridArea = `${2 * c.row + 1} / ${2 * c.column + 1} / ${2 * (c.row + c.rowSpan)} / ${2 * (c.column + c.columnSpan)}`;
      c.element.setAttribute('aria-label', widgetText(options, 'Chart {index}', { index: i + 1 }));
      if (c.element.parentNode !== body) body.appendChild(c.element);
    });
    for (const split of splits.splice(0)) split.remove();
    splitters('column');
    splitters('row');
    root.dataset.single = String(cells.length === 1);
    markActive();
  };

  // ── cells ──────────────────────────────────────────────────────────────
  const makeCell = (id: string, source: Source, parent: HTMLElement, cellTheme: WidgetThemeName | ChartTheme): Cell => {
    const element = h(doc, 'div', 'oac-grid__cell', { role: 'group' });
    element.dataset.paneId = id;
    parent.appendChild(element);
    const { historyPeriod } = source, feed = options.feed;
    const cell = { id, element, row: 0, column: 0, rowSpan: 1, columnSpan: 1, offs: [], span: 0, historyPeriod } as unknown as Cell;
    try {
      cell.widget = createWidget(element, {
        ...cellOptions, theme: cellTheme, symbol: source.symbol, exchange: source.exchange, interval: source.interval,
        variant: source.variant, chartType: source.chartType, keyboardRoute: () => route(cell),
        feed: typeof feed === 'function' ? feed({ id, historyPeriod }) : feed,
      });
    } catch (error) {
      element.remove();
      throw error;
    }
    return cell;
  };

  const forget = (): void => { view = null; keeper = null; };
  /** A chart with no plot shows an empty window, and has none to give. */
  const span = (cell: Cell): number => {
    const range = cell.widget.chart.getVisibleLogicalRange();
    return range.to - range.from;
  };
  const keep = (cell: Cell): void => {
    const chart = cell.widget.chart, range = chart.getVisibleLogicalRange(), data = chart.dataLayer;
    const from = data.indexToTimeFloat(range.from), to = data.indexToTimeFloat(range.to);
    if (to > from) { view = { from, to }; keeper = cell; }
  };

  /**
   * After a resize a linked chart shows the window it showed before. The
   * engine keeps its right edge, so a chart following new bars goes on
   * following them; putting its span back, rather than its bar width, keeps
   * charts of different widths on the same window. A chart that had no plot
   * (hidden behind the compact tabs) had no window, and takes the linked one.
   * Before any linked navigation there is no shared window, and a resize is
   * left to the engine.
   */
  const fit = (cell: Cell): void => {
    const chart = cell.widget.chart, range = chart.getVisibleLogicalRange(), data = chart.dataLayer, had = cell.span;
    const linked = links.options().viewport ? view : null;
    if (linked !== null && (had > 0 || cell !== keeper)) {
      syncing = true;
      try {
        chart.setVisibleLogicalRange(had > 0 ? { from: range.to - had, to: range.to }
          : { from: data.timeToIndexFloat(linked.from), to: data.timeToIndexFloat(linked.to) });
      } finally { syncing = false; }
    }
    cell.span = span(cell);
    if (cell === keeper || (linked !== null && had === 0)) keep(cell);
  };

  /** Bring a built cell into the link group and the save and tab bookkeeping. */
  const join = (cell: Cell): void => {
    const { widget } = cell;
    const chart = widget.chart;
    let settling = false;
    // A window set by fresh bars or by the grid is not the user's navigation.
    const own = (): boolean => settling || syncing;
    cell.offs.push(chart.on('data:update', () => {
      settling = true;
      queueMicrotask(() => { settling = false; });
      cell.span = span(cell);
      if (cell === keeper) keep(cell);
    }));
    cell.member = {
      on: (event, cb) => chart.on(event, event === 'pan' || event === 'zoom'
        ? payload => { if (!own()) cb(payload); }
        : event === 'symbol'
          ? payload => { const p = payload as { symbol: string; exchange: string }; cb({ symbol: instrument(p.symbol, p.exchange) }); }
          : cb),
      getVisibleLogicalRange: () => chart.getVisibleLogicalRange(),
      setVisibleLogicalRange: range => chart.setVisibleLogicalRange(range),
      get dataLayer() { return chart.dataLayer; },
      get isDestroyed() { return chart.isDestroyed; },
      panes: () => chart.panes(),
      addPrimitive: (primitive, pane) => chart.addPrimitive(primitive, pane),
      removePrimitive: primitive => chart.removePrimitive(primitive),
      setLinkedCrosshairIndex: index => chart.setLinkedCrosshairIndex(index),
    };
    links.add(cell.member, {
      symbol: instrument(widget.symbol(), widget.exchange()), interval: widget.interval(),
      onSymbol: key => { const [symbol, exchange] = JSON.parse(key) as [string, string]; widget.setSymbol(symbol, exchange); },
      onInterval: interval => {
        if (!isKnownInterval(interval)) return false;
        widget.setInterval(interval);
        return true;
      },
      // A linked change is the leader's step, taken back on its timeline and
      // sent here again; on this chart's own timeline it is never a step.
      appearance: { read: () => readChartSettings(chart), apply: values => widget.history.ignore(() => applyChartSettings(chart, values)) },
    });
    // A new instrument fits its own view, so the keeper's window is no longer
    // the linked one; the other charts still show it.
    const changed = (): void => { if (cell === keeper) forget(); syncCompact(); saveSoon(); };
    const moved = (): void => {
      const mine = !own();
      cell.span = span(cell);
      // A navigation sets the linked window; the keeper's other moves carry it along.
      if (mine || cell === keeper) keep(cell);
      // A window set by data is still written, but a desk held after a refused restore stays held.
      if (mine || !held) scheduleSave();
    };
    cell.offs.push(
      widget.on('interval', ({ interval }) => links.setInterval(cell.member, interval)),
      widget.on('theme', ({ chartTheme }) => { if (!themeSync) grid.setTheme(chartTheme); }),
      widget.on('symbol', changed),
      widget.on('interval', changed),
      widget.on('variant', changed),
      widget.on('layout', scheduleSave),
      chart.on('pan', moved),
      chart.on('zoom', moved),
      chart.on('resize', () => fit(cell)),
    );
    for (const event of ['draw:add', 'draw:remove', 'alert:created', 'alert:removed']) cell.offs.push(chart.on(event, saveSoon));
    // These arrive once per frame while something is dragged.
    for (const event of ['draw:update', 'alert:updated', 'objects:change']) cell.offs.push(chart.on(event, scheduleSave));
  };

  const drop = (cell: Cell): void => {
    if (cell === keeper) forget();
    for (const off of cell.offs.splice(0)) off();
    if (cell.member !== undefined) links.remove(cell.member);
    cell.widget.destroy();
    cell.element.remove();
  };

  const activateFrom = (target: EventTarget | null): void => {
    const cell = cells.find(c => c.element.contains(target as Node | null));
    if (cell !== undefined) grid.setActive(cell.id);
  };

  const grid: ChartGrid = {
    root,
    get isDestroyed() { return destroyed; },
    restored: () => restored,
    cells: () => cells.slice(),
    active: () => active as Cell,
    theme: () => resolveTheme(theme).name,
    compact: () => compact,
    linkOptions: () => links.options(),
    layout: () => ({ rows, columns: cols, preset, rowWeights: rowW.slice(), columnWeights: colW.slice() }),
    on: (event, cb) => bus.on(event, cb),

    setActive(id, opts = {}) {
      const cell = cells.find(c => c.id === id);
      if (cell === undefined || destroyed) return false;
      const changed = cell !== active;
      active = cell;
      markActive();
      if (opts.focus) cell.widget.root.querySelector<HTMLElement>('.oac-chart')?.focus({ preventScroll: true });
      if (changed) {
        // Focus is no edit, so it never ends the hold on a refused desk.
        if (!held) saveSoon();
        emit('active', { id });
      }
      return true;
    },

    setPreset(next) {
      const size = CHART_GRID_PRESETS[next];
      if (size === undefined) throw new Error(`openalgo-charts grid: "${String(next)}" is not a preset`);
      if (destroyed) return;
      const [r, c] = size;
      const keep = cells.slice(0, r * c);
      const before = active;
      const from = active?.widget;
      const source: Source = from === undefined ? options
        : { symbol: from.symbol(), exchange: from.exchange(), interval: from.interval(), variant: from.variant(), chartType: from.chartType(), historyPeriod: active?.historyPeriod };
      const made: Cell[] = [];
      try {
        while (keep.length + made.length < r * c) {
          let id: string;
          do id = `p${nextId++}`; while (cells.some(cell => cell.id === id));
          made.push(makeCell(id, source, body, theme));
        }
      } catch (error) {
        made.forEach(drop);
        throw error;
      }
      cells.slice(r * c).forEach(drop);
      cells = [...keep, ...made];
      cells.forEach((cell, i) => Object.assign(cell, { row: Math.floor(i / c), column: i % c, rowSpan: 1, columnSpan: 1 }));
      made.forEach(join);
      rows = r; cols = c; rowW = ones(r); colW = ones(c); preset = next;
      if (active === null || !cells.includes(active)) active = cells[0];
      render();
      saveSoon();
      emit('layout', { reason: 'preset' });
      if (active !== before) emit('active', { id: active.id });
    },

    setLinks(patch) {
      // A window from before viewport linking came on says nothing about the charts now.
      if (patch.viewport && !links.options().viewport) forget();
      // Recorded before the switch flips, so the group converges on the active chart.
      if (active !== null && patch.symbol) links.setSymbol(active.member, instrument(active.widget.symbol(), active.widget.exchange()));
      if (active !== null && patch.interval) links.setInterval(active.member, active.widget.interval());
      links.setOptions(patch);
      saveSoon();
      emit('links', links.options());
    },

    setTheme(next) {
      theme = next;
      paintTheme();
      themeSync = true;
      try { for (const c of cells) c.widget.setTheme(next); }
      finally { themeSync = false; }
      saveSoon();
      emit('theme', { theme: resolveTheme(next).name });
    },

    getWorkspace() {
      const o = links.options();
      const payload: WorkspacePayload = {
        layout: {
          rows, columns: cols,
          slots: cells.map(c => ({ paneId: c.id, row: c.row, column: c.column, rowSpan: c.rowSpan, columnSpan: c.columnSpan })),
          ...(preset === null ? {} : { preset }), rowWeights: rowW.slice(), columnWeights: colW.slice(),
        },
        panes: cells.map((c): WorkspacePane => {
          const s = c.widget.getState();
          // The widget draws no separate volume series and no comparisons, so
          // it saves neither rather than claim a preference it cannot show.
          return { id: c.id, symbol: s.symbol, exchange: s.exchange, interval: s.interval, ...(s.variant ? { variant: s.variant } : {}), chartType: s.chartType,
            chart: s.chart as WorkspaceChartState, settings: { [THEME_SETTING]: s.theme }, volume: false,
            magnet: s.rail?.magnet ?? 'off', stay: s.rail?.stay ?? false, comparisons: [], comparisonMode: 'percent', historyPeriod: c.historyPeriod };
        }),
        activePaneId: (active as Cell).id,
        sync: { crosshair: o.crosshair, viewport: o.viewport, symbol: o.symbol, interval: o.interval, appearance: o.appearance },
      };
      // Chart states carry absent optional fields; the portable form is plain JSON.
      return JSON.parse(JSON.stringify(payload)) as WorkspacePayload;
    },

    applyWorkspace(payload) {
      if (destroyed) return { applied: false, reason: 'the grid is destroyed' };
      const reason = check(payload);
      if (reason !== '') return { applied: false, reason };
      const saved = payload.panes.find(p => p.id === payload.activePaneId)?.settings?.[THEME_SETTING];
      const nextTheme = saved === 'dark' || saved === 'light' ? saved : theme;
      const staging = doc.createElement('div');
      const made: Cell[] = [];
      try {
        for (const slot of payload.layout.slots.slice().sort((a, b) => a.row - b.row || a.column - b.column)) {
          const pane = payload.panes.find(p => p.id === slot.paneId) as WorkspacePane;
          const cell = makeCell(pane.id, pane, staging, nextTheme);
          made.push(cell);
          Object.assign(cell, { row: slot.row, column: slot.column, rowSpan: slot.rowSpan ?? 1, columnSpan: slot.columnSpan ?? 1 });
          const rail = cell.widget.getState().rail;
          const report = cell.widget.restoreState({ version: 1, symbol: pane.symbol, exchange: pane.exchange, interval: pane.interval,
            ...(pane.variant ? { variant: pane.variant } : {}), chartType: pane.chartType, chart: pane.chart, ...(rail === null ? {} : { rail: { ...rail, magnet: pane.magnet, stay: pane.stay } }) });
          if (!report.applied) throw new Error(`${pane.id}: ${report.reason ?? 'the chart state could not be restored'}`);
        }
      } catch (error) {
        made.reverse().forEach(drop);
        return { applied: false, reason: error instanceof Error ? error.message : String(error) };
      }
      cells.forEach(drop);
      cells = made;
      const { layout, sync } = payload;
      rows = layout.rows; cols = layout.columns;
      rowW = layout.rowWeights?.slice() ?? ones(rows);
      colW = layout.columnWeights?.slice() ?? ones(cols);
      preset = layout.preset ?? null;
      theme = nextTheme;
      paintTheme();
      // Every channel off while the charts join, so joining cannot overwrite a
      // saved chart; the checks above make the final switch-on agree already.
      links.setOptions({ crosshair: false, viewport: false, symbol: false, interval: false, appearance: false });
      made.forEach(join);
      active = made.find(c => c.id === payload.activePaneId) as Cell;
      // The group still remembers the replaced charts' instrument, and turning a
      // channel on converges on what it remembers; record the new one first.
      links.setSymbol(active.member, instrument(active.widget.symbol(), active.widget.exchange()));
      links.setInterval(active.member, active.widget.interval());
      links.setOptions({ crosshair: sync.crosshair, viewport: sync.viewport, symbol: sync.symbol, interval: sync.interval, appearance: sync.appearance === true });
      render();
      saveSoon();
      emit('layout', { reason: 'workspace' });
      emit('active', { id: active.id });
      return { applied: true };
    },

    destroy() {
      if (destroyed) return;
      saveNow();
      destroyed = true;
      for (const off of offs.splice(0)) off();
      cells.splice(0).forEach(drop);
      links.destroy();
      root.remove();
      bus.clear();
    },
  };

  paintTheme();
  container.appendChild(root);
  const listen = (target: EventTarget, type: string, fn: (e: Event) => void, capture = false): void => {
    target.addEventListener(type, fn, capture);
    offs.push(() => target.removeEventListener(type, fn, capture));
  };
  // Capture, so a chart that stops its own pointer events still activates.
  listen(root, 'pointerdown', e => activateFrom(e.target), true);
  listen(root, 'focusin', e => activateFrom(e.target));
  listen(root, 'pointerenter', () => { pointerIn = true; });
  listen(root, 'pointerleave', () => { pointerIn = false; });
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  const Observer = win?.ResizeObserver;
  if (Observer !== undefined) {
    const observer = new Observer(measure);
    observer.observe(root);
    offs.push(() => observer.disconnect());
  }
  if (win != null && typeof win.addEventListener === 'function') {
    if (Observer === undefined) listen(win, 'resize', measure);
    // A debounced save still pending when the tab closes is the user's last change.
    listen(win, 'pagehide', saveNow);
  }
  // Hiding is the last moment a page is sure to see; unload may never come.
  listen(doc, 'visibilitychange', () => { if (doc.visibilityState === 'hidden') saveNow(); });

  const saved = storage.get(STATE_KEY);
  restored = saved === null ? null : grid.applyWorkspace(saved as WorkspacePayload);
  if (restored?.applied !== true) {
    grid.setPreset(options.preset ?? '1x1');
    if (restored !== null) {
      // The stored desk may only be waiting for a study or chart type the page
      // registers later, so it is kept, not overwritten by this fallback.
      held = true;
      grid.active().widget.context.toast(widgetText(options, 'The saved layout could not be restored: {error}', { error: restored.reason ?? '' }), 'error');
    }
  }
  measure();
  return grid;
}
