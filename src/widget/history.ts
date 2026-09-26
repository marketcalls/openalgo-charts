/**
 * One undo timeline for the whole chart: studies, their settings, the chart
 * type, price scales, panes and drawings, walked by one Ctrl+Z.
 *
 * The drawing controller already records its own steps, and it stays the
 * owner of them: this history holds each one by the number the controller
 * reported it under and asks the controller to take it back, so a drawing
 * step keeps every rule the controller applies to it (read-only drawings,
 * linked charts, a host's forced edit). Everything else is observed: the
 * chart announces each change it makes, from a legend button, a dialog, a
 * menu or a host's own call, and the history compares what it saw before
 * with what it sees once the turn that made the change is over. One user
 * action is one turn, so a study removed with the pane it emptied is one step.
 * A study input anchor dragged on the chart is a settings patch like any
 * other: the controller hands its step over (`delegateInputAnchorSteps`)
 * rather than holding it too, and the patch is recorded here the moment the
 * move ends, so one move is one step, taken back once.
 *
 * Five rules the design keeps:
 *
 * - **A step is taken back by making the chart look like it did, not by
 *   restoring a saved state.** A full restore recreates every study, replays
 *   managed requests and resets the drawing history; a step touches only the
 *   studies, panes and settings it changed.
 * - **Price data, alerts and orders are never history.** Nothing here writes
 *   bars, and nothing here touches the alert controller or an order route.
 *   A study brought back computes from the bars the chart holds now, and its
 *   alerts reseed silently, the way any study added to a loaded chart does.
 * - **A step that cannot be taken back leaves the history true to the chart.**
 *   What the press had done is put back, and the steps it made unreachable
 *   are dropped, rather than leaving a timeline that describes another chart.
 * - **What the host does is never a step.** A change made inside `ignore`, or
 *   by a listener while a press is being applied, drawings included, is
 *   recorded nowhere: the drawing controller runs it `untracked`, so every
 *   recorded step takes it in and no later undo or redo reverses it.
 * - **A study's policy is its host's.** No press removes, reconfigures or
 *   moves a study its policy keeps from the user, however old the step: the
 *   press leaves that part out and does the rest, and a step left with
 *   nothing to do is dropped, so `canUndo` and `canRedo` stay true. A change
 *   only the host could have made, a forced call on a study it protects, is
 *   recorded as no step.
 */
import { applyChartSettings, filterLinkAppearance, readChartSettings } from 'openalgo-charts';
import type {
  Chart, ChartSettingsValues, IndicatorApi, IndicatorPolicy, IndicatorSettings, IPrimitive, Pane, PriceAxisSide, PriceScaleId, PriceScaleMode,
  SeriesApi, SeriesType,
} from 'openalgo-charts';
import { DRAWING_STATE_VERSION, type Drawing, type DrawingChangeEvent, type DrawingController, type DrawingsDocument } from 'openalgo-charts/draw';

/** What a step changes, for a label or a test. */
export type ChartHistoryChange =
  | 'study-add' | 'study-remove' | 'study-settings' | 'study-visibility' | 'study-scale' | 'study-pane' | 'study-order'
  | 'chart-type' | 'series-scale' | 'pane-add' | 'pane-remove' | 'pane-order' | 'pane-weight' | 'pane-collapse' | 'axis'
  | 'settings' | 'drawing' | 'command';

/** A description of the step an undo or redo would take. */
export interface ChartHistoryStep {
  /** The label a host gave `transact`, `group` or `push`. */
  label?: string;
  changes: readonly ChartHistoryChange[];
}

/**
 * A host's own reversible step, for a change the history cannot observe or
 * make itself: a host that rebuilds its chart to switch the chart type. A
 * return of exactly `false`, or a throw, is a failure.
 */
export interface ChartHistoryCommand {
  label?: string;
  undo(): unknown;
  redo(): unknown;
}

/** A step that could not be applied. The history has already put the chart back. */
export interface ChartHistoryError {
  direction: 'undo' | 'redo';
  step: ChartHistoryStep;
  error: unknown;
}

export interface ChartHistoryOptions {
  /** The drawing controller whose steps join the timeline. */
  draw?: DrawingController | null;
  /** Most steps kept; the oldest go first. Default 100. */
  limit?: number;
  /** The series whose type and scale are history. Default: the chart's primary series. */
  series?: () => SeriesApi | null;
  /** How the chart type is set, so a host's own bookkeeping runs. Default: `setSeriesType` on that series. */
  setChartType?: (type: string) => unknown;
  /** Called when an undo or redo fails. */
  onError?: (error: ChartHistoryError) => void;
}

interface StudyShot {
  id: string;
  indicatorId: string;
  settings: IndicatorSettings;
  pane: number;
  visible: boolean;
  scale: PriceScaleId | null;
  plots: Record<string, PriceScaleId>;
  /** The host's restrictions, when it set any: a study brought back comes back with them. Never compared. */
  policy?: IndicatorPolicy;
}

interface AxisShot {
  side: PriceAxisSide;
  order: number;
  mode: PriceScaleMode;
  inverted: boolean;
  marginTop: number;
  marginBottom: number;
  // Only in a full capture: a pan, a zoom or an axis drag changes both, and
  // those are views of the chart rather than edits to it.
  auto?: boolean;
  lock?: boolean;
}

/**
 * `series` counts every series in the pane, a study's plots and a host's own
 * alike. A pane with none keeps the range its scales last had, and that range
 * is all that places its drawings, so it is held in `ranges` to make such a
 * pane again; it is a view, never compared.
 */
interface PaneShot {
  key: number; weight: number; collapsed: boolean; series: number; axes: Record<string, AxisShot>;
  ranges?: Record<string, { min: number; max: number }>;
}

interface Shot {
  full: boolean;
  type: string | null;
  scale: PriceScaleId | null;
  studies: StudyShot[];
  panes: PaneShot[];
  settings?: ChartSettingsValues;
}

/**
 * What differs between two captures, field by field: the scope a step
 * reaches. A step writes these fields and no others, so a change the host
 * made to a neighbouring field since is still there after an undo.
 */
interface Delta {
  type: boolean;
  scale: boolean;
  settings: string[];
  studies: Map<string, StudyDelta>;
  kinds: Set<ChartHistoryChange>;
  order: boolean;
  paneOrder: boolean;
  panes: Map<number, PaneDelta>;
  /** Panes only the second capture has, and panes only the first has: what a step makes and removes. */
  born: number[];
  gone: number[];
}

/** A study present on one side only is `presence`; otherwise the fields that differ. */
interface StudyDelta { presence: boolean; keys: string[]; visible: boolean; scale: boolean; pane: boolean }
interface PaneDelta { weight: boolean; collapsed: boolean; axes: Map<string, (keyof AxisShot)[]> }

/** A drawing a removed pane took with it, and the pane it goes back on. */
interface Orphan { pane: number; drawing: Drawing }

/**
 * A drawing step, by the number its controller holds it under, with the
 * drawings either side of it. A host that rebuilds its chart replaces the
 * controller, and the new one holds none of the old steps; such a step is
 * `detached` and is taken back from the two documents instead.
 */
interface Step { id: number; before: DrawingsDocument; after: DrawingsDocument; detached: boolean }

interface Part {
  label?: string;
  before?: Shot;
  after?: Shot;
  steps?: Step[];
  commands?: ChartHistoryCommand[];
  orphans?: Orphan[];
  linked?: boolean;
}

/** A transaction in progress: what it began from (again after an `ignore` inside it), and what it holds so far. */
interface Tx { label?: string; before: Shot; steps: Step[]; commands: ChartHistoryCommand[] }

/** A group in progress; `redo` and `shifted` are what its entry took away, for a group that ends as no step. */
interface Group { entry: Entry | null; label?: string; depth: number; redo?: Entry[]; shifted?: Entry }

