/**
 * Series creation and the data behind a series handle: making a series and
 * the handle a host holds, changing its renderer, the price format and
 * precision it pushes onto its scale, and the replace, prepend and live-update
 * paths its `setData`, `prependData` and `update` run.
 *
 * Its own module because a series handle is where data enters the chart, and
 * its closures reach nothing of the chart beyond what `SeriesHost` names. The
 * chart reaches it through `Chart._series`, and it reaches the chart through
 * `SeriesHost`. The series maps, the primary series, the first data id and
 * the source's stacking slot stay on Chart, because the studies, the stacking
 * and the frame read them too. `addSeries` and `setSeriesType` stay public on
 * Chart as delegates and carry the documented contract. Members the chart
 * calls are public on this internal class; no entry point exports the class
 * and the chart holds it in a private field, so none of it reaches the
 * published declarations.
 */
import { InvalidationLevel } from './invalidate-mask';
import type { Chart } from './chart';
import { compactVolume, type AddSeriesOptions } from './chart-types';
import type { PreservedScaleFormats } from './chart-state';
import type { Pane } from './pane';
import type { PriceScale } from '../scale/price-scale';
import { createSeriesRecord, type SeriesApi, type BarConfirmationOptions, type SeriesUpdateOptions } from '../model/series';
import { bindSeriesProvenance, SeriesProvenance, validateSeriesOptions } from '../model/series-provenance';
import { getChartType, type SeriesType } from '../model/chart-type-registry';
import type { SeriesStyle } from '../render/series-style';
import type { Bar, SeriesDataItem } from '../model/bar';
import { toBar } from '../model/bar';
import { SeriesMarkers } from '../primitives/markers';
import { clamp } from '../helpers/math';

/**
 * The slice of the chart series creation and the data paths read, write and
 * drive. The chart itself is the host: each member carries the name and the
 * type of the chart's own, so the moved code reads as it did in chart.ts, and
 * a member the chart renames or retypes fails to compile here. The writable
 * fields are the chart's own, assigned here.
 */
export interface SeriesHost {
  readonly _panes: Chart['_panes'];
  readonly _dataLayer: Chart['_dataLayer'];
  readonly _timeScale: Chart['_timeScale'];
  readonly _seriesProvenance: Chart['_seriesProvenance'];
  readonly _seriesRecords: Chart['_seriesRecords'];
  readonly _seriesOwners: Chart['_seriesOwners'];
  readonly _firstDataId: Chart['_firstDataId'];
  readonly _priceFormatter: Chart['_priceFormatter'];
  readonly _sourceAbove: Chart['_sourceAbove'];
  readonly _width: Chart['_width'];
  readonly _leftAxisWidth: Chart['_leftAxisWidth'];
  readonly _rightAxisWidth: Chart['_rightAxisWidth'];
  _primary: Chart['_primary'];
  _firstPane: Chart['_firstPane'];
  _hasFitContent: Chart['_hasFitContent'];
  /** The chart's other collaborators, whose methods this code calls directly. */
  readonly _layout: Chart['_layout'];
  readonly _scales: Chart['_scales'];
  readonly _studies: Chart['_studies'];
  readonly _primitives: Chart['_primitives'];
  readonly _motion: Chart['_motion'];
  _primaryIndex: Chart['_primaryIndex'];
  _mutateTimeScale: Chart['_mutateTimeScale'];
  _fitDefaultView: Chart['_fitDefaultView'];
  _updateAccessibleSummary: Chart['_updateAccessibleSummary'];
  seriesType: Chart['seriesType'];
  invalidate: Chart['invalidate'];
  emit: Chart['emit'];
}

export class ChartSeries {
  private readonly _host: SeriesHost;

  public constructor(host: SeriesHost) {
    this._host = host;
  }

