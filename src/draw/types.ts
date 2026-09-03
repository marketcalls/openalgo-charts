/**
 * Drawing model (ARCHITECTURE.md section 8). A drawing is **plain data**: anchors
 * in `{ time, price }`, a style bag, a tool id. It serialises straight into
 * `ChartState.drawings` with no custom encoder, and a tool is a registry entry
 * exactly like a chart type or an indicator.
 *
 * Anchors are stored in *data* space, never pixels: the chart's time axis is
 * gapless (section 5.3), so a pixel anchor would slide the moment a weekend
 * collapsed or the user zoomed. `DataLayer.timeToIndexFloat` maps them back,
 * which also gives anchors between bars and to the right of the last one,
 * where trend projections and forecasts live.
 *
 * Version 2 of the model split the text fields out of the style bag into
 * {@link DrawingText}, made `levels` a list of {@link FibLevel} rather than bare
 * ratios, and gave every drawing a `zIndex`. A 1.9.x document is upgraded by
 * `migrateDrawings` on the way in; nothing downstream sees the old shape.
 */
import type { PrimitiveRenderContext } from 'openalgo-charts';
import type { SettingsSchema } from './schema';

/** One anchor, in data space. */
export interface DrawingPoint {
  /** UTC seconds. May fall between bars, or past the last one. */
  time: number;
  price: number;
  /**
   * Pen pressure at this sample, 0..1, on a freehand stroke only. Absent means
   * the pointer events stand-in of 0.5, which is what a mouse reports and what
   * a stroke's width is calibrated to, so a mouse stroke stores nothing here.
   */
  pressure?: number;
}

/**
 * How new anchors snap to the bar under the cursor. `weak` snaps only when an
 * O/H/L/C sits within a few pixels of the pointer, so a click on empty space
 * lands where it was made; `strong` always takes the nearest of the four.
 */
export type MagnetMode = 'off' | 'weak' | 'strong';

/**
 * The text a drawing carries, and how it is set. The text tool *is* this box;
 * a shape (rectangle, channel, callout) carries one as its label.
 *
 * Kept apart from {@link DrawingStyle} because the two answer different
 * questions: style is how the outline is stroked, text is what the label says
 * and how it is typeset. A purple rectangle with white bold text is one shape
 * with two colours, and a settings panel wants them on different tabs.
 */
export interface DrawingText {
  /** Body text. `\n` starts a new line; see `wrap` for soft wrapping. */
  value: string;
  /** Falls back to `style.color`. */
  color?: string;
  /** Media px. Default 12. */
  fontSize?: number;
  /** CSS font stack. Defaults to the UI sans-serif stack. */
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  /** Horizontal alignment within the box. Default 'left'. */
  align?: 'left' | 'center' | 'right';
  /** Vertical placement within the box. Default 'top'. */
  valign?: 'top' | 'middle' | 'bottom';
  /** Soft-wrap at `wrapWidth` instead of running off the pane. */
  wrap?: boolean;
  /** Wrap width in media px. Default 220. */
  wrapWidth?: number;
  /** Draw a filled plate behind the text. */
  background?: boolean;
  backgroundColor?: string;
  /** Plate opacity, 0..1. Default 1: a text background is usually opaque. */
  backgroundOpacity?: number;
  /** Stroke a border around the plate. */
  border?: boolean;
  borderColor?: string;
  /**
   * Where a shape's label sits relative to the shape: `inside` the outline, or
   * `outside` just above it. Shapes only; the text tool is its own box.
   */
  position?: 'inside' | 'outside';
}

/** One level of a Fibonacci-family tool. */
export interface FibLevel {
  /** The level as a fraction of the anchor span (0.618, 1.618, ...). */
  ratio: number;
  /** Stroke colour. Falls back to the conventional colour for the ratio. */
  color?: string;
  /** `false` hides the level without forgetting it. Default true. */
  enabled?: boolean;
  /** Printed instead of the ratio when set. */
  label?: string;
}

export interface DrawingStyle {
  color?: string;
  lineWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  /** Fill the shape's interior (rectangle, ellipse, channel, position boxes). */
  fill?: boolean;
  fillColor?: string;
  /** 0..1. Defaults to 0.12. */
  fillOpacity?: number;
  /** Extend the line past its anchors. */
  extendLeft?: boolean;
  extendRight?: boolean;
  /** Draw level / price / ratio labels where the tool has them. */
  showLabels?: boolean;
  /** Fibonacci-family levels. Defaults per tool. */
  levels?: FibLevel[];
  /** Position tools: capital base and risk per trade, for the size readout. */
  accountSize?: number;
  risk?: number;
  /** Line tools: print the bar count, price change and angle at the midpoint. */
  showStats?: boolean;
  /** Brush: let pen pressure drive the stroke width. */
  pressure?: boolean;
}