/**
 * One stretch of chart changes. `epoch` names the baseline its `before` was
 * measured from: changes on one baseline merge into one stretch, and one a
 * host's own change interrupted starts another, so taking the step back never
 * takes the host's change with it.
 */
interface Stretch { before: Shot; after: Shot; epoch: number }

interface Entry {
  label?: string;
  changes: Stretch[];
  steps: Step[];
  commands: ChartHistoryCommand[];
  orphans: Orphan[];
  /**
   * The step announced an appearance change (`style:change`), which linked
   * charts follow; taking it back or applying it again announces the result.
   */
  linked?: boolean;
}

const OBSERVED = ['objects:change', 'indicatorRemoved', 'paneAdded', 'paneRemoved', 'paneMoved', 'paneCollapsed',
  'paneResized', 'priceAxisMoved', 'priceAxisPlacementChanged'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Structural equality for the plain data a capture holds. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!same(a[key], b[key])) return false;
  return true;
}

const isSource = (v: unknown): v is { kind: 'indicator'; instanceId: string; plotKey: string } =>
  isRecord(v) && v.kind === 'indicator' && typeof v.instanceId === 'string';

/** Settings with every study-source reference renamed, as a detached copy. */
function renameSources(settings: Readonly<IndicatorSettings>, rename: (id: string) => string): IndicatorSettings {
  const out: IndicatorSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    out[key] = isSource(value) ? { ...value, instanceId: rename(value.instanceId) }
      : Array.isArray(value) ? value.map(item => (isRecord(item) ? { ...item } : item)) as never
      : isRecord(value) ? { ...value } as never : value;
  }
  return out;
}

/**
 * What the chart lets a step do now. A study's policy is its host's, and no
 * undo or redo overrides it: a step leaves a protected study as the policy
 * keeps it and does the rest of what it records, the way the drawing history
 * leaves a read-only drawing.
 */
interface Rules {
  /** The policy of the study a step names, as it is on the chart now; null when it is not there. */
  policy(id: string, indicatorId: string): Readonly<IndicatorPolicy> | null;
  /** Whether the stacking order `to` records can be put back without moving a study that may not move. */
  order(to: Shot): boolean;
}

/**
 * Captures compared on what both hold: settings and the view-driven axis
 * fields only in full ones. With `rules`, what the chart would refuse is left
 * out: the delta is then what a press can still do.
 */
function diff(a: Shot, b: Shot, rules?: Rules): Delta {
  const d: Delta = {
    type: false, scale: false, settings: [], studies: new Map(), kinds: new Set(), order: false, paneOrder: false, panes: new Map(), born: [], gone: [],
  };
  if (a.type !== b.type) { d.type = true; d.kinds.add('chart-type'); }
  if (a.scale !== b.scale) { d.scale = true; d.kinds.add('series-scale'); }
  if (a.settings && b.settings) {
    for (const key of new Set([...Object.keys(a.settings), ...Object.keys(b.settings)])) {
      if (key in a.settings && key in b.settings && !same(a.settings[key], b.settings[key])) d.settings.push(key);
    }
    if (d.settings.length) d.kinds.add('settings');
  }
  const left = new Map(a.studies.map(s => [s.id, s]));
  const right = new Map(b.studies.map(s => [s.id, s]));
  const whole: StudyDelta = { presence: true, keys: [], visible: true, scale: true, pane: true };
  for (const [id, s] of left) {
    const t = right.get(id);
    const policy = rules?.policy(id, s.indicatorId) ?? {};
    if (t === undefined) {
      if (policy.removable !== false) { d.studies.set(id, whole); d.kinds.add('study-remove'); }
      continue;
    }
    const keys = policy.configurable === false ? []
      : [...new Set([...Object.keys(s.settings), ...Object.keys(t.settings)])].filter(key => !same(s.settings[key], t.settings[key]));
    const sd: StudyDelta = {
      presence: false, keys, visible: s.visible !== t.visible,
      scale: policy.configurable !== false && (s.scale !== t.scale || !same(s.plots, t.plots)),
      pane: policy.movable !== false && s.pane !== t.pane,
    };
    if (keys.length) d.kinds.add('study-settings');
    if (sd.visible) d.kinds.add('study-visibility');
    if (sd.scale) d.kinds.add('study-scale');
    if (sd.pane) d.kinds.add('study-pane');
    if (keys.length || sd.visible || sd.scale || sd.pane) d.studies.set(id, sd);
  }
  for (const [id, t] of right) {
    if (left.has(id)) continue;
    // A study its policy kept from the user's remove went by the host's hand,
    // and only the host brings it back.
    if (rules !== undefined && t.policy?.removable === false) continue;
    d.studies.set(id, whole);
    d.kinds.add('study-add');
  }
  // Stacking is per pane: the order of the studies both captures share, pane by pane.
  const stack = (shot: Shot, pane: number): string[] => shot.studies.filter(s => s.pane === pane && left.has(s.id) && right.has(s.id)).map(s => s.id);
  for (const pane of new Set(b.studies.map(s => s.pane))) if (!same(stack(a, pane), stack(b, pane))) d.order = true;
  if (d.order && rules !== undefined && !rules.order(b)) d.order = false;
  if (d.order) d.kinds.add('study-order');
  const before = new Map(a.panes.map(p => [p.key, p]));
  const after = new Set(b.panes.map(p => p.key));
  // A pane a study brought or took is that study's change. One that came or
  // went on its own is a step of its own, unless it holds a series: that is a
  // host's plotted data, which history never makes or removes.
  const carried = (p: PaneShot, shot: Shot): boolean => shot.studies.some(s => s.pane === p.key && d.studies.has(s.id));
  const own = (p: PaneShot, shot: Shot): boolean => carried(p, shot) || p.series === 0;
  d.gone = a.panes.filter(p => !after.has(p.key) && own(p, a)).map(p => p.key);
  d.born = b.panes.filter(p => !before.has(p.key) && own(p, b)).map(p => p.key);
  if (a.panes.some(p => d.gone.includes(p.key) && !carried(p, a))) d.kinds.add('pane-remove');
  if (b.panes.some(p => d.born.includes(p.key) && !carried(p, b))) d.kinds.add('pane-add');
  const shared = b.panes.filter(p => before.has(p.key));
  const was = a.panes.filter(p => shared.some(q => q.key === p.key)).map(p => p.key);
  if (!same(was, shared.map(p => p.key))) { d.paneOrder = true; d.kinds.add('pane-order'); }
  for (const p of shared) {
    const q = before.get(p.key)!;
    const pd: PaneDelta = { weight: !same(p.weight, q.weight), collapsed: p.collapsed !== q.collapsed, axes: new Map() };
    if (pd.weight) d.kinds.add('pane-weight');
    if (pd.collapsed) d.kinds.add('pane-collapse');
    for (const [id, axis] of Object.entries(p.axes)) {
      const other = q.axes[id];
      if (other === undefined) continue;
      const fields = (Object.keys(axis) as (keyof AxisShot)[]).filter(field => field in other && !same(axis[field], other[field]));
      if (fields.length) { pd.axes.set(id, fields); d.kinds.add('axis'); }
    }
    if (pd.weight || pd.collapsed || pd.axes.size) d.panes.set(p.key, pd);
  }
  // Three chart settings read the price pane's scale but write every pane's.
  // Replayed after a change made to one axis from its own menu, they would
  // move every other pane's scale too, so they stay in a step only when the
  // step moved that field on every pane, as the chart-wide write does. The
  // axes carry the change either way; auto-fit has no chart-wide default to
  // restore, so it is left to them always.
  const broad: Record<string, keyof AxisShot | null> = { 'scales.mode': 'mode', 'scales.inverted': 'inverted', 'scales.autoScale': null };
  d.settings = d.settings.filter(key => {
    const field = broad[key];
    return field === undefined || (field !== null && shared.every(p => d.panes.get(p.key)?.axes.get('right')?.includes(field)));
  });
  if (!d.settings.length) d.kinds.delete('settings');
  return d;
}

