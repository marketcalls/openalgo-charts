/**
 * Saving and restoring the chart: the body of `getState`, the checks
 * `restoreState` runs before it touches anything, and the ordered steps that
 * then lay the saved layout back onto the chart.
 *
 * Its own module because the capture and the restore are one contract, read
 * and changed together, and nothing else in the chart calls into them. The
 * class is `ChartPersistence` rather than `ChartState` because that name is
 * already the saved shape (model/chart-state.ts). The chart reaches it
 * through `Chart._persistence`, and it reaches the chart through
 * `PersistenceHost`, which names each field and method the steps read, write
 * or call. `getState` and `restoreState` stay public on Chart as delegates
 * and carry the documented contract. Members the chart calls are public on
 * this internal class; no entry point exports the class and the chart holds
 * it in a private field, so none of it reaches the published declarations.
 */
import { InvalidationLevel, type InvalidateMask } from './invalidate-mask';
import type { Pane } from './pane';
import type { AxisChromeOptions, ChartEventOptions, ChartNavigationOptions, ChartWatermarkOptions } from './chart-types';
import type { TradingSettings } from './trading-controller';
import type { TimeScale, LogicalRange } from '../scale/time-scale';
import type { PriceScale, PriceScaleOptions } from '../scale/price-scale';
import type { CanvasOptions, GridOptions } from '../render/grid';
import type { DataLayer } from '../model/data-layer';
import type { PriceScaleId } from '../model/series';
import { cloneIndicatorSettings, planIndicatorDependencies } from '../model/indicator-dependencies';
import { getIndicator, hasIndicator, type IndicatorDescriptor } from '../model/indicator-registry';
import {
  IndicatorInstance, parseIndicatorPlotPriceScales, validateIndicatorScaleAssignment, type IndicatorHost,
} from '../model/indicator-instance';
import { parseIndicatorPolicy } from '../model/indicator-policy';
import type { AlertsDocument } from '../alerts/types';
import { parseAlertsDocument } from '../alerts/document';
import {
  CHART_STATE_VERSION,
  parsePaneState,
  type ChartState,
  type PaneState,
  type PriceScaleState,
  type SeriesState,
  type RestoreReport,
  type ChartRestoreOptions,
  type IndicatorState,
} from '../model/chart-state';
import type { CrosshairMode } from '../input/crosshair';
import type { IPrimitive } from '../primitives/primitive';
import type { LegendStatusLineOptions } from '../primitives/pane-legend';
import { validateIndicatorInputs } from '../model/indicator-inputs';
import type { TimeNavigator } from '../primitives/time-navigator';
import type { ChartSettingsState } from '../model/chart-settings';
import { isValidTimezone } from '../feed/time';

interface PreparedIndicatorRestore {
  specs: IndicatorState[];
  order: readonly string[];
  descriptors: ReadonlyMap<string, IndicatorDescriptor>;
}
export type PreservedScaleFormats = ReadonlyMap<Pane, ReadonlySet<PriceScaleId>>;

/**
 * The slice of the chart a capture and a restore read, write and drive.
 * Members carry the chart's own names, so the moved code reads as it did in
 * chart.ts. The writable fields are the chart's own, written through.
 */
