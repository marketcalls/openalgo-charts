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
import type { IPrimitive, DataLayer, AlertDrawingValue, AlertDrawingInfo, PlotRect } from 'openalgo-charts';
import type {
  Drawing, DrawingInput, DrawingPatch, DrawingPoint, DrawingStyle, DrawingTool, DrawingsDocument,
  MagnetMode, ScreenPoint, DrawingGroup, DrawingSpace, DrawingStackTarget, ViewportPoint,
} from './types';
import { DRAWING_STATE_VERSION } from './types';
import { DrawingLayer, placeViewportAnchors, sortByZIndex, type DrawingPointerKind } from './layer';
import { getDrawingTool, hasDrawingTool, viewportDrawingTool } from './tools';
import { readViewportPoints } from './viewport';
import { boundsOf } from './geometry';
import { DrawingClipboard, cloneDrawing, type ClipboardPort } from './clipboard';
import { migrateDrawings, migrateGroups } from './migrate';
import { rdpSimplify } from './freehand';
import { InputAnchors, type InputAnchorHost, type InputAnchorStep } from './input-anchors';

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
  readonly isDestroyed?: boolean;
  /**
   * The event bus. The controller listens for `click`, `crosshair:move`,
   * `drag`, `drag:end` and `dblclick`, and for `hover` (`{ id }`, the hit id
   * under the pointer whenever it changes), which is what drives the hover
   * state: the chart has already hit-tested the move, so the controller
   * reads its answer rather than testing a second time. A host that never
   * emits `hover` has drawings that select and drag but do not light up.
   */
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
   * Optional, the time-axis half of the same conversion. coordinateToTime also
   * keeps previews and freehand strokes active in empty space beyond the bars.
   * Without these methods a horizontal nudge assumes the default bar spacing.
   */
  timeToCoordinate?(time: number): number;
  coordinateToTime?(x: number): number;
  /**
   * Optional, for drawings anchored to the viewport (`space: 'viewport'`):
   * the time axis, which turns a data anchor's time into a place on the plot
   * and back when a drawing is pinned or unpinned.
   */
  readonly timeScale?: { indexToX(index: number): number; xToIndex(x: number): number };
  /**
   * Optional, for drawings anchored to the viewport: a pane's plot in
   * container px, as `Chart.plotRect` reports it, which is what a viewport
   * anchor is a fraction of. A host without it still paints them, since the
   * layer reads the plot size from its render context, but cannot place,
   * move or convert them.
   */
  plotRect?(paneIndex: number): PlotRect | null;
  /**
   * Optional. It keeps a paste from a chart with more panes than this one
   * landing on a pane the user cannot see: adding a primitive creates the pane
   * it names, so without this a drawing copied out of an indicator pane would
   * conjure an empty pane in a single-pane chart. An entry with `priceToY` and
   * `yToPrice`, as a chart pane has, also lets an alert read a drawing on a
   * pane the chart maps no price for, one collapsed to its header strip.
   */
  panes?(): readonly unknown[];
  /**
   * Optional. Slot of the price pane, the one pane whose drawings the magnet
   * snaps to candle prices and a drawing link shares. It moves when a host
   * puts the price pane below its studies; without it the price pane is slot 0.
   */
  primaryPaneIndex?(): number;
  /**
   * Optional, both: a pane's series band, back to front, and the call that
   * paints a layer directly above one of its entries. Without them no drawing
   * can be placed in the series band, and one saved there paints by its
   * `zIndex`.
   */
  seriesStack?(paneIndex: number): readonly string[];
  setPrimitiveStackAbove?(primitive: IPrimitive, above: string | null): boolean;
}

/** The pane-local price projection a chart pane carries, in media px. */
interface PaneProjection {
  priceToY(price: number): number;
  yToPrice(y: number): number;
}

export interface DrawingControllerOptions {
  /**
   * Snap new anchors to the O/H/L/C of the bar under the cursor. `'strong'`
   * always takes the nearest of the four; `'weak'` only when one sits within
   * a few pixels of the pointer, so a click on open space stays where it was
   * made. `true` means `'strong'` and `false` means `'off'`, which is what
   * the boolean meant before the modes existed. Default `'off'`. While a
   * tool is armed the layer paints a ring where the next click will land.
   */
  magnet?: boolean | MagnetMode;
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
  /**
   * Draw the anchor of every study input that declares one (a `price` input
   * with a `timeKey` and `anchor: true`): a handle at the point the pair
   * names that drags both as one settings change and one step of this undo
   * history. Default true; false draws none, and the inputs are still edited
   * in settings and picked with `Chart.beginPick('point')`.
   */
  inputAnchors?: boolean;
}

/** How `DrawingController.setTool` arms a tool. */
export interface DrawingPlacementOptions {
  /**
   * The space the placed drawing is anchored in. `'viewport'` pins it to the
   * screen: the anchors are placed where they are clicked, as usual, and kept
   * as fractions of the pane's plot from then on. Only a tool that declares
   * `viewport` accepts it. Default `'data'`.
   */
  space?: DrawingSpace;
}

/**
 * What `drawing:change` reports happened to the listed ids. The list is empty
 * for a step of the undo history that changed no drawing, a study input
 * anchor's drag and its undo or redo, so a control showing whether Undo is
 * available still refreshes.
 */
export type DrawingChangeKind = 'add' | 'update' | 'remove' | 'reorder' | 'undo' | 'redo';

/** Options for a call that changes, groups or deletes drawings. */
export interface DrawingEditOptions {
  /**
   * Reach drawings whose policy sets `editable: false` as well, and the
   * groups that hold them. Without it they are left exactly as they are,
   * which is what keeps every control a host wires to the user off them. The
   * host that placed such a drawing passes it to move, restyle, regroup or
   * retire it. A forced call is the host's own act, not the user's, so it
   * records no undo step, and every step already recorded takes it too: no
   * later undo or redo reverses it, and a step it leaves with nothing to do
   * is dropped.
   *
   * Cost: taking a call into the recorded steps is one pass over the undo
   * and redo history, parsing and rewriting both snapshots of every step, so
   * it grows with the number of recorded steps (see `historyLimit`) times
   * the drawing count. A forced delete, a forced grouping call, a forced
   * patch to a drawing the user may edit or one that carries `zIndex`, any
   * patch that carries `policy` and a linked chart's change of policy make
   * that pass. A forced patch to a read-only drawing that carries neither
   * `policy` nor `zIndex` (a level the host trails on every tick) makes
   * none: history cannot reach that drawing's content while it stays
   * read-only, so the patch is held and goes in with the next pass, which a
   * change of its policy always makes.
   */
  force?: boolean;
}

/**
 * The pointer facts the chart attaches to every gesture payload. Read
 * defensively throughout: a host built against an older engine, or a
 * synthetic event in a test, carries none of them, and the fallbacks are a
 * plain mouse click with nothing held.
 */
interface PointerFacts {
  modifiers?: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean };
  pointerType?: string;
  pressure?: number;
}

/** One coalesced pointer position: container x, pane-local y, pressure. */
interface PointerSample {
  x: number;
  y: number;
  pressure?: number;
}

interface ClickPayload extends PointerFacts {
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

interface DragPayload extends PointerFacts {
  id: string;
  price: number;
  time: number;
  paneIndex: number;
  /** Container x, pane-local y. What a viewport drag measures, where the bars cannot. */
  point?: { x: number; y: number };
  /** Where the gesture was grabbed; deltas measure from here, not frame one. */
  fromPrice?: number;
  fromTime?: number;
}

/**
 * What a crosshair move carries, beyond the pointer facts: the bar under the
 * pointer for the magnet, `pressed` for freehand inking, and, while pressed,
 * every position the pointer passed through since the last move (`samples`),
 * so a fast stroke keeps its curve rather than its frame-rate corners.
 */
interface CrosshairPayload extends PointerFacts {
  time?: number | null;
  price?: number | null;
  paneIndex?: number | null;
  point?: { x: number; y: number } | null;
  bar?: { open: number; high: number; low: number; close: number } | null;
  pressed?: boolean;
  samples?: PointerSample[];
}

/**
 * The layers of one pane: under the series, over it, and one inside the
 * series band for each entry a drawing is placed above.
 */
interface PaneLayers {
  bottom: DrawingLayer;
  top: DrawingLayer;
  series: Map<string, DrawingLayer>;
}

/**
 * The time scale's default bar spacing, for a horizontal nudge on a host that
 * cannot map pixels to time. Wrong by the zoom factor there, never by an order
 * of magnitude.
 */
const FALLBACK_BAR_SPACING_PX = 8;

/** How close, in media px, an O/H/L/C must be for the weak magnet to pull. */
const WEAK_MAGNET_PX = 8;

/** The angle step Shift locks a line to, in radians: 45 degrees. */
const ANGLE_STEP = Math.PI / 4;

/**
 * How far a thinned stroke may stray from the pointer's path, in media px.
 * Under the width of the ink itself, so the thinning is invisible; above the
 * jitter of a hand, so a stroke stops costing an anchor per pixel.
 */
const STROKE_EPSILON_PX = 1.5;

/**
 * The pressure a mouse reports while its button is held, and what a sample
 * without a value is taken to be. A sample at exactly this value stores
 * nothing, so a mouse stroke carries no pressure at all.
 */
const REST_PRESSURE = 0.5;

let nextId = 1;

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** Read-only to the user: `DrawingPolicy.editable` set to false. */
const pinned = (d: Drawing | undefined): boolean => d?.policy?.editable === false;

/**
 * The index of the one anchor that differs between two sets, or null when
 * none or several do. What a tool's constraint is told a points patch moved.
 */
function changedAnchor(prev: readonly DrawingPoint[], next: readonly DrawingPoint[]): number | null {
  if (prev.length !== next.length) return null;
  let found: number | null = null;
  for (let i = 0; i < next.length; i++) {
    if (prev[i].time === next[i].time && prev[i].price === next[i].price) continue;
    if (found !== null) return null;
    found = i;
  }
  return found;
}

/** The 1.9.x boolean and the 2.0 modes, folded onto one. */
function magnetModeOf(value: boolean | MagnetMode | undefined): MagnetMode {
  if (value === true) return 'strong';
  if (value === 'weak' || value === 'strong') return value;
  return 'off';
}

/** Whether Shift is held, from either form the payload carries it in. */
const shiftOf = (p: PointerFacts & { shiftKey?: boolean }): boolean =>
  p.modifiers?.shift === true || p.shiftKey === true;

/** `v` held to `0..size`: a pixel on a plot of that size. */
const within = (v: number, size: number): number => (v < 0 ? 0 : v > size ? size : v);

/**
 * Anchors on one axis, from `a0..a1`, cut so the box `b0..b1` they carry fits
 * a plot of `size`: held inside the room the box leaves them, so a label
 * above a box stays above it on the plot, or on the plot when the box adds
 * more than the plot has.
 */
const cutInto = (b0: number, b1: number, a0: number, a1: number, size: number) => {
  const lead = Math.max(0, a0 - b0);
  const trail = Math.max(0, b1 - a1);
  return (v: number): number => (b1 - b0 <= size ? v
    : lead + trail < size ? Math.min(Math.max(v, lead), size - trail)
    : within(v, size));
};

/** The pointer kind behind a payload; anything unnamed is a mouse. */
const pointerKindOf = (p: PointerFacts): DrawingPointerKind =>
  p.pointerType === 'touch' || p.pointerType === 'pen' ? p.pointerType : 'mouse';

type ControllerOptions = Required<Omit<DrawingControllerOptions, 'defaultStyle' | 'clipboard' | 'clipboardFallbackToMemory' | 'magnet' | 'inputAnchors'>>
  & { defaultStyle: DrawingStyle; magnet: MagnetMode };

// `external` is a step of the history that is not a drawing edit, a study
// anchor's drag: its snapshots are the drawings as they stood, unchanged by it.
interface DrawingHistoryEntry { before: string; after: string; external?: InputAnchorStep }

/** @internal Reserved persistence metadata; a duplicate is a new drawing lineage. */
export const DRAWING_LINK_METADATA_KEY = 'openalgo-charts/drawing-link';

function historyPatch(current: unknown, before: unknown, after: unknown): unknown {
  if (JSON.stringify(before) === JSON.stringify(after)) return current;
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object'
    || Array.isArray(before) || Array.isArray(after)) return after;
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const result = { ...(current as Record<string, unknown> | undefined) };
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (JSON.stringify(left[key]) === JSON.stringify(right[key])) continue;
    if (!(key in right)) delete result[key];
    else result[key] = historyPatch(result[key], left[key], right[key]);
  }
  return result;
}