const empty = (d: Delta): boolean => d.kinds.size === 0;

/** The change that walking a step the other way makes. The rest read the same both ways. */
const REVERSED: Partial<Record<ChartHistoryChange, ChartHistoryChange>> = {
  'study-add': 'study-remove', 'study-remove': 'study-add', 'pane-add': 'pane-remove', 'pane-remove': 'pane-add',
};

/** One stretch of a step as a press walks it. */
interface Move { from: Shot; to: Shot; delta: Delta }

class HistoryFailure extends Error {}
const fail = (why: string): never => { throw new HistoryFailure(why); };

/**
 * The chart-wide undo and redo coordinator. Build one per chart, give it the
 * drawing controller, and send every undo and redo press through it.
 */
export class ChartHistory {
  private _chart: Chart;
  private _draw: DrawingController | null;
  private readonly _opts: ChartHistoryOptions;
  private readonly _limit: number;
  private _undo: Entry[] = [];
  private _redo: Entry[] = [];
  /** What the chart looked like after the last recorded, applied or ignored change. */
  private _base: Shot;
  /** Bumped whenever the baseline moves for a change that is not recorded. */
  private _epoch = 0;
  private _pending = false;
  private _applying = 0;
  private _ignoring = 0;
  private _restoring = 0;
  private _tx: Tx | null = null;
  /** The transaction in progress announced an appearance change. */
  private _styled = false;
  /** The drawings as of the last change the controller reported: the `before` of the next step. */
  private _drawings: DrawingsDocument = { version: DRAWING_STATE_VERSION, drawings: [] };
  private _group: Group | null = null;
  private _dragging = false;
  /** A study or pane change seen during a drawing drag, recorded when the drag ends. */
  private _deferred = false;
  /** Drawings the controller dropped without a step, waiting to learn whether a pane went with them. */
  private _dropped: Drawing[] = [];
  private _orphans: Orphan[] = [];
  private readonly _keys = new WeakMap<object, number>();
  private _nextKey = 1;
  /** Study ids as the history knows them, and the ids a study brought back under a new one answers to. */
  private readonly _canon = new Map<string, string>();
  private readonly _aliases = new Map<string, string>();
  private readonly _listeners = new Set<() => void>();
  private _off: (() => void)[] = [];
  /** Gives the drawing controller its study anchor steps back. */
  private _release: (() => void) | null = null;
  /** Numbers the names a study holding an id the history keeps for another goes by. */
  private _nextHolder = 1;
  /** `_ready()` as of the last notice. */
  private _heard = '';
  private _destroyed = false;

  public constructor(chart: Chart, options: ChartHistoryOptions = {}) {
    this._chart = chart;
    this._draw = options.draw ?? null;
    this._opts = options;
    this._limit = Math.max(1, Math.floor(options.limit ?? 100));
    this._base = this._shot(false);
    this._drawings = this._document();
    this._listen();
    this._claim();
  }

  public get isDestroyed(): boolean { return this._destroyed; }

  /**
   * Follow a chart a host rebuilt (and its drawing controller), keeping the
   * timeline. Panes are matched by slot and studies by id, which is what a
   * chart restored from the old one's `getState` keeps. Drawing steps the old
   * controller held are taken back from the drawings either side of them,
   * since the new controller holds none of them.
   */
  public attach(chart: Chart, draw: DrawingController | null = this._draw): void {
    if (this._destroyed) return;
    for (const off of this._off.splice(0)) off();
    const keys = this._base.panes.map(p => p.key);
    if (draw !== this._draw) this._detachSteps();
    this._chart = chart;
    this._draw = draw;
    this._claim();
    this._drawings = this._document();
    chart.panes().forEach((pane, slot) => { if (keys[slot] !== undefined) this._keys.set(pane, keys[slot]); });
    this._pending = false;
    this._dragging = false;
    this._deferred = false;
    this._rebase();
    this._listen();
    this._notify();
  }

  public canUndo(): boolean { return this._undo.some(entry => this._reachable(entry, 'undo')); }
  public canRedo(): boolean { return this._redo.some(entry => this._reachable(entry, 'redo')); }

  /** The step an undo would take, or null. */
  public peekUndo(): ChartHistoryStep | null { return this._peek(this._undo, 'undo'); }
  /** The step a redo would take, or null. */
  public peekRedo(): ChartHistoryStep | null { return this._peek(this._redo, 'redo'); }

  /** Take back the latest step. False when there was none, or it could not be applied. */
  public undo(): boolean { return this._move('undo'); }
  /** Apply again the step an undo took back. False when there was none, or it could not be applied. */
  public redo(): boolean { return this._move('redo'); }

  /**
   * Run `fn` as one step: every change it makes to the chart and its drawings
   * is taken back by one undo. Changes the chart does not announce (a pane
   * weight, a scale option, a chart setting) are recorded only this way.
   * Nested calls join the outermost one. A throw still records what `fn`
   * changed before it, then rethrows. An `ignore` inside it is left out of
   * the step, which is taken back on either side of it.
   */
  public transact<T>(fn: () => T, label?: string): T {
    if (this._destroyed || this._chart.isDestroyed || this._applying > 0 || this._ignoring > 0 || this._tx !== null) return fn();
    // A group, so the stretches either side of an ignore are one entry.
    const end = this.group(label);
    this._flush();
    const tx: Tx = this._tx = { label, before: this._shot(true), steps: [], commands: [] };
    try {
      return fn();
    } finally {
      this._cut(tx);
      this._tx = null;
      end();
    }
  }

  /** Record what the transaction changed since it began, or since the last ignore inside it. */
  private _cut(tx: Tx): void {
    this._pending = false;
    const after = this._shot(true);
    this._base = after;
    const linked = this._styled;
    this._styled = false;
    this._record({ label: tx.label, before: tx.before, after, steps: tx.steps.splice(0), commands: tx.commands.splice(0), orphans: this._takeOrphans(), linked });
  }

  /** Measure the chart afresh after a change that is not a step, so no later step takes it in. */
  private _rebase(): void {
    this._epoch++;
    this._base = this._shot(false);
  }

  /**
   * Merge everything recorded until the returned function runs into one step:
   * a dialog that previews its edits live, a colour dragged through a picker.
   * A group whose changes cancel out (a dialog's Cancel) leaves no step.
   * Groups nest; the outermost decides.
   */
  public group(label?: string): () => void {
    if (this._destroyed) return () => {};
    if (this._group !== null) {
      this._group.depth++;
      return this._closer(this._group);
    }
    this._flush();
    const group: Group = this._group = { entry: null, label, depth: 1 };
    return this._closer(group);
  }

  /**
   * Run `fn` as the host's own change rather than a user step: nothing it
   * does to the chart or its drawings is recorded, and no undo or redo takes
   * it back. The redo branch is kept. Inside a transaction or a group, the
   * step is recorded on either side of it and leaves it alone.
   */
  public ignore<T>(fn: () => T): T {
    // A press being applied is already the host's, drawings included.
    if (this._destroyed || this._applying > 0) return fn();
    const tx = this._ignoring === 0 ? this._tx : null;
    if (tx !== null) this._cut(tx);
    else this._flush();
    this._ignoring++;
    try { return this._untracked(fn); }
    finally {
      if (--this._ignoring === 0) {
        this._pending = false;
        this._orphans = [];
        this._styled = false;
        this._rebase();
        // The transaction goes on from here, measured in full as it began.
        if (tx !== null && this._tx === tx) this._base = tx.before = this._shot(true);
      }
    }
  }

