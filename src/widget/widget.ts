/**
 * The widget shell: a chart with its chrome, built in one call.
 *
 * `createWidget(container, options)` puts a `.oac-widget` root into the
 * container with a top bar, a stage (the tool rail beside the chart) and a
 * status line, creates the chart and the drawing controller inside it, wires
 * the keymap, the overlay stack and the toasts, and hands every mounted piece
 * one `WidgetContext`. A host that wants the chart alone still has the engine;
 * this is for the host that wants the terminal.
 *
 * Three decisions worth recording:
 *
 * - **The shell owns the theme, the symbol and the interval; the chart owns
 *   everything else.** The engine has no instrument concept, so symbol and
 *   interval live here, drive the feed from here, and are published on the bus
 *   as `symbol` and `interval` for a host (or a link group) to follow.
 * - **Persisted state is validated field by field and applied to the dataset
 *   it was captured on.** A viewport is a range of bar indices and means
 *   nothing on different bars, so a saved layout landing on another symbol
 *   keeps its indicators, drawings and panes and drops its view.
 * - **Every chord goes through one keymap in the capture phase.** The rail,
 *   the editing keys and the tool chords register there with a scope, so a
 *   dialog being open or the focus being in the rail is decided once, not in
 *   every listener.
 */
import {
  AlertController, ChartObjects, DataLoadingController, ShortcutManager, createChart, darkTheme, lightTheme, registeredIntervals, registeredChartTypes, tryResolveInterval, resolveInterval, isKnownInterval,
  type Chart, type ChartOptions, type ChartTheme, type DataFeed, type Bar, type SeriesApi, type SeriesType,
  type RestoreReport, type BarsRequest, type DataLoadingOptions, type DataLoadingSnapshot, type AlertTriggeredPayload, type TradingCapabilityRequest, type TradingCapabilitySource,
} from 'openalgo-charts';
import { DrawingController, drawingShortcuts, keyToDrawingAction, type DrawingKeyContext } from 'openalgo-charts/draw';
import {
  WidgetBus, WidgetStorage, createOverlayStack, createTipController, defaultStorage, h, widgetDialog,
  type OverlayOptions, type StorageLike, type WidgetBusEvents, type WidgetContext, type WidgetDialogName,
} from './context';
import { Keymap, openShortcutsPanel, type KeyEventLike, type KeyScope } from './keymap';
import { mountRail, toolName, type RailHandle, type RailOptions, type RailPrefs } from './rail';
import { mountStatusline, type StatuslineHandle } from './statusline';
import { mountTopbar, type SymbolSearch, type TopbarHandle } from './topbar';
import { mountToasts, type ToastHandle, type ToastKind, type Toaster } from './toast';
import { applyTokens, themeMode, widgetTokens, type WidgetThemeName } from './tokens';
import { injectWidgetStyles } from './styles';
import { mountDataStatus, type DataStatusHandle } from './data-status';
import { attachContextMenu, mountIndicatorSettings, mountDrawingProperties, mountAlertsPanel, type OrderRequest, type PanelHandle } from './dialogs/index';
import { mountObjectsPanel, createObjectsPanelContent } from './objects-panel';
import { mountMobile, type MobileHandle, type MobileMode } from './mobile';
import { widgetText, type WidgetTranslator } from './localization';
import { EventDetailsPopup, type EventDetailsPopupOptions } from './event-details';
import type { ChartEventClick } from 'openalgo-charts';
import { mountDataWindow } from './data-window';
import { mountPanelDock, sanitizePanelDockState, type PanelDockHandle, type PanelDockState } from './panel-dock';
import { mountQuickEntry, type QuickEntryHandle } from './quick-entry';
import { WIDGET_COMPONENT_CSS } from './component-styles';
import { DateNavigator, timeBuckets, type DateNavigationResult, type DateNavigationTarget, type HistoryReach } from './date-navigator';
import { openDateNavigation } from './date-navigation-dialog';
import { mountWatchlistPanel, type WatchlistPanelOptions } from './watchlist-panel';
import { mountNewsPanel, type NewsPanelOptions } from './news-panel';

/** The intervals offered when the host names none: the registry's codes are appended. */
export const DEFAULT_INTERVALS: readonly string[] = ['1m', '5m', '15m', '1h', '1d', '1w'];
/** Bars asked of the feed per load when the host names no lookback. */
export const DEFAULT_LOOKBACK_BARS = 500;
/** Debounce on writing the persisted layout, because drags fire per frame. */
export const SAVE_DEBOUNCE_MS = 250;
/** The storage entry the layout lives under. */
export const STATE_KEY = 'state';
export const WIDGET_STATE_VERSION = 1;

/** Named lists and their quotes for the docked watchlist. A chosen row charts that instrument. */
export type WidgetWatchlistOptions = Omit<WatchlistPanelOptions, 'onSelect' | 'normalize'>;
/** The news source for the docked reader, which follows the chart's instrument. */
export type WidgetNewsOptions = NewsPanelOptions;

export interface WidgetOptions extends Omit<ChartOptions, 'theme'> {
  /** Docked Data and Objects panels. False retains the original Objects dialog. Default true. */
  panels?: boolean;
  /** Unclaimed letters and digits open symbol and interval entry on the focused chart. Default true. */
  typingNavigation?: boolean;
  /**
   * A docked watchlist: named lists from a store (a `WatchlistRepository` from
   * `openalgo-charts/workspace`), with prices only from `quotes`. Needs `panels`.
   */
  watchlist?: WidgetWatchlistOptions;
  /** A docked reader for the chart instrument's news. Needs `panels`. */
  news?: WidgetNewsOptions;
  /** Event marker clicks open details. Set false to provide a host-owned view. */
  eventDetails?: false | EventDetailsPopupOptions;
  /** Where bars come from. Without one the chart shows what the host sets on `widget.series` itself. */
  feed?: DataFeed;
  /** Shared history, paging and recovery options. `now` here uses UTC seconds. */
  loading?: DataLoadingOptions;
  symbol?: string;
  /** Exchange passed to the feed with the symbol. Default `''`. */
  exchange?: string;
  /** Interval code the registry knows (a built-in token or one passed to `registerInterval`). Default `1d`. */
  interval?: string;
  /** The interval pills, each a known code. Default: `DEFAULT_INTERVALS` plus every registered code. */
  intervals?: readonly string[];
  /** Primary series type. Default `candlestick`. Must be a registered chart type. */
  chartType?: string;
  /** `dark` (default), `light`, or a full `ChartTheme`; the chrome derives its palette from it. */
  theme?: WidgetThemeName | ChartTheme;
  /** The drawing rail. `false` hides it; an object restricts its tools or seeds its pins. Default on. */
  rail?: boolean | RailOptions;
  topbar?: boolean;
  statusline?: boolean;
  /** Narrow controls. Auto activates at 640 CSS px or less, or for a coarse primary pointer. Default auto. */
  mobile?: MobileMode;
  /**
   * Keep the layout, the rail preferences, the symbol, the interval and the
   * theme between visits. `true` uses one shared namespace; a string names one,
   * so two widgets on a page keep separate layouts. Default off.
   */
  persist?: boolean | string;
  /** The store behind `persist`. Default: the page's `localStorage`. */
  storage?: StorageLike | null;
  /** BCP 47 tag for the numbers on the status line. Default: the runtime's. */
  locale?: string;
  /** Host translations for widget chrome and dialogs, with English fallback. */
  translate?: WidgetTranslator;
  /** Show the Indicators button. Default true. */
  indicators?: boolean;
  /** Symbol lookup for the top bar's box, called as the user types. */
  symbolSearch?: SymbolSearch;
  /** How many bars a load asks the feed for. Default `DEFAULT_LOOKBACK_BARS`. */
  lookbackBars?: number;
  /** Clock for the load window and the capture filename. Default `Date.now`. */
  now?: () => number;
  /** Order entry from the right-click menu. Without it the menu draws no trade rows. */
  onOrder?: (order: OrderRequest) => void;
  /** Supported host order routes, optionally resolved again for each request. */
  tradingCapabilities?: TradingCapabilitySource;
  /** The requested execution mode when the host capabilities constrain it. */
  tradingMode?: TradingCapabilityRequest['mode'];
  /** Locks order entry during host replay selection or workspace transitions. */
  tradingLocked?: () => boolean;
  /** Host CSP nonce for the widget and dialog stylesheet, assigned before insertion. */
  styleNonce?: string;
  /**
   * Which widget answers the keyboard when a host shows several. True sends
   * chords here as if the chart had focus, false silences this widget and its
   * chart's shortcuts, and undefined leaves the pointer and the focus to
   * decide, as they do for a lone widget. The chart grid supplies it per cell.
   */
  keyboardRoute?: () => boolean | undefined;
}