export class DrawingController {
  private readonly _chart: DrawingChartHost;
  private _opts: ControllerOptions;
  private readonly _clipboard: DrawingClipboard;
  private readonly _layers = new Map<number, PaneLayers>();
  private _drawings: Drawing[] = [];
  private _groups: DrawingGroup[] = [];
  private _nextGroup = 1;
  private readonly _linkedPreviews = new Map<string, Drawing>();
  private _destroyed = false;
  private _tool: string | null = null;
  /** The space the armed tool places in; data whenever no tool is armed. */
  private _toolSpace: DrawingSpace = 'data';
  private _pending: DrawingPoint[] = [];
  private _pendingPane = 0;
  /** Selected ids, in the order they were picked. The first is the primary. */
  private _selection: string[] = [];
  /** The drawing under the pointer, from the chart's own hit-test. */
  private _hovered: string | null = null;
  /**
   * Drawings that live under the series but are painted on the top layer for
   * the length of a drag. The top layer repaints on the cursor tier; the
   * bottom one costs the series every frame, which is the difference between
   * a drag that follows the hand and one that stutters through the candles.
   */
  private readonly _lifted = new Set<string>();
  /** The slots the series-band drawings were last listed in; see `_slotSignature`. */
  private _slotKey = '';
  /** Shift as of the last pointer report: what angle lock reads mid-preview. */
  private _shift = false;
  /** The device behind the last pointer report, for target sizing. */
  private _pointerKind: DrawingPointerKind = 'mouse';
  /** Snapshots for undo/redo; each is a full drawing list (they are small). */
  private _undo: DrawingHistoryEntry[] = [];
  private _redo: DrawingHistoryEntry[] = [];
  private _pendingHistory: DrawingHistoryEntry | null = null;
  /** The host's patches the recorded steps have yet to take, merged per drawing. */
  private readonly _hostPatches = new Map<string, DrawingPatch>();
  /**
   * One gesture's starting state. `items` are ids rather than objects because
   * an undo mid-drag replaces every drawing object, and a stale reference
   * would move a shape that is no longer in the model.
   */
  private _dragStart: {
    id: string;
    handle: number | null;
    from: DrawingPoint;
    /** The press on its pane's plot, in media px: what a viewport drawing moves by the pointer from. */
    origin: ScreenPoint | null;
    items: { id: string; paneIndex: number; points: DrawingPoint[]; viewportPoints?: ViewportPoint[] }[];
    undo: DrawingHistoryEntry[];
    redo: DrawingHistoryEntry[];
  } | null = null;
  private readonly _off: (() => void)[] = [];
  private _anchors: InputAnchors | null = null;
  private _lastCursor: { time: number; price: number; paneIndex: number } | null = null;
  /**
   * Bar under the cursor, carried by the crosshair event, with the time the
   * crosshair reported for it: the magnet lands anchors on that bar's values
   * at that bar's time.
   */
  private _lastBar: { time: number; open: number; high: number; low: number; close: number } | null = null;