export interface PersistenceHost {
  readonly _panes: readonly Pane[];
  readonly _indicators: IndicatorInstance[];
  readonly _indicatorRanges: ReadonlyMap<string, {
    pane: Pane; scaleId: PriceScaleId; range: { min: number; max: number }; token: object;
  }>;
  readonly _ownedScaleRanges: Map<PriceScale, object>;
  readonly _collapsed: WeakSet<Pane>;
  readonly _timezone: string;
  readonly _timeScale: TimeScale;
  readonly _dataLayer: DataLayer;
  readonly _tradingSettings: TradingSettings;
  readonly _axisChrome: AxisChromeOptions;
  readonly _movablePrimaryPane: boolean;
  readonly _indicatorReservedIds: Set<string>;
  readonly _indicatorRefreshes: Map<string, boolean>;
  readonly _primaryPane: Pane;
  readonly _timeNav: TimeNavigator | null;
  readonly _anchored: readonly { primitive: IPrimitive }[];
  _crosshairMode: CrosshairMode;
  _crosshairSnapToBar: boolean;
  _priceOnlyAutoScale: boolean;
  _indicatorLegendCollapsed: boolean;
  _sourceAbove: string | null | undefined;
  _drawingState: unknown;
  _alertState: AlertsDocument | undefined;
  _primaryIndex(): number;
  getVisibleLogicalRange(): LogicalRange;
  setVisibleLogicalRange(range: LogicalRange): void;
  navigationOptions(): Readonly<ChartNavigationOptions>;
  _patchNavigation(patch: Partial<ChartNavigationOptions>): void;
  gridOptions(): { vertLines: boolean; horzLines: boolean } & Partial<GridOptions>;
  setGridOptions(opts: Partial<GridOptions>): void;
  canvasOptions(): CanvasOptions;
  setCanvasOptions(patch: CanvasOptions): void;
  statusLineOptions(): LegendStatusLineOptions;
  setStatusLineOptions(patch: LegendStatusLineOptions): void;
  watermarkOptions(): Readonly<ChartWatermarkOptions>;
  setWatermarkOptions(options: boolean | ChartWatermarkOptions): void;
  setTradingSettings(patch: TradingSettings): void;
  setAxisChromeOptions(patch: AxisChromeOptions): void;
  eventOptions(): ChartEventOptions;
  setEventOptions(patch: ChartEventOptions): void;
  setTimezone(zone: string): void;
  _validPriceScaleId(value: unknown): value is PriceScaleId;
  _reserveAlertStudyIds(document: AlertsDocument | undefined, reserved: Set<string>): void;
  emit(event: string, payload: unknown): void;
  _withinLayoutChange<T>(fn: () => T): T;
  _mutateTimeScale<T>(apply: () => T): T;
  invalidate(build: (mask: InvalidateMask) => void): void;
  _emitViewportIfMoved(before: LogicalRange): void;
  _restackLegends(): void;
  _ensurePane(index: number): void;
  setPrimaryPaneIndex(index: number): boolean;
  _relayout(): void;
  _rehomeAnchored(): void;
  _indicatorHost(preservedFormats?: PreservedScaleFormats): IndicatorHost;
  _reorderIndicatorResources(): void;
  _scalePatchFor(pane: Pane, patch: Partial<PriceScaleOptions>): Partial<PriceScaleOptions>;
  removePane(index: number): boolean;
  _recomputeAxisColumns(): void;
}

export class ChartPersistence {
  private readonly _host: PersistenceHost;
  private _restoreGeneration = 0;

  public constructor(host: PersistenceHost) {
    this._host = host;
  }