export type WidgetChartState = ReturnType<Chart['getState']>;

/** What `getState` returns and `restoreState` takes. JSON-safe. */
export interface WidgetState {
  version: typeof WIDGET_STATE_VERSION;
  symbol: string;
  exchange: string;
  interval: string;
  chartType: string;
  theme: WidgetThemeName;
  chart: WidgetChartState;
  rail: RailPrefs | null;
  /** Optional in older records. Width is bounded when restored. */
  panels?: PanelDockState;
}

export interface WidgetRestoreReport {
  applied: boolean;
  reason?: string;
  /** The engine's own report for the chart half, when it was reached. */
  chart?: RestoreReport;
}

export type WidgetEventName = 'symbol' | 'interval' | 'theme' | 'layout' | 'data' | 'status';

export interface Widget {
  /** Managed data owner, or null when the host supplies series data directly. */
  readonly dataController: DataLoadingController | null;
  readonly chart: Chart;
  readonly draw: DrawingController;
  readonly alerts: AlertController;
  /** Shared inventory and supported actions for drawings, indicators and registered profiles. */
  readonly objects: ChartObjects;
  /** The `.oac-widget` element. */
  readonly root: HTMLElement;
  /** What every mounted piece was handed; a host mounting its own panel wants the same. */
  readonly context: WidgetContext;
  /** The primary series; its handle stays stable across chart-type changes. */
  readonly series: SeriesApi;
  symbol(): string;
  exchange(): string;
  interval(): string;
  chartType(): string;
  theme(): WidgetThemeName;
  setSymbol(symbol: string, exchange?: string): void;
  setInterval(code: string): void;
  /** Select a renderer while retaining series state. Transform data remains host-owned. */
  setChartType(id: string): void;
  setTheme(theme: WidgetThemeName | ChartTheme): void;
  /** Open the settings dialog. False when the dialog tier has not registered one. */
  openSettings(): boolean;
  openIndicatorPicker(): boolean;
  /** Open the searchable object inventory. False after destruction. */
  openObjects(): boolean;
  /** Show candle and study readings. False when panels are disabled or after destruction. */
  openDataWindow(): boolean;
  /** Open trader alerts and their lifecycle states. False after destruction. */
  openAlerts(): boolean;
  /** Open the docked watchlist. False without a `watchlist` source, with panels off, or after destruction. */
  openWatchlist(): boolean;
  /** Open the docked news reader. False without a `news` source, with panels off, or after destruction. */
  openNews(): boolean;
  getState(): WidgetState;
  restoreState(state: unknown): WidgetRestoreReport;
  /** Load (or reload) bars from the feed for the current symbol and interval. */
  reload(): Promise<void>;
  /**
   * Show a date, or an explicit UTC range, after loading the older history it
   * needs through the feed. Waits for a load in flight; a newer request, a
   * symbol or interval change, a pan or zoom while history loads, or
   * destruction settles it `cancelled`.
   */
  goTo(target: DateNavigationTarget): Promise<DateNavigationResult>;
  /** Open the go-to panel. False after destruction or on an interval without time buckets. */
  openDateNavigation(): boolean;
  on<K extends WidgetEventName>(event: K, cb: (payload: WidgetBusEvents[K]) => void): () => void;
  off<K extends WidgetEventName>(event: K, cb?: (payload: WidgetBusEvents[K]) => void): void;
  destroy(): void;
  readonly isDestroyed: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The options the shell consumes; the rest of `WidgetOptions` is the chart's. */
const WIDGET_ONLY_KEYS: ReadonlyArray<keyof WidgetOptions> = [
  'feed', 'symbol', 'exchange', 'interval', 'intervals', 'chartType', 'theme', 'rail', 'topbar', 'statusline',
  'mobile', 'loading', 'persist', 'storage', 'locale', 'translate', 'indicators', 'symbolSearch', 'lookbackBars', 'now', 'onOrder', 'styleNonce',
  'tradingCapabilities', 'tradingMode', 'tradingLocked',
  'eventDetails',
  'panels', 'typingNavigation', 'keyboardRoute', 'watchlist', 'news',
];

/**
 * The saved chart state without what describes the old view: the viewport
 * and every pinned price range go, the indicators, drawings and pane weights
 * stay. For a layout about to land on a different dataset.
 */
export function stripView(state: WidgetChartState): WidgetChartState {
  const out = { ...state } as Record<string, unknown>;
  delete out.viewport;
  delete out.barSpacing;
  const clearScaleView = (value: unknown): unknown => {
    if (!isRecord(value)) return value;
    const scale = { ...value, autoScale: true } as Record<string, unknown>;
    delete scale.range;
    delete scale.ratioLock;
    return scale;
  };
  if (Array.isArray(out.panes)) {
    out.panes = (out.panes as unknown[]).map((pane) => {
      if (!isRecord(pane)) return pane;
      const next = { ...pane };
      if (isRecord(pane.priceScale)) next.priceScale = clearScaleView(pane.priceScale);
      if (isRecord(pane.scales)) next.scales = Object.fromEntries(
        Object.entries(pane.scales).map(([id, scale]) => [id, clearScaleView(scale)]),
      );
      return next;
    });
  }
  return out as unknown as WidgetChartState;
}

/** Resolve a theme option to the engine palette and the chrome mode. */
export function resolveTheme(t: WidgetThemeName | ChartTheme | undefined): { theme: ChartTheme; name: WidgetThemeName } {
  if (t === 'light') return { theme: lightTheme, name: 'light' };
  if (t === 'dark' || t === undefined) return { theme: darkTheme, name: 'dark' };
  return { theme: t, name: themeMode(t) };
}

/** The window the feed is asked for: `lookback` bars back from now, or five years for a non-time bucketing. */
export function loadWindow(interval: string, lookback: number, nowSec: number): { from: number; to: number } {
  const d = tryResolveInterval(interval);
  const seconds = d !== null && d.bucketing.mode === 'interval' ? d.bucketing.seconds : null;
  const span = seconds === null ? 5 * 365 * 86400 : Math.max(1, Math.round(lookback)) * seconds;
  return { from: nowSec - span, to: nowSec };
}

/** The facts the context reads live from the shell rather than copying. */
interface ThemeSource {
  theme(): WidgetThemeName;
  chartThemeInUse(): ChartTheme;
}

type ContextParts = Omit<WidgetContext, 'theme' | 'chartTheme'>;

/**
 * The context handed to every mounted piece. Theme facts are getters onto the
 * shell, so a dialog that reads `ctx.theme` after a switch sees the new one
 * without anyone re-handing it a context.
 */
class WidgetContextImpl implements WidgetContext {
  public readonly chart: Chart;
  public readonly draw: DrawingController;
  public readonly objects: ChartObjects | undefined;
  public readonly alerts: AlertController | undefined;
  public readonly root: HTMLElement;
  public readonly document: Document;
  public readonly keymap: Keymap;
  public readonly bus: WidgetBus<WidgetBusEvents>;
  public readonly storage: WidgetStorage;
  public readonly locale: string | undefined;
  public readonly translate?: WidgetTranslator;
  public readonly symbolSearch?: SymbolSearch;
  public readonly toast: WidgetContext['toast'];
  public readonly openOverlay: WidgetContext['openOverlay'];
  public readonly status: WidgetContext['status'];
  public readonly tips: WidgetContext['tips'];
  public readonly overlays: WidgetContext['overlays'];
  public readonly symbol: WidgetContext['symbol'];
  public readonly interval: WidgetContext['interval'];
  private readonly _source: ThemeSource;

