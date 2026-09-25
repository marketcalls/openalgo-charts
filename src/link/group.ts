/**
 * Chart linking groups: a grid of charts that behaves as one workspace.
 *
 * Headless, in the spirit of `ComparisonController` and `ReplayController`. It
 * ships no DOM, so the host draws its own link badge / colour chips and decides
 * which charts belong to which group.
 *
 * Each channel switches independently because a user routinely
 * wants one without the others (mirror the cursor across four timeframes but
 * keep each zoom; or slave every chart's symbol but let each keep its own
 * window):
 *
 * - **crosshair**: hovering one chart marks the same instant on the others.
 * - **viewport**: panning or zooming one moves the others to the same window.
 * - **symbol**: changing the instrument on one changes it on the others.
 * - **interval**: changing a timeframe asks each following host to adopt it.
 * - **appearance**: visual settings pass through a structural host adapter.
 *
 * Four decisions carry the design.
 *
 * 1. **Everything crosses a chart boundary as a time, never as a logical
 *    index.** See `./align`. This is the whole difficulty of the feature: the
 *    naive version works perfectly on two charts of the same symbol and
 *    interval, which is how it would ship broken.
 *
 * 2. **A follower's crosshair is a primitive, not the chart's own crosshair.**
 *    The engine's crosshair belongs to the pointer inside that chart; a linked
 *    one is a second, weaker mark that must not fight it. See `./crosshair`.
 *
 * 3. **One re-entrancy guard covers every channel.** A syncs B, B echoes
 *    back to A, and the pair either oscillates forever or blows the stack. Any
 *    member event that arrives *while the group is broadcasting* is an echo of
 *    that broadcast by definition (a human cannot pan two charts in one call
 *    stack), so it is dropped. The guard is deliberately group-wide rather than
 *    per channel: a symbol change that reloads data can move a viewport, and
 *    that second-order echo is the same bug wearing a different hat.
 *
 * 4. **The group never keeps a destroyed chart alive.** `Chart.destroy` sets
 *    `isDestroyed` and emits `'destroy'`, so a member is released the moment it
 *    dies rather than at the next channel event. A `LinkChart` that is not a
 *    `Chart` may report neither, so members are also probed by pane count
 *    before every use (the price pane can never be removed by any other route) and
 *    dropped on the spot, which matters because `addPrimitive` on a destroyed
 *    chart would resurrect a pane.
 *
 * The host owns instrument selection and loading. It tells the group a selection changed (by
 * emitting `'symbol'` on the chart's own event bus, or by calling `setSymbol`),
 * and it supplies the per-member `onSymbol` callback that actually loads the
 * new instrument's bars. A member without `onSymbol` broadcasts symbol changes
 * but never receives them, which is how a host pins one chart of a grid.
 */
import type { IPrimitive } from '../primitives/primitive';
import type { LogicalRange } from '../scale/time-scale';
import { LinkCrosshair } from './crosshair';
import { followerIndex, followerRange, type LinkDataLayer, type LinkMissingPolicy } from './align';
import { filterLinkAppearance, type LinkAppearanceAdapter } from './appearance';

/**
 * The slice of the chart a link group drives. `Chart` satisfies it; declaring
 * it structurally keeps the group testable against a stub, which is the only
 * practical way to prove the feedback guard (the engine's own programmatic
 * setters do not echo today, and the guard exists for the day they do and for
 * the host callbacks that echo right now).
 */
export interface LinkChart {
  on(event: string, cb: (payload: unknown) => void): () => void;
  getVisibleLogicalRange(): LogicalRange;
  setVisibleLogicalRange(range: LogicalRange): void;
  readonly dataLayer: LinkDataLayer;
  /**
   * Set by `Chart`. Optional so the group stays testable against a stub and
   * usable by a host wrapping something that is not a `Chart`, but when it is
   * there it is the answer: an empty pane list is only ever an inference.
   */
  readonly isDestroyed?: boolean;
  /** Only the count is read: the fallback destruction probe. See `alive`. */
  panes(): readonly unknown[];
  addPrimitive(primitive: IPrimitive, paneIndex?: number): void;
  removePrimitive(primitive: IPrimitive): void;
  /** Optional readout support alongside the group's vertical marker. */
  setLinkedCrosshairIndex?(index: number | null): void;
}