  /** Run `fn` with the drawing controller recording nothing, as the host's own act. */
  private _untracked<T>(fn: () => T): T {
    const draw = this._draw;
    return draw !== null && !draw.isDestroyed ? draw.untracked(fn) : fn();
  }

  /** Record a host's own reversible step, for a change the history cannot observe. */
  public push(command: ChartHistoryCommand): void {
    if (this._destroyed || this._applying > 0) return;
    if (this._tx !== null) { this._tx.commands.push(command); return; }
    this._flush();
    this._record({ label: command.label, commands: [command] });
  }

  /** Forget every step. The chart is left as it is. */
  public clear(): void {
    this._undo = [];
    this._redo = [];
    if (this._group !== null) this._group.entry = null;
    this._pending = false;
    this._orphans = [];
    this._dropped = [];
    if (!this._destroyed) { this._drawings = this._document(); this._rebase(); }
    this._notify();
  }

  /** Called after every change to what `canUndo`, `canRedo` or the peeks report. */
  public subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  public destroy(): void {
    if (this._destroyed) return;
    this.clear();
    this._destroyed = true;
    for (const off of this._off.splice(0)) off();
    this._release?.();
    this._release = null;
    this._listeners.clear();
  }

  /**
   * Take the study anchor steps of the drawing controller in hand, giving the
   * previous one's back. The controller would otherwise hold each move as a
   * step of its own beside the settings patch recorded here, so one move
   * would need two presses, and a press on the drawing history alone would
   * find a step this timeline had already taken back.
   */
  private _claim(): void {
    this._release?.();
    this._release = null;
    const draw = this._draw;
    if (draw !== null && !draw.isDestroyed) this._release = draw.delegateInputAnchorSteps(() => this._anchorMoved());
  }

  /**
   * An anchor move has written its patch: record it now, as the step it is,
   * rather than at the end of the turn, so a control asking `canUndo` right
   * after the release already sees it. Inside a transaction or a group it
   * joins that step as any observed change does.
   */
  private _anchorMoved(): void {
    if (this._destroyed || this._applying > 0 || this._ignoring > 0 || this._restoring > 0 || this._tx !== null) return;
    this._flush();
  }

  // ── recording ────────────────────────────────────────────────────────

  private _listen(): void {
    const chart = this._chart;
    if (chart.isDestroyed) return;
    const on = (event: string, fn: (payload: unknown) => void): void => { this._off.push(chart.on(event, fn)); };
    for (const event of OBSERVED) on(event, () => this._observe(event));
    // A press that grabs something starts an action of its own: whatever came
    // before it in the same turn is a step already, not part of the drag's.
    on('drag:start', () => this._flush());
    on('draw:preview', () => { this._dragging = true; });
    on('draw:preview-clear', () => {
      this._dragging = false;
      if (this._deferred) { this._deferred = false; this._observe('objects:change'); }
    });
    // Linked charts follow an appearance change the chart announces; a step
    // that made one announces its result again when it is walked.
    on('style:change', () => {
      if (this._tx !== null && this._applying === 0 && this._ignoring === 0 && this._restoring === 0) this._styled = true;
    });
    on('draw:remove', payload => {
      const drawing = (payload as { drawing?: Drawing } | null)?.drawing;
      if (drawing !== undefined && this._applying === 0) this._dropped.push(drawing);
    });
    on('drawing:change', payload => this._drawingChange(payload as DrawingChangeEvent));
    on('draw:destroy', payload => {
      if ((payload as { controller?: unknown } | null)?.controller !== this._draw) return;
      this._detachSteps();
      this._draw = null;
      this._release = null;
    });
    on('state:restore:start', () => { this._restoring++; this._pending = false; });
    on('state:restore:end', () => {
      // A restored layout is a different document: its studies were rebuilt
      // and its drawings reloaded, so no step recorded before it still applies.
      if (--this._restoring === 0) this.clear();
    });
    // The timeline outlives its chart: a host that rebuilds attaches the new one.
    on('destroy', () => { if (this._chart === chart) for (const off of this._off.splice(0)) off(); });
  }

  private _observe(event: string): void {
    if (this._destroyed || this._applying > 0 || this._ignoring > 0 || this._restoring > 0 || this._tx !== null) return;
    // A drawing drag writes the drawing state every frame, and nothing a drag
    // does is a study or a pane, so the capture waits for the drag to end; a
    // study changed meanwhile is still recorded then.
    if (event === 'objects:change' && this._dragging) { this._deferred = true; return; }
    if (this._pending) return;
    this._pending = true;
    queueMicrotask(() => { if (this._pending) this._flush(); });
  }

  /** Record the change observed since the last capture, now rather than at the end of the turn. */
  private _flush(): void {
    if (!this._pending || this._destroyed) return;
    this._pending = false;
    // Joining a stretch a transaction measured in full, measure in full too,
    // or the settings it recorded would drop out of the comparison.
    const changes = this._group?.entry?.changes;
    const last = changes === undefined ? undefined : changes[changes.length - 1];
    const now = this._shot(last?.before.full === true && last.epoch === this._epoch);
    const before = this._base;
    this._base = now;
    this._record({ before, after: now, orphans: this._takeOrphans() });
  }

  private _drawingChange(change: DrawingChangeEvent): void {
    const dropped = this._dropped;
    this._dropped = [];
    if (this._destroyed || this._applying > 0) return;
    const before = this._drawings;
    this._drawings = this._document();
    if (change.step !== undefined) {
      // Inside `ignore` the controller records nothing; a step now comes from
      // a controller this history does not run, and stays that controller's.
      if (this._ignoring > 0) return;
      const step: Step = { id: change.step, before, after: this._drawings, detached: false };
      if (this._tx !== null) { this._tx.steps.push(step); return; }
      this._flush();
      this._record({ steps: [step] });
      return;
    }
    // Drawings gone without a step, as a pane went: the pane took them, and
    // they come back when the step that removed it is undone. The controller
    // can hear the pane go before the history does, so the pane is looked
    // for too. A host's forced delete, with no pane gone, stays deleted.
    if (change.kind === 'update' && change.linked !== true && dropped.length > 0 && (this._pending || this._tx !== null || this._paneGone())) {
      const keys = this._base.panes.map(p => p.key);
      for (const drawing of dropped) {
        const pane = keys[drawing.paneIndex];
        if (pane !== undefined) this._orphans.push({ pane, drawing });
      }
      return;
    }
    if (change.kind === 'undo' || change.kind === 'redo') this._follow(change.kind);
  }

  private _document(): DrawingsDocument {
    return this._draw?.toJSON() ?? { version: DRAWING_STATE_VERSION, drawings: [] };
  }

  /** Whether a pane the last capture held has gone from the chart since. */
  private _paneGone(): boolean {
    const live = new Set(this._chart.panes().map(pane => this._keys.get(pane)));
    return this._base.panes.some(p => !live.has(p.key));
  }

  /** The controller holding these steps is gone: from now on they are taken back from their documents. */
  private _detachSteps(): void {
    for (const entry of [...this._undo, ...this._redo]) for (const step of entry.steps) step.detached = true;
    if (this._tx !== null) for (const step of this._tx.steps) step.detached = true;
  }

  private _takeOrphans(): Orphan[] {
    const out = this._orphans;
    this._orphans = [];
    return out;
  }