  public constructor(source: ThemeSource, parts: ContextParts) {
    this._source = source;
    this.chart = parts.chart;
    this.draw = parts.draw;
    this.objects = parts.objects;
    this.alerts = parts.alerts;
    this.root = parts.root;
    this.document = parts.document;
    this.keymap = parts.keymap;
    this.bus = parts.bus;
    this.storage = parts.storage;
    this.locale = parts.locale;
    this.translate = parts.translate;
    this.symbolSearch = parts.symbolSearch;
    this.toast = parts.toast;
    this.openOverlay = parts.openOverlay;
    this.status = parts.status;
    this.tips = parts.tips;
    this.overlays = parts.overlays;
    this.symbol = parts.symbol;
    this.interval = parts.interval;
  }

  public get theme(): WidgetThemeName { return this._source.theme(); }
  public get chartTheme(): ChartTheme { return this._source.chartThemeInUse(); }
}

class WidgetImpl implements Widget {
  public readonly dataController: DataLoadingController | null;
  public readonly chart: Chart;
  public readonly draw: DrawingController;
  public readonly objects: ChartObjects;
  public readonly alerts: AlertController;
  public readonly root: HTMLElement;
  public readonly context: WidgetContext;
  private readonly _series: SeriesApi;

  private readonly _doc: Document;
  private readonly _opts: WidgetOptions;
  private readonly _bus = new WidgetBus<WidgetBusEvents>();
  private readonly _storage: WidgetStorage;
  private readonly _keymap: Keymap;
  private readonly _toasts: Toaster;
  private readonly _chartEl: HTMLElement;
  private _rail: RailHandle | null = null;
  private _topbar: TopbarHandle | null = null;
  private _statusline: StatuslineHandle | null = null;
  private _mobile: MobileHandle | null = null;
  private _objectsPanel: PanelHandle | null = null;
  private _dock: PanelDockHandle | null = null;
  private _quickEntry: QuickEntryHandle | null = null;
  private _alertsPanel: PanelHandle | null = null;
  private _goToPanel: PanelHandle | null = null;
  private readonly _navigator: DateNavigator;
  /** Bumped by every go-to request and every context change, so a waiting request knows it lost. */
  private _navigation = 0;
  private _loading: Promise<unknown> | null = null;
  /** Set while the widget itself moves the view for arriving data, which is not the user moving on. */
  private _anchoring = false;
  private readonly _intervals: string[];

  private _symbol: string;
  private _exchange: string;
  private _interval: string;
  private _chartType: string;
  private _chartTypeRequest = 0;
  private _themeName: WidgetThemeName;
  private _chartTheme: ChartTheme;

  private _pointerInside = false;
  private _pointerInChart = false;
  private readonly _dataStatus: DataStatusHandle;
  private _displayedBars: readonly Bar[] | null = null;
  private _dataState: DataLoadingSnapshot | null = null;
  private _initialView = true;
  private _pendingView: WidgetChartState['viewport'] | null = null;
  private _keepView = false;
  private _saveTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private _destroyed = false;
  private readonly _cleanups: Array<() => void> = [];

  public constructor(container: HTMLElement, options: WidgetOptions) {
    this._opts = options;
    this.dataController = options.feed ? new DataLoadingController(options.feed, {
      now: () => Math.floor((options.now ?? Date.now)() / 1000),
      ...options.loading,
    }) : null;
    this._navigator = new DateNavigator({ chart: () => this.chart, loadHistory: time => this._loadHistory(time) });
    const doc = options.document ?? container.ownerDocument;
    this._doc = doc;
    injectWidgetStyles(doc, WIDGET_COMPONENT_CSS, options.styleNonce);

    // ── persisted facts, before anything is built from them ────────────
    const ns = typeof options.persist === 'string' ? options.persist : 'default';
    const store = options.persist ? (options.storage === undefined ? defaultStorage() : options.storage) : null;
    this._storage = new WidgetStorage(ns, store);
    const saved = this._readSaved();

    this._symbol = (options.symbol ?? saved?.symbol ?? '').toUpperCase();
    this._exchange = options.exchange ?? saved?.exchange ?? '';
    // A code nothing recognises is an error at the call site (the engine's
    // own rule: a chart showing the wrong timeframe is a wrong trade), and a
    // saved code from a build that registered it is dropped for the default.
    if (options.interval !== undefined) resolveInterval(options.interval);
    for (const code of options.intervals ?? []) resolveInterval(code);
    const savedInterval = saved !== null && isKnownInterval(saved.interval) ? saved.interval : '1d';
    this._interval = options.interval ?? savedInterval;
    const wantType = options.chartType ?? saved?.chartType ?? 'candlestick';
    if (options.chartType !== undefined && !registeredChartTypes().includes(options.chartType)) {
      throw new Error(`openalgo-charts widget: "${options.chartType}" is not a registered chart type`);
    }
    this._chartType = registeredChartTypes().includes(wantType) ? wantType : 'candlestick';
    const t = resolveTheme(options.theme ?? saved?.theme);
    this._themeName = t.name;
    this._chartTheme = t.theme;

    const set = new Set<string>(options.intervals ?? [...DEFAULT_INTERVALS, ...registeredIntervals().map((d) => d.code)]);
    set.add(this._interval);
    this._intervals = Array.from(set);

    // ── the frame ──────────────────────────────────────────────────────
    const root = h(doc, 'div', 'oac-widget');
    root.dataset.theme = this._themeName;
    applyTokens(root, widgetTokens(this._chartTheme, this._themeName));
    this.root = root;
    const topbarEl = h(doc, 'div', 'oac-topbar');
    if (options.topbar === false) topbarEl.hidden = true;
    root.appendChild(topbarEl);
    const stage = h(doc, 'div', 'oac-stage');
    root.appendChild(stage);
    const railEl = h(doc, 'div', 'oac-rail');
    if (options.rail === false) railEl.hidden = true;
    stage.appendChild(railEl);
    const chartEl = h(doc, 'div', 'oac-chart');
    this._chartEl = chartEl;
    stage.appendChild(chartEl);
    const statusEl = h(doc, 'div', 'oac-statusline');
    if (options.statusline === false) statusEl.hidden = true;
    root.appendChild(statusEl);
    const toastEl = h(doc, 'div', 'oac-toasts');
    root.appendChild(toastEl);
    container.appendChild(root);

    // ── the engine ─────────────────────────────────────────────────────
    // Everything the widget does not consume itself goes to the chart as is,
    // so a host keeps every engine option it had.
    const chartOpts = { ...options } as Record<string, unknown>;
    for (const k of WIDGET_ONLY_KEYS) delete chartOpts[k];
    if (options.navigation?.defaultVisibleBars === undefined && options.navigation?.defaultBarSpacing === undefined) {
      chartOpts.navigation = { ...options.navigation, defaultBarSpacing: options.timeScale?.barSpacing ?? 8 };
    }
    const reducedMotion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reducedMotion && chartOpts.animZoom === undefined) chartOpts.animZoom = false;
    if (reducedMotion && chartOpts.animAutoscale === undefined) chartOpts.animAutoscale = false;
    // A routed widget hands the engine's shortcuts the same decision as its own
    // chords, so a hovered chart that is not the routed one stays still. A
    // host's own manager, which a grid shares between its charts, is wrapped
    // per chart rather than rebuilt, and its scope still decides whenever the
    // route leaves the choice open.
    const route = options.keyboardRoute;
    const given = options.shortcuts;
    if (route !== undefined && given !== false) {
      const target = given instanceof ShortcutManager ? given : new ShortcutManager(given);
      chartOpts.shortcuts = new Proxy(target, {
        get: (t, key) => {
          if (key === 'scope') return 'global';
          if (key === 'resolve') return (e: KeyboardEvent) => ((route() ?? (t.scope === 'global' || this._inChart())) ? t.resolve(e) : null);
          const value = Reflect.get(t, key) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(t) : value;
        },
      });
    }
    this.chart = createChart(chartEl, { ...(chartOpts as ChartOptions), theme: this._chartTheme, document: doc });
    chartEl.setAttribute('aria-label', options.ariaLabel ?? widgetText(options, 'Price chart'));
    this._series = this.chart.addSeries(this._chartType as SeriesType);
    this._publishDataContext();
    this.draw = new DrawingController(this.chart, {});
    this.alerts = new AlertController(this.chart, { drawings: this.draw });
    this.objects = new ChartObjects(this.chart, {
      drawings: this.draw,
      onSettings: object => {
        if (object.kind === 'source') this.openSettings();
        else if (object.kind === 'indicator') mountIndicatorSettings(this.context, undefined, { instanceId: object.sourceId });
        else if (object.kind === 'drawing') mountDrawingProperties(this.context, undefined, { ids: [object.sourceId] });
      },
    });