export interface LinkOptions {
  /** Mirror the hovered instant onto every other member. Default true. */
  crosshair?: boolean;
  /** Mirror pan and zoom as a wall-clock window. Default true. */
  viewport?: boolean;
  /** Mirror the instrument, via each member's `onSymbol`. Default false. */
  symbol?: boolean;
  /** Mirror the timeframe, via each member's `onInterval`. Default false. */
  interval?: boolean;
  /** Copy visual chart settings through each member's adapter. Default false. */
  appearance?: boolean;
  /** What a follower does with an instant it has no bar for. Default 'nearest'. */
  whenMissing?: LinkMissingPolicy;
}

export interface LinkMemberOptions {
  /** Visual settings only; no instrument, timeframe, study or trading state is copied. */
  appearance?: LinkAppearanceAdapter;
  /** The instrument this chart is showing right now, if the host tracks one. */
  symbol?: string;
  /**
   * Load `symbol` into this chart. The group calls it; the host does the work
   * (fetch bars, `series.setData`). Omit to make the member symbol-read-only:
   * it still broadcasts its own changes, it just never follows anyone else's.
   */
  onSymbol?: (symbol: string, chart: LinkChart) => void;
  /** The interval this chart is showing, if the host tracks one. */
  interval?: string;
  /** Apply the interval synchronously; return false to refuse an unsupported token. */
  onInterval?: (interval: string, chart: LinkChart) => boolean | void;
}

/** Every option resolved, as `options()` reports them. */
export type ResolvedLinkOptions = Required<LinkOptions>;

const DEFAULT_OPTIONS: ResolvedLinkOptions = {
  crosshair: true,
  viewport: true,
  symbol: false,
  interval: false,
  appearance: false,
  whenMissing: 'nearest',
};

interface Member {
  chart: LinkChart;
  appearance: LinkAppearanceAdapter | null;
  symbol: string | null;
  onSymbol: ((symbol: string, chart: LinkChart) => void) | null;
  interval: string | null;
  onInterval: NonNullable<LinkMemberOptions['onInterval']> | null;
  unsubscribe: (() => void)[];
  /** One linked crosshair per pane, mirroring the global crosshair's reach. */
  crosshairs: LinkCrosshair[];
}

/**
 * Is this chart still usable?
 *
 * `isDestroyed` when the member reports it, because a flag the chart sets
 * itself cannot be wrong. The pane-count probe stays as the fallback for a host
 * whose `LinkChart` is not a `Chart`: the price pane, in whatever slot, can never
 * be removed by any other route, so an empty pane list still means destruction there.
 */
function alive(chart: LinkChart): boolean {
  if (chart.isDestroyed === true) return false;
  return chart.panes().length > 0;
}