  private _record(part: Part): void {
    const changed = part.before !== undefined && part.after !== undefined && !empty(diff(part.before, part.after));
    // A change no undo could take back under the policies of the studies it
    // touches is the host's own, a forced call on a study it protects: no
    // step, and what follows is measured from it, as after an `ignore`.
    const chart = changed && !empty(diff(part.after!, part.before!, this._rules));
    if (changed && !chart) this._epoch++;
    if (!chart && !part.steps?.length && !part.commands?.length) {
      // Nothing recorded, but a policy set since can have moved what a press
      // would do (a step about a study now protected): the controls hear it.
      this._notifyIfMoved();
      return;
    }
    let entry: Entry;
    const group = this._group;
    if (group !== null && group.entry !== null) entry = group.entry;
    else {
      entry = { label: group?.label, changes: [], steps: [], commands: [], orphans: [] };
      this._undo.push(entry);
      const shifted = this._undo.length > this._limit ? this._undo.shift() : undefined;
      // A group that ends as no step gives these back.
      if (group !== null) Object.assign(group, { entry, redo: this._redo, shifted });
    }
    this._merge(entry, part, chart);
    this._redo = [];
    this._notify();
  }

  private _merge(entry: Entry, part: Part, chart: boolean): void {
    entry.label ??= part.label;
    if (part.linked === true) entry.linked = true;
    if (chart) {
      const before = part.before!, after = part.after!;
      const last = entry.changes[entry.changes.length - 1];
      if (last === undefined || last.epoch !== this._epoch) entry.changes.push({ before, after, epoch: this._epoch });
      else {
        // An observed change opened the stretch and a transaction joined it:
        // the settings it started from are the ones just before that
        // transaction, since nothing observed changes a setting.
        if (!last.before.full && before.full) {
          last.before = { ...last.before, full: true, settings: before.settings, panes: fill(last.before.panes, before.panes) };
        }
        last.after = after;
      }
      entry.orphans.push(...(part.orphans ?? []));
    }
    entry.steps.push(...(part.steps ?? []));
    entry.commands.push(...(part.commands ?? []));
  }

