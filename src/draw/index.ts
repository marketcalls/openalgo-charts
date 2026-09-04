/**
 * Drawing tier (opt-in: "openalgo-charts/draw").
 *
 * The built-in tools plus a headless controller. Importing this module
 * registers every built-in tool as a side effect. The named descriptor
 * re-exports below cover the most-customised subset; `BUILTIN_DRAWING_TOOLS`
 * is the full list and `registeredDrawingTools()` reads the live registry.
 *
 * ```ts
 * import { createChart } from 'openalgo-charts';
 * import { DrawingController } from 'openalgo-charts/draw';
 *
 * const chart = createChart(el);
 * chart.addSeries('candlestick').setData(bars);
 *
 * const draw = new DrawingController(chart, { magnet: true });
 * draw.setTool('trend-line');   // next two clicks place it
 * ```
 *
 * The controller ships **no UI**: no toolbar, no dialogs. It exposes the model
 * and the interactions; a host wires its own buttons (or the widget package)
 * to `setTool` / `undo` / `remove`, and its own `keydown` to
 * `keyToDrawingAction`.
 *
 * Tools register into the base bundle's registry through the package entry, not
 * a deep path, so `createChart` and this tier share one registry; see
 * rollup.config.js.
 */
import { registerBuiltinDrawingTools } from './tools';

export const DRAW_TIER = 'draw' as const;

registerBuiltinDrawingTools(); // side effect on tier import

export {
  registerDrawingTool,
  getDrawingTool,
  hasDrawingTool,
  registeredDrawingTools,
  matchDrawingShortcut,
  drawingShortcuts,
  registerBuiltinDrawingTools,
  BUILTIN_DRAWING_TOOLS,
  TREND_LINE, RAY, EXTENDED_LINE, ARROW,
  HORIZONTAL_LINE, HORIZONTAL_RAY, VERTICAL_LINE, CROSS_LINE,
  RECTANGLE, ELLIPSE, PARALLEL_CHANNEL,
  FIB_RETRACEMENT, FIB_EXTENSION,
  LONG_POSITION, SHORT_POSITION, MEASURE,
  TEXT, PATH,
  // Annotations: the marks whose job is a human sentence on the chart.
  NOTE, BALLOON, COMMENT, SIGNPOST, PRICE_NOTE, TABLE,
  ARROW_UP, ARROW_DOWN, ARROW_LEFT, ARROW_RIGHT,
  PRICE_LABEL, CALLOUT, FLAG_MARK,
  // The 2.0 additions: measurement, shape, freehand, fib and cycle families.
  FORECAST, PRICE_RANGE, DATE_RANGE,
  CIRCLE, TRIANGLE, POLYLINE, ARC, CURVE, ROTATED_RECTANGLE, DOUBLE_CURVE,
  HIGHLIGHTER, BRUSH,
  FIB_CHANNEL, FIB_TIME_ZONE, FIB_FAN, GANN_FAN, GANN_BOX,
  CYCLIC_LINES, TIME_CYCLES, SINE_LINE,
  // A registry lookup, so it lives with the registry rather than in schema.ts.
  drawingSettingsSchema,
} from './tools';

// Per-tool settings schema. Pure and DOM-free: a host renders its own dialog
// from the field list and writes the result back through
// `applyDrawingSettings`, which coerces form strings and drops anything the
// schema does not declare.
export {
  composeSettings, readDrawingSetting, readDrawingSettings, coerceSettingValue, applyDrawingSettings,
  LINE_FIELDS, FILL_FIELDS, EXTEND_FIELDS, LEVEL_FIELDS, TEXT_FIELDS, FONT_FIELDS, SHAPE_TEXT_FIELDS, PLATE_TEXT_FIELDS,
  COLOR_FIELD, LINE_WIDTH_FIELD, LINE_STYLE_FIELD, SHOW_LABELS_FIELD, TEXT_VALUE_FIELD,
  LINE_STYLE_OPTIONS, ALIGN_OPTIONS, VALIGN_OPTIONS, TEXT_POSITION_OPTIONS, FONT_OPTIONS,
  type FieldKind, type FieldGroup, type SettingsField, type SettingsSchema,
} from './schema';