    // ── shared furniture ───────────────────────────────────────────────
    const overlays = createOverlayStack(root, doc);
    const tips = createTipController(root, overlays.layer, doc);
    this._toasts = mountToasts(toastEl, doc, options);
    const sc = this.chart.shortcuts;
    this._keymap = new Keymap({ chart: sc === null ? null : { list: () => sc.list() }, scopes: () => this._scopes() });
    this._keymap.onConflict((c) => this._bus.emit('keymap:conflict', { combo: c.combo, kept: c.kept, shadowed: c.shadowed }));

    this.context = new WidgetContextImpl(this, {
      chart: this.chart,
      draw: this.draw,
      objects: this.objects,
      alerts: this.alerts,
      root,
      document: doc,
      keymap: this._keymap,
      bus: this._bus,
      storage: this._storage,
      locale: options.locale,
      translate: options.translate,
      symbolSearch: options.symbolSearch,
      toast: (message: string, kind?: ToastKind): ToastHandle => this._toasts.toast(message, kind),
      openOverlay: (el: HTMLElement, o?: OverlayOptions): (() => void) => overlays.open(el, o),
      status: (text: string, kind: 'info' | 'error' = 'info'): void => {
        this._statusline?.setMessage(text, kind);
        this._bus.emit('status', { text, kind });
      },
      tips,
      overlays,
      symbol: () => ({ symbol: this._symbol, exchange: this._exchange }),
      interval: () => this._interval,
    });
    this._cleanups.push(() => { tips.destroy(); overlays.destroy(); });
    if (options.eventDetails !== false) {
      const eventDetails = new EventDetailsPopup(chartEl, {
        styleNonce: options.styleNonce, overlays: this.context.overlays,
        formatTime: time => {
          const date = new Date(time * 1000);
          return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(options.locale, {
            timeZone: this.chart.timezone(), dateStyle: 'medium', timeStyle: 'short',
          }).format(date) : String(time);
        },
        ...options.eventDetails,
        // Reuse the host's shared stylesheet and its preserved CSP nonce.
        injectStyles: false,
      });
      this._cleanups.push(this.chart.on('event:click', payload => {
        const details = payload as ChartEventClick;
        eventDetails.open(details, details.point);
      }));
      this._cleanups.push(this.chart.on('data:context', () => eventDetails.close()));
      this._cleanups.push(this.chart.on('events:change', () => eventDetails.close()));
      this._cleanups.push(() => eventDetails.destroy());
    }
    this._dataStatus = mountDataStatus(this.context, stage, this.dataController, () => { void this.reload(); });
    if (options.panels !== false) {
      this._dock = mountPanelDock(this.context, stage, {
        data: host => mountDataWindow(this.context, host),
        objects: host => {
          const content = createObjectsPanelContent(this.context);
          host.appendChild(content.element);
          return content;
        },
        // Rows name instruments as setSymbol will chart them, so case cannot split one instrument in two.
        watchlist: options.watchlist ? host => mountWatchlistPanel(this.context, host, {
          ...options.watchlist!, onSelect: instrument => this.setSymbol(instrument.symbol, instrument.exchange),
          normalize: instrument => ({ symbol: instrument.symbol.trim().toUpperCase(), exchange: instrument.exchange }),
        }) : undefined,
        news: options.news ? host => mountNewsPanel(this.context, host, options.news!) : undefined,
        onChange: () => { this._bus.emit('layout', { reason: 'panels' }); this._scheduleSave(); },
      });
    }
    // The right-click menu is the one dialog nothing in the chrome opens, so
    // the shell subscribes it to the chart itself.
    this._cleanups.push(attachContextMenu(this.context, {
      onOrder: options.onOrder, tradingCapabilities: options.tradingCapabilities, tradingMode: options.tradingMode, tradingLocked: options.tradingLocked,
    }));