  /** The work of `Chart.getState`, which carries the documented contract. */
  public getState(): ChartState & ChartSettingsState & { timezone: string } {
    const studyInputs = planIndicatorDependencies(this._host._indicators.map(item => item.dependencyNode())).dependencies;
    const panes: PaneState[] = this._host._panes.map((pane) => {
      const states = pane.scaleStates();
      for (const [instanceId, claim] of this._host._indicatorRanges) {
        if (claim.pane !== pane) continue;
        const scale = pane.scaleFor(claim.scaleId), token = this._host._ownedScaleRanges.get(scale);
        const ownership = token ? scale.ownedFixedRangeState(token) : null;
        if (ownership && states[claim.scaleId] && !states[claim.scaleId]!.indicatorRange) states[claim.scaleId]!.indicatorRange = { instanceId, manual: ownership.manual };
      }
      const { right, ...scales } = states;
      const state: PaneState = {
        weight: pane.weight,
        priceScale: right!,
      };
      if (Object.keys(scales).length) state.scales = scales;
      if (this._host._collapsed.has(pane)) state.collapsed = true;
      return state;
    });

    const series: SeriesState[] = [];
    this._host._panes.forEach((pane, paneIndex) => {
      for (const record of pane.series()) {
        const style = Object.fromEntries(Object.entries(record.style).filter(([, value]) => value !== undefined));
        series.push({ type: record.type, style, paneIndex, priceScaleId: record.scaleId });
      }
    });

    const primary = this._host._primaryIndex();
    const state: ChartState & ChartSettingsState & { timezone: string } = {
      // Version 2 only when the price pane has moved. Every pane index in a
      // state is a visual slot, and a reader older than `primaryPane` would
      // put the price pane's scales, studies and drawings on whatever pane
      // holds slot 0; refusing the newer version is the right answer for it.
      // A layout with the price pane in place is written exactly as it always
      // was, so every existing reader still opens it.
      version: primary > 0 ? CHART_STATE_VERSION : 1,
      // Saved unconditionally, including the default: a layout restored after
      // the default itself changes should still read the hours it was saved with.
      timezone: this._host._timezone,
      viewport: { ...this._host.getVisibleLogicalRange() },
      barSpacing: this._host._timeScale.barSpacing,
      navigation: this._host.navigationOptions(),
      grid: this._host.gridOptions(),
      // The settings dialog's own slice. It lives beside `grid` rather than
      // inside it because these are chart-wide overrides, and it is declared by
      // the settings module so `ChartState` stays the shape of the core.
      canvas: this._host.canvasOptions(),
      statusLine: this._host.statusLineOptions(),
      watermark: this._host.watermarkOptions(),
      trading: { ...this._host._tradingSettings },
      // The two switches, never the clock function: a callback does not survive
      // JSON, and the host that supplied one supplies it again on the way back.
      axisChrome: {
        sessionClock: this._host._axisChrome.sessionClock,
        barCountdown: this._host._axisChrome.barCountdown,
      },
      events: this._host.eventOptions(),
      crosshairMode: this._host._crosshairMode,
      crosshairSnapToBar: this._host._crosshairSnapToBar,
      priceOnlyAutoScale: this._host._priceOnlyAutoScale,
      indicatorLegendCollapsed: this._host._indicatorLegendCollapsed,
      panes,
      ...(primary > 0 ? { primaryPane: primary } : {}),
      series,
      indicators: this._host._indicators.map((i) => ({
        indicatorId: i.indicatorId,
        instanceId: i.id,
        settings: i.settings(),
        paneIndex: i.paneIndex,
        visible: i.visible(),
        ...(studyInputs.get(i.id)?.length ? { studyInputs: studyInputs.get(i.id)!.map(edge => edge.inputKey) } : {}),
        ...(i.priceScaleId() === null ? {} : { priceScaleId: i.priceScaleId()! }),
        ...(Object.keys(i.plotPriceScaleIds()).length ? { plotPriceScaleIds: i.plotPriceScaleIds() } : {}),
        // Restrictions only: an unrestricted study saves what it always did.
        ...(Object.keys(i.policy()).length ? { policy: { ...i.policy() } } : {}),
      })),
      ...(typeof this._host._sourceAbove === 'string' ? { sourceAbove: this._host._sourceAbove } : {}),
    };
    if (this._host._drawingState !== undefined) state.drawings = this._host._drawingState;
    if (this._host._alertState !== undefined) state.alerts = parseAlertsDocument(this._host._alertState);
    return state;
  }