  public _setSeriesType(series: SeriesApi, type: SeriesType, notify: boolean): boolean {
    if (this._host.seriesType(series) === null) return false;
    const record = this._host._seriesRecords.get(series)!, owner = this._host._seriesOwners.get(series)!;
    const entry = getChartType(type);
    if (record.type === type) return false;
    const precision = record.style.precision;
    const style = { ...record.style };
    for (const key of Object.keys(owner.inheritedStyle) as (keyof SeriesStyle)[]) {
      if (style[key] === owner.inheritedStyle[key]) delete style[key];
    }
    const defaults: Partial<SeriesStyle> = {};
    for (const key of Object.keys(entry.defaultStyle) as (keyof SeriesStyle)[]) {
      if (!Object.prototype.hasOwnProperty.call(style, key)) Object.assign(defaults, { [key]: entry.defaultStyle[key] });
    }
    for (const key of Object.keys(record.style) as (keyof SeriesStyle)[]) delete record.style[key];
    Object.assign(record.style, defaults, style);
    owner.inheritedStyle = defaults;
    record.type = type;
    if (record.style.precision !== precision) {
      const scale = owner.pane.scaleOf(record);
      this._applyPrecision(scale, record.style.precision);
      if (record.style.precision === undefined) this._applySeriesPriceFormat(scale, owner.priceFormat);
    }
    this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    if (notify) this._host.emit('objects:change', {});
    return true;
  }