    // ── chrome ─────────────────────────────────────────────────────────
    if (options.rail !== false) {
      const railOpts: RailOptions = { ...(typeof options.rail === 'object' ? options.rail : {}), cursorTarget: chartEl };
      this._rail = mountRail(this.context, railEl, railOpts);
    }
    if (options.statusline !== false) {
      this._statusline = mountStatusline(this.context, statusEl, { locale: options.locale });
      this._statusline.setSymbol(this._symbol, this._exchange, this._interval);
    }
    if (options.topbar !== false) {
      this._topbar = mountTopbar(this.context, topbarEl, {
        intervals: this._intervals,
        indicators: options.indicators,
        search: options.symbolSearch,
        state: () => ({ symbol: this._symbol, exchange: this._exchange, interval: this._interval, chartType: this.chartType(), theme: this._themeName }),
        onSymbol: (s, ex) => this.setSymbol(s, ex),
        onInterval: (code) => this.setInterval(code),
        onChartType: (id) => this.setChartType(id),
        onTheme: (next) => this.setTheme(next),
        onSettings: (anchor) => this._openDialog('settings', anchor),
        onIndicators: (anchor) => this._openDialog('indicatorPicker', anchor),
        onObjects: (anchor) => this._openObjects(anchor),
        onDataWindow: options.panels === false ? undefined : () => this._dock?.toggle('data'),
        onAlerts: (anchor) => this._openAlerts(anchor),
        onWatchlist: this._docked('watchlist') ? () => this._dock?.toggle('watchlist') : undefined,
        onNews: this._docked('news') ? () => this._dock?.toggle('news') : undefined,
        onGoTo: (anchor) => this._openGoTo(anchor),
        settingsAvailable: () => widgetDialog('settings') !== null,
        indicatorsAvailable: () => widgetDialog('indicatorPicker') !== null,
        dataAvailable: () => this.dataController === null || this._dataState?.status === 'ready' || this._dataState?.status === 'stale',
      });
    }
    this._mobile = mountMobile(this.context, {
      mode: options.mobile,
      container,
      intervals: this._intervals,
      topbar: options.topbar !== false,
      rail: this._rail,
      tools: typeof options.rail === 'object' ? options.rail.tools : undefined,
      indicators: options.indicators !== false,
      search: options.symbolSearch,
      state: () => ({ symbol: this._symbol, exchange: this._exchange, interval: this._interval, chartType: this.chartType(), theme: this._themeName }),
      onSymbol: (symbol, exchange) => this.setSymbol(symbol, exchange),
      onInterval: (code) => this.setInterval(code),
      onChartType: (id) => this.setChartType(id),
      onTheme: () => this.setTheme(this._themeName === 'dark' ? 'light' : 'dark'),
      onSettings: (anchor) => this._openDialog('settings', anchor),
      onIndicators: (anchor) => this._openDialog('indicatorPicker', anchor),
      onObjects: (anchor) => this._openObjects(anchor),
      onDataWindow: options.panels === false ? undefined : () => this._dock?.toggle('data'),
      onAlerts: (anchor) => this._openAlerts(anchor),
      onWatchlist: this._docked('watchlist') ? () => this._dock?.open('watchlist') : undefined,
      onNews: this._docked('news') ? () => this._dock?.open('news') : undefined,
      onGoTo: (anchor) => this._openGoTo(anchor),
      onProperties: (anchor) => this._openDialog('drawingProperties', anchor),
      onCapture: (anchor) => this._topbar?.openCapture(anchor),
      settingsAvailable: () => widgetDialog('settings') !== null,
      indicatorsAvailable: () => widgetDialog('indicatorPicker') !== null,
    });

    this._installKeys();
    this._keymap.attach(doc);
    if (options.typingNavigation !== false) {
      this._quickEntry = mountQuickEntry(this.context, {
        enabled: () => !this._destroyed && this._doc.activeElement !== null
          && this._chartEl.contains(this._doc.activeElement) && this.draw.selection().length === 0,
        onSymbol: (symbol, exchange) => this.setSymbol(symbol, exchange),
        onInterval: code => this.setInterval(code), search: options.symbolSearch,
      });
    }
    this._trackPointer();
    this._followChart();

    // ── the saved layout, onto the dataset it belongs to ───────────────
    if (saved?.chart !== undefined) {
      const same = saved.symbol === this._symbol && saved.exchange === this._exchange && saved.interval === this._interval;
      const report = this.chart.restoreState(same ? saved.chart : stripView(saved.chart));
      if (report.applied) {
        this._keepView = same;
        this._pendingView = same ? saved.chart.viewport ?? null : null;
      } else {
        this._toasts.toast(widgetText(this.context, 'The saved layout could not be restored: {error}', { error: report.reason ?? 'unknown reason' }), 'error');
      }
    }
    if (saved?.rail && this._rail !== null) this._rail.restorePrefs(saved.rail);
    if (saved?.panels) this._dock?.restore(saved.panels);

    if (this.dataController !== null) {
      this._cleanups.push(this.dataController.subscribe(state => this._applyData(state)));
      this.chart.setHistoryLoader(() => {
        void this.dataController!.loadMore().finally(() => { if (!this._destroyed) this.chart.historyLoadComplete(); });
      });
      const visibility = (): void => this.dataController!.setVisible(!doc.hidden);
      doc.addEventListener('visibilitychange', visibility);
      this._cleanups.push(() => doc.removeEventListener('visibilitychange', visibility));
      if (doc.hidden) visibility();
      if (this._symbol !== '') void this.reload();
    }
  }

  // ── facts ────────────────────────────────────────────────────────────
  public get series(): SeriesApi { return this._series; }
  public get isDestroyed(): boolean { return this._destroyed; }
  public symbol(): string { return this._symbol; }
  public exchange(): string { return this._exchange; }
  public interval(): string { return this._interval; }
  public chartType(): string { return this.chart.seriesType(this._series) ?? this._chartType; }
  public theme(): WidgetThemeName { return this._themeName; }
  /** The engine palette in force, for the context's `chartTheme` getter. */
  public chartThemeInUse(): ChartTheme { return this._chartTheme; }

  public on<K extends WidgetEventName>(event: K, cb: (payload: WidgetBusEvents[K]) => void): () => void {
    return this._bus.on(event, cb);
  }

  public off<K extends WidgetEventName>(event: K, cb?: (payload: WidgetBusEvents[K]) => void): void {
    this._bus.off(event, cb);
  }

  // ── symbol, interval, type, theme ────────────────────────────────────
  public setSymbol(symbol: string, exchange?: string): void {
    const s = symbol.trim().toUpperCase();
    const ex = exchange ?? this._exchange;
    if (s === this._symbol && ex === this._exchange) { this._topbar?.refresh(); this._mobile?.refresh(); return; }
    this._symbol = s;
    this._exchange = ex;
    this._cancelNavigation();
    this._keepView = false;
    this._pendingView = null;
    if (this.dataController === null) {
      this._series.setData([]);
      this._publishDataContext();
    }
    this._statusline?.setSymbol(s, ex, this._interval);
    this._topbar?.refresh();
    this._mobile?.refresh();
    this._scheduleSave();
    if (this._opts.feed) void this.reload();
    // Listeners last, so a host's own bug in one cannot leave the shell
    // half-updated. A link group listens for the same fact on the chart's bus.
    this._bus.emit('symbol', { symbol: s, exchange: ex });
    this.chart.emit('symbol', { symbol: s, exchange: ex });
  }

  public setInterval(code: string): void {
    const c = code.trim();
    if (c === '') throw new Error('openalgo-charts widget: interval code must not be empty');
    resolveInterval(c);
    if (c === this._interval) { this._topbar?.refresh(); this._mobile?.refresh(); return; }
    this._interval = c;
    this._cancelNavigation();
    this._keepView = false;
    this._pendingView = null;
    if (this.dataController === null) {
      this._series.setData([]);
      this._publishDataContext();
    }
    this._statusline?.setSymbol(this._symbol, this._exchange, c);
    this._topbar?.refresh();
    this._mobile?.refresh();
    this._scheduleSave();
    if (this._opts.feed) void this.reload();
    this._bus.emit('interval', { interval: c });
  }

  public setChartType(id: string): void {
    if (!registeredChartTypes().includes(id)) throw new Error(`openalgo-charts widget: "${id}" is not a registered chart type`);
    if (id === this.chartType()) return;
    const request = ++this._chartTypeRequest;
    if (!this.chart.setSeriesType(this._series, id as SeriesType)) return;
    if (request !== this._chartTypeRequest || this.chartType() !== id) return;
    this._scheduleSave();
    this._bus.emit('layout', { reason: 'chartType', chartType: id });
  }

  public setTheme(theme: WidgetThemeName | ChartTheme): void {
    const t = resolveTheme(theme);
    this._themeName = t.name;
    this._chartTheme = t.theme;
    this.chart.setTheme(t.theme);
    this.root.dataset.theme = t.name;
    applyTokens(this.root, widgetTokens(t.theme, t.name));
    this._topbar?.refresh();
    this._mobile?.refresh();
    this._scheduleSave();
    this._bus.emit('theme', { theme: t.name, chartTheme: t.theme });
  }