  private _closer(group: Group): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--group.depth > 0 || this._group !== group) return;
      this._flush();
      this._group = null;
      const entry = group.entry;
      // Changes that cancel out, the way a dialog's Cancel puts them back,
      // are no step at all, and take nothing away: the redo branch and the
      // oldest step its entry displaced come back.
      const changes = entry?.changes ?? [];
      if (entry !== null && !entry.steps.length && !entry.commands.length
        && (!changes.length || empty(diff(changes[0].before, changes[changes.length - 1].after)))) {
        const at = this._undo.lastIndexOf(entry);
        if (at >= 0) {
          this._undo.splice(at, 1);
          if (group.shifted !== undefined) this._undo.unshift(group.shifted);
          if (!this._redo.length && group.redo !== undefined) this._redo = group.redo;
        }
      }
      this._notify();
    };
  }

  // ── capture ──────────────────────────────────────────────────────────

  private _keyOf(pane: Pane): number {
    let key = this._keys.get(pane);
    if (key === undefined) { key = this._nextKey++; this._keys.set(pane, key); }
    return key;
  }

  private _canonical(id: string): string { return this._canon.get(id) ?? id; }
  private _liveId(id: string): string { return this._aliases.get(id) ?? id; }

  private _series(): SeriesApi | null {
    const series = this._opts.series ? this._opts.series() : this._chart.primarySeries();
    return series ?? null;
  }

  private _shot(full: boolean): Shot {
    const chart = this._chart;
    const shot: Shot = { full, type: null, scale: null, studies: [], panes: [] };
    if (chart.isDestroyed) return shot;
    const panes = chart.panes();
    const keys = panes.map(pane => this._keyOf(pane));
    const series = this._series();
    const scale = series?.priceScale();
    if (series) shot.type = chart.seriesType(series);
    panes.forEach((pane, slot) => {
      const axes: Record<string, AxisShot> = {};
      for (const [id, state] of Object.entries(pane.scaleStates())) {
        if (state === undefined) continue;
        const scaleId = id as PriceScaleId;
        if (scale !== undefined && pane.scaleFor(scaleId) === scale) shot.scale = scaleId;
        const placement = chart.priceAxisPlacement(slot, scaleId);
        const axis: AxisShot = {
          side: placement?.side ?? (scaleId === 'left' || scaleId === 'right' ? scaleId : 'hidden'), order: placement?.order ?? 0,
          mode: state.mode, inverted: state.inverted, marginTop: state.marginTop, marginBottom: state.marginBottom,
        };
        if (full) { axis.auto = state.autoScale; axis.lock = pane.ratioLocked(scaleId); }
        axes[id] = axis;
      }
      const p: PaneShot = { key: keys[slot], weight: chart.paneWeight(slot), collapsed: chart.paneCollapsed(slot), series: pane.series().length, axes };
      if (p.series === 0) {
        p.ranges = {};
        for (const id of Object.keys(axes)) {
          const scale = pane.scaleFor(id as PriceScaleId);
          if (scale.scaled) p.ranges[id] = scale.priceRange();
        }
      }
      shot.panes.push(p);
    });
    shot.studies = chart.indicators().map(study => {
      const policy = study.policy();
      return {
        id: this._canonical(study.id), indicatorId: study.indicatorId,
        settings: renameSources(study.settings(), id => this._canonical(id)),
        pane: keys[study.paneIndex] ?? -1, visible: study.visible(),
        scale: study.priceScaleId(), plots: { ...study.plotPriceScaleIds() },
        ...(Object.keys(policy).length ? { policy: { ...policy } } : {}),
      };
    });
    if (full) shot.settings = readChartSettings(chart);
    return shot;
  }

  // ── applying ─────────────────────────────────────────────────────────

  private _peek(stack: Entry[], direction: 'undo' | 'redo'): ChartHistoryStep | null {
    for (let i = stack.length - 1; i >= 0; i--) if (this._reachable(stack[i], direction)) return this._describe(stack[i], direction);
    return null;
  }

  /**
   * The step as it was made, in what a press would still change: the
   * policies the studies hold now leave out what they keep.
   */
  private _describe(entry: Entry, direction: 'undo' | 'redo'): ChartHistoryStep {
    const changes = new Set<ChartHistoryChange>();
    // An undo walks a step backwards, so what it removes is what the step added.
    const made = (kind: ChartHistoryChange): ChartHistoryChange => (direction === 'redo' ? kind : REVERSED[kind] ?? kind);
    for (const move of this._moves(entry, direction)) for (const kind of move.delta.kinds) changes.add(made(kind));
    if (entry.steps.length) changes.add('drawing');
    if (entry.commands.length) changes.add('command');
    return { ...(entry.label === undefined ? {} : { label: entry.label }), changes: [...changes] };
  }

  /**
   * The stretches a press would walk, in the order it walks them (newest
   * first for an undo), each from where it left the chart back to where it
   * found it, with what the chart lets it change now. One the policies leave
   * nothing to do is left out.
   */
  private _moves(entry: Entry, direction: 'undo' | 'redo'): Move[] {
    const undo = direction === 'undo';
    return (undo ? entry.changes.slice().reverse() : entry.changes)
      .map(change => ({ from: undo ? change.after : change.before, to: undo ? change.before : change.after }))
      .map(move => ({ ...move, delta: diff(move.from, move.to, this._rules) }))
      .filter(move => !empty(move.delta));
  }

  /** Whether a press would find anything to do in this step. */
  private _reachable(entry: Entry, direction: 'undo' | 'redo'): boolean {
    if (entry.commands.length || this._moves(entry, direction).length) return true;
    const held = this._draw?.historySteps()[direction] ?? [];
    return entry.steps.some(step => step.detached || held.includes(step.id));
  }

  private _move(direction: 'undo' | 'redo'): boolean {
    if (this._destroyed || this._applying > 0 || this._chart.isDestroyed) return false;
    this._flush();
    // A step is closed by a press: what follows it is a new one.
    if (this._group !== null) this._group.entry = null;
    const from = direction === 'undo' ? this._undo : this._redo;
    const to = direction === 'undo' ? this._redo : this._undo;
    for (let entry = from.pop(); entry !== undefined; entry = from.pop()) {
      const outcome = this._run(entry, direction);
      if (outcome === 'skip') continue;
      if (outcome === 'done') to.push(entry);
      // A step that failed makes every step behind it unreachable: those
      // describe a chart this one no longer leads back to.
      else from.length = 0;
      this._notify();
      return outcome === 'done';
    }
    this._notify();
    return false;
  }

  private _run(entry: Entry, direction: 'undo' | 'redo'): 'done' | 'skip' | 'fail' {
    const undo = direction === 'undo';
    const held = this._draw?.historySteps();
    // A step its own controller dropped (a reset, a trim, a host edit that
    // left it nothing to do) is gone for good; one whose controller was
    // replaced is still taken back, from its documents.
    entry.steps = entry.steps.filter(step => step.detached || (held !== undefined && (held.undo.includes(step.id) || held.redo.includes(step.id))));
    // A step the studies' policies now leave nothing to do (removing a study
    // the host protected since) is dropped here, as the drawing history
    // drops one a read-only drawing leaves empty, and the press goes on.
    const moves = this._moves(entry, direction);
    if (!entry.commands.length && !moves.length && !entry.steps.length) return 'skip';
    const done = { steps: [] as Step[], moves: 0, commands: 0 };
    const look = entry.linked === true ? this._look() : null;
    this._applying++;
    try {
      // A drawing a listener makes meanwhile is the host's reaction, not a step.
      this._untracked(() => {
        if (!undo) for (const command of entry.commands) { if (command.redo() === false) fail('command'); done.commands++; }
        if (undo) this._drawSteps(entry.steps.slice().reverse(), 'undo', done.steps);
        // Counted before it runs: a stretch that fails halfway is put back too.
        for (const move of moves) { done.moves++; this._apply(move.from, move.to, move.delta); }
        if (undo) this._restoreOrphans(entry.orphans);
        if (!undo) this._drawSteps(entry.steps, 'redo', done.steps);
        if (undo) for (const command of entry.commands.slice().reverse()) { if (command.undo() === false) fail('command'); done.commands++; }
      });
      // Every linked chart heard the change when it was made, so it hears
      // where the step leaves it, whichever calls the step made on the way.
      if (look !== null && !this._chart.isDestroyed) {
        const now = this._look();
        const moved = Object.fromEntries(Object.entries(now).filter(([key, value]) => !same(look[key], value)));
        if (Object.keys(moved).length) this._chart.emit('style:change', moved);
      }
      return 'done';
    } catch (error) {
      this._rollback(entry, direction, done, moves);
      try { this._opts.onError?.({ direction, step: this._describe(entry, direction), error }); } catch { /* A host's report cannot undo the rollback. */ }
      return 'fail';
    } finally {
      this._applying--;
      this._pending = false;
      this._dropped = [];
      this._orphans = [];
      this._drawings = this._document();
      this._rebase();
    }
  }

  /** Put back what a failed press had changed, as far as it can be. */
  private _rollback(entry: Entry, direction: 'undo' | 'redo', done: { steps: Step[]; moves: number; commands: number },
    moves: readonly Move[]): void {
    const undo = direction === 'undo';
    const quietly = (fn: () => void): void => { try { this._untracked(fn); } catch { /* Best effort: the stacks are trimmed either way. */ } };
    const commands = undo ? entry.commands.slice().reverse() : entry.commands;
    for (const command of commands.slice(0, done.commands).reverse()) quietly(() => { if (undo) command.redo(); else command.undo(); });
    for (const move of moves.slice(0, done.moves).reverse()) quietly(() => this._apply(move.to, move.from, diff(move.to, move.from, this._rules)));
    quietly(() => this._drawSteps(done.steps.slice().reverse(), undo ? 'redo' : 'undo', []));
  }

  /** The chart settings a linked chart follows, as the chart reads now. */
  private _look(): Record<string, unknown> {
    return this._chart.isDestroyed ? {} : filterLinkAppearance(readChartSettings(this._chart));
  }

  /** Ask the drawing controller to take each step back (or again), newest first for an undo. */
  private _drawSteps(steps: readonly Step[], direction: 'undo' | 'redo', done: Step[]): void {
    const draw = this._draw;
    if (draw === null) { if (steps.length) fail('drawing'); return; }
    for (const step of steps) {
      // A step the controller holds under one this history does not would
      // take that one back with it; this step is taken from its documents
      // from now on, and the other is left where it is.
      const branch = draw.historySteps()[direction];
      if (!step.detached && branch.includes(step.id) && branch[branch.length - 1] !== step.id) step.detached = true;
      if (step.detached) {
        // No controller holds it: put each drawing it changed back to how
        // the other side of the step had it, outside any controller's history.
        const [from, to] = direction === 'undo' ? [step.after, step.before] : [step.before, step.after];
        const left = new Map(from.drawings.map(d => [d.id, d]));
        const right = new Map(to.drawings.map(d => [d.id, d]));
        for (const id of new Set([...left.keys(), ...right.keys()])) {
          if (!same(left.get(id), right.get(id))) draw.applyLinkedDrawing(id, right.get(id) ?? null);
        }
        done.push(step);
        continue;
      }
      // Normally one press; a step the controller finds empty is skipped by
      // it, so keep pressing until this one has moved, within reason.
      for (let guard = 0; draw.historySteps()[direction].includes(step.id) && guard < 1000; guard++) {
        if (!(direction === 'undo' ? draw.undo() : draw.redo())) break;
      }
      if (draw.historySteps()[direction].includes(step.id)) fail('drawing');
      done.push(step);
    }
  }

  /** Someone moved along the drawing branches directly: follow, so the next press is not out of step. */
  private _follow(direction: 'undo' | 'redo'): void {
    const steps = this._draw?.historySteps();
    if (steps === undefined) return;
    const from = direction === 'undo' ? this._undo : this._redo;
    const to = direction === 'undo' ? this._redo : this._undo;
    const moved = direction === 'undo' ? steps.redo : steps.undo;
    for (let top = from[from.length - 1]; top !== undefined; top = from[from.length - 1]) {
      if (top.commands.length || top.changes.length || !top.steps.length || !top.steps.every(step => !step.detached && moved.includes(step.id))) break;
      to.push(from.pop()!);
    }
    this._notify();
  }

  private _restoreOrphans(orphans: readonly Orphan[]): void {
    const draw = this._draw;
    if (draw === null) return;
    for (const { pane, drawing } of orphans) {
      const slot = this._slot(pane);
      if (slot >= 0 && draw.get(drawing.id) === undefined) draw.applyLinkedDrawing(drawing.id, { ...drawing, paneIndex: slot });
    }
  }

  private _slot(key: number): number {
    return this._chart.panes().findIndex(pane => this._keys.get(pane) === key);
  }

  /**
   * The study on the chart a step names. A study of another kind under the
   * same id is not it: a host that placed one under an id that came free
   * gets it left alone rather than taken for the one the step means.
   */
  private _find(id: string, indicatorId?: string): IndicatorApi | undefined {
    const live = this._liveId(id);
    return this._chart.indicators().find(study => study.id === live && (indicatorId === undefined || study.indicatorId === indicatorId));
  }

  /** What the chart lets a step do now, read from the studies' policies (see `diff`). */
  private readonly _rules: Rules = {
    policy: (id, indicatorId) => (this._chart.isDestroyed ? null : this._find(id, indicatorId)?.policy() ?? null),
    order: to => this._stackPlan(to).some(plan => !plan.blocked),
  };

  /** Make the chart look like `to` in everything `d` reaches, and nothing else. */
  private _apply(from: Shot, to: Shot, d: Delta): void {
    const chart = this._chart;
    const wanted = new Map(to.studies.map(s => [s.id, s]));
    const had = new Map(from.studies.map(s => [s.id, s]));
    // Studies that go, first: a pane they empty goes with them.
    for (const id of d.studies.keys()) {
      if (wanted.has(id)) continue;
      const live = this._find(id, had.get(id)?.indicatorId);
      if (live !== undefined && !chart.removeIndicator(live.id)) fail('remove');
    }
    // Studies that come back or change pane, each producer before a study reading it.
    const pending = to.studies.filter(s => {
      const sd = d.studies.get(s.id);
      return sd !== undefined && (sd.presence || sd.pane) && this._find(s.id, s.indicatorId)?.paneIndex !== this._slot(s.pane);
    });
    const placed: StudyShot[] = [];
    while (pending.length) {
      const waits = (s: StudyShot): boolean => Object.values(s.settings).some(v => isSource(v) && pending.some(p => p !== s && p.id === v.instanceId));
      const at = Math.max(0, pending.findIndex(s => !waits(s)));
      placed.push(...pending.splice(at, 1));
    }
    // A pane brought back is whole again: weight, fold and every axis.
    const fresh = new Set<number>();
    // Made empty, at the end: its studies and drawings go into it next, and
    // it goes to its place with the others. The chart makes a pane for a
    // primitive, and keeps it when the primitive goes.
    for (const key of d.born) {
      if (this._slot(key) >= 0) continue;
      const slot = chart.panes().length;
      const hold: IPrimitive = { zOrder: () => 'bottom', draw: () => {} };
      chart.addPrimitive(hold, slot);
      chart.removePrimitive(hold);
      const pane = chart.panes()[slot];
      if (pane === undefined) fail('pane');
      this._keys.set(pane, key);
      fresh.add(key);
    }
    let added = false;
    for (const s of placed) {
      let slot = this._slot(s.pane);
      const create = slot < 0;
      if (create) slot = chart.panes().length;
      const live = this._find(s.id, s.indicatorId);
      if (live === undefined) { this._add(s, slot, to); added = true; }
      else if (live.paneIndex !== slot && !chart.moveIndicator(live.id, slot)) fail('move');
      const pane = chart.panes()[slot];
      if (create && pane !== undefined) { this._keys.set(pane, s.pane); fresh.add(s.pane); }
    }
    // A pane the step removes goes once its studies have: with what is left
    // in it, unless a host has plotted a series there since.
    for (const key of d.gone) {
      const slot = this._slot(key);
      if (slot >= 0 && chart.panes()[slot].series().length === 0 && !chart.removePane(slot)) fail('pane');
    }
    if (d.paneOrder || fresh.size) this._arrange(to);
    for (const p of to.panes) {
      const pd = d.panes.get(p.key);
      const whole = fresh.has(p.key);
      const slot = pd !== undefined || whole ? this._slot(p.key) : -1;
      if (slot < 0) continue;
      if ((whole || pd!.weight) && !same(chart.paneWeight(slot), p.weight)) chart.setPaneWeight(slot, p.weight);
      if ((whole || pd!.collapsed) && chart.paneCollapsed(slot) !== p.collapsed && !chart.setPaneCollapsed(slot, p.collapsed)) fail('collapse');
    }
    for (const s of to.studies) {
      const sd = d.studies.get(s.id);
      if (sd !== undefined && !sd.presence) this._fit(s, sd);
    }
    // A study brought back joins the end of its pane's stack; it goes back
    // to the row it held.
    if (d.order || added) this._stack(to);
    const series = this._series();
    if (d.type && to.type !== null && series !== null && chart.seriesType(series) !== to.type) {
      if (this._opts.setChartType) this._opts.setChartType(to.type);
      else chart.setSeriesType(series, to.type as SeriesType);
      if (chart.seriesType(series) !== to.type) fail('chart type');
    }
    if (d.scale && to.scale !== null && series !== null) chart.setSeriesPriceScale(series, to.scale);
    if (d.settings.length && to.settings) {
      const now = readChartSettings(chart);
      const patch: ChartSettingsValues = {};
      for (const key of d.settings) if (key in to.settings && !same(now[key], to.settings[key])) patch[key] = to.settings[key];
      if (Object.keys(patch).length) applyChartSettings(chart, patch);
    }
    // Axes last: the most specific answer for each scale, after the chart-wide settings.
    for (const p of to.panes) {
      const fields = fresh.has(p.key) ? null : d.panes.get(p.key)?.axes;
      if (fields !== null && !fields?.size) continue;
      const slot = this._slot(p.key);
      if (slot >= 0) this._axes(slot, p, fields ?? null);
      // A pane made again with nothing plotted in it has no data to fit its
      // scales to: they get back the range its drawings were placed against.
      const pane = chart.panes()[slot];
      if (fields === null && pane !== undefined && pane.series().length === 0) {
        for (const [id, range] of Object.entries(p.ranges ?? {})) pane.scaleFor(id as PriceScaleId).setComputedRange(range);
      }
    }
    this._check(from, to, d);
  }

  /**
   * Bring a study back under the instance id it had, so the studies reading
   * it and the alerts naming it find it again. A study the host placed
   * under that id since holds it, and two cannot answer to one id, so this
   * one comes back under a fresh id then: every step that names it and the
   * studies `to` has reading it follow, and the holder is a study of its own
   * to the history from here on.
   */
  private _add(s: StudyShot, slot: number, to: Shot): void {
    const chart = this._chart;
    const previous = this._liveId(s.id);
    const options: Parameters<Chart['addIndicator']>[2] = { paneIndex: slot, instanceId: s.id };
    if (s.scale !== null) options.priceScaleId = s.scale;
    if (Object.keys(s.plots).length) options.plotPriceScaleIds = s.plots;
    if (s.policy !== undefined) options.policy = { ...s.policy };
    const settings = this._liveSettings(s.settings);
    let study: IndicatorApi;
    let holder: IndicatorApi | undefined;
    try {
      study = chart.addIndicator(s.indicatorId, settings, options);
    } catch (error) {
      holder = chart.indicators().find(other => other.id === s.id);
      if (holder === undefined) throw error;
      const fresh = { ...options };
      delete fresh.instanceId;
      study = chart.addIndicator(s.indicatorId, settings, fresh);
    }
    if (study.id !== previous) {
      this._canon.delete(previous);
      this._aliases.set(s.id, study.id);
      this._canon.set(study.id, s.id);
      // Its readers as the step has them; one the host pointed at the holder is the host's.
      for (const r of to.studies) {
        const keys = Object.keys(r.settings).filter(key => isSource(r.settings[key]) && (r.settings[key] as { instanceId: string }).instanceId === s.id);
        const reader = keys.length ? this._find(r.id, r.indicatorId) : undefined;
        if (reader === undefined) continue;
        const current = reader.settings();
        const patch: IndicatorSettings = {};
        for (const key of keys) {
          const value = current[key];
          if (isSource(value) && value.instanceId !== study.id) patch[key] = { ...value, instanceId: study.id };
        }
        if (Object.keys(patch).length) reader.setSettings(patch);
      }
    }
    if (holder !== undefined) {
      // The holder's own name to the history, one no study answers to.
      let own = `${holder.id}~${this._nextHolder++}`;
      while (this._aliases.has(own) || chart.indicators().some(other => other.id === own)) own = `${holder.id}~${this._nextHolder++}`;
      this._canon.set(holder.id, own);
      this._aliases.set(own, holder.id);
    }
    if (!s.visible) study.setVisible(false);
  }

  private _liveSettings(settings: IndicatorSettings): IndicatorSettings {
    return renameSources(settings, id => this._liveId(id));
  }

  /** The settings keys, visibility and scale assignment a step changed on one study. */
  private _fit(s: StudyShot, sd: StudyDelta): void {
    const live = this._find(s.id, s.indicatorId);
    if (live === undefined) return;
    const settings = this._liveSettings(s.settings);
    const current = live.settings();
    const patch: IndicatorSettings = {};
    for (const key of sd.keys) if (key in settings && !same(current[key], settings[key])) patch[key] = settings[key];
    if (Object.keys(patch).length) live.setSettings(patch);
    if (sd.visible && live.visible() !== s.visible) live.setVisible(s.visible);
    if (!sd.scale) return;
    if (live.priceScaleId() !== s.scale && !live.setPriceScale(s.scale)) fail('scale');
    const plots = live.plotPriceScaleIds();
    const assign: Record<string, PriceScaleId | null> = {};
    for (const [key, id] of Object.entries(s.plots)) if (plots[key] !== id) assign[key] = id;
    for (const key of Object.keys(plots)) if (!(key in s.plots)) assign[key] = null;
    if (Object.keys(assign).length && !live.setPlotPriceScales(assign)) fail('scale');
  }

  /**
   * Put the panes `to` knows into its order, one adjacent move at a time,
   * leaving any pane it does not know (a host's own, added since) in its slot.
   */
  private _arrange(to: Shot): void {
    const chart = this._chart;
    const keys = (): number[] => chart.panes().map(pane => this._keyOf(pane));
    const known = to.panes.map(p => p.key).filter(key => keys().includes(key));
    const now = keys();
    const desired = now.slice();
    let next = 0;
    now.forEach((key, i) => { if (known.includes(key)) desired[i] = known[next++]; });
    for (let i = 0; i < desired.length; i++) {
      for (let at = keys().indexOf(desired[i]); at > i; at--) if (!chart.movePane(at, -1)) fail('pane order');
    }
  }

  /**
   * Each pane whose studies `to` stacks in another order than the chart does
   * now: the order it wants, over the studies both hold, the rest keeping
   * their rows. `blocked` when that would give a study that may not move
   * (`movable: false`) another row; the pane is then left as it is.
   */
  private _stackPlan(to: Shot): { slot: number; desired: string[]; blocked: boolean }[] {
    const plans: { slot: number; desired: string[]; blocked: boolean }[] = [];
    if (this._chart.isDestroyed) return plans;
    for (const p of to.panes) {
      const slot = this._slot(p.key);
      if (slot < 0) continue;
      const studies = this._chart.indicators().filter(study => study.paneIndex === slot);
      const now = studies.map(study => this._canonical(study.id));
      const known = to.studies.filter(s => s.pane === p.key).map(s => s.id).filter(id => now.includes(id));
      const desired = now.slice();
      let next = 0;
      now.forEach((id, i) => { if (known.includes(id)) desired[i] = known[next++]; });
      if (same(desired, now)) continue;
      plans.push({ slot, desired, blocked: studies.some((study, i) => study.policy().movable === false && desired[i] !== now[i]) });
    }
    return plans;
  }

  /** Put each pane's studies back into `to`'s stacking order, where no study that may not move would have to. */
  private _stack(to: Shot): void {
    const chart = this._chart;
    const at = (id: string): IndicatorApi | undefined => chart.indicators().find(study => study.id === this._liveId(id));
    for (const { slot, desired, blocked } of this._stackPlan(to)) {
      if (blocked) continue;
      const ids = (): string[] => chart.indicators().filter(study => study.paneIndex === slot).map(study => this._canonical(study.id));
      for (let i = 0; i < desired.length; i++) {
        for (let row = ids().indexOf(desired[i]); row > i; row--) {
          // One row up. A study that may not move ends where it began, but
          // another passing it moves it a row on the way, so it goes back by
          // the one above it moving down, which that one's policy allows.
          const up = at(desired[i]);
          const moved = up?.policy().movable !== false
            ? chart.reorderIndicator(this._liveId(desired[i]), -1)
            : chart.reorderIndicator(this._liveId(ids()[row - 1]), 1);
          if (!moved) fail('study order');
        }
      }
    }
  }

  /** One pane's axes as `p` has them, in the fields `only` names per scale, or every field for a pane brought back. */
  private _axes(slot: number, p: PaneShot, only: Map<string, (keyof AxisShot)[]> | null): void {
    const chart = this._chart;
    const pane = chart.panes()[slot];
    const live = pane.scaleStates();
    for (const [id, axis] of Object.entries(p.axes)) {
      const state = live[id as PriceScaleId];
      const fields = only?.get(id);
      if (state === undefined || (only !== null && fields === undefined)) continue;
      const wants = (field: keyof AxisShot): boolean => fields === undefined || fields.includes(field);
      const scaleId = id as PriceScaleId;
      const placement = chart.priceAxisPlacement(slot, scaleId);
      if ((wants('side') || wants('order')) && placement !== null && (placement.side !== axis.side || placement.order !== axis.order)) {
        chart.setPriceAxisPlacement(slot, scaleId, axis.side, axis.order);
      }
      const patch: { mode?: PriceScaleMode; inverted?: boolean; marginTop?: number; marginBottom?: number } = {};
      if (wants('mode') && state.mode !== axis.mode) patch.mode = axis.mode;
      if (wants('inverted') && state.inverted !== axis.inverted) patch.inverted = axis.inverted;
      if (wants('marginTop') && !same(state.marginTop, axis.marginTop)) patch.marginTop = axis.marginTop;
      if (wants('marginBottom') && !same(state.marginBottom, axis.marginBottom)) patch.marginBottom = axis.marginBottom;
      if (Object.keys(patch).length) chart.setPriceAxisOptions(slot, scaleId, patch);
      if (wants('auto') && axis.auto !== undefined && state.autoScale !== axis.auto) chart.setPriceAxisAutoFit(slot, scaleId, axis.auto);
      if (wants('lock') && axis.lock !== undefined && pane.ratioLocked(scaleId) !== axis.lock) chart.setPriceAxisLockRatio(slot, scaleId, axis.lock);
    }
  }

  /** The structure a step promises: each study it reaches present or gone, on its pane, and the panes in order. */
  private _check(from: Shot, to: Shot, d: Delta): void {
    const wanted = new Map(to.studies.map(s => [s.id, s]));
    const had = new Map(from.studies.map(s => [s.id, s]));
    for (const [id, sd] of d.studies) {
      const s = wanted.get(id);
      const live = this._find(id, (s ?? had.get(id))?.indicatorId);
      if ((s === undefined) !== (live === undefined)) fail('study');
      if ((sd.presence || sd.pane) && s !== undefined && live !== undefined && this._slot(s.pane) !== live.paneIndex) fail('study pane');
    }
    if (d.paneOrder) {
      const keys = this._chart.panes().map(pane => this._keys.get(pane));
      const order = to.panes.map(p => p.key).filter(key => keys.includes(key));
      if (!same(keys.filter(key => key !== undefined && order.includes(key)), order)) fail('pane order');
    }
  }

  private _notify(): void {
    this._heard = this._ready();
    for (const listener of [...this._listeners]) {
      try { listener(); } catch { /* One listener cannot stop the others hearing of the change. */ }
    }
  }

  /** What an undo and a redo would do, as `subscribe` reports it: the two peeks, null when a press would do nothing. */
  private _ready(): string {
    return this._destroyed ? '' : JSON.stringify([this.peekUndo(), this.peekRedo()]);
  }

  private _notifyIfMoved(): void {
    if (this._listeners.size > 0 && this._ready() !== this._heard) this._notify();
  }
}

/** The panes of a partial capture with the view fields a full one adds, pane by pane and scale by scale. */
function fill(panes: readonly PaneShot[], full: readonly PaneShot[]): PaneShot[] {
  return panes.map(p => {
    const other = full.find(q => q.key === p.key);
    if (other === undefined) return p;
    const axes: Record<string, AxisShot> = {};
    for (const [id, axis] of Object.entries(p.axes)) {
      const more = other.axes[id];
      axes[id] = more === undefined ? axis : { ...axis, auto: more.auto, lock: more.lock };
    }
    return { ...p, axes };
  });
}
