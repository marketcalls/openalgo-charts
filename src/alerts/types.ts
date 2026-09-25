import type { SeriesApi } from '../model/series';
import type { Bar } from '../model/bar';
import type { ChartDataContext } from '../model/indicator-registry';
import type { IndicatorApi } from '../model/indicator-instance';
import type { IPrimitive } from '../primitives/primitive';

/** A primary-source mutation, emitted after indicator invalidation. */
export interface ChartDataUpdate {
  kind: 'update' | 'reset' | 'prepend';
  time?: number;
}

/** Minimum headless chart surface needed to evaluate alerts. */
export interface AlertChartHost {
  primaryBars(): readonly Bar[];
  /** Owning price scale for primary-price drag snapping, including a left axis. */
  primarySeries?(): Pick<SeriesApi, 'priceScale'> | null;
  getDataContext(): Readonly<ChartDataContext> | undefined;
  on(event: string, callback: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
  /** Flushes computed study values. Only required by indicator-source alerts. */
  indicators?(): readonly (Pick<IndicatorApi, 'id' | 'paneIndex' | 'series' | 'values'> & Partial<Pick<IndicatorApi, 'indicatorId'>>)[];
  addPrimitive?(primitive: IPrimitive, paneIndex?: number): void;
  removePrimitive?(primitive: IPrimitive): void;
  alertState?(): AlertsDocument | undefined;
  setAlertState?(document: AlertsDocument | undefined): void;
  /**
   * A price rounded to the tick the pane's scale is written in.
   *
   * Optional, and unrounded is the fallback: a host that declares no tick has
   * nothing to round to, and inventing one would move a price somebody chose.
   */
  snapPrice?(paneIndex: number, price: number): number;
  /**
   * Slot of the price pane, where a price alert draws and where a drawing
   * needs no input plot. It moves when a host puts the price pane below its
   * studies. Optional; absent means slot 0.
   */
  primaryPaneIndex?(): number;
}

export type AlertCondition = 'crossing' | 'crossingUp' | 'crossingDown'
  | 'greaterThan' | 'lessThan' | 'enteringRange' | 'leavingRange' | 'matches';
export type AlertPolicy = 'onBarClose' | 'onTouch';
export type AlertRepeat = 'once' | 'everyTime';
export type AlertState = 'armed' | 'triggered' | 'expired' | 'disabled';

/** Prices are in primary-series units. Range conditions require upperPrice. */
export interface PriceAlertSource {
  kind: 'price';
  price: number;
  upperPrice?: number;
}

/** A threshold in plot units, anchored to one specific study instance. */
export interface IndicatorAlertSource {
  kind: 'indicator';
  instanceId: string;
  plotKey: string;
  value: number;
  upperValue?: number;
}

export interface BarConditionAlertSource {
  kind: 'barCondition';
  id: string;
}

export interface DrawingAlertSource {
  kind: 'drawing';
  drawingId: string;
  level?: string;
  /** Required for a drawing on a study pane, so prices are not compared to different units. */
  input?: { instanceId: string; plotKey: string };
}

export type AlertSource = PriceAlertSource | IndicatorAlertSource | BarConditionAlertSource | DrawingAlertSource;

/** Missing values, an absent anchor or a paused/context-mismatched chart are unavailable. */
export interface AlertAvailability {
  available: boolean;
  reason?: string;
  paneIndex?: number;
}

export interface AlertDrawingValue {
  price: number;
  upperPrice?: number;
  paneIndex: number;
}

export interface AlertDrawingLevel {
  id: string;
  title: string;
}

export interface AlertDrawingInfo extends AlertAvailability {
  levels: readonly AlertDrawingLevel[];
}

/** Implemented by the optional drawing tier; the alert engine never imports it. */
export interface AlertDrawingProvider {
  get(id: string): unknown;
  valueAt(id: string, time: number, level?: string): AlertDrawingValue | undefined;
  alertInfo(id: string): AlertDrawingInfo;
}

export interface BarConditionContext {
  /** Only the prefix through index is exposed, including for confirmed-bar checks. */
  bars: readonly Bar[];
  index: number;
}

export interface BarCondition {
  id: string;
  title: string;
  /** Runs at the alert's chosen policy, never for loaded history. */
  when(context: BarConditionContext): boolean;
}

/**
 * Evaluation belongs to the instrument and interval present when the alert was armed.
 * Fixed price levels remain visible on other intervals of the same instrument,
 * labelled with their original timeframe and paused until it is displayed again.
 */
export interface AlertScope {
  symbol?: string;
  exchange?: string;
  interval?: string;
}

export interface AlertInput {
  id?: string;
  source: AlertSource;
  condition?: AlertCondition;
  /** Defaults to onBarClose. An intrabar touch may disappear from final history. */
  policy?: AlertPolicy;
  repeat?: AlertRepeat;
  state?: 'armed' | 'disabled';
  title?: string;
  message?: string;
  cooldownSeconds?: number;
  /** UTC seconds. At this instant the alert expires before it can trigger. */
  expiresAt?: number;
  /** Opaque host routing data. The controller never interprets or delivers it. */
  payload?: unknown;
}

export type AlertPatch = Partial<Omit<AlertInput, 'id'>>;

/** Lifecycle record. Snapshots detach mutable configuration, retaining opaque payloads. */
export interface Alert extends Omit<AlertInput, 'id' | 'condition' | 'policy' | 'repeat' | 'state' | 'title' | 'cooldownSeconds'> {
  id: string;
  condition: AlertCondition;
  policy: AlertPolicy;
  repeat: AlertRepeat;
  state: AlertState;
  title: string;
  cooldownSeconds: number;
  scope: AlertScope;
  lastTriggeredAt?: number;
  lastTriggeredTime?: number;
  /** Newest confirmed bar already judged, including a nonmatch. */
  lastClosedTime?: number;
  /** Newest intrabar match consumed, including one suppressed by cooldown. */
  lastTouchedTime?: number;
}

/** Portable trader records. JSON persistence rejects unsupported host payloads. */
export interface AlertsDocument {
  version: 1;
  alerts: Alert[];
}

/** Shared delivery fields for trader and indicator-authored alerts. */
export interface AlertEventPayload {
  alertId: string;
  title: string;
  message?: string;
  /** Source bar UTC seconds and source index, not delivery wall-clock time. */
  time: number;
  index: number;
}

export interface AlertTriggeredPayload extends AlertEventPayload {
  price: number;
  alert: Alert;
}

export interface AlertControllerOptions {
  /** Delivery and expiry clock in UTC seconds. Defaults to Date.now() / 1000. */
  now?: () => number;
  drawings?: AlertDrawingProvider;
  /** PriceLine visuals are enabled on chart hosts; disable for a model-only consumer. */
  visuals?: boolean;
  /**
   * Whether a spent alert keeps its line. Defaults to `'show'`.
   *
   * A triggered or expired alert is no longer watching anything, and the two
   * defensible things to do with its line are opposites. Keeping it is this
   * library's default and is why each lifecycle state has its own badge and
   * colour: the line says what became of the level, which is worth knowing on a
   * chart somebody has just come back to.
   *
   * `'hide'` is for the host where that reading does not pay. A terminal left
   * open through a session accumulates levels that will never fire again, and
   * past a certain number the ones still watching are the hardest to pick out
   * of them. The alert itself is untouched either way: it stays in `list()`,
   * keeps its lifecycle state, still refuses to fire twice, and gets its line
   * back if a host re-arms it. Only the drawing goes.
   */
  spentLines?: 'show' | 'hide';
}