  public openSettings(): boolean { return this._openDialog('settings'); }
  public openIndicatorPicker(): boolean { return this._openDialog('indicatorPicker'); }

  public openObjects(): boolean { return this._openObjects(); }
  public openDataWindow(): boolean {
    if (this._destroyed || !this._dock) return false;
    this._dock.open('data');
    return true;
  }
  public openAlerts(): boolean { return this._openAlerts(); }
  public openWatchlist(): boolean { return this._openDocked('watchlist'); }
  public openNews(): boolean { return this._openDocked('news'); }

  /** Whether the dock carries this source: the option was given and panels are on. */
  private _docked(panel: 'watchlist' | 'news'): boolean {
    return this._opts.panels !== false && this._opts[panel] !== undefined;
  }

  private _openDocked(panel: 'watchlist' | 'news'): boolean {
    if (this._destroyed || !this._dock || !this._docked(panel)) return false;
    this._dock.open(panel);
    return true;
  }
  public openDateNavigation(): boolean { return this._openGoTo(); }

  private _openGoTo(anchor?: HTMLElement): boolean {
    if (this._destroyed || timeBuckets(this._interval) === null) return false;
    if (this._goToPanel?.isOpen()) { this._goToPanel.el.focus(); return true; }
    let mine = 0;
    this._goToPanel = openDateNavigation(this.context, anchor, {
      navigate: target => {
        const work = this.goTo(target);
        mine = this._navigation;
        return work;
      },
      // Only the panel's own request: a newer goTo or a context change already replaced it.
      cancel: () => { if (mine === this._navigation) this._cancelNavigation(); },
      onClose: () => { this._goToPanel = null; },
    });
    return true;
  }

  private _openAlerts(anchor?: HTMLElement): boolean {
    if (this._destroyed) return false;
    if (this._alertsPanel?.isOpen()) { this._alertsPanel.el.focus(); return true; }
    this._alertsPanel = mountAlertsPanel(this.context, anchor, { onClose: () => { this._alertsPanel = null; } });
    return true;
  }

  private _openObjects(anchor?: HTMLElement): boolean {
    if (this._destroyed) return false;
    if (this._dock) { this._dock.open('objects'); return true; }
    if (this._objectsPanel?.isOpen()) { this._objectsPanel.el.focus(); return true; }
    this._objectsPanel = mountObjectsPanel(this.context, anchor, { onClose: () => { this._objectsPanel = null; } });
    return true;
  }

  private _openDialog(name: WidgetDialogName, anchor?: HTMLElement): boolean {
    const mount = widgetDialog(name);
    if (mount === null) return false;
    mount(this.context, anchor);
    return true;
  }

  // ── data ─────────────────────────────────────────────────────────────
  private _publishDataContext(): void {
    const previous = this.chart.getDataContext();
    // Capabilities belong to the instrument, so an interval change retains them
    // while a symbol change waits for fresh metadata from the host.
    const sameInstrument = previous?.symbol === this._symbol && previous.exchange === this._exchange;
    this.chart.setDataContext({
      symbol: this._symbol, exchange: this._exchange, interval: this._interval,
      ...(sameInstrument && previous.hasOpenInterest !== undefined ? { hasOpenInterest: previous.hasOpenInterest } : {}),
    });
  }

  public async reload(): Promise<void> {
    const controller = this.dataController;
    if (controller === null || this._destroyed) return;
    const current = controller.getState().request;
    const same = current?.symbol === this._symbol && current.exchange === this._exchange && current.interval === this._interval;
    if (same) { await controller.refresh(); return; }
    const nowSec = this._opts.loading?.now?.() ?? Math.floor((this._opts.now ?? Date.now)() / 1000);
    const request: BarsRequest = { symbol: this._symbol, exchange: this._exchange, interval: this._interval,
      ...loadWindow(this._interval, this._opts.lookbackBars ?? DEFAULT_LOOKBACK_BARS, nowSec) };
    this._initialView = true;
    this._displayedBars = null;
    this._series.setData([]);
    this._publishDataContext();
    const work = controller.load(request);
    this._loading = work;
    await work;
    if (this._loading === work) this._loading = null;
  }

  public async goTo(target: DateNavigationTarget): Promise<DateNavigationResult> {
    const request = ++this._navigation;
    this._navigator.cancel();
    // The placement belongs after the accepted load, or the first data would reset it.
    if (this._loading !== null) await this._loading;
    if (request !== this._navigation || this._destroyed) return { status: 'cancelled' };
    return this._navigator.goTo(target);
  }

  private _cancelNavigation(): void {
    this._navigation++;
    this._navigator.cancel();
  }

  /** One reach of the managed controller, translated into what the navigator can decide on. */
  private async _loadHistory(time: number): Promise<HistoryReach> {
    const controller = this.dataController;
    const state = controller?.getState();
    if (controller == null || state === undefined || state.paused || state.request === null) return 'unavailable';
    if (state.hasMore === false) return 'exhausted';
    const first = controller.bars()[0]?.time;
    // A pan or zoom the widget did not make while the page loads (a gesture,
    // a key, a linked chart, the host's own call) means the view is wanted
    // elsewhere, and a placement landing after it would undo it. A first load
    // is not watched: the chart is blank until it lands and then resets.
    const moved = (): void => { if (!this._anchoring) this._cancelNavigation(); };
    const offs = [this.chart.on('pan', moved), this.chart.on('zoom', moved)];
    try { await controller.loadMore(time); } finally { for (const off of offs) off(); }
    const next = controller.getState();
    if (next.historyStatus === 'error') throw next.historyError ?? new Error('Older history failed to load');
    if (next.historyStatus === 'limited') return 'limited';
    const reached = controller.bars()[0]?.time;
    if (reached !== undefined && (first === undefined || reached < first)) return 'loaded';
    return next.hasMore === false ? 'exhausted' : 'empty';
  }

  private _applyData(state: DataLoadingSnapshot): void {
    if (this._destroyed || state.request === null) return;
    const previous = this._dataState;
    this._dataState = state;
    this._dataStatus.update(state);
    const { symbol, interval } = state.request;
    if (!state.paused && state.bars !== this._displayedBars) {
      const before = this._series.getData();
      const view = this.chart.getVisibleLogicalRange();
      const anchor = before[Math.max(0, Math.min(before.length - 1, Math.round(view.from)))];
      const anchorIndex = anchor === undefined ? -1 : before.findIndex(bar => bar.time === anchor.time);
      const tail = state.bars[state.bars.length - 1];
      if (state.reason === 'live' && tail !== undefined && before[0]?.time === state.bars[0]?.time &&
        (before.length === state.bars.length || before.length + 1 === state.bars.length)) this._series.update(tail);
      else {
        this._series.setData(state.bars);
        this._anchoring = true;
        if (state.bars.length > 0) {
          if (this._initialView) {
            if (this._pendingView) this.chart.setVisibleLogicalRange(this._pendingView);
            else if (!this._keepView) this.chart.resetScale();
            this._pendingView = null;
            this._initialView = false;
            this._keepView = false;
          } else {
            const nextIndex = anchor === undefined ? -1 : state.bars.findIndex(bar => bar.time === anchor.time);
            const shift = nextIndex < 0 || anchorIndex < 0 ? 0 : nextIndex - anchorIndex;
            this.chart.setVisibleLogicalRange({ from: view.from + shift, to: view.to + shift });
          }
        }
        this._anchoring = false;
      }
      this._displayedBars = state.bars;
      this._statusline?.refresh();
    }
    if (previous?.status === state.status && previous.error === state.error && !['load', 'refresh', 'prepend', 'resume'].includes(state.reason)) return;
    if (state.status === 'loading') this.context.status(widgetText(this.context, 'Loading {symbol} {interval}', { symbol, interval }));
    else if (state.status === 'refreshing') this.context.status(widgetText(this.context, 'History is stale. Refreshing {symbol} {interval}', { symbol, interval }));
    else if (state.status === 'error' || state.status === 'stale') {
      this.context.status(state.status === 'stale' ? widgetText(this.context, 'History is stale for {symbol} {interval}. Reload to retry.', { symbol, interval }) : widgetText(this.context, 'Could not load {symbol} {interval}', { symbol, interval }), 'error');
      if (state.error && state.error !== previous?.error) {
        this._toasts.toast(widgetText(this.context, 'Could not load {symbol} {interval}: {error}', { symbol, interval, error: state.error.message }), 'error');
        this._bus.emit('data', { symbol, interval, bars: 0, error: state.error.message });
      }
    } else if (state.status === 'ready' || state.status === 'empty') {
      this.context.status(state.bars.length === 0 ? widgetText(this.context, 'No bars for {symbol} {interval}', { symbol, interval }) : widgetText(this.context, '{count} bars', { count: state.bars.length }));
      this._bus.emit('data', { symbol, interval, bars: state.bars.length });
    }
  }