export interface Drawing {
  id: string;
  /** Registered tool id. */
  tool: string;
  points: DrawingPoint[];
  style: DrawingStyle;
  /** The label (or, for the text tool, the whole content). */
  text?: DrawingText;
  /**
   * Per-tool extras that do not belong on every drawing (a table's cells, a
   * callout's tail side). Keeps the base shape closed while a tool stays free
   * to carry what it needs. Must be JSON-safe: it is persisted verbatim.
   */
  props?: Record<string, unknown>;
  paneIndex: number;
  /** Locked drawings render but cannot be selected or dragged. */
  locked?: boolean;
  /** Default true. */
  visible?: boolean;
  /**
   * Paint order. Below zero paints under the series, at or above zero paints
   * over it. Ties break by array order, so two drawings at 0 paint in the
   * order they sit in the list.
   */
  zIndex: number;
  /** Epoch ms, set by the controller when the drawing is added. */
  createdAt?: number;
}

/**
 * What `DrawingController.add` accepts: a drawing minus the fields the
 * controller fills in. `zIndex` defaults to 0, `createdAt` to now, and an id is
 * minted unless one is supplied.
 */
export type DrawingInput = Omit<Drawing, 'id' | 'zIndex' | 'createdAt'> & {
  id?: string;
  zIndex?: number;
  createdAt?: number;
};

/** The fields `DrawingController.update` and `updateMany` can change. */
export type DrawingPatch = Partial<Pick<Drawing, 'points' | 'style' | 'text' | 'props' | 'locked' | 'visible' | 'zIndex'>>;

/** The persisted shape's version; bumped when {@link Drawing} changes. */
export const DRAWING_STATE_VERSION = 2;

/**
 * What `toJSON` returns and `ChartState.drawings` carries. Versioned so a 1.9.x
 * save (a bare `Drawing[]`) is recognisable and upgraded rather than misread.
 */
export interface DrawingsDocument {
  version: 2;
  drawings: Drawing[];
}

/** A point mapped to the pane, in media px. */
export interface ScreenPoint {
  x: number;
  y: number;
}

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  rc: PrimitiveRenderContext;
  /** Anchors in **device** px, ready to stroke. */
  pts: ScreenPoint[];
  drawing: Drawing;
  style: Required<Pick<DrawingStyle, 'color' | 'lineWidth'>> & DrawingStyle;
  selected: boolean;
  /** Format a price the way the pane's axis does. */
  formatPrice(price: number): string;
}

export interface HitContext {
  /** Anchors in **media** px, the same space as the incoming x/y. */
  pts: ScreenPoint[];
  drawing: Drawing;
  rc: PrimitiveRenderContext;
}

/** What {@link DrawingTool.expand} needs to size a default in chart units. */
export interface ExpandContext {
  /** Seconds between adjacent bars, so a default can span a sane bar count. */
  barSeconds: number;
  /**
   * Bars currently on screen. A default sized in fixed bars is a hairline when
   * zoomed out and fills the pane when zoomed in, so size against this instead.
   */
  visibleBars: number;
}

export interface DrawingTool {
  id: string;
  name: string;
  /**
   * Anchors the tool needs before it is complete. `0` means free-form: the
   * drawing finishes on double-click.
   */
  points: number;
  /**
   * Sample the cursor continuously while the pointer is held, and finish on
   * release: one press-drag-release gesture is one stroke. Brushes want this;
   * without it a `points: 0` tool collects a vertex per click, which is
   * polyline behaviour and never terminates on its own.
   */
  freehand?: boolean;
  /**
   * Hold Shift to snap the free end of a two-anchor tool to 45 degree steps
   * on screen, while placing and while dragging a handle. The line family
   * sets it; a tool whose second anchor is not the far end of a line (a
   * rectangle's opposite corner) leaves it off, since a locked diagonal is
   * not what Shift means there.
   */
  angleLock?: boolean;
  /**
   * Turn the anchors actually clicked into the full anchor set. Lets a tool drop
   * a complete, immediately editable default from fewer clicks: the position
   * tools place a 1:1 box off a single click, which the user then drags, rather
   * than demanding entry/target/stop be clicked in turn.
   *
   * The returned points become the drawing's anchors, so each one stays a
   * draggable handle.
   */
  expand?(clicked: readonly DrawingPoint[], ctx: ExpandContext): DrawingPoint[];
  /**
   * Keyboard shortcut that arms this tool, as `'Alt+T'` / `'Shift+Alt+F'`:
   * modifiers in `Ctrl`, `Alt`, `Shift` order, then a single key. Hosts render
   * it beside the tool's name in a palette and bind it with
   * `matchDrawingShortcut`; the library itself installs no listener, since only
   * the host knows whether the chart has focus or a dialog is open.
   */
  shortcut?: string;
  /** Merged under the caller's style when a drawing is created. */
  defaultStyle?: DrawingStyle;
  /**
   * Merged under the caller's text when a drawing is created. The text tool
   * uses it for its placeholder content and default size; a shape leaves it
   * unset so it carries no label until the user gives it one.
   */
  defaultText?: DrawingText;
  /**
   * The fields a settings panel offers for this tool. Every built-in declares
   * one; a custom tool without it gets the plain line fields.
   */
  settings?: SettingsSchema;
  draw(c: DrawContext): void;
  /**
   * Distance in media px from the cursor to the shape, or `null` for a miss.
   * Return `0` for "inside" so a filled region is grabbable anywhere.
   */
  distance(x: number, y: number, c: HitContext): number | null;
}