  public constructor(chart: DrawingChartHost, options: DrawingControllerOptions = {}) {
    this._chart = chart;
    this._opts = {
      magnet: magnetModeOf(options.magnet),
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
    this._off.push(chart.on('crosshair:move', (p) => this._onCrosshair(p as CrosshairPayload)));
    this._off.push(chart.on('hover', (p) => this._onHover(p as { id?: string | null })));
    this._off.push(chart.on('drag', (p) => this._onDrag(p as DragPayload)));
    this._off.push(chart.on('drag:end', () => this._onDragEnd()));
    this._off.push(chart.on('drag:cancel', () => { this.cancelDrag(); }));
    this._off.push(chart.on('data:context', () => { this.cancelDrag(); }));
    this._off.push(chart.on('dblclick', () => { this.finish(); }));
    this._off.push(chart.on('drawings:restore', document => this.fromJSON(document)));
    // Restore anything a previous session left in the chart state. A 1.9.x
    // save is a bare array; the migration upgrades it in place.
    const saved = chart.drawingState();
    if (saved !== undefined && saved !== null) {
      const document = migrateDrawings(saved);
      this._drawings = document.drawings;
      this._groups = document.groups ?? [];
    }
    this._off.push(chart.on('paneRemoved', value => {
      const { paneIndex } = value as { paneIndex: number };
      this._remapPanes(index => index === paneIndex ? null : index > paneIndex ? index - 1 : index);
    }));
    this._off.push(chart.on('paneMoved', value => {
      const { from, to } = value as { from: number; to: number };
      this._remapPanes(index => index === from ? to : index === to ? from : index);
    }));
    // A study added, removed, moved or restacked changes which slot a drawing
    // placed in the series band paints in, and nothing else of it: only the
    // layers are re-listed, and only when a slot changed. Writing the chart
    // state here would announce a change of its own and come straight back.
    for (const event of ['objects:change', 'indicatorRemoved']) {
      this._off.push(chart.on(event, () => { if (this._slotKey !== this._slotSignature()) this._syncLayers(); }));
    }
    this._sync();
    if (options.inputAnchors !== false && typeof (chart as InputAnchorHost).indicators === 'function') {
      this._anchors = new InputAnchors(chart as InputAnchorHost, {
        record: step => this._recordStep(step),
        placing: () => this._tool !== null,
      });
    }
  }

  // ── public API ──────────────────────────────────────────────────────────

  /**
   * Arm a tool for placement, or pass null to return to the cursor. With
   * `options.space` set to `'viewport'` the drawing it places is pinned to the
   * screen; a tool that cannot be (see `DrawingTool.viewport`) throws.
   */
  public setTool(toolId: string | null, options: DrawingPlacementOptions = {}): void {
    if (toolId !== null && !hasDrawingTool(toolId)) {
      throw new Error(`openalgo-charts: unknown drawing tool "${toolId}"`);
    }
    const space: DrawingSpace = toolId !== null && options.space === 'viewport' ? 'viewport' : 'data';
    if (space === 'viewport' && !viewportDrawingTool(toolId as string)) {
      throw new Error(`openalgo-charts: drawing tool "${toolId}" cannot be anchored to the viewport`);
    }
    this.cancelDrag();
    this._tool = toolId;
    this._toolSpace = space;
    this._pending = [];
    this._setPlacementMode(toolId !== null);
    this._syncPreview();
    this._syncSnapRing();
    this._emitTool();
  }

  /** The space the armed tool places in: `'data'` unless it was armed for the viewport. */
  public activeToolSpace(): DrawingSpace {
    return this._toolSpace;
  }

  /** `draw:tool`, carrying the space only when it is not the default, as the payload always has. */
  private _emitTool(): void {
    this._chart.emit('draw:tool', this._toolSpace === 'viewport' ? { tool: this._tool, space: 'viewport' } : { tool: this._tool });
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
    const { clipboard, magnet, ...rest } = patch;
    this._opts = {
      ...this._opts, ...rest,
      defaultStyle: patch.defaultStyle ?? this._opts.defaultStyle,
      magnet: magnet === undefined ? this._opts.magnet : magnetModeOf(magnet),
    };
    if (clipboard !== undefined) this._clipboard.setPort(clipboard);
    this._syncSnapRing();
  }

  /** The snap mode in force, after the boolean form has been folded. */
  public magnetMode(): MagnetMode {
    return this._opts.magnet;
  }

  /**
   * The drawing under the pointer, selected or not, as the chart's hit-test
   * last reported it. What a host passes as `hasTarget` to the key mapping,
   * and what a context menu opens on.
   */
  public hovered(): string | null {
    return this._hovered;
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
  /** Named drawing sets, returned as detached records. */
  public groups(): readonly DrawingGroup[] {
    return this._groups.map(group => ({ ...group, members: [...group.members] }));
  }

  /**
   * Group live drawings, replacing any previous membership for those ids. A
   * read-only drawing's group is the host's, so it is left where it is
   * unless `options.force` is set.
   */
  public createGroup(name: string, ids: readonly string[], options: DrawingEditOptions = {}): DrawingGroup | null {
    const members = [...new Set(ids)].filter(id => this.get(id) !== undefined && (options.force || !pinned(this.get(id))));
    if (this._destroyed || !name.trim() || !members.length) return null;
    let id: string;
    // An id that only a recorded step still holds is taken as well: that
    // step would bring its group back over this one. Serialised, a group id
    // is its quoted self; the same text anywhere else only skips a number.
    do { id = `group-${this._nextGroup++}`; } while (this._groups.some(group => group.id === id)
      || [...this._undo, ...this._redo].some(entry => (entry.before + entry.after).includes(`"${id}"`)));
    const group = { id, name: name.trim(), members };
    const moved = new Set(members);
    this._regroup(options.force, groups => groups
      .map(previous => ({ ...previous, members: previous.members.filter(member => !moved.has(member)) }))
      .concat({ ...group, members: [...members] }));
    this._sync();
    this._emitChange(members, 'update');
    return { ...group, members: [...members] };
  }

  /** Rename a group. One that holds a read-only drawing is the host's, and needs `options.force`. */
  public renameGroup(id: string, name: string, options: DrawingEditOptions = {}): boolean {
    const group = this._group(id, options);
    if (!group || !name.trim()) return false;
    this._regroup(options.force, groups => groups.map(item => item.id === id ? { ...item, name: name.trim() } : item));
    this._sync();
    this._emitChange(group.members, 'update');
    return true;
  }

  /**
   * Remove a group, optionally deleting all its drawings as one edit. One
   * that holds a read-only drawing is the host's, and needs `options.force`.
   */
  public removeGroup(id: string, removeDrawings = false, options: DrawingEditOptions = {}): boolean {
    const group = this._group(id, options);
    if (!group) return false;
    this._regroup(options.force, groups => groups.filter(item => item.id !== id));
    if (!removeDrawings || this._removeIds(group.members, false, options.force).length === 0) { this._sync(); this._emitChange(group.members, 'update'); }
    return true;
  }

  /**
   * Make a grouping edit. The host's forced one is its own act, so every
   * recorded step takes it as well, and no undo or redo reverses it.
   */
  private _regroup(force: boolean | undefined, edit: (groups: DrawingGroup[]) => DrawingGroup[]): void {
    this._begin(!force);
    this._groups = edit(this._groups);
    if (force) this._rebase(document => { document.groups = edit(document.groups ?? []); });
  }

  /** The live group `id`, unless it holds a read-only drawing and the call is not forced. */
  private _group(id: string, options: DrawingEditOptions): DrawingGroup | undefined {
    const group = this._groups.find(item => item.id === id);
    return this._destroyed || (!options.force && group?.members.some(member => pinned(this.get(member)))) ? undefined : group;
  }

  /**
   * Move one step through the rendered stack, within the slot it paints in:
   * its side of the series, or the entry it is placed above. `placeInStack`
   * moves it between slots.
   */
  public reorder(id: string, direction: -1 | 1): boolean {
    const drawing = this.get(id);
    if (!drawing || this._destroyed || (direction !== -1 && direction !== 1)) return false;
    const entries = this._entries(drawing.paneIndex), slot = this._slotOf(drawing, entries);
    const band = this._drawings.filter(item => item.paneIndex === drawing.paneIndex && this._slotOf(item, entries) === slot)
      .sort((a, b) => a.zIndex - b.zIndex);
    const index = band.indexOf(drawing);
    const target = index + direction;
    if (target < 0 || target >= band.length) return false;
    this._pushUndo();
    [band[index], band[target]] = [band[target], band[index]];
    const members = new Set(band);
    let cursor = 0;
    this._drawings = this._drawings.map(item => members.has(item) ? band[cursor++] : item);
    band.forEach((item, position) => { item.zIndex = slot === 'below' ? position - band.length : position; });
    this._sync();
    for (const item of band) this._chart.emit('draw:update', { drawing: item });
    this._emitChange(band.map(item => item.id), 'reorder');
    return true;
  }

  /**
   * Move a drawing directly above or below `target` in its pane's paint
   * order, as one undo step. Next to another drawing it joins the slot that
   * drawing paints in; above a series-band entry (`chart.seriesStack`) it is
   * placed on that entry, under the drawings already there; below one it goes
   * on top of the slot under that entry, the drawings behind the series when
   * the entry is the first. A slot's drawings are renumbered, below the series
   * up to -1 and elsewhere from 0. False, with nothing recorded, for a target
   * on another pane, one the host cannot report, or a move that changes nothing.
   * Like `reorder`, it is outside a drawing's policy.
   */
  public placeInStack(id: string, target: DrawingStackTarget, where: 'above' | 'below'): boolean {
    const d = this.get(id);
    if (d === undefined || this._destroyed || (where !== 'above' && where !== 'below') || target === null || typeof target !== 'object') return false;
    const entries = this._entries(d.paneIndex);
    let slot: string, index: number;
    if ('drawing' in target) {
      const t = this.get(target.drawing);
      if (t === undefined || t === d || t.paneIndex !== d.paneIndex) return false;
      slot = this._slotOf(t, entries);
      index = this._slotMembers(d.paneIndex, slot, entries).filter(m => m !== d).indexOf(t) + (where === 'above' ? 1 : 0);
    } else {
      const at = entries.indexOf((target as { entry: string }).entry);
      if (at < 0) return false;
      slot = where === 'above' ? 'entry:' + entries[at] : at === 0 ? 'below' : 'entry:' + entries[at - 1];
      index = where === 'above' ? 0 : this._slotMembers(d.paneIndex, slot, entries).filter(m => m !== d).length;
    }
    const members = this._slotMembers(d.paneIndex, slot, entries);
    if (this._slotOf(d, entries) === slot && members.indexOf(d) === index) return false;
    this._pushUndo();
    const next = members.filter(m => m !== d);
    next.splice(index, 0, d);
    if (slot.startsWith('entry:')) d.stackAbove = slot.slice('entry:'.length);
    else delete d.stackAbove;
    next.forEach((m, position) => { m.zIndex = slot === 'below' ? position - next.length : position; });
    this._sync();
    for (const m of next) this._chart.emit('draw:update', { drawing: m });
    this._emitChange(next.map(m => m.id), 'reorder');
    return true;
  }

  /** A pane's series band as the chart reports it, or none on a host that cannot. */
  private _entries(paneIndex: number): readonly string[] {
    return this._chart.seriesStack?.(paneIndex) ?? [];
  }

  /**
   * The slot a drawing paints in: `entry:<id>` while the entry it is placed
   * above is in its pane's series band, else its side of the series by `zIndex`.
   */
  private _slotOf(d: Drawing, entries: readonly string[]): string {
    return d.stackAbove !== undefined && entries.includes(d.stackAbove) ? 'entry:' + d.stackAbove : d.zIndex < 0 ? 'below' : 'above';
  }

  /** The drawings of one slot of a pane, in paint order. */
  private _slotMembers(paneIndex: number, slot: string, entries: readonly string[]): Drawing[] {
    return sortByZIndex(this._drawings.filter(d => d.paneIndex === paneIndex && this._slotOf(d, entries) === slot));
  }

  private _remapPanes(map: (index: number) => number | null): void {
    // Cancel without syncing to numeric slots which have already shifted.
    const drag = this._dragStart;
    if (drag) {
      this._dragStart = null;
      for (const item of drag.items) { const drawing = this.get(item.id); if (drawing) this._restoreAnchors(drawing, item); }
      this._undo = drag.undo;
      this._redo = drag.redo;
      this._pendingHistory = null;
      this._lifted.clear();
      this._chart.emit('draw:preview-clear', { ids: drag.items.map(item => item.id) });
    }
    this._pending = [];
    this._lastCursor = null;
    this._linkedPreviews.clear();
    const remapSnapshot = (value: string): string => {
      const document = migrateDrawings(JSON.parse(value));
      document.drawings = document.drawings.filter(drawing => {
        const pane = map(drawing.paneIndex);
        if (pane === null) return false;
        drawing.paneIndex = pane;
        return true;
      });
      document.groups = migrateGroups(document.groups, document.drawings);
      return JSON.stringify(document);
    };
    for (const entry of new Set([...this._undo, ...this._redo])) {
      entry.before = remapSnapshot(entry.before);
      entry.after = remapSnapshot(entry.after);
    }
    const removed: Drawing[] = [];
    this._drawings = this._drawings.filter(drawing => {
      const pane = map(drawing.paneIndex);
      if (pane === null) { removed.push(drawing); return false; }
      drawing.paneIndex = pane;
      return true;
    });
    const layers = [...this._layers.entries()];
    this._layers.clear();
    for (const [index, pair] of layers) {
      const pane = map(index);
      if (pane !== null) this._layers.set(pane, pair);
    }
    this._pruneSelection();
    this._sync();
    for (const drawing of removed) this._chart.emit('draw:remove', { drawing });
    this._emitChange(this._drawings.map(drawing => drawing.id), 'update');
  }

  public drawings(): readonly Drawing[] {
    return this._drawings;
  }

  public get(id: string): Drawing | undefined {
    return this._drawings.find((d) => d.id === id);
  }

  public get isDestroyed(): boolean { return this._destroyed; }

  /** Apply a linked commit without adding to this chart's local undo history. */
  public applyLinkedDrawing(id: string, drawing: Drawing | null): void {
    if (this._destroyed || this._chart.isDestroyed === true) return;
    if (this._dragStart?.items.some(item => item.id === id)) this.cancelDrag();
    const index = this._drawings.findIndex(item => item.id === id);
    this._linkedPreviews.delete(id);
    if (drawing === null) {
      if (index < 0) return;
      this._drawings.splice(index, 1);
      this._pruneSelection();
    } else {
      const copy = cloneDrawing({ ...drawing, id });
      const was = JSON.stringify(this._drawings[index]?.policy);
      if (index < 0) this._drawings.push(copy);
      else this._drawings[index] = copy;
      // A policy the other chart's host changed holds here too, history included.
      if (JSON.stringify(copy.policy) !== was) {
        this._rebase(document => { for (const d of document.drawings) if (d.id === id) d.policy = copy.policy; });
      }
    }
    this._sync();
    this._chart.emit('drawing:change', { ids: [id], kind: drawing === null ? 'remove' : index < 0 ? 'add' : 'update', linked: true });
  }

  /** A linked drag paints over its committed drawing without changing saved state. */
  public setLinkedPreview(id: string, drawing: Drawing | null): void {
    if (this._destroyed || this._chart.isDestroyed === true) return;
    if (drawing === null) this._linkedPreviews.delete(id);
    else if (this.get(id) !== undefined) this._linkedPreviews.set(id, cloneDrawing({ ...drawing, id }));
    this._sync();
  }

  /** Reorder related drawings inside their existing slots, preserving unrelated local order. */
  public reorderLinkedDrawings(ids: readonly string[]): void {
    if (this._destroyed || this._chart.isDestroyed === true) return;
    const ordered = [...new Set(ids)].map(id => this.get(id)).filter((d): d is Drawing => d !== undefined);
    const selected = new Set(ordered.map(d => d.id));
    let index = 0;
    const next = this._drawings.map(d => selected.has(d.id) ? ordered[index++] : d);
    if (next.every((d, i) => d === this._drawings[i])) return;
    this._drawings = next;
    this._sync();
    this._chart.emit('drawing:change', { ids: ordered.map(d => d.id), kind: 'reorder', linked: true });
  }

  /** Supported numeric levels, independent of whether the queried time lies on the shape. */
  public alertInfo(id: string): AlertDrawingInfo {
    const drawing = this.get(id);
    if (!drawing || !hasDrawingTool(drawing.tool)) return { available: false, reason: 'Drawing is unavailable', levels: [] };
    const tool = getDrawingTool(drawing.tool);
    // A pinned drawing sits over whatever price is under it at the moment,
    // which changes with every pan: there is no level to watch.
    if (drawing.space === 'viewport') return { available: false, reason: 'A drawing pinned to the screen has no price', paneIndex: drawing.paneIndex, levels: [] };
    if (!tool.alertValue) return { available: false, reason: 'This tool has no numeric alert value', paneIndex: drawing.paneIndex, levels: [] };
    const levels = tool.alertLevels?.(drawing) ?? [{ id: 'line', title: 'Line' }];
    if (!this._chart.timeToCoordinate || !this._chart.priceToCoordinate || !this._chart.coordinateToPrice) {
      return { available: false, reason: 'Drawing coordinate maps are unavailable', levels: [], paneIndex: drawing.paneIndex };
    }
    return { available: levels.length > 0, reason: levels.length ? undefined : 'No active drawing levels',
      paneIndex: drawing.paneIndex, levels: levels.map(level => ({ ...level })) };
  }

  /** Numeric drawing value using the actual pane projection and collapsed time axis. */
  public valueAt(id: string, time: number, level?: string): AlertDrawingValue | undefined {
    const drawing = this.get(id);
    if (!drawing || drawing.space === 'viewport' || !hasDrawingTool(drawing.tool) || !Number.isFinite(time)) return undefined;
    const tool = getDrawingTool(drawing.tool);
    const toX = this._chart.timeToCoordinate;
    const toPrice = this._chart.coordinateToPrice;
    if (!tool.alertValue || !toX || !toPrice) return undefined;
    const pane = drawing.paneIndex;
    let fromY = (y: number): number | null => toPrice.call(this._chart, y, pane);
    let pts = drawing.points.map(point => this._toPixel(point, pane));
    if (pts.includes(null)) {
      // A pane folded to a strip has no place on screen, so the chart maps no
      // price there, yet an alert on it must keep firing. The pane's own scale
      // keeps the projection it was drawn in, and every alert level is a line
      // through the anchors, which the height of that scale cannot move.
      const own = this._chart.panes?.()[pane] as PaneProjection | undefined;
      if (typeof own?.priceToY !== 'function' || typeof own.yToPrice !== 'function') return undefined;
      pts = drawing.points.map(point => ({ x: toX.call(this._chart, point.time), y: own.priceToY(point.price) }));
      fromY = y => own.yToPrice(y);
    }
    const x = toX.call(this._chart, time);
    if (!Number.isFinite(x)) return undefined;
    const value = tool.alertValue({ drawing, pts: pts as ScreenPoint[], time, x, fromY }, level);
    if (!value || !Number.isFinite(value.price) || (value.upperPrice !== undefined && !Number.isFinite(value.upperPrice))) return undefined;
    return { ...value, paneIndex: drawing.paneIndex };
  }

  /**
   * Add a fully-specified drawing (import, or a host-authored one). One that
   * carries a restriction is the host's, and placing it is not a step the
   * user can take back, so it is not recorded.
   */
  public add(drawing: DrawingInput): Drawing {
    // Refused before anything is recorded: a bad viewport drawing is the
    // caller's mistake, and leaves no undo step behind.
    if (drawing.space === 'viewport' && (!viewportDrawingTool(drawing.tool) || readViewportPoints(drawing.viewportPoints) === null)) {
      throw new Error(`openalgo-charts: a "${drawing.tool}" drawing cannot be anchored to the viewport with those viewportPoints`);
    }
    this._begin(!Object.values(drawing.policy ?? {}).includes(false));
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
    // A copy: the object the caller keeps is not a switch on this drawing.
    if (drawing.policy) created.policy = { ...drawing.policy };
    // One space, one set of anchors: a viewport drawing keeps no data anchors
    // that could be mistaken for its position, and data is never written out.
    if (drawing.space === 'viewport') {
      created.points = [];
      created.viewportPoints = readViewportPoints(drawing.viewportPoints) ?? [];
    } else {
      delete created.space;
      delete created.viewportPoints;
    }
    if (created.props?.[DRAWING_LINK_METADATA_KEY] !== undefined) {
      created.props = { ...created.props };
      delete created.props[DRAWING_LINK_METADATA_KEY];
    }
    if (drawing.text !== undefined || tool.defaultText !== undefined) {
      created.text = { value: '', ...tool.defaultText, ...drawing.text };
    }
    this._drawings.push(created);
    return created;
  }

  private _mintId(): string {
    return `d${nextId++}`;
  }

  /**
   * Patch one drawing. False when there is no such drawing, or when it is
   * read-only to the user and `options.force` is not set. A patch that
   * carries `policy` is the host's, and like a forced one records no step.
   *
   * Also false when the patch asks for a `space` the drawing could not be
   * moved to (a tool without viewport support, or a pane with no place on
   * screen, folded or hidden behind a maximized pane): the rest of the patch
   * still applies, and the false tells a host that the drawing is not in the
   * space it asked for, which a control showing that space has to say.
   */
  public update(id: string, patch: DrawingPatch, options: DrawingEditOptions = {}): boolean {
    const d = this.get(id);
    if (d === undefined || (pinned(d) && options.force !== true)) return false;
    this.updateMany([{ id, patch }], options);
    return patch.space === undefined || (d.space === 'viewport') === (patch.space === 'viewport');
  }

  /**
   * Patch several drawings as one undo entry: a colour change across a
   * multi-selection is one edit to the user, so it is one Ctrl+Z too. Ids that
   * no longer exist are skipped, and so are read-only drawings unless
   * `options.force` is set; nothing is recorded when nothing is left, or
   * when every patch is the host's (forced, or carrying `policy`).
   */
  public updateMany(patches: ReadonlyArray<{ id: string; patch: DrawingPatch }>, options: DrawingEditOptions = {}): void {
    const live = patches
      .map((p) => ({ d: this.get(p.id), patch: p.patch }))
      .filter((p): p is { d: Drawing; patch: DrawingPatch } => p.d !== undefined && (options.force === true || !pinned(p.d)))
      // A change of space the controller cannot make leaves nothing for that
      // drawing to do, and it is not an edit to record.
      .map(({ d, patch }) => ({ d, patch: this._spacePatch(d, patch), asked: Object.keys(patch).length }))
      .filter(({ patch, asked }) => asked === 0 || Object.keys(patch).length > 0);
    if (live.length === 0) return;
    this._begin(!options.force && live.some(({ patch }) => !patch.policy));
    for (const { d, patch } of live) this._applyPatch(d, patch);
    let rewrite = false;
    for (const { d, patch: { points, ...rest } } of live) {
      if (!options.force && !rest.policy) continue;
      // The host's patch, whole, and the anchors exactly where they landed:
      // a constraint run again on an older shape could put them elsewhere.
      const held = this._hostPatches.get(d.id) ?? {};
      this._applyPatch(held as Drawing, rest);
      // Data is stored as an absent space, so the held patch names it outright.
      if (rest.space !== undefined) held.space = rest.space;
      // Likewise a drawing taken out of the series band.
      if (rest.stackAbove !== undefined) (held as DrawingPatch).stackAbove = rest.stackAbove;
      if (points) held.points = d.points;
      this._hostPatches.set(d.id, held);
      // History cannot reach a read-only drawing's content until its policy
      // changes, and that change is a rewrite which takes this patch first,
      // so moving one (a trailing level, every tick) costs no rewrite. Its
      // place in the stack is within history's reach.
      rewrite ||= !pinned(d) || !!rest.policy || rest.zIndex !== undefined || rest.stackAbove !== undefined;
    }
    if (rewrite) this._rebase();
    this._sync();
    for (const { d } of live) this._chart.emit('draw:update', { drawing: d });
    this._emitChange(live.map((p) => p.d.id), 'update');
  }

  /**
   * A patch as it applies to `d`. A change of space comes out complete, with
   * the anchors of the new space (converted at the view on screen unless the
   * patch gives them), or is left out when it cannot be made; anchors of the
   * space the drawing will not be in are left out too, so one drawing never
   * carries two positions.
   */
  private _spacePatch(d: Drawing, patch: DrawingPatch): DrawingPatch {
    const { space, points, viewportPoints, ...rest } = patch;
    const from: DrawingSpace = d.space === 'viewport' ? 'viewport' : 'data';
    let to: DrawingSpace = space === undefined ? from : space === 'viewport' ? 'viewport' : 'data';
    if (to === 'viewport' && from === 'data' && !viewportDrawingTool(d.tool)) to = 'data';
    if (to === 'viewport') {
      const given = viewportPoints === undefined ? null : readViewportPoints(viewportPoints);
      if (to === from) return given === null ? rest : { ...rest, viewportPoints: given };
      const anchors = given ?? this._toViewport(points ?? d.points, d.paneIndex, d);
      return anchors === null ? rest : { ...rest, space: 'viewport', points: [], viewportPoints: anchors };
    }
    if (to === from) return points === undefined ? rest : { ...rest, points };
    const anchors = points ?? this._fromViewport(readViewportPoints(viewportPoints) ?? d.viewportPoints ?? [], d.paneIndex, d);
    return anchors === null ? rest : { ...rest, space: 'data', points: anchors };
  }

  private _applyPatch(d: Drawing, patch: DrawingPatch): void {
    if (patch.points !== undefined) {
      const points = patch.points.map((p) => ({ ...p }));
      const tool = hasDrawingTool(d.tool) ? getDrawingTool(d.tool) : undefined;
      // A patch that moved exactly one anchor (a price typed into a settings
      // field) is told which, so the constraint leaves that one where it was
      // put, the same as a drag of its handle would. A move to the viewport
      // empties the list, which leaves nothing to constrain.
      d.points = tool?.constrain === undefined || points.length === 0 ? points : tool.constrain(points, changedAnchor(d.points, points));
    }
    if (patch.space !== undefined) {
      if (patch.space === 'viewport') d.space = 'viewport';
      else { delete d.space; delete d.viewportPoints; }
    }
    if (patch.viewportPoints !== undefined) d.viewportPoints = patch.viewportPoints.map((p) => ({ x: p.x, y: p.y }));
    if (patch.style !== undefined) d.style = { ...d.style, ...patch.style };
    if (patch.text !== undefined) d.text = { ...d.text, ...patch.text };
    if (patch.props !== undefined) d.props = { ...d.props, ...patch.props };
    if (patch.locked !== undefined) d.locked = patch.locked;
    if (patch.visible !== undefined) d.visible = patch.visible;
    if (patch.zIndex !== undefined && Number.isFinite(patch.zIndex)) d.zIndex = patch.zIndex;
    if (patch.policy !== undefined) d.policy = { ...d.policy, ...patch.policy };
    if (typeof patch.stackAbove === 'string' && patch.stackAbove !== '') d.stackAbove = patch.stackAbove;
    else if (patch.stackAbove === null) delete d.stackAbove;
  }

  /** Delete one drawing. A read-only one goes only with `options.force`. */
  public remove(id: string, options: DrawingEditOptions = {}): boolean {
    return this._removeIds([id], true, options.force).length > 0;
  }

  /**
   * Delete several drawings as one undo entry. Unknown ids are ignored, and
   * read-only drawings stay unless `options.force` is set.
   */
  public removeMany(ids: readonly string[], options: DrawingEditOptions = {}): void {
    this._removeIds(ids, true, options.force);
  }

  /**
   * The delete shared by `remove`, `removeMany`, `cut` and `clear`. Returns
   * what went, and records nothing when nothing did.
   */
  private _removeIds(ids: readonly string[], pushUndo: boolean, force = false): Drawing[] {
    const wanted = new Set(ids);
    const removed = this._drawings.filter((d) => wanted.has(d.id) && (force || !pinned(d)));
    if (removed.length === 0) return [];
    if (pushUndo) this._begin(!force);
    const set = new Set(removed.map((d) => d.id));
    this._drawings = this._drawings.filter((d) => !set.has(d.id));
    if (force) this._rebase(document => { document.drawings = document.drawings.filter((d) => !set.has(d.id)); });
    this._selection = this._selection.filter((id) => !set.has(id));
    this._sync();
    for (const d of removed) this._chart.emit('draw:remove', { drawing: d });
    this._emitChange(removed.map((d) => d.id), 'remove');
    return removed;
  }

  /** Delete every drawing the user may, as one undo entry; `options.force` takes the read-only ones too. */
  public clear(options: DrawingEditOptions = {}): void {
    if (this._drawings.length === 0) return;
    this._removeIds(this._drawings.map((d) => d.id), true, options.force);
    this._setSelection([]);
  }

  // ── selection ───────────────────────────────────────────────────────────

  /**
   * Replace the selection, or with `additive` toggle each id into it (the
   * shift-click gesture). Ids that name nothing, or a drawing whose policy
   * says it cannot be selected, are ignored, so the selection only ever holds
   * drawings that are there to act on. Pass null to clear.
   */
  public select(id: string | readonly string[] | null, additive = false): void {
    const wanted = id === null ? [] : typeof id === 'string' ? [id] : id;
    const known: string[] = [];
    for (const x of wanted) {
      if (this._selectable(x) && !known.includes(x)) known.push(x);
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

  private _selectable(id: string): boolean {
    const d = this.get(id);
    return d !== undefined && d.policy?.selectable !== false;
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
    for (const layer of this._allLayers()) layer.setSelected(next);
    if (!changed) return;
    this._chart.emit('draw:select', { id: this.selected() });
    this._chart.emit('drawing:select', { ids: next.slice() });
  }

  private _emitChange(ids: readonly string[], kind: DrawingChangeKind): void {
    if (this._pendingHistory !== null) {
      this._pendingHistory.after = this._historyText();
      this._pendingHistory = null;
    }
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

  /** In front of every other drawing in its slot: its side of the series, or the entry it is placed above. */
  public bringToFront(id: string): void {
    const d = this.get(id);
    if (d === undefined) return;
    const band = this._band(d);
    const z = band.length === 0 ? d.zIndex : Math.max(...band.map((o) => o.zIndex));
    this._reorder(d, z, 'end');
  }

  /** Behind every other drawing in its slot: its side of the series, or the entry it is placed above. */
  public sendToBack(id: string): void {
    const d = this.get(id);
    if (d === undefined) return;
    const band = this._band(d);
    const z = band.length === 0 ? d.zIndex : Math.min(...band.map((o) => o.zIndex));
    this._reorder(d, z, 'start');
  }

  /**
   * Under the series (`zIndex` -1), out of the series band when it was placed
   * in it. A no-op for a drawing already there.
   */
  public sendBehindSeries(id: string): void {
    const d = this.get(id);
    // A placement kept for a study that is gone goes too: the user chose a side.
    if (d !== undefined && (d.stackAbove !== undefined || this._slotOf(d, this._entries(d.paneIndex)) !== 'below')) this._crossSeries(d, -1);
  }

  /**
   * Over the series (`zIndex` 0), out of the series band when it was placed
   * in it. A no-op for a drawing already there.
   */
  public bringAboveSeries(id: string): void {
    const d = this.get(id);
    if (d !== undefined && (d.stackAbove !== undefined || this._slotOf(d, this._entries(d.paneIndex)) !== 'above')) this._crossSeries(d, 0);
  }

  private _crossSeries(d: Drawing, z: number): void {
    this._pushUndo();
    d.zIndex = z;
    delete d.stackAbove;
    this._sync();
    this._chart.emit('draw:update', { drawing: d });
    this._emitChange([d.id], 'reorder');
  }

  /** The other drawings sharing `d`'s pane and slot. */
  private _band(d: Drawing): Drawing[] {
    const entries = this._entries(d.paneIndex), slot = this._slotOf(d, entries);
    return this._drawings.filter((o) => o !== d && o.paneIndex === d.paneIndex && this._slotOf(o, entries) === slot);
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
   * shape the same visible amount on every pane and scale. Locked and
   * read-only drawings stay put.
   */
  public nudge(ids: readonly string[], dxPx: number, dyPx: number): void {
    if (dxPx === 0 && dyPx === 0) return;
    const list = this._targets(ids).filter((d) => d.locked !== true && !pinned(d));
    if (list.length === 0) return;
    this._pushUndo();
    for (const d of list) {
      if (d.space === 'viewport') {
        const frame = this._plotFrame(d.paneIndex);
        if (frame !== null) d.viewportPoints = this._shiftPinned(d, d.viewportPoints ?? [], dxPx, dyPx, frame);
        continue;
      }
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
   * select the clones. One undo entry. Ids that name nothing are ignored. A
   * clone is the user's own drawing, so it carries no policy.
   */
  public duplicate(ids: readonly string[]): Drawing[] {
    const sources = this._targets(ids);
    if (sources.length === 0) return [];
    this._pushUndo();
    const clones = sources.map((d) => {
      const { id: _id, createdAt: _createdAt, policy: _policy, ...rest } = cloneDrawing(d);
      void _id; void _createdAt; void _policy;
      return this._insert({ ...rest, ...this._offsetAnchors(d, d.paneIndex) });
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
    const ok = await this._clipboard.write(this._portable(list));
    if (ok) this._chart.emit('draw:copy', { drawings: list.map(cloneDrawing) });
    return ok;
  }

  /**
   * Copy, then delete. The delete happens **only** after the clipboard write
   * resolves successfully, so a refused write leaves the model exactly as it
   * was rather than destroying a drawing that went nowhere. A read-only
   * drawing cannot be deleted, so it is not cut either: it stays, uncopied.
   */
  public async cut(target?: string | readonly string[] | null): Promise<boolean> {
    const list = this._targets(target).filter((d) => !pinned(d));
    if (list.length === 0) return false;
    const ok = await this._clipboard.write(this._portable(list));
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
      return { ...e, paneIndex, ...this._offsetAnchors(e, paneIndex) };
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

  /** The slot this chart keeps its price pane in, read at each use because a host can move it. */
  private _pricePane(): number {
    return this._chart.primaryPaneIndex?.() ?? 0;
  }

  /**
   * Drawings as the clipboard carries them: panes counted price pane first,
   * the study panes after it in their order, the way a portable template
   * counts them. A price pane at the top, where every build before the move
   * kept it, is written exactly as before, and a drawing copied beside the
   * candles pastes beside the candles on any chart in any arrangement.
   */
  private _portable(list: readonly Drawing[]): Drawing[] {
    const price = this._pricePane();
    return list.map((d) => ({ ...d, paneIndex: d.paneIndex === price ? 0 : d.paneIndex < price ? d.paneIndex + 1 : d.paneIndex }));
  }

  /**
   * Fold a clipboard pane onto a pane this chart actually has: clamped to the
   * pane count in clipboard order, so a study drawing from a taller stack
   * lands on the last study pane rather than on the price pane, then put in
   * this chart's own slots around its price pane.
   */
  private _clampPane(paneIndex: number): number {
    const panes = this._chart.panes;
    const n = panes === undefined ? paneIndex + 1 : panes.call(this._chart).length;
    const slot = n === 0 ? 0 : Math.min(paneIndex, n - 1), price = this._pricePane();
    return slot === 0 ? price : slot <= price ? slot - 1 : slot;
  }

  /**
   * A copy's anchors, offset from the original's in its own space. A viewport
   * copy moves the paste offset in pixels on both axes, as a fraction of the
   * pane it lands on, so it reads the same on a chart of any size, and stays
   * on that pane's plot when the original sits at its edge.
   */
  private _offsetAnchors(d: Omit<Drawing, 'id'>, paneIndex: number): Pick<Drawing, 'points' | 'viewportPoints'> {
    if (d.space !== 'viewport') return { points: this._offsetPoints(d.points, paneIndex) };
    const anchors = d.viewportPoints ?? [];
    const frame = this._plotFrame(paneIndex);
    const px = this._opts.pasteOffsetPixels;
    return {
      points: [],
      viewportPoints: frame === null ? anchors.map((p) => ({ x: p.x, y: p.y })) : this._shiftPinned({ ...d, id: '' }, anchors, px, px, frame),
    };
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

  /**
   * Move a study's input anchor (a price input declared with `timeKey` and
   * `anchor: true`) to `point` as the user, the way dragging its handle does:
   * the time snaps to the bar under it, both halves stay inside the bounds the
   * inputs declare, a study the user may not configure refuses it, and the move
   * is one undo step in this history. For a host control that sets the point
   * another way, such as a point pick on the chart, so Undo takes it back like
   * a drag. False when the study has no anchor for `key` (or the controller was
   * built without input anchors), the study refuses, or it already holds the point.
   */
  public moveInputAnchor(studyId: string, key: string, point: { time: number; price: number }): boolean {
    return this._anchors?.move(studyId, key, point.time, point.price) ?? false;
  }

  // ── history and persistence ─────────────────────────────────────────────

  public undo(): boolean {
    this._onDragEnd();
    // A step that held nothing but changes to drawings now read-only does
    // nothing any more, so the press goes on to the step before it.
    for (let snap = this._undo.pop(); snap !== undefined; snap = this._undo.pop()) {
      this._redo.push(snap);
      if (snap.external ? this._external(snap.external.undo(), 'undo') : this._applyHistory(snap.after, snap.before, 'undo')) return true;
    }
    return false;
  }

  public redo(): boolean {
    this._onDragEnd();
    for (let snap = this._redo.pop(); snap !== undefined; snap = this._redo.pop()) {
      this._undo.push(snap);
      if (snap.external ? this._external(snap.external.redo(), 'redo') : this._applyHistory(snap.before, snap.after, 'redo')) return true;
    }
    return false;
  }

  /**
   * Move the model from one snapshot to the other; false when the policy left
   * nothing to move. Without `kind` it only answers, and moves nothing.
   */
  private _applyHistory(from: string, to: string, kind?: 'undo' | 'redo'): boolean {
    const beforeDocument = migrateDrawings(JSON.parse(from));
    const afterDocument = migrateDrawings(JSON.parse(to));
    const before = beforeDocument.drawings;
    const after = afterDocument.drawings;
    const left = new Map(before.map(d => [d.id, d]));
    const right = new Map(after.map(d => [d.id, d]));
    const beforeOrder = before.filter(d => right.has(d.id)).map(d => d.id);
    const afterOrder = after.filter(d => left.has(d.id)).map(d => d.id);
    const moved = afterOrder.some(id => beforeOrder.indexOf(id) !== afterOrder.indexOf(id));
    let held = false;
    const ids = [...new Set([...left.keys(), ...right.keys()])].filter(id => {
      const a = left.get(id);
      const b = right.get(id);
      if (JSON.stringify(a) === JSON.stringify(b) && beforeOrder.indexOf(id) === afterOrder.indexOf(id)) return false;
      // History is what the user did, and a read-only drawing is not theirs
      // to change: its content stays whatever a step says. Its place in the
      // stack is outside the policy, so a step that only restacked it runs.
      if ((pinned(a) || pinned(b) || pinned(this.get(id)))
        && !(a && b && JSON.stringify({ ...a, zIndex: 0 }) === JSON.stringify({ ...b, zIndex: 0 }))) { held = true; return false; }
      return true;
    });
    const changed = new Set(ids);
    const previous = new Map(this._drawings.map(d => [d.id, d]));
    const beforeGroups = new Map((beforeDocument.groups ?? []).map(group => [group.id, group]));
    const afterGroups = new Map((afterDocument.groups ?? []).map(group => [group.id, group]));
    const fixed = (member: string): boolean => pinned(this.get(member));
    // Where a step leaves group `id`, the policy allowing: a read-only drawing
    // stays in the group it is in now, and that group keeps its name. The
    // `order` form is what is applied; the other puts the read-only members
    // last, so a step that differs only in them compares as doing nothing.
    const place = (group: DrawingGroup | undefined, id: string, order?: boolean): DrawingGroup | undefined => {
      const now = this._groups.find(item => item.id === id);
      const kept = now?.members.filter(fixed) ?? [];
      if (!kept.length && !group?.members.some(fixed)) return group;
      const rest = group?.members.filter(member => !fixed(member) || (order && kept.includes(member))) ?? [];
      const members = [...new Set([...rest, ...kept])];
      return members.length ? { id, name: (kept.length ? now : group)!.name, members } : undefined;
    };
    const changedGroups = new Set([...beforeGroups.keys(), ...afterGroups.keys()]
      .filter(id => JSON.stringify(place(beforeGroups.get(id), id)) !== JSON.stringify(place(afterGroups.get(id), id))));
    // A step with nothing left to do is skipped by a press, and dropped by a
    // rewrite (`kind` absent), which is where a grouping step the policy has
    // emptied goes; one that never did anything still runs, as it always has.
    if (!ids.length && !changedGroups.size && !moved && (held || !kind)) return false;
    if (!kind) return true;
    const regrouped = [...changedGroups].map(id => place(afterGroups.get(id), id, true));
    this._groups = this._groups.filter(group => !changedGroups.has(group.id));
    for (const group of regrouped) if (group) this._groups.push(group);
    // Property history patches in place. Removing and reinserting every edited
    // shape would also undo a later reorder performed on another chart.
    this._drawings = this._drawings.filter(d => !changed.has(d.id) || right.has(d.id))
      .map(d => changed.has(d.id) ? historyPatch(d, left.get(d.id), right.get(d.id)) as Drawing : d);
    for (let i = 0; i < after.length; i++) {
      const drawing = after[i];
      // An edit cannot resurrect somebody else's deletion. Only history which
      // actually removed an id can restore it here.
      if (!changed.has(drawing.id) || previous.has(drawing.id) || left.has(drawing.id)) continue;
      const next = after.slice(i + 1).find(d => this.get(d.id) !== undefined);
      const at = next === undefined ? this._drawings.length : this._drawings.findIndex(d => d.id === next.id);
      this._drawings.splice(at, 0, drawing);
    }
    const reordered = afterOrder.filter(id => beforeOrder.indexOf(id) !== afterOrder.indexOf(id))
      .map(id => this.get(id)).filter((d): d is Drawing => d !== undefined);
    const moving = new Set(reordered.map(d => d.id));
    let position = 0;
    this._drawings = this._drawings.map(d => moving.has(d.id) ? reordered[position++] : d);
    this._pruneSelection();
    this._sync();
    for (const id of ids) {
      const drawing = this.get(id);
      const old = previous.get(id);
      if (drawing !== undefined) this._chart.emit(old === undefined ? 'draw:add' : 'draw:update', { drawing, history: true });
      else if (old !== undefined) this._chart.emit('draw:remove', { drawing: old, history: true });
    }
    this._emitChange(ids, kind);
    return true;
  }

  /** Drop selected ids the model no longer holds, or that can no longer be selected. */
  private _pruneSelection(): void {
    const next = this._selection.filter((id) => this._selectable(id));
    if (!sameIds(next, this._selection)) this._setSelection(next);
  }

  public canUndo(): boolean { return this._undo.length > 0; }
  public canRedo(): boolean { return this._redo.length > 0; }

  /**
   * Serialisable document, the same shape `ChartState.drawings` carries.
   * Transient drawings (`policy.persistent` false) are left out, and so is
   * their group membership.
   */
  public toJSON(): DrawingsDocument {
    return this._document(this._drawings.filter(d => d.policy?.persistent !== false));
  }

  /** `drawings` as a document, with the groups narrowed to them. */
  private _document(drawings: readonly Drawing[]): DrawingsDocument {
    const groups = migrateGroups(this._groups, drawings);
    return { version: DRAWING_STATE_VERSION, drawings: drawings.map(cloneDrawing), ...(groups.length ? { groups } : {}) };
  }

  /** Every drawing, transient ones too: an undo in the session reaches them. */
  private _historyText(): string {
    return JSON.stringify(this._document(this._drawings));
  }

  /**
   * Replace every drawing. Accepts a {@link DrawingsDocument} or a 1.9.x bare
   * `Drawing[]`; both go through the migration, so an old save upgrades on
   * load. Clears the selection and history.
   */
  public fromJSON(data: unknown): void {
    this.cancelDrag();
    this._linkedPreviews.clear();
    const document = migrateDrawings(data);
    this._drawings = document.drawings;
    this._groups = document.groups ?? [];
    this._undo = [];
    this._redo = [];
    this._hostPatches.clear();
    this._pendingHistory = null;
    this._setSelection([]);
    this._sync();
    this._chart.emit('draw:restore', {});
    this._emitChange(this._drawings.map(drawing => drawing.id), 'update');
  }

  public destroy(): void {
    if (this._destroyed) return;
    this.cancelDrag();
    this._destroyed = true;
    this._linkedPreviews.clear();
    this._chart.emit('draw:destroy', { controller: this });
    this._anchors?.destroy();
    this._setPlacementMode(false);   // never leave the chart unable to pan
    for (const off of this._off) off();
    this._off.length = 0;
    for (const l of this._layers.values()) {
      l.top.setBelow(null);
      this._chart.removePrimitive(l.top);
      this._chart.removePrimitive(l.bottom);
      for (const layer of l.series.values()) this._chart.removePrimitive(layer);
    }
    this._layers.clear();
  }

  /** Every layer of every pane. */
  private _allLayers(): DrawingLayer[] {
    return [...this._layers.values()].flatMap(l => [l.bottom, l.top, ...l.series.values()]);
  }

  // ── interaction ─────────────────────────────────────────────────────────

  private _onCrosshair(p: CrosshairPayload): void {
    const barTime = p.time ?? null;
    // No hovered bar does not mean the pointer left the plot. Empty time-axis
    // space still has a drawable position, while legends retain their null bar.
    const time = barTime ?? (p.point ? this._chart.coordinateToTime?.(p.point.x) ?? null : null);
    const price = p.price ?? null;
    const paneIndex = p.paneIndex ?? null;
    this._lastCursor = time === null || !Number.isFinite(time) || price === null || paneIndex === null
      ? null : { time, price, paneIndex };
    const bar = p.bar ?? null;
    this._lastBar = bar === null || barTime === null ? null : { time: barTime, ...bar };
    this._shift = shiftOf(p);
    this._notePointer(p);
    // The pointer left the plot: nothing is under it any more.
    if (time === null && price === null) this._setHovered(null);
    // Freehand tools ink while the pointer is held rather than on clicks.
    if (this._tool !== null && p.pressed === true && this._isFreehand()
      && time !== null && price !== null && paneIndex !== null
      && Number.isFinite(time) && Number.isFinite(price)) {
      for (const q of this._coalesced(p, { time, price }, paneIndex)) this._inkPoint(q, paneIndex);
      return;
    }
    this._syncSnapRing();
    // A tool mid-placement previews against the live cursor.
    if (this._tool !== null && this._pending.length > 0) this._syncPreview();
  }

  /** The chart's hit-test answer for the pointer position, whenever it changes. */
  private _onHover(p: { id?: string | null }): void {
    const id = p.id ?? null;
    const hit = id !== null && id.startsWith('draw:') ? id.slice('draw:'.length).split('#')[0] : null;
    // What cannot be selected is not a target for the keys either.
    this._setHovered(hit !== null && this._selectable(hit) ? hit : null);
  }

  private _setHovered(id: string | null): void {
    if (id === this._hovered) return;
    this._hovered = id;
    for (const layer of this._allLayers()) layer.setHovered(id);
    this._chart.emit('drawing:hover', { id });
  }

  /** Remember the device behind a report and size the layers' targets for it. */
  private _notePointer(p: PointerFacts): void {
    const kind = pointerKindOf(p);
    if (kind === this._pointerKind) return;
    this._pointerKind = kind;
    for (const layer of this._allLayers()) layer.setPointerType(kind);
  }

  /**
   * The positions a pressed move passed through, as anchors, ending on the
   * move's own point. The samples carry pixels (container x, pane-local y);
   * the payload's point is the same position in its own space, so the gap
   * between the two is the pane's offset, and each sample maps back through
   * the host's converters. A host without them, or a payload without
   * samples, inks the one point the move reports.
   */
  private _coalesced(p: CrosshairPayload, last: DrawingPoint, paneIndex: number): DrawingPoint[] {
    const samples = p.samples;
    const end = { ...last, ...this._pressureOf(p.pressure) };
    const toTime = this._chart.coordinateToTime;
    const toPrice = this._chart.coordinateToPrice;
    if (!Array.isArray(samples) || samples.length < 2 || toTime === undefined || toPrice === undefined
      || p.point === null || p.point === undefined) {
      return [end];
    }
    const tail = samples[samples.length - 1];
    const shift = p.point.y - tail.y;
    if (!Number.isFinite(shift)) return [end];
    const out: DrawingPoint[] = [];
    for (let i = 0; i < samples.length - 1; i++) {
      const s = samples[i];
      const time = toTime.call(this._chart, s.x);
      const price = toPrice.call(this._chart, s.y + shift, paneIndex);
      if (price === null || !Number.isFinite(time) || !Number.isFinite(price)) continue;
      out.push({ time, price, ...this._pressureOf(s.pressure) });
    }
    out.push({ ...end, ...this._pressureOf(tail.pressure ?? p.pressure) });
    return out;
  }

  /** A pressure worth storing: finite, and not the mouse's stand-in. */
  private _pressureOf(pressure: number | undefined): { pressure?: number } {
    return typeof pressure === 'number' && Number.isFinite(pressure) && pressure !== REST_PRESSURE
      ? { pressure: Math.min(1, Math.max(0, pressure)) }
      : {};
  }

  /**
   * Let a tool turn the clicked anchors into its full set (the position tools
   * build a 1:1 box off one click). Identity for tools without the hook.
   */
  private _expand(tool: DrawingTool, clicked: DrawingPoint[]): DrawingPoint[] {
    if (tool.expand === undefined) return clicked;
    const range = this._chart.getVisibleLogicalRange();
    const visibleBars = range === null ? 60 : Math.max(1, range.to - range.from);
    const pane = this._pendingPane;
    // The pixel mapping is offered only when the host has one, so a tool can
    // tell "cannot map" from "mapped to nothing" and size in chart units.
    const mapped = this._chart.timeToCoordinate !== undefined && this._chart.priceToCoordinate !== undefined
      && this._chart.coordinateToTime !== undefined && this._chart.coordinateToPrice !== undefined;
    const expanded = tool.expand(clicked, {
      barSeconds: this._barSeconds(),
      visibleBars,
      ...(mapped ? {
        toPixel: (p: DrawingPoint) => this._toPixel(p, pane),
        fromPixel: (at: ScreenPoint) => this._fromPixel(at, pane),
      } : {}),
    });
    return tool.constrain === undefined ? expanded : tool.constrain(expanded, null);
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
    const pane = this._pendingPane;
    // Placement runs in data space, where the preview already works; a tool
    // armed for the viewport converts at the moment it lands, which is
    // exactly where each anchor was clicked (the magnet does not pull for
    // it). Its box is measured with the text the drawing will be given.
    const text = tool.defaultText === undefined ? {} : { text: { ...tool.defaultText } };
    const pinned = this._toolSpace === 'viewport'
      ? this._toViewport(pts, pane, { id: '', tool: tool.id, points: [], style: {}, paneIndex: pane, zIndex: 0, ...text })
      : null;
    const created = this.add(pinned === null
      ? { tool: tool.id, points: pts, style: {}, paneIndex: pane }
      : { tool: tool.id, points: [], space: 'viewport', viewportPoints: pinned, style: {}, paneIndex: pane });
    this._pending = [];
    if (!this._opts.stayInDrawingMode) {
      this._tool = null;
      this._toolSpace = 'data';
      this._setPlacementMode(false);   // hand panning back to the chart
    }
    this._syncPreview();
    this._syncSnapRing();
    this.select(created.id);
    this._emitTool();
  }

  /**
   * Commit the stroke a freehand gesture built, if it has any extent. The
   * samples are thinned first: a pointer reports every few px, and a stroke
   * kept whole costs a time and price conversion per sample on every frame
   * and a row per sample in every save, for a curve the eye cannot tell from
   * the thinned one. Thinning happens in screen space, since the tolerance is
   * a pixel one; a host that cannot map to pixels keeps every sample.
   */
  private _finishFreehand(): void {
    const pts = this._pending;
    this._pending = [];
    if (pts.length < 2) {           // a tap is not a stroke
      this._syncPreview();
      return;
    }
    this._commit(this._thinStroke(pts, this._pendingPane));
  }

  private _thinStroke(pts: DrawingPoint[], paneIndex: number): DrawingPoint[] {
    const px: ScreenPoint[] = [];
    for (const p of pts) {
      const at = this._toPixel(p, paneIndex);
      if (at === null) return pts;
      px.push(at);
    }
    const kept = rdpSimplify(px, STROKE_EPSILON_PX);
    // Kept points come back at their exact input coordinates, in order, so
    // walking the input once pairs each with the sample it came from.
    const out: DrawingPoint[] = [];
    let j = 0;
    for (const k of kept) {
      while (j < px.length && (px[j].x !== k.x || px[j].y !== k.y)) j++;
      if (j >= px.length) return pts;   // cannot happen; keep everything rather than lose a sample
      out.push(pts[j]);
      j++;
    }
    return out;
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

  /**
   * Abandon whatever is being placed: the anchors so far are dropped and,
   * unless the controller stays in drawing mode, the tool is disarmed too, so
   * one Escape returns the chart to the cursor the way a finished shape
   * would. With nothing pending, an armed tool is simply disarmed. Returns
   * whether anything changed, so a host can let the key fall through when it
   * did nothing.
   */
  public cancel(): boolean {
    if (this.cancelDrag()) return true;
    if (this._tool === null) return false;
    const hadPending = this._pending.length > 0;
    this._pending = [];
    if (!hadPending || !this._opts.stayInDrawingMode) {
      this._tool = null;
      this._toolSpace = 'data';
      this._setPlacementMode(false);
      this._syncPreview();
      this._syncSnapRing();
      this._chart.emit('draw:tool', { tool: null });
      return true;
    }
    this._syncPreview();
    return true;
  }

  /**
   * Remove the last anchor placed on a variable-anchor tool (polyline, path)
   * still being drawn: the Backspace of placement. A fixed-anchor tool has
   * nothing to pop, since its anchors commit the moment the last one lands,
   * and a freehand stroke is one gesture rather than a list. Returns whether
   * an anchor went.
   */
  public popAnchor(): boolean {
    if (this._tool === null || this._pending.length === 0) return false;
    const tool = getDrawingTool(this._tool);
    if (tool.points !== 0 || tool.freehand === true) return false;
    this._pending.pop();
    this._syncPreview();
    return true;
  }

  private _onClick(p: ClickPayload): void {
    this._notePointer(p);
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
      this._shift = shiftOf(p);
      this._placePoint(this._aimPoint({ time: p.time, price: p.price }, p.paneIndex), p.paneIndex);
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

  /**
   * Where a click at `point` actually lands for the armed tool: on the 45
   * degree lock while Shift holds the free end of a line, else on the magnet
   * when it pulls, else where it was. The lock wins over the magnet because a
   * snapped price would bend the exact angle the lock exists to give.
   */
  private _aimPoint(point: DrawingPoint, paneIndex: number): DrawingPoint {
    const locked = this._lockedPoint(point, paneIndex);
    if (locked !== null) return locked;
    return this._snapPoint(point, paneIndex) ?? point;
  }

  /**
   * The free end of a two-anchor line under angle lock, or null when the lock
   * does not apply: no Shift, a tool without the flag, no anchor yet to
   * measure from, or a host that cannot map pixels (the lock is a screen
   * angle, so there is nothing to lock to in data space).
   */
  private _lockedPoint(point: DrawingPoint, paneIndex: number): DrawingPoint | null {
    if (!this._shift || this._tool === null || this._pending.length !== 1) return null;
    if (getDrawingTool(this._tool).angleLock !== true || paneIndex !== this._pendingPane) return null;
    return this._lockAngle(this._pending[0], point, paneIndex);
  }

  /**
   * The nearest O/H/L/C of the hovered bar, at that bar's time, when the
   * magnet pulls; null when it does not. `strong` always pulls; `weak` only
   * within a few pixels, measured on screen so the pull is the same reach at
   * every zoom. Price panes only: an indicator pane's values are not prices.
   */
  private _snapPoint(point: DrawingPoint, paneIndex: number): DrawingPoint | null {
    const mode = this._opts.magnet;
    // A drawing pinned to the screen lands where it is clicked: a bar's price
    // is no reference for something that will not follow the bars.
    if (mode === 'off' || paneIndex !== this._pricePane() || this._toolSpace === 'viewport') return null;
    const bar = this._lastBar;
    if (bar === null) return null;
    const values = [bar.open, bar.high, bar.low, bar.close];
    if (mode === 'strong') {
      let best = values[0];
      let bestD = Infinity;
      for (const v of values) {
        const d = Math.abs(v - point.price);
        if (d < bestD) { bestD = d; best = v; }
      }
      return { time: bar.time, price: best };
    }
    // Weak: the nearest value by screen distance, and only when it is close.
    // Without a pixel mapping there is no "close", so nothing pulls.
    const toY = this._chart.priceToCoordinate;
    if (toY === undefined) return null;
    const y = toY.call(this._chart, point.price, paneIndex);
    if (y === null || !Number.isFinite(y)) return null;
    let best: number | null = null;
    let bestD = WEAK_MAGNET_PX;
    for (const v of values) {
      const vy = toY.call(this._chart, v, paneIndex);
      if (vy === null || !Number.isFinite(vy)) continue;
      const d = Math.abs(vy - y);
      if (d <= bestD) { bestD = d; best = v; }
    }
    return best === null ? null : { time: bar.time, price: best };
  }

  private _onDrag(p: DragPayload): void {
    if (!p.id.startsWith('draw:')) return;
    const [rawId, handleStr] = p.id.slice('draw:'.length).split('#');
    const d = this.get(rawId);
    if (d === undefined || d.locked === true || pinned(d) || !this._selectable(rawId)) return;
    const handle = handleStr === undefined ? null : Number(handleStr);

    this._notePointer(p);
    this._shift = shiftOf(p);
    if (this._dragStart === null || this._dragStart.id !== rawId || this._dragStart.handle !== handle) {
      // Grabbing the body of an unselected shape selects it first, on its own:
      // the selection is what moves, and a drag that moved something other than
      // what it grabbed would be a surprise.
      if (handle === null && !this._selection.includes(rawId)) this.select(rawId);
      const moving = handle === null
        ? this._targets(this._selection).filter((m) => m.locked !== true && !pinned(m))
        : [d];
      // Snapshot once per gesture so undo restores the pre-drag position, not
      // an intermediate frame.
      const undo = this._undo.slice();
      const redo = this._redo.slice();
      this._pushUndo();
      this._dragStart = {
        id: rawId, handle,
        undo, redo,
        from: { time: p.fromTime ?? p.time, price: p.fromPrice ?? p.price },
        origin: this._dragOrigin(p),
        items: moving.map((m) => ({
          id: m.id, paneIndex: m.paneIndex, points: m.points.map((q) => ({ ...q })),
          ...(m.space === 'viewport' ? { viewportPoints: (m.viewportPoints ?? []).map((q) => ({ ...q })) } : {}),
        })),
      };
      // Anything under the series rides on the top layer for the gesture, so
      // the frames that follow repaint the overlay alone. Lifting re-lists the
      // bottom layer once, which is the one series repaint a lifted drag
      // costs; a drag with nothing to lift never touches it.
      let lifted = false;
      for (const m of moving) {
        if (!this._onTop(m)) { this._lifted.add(m.id); lifted = true; }
      }
      this._moveDrag(p, d, handle);
      if (lifted) this._sync();
      else this._syncDrag();
      this._emitDragPreview();
      return;
    }
    this._moveDrag(p, d, handle);
    this._syncDrag();
    this._emitDragPreview();
  }

  private _emitDragPreview(): void {
    const drawings = this._dragStart?.items.map(item => this.get(item.id)).filter((d): d is Drawing => d !== undefined) ?? [];
    this._chart.emit('draw:preview', { drawings: drawings.map(cloneDrawing) });
  }

  /** Roll back an interrupted drag and leave the pre-gesture undo/redo stacks intact. */
  public cancelDrag(): boolean {
    const start = this._dragStart;
    if (start === null) return false;
    this._dragStart = null;
    for (const item of start.items) {
      const drawing = this.get(item.id);
      if (drawing !== undefined) this._restoreAnchors(drawing, item);
    }
    this._undo = start.undo;
    this._redo = start.redo;
    this._pendingHistory = null;
    this._lifted.clear();
    if (this._chart.isDestroyed !== true) this._sync();
    this._chart.emit('draw:preview-clear', { ids: start.items.map(item => item.id) });
    return true;
  }

  /** Apply one drag frame to the model, from the gesture's snapshot. */
  private _moveDrag(p: DragPayload, d: Drawing, handle: number | null): void {
    const start = this._dragStart as NonNullable<typeof this._dragStart>;
    if (handle === null) {
      // Whole shape: translate every anchor of every selected shape by the
      // cursor delta. A shape on another pane cannot take the price delta (its
      // scale is a different quantity), so it takes the same screen distance.
      const dt = p.time - start.from.time;
      const dp = p.price - start.from.price;
      const dy = this._pixelDelta(start.from.price, p.price, p.paneIndex);
      // A pinned shape takes the pointer's travel on screen, as a fraction of
      // its own pane, so it moves with the hand whatever the scales say.
      const at = this._gesturePlot(p, p.paneIndex);
      const travel = at === null || start.origin === null ? null : { x: at.x - start.origin.x, y: at.y - start.origin.y };
      for (const item of start.items) {
        const m = this.get(item.id);
        if (m === undefined) continue;
        if (item.viewportPoints !== undefined) {
          const frame = this._plotFrame(item.paneIndex);
          if (frame !== null && travel !== null) m.viewportPoints = this._shiftPinned(m, item.viewportPoints, travel.x, travel.y, frame);
          continue;
        }
        const samePane = item.paneIndex === p.paneIndex;
        m.points = item.points.map((q) => ({
          ...q,
          time: q.time + dt,
          price: samePane ? q.price + dp : this._offsetPrice(q.price, item.paneIndex, dy),
        }));
      }
    } else if (d.space === 'viewport') {
      // A handle lands under the pointer, held on the plot, and then the box
      // is kept inside it: a note's one handle is its corner, and the rest of
      // the note has to stay where it can be seen and grabbed again too.
      const anchors = start.items[0].viewportPoints ?? [];
      const at = this._gesturePlot(p, d.paneIndex);
      const frame = this._plotFrame(d.paneIndex);
      if (handle >= 0 && handle < anchors.length && at !== null && frame !== null) {
        const { width, height } = frame;
        const placed = placeViewportAnchors(d, anchors, width, height);
        placed[handle] = { x: within(at.x, width), y: within(at.y, height) };
        // Where the box reaches an edge before the handle does (a label above
        // a box), the handle stops short instead of pushing the other corners
        // away from the edge it was dragged to.
        placed[handle] = placeViewportAnchors(d, placed.map((q) => ({ x: q.x / width, y: q.y / height })), width, height)[handle];
        d.viewportPoints = this._pinPlot(d, placed, frame);
      }
    } else if (handle >= 0 && handle < d.points.length) {
      const item = start.items[0];
      let target: DrawingPoint = { time: p.time, price: p.price };
      // Shift on the handle of a two-anchor line locks it to the 45 degree
      // step about the other anchor, the same way placement does.
      if (this._shift && item.points.length === 2 && hasDrawingTool(d.tool)
        && getDrawingTool(d.tool).angleLock === true) {
        target = this._lockAngle(item.points[1 - handle], target, d.paneIndex) ?? target;
      }
      const moved = item.points.map((q, i) => (i === handle ? { ...q, ...target } : { ...q }));
      // A tool with a constraint reads the whole set after the one anchor
      // moved, from the gesture's snapshot every frame: constraining the
      // already-constrained previous frame would let a flip feed on itself.
      const tool = hasDrawingTool(d.tool) ? getDrawingTool(d.tool) : undefined;
      d.points = tool?.constrain === undefined ? moved : tool.constrain(moved, handle);
    }
  }

  /** How far down the screen `to` is from `from` on one pane, in media px. */
  private _pixelDelta(from: number, to: number, paneIndex: number): number {
    const toY = this._chart.priceToCoordinate;
    if (toY === undefined) return 0;
    const y0 = toY.call(this._chart, from, paneIndex);
    const y1 = toY.call(this._chart, to, paneIndex);
    return y0 === null || y1 === null || !Number.isFinite(y0) || !Number.isFinite(y1) ? 0 : y1 - y0;
  }

  /** An anchor in container media px, or null on a host without the mapping. */
  private _toPixel(p: DrawingPoint, paneIndex: number): ScreenPoint | null {
    const toX = this._chart.timeToCoordinate;
    const toY = this._chart.priceToCoordinate;
    if (toX === undefined || toY === undefined) return null;
    const x = toX.call(this._chart, p.time);
    const y = toY.call(this._chart, p.price, paneIndex);
    return y === null || !Number.isFinite(x) || !Number.isFinite(y) ? null : { x, y };
  }

  /** The inverse of `_toPixel`. */
  private _fromPixel(at: ScreenPoint, paneIndex: number): DrawingPoint | null {
    const toTime = this._chart.coordinateToTime;
    const toPrice = this._chart.coordinateToPrice;
    if (toTime === undefined || toPrice === undefined) return null;
    const time = toTime.call(this._chart, at.x);
    const price = toPrice.call(this._chart, at.y, paneIndex);
    return price === null || !Number.isFinite(time) || !Number.isFinite(price) ? null : { time, price };
  }

  // ── viewport space ──────────────────────────────────────────────────────
  //
  // A viewport anchor is a fraction of its pane's plot. The layer scales it
  // by the plot size in its render context; everything here scales it by the
  // plot the chart reports (`plotRect`), the same rectangle the chart hands
  // that render context, and reads y through the pane's own readout scale,
  // the scale a gesture's price was read from. Plot-relative px therefore
  // agree with what the layer painted.

  /**
   * The drawing's anchors in container media px, the space `timeToCoordinate`
   * and `priceToCoordinate` answer in, whichever space it is anchored in. What
   * a host places an overlay by (an inline editor, a popover). Null for an
   * unknown id, or when the drawing's pane has no place on screen (folded to
   * a strip, or hidden behind a maximized pane).
   */
  public screenPoints(id: string): ScreenPoint[] | null {
    const d = this.get(id);
    if (d === undefined) return null;
    if (d.space !== 'viewport') {
      const out: ScreenPoint[] = [];
      for (const p of d.points) {
        const at = this._toPixel(p, d.paneIndex);
        if (at === null) return null;
        out.push(at);
      }
      return out;
    }
    const frame = this._plotFrame(d.paneIndex);
    if (frame === null) return null;
    return placeViewportAnchors(d, d.viewportPoints ?? [], frame.width, frame.height)
      .map((p) => ({ x: frame.left + p.x, y: frame.top + p.y }));
  }

  /** A pane's price projection, when the host exposes one. */
  private _pane(paneIndex: number): PaneProjection | null {
    const own = this._chart.panes?.()[paneIndex] as PaneProjection | undefined;
    return typeof own?.priceToY === 'function' && typeof own.yToPrice === 'function' ? own : null;
  }

  /**
   * Where a pane's plot is and how big, or null when it has none on screen
   * (folded to a strip, or hidden behind a maximized pane): a fraction of
   * either would be a fraction of nothing. It needs a pane projection too,
   * since every gesture reads its y back through one.
   */
  private _plotFrame(paneIndex: number): PlotRect | null {
    const rect = this._pane(paneIndex) === null ? null : this._chart.plotRect?.(paneIndex) ?? null;
    return rect !== null && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  /**
   * A gesture's position on its pane's plot, in media px. y reads the price
   * back through the pane's readout scale, the exact inverse of how the chart
   * read it; x is the pointer's container x less the plot's left edge, or,
   * for a payload without one, the time through the time axis.
   */
  private _gesturePlot(p: { time: number; price: number; point?: { x: number } | null }, paneIndex: number): ScreenPoint | null {
    const pane = this._pane(paneIndex);
    const ts = this._chart.timeScale;
    if (pane === null || !Number.isFinite(p.price)) return null;
    const x = p.point !== undefined && p.point !== null ? p.point.x - (this._plotFrame(paneIndex)?.left ?? Number.NaN)
      : ts === undefined ? Number.NaN : ts.indexToX(this._chart.dataLayer.timeToIndexFloat(p.time));
    const y = pane.priceToY(p.price);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  /**
   * Where a drag was pressed, on its pane's plot. Read from the press's time
   * and price when the chart reports them, so the first move is measured from
   * the press and not from itself; a chart with fewer than two bars has no
   * time axis to read a position back from, so it measures from the first move.
   */
  private _dragOrigin(p: DragPayload): ScreenPoint | null {
    if (p.fromTime !== undefined && p.fromPrice !== undefined && this._chart.dataLayer.length >= 2) {
      return this._gesturePlot({ time: p.fromTime, price: p.fromPrice }, p.paneIndex);
    }
    return this._gesturePlot(p, p.paneIndex);
  }

  /**
   * Data anchors as fractions of their pane's plot at the view on screen, or
   * null when it has none. What is on screen stays where it is; a drawing part
   * way or wholly off the plot comes onto it, since once pinned no pan could
   * bring it back. One that fits moves in whole. One wider or taller than the
   * plot is cut to it on that axis instead, so every handle of a pinned box
   * is on screen to be grabbed.
   */
  private _toViewport(points: readonly DrawingPoint[], paneIndex: number, d: Drawing): ViewportPoint[] | null {
    const frame = this._plotFrame(paneIndex);
    const pane = this._pane(paneIndex);
    const ts = this._chart.timeScale;
    if (frame === null || pane === null || ts === undefined || points.length === 0) return null;
    const px: ScreenPoint[] = [];
    for (const p of points) {
      const x = ts.indexToX(this._chart.dataLayer.timeToIndexFloat(p.time));
      const y = pane.priceToY(p.price);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      px.push({ x, y });
    }
    const own = boundsOf(px);
    const box = (hasDrawingTool(d.tool) ? getDrawingTool(d.tool).bounds?.(px, d) : undefined) ?? own;
    const cutX = cutInto(box.x0, box.x1, own.x0, own.x1, frame.width);
    const cutY = cutInto(box.y0, box.y1, own.y0, own.y1, frame.height);
    return this._pinPlot(d, px.map((p) => ({ x: cutX(p.x), y: cutY(p.y) })), frame);
  }

  /**
   * The inverse of `_toViewport`: fractions back to time and price at the view
   * on screen, from where the drawing is painted, so it does not move.
   */
  private _fromViewport(points: readonly ViewportPoint[], paneIndex: number, d: Drawing): DrawingPoint[] | null {
    const frame = this._plotFrame(paneIndex);
    const pane = this._pane(paneIndex);
    const ts = this._chart.timeScale;
    if (frame === null || pane === null || ts === undefined || points.length === 0) return null;
    const out: DrawingPoint[] = [];
    for (const p of placeViewportAnchors(d, points, frame.width, frame.height)) {
      const time = this._chart.dataLayer.indexToTimeFloat(ts.xToIndex(p.x));
      const price = pane.yToPrice(p.y);
      if (!Number.isFinite(time) || !Number.isFinite(price)) return null;
      out.push({ time, price });
    }
    return out;
  }

  /**
   * Anchors in plot px as the fractions a pinned drawing stores, moved first
   * so its box lies inside the plot. Every gesture ends here, so what is
   * stored is what is painted, and no drag can leave the box where the
   * pointer cannot reach it.
   */
  private _pinPlot(d: Drawing, pts: readonly ScreenPoint[], frame: PlotRect): ViewportPoint[] {
    const fraction = (p: ScreenPoint): ViewportPoint => ({ x: p.x / frame.width, y: p.y / frame.height });
    return placeViewportAnchors(d, pts.map(fraction), frame.width, frame.height).map(fraction);
  }

  /**
   * Pinned anchors moved by a screen distance in media px, from where the
   * drawing is painted rather than from what it stores: a note the layer
   * holds in from a stored place off the plot (a host's value, a larger
   * chart) moves at once, with no dead travel before it starts.
   */
  private _shiftPinned(d: Drawing, points: readonly ViewportPoint[], dxPx: number, dyPx: number, frame: PlotRect): ViewportPoint[] {
    const at = placeViewportAnchors(d, points, frame.width, frame.height);
    return this._pinPlot(d, at.map((p) => ({ x: p.x + dxPx, y: p.y + dyPx })), frame);
  }

  /** Put a drawing's anchors back as a gesture found them. */
  private _restoreAnchors(d: Drawing, item: { points: readonly DrawingPoint[]; viewportPoints?: readonly ViewportPoint[] }): void {
    d.points = item.points.map((point) => ({ ...point }));
    if (item.viewportPoints !== undefined) d.viewportPoints = item.viewportPoints.map((point) => ({ ...point }));
  }

  /**
   * `free` projected onto the nearest 45 degree ray from `anchor`, all in
   * screen space: the angle the eye reads is the one on the canvas, and a log
   * scale or a tall pane would make a data-space angle anything but. The
   * projection rather than a rotation, so a level line still ends under the
   * pointer's x and a vertical one under its y; only the stray axis is
   * dropped. Null when the host cannot map pixels, or the two coincide.
   */
  private _lockAngle(anchor: DrawingPoint, free: DrawingPoint, paneIndex: number): DrawingPoint | null {
    const a = this._toPixel(anchor, paneIndex);
    const b = this._toPixel(free, paneIndex);
    if (a === null || b === null) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) return null;
    const angle = Math.round(Math.atan2(dy, dx) / ANGLE_STEP) * ANGLE_STEP;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const along = dx * ux + dy * uy;
    return this._fromPixel({ x: a.x + along * ux, y: a.y + along * uy }, paneIndex);
  }

  private _onDragEnd(): void {
    if (this._dragStart === null) return;
    const moved = this._dragStart.items.map((i) => this.get(i.id)).filter((m): m is Drawing => m !== undefined);
    this._dragStart = null;
    this._chart.emit('draw:preview-clear', { ids: moved.map(d => d.id) });
    // Whatever was lifted for the gesture goes back under the series.
    if (this._lifted.size > 0) {
      this._lifted.clear();
      this._sync();
    }
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
      pair = { bottom: new DrawingLayer('bottom'), top: new DrawingLayer('top'), series: new Map() };
      this._chart.addPrimitive(pair.bottom, paneIndex);
      this._chart.addPrimitive(pair.top, paneIndex);
      pair.top.setBelow(pair.bottom);
      pair.bottom.setSelected(this._selection);
      pair.top.setSelected(this._selection);
      this._layers.set(paneIndex, pair);
    }
    return pair;
  }

  /**
   * Whether a drawing paints on the top layer: over the series and outside
   * the series band, or lifted for a drag.
   */
  private _onTop(d: Drawing, entries = this._entries(d.paneIndex)): boolean {
    return this._lifted.has(d.id) || this._slotOf(d, entries) === 'above';
  }

  /** Push the current list into each pane's layers and into the chart state. */
  private _sync(): void {
    this._groups = migrateGroups(this._groups, this._drawings);
    this._syncLayers();
    // A hover or a selection on a drawing that has just gone, or has just
    // been made unselectable, would otherwise outlive it until the pointer
    // next moves.
    this._pruneSelection();
    if (this._hovered !== null && !this._selectable(this._hovered)) this._setHovered(null);
    this._chart.setDrawingState(this.toJSON());
  }

  /** Each drawing placed in the series band, with the slot it resolves to now. */
  private _slotSignature(): string {
    const stacks = new Map<number, readonly string[]>();
    let key = '';
    for (const d of this._drawings) {
      if (d.stackAbove === undefined) continue;
      let entries = stacks.get(d.paneIndex);
      if (entries === undefined) stacks.set(d.paneIndex, entries = this._entries(d.paneIndex));
      key += d.id + '\u0000' + this._slotOf(d, entries) + '\u0000';
    }
    return key;
  }

  /** List every drawing on the layer of the slot it paints in. */
  private _syncLayers(): void {
    this._slotKey = this._slotSignature();
    const byPane = new Map<number, { below: Drawing[]; above: Drawing[]; series: Map<string, Drawing[]> }>();
    const stacks = new Map<number, readonly string[]>();
    for (const committed of this._drawings) {
      const d = this._linkedPreviews.get(committed.id) ?? committed;
      let lists = byPane.get(d.paneIndex);
      if (lists === undefined) {
        lists = { below: [], above: [], series: new Map() };
        byPane.set(d.paneIndex, lists);
      }
      let entries = stacks.get(d.paneIndex);
      if (entries === undefined) stacks.set(d.paneIndex, entries = this._entries(d.paneIndex));
      const slot = this._lifted.has(d.id) ? 'above' : this._slotOf(d, entries);
      if (slot === 'above') lists.above.push(d);
      else if (slot === 'below') lists.below.push(d);
      else {
        const list = lists.series.get(slot.slice('entry:'.length));
        if (list) list.push(d); else lists.series.set(slot.slice('entry:'.length), [d]);
      }
    }
    for (const [pane, lists] of byPane) {
      const l = this._layerFor(pane);
      l.bottom.setDrawings(lists.below);
      l.top.setDrawings(lists.above);
      this._syncSeriesLayers(pane, l, lists.series, stacks.get(pane) ?? []);
    }
    // Panes that lost their last drawing must be cleared, not left stale.
    for (const [pane, l] of this._layers) {
      if (!byPane.has(pane)) {
        l.bottom.setDrawings([]);
        l.top.setDrawings([]);
        this._syncSeriesLayers(pane, l, new Map(), []);
      }
      for (const layer of [l.bottom, l.top, ...l.series.values()]) layer.setSelected(this._selection);
    }
  }

  /**
   * One series-band layer per entry a drawing on this pane is placed above,
   * made on first use and dropped when its last drawing leaves, each painted
   * by the chart right after its entry. The top layer answers for them,
   * front to back, then for the layer under the series.
   */
  private _syncSeriesLayers(pane: number, l: PaneLayers, groups: ReadonlyMap<string, Drawing[]>, entries: readonly string[]): void {
    for (const [entry, layer] of l.series) {
      if (groups.has(entry)) continue;
      l.series.delete(entry);
      this._chart.removePrimitive(layer);
    }
    for (const [entry, list] of groups) {
      let layer = l.series.get(entry);
      if (layer === undefined) {
        layer = new DrawingLayer('series');
        this._chart.addPrimitive(layer, pane);
        this._chart.setPrimitiveStackAbove?.(layer, entry);
        layer.setPointerType(this._pointerKind);
        layer.setHovered(this._hovered);
        l.series.set(entry, layer);
      }
      layer.setDrawings(list);
    }
    l.top.setBelow([...entries].reverse().flatMap(entry => l.series.get(entry) ?? []).concat(l.bottom));
  }

  /**
   * The per-frame half of a drag: only the top layers of the panes the
   * gesture touches are re-listed, so the repaint stays on the cursor tier.
   * Everything moving is on a top layer by then (anything under the series
   * was lifted when the gesture began), and the bottom layers have not
   * changed since, so re-listing them would cost a series repaint for
   * nothing.
   */
  private _syncDrag(): void {
    const start = this._dragStart;
    if (start === null) return;
    const panes = new Set(start.items.map((i) => i.paneIndex));
    for (const pane of panes) {
      const l = this._layers.get(pane);
      if (l === undefined) continue;
      l.top.setDrawings(this._drawings.filter((d) => d.paneIndex === pane && this._onTop(d)));
    }
    this._chart.setDrawingState(this.toJSON());
  }

  /**
   * Mirror the in-progress anchors (plus the cursor) into the preview slot.
   * The cursor point goes through the same aim as a click would, so the
   * preview shows the locked angle or the snapped anchor before it lands.
   */
  private _syncPreview(): void {
    for (const l of this._layers.values()) l.top.setPreview(null);
    if (this._tool === null || this._pending.length === 0) return;
    const cursor = this._lastCursor;
    const points = cursor === null || cursor.paneIndex !== this._pendingPane
      ? this._pending
      : [...this._pending, this._aimPoint({ time: cursor.time, price: cursor.price }, cursor.paneIndex)];
    this._layerFor(this._pendingPane).top.setPreview({
      id: '__preview', tool: this._tool, points, style: this._opts.defaultStyle,
      paneIndex: this._pendingPane, zIndex: 0,
    });
  }

  /**
   * Show where the magnet will land the next click, or nothing. A ring only
   * while a click would place an anchor: a tool armed, not a brush (which
   * inks where the pointer is), and the pull actually applying at the cursor.
   * Angle lock bypasses the magnet, so it hides the ring too.
   */
  private _syncSnapRing(): void {
    const cursor = this._lastCursor;
    let ring: DrawingPoint | null = null;
    let pane = cursor?.paneIndex ?? this._pendingPane;
    if (cursor !== null && this._tool !== null && !this._isFreehand()
      && this._lockedPoint({ time: cursor.time, price: cursor.price }, cursor.paneIndex) === null) {
      ring = this._snapPoint({ time: cursor.time, price: cursor.price }, cursor.paneIndex);
      pane = cursor.paneIndex;
    }
    for (const [index, l] of this._layers) l.top.setSnapPoint(index === pane ? ring : null);
    // The ring's pane may not have layers yet (no drawing there so far); make
    // them only when there is a ring to paint, since a pair costs a pane repaint.
    if (ring !== null && !this._layers.has(pane)) this._layerFor(pane).top.setSnapPoint(ring);
  }

  /**
   * Record a step that is not a drawing edit, a study anchor's drag, in the
   * same history, so Undo walks it and the drawings in the order they were
   * made. Like any new edit it clears the redo branch.
   */
  private _recordStep(step: InputAnchorStep): void {
    this._onDragEnd();
    const text = this._historyText();
    this._undo.push({ before: text, after: text, external: step });
    if (this._undo.length > this._opts.historyLimit) this._undo.shift();
    this._redo = [];
    this._external(true, 'update');
  }

  /**
   * Announce a move of the history that changed no drawing, with no ids, so
   * a host's Undo and Redo controls, which refresh on `drawing:change`,
   * follow it. Passes `applied` through.
   */
  private _external(applied: boolean, kind: DrawingChangeKind): boolean {
    if (applied) this._chart.emit('drawing:change', { ids: [], kind });
    return applied;
  }

  private _pushUndo(): void {
    this._onDragEnd();
    const before = this._historyText();
    this._pendingHistory = { before, after: before };
    this._undo.push(this._pendingHistory);
    if (this._undo.length > this._opts.historyLimit) this._undo.shift();
    this._redo = []; // a new edit invalidates the redo branch
  }

  /**
   * Open an edit: recorded, or, for a change the history does not hold (a
   * host placing or moving a read-only drawing), not recorded and leaving
   * both branches alone. Either way a drag in progress ends first.
   */
  private _begin(record: boolean): void {
    if (record) this._pushUndo();
    else this._onDragEnd();
  }

  /**
   * What the host does (a policy, a forced call) is its own act and never
   * history's to reverse: `edit` makes the same change to every recorded
   * snapshot, as if it had always been so, and a step left with nothing to do
   * is dropped, so `canUndo` and `canRedo` match what a press would do. The
   * step still being recorded stays whatever it holds so far. `edit` may
   * share live objects, since each snapshot is serialised at once. The
   * host's patches still held back go in first, being older. Both snapshots
   * of every step are parsed and written, which is why a forced move of a
   * read-only drawing is held back rather than paying for this.
   */
  private _rebase(edit?: (document: DrawingsDocument) => void): void {
    const rewrite = (text: string): string => {
      const document = JSON.parse(text) as DrawingsDocument;
      for (const d of document.drawings) {
        const { points, ...rest } = this._hostPatches.get(d.id) ?? {};
        this._applyPatch(d, rest);
        if (points) d.points = points;
      }
      edit?.(document);
      return JSON.stringify(document);
    };
    const keep = (entry: DrawingHistoryEntry): boolean => {
      entry.before = rewrite(entry.before);
      entry.after = rewrite(entry.after);
      // A step outside the drawings keeps whatever the host did to them.
      return entry === this._pendingHistory || entry.external !== undefined || this._applyHistory(entry.before, entry.after);
    };
    // A drag holds the branches as they were when it began, for a cancel to
    // put back. They share their steps with the live ones, and taking an
    // edit twice changes nothing, since a snapshot is read through the
    // migration.
    const drag = this._dragStart;
    if (drag) {
      drag.undo = drag.undo.filter(keep);
      drag.redo = drag.redo.filter(keep);
    }
    this._undo = this._undo.filter(keep);
    this._redo = this._redo.filter(keep);
    this._hostPatches.clear();
  }
}