// Level ladders shared by the fib and gann family, and the colour convention a
// host wants when it builds a level editor of its own.
export {
  levelColor, cycleColor, formatRatio, gannLabel, cloneLevels,
  LEVEL_NEUTRAL, CYCLE_PALETTE, DEFAULT_FIB, DEFAULT_FIB_FAN, DEFAULT_GANN_BOX, DEFAULT_GANN_FAN, DEFAULT_FIB_TIME_ZONE,
} from './levels';

// Glyphs. Path data for both grids lives in icons.ts; icon-svg.ts derives
// inline markup, a sprite and a CSS cursor from it, so every surface that
// shows a tool reads from one source.
export {
  DRAWING_TOOL_ICONS, drawingToolIcon, drawingToolIconIds,
  ICON_VIEWBOX, ICON_STROKE, ICON_ATTRS,
  CHROME_ICONS, CHROME_ICON_FILLED, chromeIcon, chromeIconIds,
  CHROME_ICON_VIEWBOX, CHROME_ICON_STROKE, CHROME_ICON_ATTRS,
  type IconAttrs,
} from './icons';
export {
  iconSvg, chromeIconSvg, iconSprite, iconUse, toolCursor, ICON_SYMBOL_PREFIX,
  type IconSvgOptions, type ToolCursorOptions,
} from './icon-svg';

export { DrawingLayer, sortByZIndex, type DrawingLayerOrder, type DrawingPointerKind } from './layer';
export {
  DrawingController,
  type DrawingControllerOptions,
  type DrawingChangeKind,
} from './controller';

// Keyboard editing. Pure: the host owns the listener and asks what a key means.
export {
  keyToDrawingAction,
  NUDGE_STEP_PX,
  NUDGE_STEP_SHIFT_PX,
  type DrawingKeyAction,
  type DrawingKeyEvent,
  type DrawingKeyContext,
} from './keys';

// Clipboard transfer. `DrawingControllerOptions.clipboard` is typed as
// `ClipboardPort` and `DrawingController.clipboard()` returns a
// `DrawingClipboard`, so both have to be nameable from the tier entry or a
// TypeScript host can use neither. The encode / decode / sanitize trio is
// exported for a host moving drawings over its own transport (a websocket, a
// saved template) with the same validation a paste gets.
export {
  DrawingClipboard,
  clearMemoryClipboard,
  systemClipboard,
  encodeClipboardPayload,
  decodeClipboardPayload,
  sanitizeDrawing,
  cloneDrawing,
  DRAWING_CLIPBOARD_KEY,
  DRAWING_CLIPBOARD_VERSION,
  type ClipboardPort,
  type DrawingClipboardOptions,
} from './clipboard';

// Persistence. `fromJSON` runs the migration itself; it is exported for a host
// that reads a saved layout for its own purposes (a template list, a preview)
// and wants the 2.0 shape without a controller.
export { migrateDrawings } from './migrate';
export { DRAWING_STATE_VERSION } from './types';
export type {
  Drawing,
  DrawingInput,
  DrawingPatch,
  DrawingPoint,
  DrawingStyle,
  DrawingText,
  DrawingsDocument,
  FibLevel,
  DrawingTool,
  DrawContext,
  HitContext,
  ScreenPoint,
  // `DrawingControllerOptions.magnet` accepts it; a host with a snap picker
  // wants the three names as one type.
  MagnetMode,
  // `DrawingTool.expand` receives this; a custom tool cannot type its own
  // implementation without it.
  ExpandContext,
} from './types';

// What `new DrawingController(chart)` accepts. Exported so a host wiring the
// controller to something other than a Chart can state what it must provide.
export type { DrawingChartHost } from './controller';

export type { ShortcutEvent } from './tools';

export {
  distToSegment, distToLine, distToPolyline,
  distToRect, distToEllipse, rectOf, boundsOf, extendSegment,
} from './geometry';

// Freehand stroke geometry. Pure and DOM-free: a host or a custom tool that
// captures its own pointer trail can thin, smooth and weight it the way the
// brush and highlighter do.
export { rdpSimplify, catmullRom, pressureWidth } from './freehand';