  /**
   * `claimPrimary` is false for series the chart creates on a caller's behalf
   * (indicator plots), so an indicator's line never becomes the price series
   * that drives the magnet crosshair and the OHLC legend.
   */
  public _createSeries(type: SeriesType, options: AddSeriesOptions, claimPrimary: boolean,
    preservedFormats?: PreservedScaleFormats): SeriesApi {
    const dataId = this._host._dataLayer.createSeries();
    const provenance = new SeriesProvenance(dataId);
    this._host._seriesProvenance.set(dataId, provenance);
    const paneIndex = options.paneIndex ?? this._host._primaryIndex();
    this._host._layout._ensurePane(paneIndex);
    const record = createSeriesRecord(dataId, type, options.style, options.priceScaleId ?? 'right');
    // A pane starts quoting the instrument the moment the host plots a price on
    // it, which is how a second symbol on a pane of its own keeps a tick-sized
    // axis. Indicator plots come through here with `claimPrimary` false, so an
    // oscillator can never promote the pane it draws in.
    if (claimPrimary && getChartType(type).isPriceSeries) this._host._scales._claimPricePane(this._host._panes[paneIndex]);
    // The first price-type series drives the magnet crosshair + OHLC legend.
    const isPrimary = claimPrimary && this._host._firstDataId.value === null && getChartType(type).isPriceSeries;
    if (isPrimary) {
      this._host._firstDataId.value = dataId;
      this._host._firstPane = this._host._panes[paneIndex];
    }
    this._host._panes[paneIndex].addSeries(record);
    this._host._layout._recomputeAxisColumns(); // reserve/free the axis columns
    /**
     * The pane this series lives on, held BY IDENTITY rather than by the index
     * it happened to be created at.
     *
     * `paneIndex` is a slot number, and slots are not stable. `removePane`
     * splices the array and everything below shifts up one; `movePane` swaps two
     * entries outright. A closure that captured the number therefore starts
     * pointing at a different pane, or at no pane at all, the moment either
     * happens -- and both are ordinary things to do with indicator panes.
     *
     * That was a real crash, not a theoretical one. Three sub-plot indicators on
     * panes 1, 2 and 3; remove the first and the survivors shift to 1 and 2
     * while their series still name 2 and 3; remove the last and
     * `this._panes[3]` is undefined, so `removeSeries` throws on undefined and
     * the teardown aborts half-done -- legend gone, plot still on the chart. The
     * quieter version is worse: when the stale index still lands on a pane that
     * exists, the series is removed from the WRONG pane and nothing reports it.
     *
     * Panes move around their series, so the object stays correct through both
     * operations and the index never has to be patched.
     */
    const inheritedStyle = { ...getChartType(type).defaultStyle };
    for (const key of Object.keys(options.style ?? {}) as (keyof SeriesStyle)[]) delete inheritedStyle[key];
    const owner = { pane: this._host._panes[paneIndex], priceFormat: options.priceFormat, inheritedStyle, indicatorOwned: !claimPrimary };
    const scale = owner.pane.scaleOf(record);
    const preserveFormat = preservedFormats?.get(owner.pane)?.has(record.scaleId) === true;
    this._applySeriesPriceFormat(scale, options.priceFormat, preserveFormat);
    if (!preserveFormat && record.style.precision !== undefined) this._applyPrecision(scale, record.style.precision);

    const api: SeriesApi = {
      setData: (bars: readonly SeriesDataItem[], metadata?: BarConfirmationOptions): void => this._setData(dataId, bars.map(toBar), metadata, owner),
      prependData: (bars: readonly SeriesDataItem[]): void => this._prependData(dataId, bars.map(toBar)),
      update: (bar: SeriesDataItem, metadata?: SeriesUpdateOptions): void => this._updateBar(dataId, toBar(bar), metadata, owner),
      getData: (): Bar[] => this._host._dataLayer.indexedBars(dataId).map((ib) => ib.bar),
      applyOptions: (patch: Partial<SeriesStyle>): void => {
        for (const key of Object.keys(patch) as (keyof SeriesStyle)[]) delete owner.inheritedStyle[key];
        Object.assign(record.style, patch);
        // Precision is a label override on the scale, not a style the renderer
        // reads, so it needs pushing across when it changes (including back to
        // "Default", which is the key present and undefined).
        if ('precision' in patch) this._applyPrecision(owner.pane.scaleOf(record), patch.precision);
        this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
        if (this._host._primary?.record === record) this._host.emit('objects:change', {});
      },
      remove: (): void => {
        const primary = this._host._primary?.record === record;
        owner.pane.removeSeries(record);
        this._host._dataLayer.removeSeries(dataId);
        this._host._seriesProvenance.delete(dataId);
        if (this._host._firstDataId.value === dataId) this._host._firstDataId.value = null;
        if (this._host._primary?.record === record) { this._host._primary = null; owner.pane.setSourceSeries(null); }
        if (!owner.indicatorOwned) this._host._studies._reconcileIndicatorRanges();
        this._host._timeScale.setBaseIndex(this._host._dataLayer.baseIndex);
        this._host._layout._recomputeAxisColumns();
        this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
        if (primary) {
          this._host.emit('data:update', { kind: 'reset' });
          this._host.emit('objects:change', {});
        }
      },
      priceScale: (): PriceScale => owner.pane.scaleOf(record),
      createMarkers: (fallbackBars?: () => readonly Bar[]): SeriesMarkers => {
        const m = new SeriesMarkers(dataId, fallbackBars, () => owner.pane.scaleOf(record));
        // Resolved now, not at creation: primitives are addressed by slot, and
        // this series' slot may have shifted since.
        this._host._primitives._addPrimitive(this._host._panes.indexOf(owner.pane), m);
        return m;
      },
    };
    this._host._seriesRecords.set(api, record);
    bindSeriesProvenance(api, provenance);
    this._host._seriesOwners.set(api, owner);
    if (!owner.indicatorOwned) this._host._studies._reconcileIndicatorRanges();
    if (isPrimary) {
      this._host._primary = { api, record };
      this._host._panes[paneIndex].setSourceSeries(record);
      // A source added after a layout placed it goes where the layout says.
      if (this._host._sourceAbove !== undefined) this._host._primitives._placeSource();
      this._host.emit('objects:change', {});
    }
    return api;
  }