  /** The work of `Chart.restoreState`, which carries the documented contract. */
  public restoreState(state: unknown, options: ChartRestoreOptions = {}): RestoreReport {
    const s = state as (ChartState & ChartSettingsState & { timezone?: unknown }) | null;
    if (s === null || typeof s !== 'object' || typeof s.version !== 'number') {
      return { applied: false, series: [], indicators: 0, reason: 'not a chart state object' };
    }
    if (s.version > CHART_STATE_VERSION) {
      return { applied: false, series: [], indicators: 0, reason: `state version ${s.version} is newer than ${CHART_STATE_VERSION}` };
    }

    let alerts: AlertsDocument | undefined;
    let panes: PaneState[] | undefined;
    let primaryPane: number | undefined;
    let studies: PreparedIndicatorRestore | undefined;
    const preservedFormats = new Map<Pane, Set<PriceScaleId>>();
    const reservedIds = new Set<string>();
    try {
      const priceOnly = Object.getOwnPropertyDescriptor(s, 'priceOnlyAutoScale');
      if (priceOnly && (!('value' in priceOnly) || (priceOnly.value !== undefined && typeof priceOnly.value !== 'boolean'))) {
        throw new Error('Invalid price-only autoscale preference');
      }
      const collapsed = Object.getOwnPropertyDescriptor(s, 'indicatorLegendCollapsed');
      if (collapsed && (!('value' in collapsed) || (collapsed.value !== undefined && typeof collapsed.value !== 'boolean'))) {
        throw new Error('Invalid indicator legend preference');
      }
      const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
        && [Object.prototype, null].includes(Object.getPrototypeOf(value))
        && Object.values(Object.getOwnPropertyDescriptors(value)).every(property => 'value' in property);
      if (!plain(options)) throw new Error('Invalid chart restore options');
      if (options.preserveScaleFormats !== undefined) {
        const selectors = options.preserveScaleFormats;
        if (!Array.isArray(selectors)) throw new Error('Invalid preserved scale formats');
        const properties = Object.getOwnPropertyDescriptors(selectors);
        if (Reflect.ownKeys(properties).some(key => key !== 'length' && (typeof key !== 'string'
          || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= selectors.length
          || !('value' in properties[key])))) throw new Error('Invalid preserved scale formats');
        for (let index = 0; index < selectors.length; index++) {
          const selector = properties[index]?.value as unknown;
          if (!plain(selector) || typeof selector.paneIndex !== 'number' || !Number.isInteger(selector.paneIndex) || selector.paneIndex < 0
            || !this._host._validPriceScaleId(selector.scaleId)) throw new Error('Invalid preserved scale selector');
          const pane = this._host._panes[selector.paneIndex];
          if (!pane || !Object.prototype.hasOwnProperty.call(pane.scaleStates(), selector.scaleId)) {
            throw new Error('Preserved scale must already exist');
          }
          const ids = preservedFormats.get(pane) ?? new Set<PriceScaleId>();
          ids.add(selector.scaleId);
          preservedFormats.set(pane, ids);
        }
      }
      if (s.panes !== undefined) {
        if (!Array.isArray(s.panes)) throw new Error('Invalid pane list');
        panes = s.panes.map(pane => parsePaneState(pane, true));
      }
      // Checked with the rest, before anything is applied: a slot that names no
      // saved pane would put the price pane's scales on a study pane.
      const slot = Object.getOwnPropertyDescriptor(s, 'primaryPane');
      if (slot && (!('value' in slot) || slot.value !== undefined)) {
        const at: unknown = slot.value;
        if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || !(at < (panes?.length ?? 0))) throw new Error('Invalid primary pane slot');
        // The same rule a workspace document enforces: a version 1 reader
        // trusts the version and would lay the price pane's scales on slot 0.
        if (s.version < 2) throw new Error('A moved price pane needs chart version 2');
        // The one switch: a chart that did not opt in keeps its price pane on
        // top, and a layout that moved it would put every slot on the wrong pane.
        if (at > 0 && !this._host._movablePrimaryPane) throw new Error('A moved price pane needs movablePrimaryPane');
        primaryPane = at;
      }
      if (s.alerts !== undefined) alerts = parseAlertsDocument(s.alerts);
      if (s.sourceAbove !== undefined && (typeof s.sourceAbove !== 'string' || !s.sourceAbove.trim())) throw new Error('Invalid source placement');
      if (s.indicators !== undefined) {
        if (!Array.isArray(s.indicators)) throw new Error('Invalid indicator list');
        for (const spec of s.indicators) {
          if ('plotPriceScaleIds' in spec) {
            const property = Object.getOwnPropertyDescriptor(spec, 'plotPriceScaleIds');
            if (!property?.enumerable || !('value' in property)) throw new Error('Invalid indicator plot price scale map field');
          }
          if (spec.priceScaleId !== undefined && !this._host._validPriceScaleId(spec.priceScaleId)) throw new Error('Invalid indicator price scale');
          if (spec.instanceId === undefined) continue;
          if (typeof spec.instanceId !== 'string' || !spec.instanceId.trim() || reservedIds.has(spec.instanceId)) {
            throw new Error('Invalid or duplicate indicator instance id');
          }
          reservedIds.add(spec.instanceId);
        }
        this._host._reserveAlertStudyIds(alerts, reservedIds);
        const used = new Set([...reservedIds, ...this._host._indicatorReservedIds, ...this._host._indicators.map(item => item.id)]);
        const specs = s.indicators.map(spec => ({ ...spec, settings: cloneIndicatorSettings(spec.settings ?? {}),
          ...(spec.policy === undefined ? {} : { policy: parseIndicatorPolicy(spec.policy) }) }));
        // Missing producers remain reserved even when no descriptor can recreate them.
        for (const spec of specs) for (const value of Object.values(spec.settings)) {
          if (value && typeof value === 'object' && 'kind' in value && value.kind === 'indicator'
            && 'instanceId' in value && typeof value.instanceId === 'string') {
            used.add(value.instanceId);
            reservedIds.add(value.instanceId);
          }
        }
        let generated = 0;
        for (const spec of specs) {
          if (spec.instanceId === undefined) {
            do { spec.instanceId = `restored-study-${++generated}`; } while (used.has(spec.instanceId));
            used.add(spec.instanceId);
          }
          reservedIds.add(spec.instanceId);
        }
        const descriptors = new Map(specs.filter(spec => hasIndicator(spec.indicatorId))
          .map(spec => [spec.instanceId!, getIndicator(spec.indicatorId)]));
        const nodes = specs.flatMap(spec => {
          const descriptor = descriptors.get(spec.instanceId!);
          if (descriptor && spec.plotPriceScaleIds !== undefined) {
            spec.plotPriceScaleIds = parseIndicatorPlotPriceScales(descriptor, spec.plotPriceScaleIds);
          }
          if (descriptor) {
            validateIndicatorInputs(descriptor.inputs, spec.settings);
            // Against the slot the price pane will hold once the layout lands:
            // an old layout puts it at the top, a partial one leaves it be.
            validateIndicatorScaleAssignment(descriptor, spec.priceScaleId, spec.plotPriceScaleIds, spec.paneIndex,
              panes === undefined ? this._host._primaryIndex() : primaryPane ?? 0);
          }
          return descriptor ? [{ id: spec.instanceId!, descriptor, settings: spec.settings }] : [];
        });
        studies = { specs, order: planIndicatorDependencies(nodes).order, descriptors };
      }
    } catch (error) {
      return { applied: false, series: [], indicators: 0, reason: error instanceof Error ? error.message : 'Invalid saved alerts or identities' };
    }
    // Restore callbacks may add studies before the saved layout is applied.
    this._host._reserveAlertStudyIds(alerts, reservedIds);
    for (const id of reservedIds) this._host._indicatorReservedIds.add(id);
    const generation = ++this._restoreGeneration;
    const previousPriceOnly = this._host._priceOnlyAutoScale;
    const previousLegendCollapsed = this._host._indicatorLegendCollapsed;
    this._host.emit('state:restore:start', {});
    const before = this._host._timeScale.visibleRange();
    try {
      // A start listener can synchronously install a newer layout on this chart.
      if (generation !== this._restoreGeneration) {
        return { applied: false, series: [], indicators: 0, reason: 'superseded by a newer chart restore' };
      }
      // The layout setters a restore calls are the restore, which the start
      // and end events announce; they do not each fire `layout:change`.
      const report = this._host._withinLayoutChange(() =>
        this._host._mutateTimeScale(() => this._restoreState(s, alerts, reservedIds, panes, primaryPane ?? 0, studies, preservedFormats)));
      if (report.applied && generation === this._restoreGeneration && (previousPriceOnly !== this._host._priceOnlyAutoScale
        || previousLegendCollapsed !== this._host._indicatorLegendCollapsed)) {
        this._host.emit('objects:change', {});
      }
      return report;
    }
    finally {
      preservedFormats.clear();
      // Restore listeners can replace the viewport after its last internal paint.
      this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      this._host._emitViewportIfMoved(before);
      this._host.emit('state:restore:end', {});
    }
  }

  private _restoreState(s: ChartState & ChartSettingsState & { timezone?: unknown }, alerts: AlertsDocument | undefined,
    reservedIds: Set<string>, panes: PaneState[] | undefined, primaryPane: number, studies: PreparedIndicatorRestore | undefined,
    preservedFormats: PreservedScaleFormats): RestoreReport {

    // Old locks describe the outgoing ranges, not the settings about to be restored.
    if (panes) for (const pane of this._host._panes) pane.clearRatioLocks();

    if (s.grid) this._host.setGridOptions(s.grid);
    // Canvas before the panes: its margins are chart-wide, and a pane's own
    // saved marginTop/marginBottom is the more specific answer, so it must land
    // last and win.
    if (s.canvas) this._host.setCanvasOptions(s.canvas);
    if (s.statusLine) this._host.setStatusLineOptions(s.statusLine);
    if (s.watermark) this._host.setWatermarkOptions(s.watermark);
    if (s.trading) this._host.setTradingSettings(s.trading);
    if (s.axisChrome) this._host.setAxisChromeOptions(s.axisChrome);
    if (s.navigation && typeof s.navigation === 'object') this._host._patchNavigation(s.navigation);
    if (s.events) this._host.setEventOptions(s.events);
    if (s.crosshairMode) this._host._crosshairMode = s.crosshairMode;
    if (typeof s.crosshairSnapToBar === 'boolean') this._host._crosshairSnapToBar = s.crosshairSnapToBar;
    const priceOnly = Object.getOwnPropertyDescriptor(s, 'priceOnlyAutoScale');
    if (priceOnly && typeof priceOnly.value === 'boolean') this._host._priceOnlyAutoScale = priceOnly.value;
    const collapsed = Object.getOwnPropertyDescriptor(s, 'indicatorLegendCollapsed');
    if (collapsed && typeof collapsed.value === 'boolean') this._host._indicatorLegendCollapsed = collapsed.value;
    this._host._restackLegends();
    // A saved zone is data of unknown provenance, so an unrecognised name is
    // skipped rather than thrown: the rest of the layout is still restorable,
    // and a whole saved workspace should not be lost to one stale zone name.
    if (typeof s.timezone === 'string' && isValidTimezone(s.timezone)) this._host.setTimezone(s.timezone);

    // The panes themselves first: the indicators below are placed by index, so
    // the panes have to exist and be weighted before they are rebuilt. Their
    // price scales are *not* set here, see below. The price pane goes to its
    // saved slot before anything is applied by index, and a layout that names
    // no slot is one from before the price pane could move: its slot is 0.
    if (panes) {
      for (let i = 0; i < panes.length; i++) this._host._ensurePane(i);
      this._host.setPrimaryPaneIndex(primaryPane);
      panes.forEach((ps, i) => { this._host._panes[i].weight = ps.weight; });
    }
    if (panes || studies) {
      // A layout that does not fold a pane opens it, and the price pane never
      // folds, in whatever slot. That covers a pane it does not list at all:
      // rebuilt studies land on the existing panes and would otherwise open
      // inside a stale strip.
      this._host._panes.forEach((pane, i) => {
        if (pane !== this._host._primaryPane && panes?.[i]?.collapsed) this._host._collapsed.add(pane);
        else this._host._collapsed.delete(pane);
      });
      this._host._relayout();
      this._host._rehomeAnchored();
    }

    // Indicators are fully derivable from the source data, so they *can* be
    // recreated. Replace rather than append, so restore is idempotent.
    let indicators = 0;
    if (studies) {
      this._host._indicatorRefreshes.clear();
      // A restore is the host's act: it replaces a protected study as well.
      for (const instance of this._host._indicators.splice(0)) instance.remove({ force: true });
      const byId = new Map(studies.specs.map(spec => [spec.instanceId!, spec]));
      for (const id of studies.order) {
        const spec = byId.get(id)!;
        const descriptor = studies.descriptors.get(id)!;
        const instance = new IndicatorInstance(
          this._host._indicatorHost(preservedFormats), descriptor, spec.settings, spec.paneIndex,
          spec.instanceId, reservedIds, spec.priceScaleId, spec.plotPriceScaleIds, spec.policy,
        );
        reservedIds.add(instance.id);
        this._host._indicators.push(instance);
        if (spec.visible === false) instance.setVisible(false);
        indicators += 1;
      }
      const display = new Map(studies.specs.map((spec, index) => [spec.instanceId!, index]));
      this._host._indicators.sort((a, b) => display.get(a.id)! - display.get(b.id)!);
      // With the studies it is read with: a layout from before the source could
      // move says nothing, and the source stays behind the studies just made.
      this._host._sourceAbove = s.sourceAbove;
      this._host._reorderIndicatorResources();
    }

    // Price scales last of all, for the same reason the canvas block goes
    // first: this is the most specific answer for each pane, and everything
    // above moves ranges around. Rebuilding an indicator in particular takes a
    // pane's axis with it, so a scale restored before that step is a scale the
    // restore then throws away.
    const ratioLocks: { pane: Pane; id: PriceScaleId; reference: NonNullable<PriceScaleState['ratioLock']> }[] = [];
    if (panes) {
      panes.forEach((ps, i) => {
        const pane = this._host._panes[i];
        if (pane === undefined) return;
        const entries = [['right', ps.priceScale], ...Object.entries(ps.scales ?? {})] as [PriceScaleId, PriceScaleState][];
        pane.restoreAxisPlacements(new Map(entries.flatMap(([id, saved]) => saved.placement ? [[id, saved.placement] as const] : [])));
        for (const [id, saved] of entries) {
          const scale = pane.scaleFor(id);
          const options: Partial<PriceScaleOptions> = {
            marginTop: saved.marginTop, marginBottom: saved.marginBottom, minMove: saved.minMove,
            mode: saved.mode, inverted: saved.inverted,
          };
          if (saved.minPrecision !== undefined) options.minPrecision = saved.minPrecision;
          // Legacy snapshots may carry an instrument tick broadcast into an oscillator.
          // New snapshots explicitly preserve the precision configured on each scale.
          scale.setOptions(id === 'right' && saved.minPrecision === undefined ? this._host._scalePatchFor(pane, options) : options);
          const claim = saved.indicatorRange ? this._host._indicatorRanges.get(saved.indicatorRange.instanceId) : undefined;
          const ownDefault = claim && claim.pane === pane && claim.scaleId === id
            && saved.fixedRange?.min === claim.range.min && saved.fixedRange?.max === claim.range.max;
          if (ownDefault) {
            if (!scale.ownsFixedRange(claim.token)) {
              scale.setFixedRange(null);
              scale.setAutoScale(true);
              scale.setOwnedFixedRange(claim.token, claim.range);
              this._host._ownedScaleRanges.set(scale, claim.token);
            }
            scale.setAutoScale(true);
            if (saved.indicatorRange!.manual) {
              scale.setAutoScale(false);
              if (saved.range) scale.setPriceRange(saved.range);
            }
          } else {
            if (saved.fixedRange !== undefined) scale.setFixedRange(saved.fixedRange);
            scale.setAutoScale(saved.autoScale);
            if (!saved.autoScale && saved.range) scale.setPriceRange(saved.range);
          }
          if (saved.ratioLock) ratioLocks.push({ pane, id, reference: saved.ratioLock });
        }
      });
    }

    // Drawings name panes by slot, in the layout the state describes, which is
    // the one standing now. They go on before the pruning below, so a pane the
    // restore then empties and removes shifts them with every other pane
    // (`paneRemoved`) instead of leaving them on slots that have moved. The
    // case that needs it: a host that swaps studies keeps its drawings, and a
    // study pane above the price pane empties, which moves the price pane up.
    this._host._drawingState = s.drawings;
    this._host.emit('drawings:restore', s.drawings ?? []);

    // Unavailable studies leave empty panes, but a live study can have no plot
    // series. Keep its pane and host primitives; chart furniture alone does not
    // occupy a pane. Walk backwards so removal keeps the remaining indices valid.
    // A study pane above the price pane is as prunable as one below it.
    for (let i = this._host._panes.length - 1; i >= 0; i--) {
      const pane = this._host._panes[i];
      if (pane !== this._host._primaryPane && pane.series().length === 0 && !this._host._indicators.some(study => study.paneIndex === i)
        && pane.primitives().every(primitive => primitive === this._host._timeNav || this._host._anchored.some(entry => entry.primitive === primitive))) this._host.removePane(i);
    }

    this._host._alertState = alerts;
    this._host._recomputeAxisColumns();
    if (s.barSpacing !== undefined) this._host._timeScale.setBarSpacing(s.barSpacing);
    if (s.viewport && this._host._dataLayer.length > 0) this._host.setVisibleLogicalRange(s.viewport);
    // Lock references belong to the saved geometry. Applying them after pane pruning
    // and viewport restoration prevents intermediate layouts from scaling the range twice.
    for (const { pane, id, reference } of ratioLocks) {
      if (this._host._panes.includes(pane)) pane.setRatioLock(id, true, reference.barSpacing, reference.height);
    }
    this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._host.emit('alerts:restore', alerts ?? { version: 1, alerts: [] });
    this._host.emit('objects:change', {});
    return { applied: true, series: s.series ?? [], indicators };
  }
}