  // ── state ────────────────────────────────────────────────────────────
  public getState(): WidgetState {
    return {
      version: WIDGET_STATE_VERSION,
      symbol: this._symbol,
      exchange: this._exchange,
      interval: this._interval,
      chartType: this.chartType(),
      theme: this._themeName,
      chart: this.chart.getState(),
      rail: this._rail?.prefs() ?? null,
      panels: this._dock?.state(),
    };
  }

  public restoreState(state: unknown): WidgetRestoreReport {
    if (!isRecord(state)) return { applied: false, reason: 'not a widget state object' };
    if (state.version !== undefined && state.version !== WIDGET_STATE_VERSION) {
      return { applied: false, reason: `widget state version ${String(state.version)} is not ${WIDGET_STATE_VERSION}` };
    }
    if (state.theme === 'dark' || state.theme === 'light') this.setTheme(state.theme);
    if (typeof state.chartType === 'string' && registeredChartTypes().includes(state.chartType)) this.setChartType(state.chartType);
    if (state.rail !== undefined && this._rail !== null) this._rail.restorePrefs(state.rail);
    if (state.panels !== undefined) this._dock?.restore(state.panels);
    const symbol = typeof state.symbol === 'string' ? state.symbol.toUpperCase() : this._symbol;
    const exchange = typeof state.exchange === 'string' ? state.exchange : this._exchange;
    const interval = typeof state.interval === 'string' && isKnownInterval(state.interval) ? state.interval : this._interval;
    const same = symbol === this._symbol && exchange === this._exchange && interval === this._interval;
    let chart: RestoreReport | undefined;
    if (isRecord(state.chart)) {
      const doc = state.chart as unknown as WidgetChartState;
      chart = this.chart.restoreState(same ? doc : stripView(doc));
      if (!chart.applied) return { applied: false, reason: chart.reason, chart };
      this._keepView = same;
      this._pendingView = same ? doc.viewport ?? null : null;
    }
    if (!same) {
      this._cancelNavigation();
      if (interval !== this._interval) {
        this._interval = interval;
        this._bus.emit('interval', { interval });
      }
      if (symbol !== this._symbol || exchange !== this._exchange) {
        this._symbol = symbol;
        this._exchange = exchange;
        this._bus.emit('symbol', { symbol, exchange });
      }
      this._statusline?.setSymbol(this._symbol, this._exchange, this._interval);
      this._topbar?.refresh();
      this._mobile?.refresh();
      if (this._opts.feed) void this.reload();
      else {
        this._series.setData([]);
        this._publishDataContext();
      }
    }
    this._rail?.refresh();
    this._statusline?.refresh();
    this._bus.emit('layout', { reason: 'restore', chartType: this.chartType() });
    this._scheduleSave();
    return chart === undefined ? { applied: true } : { applied: true, chart };
  }

  private _readSaved(): WidgetState | null {
    const raw = this._storage.get(STATE_KEY);
    if (!isRecord(raw) || raw.version !== WIDGET_STATE_VERSION) return null;
    const out: WidgetState = {
      version: WIDGET_STATE_VERSION,
      symbol: typeof raw.symbol === 'string' ? raw.symbol : '',
      exchange: typeof raw.exchange === 'string' ? raw.exchange : '',
      interval: typeof raw.interval === 'string' && raw.interval !== '' ? raw.interval : '1d',
      chartType: typeof raw.chartType === 'string' ? raw.chartType : 'candlestick',
      theme: raw.theme === 'light' ? 'light' : 'dark',
      chart: isRecord(raw.chart) ? (raw.chart as unknown as WidgetChartState) : (undefined as unknown as WidgetChartState),
      rail: isRecord(raw.rail) ? (raw.rail as unknown as RailPrefs) : null,
      panels: sanitizePanelDockState(raw.panels),
    };
    return out;
  }