  public _applySeriesPriceFormat(scale: PriceScale, pf: AddSeriesOptions['priceFormat'], preserveFormat = false): void {
    if (pf) {
      if (pf.type === 'custom') { if (!preserveFormat) scale.setPriceFormatter(pf.formatter); }
      else if (pf.type === 'volume') { if (!preserveFormat) scale.setPriceFormatter(compactVolume); }
      else if (pf.type === 'percent') {
        const digits = pf.precision ?? 2;
        if (!preserveFormat) scale.setPriceFormatter((v) => `${v.toFixed(digits)}%`);
      } else {
        if (!preserveFormat) scale.setPriceFormatter(this._host._priceFormatter);
        const minMove = pf.minMove ?? (pf.precision !== undefined ? Math.pow(10, -pf.precision) : undefined);
        if (minMove !== undefined) scale.setOptions({ minMove });
      }
    }
  }

  /**
   * Push a series' `precision` override onto the price scale it maps to.
   *
   * It rides the scale's *formatter* rather than `minMove` because minMove also
   * drives `snapToTick`: precision 0 would start snapping every price to whole
   * numbers. Going through the formatter covers the axis ticks, the last-value
   * tag, the crosshair label and the drawing-tool labels at once, since they all
   * call `priceScale.format`. Clearing it restores the chart-wide formatter.
   */
  public _applyPrecision(scale: PriceScale, precision: number | undefined): void {
    if (precision === undefined || !isFinite(precision)) {
      scale.setPriceFormatter(this._host._priceFormatter);
      return;
    }
    const digits = clamp(Math.round(precision), 0, 8);
    scale.setPriceFormatter((v) => v.toFixed(digits));
  }

  /**
   * What every pane shares and a data write can move: the shared index (its
   * length and the times at either end) and the time scale's window. A write
   * that leaves all of it as it was changes the panes holding what it wrote,
   * and no other pane has anything new to show.
   */
  public _sharedAxis(): number[] {
    const layer = this._host._dataLayer, scale = this._host._timeScale;
    return [layer.length, layer.indexToTime(0) ?? 0, layer.indexToTime(layer.baseIndex) ?? 0,
      scale.visibleRange().to, scale.barSpacing, scale.width];
  }

  /**
   * Ask for the repaint a write to `panes` needs, given `before` from
   * `_sharedAxis`. Each of those panes repaints at `Full`, so its scales
   * re-measure. Every pane repaints instead when the write moved the shared
   * index or the time scale: each pane's x positions and the time axis
   * follow them.
   */
  public _invalidateWrite(panes: Iterable<Pane>, before: readonly number[]): void {
    const after = this._sharedAxis();
    const indices = [...panes].map(pane => this._host._panes.indexOf(pane));
    if (indices.includes(-1) || after.some((value, i) => value !== before[i])) {
      this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      return;
    }
    if (indices.length === 0) return;
    this._host.invalidate((m) => {
      for (const index of indices) m.invalidatePane(index, { level: InvalidationLevel.Full, autoScale: true });
    });
  }

  /** Apply one live bar; auto-scroll only on a genuine right-edge append. */
  private _updateBar(dataId: number, bar: Bar, options: SeriesUpdateOptions | undefined, owner: { readonly pane: Pane }): void {
    validateSeriesOptions(options, true);
    const before = this._sharedAxis();
    const bars = this._host._dataLayer.seriesBars(dataId);
    const tailTime = bars[bars.length - 1]?.time;
    const change = tailTime === undefined || bar.time > tailTime ? 'append' : bar.time === tailTime ? 'replace' : 'correction';
    const wasAtRight = this._host._timeScale.rightOffset >= 0;
    const kind = this._host._dataLayer.update(dataId, bar);
    this._host._seriesProvenance.get(dataId)?.record(change, Math.max(tailTime ?? bar.time, bar.time), options);
    this._host._timeScale.setBaseIndex(this._host._dataLayer.baseIndex);
    // Only a real append advances the view; late/historical inserts must not
    // be treated as a new right-edge bar (would wrongly auto-scroll / shift).
    if (kind === 'append' && !wasAtRight) {
      this._host._mutateTimeScale(() => this._host._timeScale.setRightOffset(this._host._timeScale.rightOffset - 1));
    }
    // A tick that replaces the forming bar moves nothing the panes share, so it
    // repaints its own pane alone; the studies it feeds repaint theirs when
    // they recompute. An appended bar grows the index, and every pane repaints.
    if (dataId === this._host._firstDataId.value) this._host._studies._invalidateIndicators();
    this._invalidateWrite([owner.pane], before);
    this._host._updateAccessibleSummary();
    if (dataId === this._host._firstDataId.value) this._host.emit('data:update', { kind: 'update', time: bar.time });
  }

