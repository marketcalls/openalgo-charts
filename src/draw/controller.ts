/**
 * Drawing controller: the interaction and persistence layer over
 * `DrawingLayer`. It is **headless**: no DOM, no toolbar. A host sets the
 * active tool (from its own button, a shortcut, a command palette) and the
 * controller runs placement, selection, dragging, undo, and serialisation.
 *
 * It listens on the chart's event bus (`click`, `crosshair:move`, `drag`,
 * `drag:end`) rather than the single-slot `subscribeClick`/`subscribeDrag`
 * callbacks, so a host keeps using those for its own order lines.
 *
 * Selection is a list. Every method that edits takes the whole list into one
 * undo entry, so a multi-drag, a batch delete or a paste of ten shapes is one
 * Ctrl+Z, which is what the hand that did it expects.
 */
// Shared types come from the package entry, not a relative path: each tier
// bundles its own .d.ts, so a relative import gets *inlined* as a second
// declaration. Classes with private members are nominal, so that second copy
// is a different type, and a consumer passing the real one got "separate
// declarations of a private property". The entry is external to tier builds,
// so this survives as `from 'openalgo-charts'` and stays one identity.
import type { IPrimitive, DataLayer } from 'openalgo-charts';
import type {
  Drawing, DrawingInput, DrawingPatch, DrawingPoint, DrawingStyle, DrawingTool, DrawingsDocument,
} from './types';
import { DRAWING_STATE_VERSION } from './types';
import { DrawingLayer } from './layer';
import { getDrawingTool, hasDrawingTool } from './tools';
import { DrawingClipboard, cloneDrawing, type ClipboardPort } from './clipboard';
import { migrateDrawings } from './migrate';

/**
 * The slice of the chart this controller needs.
 *
 * Declared structurally rather than as `Chart` on purpose. Each tier ships its
 * own bundled `.d.ts`, so naming the class here made the draw tier re-declare
 * `Chart`, and because `Chart` has private members, TypeScript treats the two
 * declarations as *different* types. A TS consumer passing the chart from
 * `createChart()` got "separate declarations of a private property", which made
 * the tier unusable from TypeScript at all. An interface with no private
 * members is structural, so the real `Chart` satisfies it with nothing to cast.
 */