  private _scheduleSave(): void {
    if (!this._storage.enabled || this._destroyed) return;
    if (this._saveTimer !== 0) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = 0; this._saveNow(); }, SAVE_DEBOUNCE_MS);
  }

  private _saveNow(): void {
    if (!this._storage.enabled || this._destroyed) return;
    if (this._saveTimer !== 0) { clearTimeout(this._saveTimer); this._saveTimer = 0; }
    try {
      if (!this._storage.set(STATE_KEY, this.getState())) this.context.status(widgetText(this.context, 'The chart layout could not be saved'), 'error');
    } catch (error) {
      this.context.status(widgetText(this.context, 'The chart layout could not be saved: {error}', { error: error instanceof Error ? error.message : 'invalid state' }), 'error');
    }
  }

  // ── keyboard ─────────────────────────────────────────────────────────
  private _scopes(): KeyScope[] {
    if (this.context.overlays.size() > 0) return ['overlay'];
    const out: KeyScope[] = [];
    const active = this._doc.activeElement;
    const routed = this._opts.keyboardRoute?.();
    if (routed === false || (active !== null && this._dataStatus.el.contains(active))) return [];
    if (this._rail !== null && active !== null && this._rail.el.contains(active)) out.push('rail');
    if (routed || this._inChart()) out.push('chart');
    if (routed || this._pointerInside || (active !== null && this.root.contains(active))) out.push('widget');
    out.push('global');
    return out;
  }

  /** The engine's own test for its shortcuts: the pointer over the chart, or the focus in it. */
  private _inChart(): boolean {
    const active = this._doc.activeElement;
    return this._pointerInChart || (active !== null && this._chartEl.contains(active));
  }

  private _installKeys(): void {
    const km = this._keymap;
    const draw = this.draw;
    const drawCtx = (): DrawingKeyContext => ({
      hasSelection: draw.selected() !== null,
      hasTarget: draw.hovered() !== null,
      editingText: false,
      placing: draw.activeTool() !== null,
    });
    const targets = (): string[] => {
      const sel = draw.selection();
      if (sel.length > 0) return sel.slice();
      const hov = draw.hovered();
      return hov === null ? [] : [hov];
    };
    // One handler for every editing key: the tier says what the key means
    // for the selection or the placement in hand, and a key that means
    // nothing right now is declined so the engine (an arrow pan) still gets it.
    const editing = (e: KeyEventLike): boolean => {
      const action = keyToDrawingAction(e, drawCtx());
      // Alert deletion is a fallback: a drawing selection, hover or armed
      // tool keeps ownership even when the pointer is over an alert line.
      if (action === null) {
        const alertId = this.alerts.hovered();
        if (alertId !== undefined && draw.activeTool() === null && (e.key === 'Delete' || e.key === 'Backspace')) {
          this.alerts.remove(alertId);
          this._rail?.refresh();
          return true;
        }
        return false;
      }
      switch (action.type) {
        case 'undo': draw.undo(); break;
        case 'redo': draw.redo(); break;
        case 'delete': draw.removeMany(targets()); break;
        case 'duplicate': draw.duplicate(targets()); break;
        case 'nudge': draw.nudge(targets(), action.dx, action.dy); break;
        case 'cancel': draw.cancel(); if (draw.activeTool() === null) this._rail?.setDrawLock(false); break;
        case 'finish': draw.finish(); break;
        case 'popAnchor': draw.popAnchor(); break;
        case 'copy': void draw.copy(targets()); break;
        case 'cut': void draw.cut(targets()); break;
        case 'paste': void draw.paste(); break;
      }
      this._rail?.refresh();
      return true;
    };
    const G = 'Drawing';
    // The arrows are layered: with nothing selected they decline and the
    // engine's pan runs, so they are not a conflict with it.
    const edit = (combo: string, label: string, hidden = false, layered = false): void => {
      km.register(combo, editing, 'widget', { label, group: G, hidden, layered });
    };
    edit('Mod+Z', 'Undo');
    edit('Mod+Shift+Z', 'Redo');
    edit('Mod+Y', 'Redo', true);
    edit('Mod+C', 'Copy the selected drawing');
    edit('Mod+X', 'Cut the selected drawing');
    edit('Mod+V', 'Paste drawings');
    edit('Mod+D', 'Duplicate the selected drawing');
    edit('Delete', 'Delete the selected drawing');
    edit('Backspace', 'Delete, or drop the last anchor while placing');
    edit('Enter', 'Finish the drawing being placed');
    edit('ArrowLeft', 'Nudge the selection left (Shift: ten pixels)', false, true);
    edit('ArrowRight', 'Nudge the selection right (Shift: ten pixels)', false, true);
    edit('ArrowUp', 'Nudge the selection up (Shift: ten pixels)', false, true);
    edit('ArrowDown', 'Nudge the selection down (Shift: ten pixels)', false, true);
    for (const k of ['Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown']) edit(k, 'Nudge ten pixels', true, true);
    km.register('Escape', (e) => {
      if (draw.activeTool() !== null) {
        if (editing(e)) return true;
        draw.setTool(null);
        this._rail?.setDrawLock(false);
        return true;
      }
      if (draw.selection().length > 0) { draw.select(null); this._rail?.refresh(); return true; }
      return false;
    }, 'widget', { label: 'Leave the tool, then clear the selection', group: G });
    for (const [id, chord] of Object.entries(drawingShortcuts())) {
      km.register(chord, () => { this._rail?.setDrawLock(false); draw.setTool(id); }, 'widget', { label: toolName(id), group: 'Drawing tools' });
    }
    km.register('?', () => { openShortcutsPanel(this.context); }, 'widget', { label: 'Keyboard shortcuts', group: 'Widget' });
  }

  private _trackPointer(): void {
    const root = this.root;
    const chartEl = this._chartEl;
    const onRootEnter = (): void => { this._pointerInside = true; };
    const onRootLeave = (): void => { this._pointerInside = false; this._pointerInChart = false; };
    const onChartEnter = (): void => { this._pointerInChart = true; };
    const onChartLeave = (): void => { this._pointerInChart = false; };
    root.addEventListener('pointerenter', onRootEnter);
    root.addEventListener('pointerleave', onRootLeave);
    chartEl.addEventListener('pointerenter', onChartEnter);
    chartEl.addEventListener('pointerleave', onChartLeave);
    this._cleanups.push(() => {
      root.removeEventListener('pointerenter', onRootEnter);
      root.removeEventListener('pointerleave', onRootLeave);
      chartEl.removeEventListener('pointerenter', onChartEnter);
      chartEl.removeEventListener('pointerleave', onChartLeave);
    });
  }

  /** Every change that lands in `getState` schedules a save and a layout notice. */
  private _followChart(): void {
    const chartEvents = ['paneAdded', 'paneResized', 'paneMoved', 'paneMaximized', 'paneCollapsed', 'paneRemoved', 'indicatorRemoved', 'indicatorSettings', 'priceAxisMoved', 'objects:change'];
    for (const ev of chartEvents) {
      this._cleanups.push(this.chart.on(ev, () => {
        if (ev === 'objects:change' && this.chartType() !== this._chartType) {
          this._chartType = this.chartType();
          this._topbar?.refresh();
          this._mobile?.refresh();
          this._statusline?.refresh();
        }
        this._bus.emit('layout', { reason: ev });
        this._scheduleSave();
      }));
    }
    for (const ev of ['draw:add', 'draw:remove', 'draw:update', 'draw:paste', 'draw:cut',
      'alert:created', 'alert:updated', 'alert:removed', 'alert:triggered', 'alert:expired', 'alerts:restored', 'alerts:checkpoint']) {
      this._cleanups.push(this.chart.on(ev, () => this._scheduleSave()));
    }
    this._cleanups.push(this.chart.on('alert:triggered', payload => {
      const event = payload as AlertTriggeredPayload;
      this.context.toast(event.message ?? event.title, 'success');
    }));
    const win = this._doc.defaultView;
    if (win !== null && win !== undefined && typeof win.addEventListener === 'function') {
      // A debounced save still pending when the tab closes is the last quarter
      // second of the user's work; pagehide is the last synchronous moment.
      const flush = (): void => this._saveNow();
      win.addEventListener('pagehide', flush);
      this._cleanups.push(() => win.removeEventListener('pagehide', flush));
    }
  }

  public destroy(): void {
    if (this._destroyed) return;
    this._saveNow();
    this._destroyed = true;
    this._cancelNavigation();
    this._navigator.destroy();
    this._goToPanel?.close();
    this._quickEntry?.destroy();
    this._dock?.destroy();
    this.dataController?.destroy();
    this._dataStatus.destroy();
    this._mobile?.destroy();
    this._mobile = null;
    if (this._saveTimer !== 0) { clearTimeout(this._saveTimer); this._saveTimer = 0; }
    for (const c of this._cleanups.splice(0)) c();
    this._topbar?.destroy();
    this._rail?.destroy();
    this._statusline?.destroy();
    this._toasts.destroy();
    this._keymap.destroy();
    this.objects.destroy();
    this.alerts.destroy();
    this.draw.destroy();
    this.chart.destroy();
    this.root.remove();
    this._bus.clear();
  }
}

/**
 * Build a widget inside `container`: an element, or a selector (or id)
 * resolved against `options.document` or the page.
 */
export function createWidget(container: HTMLElement | string, options: WidgetOptions = {}): Widget {
  let el: HTMLElement | null;
  if (typeof container === 'string') {
    const doc = options.document ?? (globalThis as { document?: Document }).document;
    if (doc === undefined) throw new Error('openalgo-charts widget: a selector needs a document');
    el = doc.querySelector<HTMLElement>(container) ?? doc.getElementById(container);
    if (el === null) throw new Error(`openalgo-charts widget: no element matches "${container}"`);
  } else {
    el = container;
  }
  return new WidgetImpl(el, options);
}