  private _setData(dataId: number, bars: readonly Bar[], options: BarConfirmationOptions | undefined,
    owner: { readonly pane: Pane; readonly indicatorOwned: boolean }): void {
    validateSeriesOptions(options);
    const before = this._sharedAxis();
    if (dataId === this._host._firstDataId.value) this._host._motion._stopNavigationMotion();
    this._host._dataLayer.setSeriesData(dataId, bars);
    const sorted = this._host._dataLayer.seriesBars(dataId);
    this._host._seriesProvenance.get(dataId)?.record('reset', sorted[sorted.length - 1]?.time, options);
    // An indicator's plots are series in this same layer, so `baseIndex` is the
    // longest of *all* of them, this one included. Replacing the primary series
    // wholesale can therefore leave the axis measured against an indicator that
    // has not been recomputed yet: shorten the price series and the indicator's
    // own series still holds the old, longer count until the next frame.
    //
    // That is not a cosmetic lag. `baseIndex` is what converts a logical range
    // into `rightOffset`, so a host that replaces its data and then positions
    // the viewport in the same turn -- entering replay does exactly that -- aims
    // at a right edge hundreds of bars past the end of the data and draws an
    // empty chart. Recomputing before the base index is read closes that window.
    //
    // The tick path is deliberately left deferred, which is where the coalescing
    // earns its keep: an appended bar makes the primary the longest series, so
    // the base index is already right with the indicator a bar behind, and a
    // burst of ticks between two frames still costs one recompute.
    if (dataId === this._host._firstDataId.value) {
      this._host._studies._invalidateIndicators();
      this._host._studies._flushIndicators();
    }
    this._host._timeScale.setBaseIndex(this._host._dataLayer.baseIndex);
    if (!this._host._hasFitContent && this._host._dataLayer.length > 0) {
      this._host._timeScale.setWidth(Math.max(0, this._host._width - this._host._rightAxisWidth - this._host._leftAxisWidth));
      this._host._hasFitContent = this._host._fitDefaultView();
    }
    // A study writes its plots again on every recompute, so a plot repaints
    // the pane it is on. A host's own replace still repaints every pane.
    if (owner.indicatorOwned) this._invalidateWrite([owner.pane], before);
    else this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._host._updateAccessibleSummary();
    if (dataId === this._host._firstDataId.value) this._host.emit('data:update', { kind: 'reset' });
  }

  /** History paging: merge older bars, preserving the viewport (§4.2). */
  private _prependData(dataId: number, bars: readonly Bar[]): void {
    this._host._dataLayer.addBars(dataId, bars);
    const sorted = this._host._dataLayer.seriesBars(dataId);
    this._host._seriesProvenance.get(dataId)?.record('prepend', sorted[sorted.length - 1]?.time);
    // baseIndex shifts up by the inserted count; updating it keeps the same
    // bars on screen because (rightEdge − index) is invariant.
    this._host._timeScale.setBaseIndex(this._host._dataLayer.baseIndex);
    if (dataId === this._host._firstDataId.value) this._host._studies._invalidateIndicators();
    this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._host._updateAccessibleSummary();
    if (dataId === this._host._firstDataId.value) this._host.emit('data:update', { kind: 'prepend' });
  }
}