function validInterval(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class LinkGroup {
  private readonly _members: Member[] = [];
  private _options: ResolvedLinkOptions;
  /** True while the group is applying a change to followers. See decision 3. */
  private _broadcasting = false;
  private _symbol: string | null = null;
  private _interval: string | null = null;
  private _destroyed = false;

  public constructor(options: LinkOptions = {}) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
  }

  public options(): ResolvedLinkOptions {
    return { ...this._options };
  }

  /**
   * Flip switches at runtime. Turning `crosshair` off clears the linked lines
   * immediately rather than leaving the last one frozen on every follower;
   * turning `symbol` on makes the group agree on the instrument it already
   * knows, because a switch that only takes effect on the *next* change would
   * leave a linked grid visibly unlinked.
   *
   * `viewport` has no equivalent convergence: nothing in the group says which
   * member's window the others should have adopted, so it takes effect on the
   * next pan or zoom.
   */
  public setOptions(patch: LinkOptions): void {
    const before = this._options;
    this._options = { ...before, ...patch };
    if (before.crosshair && !this._options.crosshair) {
      for (const m of this._members) this._detachCrosshairs(m);
    }
    if (!before.symbol && this._options.symbol) this._convergeSymbol();
    if (!before.interval && this._options.interval) this._convergeInterval();
  }

  public members(): readonly LinkChart[] {
    this._prune();
    return this._members.map((m) => m.chart);
  }

  public has(chart: LinkChart): boolean {
    return this._find(chart) !== null;
  }

  /** The instrument the group has agreed on, or null if nobody declared one. */
  public symbol(): string | null {
    return this._symbol;
  }

  /** Latest interval selected by a member, even while interval linking is off. */
  public interval(): string | null {
    return this._interval;
  }

  /**
   * The member's own logical index its linked crosshair is marking, or null
   * when it is showing none (it is the chart being hovered, the leader's
   * instant falls outside its coverage, or crosshair sync is off).
   *
   * A host wanting the linked bar's OHLC reads it back with
   * `chart.dataLayer.indexToTime(...)`, the same way a native crosshair readout
   * does.
   */
  public crosshairIndex(chart: LinkChart): number | null {
    return this._find(chart)?.crosshairs[0]?.index() ?? null;
  }

  /**
   * Put a chart in the group. Adding one twice updates its member options
   * instead of double-subscribing.
   *
   * A member joining a group that already has a symbol adopts it (when symbol
   * sync is on and it can follow), because joining a linked workspace is
   * exactly the moment a user expects the new chart to fall in line.
   */
  public add(chart: LinkChart, member: LinkMemberOptions = {}): void {
    if (this._destroyed || !alive(chart)) return;
    const existing = this._find(chart);
    if (existing !== null) {
      if (member.symbol !== undefined) existing.symbol = member.symbol;
      if (member.onSymbol !== undefined) existing.onSymbol = member.onSymbol;
      if (validInterval(member.interval)) existing.interval = member.interval;
      if (member.onInterval !== undefined) existing.onInterval = member.onInterval;
      if (member.appearance !== undefined) existing.appearance = member.appearance;
      if (this._options.interval) this._convergeInterval();
      return;
    }
    const entry: Member = {
      chart,
      appearance: member.appearance ?? null,
      symbol: member.symbol ?? null,
      onSymbol: member.onSymbol ?? null,
      interval: validInterval(member.interval) ? member.interval : null,
      onInterval: member.onInterval ?? null,
      unsubscribe: [],
      crosshairs: [],
    };
    entry.unsubscribe.push(
      chart.on('crosshair:move', (p) => this._onCrosshair(entry, p)),
      chart.on('pan', () => this._onViewport(entry)),
      chart.on('zoom', () => this._onViewport(entry)),
      chart.on('symbol', (p) => this._onSymbolEvent(entry, p)),
      chart.on('style:change', () => this.syncAppearance(chart)),
      chart.on('interval', (p) => {
        const interval = typeof p === 'string' ? p : (p as { interval?: unknown } | null)?.interval;
        if (validInterval(interval)) this._applyInterval(entry, interval);
      }),
      // Without this the group holds a destroyed chart (and every listener
      // closure it captured) until the next channel event happens to prune it,
      // which for a group whose other member is idle is forever.
      chart.on('destroy', () => this._prune()),
    );
    this._members.push(entry);
    // The first member to declare an instrument establishes the group's.
    if (this._symbol === null && entry.symbol !== null) this._symbol = entry.symbol;
    if (this._options.symbol) this._convergeSymbol();
    if (this._interval === null && entry.interval !== null) this._interval = entry.interval;
    if (this._options.interval) this._convergeInterval();
  }

  /** Take a chart out of the group. Safe to call twice, and after `destroy`. */
  public remove(chart: LinkChart): void {
    const i = this._members.findIndex((m) => m.chart === chart);
    if (i < 0) return;
    this._release(this._members[i]);
    this._members.splice(i, 1);
  }

  /**
   * The host reporting an instrument change on one member: the imperative twin
   * of emitting `'symbol'` on that chart's event bus. Records it and, when
   * symbol sync is on, loads it into every other member that can follow.
   */
  public setSymbol(chart: LinkChart, symbol: string): void {
    const entry = this._find(chart);
    if (entry === null) return;
    this._applySymbol(entry, symbol);
  }

  /** Report a host-owned interval selection; followers opt in through `onInterval`. */
  public setInterval(chart: LinkChart, interval: string): void {
    const entry = this._find(chart);
    if (entry !== null && validInterval(interval)) this._applyInterval(entry, interval);
  }

  /** Report an appearance edit. `style:change` does this automatically for settings patches. */
  public syncAppearance(chart: LinkChart): void {
    if (this._destroyed || this._broadcasting || !this._options.appearance || !alive(chart)) return;
    const from = this._find(chart);
    if (from?.appearance === null || from === null) return;
    const values = filterLinkAppearance(from.appearance.read());
    if (Object.keys(values).length === 0) return;
    this._broadcast(from, target => target.appearance?.apply({ ...values }));
  }

  /** Unlink everything: no listeners, no linked crosshairs, no references. */
  public destroy(): void {
    this._destroyed = true;
    for (const m of this._members) this._release(m);
    this._members.length = 0;
    this._symbol = null;
    this._interval = null;
  }

  // ── channels ──────────────────────────────────────────────────────────────

  private _onCrosshair(from: Member, payload: unknown): void {
    if (!this._options.crosshair) return;
    const time = (payload as { time?: number | null } | null)?.time ?? null;
    this._broadcast(from, (target) => {
      const index = time === null
        ? null
        : followerIndex(target.chart.dataLayer, time, this._options.whenMissing);
      this._setCrosshair(target, index);
    }, (leader) => {
      // The leader is drawing its own, real crosshair, and a linked one on top of
      // it would double the line under the user's cursor.
      this._setCrosshair(leader, null);
    });
  }

  private _onViewport(from: Member): void {
    if (!this._options.viewport) return;
    if (!alive(from.chart)) { this._prune(); return; }
    const range = from.chart.getVisibleLogicalRange();
    const leaderData = from.chart.dataLayer;
    this._broadcast(from, (target) => {
      const mapped = followerRange(leaderData, target.chart.dataLayer, range);
      if (mapped !== null) target.chart.setVisibleLogicalRange(mapped);
    });
  }

  private _onSymbolEvent(from: Member, payload: unknown): void {
    const symbol = typeof payload === 'string'
      ? payload
      : (payload as { symbol?: unknown } | null)?.symbol;
    if (typeof symbol !== 'string' || symbol.length === 0) return;
    this._applySymbol(from, symbol);
  }

  private _applySymbol(from: Member, symbol: string): void {
    // Recorded even with the switch off, so turning it on later has something
    // to converge on rather than silently agreeing on a stale instrument.
    from.symbol = symbol;
    this._symbol = symbol;
    if (!this._options.symbol) return;
    this._broadcast(from, (target) => {
      if (target.symbol === symbol) return;
      target.symbol = symbol;
      target.onSymbol?.(symbol, target.chart);
    });
  }

  /** Push the group's agreed symbol onto everyone who is not already on it. */
  private _convergeSymbol(): void {
    const symbol = this._symbol;
    if (symbol === null || !this._options.symbol) return;
    this._broadcast(null, (target) => {
      if (target.symbol === symbol) return;
      target.symbol = symbol;
      target.onSymbol?.(symbol, target.chart);
    });
  }

  private _applyInterval(from: Member, interval: string): void {
    // A follower can echo a normalized token while applying the request. Such
    // an echo must not replace the leader's selection before the guard runs.
    if (this._broadcasting || this._destroyed || !alive(from.chart)) return;
    from.interval = interval;
    this._interval = interval;
    if (this._options.interval) this._broadcast(from, target => this._followInterval(target, interval));
  }

  private _followInterval(target: Member, interval: string): void {
    if (target.interval === interval || target.onInterval === null) return;
    if (target.onInterval(interval, target.chart) !== false) target.interval = interval;
  }

  private _convergeInterval(): void {
    const interval = this._interval;
    if (interval !== null && this._options.interval) {
      this._broadcast(null, target => this._followInterval(target, interval));
    }
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  /**
   * Run `apply` on every member except the originator, exactly once, with the
   * echo guard held. `onLeader` (optional) runs on the originator itself.
   *
   * Re-entrant calls return without doing anything, which is what breaks the
   * A -> B -> A loop: the inner call is always an echo of the outer one.
   */
  private _broadcast(
    from: Member | null,
    apply: (target: Member) => void,
    onLeader?: (leader: Member) => void,
  ): void {
    if (this._broadcasting) return;
    this._broadcasting = true;
    try {
      this._prune();
      if (from !== null && this._members.includes(from)) onLeader?.(from);
      // Snapshot: a host callback is free to add or remove members, and the
      // list must not shift underneath the loop.
      for (const target of [...this._members]) {
        if (target === from) continue;
        if (!this._members.includes(target)) continue;
        if (!alive(target.chart)) continue; // pruned on the next pass
        apply(target);
      }
    } finally {
      this._broadcasting = false;
    }
  }

  /** Drop destroyed members, releasing the group's reference to them. */
  private _prune(): void {
    for (let i = this._members.length - 1; i >= 0; i--) {
      if (alive(this._members[i].chart)) continue;
      // No `_release`: its chart is gone, so unsubscribing and detaching
      // primitives would only touch a corpse (and `addPrimitive` on one would
      // resurrect a pane). Dropping the entry is the whole job.
      this._members.splice(i, 1);
    }
  }

  private _find(chart: LinkChart): Member | null {
    return this._members.find((m) => m.chart === chart) ?? null;
  }

  private _release(member: Member): void {
    for (const off of member.unsubscribe) off();
    member.unsubscribe.length = 0;
    this._detachCrosshairs(member);
  }

  /**
   * Point this member's linked crosshair at one of its own bars (or clear it),
   * keeping one primitive per pane so the line spans price, volume and
   * indicator panes the way the native global crosshair does.
   */
  private _setCrosshair(member: Member, index: number | null): void {
    if (!alive(member.chart)) return;
    const wanted = index === null ? member.crosshairs.length : member.chart.panes().length;
    while (member.crosshairs.length > wanted) {
      const extra = member.crosshairs.pop();
      if (extra !== undefined) member.chart.removePrimitive(extra);
    }
    while (member.crosshairs.length < wanted) {
      const line = new LinkCrosshair();
      // Panes are indexed 0..n-1 and `wanted` never exceeds the pane count, so
      // this cannot create one.
      member.chart.addPrimitive(line, member.crosshairs.length);
      member.crosshairs.push(line);
    }
    for (const line of member.crosshairs) line.setIndex(index);
    member.chart.setLinkedCrosshairIndex?.(index);
  }

  private _detachCrosshairs(member: Member): void {
    if (alive(member.chart)) {
      for (const line of member.crosshairs) member.chart.removePrimitive(line);
      member.chart.setLinkedCrosshairIndex?.(null);
    }
    member.crosshairs.length = 0;
  }
}

/** Create a link group. `group.add(chart)` puts a chart in it. */
export function createLinkGroup(options: LinkOptions = {}): LinkGroup {
  return new LinkGroup(options);
}