export interface DrawingChartHost {
  on(event: string, handler: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
  addPrimitive(primitive: IPrimitive, paneIndex?: number): void;
  removePrimitive(primitive: IPrimitive): void;
  readonly dataLayer: DataLayer;
  getVisibleLogicalRange(): { from: number; to: number } | null;
  drawingState(): unknown;
  setDrawingState(state: unknown): void;
  setPlacementMode?(active: boolean): void;
  /**
   * Optional, and used only to move a drawing by a fixed screen distance (a
   * paste offset, an arrow-key nudge, a multi-drag across panes). Going
   * through pixels rather than adding a price delta keeps the offset the same
   * visible nudge on a log scale as on a linear one, and the same on an RSI
   * pane as on the price pane. A host without them still gets the time half.
   */
  priceToCoordinate?(price: number, paneIndex?: number): number | null;
  coordinateToPrice?(y: number, paneIndex?: number): number | null;
  /**
   * Optional, the time-axis half of the same conversion. Without them a
   * horizontal nudge assumes the time scale's default bar spacing.
   */
  timeToCoordinate?(time: number): number;
  coordinateToTime?(x: number): number;
  /**
   * Optional, and used only to keep a paste from a chart with more panes than
   * this one landing on a pane the user cannot see. Adding a primitive creates
   * the pane it names, so without this a drawing copied out of an indicator
   * pane would conjure an empty pane in a single-pane chart.
   */
  panes?(): readonly unknown[];
}

export interface DrawingControllerOptions {
  /**
   * Snap new anchors to the nearest O/H/L/C of the bar under the cursor.
   * Default false.
   */
  magnet?: boolean;
  /** Style merged under every tool's own defaults. */
  defaultStyle?: DrawingStyle;
  /** Stay in the active tool after finishing a drawing. Default false. */
  stayInDrawingMode?: boolean;
  /** Undo depth. Default 50. */
  historyLimit?: number;
  /**
   * Where copy and paste move text. Defaults to `navigator.clipboard`; pass a
   * port to route through a host's own transfer, or `null` to stay in the
   * process-local clipboard entirely.
   */
  clipboard?: ClipboardPort | null;
  /**
   * Whether a refused or failing clipboard write still lands in the in-process
   * clipboard. Defaults to true, which is what makes copy and paste work between
   * two charts on a page where the browser has denied clipboard permission.
   *
   * Pass false for a host that would rather a failed copy be a failed copy: with
   * it off, `cut` leaves the drawing alone when the write does not land, so a
   * shape is never destroyed for a transfer that did not happen.
   */
  clipboardFallbackToMemory?: boolean;
  /**
   * How far a pasted or duplicated copy lands from its original, in bars along
   * time and in screen pixels down the price axis. A copy that lands exactly on
   * top of the original reads as nothing having happened. Defaults: 2 bars,
   * 16 px.
   */
  pasteOffsetBars?: number;
  pasteOffsetPixels?: number;
}

/** What `drawing:change` reports happened to the listed ids. */
export type DrawingChangeKind = 'add' | 'update' | 'remove' | 'reorder';

interface ClickPayload {
  id: string | null;
  time: number;
  price: number | null;
  paneIndex: number;
  point: { x: number; y: number };
  /** Set on the release half of a press-drag-release gesture. */
  viaDrag?: boolean;
  /** Modifier state at the click; any of them makes a selection additive. */
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

interface DragPayload {
  id: string;
  price: number;
  time: number;
  paneIndex: number;
  /** Where the gesture was grabbed; deltas measure from here, not frame one. */
  fromPrice?: number;
  fromTime?: number;
}

/** The two layers of one pane: under the series and over it. */
interface PaneLayers {
  bottom: DrawingLayer;
  top: DrawingLayer;
}

/**
 * The time scale's default bar spacing, for a horizontal nudge on a host that
 * cannot map pixels to time. Wrong by the zoom factor there, never by an order
 * of magnitude.
 */
const FALLBACK_BAR_SPACING_PX = 8;

let nextId = 1;

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export class DrawingController {
  private readonly _chart: DrawingChartHost;
  private _opts: Required<Omit<DrawingControllerOptions, 'defaultStyle' | 'clipboard' | 'clipboardFallbackToMemory'>> & { defaultStyle: DrawingStyle };
  private readonly _clipboard: DrawingClipboard;
  private readonly _layers = new Map<number, PaneLayers>();
  private _drawings: Drawing[] = [];
  private _tool: string | null = null;
  private _pending: DrawingPoint[] = [];
  private _pendingPane = 0;
  /** Selected ids, in the order they were picked. The first is the primary. */
  private _selection: string[] = [];
  /** Snapshots for undo/redo; each is a full drawing list (they are small). */
  private _undo: string[] = [];
  private _redo: string[] = [];
  /**
   * One gesture's starting state. `items` are ids rather than objects because
   * an undo mid-drag replaces every drawing object, and a stale reference
   * would move a shape that is no longer in the model.
   */
  private _dragStart: {
    id: string;
    handle: number | null;
    from: DrawingPoint;
    items: { id: string; paneIndex: number; points: DrawingPoint[] }[];
  } | null = null;
  private readonly _off: (() => void)[] = [];
  private _lastCursor: { time: number; price: number; paneIndex: number } | null = null;
  /** Bar under the cursor, carried by the crosshair event; used by magnet. */
  private _lastBar: { open: number; high: number; low: number; close: number } | null = null;

  public constructor(chart: DrawingChartHost, options: DrawingControllerOptions = {}) {
    this._chart = chart;
    this._opts = {
      magnet: options.magnet ?? false,
      stayInDrawingMode: options.stayInDrawingMode ?? false,
      historyLimit: options.historyLimit ?? 50,
      pasteOffsetBars: options.pasteOffsetBars ?? 2,
      pasteOffsetPixels: options.pasteOffsetPixels ?? 16,
      defaultStyle: options.defaultStyle ?? {},
    };
    this._clipboard = new DrawingClipboard({
      ...(options.clipboard === undefined ? {} : { port: options.clipboard }),
      ...(options.clipboardFallbackToMemory === undefined
        ? {}
        : { fallbackToMemory: options.clipboardFallbackToMemory }),
    });
    this._off.push(chart.on('click', (p) => this._onClick(p as ClickPayload)));
    this._off.push(chart.on('crosshair:move', (p) => this._onCrosshair(p as Record<string, unknown>)));
    this._off.push(chart.on('drag', (p) => this._onDrag(p as DragPayload)));
    this._off.push(chart.on('drag:end', () => this._onDragEnd()));
    this._off.push(chart.on('dblclick', () => { this.finish(); }));
    // Restore anything a previous session left in the chart state. A 1.9.x
    // save is a bare array; the migration upgrades it in place.
    const saved = chart.drawingState();
    if (saved !== undefined && saved !== null) this._drawings = migrateDrawings(saved).drawings;
    this._sync();
  }

  // ── public API ──────────────────────────────────────────────────────────

  /** Arm a tool for placement, or pass null to return to the cursor. */
  public setTool(toolId: string | null): void {
    if (toolId !== null && !hasDrawingTool(toolId)) {
      throw new Error(`openalgo-charts: unknown drawing tool "${toolId}"`);
    }
    this._tool = toolId;
    this._pending = [];
    this._setPlacementMode(toolId !== null);
    this._syncPreview();
    this._chart.emit('draw:tool', { tool: toolId });
  }

  /**
   * Ask the chart to stop panning and report gestures as anchor placement.
   * Guarded so a base bundle predating `setPlacementMode` still loads the tier.
   */
  private _setPlacementMode(active: boolean): void {
    const chart = this._chart as unknown as { setPlacementMode?: (a: boolean) => void };
    chart.setPlacementMode?.(active);
  }

  public activeTool(): string | null {
    return this._tool;
  }

  public setOptions(patch: DrawingControllerOptions): void {
    // `clipboard` is a port, not a stored option: it is applied to the live
    // clipboard so a host can hand one over after the user grants permission.
    const { clipboard, ...rest } = patch;
    this._opts = { ...this._opts, ...rest, defaultStyle: patch.defaultStyle ?? this._opts.defaultStyle };
    if (clipboard !== undefined) this._clipboard.setPort(clipboard);
  }

  /** The clipboard behind copy / cut / paste, for a host reporting failures. */
  public clipboard(): DrawingClipboard {
    return this._clipboard;
  }

  /**
   * Every drawing, in list order. That is creation order until a z-order call
   * moves one; the list is the tie-break for equal `zIndex`, so it is also the
   * paint order within a band.
   */
  public drawings(): readonly Drawing[] {
    return this._drawings;
  }

  public get(id: string): Drawing | undefined {
    return this._drawings.find((d) => d.id === id);
  }

  /** Add a fully-specified drawing (import, or a host-authored one). */
  public add(drawing: DrawingInput): Drawing {
    this._pushUndo();
    const created = this._insert(drawing);
    this._sync();
    this._chart.emit('draw:add', { drawing: created });
    this._emitChange([created.id], 'add');
    return created;
  }

  /**
   * Append one drawing without touching history or the layers. Split out so a
   * paste of several drawings is a single undo step rather than one per shape.
   */
  private _insert(drawing: DrawingInput): Drawing {
    const tool = getDrawingTool(drawing.tool);
    let id = drawing.id ?? this._mintId();
    // A restored layout can hold an id the counter has not reached yet.
    while (drawing.id === undefined && this.get(id) !== undefined) id = this._mintId();
    const { id: _dropped, ...rest } = drawing;
    void _dropped;
    const created: Drawing = {
      ...rest,
      id,
      style: { ...this._opts.defaultStyle, ...tool.defaultStyle, ...drawing.style },
      zIndex: Number.isFinite(drawing.zIndex) ? (drawing.zIndex as number) : 0,
      createdAt: drawing.createdAt ?? Date.now(),
    };
    if (drawing.text !== undefined || tool.defaultText !== undefined) {
      created.text = { value: '', ...tool.defaultText, ...drawing.text };
    }
    this._drawings.push(created);
    return created;
  }

  private _mintId(): string {
    return `d${nextId++}`;
  }

  public update(id: string, patch: DrawingPatch): boolean {
    const d = this.get(id);
    if (d === undefined) return false;
    this._pushUndo();
    this._applyPatch(d, patch);
    this._sync();
    this._chart.emit('draw:update', { drawing: d });
    this._emitChange([id], 'update');
    return true;
  }

  /**
   * Patch several drawings as one undo entry: a colour change across a
   * multi-selection is one edit to the user, so it is one Ctrl+Z too. Ids that
   * no longer exist are skipped; nothing is recorded when none exist.
   */
  public updateMany(patches: ReadonlyArray<{ id: string; patch: DrawingPatch }>): void {
    const live = patches
      .map((p) => ({ d: this.get(p.id), patch: p.patch }))
      .filter((p): p is { d: Drawing; patch: DrawingPatch } => p.d !== undefined);
    if (live.length === 0) return;
    this._pushUndo();
    for (const { d, patch } of live) this._applyPatch(d, patch);
    this._sync();
    for (const { d } of live) this._chart.emit('draw:update', { drawing: d });
    this._emitChange(live.map((p) => p.d.id), 'update');
  }

  private _applyPatch(d: Drawing, patch: DrawingPatch): void {
    if (patch.points !== undefined) d.points = patch.points.map((p) => ({ ...p }));
    if (patch.style !== undefined) d.style = { ...d.style, ...patch.style };
    if (patch.text !== undefined) d.text = { ...d.text, ...patch.text };
    if (patch.props !== undefined) d.props = { ...d.props, ...patch.props };
    if (patch.locked !== undefined) d.locked = patch.locked;
    if (patch.visible !== undefined) d.visible = patch.visible;
    if (patch.zIndex !== undefined && Number.isFinite(patch.zIndex)) d.zIndex = patch.zIndex;
  }

  public remove(id: string): boolean {
    return this._removeIds([id], true).length > 0;
  }

  /** Delete several drawings as one undo entry. Unknown ids are ignored. */
  public removeMany(ids: readonly string[]): void {
    this._removeIds(ids, true);
  }

  /**
   * The delete shared by `remove`, `removeMany`, `cut` and `clear`. Returns
   * what went, and records nothing when nothing did.
   */
  private _removeIds(ids: readonly string[], pushUndo: boolean): Drawing[] {
    const set = new Set(ids);
    const removed = this._drawings.filter((d) => set.has(d.id));
    if (removed.length === 0) return [];
    if (pushUndo) this._pushUndo();
    this._drawings = this._drawings.filter((d) => !set.has(d.id));
    this._selection = this._selection.filter((id) => !set.has(id));
    this._sync();
    for (const d of removed) this._chart.emit('draw:remove', { drawing: d });
    this._emitChange(removed.map((d) => d.id), 'remove');
    return removed;
  }

  public clear(): void {
    if (this._drawings.length === 0) return;
    this._removeIds(this._drawings.map((d) => d.id), true);
    this._setSelection([]);
  }

  // ── selection ───────────────────────────────────────────────────────────

  /**
   * Replace the selection, or with `additive` toggle each id into it (the
   * shift-click gesture). Ids that name nothing are ignored, so the selection
   * never refers to a drawing that is not there. Pass null to clear.
   */
  public select(id: string | readonly string[] | null, additive = false): void {
    const wanted = id === null ? [] : typeof id === 'string' ? [id] : id;
    const known: string[] = [];
    for (const x of wanted) {
      if (this.get(x) !== undefined && !known.includes(x)) known.push(x);
    }
    if (!additive) {
      this._setSelection(known);
      return;
    }
    const next = this._selection.slice();
    for (const x of known) {
      const i = next.indexOf(x);
      if (i >= 0) next.splice(i, 1);
      else next.push(x);
    }
    this._setSelection(next);
  }

  /** The primary selection: the first id picked, or null. */
  public selected(): string | null {
    return this._selection.length === 0 ? null : this._selection[0];
  }

  /** Every selected id, in the order they were picked. */
  public selection(): readonly string[] {
    return this._selection;
  }

  private _setSelection(next: string[]): void {
    const changed = !sameIds(next, this._selection);
    this._selection = next;
    for (const l of this._layers.values()) {
      l.bottom.setSelected(next);
      l.top.setSelected(next);
    }
    if (!changed) return;
    this._chart.emit('draw:select', { id: this.selected() });
    this._chart.emit('drawing:select', { ids: next.slice() });
  }

  private _emitChange(ids: readonly string[], kind: DrawingChangeKind): void {
    this._chart.emit('drawing:change', { ids: ids.slice(), kind });
  }

  // ── z-order ─────────────────────────────────────────────────────────────
  //
  // `zIndex` is the primary key and list position the tie-break, so "front"
  // and "back" are settled by moving both: the extreme `zIndex` of the pane
  // plus the end of the list. Whether a drawing sits under the series is a
  // separate choice made by the sign alone, and the two series calls change
  // nothing else, so they never reorder a stack the user has arranged.

  public setZIndex(id: string, z: number): void {
    const d = this.get(id);
    if (d === undefined || !Number.isFinite(z) || d.zIndex === z) return;
    this._pushUndo();
    d.zIndex = z;
    this._sync();
    this._chart.emit('draw:update', { drawing: d });
    this._emitChange([id], 'reorder');
  }

  /** In front of every other drawing on its pane. Stays on its side of the series. */
  public bringToFront(id: string): void {
    const d = this.get(id);
    if (d === undefined) return;
    const band = this._band(d);
    const z = band.length === 0 ? d.zIndex : Math.max(...band.map((o) => o.zIndex));
    this._reorder(d, z, 'end');
  }

  /** Behind every other drawing on its pane. Stays on its side of the series. */
  public sendToBack(id: string): void {
    const d = this.get(id);
    if (d === undefined) return;
    const band = this._band(d);
    const z = band.length === 0 ? d.zIndex : Math.min(...band.map((o) => o.zIndex));
    this._reorder(d, z, 'start');
  }

  /** Under the series (`zIndex` -1). A no-op for a drawing already there. */
  public sendBehindSeries(id: string): void {
    const d = this.get(id);
    if (d !== undefined && d.zIndex >= 0) this.setZIndex(id, -1);
  }

  /** Over the series (`zIndex` 0). A no-op for a drawing already there. */
  public bringAboveSeries(id: string): void {
    const d = this.get(id);
    if (d !== undefined && d.zIndex < 0) this.setZIndex(id, 0);
  }

  /** The other drawings sharing `d`'s pane and side of the series. */
  private _band(d: Drawing): Drawing[] {
    const below = d.zIndex < 0;
    return this._drawings.filter((o) => o !== d && o.paneIndex === d.paneIndex && (o.zIndex < 0) === below);
  }

  private _reorder(d: Drawing, z: number, where: 'start' | 'end'): void {
    const i = this._drawings.indexOf(d);
    const target = where === 'end' ? this._drawings.length - 1 : 0;
    if (i === target && d.zIndex === z) return;
    this._pushUndo();
    d.zIndex = z;
    this._drawings.splice(i, 1);
    if (where === 'end') this._drawings.push(d);
    else this._drawings.unshift(d);
    this._sync();
    this._chart.emit('draw:update', { drawing: d });
    this._emitChange([d.id], 'reorder');
  }

  // ── moving ──────────────────────────────────────────────────────────────

  /**
   * Move drawings by a screen distance, `dx` right and `dy` down in media px,
   * as one undo entry. Pixels rather than data units so an arrow key moves a
   * shape the same visible amount on every pane and scale. Locked drawings
   * stay put.
   */
  public nudge(ids: readonly string[], dxPx: number, dyPx: number): void {
    if (dxPx === 0 && dyPx === 0) return;
    const list = this._targets(ids).filter((d) => d.locked !== true);
    if (list.length === 0) return;
    this._pushUndo();
    for (const d of list) {
      d.points = d.points.map((p) => ({
        time: this._offsetTime(p.time, dxPx),
        price: this._offsetPrice(p.price, d.paneIndex, dyPx),
      }));
    }
    this._sync();
    for (const d of list) this._chart.emit('draw:update', { drawing: d });
    this._emitChange(list.map((d) => d.id), 'update');
  }

  /**
   * Clone drawings, offset like a paste so the copies are visibly new, and
   * select the clones. One undo entry. Ids that name nothing are ignored.
   */
  public duplicate(ids: readonly string[]): Drawing[] {
    const sources = this._targets(ids);
    if (sources.length === 0) return [];
    this._pushUndo();
    const clones = sources.map((d) => {
      const { id: _id, createdAt: _createdAt, ...rest } = cloneDrawing(d);
      void _id; void _createdAt;
      return this._insert({ ...rest, points: this._offsetPoints(d.points, d.paneIndex) });
    });
    this._sync();
    for (const c of clones) this._chart.emit('draw:add', { drawing: c });
    this._emitChange(clones.map((c) => c.id), 'add');
    this.select(clones.map((c) => c.id));
    return clones;
  }

  // ── clipboard ───────────────────────────────────────────────────────────
  //
  // Async because the OS clipboard is: `navigator.clipboard` returns promises
  // and can reject on a permission the user has not granted. The host owns the
  // key bindings (the engine installs no listeners), so these are plain calls.

  /**
   * Put drawings on the clipboard. Defaults to the selection; pass an id or a
   * list of ids to copy something else. Resolves false when there was nothing
   * to copy, or when the payload could not be stored anywhere.
   */
  public async copy(target?: string | readonly string[] | null): Promise<boolean> {
    const list = this._targets(target);
    if (list.length === 0) return false;
    const ok = await this._clipboard.write(list);
    if (ok) this._chart.emit('draw:copy', { drawings: list.map(cloneDrawing) });
    return ok;
  }

  /**
   * Copy, then delete. The delete happens **only** after the clipboard write
   * resolves successfully, so a refused write leaves the model exactly as it
   * was rather than destroying a drawing that went nowhere.
   */
  public async cut(target?: string | readonly string[] | null): Promise<boolean> {
    const list = this._targets(target);
    if (list.length === 0) return false;
    const ok = await this._clipboard.write(list);
    if (!ok) return false;
    // One undo step for the whole cut, and the drawings are re-read here
    // because the await above gave other code a chance to change the model.
    const removed = this._removeIds(list.map((d) => d.id), true);
    if (removed.length === 0) return false;
    this._chart.emit('draw:cut', { drawings: removed });
    return true;
  }

  /**
   * Paste whatever is on the clipboard into this chart, offset from the
   * original so the copy is visibly a second object, and select the result.
   * Each pasted drawing is a fresh object with a fresh id, never a second
   * reference to the one copied, so editing the paste cannot alter its source
   * (or the clipboard).
   *
   * Anything that is not our payload (foreign text, a truncated or hand-edited
   * copy, a newer format) pastes nothing and resolves to an empty array: a
   * paste shortcut must not throw at the host because the user last copied a
   * spreadsheet cell.
   */
  public async paste(): Promise<Drawing[]> {
    const entries = await this._clipboard.read();
    if (entries === null || entries.length === 0) return [];
    // Everything is prepared before the model is touched: a tool that has since
    // been unregistered would throw inside `_insert` and leave a half-applied
    // paste plus an undo entry describing a state that never existed.
    for (const e of entries) {
      if (!hasDrawingTool(e.tool)) return [];
    }
    const prepared = entries.map((e) => {
      const paneIndex = this._clampPane(e.paneIndex);
      return { ...e, paneIndex, points: this._offsetPoints(e.points, paneIndex) };
    });
    this._pushUndo();
    const created = prepared.map((p) => this._insert(p));
    this._sync();
    for (const d of created) this._chart.emit('draw:add', { drawing: d });
    this._emitChange(created.map((d) => d.id), 'add');
    this._chart.emit('draw:paste', { drawings: created });
    this.select(created.map((d) => d.id));
    return created;
  }

  /** Resolve an id list to live drawings; defaults to the selection. */
  private _targets(target?: string | readonly string[] | null): Drawing[] {
    const ids = target === undefined || target === null ? this._selection
      : typeof target === 'string' ? [target] : target;
    const out: Drawing[] = [];
    for (const id of ids) {
      const d = this.get(id);
      if (d !== undefined && !out.includes(d)) out.push(d);
    }
    return out;
  }

  /** Fold a pane index from another chart onto a pane this one actually has. */
  private _clampPane(paneIndex: number): number {
    const panes = this._chart.panes;
    if (panes === undefined) return paneIndex;
    const n = panes.call(this._chart).length;
    return n === 0 ? 0 : Math.min(paneIndex, n - 1);
  }

  /** Nudge every anchor so a pasted copy is not hidden under its original. */
  private _offsetPoints(points: readonly DrawingPoint[], paneIndex: number): DrawingPoint[] {
    const dt = this._barSeconds() * this._opts.pasteOffsetBars;
    const px = this._opts.pasteOffsetPixels;
    return points.map((p) => ({ time: p.time + dt, price: this._offsetPrice(p.price, paneIndex, px) }));
  }

  /**
   * Move a price down the screen by `px`. Done per anchor rather than as one
   * price delta so the move is a rigid *screen* translation, which is what the
   * eye expects and what keeps a shape's proportions on a log scale.
   */
  private _offsetPrice(price: number, paneIndex: number, px: number): number {
    if (px === 0) return price;
    const toY = this._chart.priceToCoordinate;
    const toPrice = this._chart.coordinateToPrice;
    if (toY === undefined || toPrice === undefined) return price;   // time offset only
    const y = toY.call(this._chart, price, paneIndex);
    if (y === null || !Number.isFinite(y)) return price;
    const moved = toPrice.call(this._chart, y + px, paneIndex);
    if (moved === null || !Number.isFinite(moved)) return price;
    return moved;
  }

  /** Move a time right along the screen by `px`. */
  private _offsetTime(time: number, px: number): number {
    if (px === 0) return time;
    const toX = this._chart.timeToCoordinate;
    const toTime = this._chart.coordinateToTime;
    if (toX !== undefined && toTime !== undefined) {
      const x = toX.call(this._chart, time);
      if (Number.isFinite(x)) {
        const moved = toTime.call(this._chart, x + px);
        if (Number.isFinite(moved)) return moved;
      }
    }
    return time + (px / FALLBACK_BAR_SPACING_PX) * this._barSeconds();
  }

  // ── history and persistence ─────────────────────────────────────────────

  public undo(): boolean {
    const snap = this._undo.pop();
    if (snap === undefined) return false;
    this._redo.push(JSON.stringify(this._drawings));
    this._drawings = JSON.parse(snap) as Drawing[];
    this._pruneSelection();
    this._sync();
    return true;
  }

  public redo(): boolean {
    const snap = this._redo.pop();
    if (snap === undefined) return false;
    this._undo.push(JSON.stringify(this._drawings));
    this._drawings = JSON.parse(snap) as Drawing[];
    this._pruneSelection();
    this._sync();
    return true;
  }

  /** Drop selected ids the model no longer holds, after a history jump. */
  private _pruneSelection(): void {
    const next = this._selection.filter((id) => this.get(id) !== undefined);
    if (!sameIds(next, this._selection)) this._setSelection(next);
  }

  public canUndo(): boolean { return this._undo.length > 0; }
  public canRedo(): boolean { return this._redo.length > 0; }

  /** Serialisable document, the same shape `ChartState.drawings` carries. */
  public toJSON(): DrawingsDocument {
    return { version: DRAWING_STATE_VERSION, drawings: this._drawings.map(cloneDrawing) };
  }

  /**
   * Replace every drawing. Accepts a {@link DrawingsDocument} or a 1.9.x bare
   * `Drawing[]`; both go through the migration, so an old save upgrades on
   * load. Clears the selection and history.
   */
  public fromJSON(data: unknown): void {
    this._drawings = migrateDrawings(data).drawings;
    this._undo = [];
    this._redo = [];
    this._setSelection([]);
    this._sync();
  }

  public destroy(): void {
    this._setPlacementMode(false);   // never leave the chart unable to pan
    for (const off of this._off) off();
    this._off.length = 0;
    for (const l of this._layers.values()) {
      l.top.setBelow(null);
      this._chart.removePrimitive(l.top);
      this._chart.removePrimitive(l.bottom);
    }
    this._layers.clear();
  }

  // ── interaction ─────────────────────────────────────────────────────────

  private _onCrosshair(p: Record<string, unknown>): void {
    const time = p.time as number | null;
    const price = p.price as number | null;
    const paneIndex = (p.paneIndex as number | null) ?? null;
    this._lastCursor = time === null || price === null || paneIndex === null
      ? null : { time, price, paneIndex };
    this._lastBar = (p.bar as { open: number; high: number; low: number; close: number } | null) ?? null;
    // Freehand tools ink while the pointer is held rather than on clicks.
    if (this._tool !== null && p.pressed === true && this._isFreehand()
      && time !== null && price !== null && paneIndex !== null
      && Number.isFinite(time) && Number.isFinite(price)) {
      this._inkPoint({ time, price }, paneIndex);
      return;
    }
    // A tool mid-placement previews against the live cursor.
    if (this._tool !== null && this._pending.length > 0) this._syncPreview();
  }

  /**
   * Let a tool turn the clicked anchors into its full set (the position tools
   * build a 1:1 box off one click). Identity for tools without the hook.
   */
  private _expand(tool: DrawingTool, clicked: DrawingPoint[]): DrawingPoint[] {
    if (tool.expand === undefined) return clicked;
    const range = this._chart.getVisibleLogicalRange();
    const visibleBars = range === null ? 60 : Math.max(1, range.to - range.from);
    return tool.expand(clicked, { barSeconds: this._barSeconds(), visibleBars });
  }

  /**
   * Bar spacing in seconds, read from the last gap in the data. A one-bar chart
   * has no gap to read, so fall back to a minute rather than answering zero and
   * producing zero-width defaults and invisible paste offsets.
   */
  private _barSeconds(): number {
    const dl = this._chart.dataLayer;
    const n = dl.baseIndex;
    const a = n > 0 ? dl.indexToTime(n - 1) : undefined;
    const b = n >= 0 ? dl.indexToTime(n) : undefined;
    return a !== undefined && b !== undefined && b > a ? b - a : 60;
  }

  private _isFreehand(): boolean {
    return this._tool !== null && getDrawingTool(this._tool).freehand === true;
  }

  /**
   * Append one sample to the stroke in progress. Points arriving closer than a
   * bar-eighth apart in time carry no shape and would bloat the saved drawing,
   * so they collapse into the last one: a pointer can fire far faster than the
   * stroke actually changes direction.
   */
  private _inkPoint(point: DrawingPoint, paneIndex: number): void {
    if (this._pending.length === 0) {
      this._pendingPane = paneIndex;
    } else if (paneIndex !== this._pendingPane) {
      return;                       // a stroke belongs to the pane it started in
    } else {
      const last = this._pending[this._pending.length - 1];
      if (last.time === point.time && last.price === point.price) return;
    }
    this._pending.push(point);
    this._syncPreview();
  }

  /** Commit `pts` as a drawing of the armed tool and leave placement. */
  private _commit(pts: DrawingPoint[]): void {
    const tool = getDrawingTool(this._tool as string);
    const created = this.add({ tool: tool.id, points: pts, style: {}, paneIndex: this._pendingPane });
    this._pending = [];
    if (!this._opts.stayInDrawingMode) {
      this._tool = null;
      this._setPlacementMode(false);   // hand panning back to the chart
    }
    this._syncPreview();
    this.select(created.id);
    this._chart.emit('draw:tool', { tool: this._tool });
  }

  /** Commit the stroke a freehand gesture built, if it has any extent. */
  private _finishFreehand(): void {
    const pts = this._pending;
    this._pending = [];
    if (pts.length < 2) {           // a tap is not a stroke
      this._syncPreview();
      return;
    }
    this._commit(pts);
  }

  /**
   * End a variable-anchor shape (polyline, path) at the anchors placed so far.
   * Those tools declare `points: 0`, so nothing else can ever complete them;
   * without this they collected vertices forever. Bound to double-click, and
   * public so a host can offer Esc / Enter too. No-op when there is nothing
   * placeable, so a stray double-click costs nothing.
   */
  public finish(): boolean {
    if (this._tool === null || this._pending.length === 0) return false;
    const tool = getDrawingTool(this._tool);
    if (tool.points !== 0 || tool.freehand === true) return false;
    const pts = this._pending;
    if (pts.length < 2) {           // a single vertex is not a shape
      this._pending = [];
      this._syncPreview();
      return false;
    }
    this._commit(pts);
    return true;
  }

  private _onClick(p: ClickPayload): void {
    // Placement takes precedence: while a tool is armed, a click is an anchor.
    if (this._tool !== null) {
      // A freehand stroke was already collected move-by-move; the click pair a
      // drag produces is its end signal, not two more anchors.
      if (this._isFreehand()) {
        if (p.viaDrag === true) this._finishFreehand();
        return;
      }
      // The release half of a drag only means something while a shape is part
      // way through. A single-anchor tool (text, horizontal line) is already
      // finished by the press, so treating the release as another anchor would
      // drop a second drawing wherever the user let go.
      if (p.viaDrag === true && this._pending.length === 0) return;
      // Reject an unmappable click outright: a NaN anchor serialises as null
      // and produces a drawing that can never be rendered or hit-tested.
      if (p.price === null || !Number.isFinite(p.price) || !Number.isFinite(p.time)) return;
      this._placePoint({ time: p.time, price: this._snap(p.price, p.paneIndex) }, p.paneIndex);
      return;
    }
    const additive = p.shiftKey === true || p.ctrlKey === true || p.metaKey === true;
    if (p.id !== null && p.id.startsWith('draw:')) {
      this.select(p.id.slice('draw:'.length).split('#')[0], additive);
      return;
    }
    // A click on empty space clears, unless it is the additive gesture, which
    // on nothing means nothing.
    if (p.id === null && !additive) this.select(null);
  }

  private _placePoint(point: DrawingPoint, paneIndex: number): void {
    if (this._pending.length === 0) this._pendingPane = paneIndex;
    this._pending.push(point);
    const tool = getDrawingTool(this._tool as string);
    if (tool.points > 0 && this._pending.length >= tool.points) {
      this._commit(this._expand(tool, this._pending));
    } else {
      this._syncPreview();
    }
  }

  /** Snap to the nearest O/H/L/C of the hovered bar when magnet is on. */
  private _snap(price: number, paneIndex: number): number {
    if (!this._opts.magnet || paneIndex !== 0) return price;
    const bar = this._lastBar;
    if (bar === null) return price;
    let best = price;
    let bestD = Infinity;
    for (const v of [bar.open, bar.high, bar.low, bar.close]) {
      const d = Math.abs(v - price);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  private _onDrag(p: DragPayload): void {
    if (!p.id.startsWith('draw:')) return;
    const [rawId, handleStr] = p.id.slice('draw:'.length).split('#');
    const d = this.get(rawId);
    if (d === undefined || d.locked === true) return;
    const handle = handleStr === undefined ? null : Number(handleStr);

    if (this._dragStart === null || this._dragStart.id !== rawId || this._dragStart.handle !== handle) {
      // Grabbing the body of an unselected shape selects it first, on its own:
      // the selection is what moves, and a drag that moved something other than
      // what it grabbed would be a surprise.
      if (handle === null && !this._selection.includes(rawId)) this.select(rawId);
      const moving = handle === null
        ? this._targets(this._selection).filter((m) => m.locked !== true)
        : [d];
      // Snapshot once per gesture so undo restores the pre-drag position, not
      // an intermediate frame.
      this._pushUndo();
      this._dragStart = {
        id: rawId, handle,
        from: { time: p.fromTime ?? p.time, price: p.fromPrice ?? p.price },
        items: moving.map((m) => ({ id: m.id, paneIndex: m.paneIndex, points: m.points.map((q) => ({ ...q })) })),
      };
    }
    const start = this._dragStart;
    if (handle === null) {
      // Whole shape: translate every anchor of every selected shape by the
      // cursor delta. A shape on another pane cannot take the price delta (its
      // scale is a different quantity), so it takes the same screen distance.
      const dt = p.time - start.from.time;
      const dp = p.price - start.from.price;
      const dy = this._pixelDelta(start.from.price, p.price, p.paneIndex);
      for (const item of start.items) {
        const m = this.get(item.id);
        if (m === undefined) continue;
        const samePane = item.paneIndex === p.paneIndex;
        m.points = item.points.map((q) => ({
          time: q.time + dt,
          price: samePane ? q.price + dp : this._offsetPrice(q.price, item.paneIndex, dy),
        }));
      }
    } else if (handle >= 0 && handle < d.points.length) {
      const item = start.items[0];
      d.points = item.points.map((q, i) => (i === handle ? { time: p.time, price: p.price } : { ...q }));
    }
    this._sync();
  }

  /** How far down the screen `to` is from `from` on one pane, in media px. */
  private _pixelDelta(from: number, to: number, paneIndex: number): number {
    const toY = this._chart.priceToCoordinate;
    if (toY === undefined) return 0;
    const y0 = toY.call(this._chart, from, paneIndex);
    const y1 = toY.call(this._chart, to, paneIndex);
    return y0 === null || y1 === null || !Number.isFinite(y0) || !Number.isFinite(y1) ? 0 : y1 - y0;
  }

  private _onDragEnd(): void {
    if (this._dragStart === null) return;
    const moved = this._dragStart.items.map((i) => this.get(i.id)).filter((m): m is Drawing => m !== undefined);
    this._dragStart = null;
    for (const m of moved) this._chart.emit('draw:update', { drawing: m });
    if (moved.length > 0) this._emitChange(moved.map((m) => m.id), 'update');
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  /**
   * The pair of layers for a pane, made on first use. The bottom one is added
   * first so a host that lists primitives sees them in paint order; the top one
   * adopts it so handles and hit-tests come from one place.
   */
  private _layerFor(paneIndex: number): PaneLayers {
    let pair = this._layers.get(paneIndex);
    if (pair === undefined) {
      pair = { bottom: new DrawingLayer('bottom'), top: new DrawingLayer('top') };
      this._chart.addPrimitive(pair.bottom, paneIndex);
      this._chart.addPrimitive(pair.top, paneIndex);
      pair.top.setBelow(pair.bottom);
      pair.bottom.setSelected(this._selection);
      pair.top.setSelected(this._selection);
      this._layers.set(paneIndex, pair);
    }
    return pair;
  }

  /** Push the current list into each pane's layers and into the chart state. */
  private _sync(): void {
    const byPane = new Map<number, { below: Drawing[]; above: Drawing[] }>();
    for (const d of this._drawings) {
      let lists = byPane.get(d.paneIndex);
      if (lists === undefined) {
        lists = { below: [], above: [] };
        byPane.set(d.paneIndex, lists);
      }
      (d.zIndex < 0 ? lists.below : lists.above).push(d);
    }
    for (const [pane, lists] of byPane) {
      const l = this._layerFor(pane);
      l.bottom.setDrawings(lists.below);
      l.top.setDrawings(lists.above);
    }
    // Panes that lost their last drawing must be cleared, not left stale.
    for (const [pane, l] of this._layers) {
      if (!byPane.has(pane)) {
        l.bottom.setDrawings([]);
        l.top.setDrawings([]);
      }
      l.bottom.setSelected(this._selection);
      l.top.setSelected(this._selection);
    }
    this._chart.setDrawingState(this.toJSON());
  }

  /** Mirror the in-progress anchors (plus the cursor) into the preview slot. */
  private _syncPreview(): void {
    for (const l of this._layers.values()) l.top.setPreview(null);
    if (this._tool === null || this._pending.length === 0) return;
    const cursor = this._lastCursor;
    const points = cursor === null
      ? this._pending
      : [...this._pending, { time: cursor.time, price: cursor.price }];
    this._layerFor(this._pendingPane).top.setPreview({
      id: '__preview', tool: this._tool, points, style: this._opts.defaultStyle,
      paneIndex: this._pendingPane, zIndex: 0,
    });
  }

  private _pushUndo(): void {
    this._undo.push(JSON.stringify(this._drawings));
    if (this._undo.length > this._opts.historyLimit) this._undo.shift();
    this._redo = []; // a new edit invalidates the redo branch
  }
}
