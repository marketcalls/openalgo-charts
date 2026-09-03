/**
 * Built-in drawing tools + the tool registry. Same philosophy as the chart-type
 * and indicator registries: a tool is a descriptor, the layer just runs it, and
 * `registerDrawingTool` makes a custom one first-class.
 *
 * `draw` receives anchors already in device px; `distance` receives them in
 * media px, the same space as the incoming cursor.
 *
 * Text lives in `drawing.text` (a `DrawingText`), never in the style bag: a
 * shape's outline colour and its label colour are two decisions, and a tool
 * that prints only a readout (a fib ladder, a measure chip) still reads its
 * face from there. Ladders read `FibLevel[]` and stroke each level in its own
 * colour, taken from the shared palette in levels.ts.
 *
 * Every tool declares `settings`: the fields a host may show for it. The
 * schema is a contract, not a wish list. A field is declared only when this
 * file reads it, because a control with nothing behind it is a defect.
 */
import type { DrawContext, Drawing, DrawingText, DrawingTool, FibLevel, ScreenPoint } from './types';
import {
  distToSegment, distToLine, distToHorizontal, distToVertical,
  distToRect, distToEllipse, distToPolyline, rectOf, boundsOf, extendSegment,
} from './geometry';
import { roundRectPath, contrastText } from '../render/pill';
import {
  type SettingsField, type SettingsSchema,
  LINE_FIELDS, FILL_FIELDS, TEXT_FIELDS, LEVEL_FIELDS, EXTEND_FIELDS, FONT_FIELDS,
  SHAPE_TEXT_FIELDS, PLATE_TEXT_FIELDS,
  COLOR_FIELD, LINE_WIDTH_FIELD, LINE_STYLE_FIELD, SHOW_LABELS_FIELD, TEXT_VALUE_FIELD,
  composeSettings,
} from './schema';
import {
  DEFAULT_FIB, DEFAULT_FIB_FAN, DEFAULT_GANN_FAN, DEFAULT_GANN_BOX, DEFAULT_FIB_TIME_ZONE,
  cloneLevels, cycleColor, levelColor, formatRatio, gannLabel,
} from './levels';
import { catmullRom, pressureWidth } from './freehand';

const registry = new Map<string, DrawingTool>();

export function registerDrawingTool(tool: DrawingTool): void {
  registry.set(tool.id, tool);
}

export function getDrawingTool(id: string): DrawingTool {
  const t = registry.get(id);
  if (t === undefined) throw new Error(`openalgo-charts: unknown drawing tool "${id}"`);
  return t;
}

export function hasDrawingTool(id: string): boolean {
  return registry.has(id);
}

export function registeredDrawingTools(): DrawingTool[] {
  return Array.from(registry.values());
}

/** Keyboard event fields a shortcut is matched against. */
export interface ShortcutEvent {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** `'Shift+Alt+F'` -> its parts, for comparison against an event. */
function parseShortcut(spec: string): { key: string; alt: boolean; ctrl: boolean; shift: boolean } {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1] ?? '';
  return {
    key,
    alt: parts.includes('alt'),
    ctrl: parts.includes('ctrl') || parts.includes('control'),
    shift: parts.includes('shift'),
  };
}

/**
 * The id of the tool whose `shortcut` matches this key event, or `null`.
 *
 * Pure, so a host can bind one `keydown` listener and decide for itself when
 * shortcuts apply. The library installs no listener, because only the host
 * knows whether the chart has focus, a dialog is open, or the user is typing.
 *
 * Modifiers must match exactly: `Alt+T` will not fire for `Ctrl+Alt+T`, so a
 * tool shortcut cannot shadow a browser or host chord. `metaKey` (Cmd) is
 * treated as Ctrl, which is what a Mac user expects.
 */
export function matchDrawingShortcut(e: ShortcutEvent): string | null {
  const key = (e.key ?? '').toLowerCase();
  if (key === '') return null;
  const alt = e.altKey === true;
  const ctrl = e.ctrlKey === true || e.metaKey === true;
  const shift = e.shiftKey === true;
  // A bare letter is never a shortcut: it would swallow ordinary typing.
  if (!alt && !ctrl) return null;
  for (const tool of registry.values()) {
    if (tool.shortcut === undefined) continue;
    const want = parseShortcut(tool.shortcut);
    if (want.key === key && want.alt === alt && want.ctrl === ctrl && want.shift === shift) {
      return tool.id;
    }
  }
  return null;
}

/** Every registered tool that has a shortcut, as `id -> shortcut`. */
export function drawingShortcuts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tool of registry.values()) {
    if (tool.shortcut !== undefined) out[tool.id] = tool.shortcut;
  }
  return out;
}

// ── settings vocabulary shared by several tools ───────────────────────────

/** Colour, width and dash: the least any tool drawn through `applyStroke` honours. */
const LINE_SETTINGS: SettingsSchema = composeSettings([LINE_FIELDS]);

/**
 * The settings a host may show for a tool: the tool's own declaration, else
 * the line fields, which every stroked custom tool reads. This is a registry
 * lookup, which is why it lives here and not in schema.ts: that module stays
 * free of any import that could loop back into this one.
 */
export function drawingSettingsSchema(toolId: string): SettingsSchema {
  return registry.get(toolId)?.settings ?? LINE_SETTINGS;
}

/** A translucent tool's one opacity (highlighter ink, a measure's band). */
const OPACITY_FIELD: SettingsField = {
  path: 'style.fillOpacity', label: 'Opacity', kind: 'opacity', min: 0, max: 1, step: 0.01, group: 'fill',
};

/** `showLabels` on a horizontal line toggles exactly one thing: the price tag. */
const PRICE_TAG_FIELD: SettingsField = { ...SHOW_LABELS_FIELD, label: 'Show price' };

/** The midpoint readout of a two-anchor line: change, percent, bars, angle. */
const STATS_FIELD: SettingsField = { path: 'style.showStats', label: 'Show stats', kind: 'boolean', group: 'behavior' };

/** Let pen pressure swell and thin a freehand stroke. */
const PRESSURE_FIELD: SettingsField = { path: 'style.pressure', label: 'Pen pressure', kind: 'boolean', group: 'line' };

const POSITION_FIELDS: readonly SettingsField[] = [
  { path: 'style.accountSize', label: 'Account size', kind: 'number', min: 0, step: 1000, group: 'behavior' },
  { path: 'style.risk', label: 'Risk %', kind: 'number', min: 0, max: 100, step: 0.1, group: 'behavior' },
];

// ── shared drawing helpers ────────────────────────────────────────────────

function applyStroke(c: DrawContext): void {
  const { ctx, rc, style } = c;
  const d = rc.dpr;
  ctx.strokeStyle = style.color;
  ctx.lineWidth = Math.max(1, Math.round(style.lineWidth * d));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash(
    style.lineStyle === 'dashed' ? [6 * d, 4 * d]
      : style.lineStyle === 'dotted' ? [1 * d, 3 * d]
      : [],
  );
}

function fillStyleOf(c: DrawContext): string {
  return c.style.fillColor ?? c.style.color;
}

function withFill(c: DrawContext, paint: () => void): void {
  if (c.style.fill !== true) return;
  const { ctx } = c;
  ctx.save();
  ctx.globalAlpha = c.style.fillOpacity ?? 0.12;
  ctx.fillStyle = fillStyleOf(c);
  paint();
  ctx.restore();
}

// ── text ──────────────────────────────────────────────────────────────────

const DEFAULT_FONT = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const NO_TEXT: DrawingText = { value: '' };

/** The drawing's text block, or an empty one so every reader falls back per field. */
function textOf(d: Drawing): DrawingText {
  return d.text ?? NO_TEXT;
}

/**
 * The CSS font shorthand for a text block at `sizePx`. `weight` overrides the
 * bold flag, for the one place (a table header) that wants a weight of its own.
 */
function fontOf(t: DrawingText, sizePx: number, weight?: string): string {
  const w = weight ?? (t.bold === true ? '700' : '');
  const italic = t.italic === true ? 'italic ' : '';
  const family = t.fontFamily === undefined || t.fontFamily === '' ? DEFAULT_FONT : t.fontFamily;
  return `${italic}${w === '' ? '' : `${w} `}${sizePx}px ${family}`;
}

/**
 * The text a mark shows, with the tool's own fallback when there is none. An
 * annotation with no text is still a mark on the chart, and an empty plate
 * reads as a rendering bug rather than as a note waiting for content; worse,
 * it cannot be seen, so it cannot be found and deleted.
 */
function contentOf(d: Drawing, fallback: string): string {
  const v = d.text?.value;
  return v === undefined || v === '' ? fallback : v;
}

/**
 * A readout on a plate of the pane background. `color` is the mark the text
 * belongs to (a level's colour); the text block's own colour wins over it,
 * and the drawing's colour is the last resort. `tint` washes the plate with a
 * direction colour, and `center` puts the plate about `x` instead of to its
 * right; both are for readouts that sit on the shape rather than beside it.
 */
function label(
  c: DrawContext, text: string, x: number, y: number, color?: string,
  opts: { tint?: string; center?: boolean } = {},
): void {
  const { ctx, rc, style } = c;
  const t = textOf(c.drawing);
  const size = (t.fontSize ?? 11) * rc.dpr;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = fontOf(t, size);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const w = ctx.measureText(text).width;
  const left = opts.center === true ? x - w / 2 : x;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = rc.theme.background;
  ctx.fillRect(left - 2 * rc.dpr, y - size * 0.75, w + 4 * rc.dpr, size * 1.5);
  if (opts.tint !== undefined) {
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = opts.tint;
    ctx.fillRect(left - 2 * rc.dpr, y - size * 0.75, w + 4 * rc.dpr, size * 1.5);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = t.color ?? color ?? style.color;
  ctx.fillText(text, left, y);
  ctx.restore();
}

/**
 * A solid rounded chip with contrasting text, one row per line: the readout
 * style the position and forecast tools share. `align` positions the box
 * horizontally about `x`, `place` vertically about `y`. Returns its height so a
 * caller can stack chips.
 */
function chip(
  c: DrawContext,
  lines: readonly string[],
  x: number,
  y: number,
  bg: string,
  opts: { align?: 'left' | 'center' | 'right'; place?: 'above' | 'below' | 'middle' } = {},
): number {
  const { ctx, rc } = c;
  const d = rc.dpr;
  const t = textOf(c.drawing);
  const size = (t.fontSize ?? 11) * d;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = fontOf(t, size);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const padX = 5 * d;
  const padY = 3 * d;
  const lh = size * 1.35;
  let textW = 0;
  for (const s of lines) textW = Math.max(textW, ctx.measureText(s).width);
  const w = textW + padX * 2;
  const h = lh * lines.length + padY * 2;
  const align = opts.align ?? 'left';
  const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const place = opts.place ?? 'above';
  const by = place === 'above' ? y - h - 4 * d : place === 'below' ? y + 4 * d : y - h / 2;
  ctx.beginPath();
  roundRectPath(ctx, bx, by, w, h, 3 * d);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = t.color ?? contrastText(bg);
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], bx + padX, by + padY + lh * (i + 0.5));
  ctx.restore();
  return h;
}

/** Thousands-separated fixed-point, locale-independent so output is stable. */
function grouped(n: number, dp = 0): string {
  const [i, f] = Math.abs(n).toFixed(dp).split('.');
  const sign = n < 0 ? '-' : '';
  return sign + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f === undefined ? '' : '.' + f);
}

/** `YYYY-MM-DD` in UTC: enough to anchor a label to its bar. */
function isoDate(sec: number): string {
  const dt = new Date(sec * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/** Coarse elapsed span: `76d 23h`, `5h 12m`, `12m`. */
function humanSpan(sec: number): string {
  const s = Math.max(0, Math.round(Math.abs(sec)));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Filled arrowhead at `b`, pointing away from `a`. Scales with line width. */
function arrowHead(c: DrawContext, a: ScreenPoint, b: ScreenPoint): void {
  const head = Math.max(8, c.style.lineWidth * 5) * c.rc.dpr;
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  c.ctx.beginPath();
  c.ctx.moveTo(b.x, b.y);
  c.ctx.lineTo(b.x - head * Math.cos(ang - 0.4), b.y - head * Math.sin(ang - 0.4));
  c.ctx.lineTo(b.x - head * Math.cos(ang + 0.4), b.y - head * Math.sin(ang + 0.4));
  c.ctx.closePath();
  c.ctx.fillStyle = c.style.color;
  c.ctx.fill();
}

/** 172.79M / 1.2K: a raw volume sum is unreadable in a label. */
function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return grouped(n);
}

const UP_TINT = '#26a69a';
const DOWN_TINT = '#ef5350';

/**
 * The midpoint readout of a two-anchor line, when `showStats` asks for it:
 * signed change and percent, bars between the anchors, and the angle the
 * line makes on screen. Bars come from logical indices so the count matches
 * the gapless axis; the angle is measured in device px because a slope in
 * price-per-second means nothing to the eye, and it is what the eye sees
 * that the readout describes. Off by default, so a line paints exactly as it
 * did before the readout existed.
 */
function lineStats(c: DrawContext): void {
  if (c.style.showStats !== true) return;
  const [a, b] = c.pts;
  const [p0, p1] = c.drawing.points;
  const chg = p1.price - p0.price;
  const pct = p0.price !== 0 ? (chg / p0.price) * 100 : 0;
  const up = chg >= 0;
  const sign = up ? '+' : '';
  const i0 = c.rc.dataLayer.timeToIndexFloat(p0.time);
  const i1 = c.rc.dataLayer.timeToIndexFloat(p1.time);
  const bars = Math.abs(Math.round(i1 - i0));
  // Screen y grows downward, so it is negated to read as a rising angle.
  const angle = (Math.atan2(a.y - b.y, b.x - a.x) * 180) / Math.PI;
  const text = `${sign}${c.formatPrice(chg)} (${sign}${pct.toFixed(2)}%)  ${grouped(bars)} bars  ${angle.toFixed(1)} deg`;
  label(c, text, (a.x + b.x) / 2, (a.y + b.y) / 2 - 10 * c.rc.dpr, c.style.color, {
    tint: up ? UP_TINT : DOWN_TINT, center: true,
  });
}

/**
 * Freehand ink through the spline. A constant-width stroke is one path; with
 * `pressure` on it becomes a filled ribbon whose edges run the spline offset
 * by half the pressure width at each sample, which is the only way a single
 * fill can be fat where the pen pressed and thin where it lifted. `alpha`
 * is the highlighter's translucency; the brush passes 1.
 */
function ink(c: DrawContext, width: number, alpha: number): void {
  const { ctx, style } = c;
  const pts = c.pts;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (style.pressure !== true) {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = width;
    ctx.beginPath();
    catmullRom(ctx, pts);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const n = pts.length;
  const left: ScreenPoint[] = [];
  const right: ScreenPoint[] = [];
  for (let i = 0; i < n; i++) {
    // The tangent at a sample runs from its previous neighbour to its next
    // one; the ends use the one segment they have.
    const prev = pts[i === 0 ? 0 : i - 1];
    const next = pts[i === n - 1 ? n - 1 : i + 1];
    const len = Math.hypot(next.x - prev.x, next.y - prev.y) || 1;
    const nx = -(next.y - prev.y) / len;
    const ny = (next.x - prev.x) / len;
    const pressure = c.drawing.points[i]?.pressure;
    const half = pressureWidth(width, pressure ?? 0.5) / 2;
    left.push({ x: pts[i].x + nx * half, y: pts[i].y + ny * half });
    right.push({ x: pts[i].x - nx * half, y: pts[i].y - ny * half });
  }
  // One loop: out along the left edge, back along the right, so the spline
  // rounds the ends on its own and the fill is a single closed region.
  right.reverse();
  ctx.fillStyle = style.color;
  ctx.beginPath();
  catmullRom(ctx, left.concat(right));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ── levels ────────────────────────────────────────────────────────────────

/**
 * The levels a ladder strokes: the drawing's own, else the tool's default,
 * minus the ones switched off and any with a ratio that is not a number
 * (a hand-edited state file is the usual source).
 */
function activeLevels(own: readonly FibLevel[] | undefined, fallback: readonly FibLevel[]): FibLevel[] {
  return (own ?? fallback).filter((l) => l.enabled !== false && Number.isFinite(l.ratio));
}

/** A fib level's colour: its own, else the convention for its ratio. */
function fibColor(lv: FibLevel): string {
  return lv.color ?? levelColor(lv.ratio);
}

/** A fib level's text: its own, else the ratio as a percentage. */
function fibText(lv: FibLevel): string {
  return lv.label ?? formatRatio(lv.ratio);
}

// ── line family ───────────────────────────────────────────────────────────

/** Trend line, ray, and extended line differ only in which ends extend. */
function lineTool(id: string, name: string, left: boolean, right: boolean): DrawingTool {
  return {
    id, name, points: 2, angleLock: true,
    defaultStyle: { extendLeft: left, extendRight: right },
    settings: composeSettings([LINE_FIELDS, EXTEND_FIELDS, STATS_FIELD]),
    draw: (c) => {
      const [a, b] = extendSegment(
        c.pts[0], c.pts[1], c.rc.plotWidth * c.rc.dpr,
        c.style.extendLeft ?? left, c.style.extendRight ?? right,
      );
      applyStroke(c);
      c.ctx.beginPath();
      c.ctx.moveTo(a.x, a.y);
      c.ctx.lineTo(b.x, b.y);
      c.ctx.stroke();
      c.ctx.setLineDash([]);
      lineStats(c);
    },
    distance: (x, y, h) => {
      const el = h.drawing.style.extendLeft ?? left;
      const er = h.drawing.style.extendRight ?? right;
      if (el && er) return distToLine(x, y, h.pts[0], h.pts[1]);
      const [a, b] = extendSegment(h.pts[0], h.pts[1], h.rc.plotWidth, el, er);
      return distToSegment(x, y, a, b);
    },
  };
}

export const TREND_LINE: DrawingTool = { ...lineTool('trend-line', 'Trend Line', false, false), shortcut: 'Alt+T' };
export const RAY = lineTool('ray', 'Ray', false, true);
export const EXTENDED_LINE = lineTool('extended-line', 'Extended Line', true, true);

export const ARROW: DrawingTool = {
  id: 'arrow', name: 'Arrow', points: 2, angleLock: true,
  settings: composeSettings([LINE_FIELDS, STATS_FIELD]),
  draw: (c) => {
    const [a, b] = c.pts;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    c.ctx.lineTo(b.x, b.y);
    c.ctx.stroke();
    // Head at the far anchor, sized off the line width so it scales with style.
    arrowHead(c, a, b);
    c.ctx.setLineDash([]);
    lineStats(c);
  },
  distance: (x, y, h) => distToSegment(x, y, h.pts[0], h.pts[1]),
};

export const HORIZONTAL_LINE: DrawingTool = {
  id: 'horizontal-line', name: 'Horizontal Line', points: 1, shortcut: 'Alt+H',
  defaultStyle: { showLabels: true },
  settings: composeSettings([LINE_FIELDS, PRICE_TAG_FIELD, FONT_FIELDS]),
  draw: (c) => {
    const y = Math.round(c.pts[0].y) + 0.5;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(0, y);
    c.ctx.lineTo(c.rc.plotWidth * c.rc.dpr, y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    if (c.style.showLabels !== false) {
      label(c, c.formatPrice(c.drawing.points[0].price), 4 * c.rc.dpr, y - 8 * c.rc.dpr);
    }
  },
  distance: (_x, y, h) => distToHorizontal(y, h.pts[0].y),
};

export const HORIZONTAL_RAY: DrawingTool = {
  id: 'horizontal-ray', name: 'Horizontal Ray', points: 1, shortcut: 'Alt+J',
  defaultStyle: { showLabels: true },
  settings: composeSettings([LINE_FIELDS, PRICE_TAG_FIELD, FONT_FIELDS]),
  draw: (c) => {
    const y = Math.round(c.pts[0].y) + 0.5;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(c.pts[0].x, y);
    c.ctx.lineTo(c.rc.plotWidth * c.rc.dpr, y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    if (c.style.showLabels !== false) {
      label(c, c.formatPrice(c.drawing.points[0].price), c.pts[0].x + 4 * c.rc.dpr, y - 8 * c.rc.dpr);
    }
  },
  distance: (x, y, h) => (x < h.pts[0].x ? null : distToHorizontal(y, h.pts[0].y)),
};

export const VERTICAL_LINE: DrawingTool = {
  id: 'vertical-line', name: 'Vertical Line', points: 1, shortcut: 'Alt+V',
  settings: LINE_SETTINGS,
  draw: (c) => {
    const x = Math.round(c.pts[0].x) + 0.5;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(x, 0);
    c.ctx.lineTo(x, c.rc.plotHeight * c.rc.dpr);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, _y, h) => distToVertical(x, h.pts[0].x),
};

export const CROSS_LINE: DrawingTool = {
  id: 'cross-line', name: 'Cross Line', points: 1, shortcut: 'Alt+C',
  settings: LINE_SETTINGS,
  draw: (c) => {
    const x = Math.round(c.pts[0].x) + 0.5;
    const y = Math.round(c.pts[0].y) + 0.5;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(x, 0); c.ctx.lineTo(x, c.rc.plotHeight * c.rc.dpr);
    c.ctx.moveTo(0, y); c.ctx.lineTo(c.rc.plotWidth * c.rc.dpr, y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => Math.min(distToVertical(x, h.pts[0].x), distToHorizontal(y, h.pts[0].y)),
};

// ── shapes ────────────────────────────────────────────────────────────────

/** What every labelled shape declares: outline, fill, and the attached label. */
const SHAPE_SETTINGS: SettingsSchema = composeSettings([LINE_FIELDS, FILL_FIELDS, SHAPE_TEXT_FIELDS]);

export const RECTANGLE: DrawingTool = {
  id: 'rectangle', name: 'Rectangle', points: 2,
  defaultStyle: { fill: true },
  settings: SHAPE_SETTINGS,
  draw: (c) => {
    const r = rectOf(c.pts[0], c.pts[1]);
    withFill(c, () => c.ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0));
    applyStroke(c);
    c.ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    c.ctx.setLineDash([]);
    shapeLabel(c, r);
  },
  distance: (x, y, h) => distToRect(x, y, h.pts[0], h.pts[1], h.drawing.style.fill === true),
};

export const ELLIPSE: DrawingTool = {
  id: 'ellipse', name: 'Ellipse', points: 2,
  defaultStyle: { fill: true },
  settings: SHAPE_SETTINGS,
  draw: (c) => {
    const r = rectOf(c.pts[0], c.pts[1]);
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const rx = Math.max(1, (r.x1 - r.x0) / 2);
    const ry = Math.max(1, (r.y1 - r.y0) / 2);
    const path = (): void => {
      c.ctx.beginPath();
      c.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    };
    withFill(c, () => { path(); c.ctx.fill(); });
    applyStroke(c);
    path();
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    // A corner of an ellipse's box is outside the ellipse, so the label
    // defaults to the middle, where there is shape behind it.
    shapeLabel(c, r, 'center', 'middle');
  },
  distance: (x, y, h) => distToEllipse(x, y, h.pts[0], h.pts[1], h.drawing.style.fill === true),
};

export const PARALLEL_CHANNEL: DrawingTool = {
  id: 'parallel-channel', name: 'Parallel Channel', points: 3,
  defaultStyle: { fill: true },
  settings: SHAPE_SETTINGS,
  draw: (c) => {
    const [a, b, t] = c.pts;
    // The third anchor sets the channel width as a vertical offset.
    const dy = t.y - (a.y + (b.y - a.y) * 0.5);
    const a2 = { x: a.x, y: a.y + dy };
    const b2 = { x: b.x, y: b.y + dy };
    withFill(c, () => {
      c.ctx.beginPath();
      c.ctx.moveTo(a.x, a.y); c.ctx.lineTo(b.x, b.y);
      c.ctx.lineTo(b2.x, b2.y); c.ctx.lineTo(a2.x, a2.y);
      c.ctx.closePath();
      c.ctx.fill();
    });
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y); c.ctx.lineTo(b.x, b.y);
    c.ctx.moveTo(a2.x, a2.y); c.ctx.lineTo(b2.x, b2.y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    shapeLabel(c, boundsOf([a, b, a2, b2]));
  },
  distance: (x, y, h) => {
    const [a, b, t] = h.pts;
    const dy = t.y - (a.y + (b.y - a.y) * 0.5);
    const d1 = distToSegment(x, y, a, b);
    const d2 = distToSegment(x, y, { x: a.x, y: a.y + dy }, { x: b.x, y: b.y + dy });
    return Math.min(d1, d2);
  },
};

// ── fibonacci ─────────────────────────────────────────────────────────────

const FIB_SETTINGS: SettingsSchema = composeSettings([LINE_FIELDS, LEVEL_FIELDS, FILL_FIELDS, EXTEND_FIELDS, FONT_FIELDS]);

/** Retracement (2 anchors) and extension (3) share the level-drawing body. */
function fibTool(id: string, name: string, anchors: 2 | 3): DrawingTool {
  return {
    id, name, points: anchors,
    defaultStyle: { showLabels: true, levels: cloneLevels(DEFAULT_FIB), fill: true, fillOpacity: 0.06 },
    settings: FIB_SETTINGS,
    draw: (c) => {
      const levels = activeLevels(c.style.levels, DEFAULT_FIB);
      const p = c.drawing.points;
      const d = c.rc.dpr;
      // Retracement measures p0 to p1; extension projects that leg from p2.
      const from = anchors === 2 ? p[0].price : p[2].price;
      const span = p[1].price - p[0].price;
      const xa = Math.min(c.pts[0].x, c.pts[anchors - 1].x);
      const xb = Math.max(c.pts[0].x, c.pts[anchors - 1].x);
      const x0 = c.style.extendLeft === true ? 0 : xa;
      const x1 = c.style.extendRight === true ? c.rc.plotWidth * d : xb;
      // The leg the ratios are ratios of, in the drawing's own colour. The
      // levels are horizontal, so nothing else shows where the swing ran.
      applyStroke(c);
      c.ctx.beginPath();
      c.ctx.moveTo(c.pts[0].x, c.pts[0].y);
      c.ctx.lineTo(c.pts[1].x, c.pts[1].y);
      if (anchors === 3) c.ctx.lineTo(c.pts[2].x, c.pts[2].y);
      c.ctx.stroke();
      let prevY: number | null = null;
      for (const lv of levels) {
        const price = from + span * lv.ratio;
        const y = Math.round(c.rc.priceScale.priceToY(price) * d) + 0.5;
        const color = fibColor(lv);
        // Each band is tinted by the level that closes it, so the fill reads
        // as part of the ladder rather than as one wash behind it.
        if (c.style.fill === true && prevY !== null) {
          c.ctx.save();
          c.ctx.globalAlpha = c.style.fillOpacity ?? 0.06;
          c.ctx.fillStyle = c.style.fillColor ?? color;
          c.ctx.fillRect(x0, Math.min(prevY, y), x1 - x0, Math.abs(y - prevY));
          c.ctx.restore();
        }
        prevY = y;
        c.ctx.strokeStyle = color;
        c.ctx.beginPath();
        c.ctx.moveTo(x0, y);
        c.ctx.lineTo(x1, y);
        c.ctx.stroke();
        if (c.style.showLabels !== false) {
          label(c, `${fibText(lv)}  ${c.formatPrice(price)}`, x0 + 4 * d, y - 8 * d, color);
        }
      }
      c.ctx.setLineDash([]);
    },
    distance: (x, y, h) => {
      const levels = activeLevels(h.drawing.style.levels, DEFAULT_FIB);
      const p = h.drawing.points;
      const from = anchors === 2 ? p[0].price : p[2].price;
      const span = p[1].price - p[0].price;
      const x0 = h.drawing.style.extendLeft === true ? 0 : Math.min(h.pts[0].x, h.pts[anchors - 1].x);
      const x1 = h.drawing.style.extendRight === true
        ? h.rc.plotWidth : Math.max(h.pts[0].x, h.pts[anchors - 1].x);
      if (x < x0 - 4 || x > x1 + 4) return null;
      let best = Infinity;
      for (const lv of levels) {
        const dd = Math.abs(y - h.rc.priceScale.priceToY(from + span * lv.ratio));
        if (dd < best) best = dd;
      }
      return best;
    },
  };
}

export const FIB_RETRACEMENT = fibTool('fib-retracement', 'Fib Retracement', 2);
export const FIB_EXTENSION = fibTool('fib-extension', 'Fib Extension', 3);

// ── measurement & positions ───────────────────────────────────────────────

/** Measurers are tinted by direction, so they read width, dash and opacity but not a colour. */
const MEASURE_SETTINGS: SettingsSchema = composeSettings([
  LINE_WIDTH_FIELD, LINE_STYLE_FIELD, OPACITY_FIELD, SHOW_LABELS_FIELD, FONT_FIELDS,
]);

export const MEASURE: DrawingTool = {
  id: 'measure', name: 'Measure', points: 2,
  defaultStyle: { fill: true, showLabels: true, fillOpacity: 0.14 },
  settings: MEASURE_SETTINGS,
  draw: (c) => {
    const r = rectOf(c.pts[0], c.pts[1]);
    const d = c.rc.dpr;
    const p = c.drawing.points;
    const chg = p[1].price - p[0].price;
    const pct = p[0].price !== 0 ? (chg / p[0].price) * 100 : 0;
    const up = chg >= 0;
    const tint = up ? UP_TINT : DOWN_TINT;
    c.ctx.save();
    c.ctx.globalAlpha = c.style.fillOpacity ?? 0.14;
    c.ctx.fillStyle = tint;
    c.ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    c.ctx.restore();
    applyStroke(c);
    c.ctx.strokeStyle = tint;
    c.ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
    c.ctx.setLineDash([]);

    // Two arrows: one along price at the start level, one along time. They are
    // what make the box read as a measurement rather than a highlight.
    const midX = (r.x0 + r.x1) / 2;
    const y0 = c.pts[0].y;
    const y1 = c.pts[1].y;
    c.ctx.strokeStyle = tint;
    c.ctx.beginPath();
    c.ctx.moveTo(r.x0, y0);
    c.ctx.lineTo(r.x1, y0);
    c.ctx.stroke();
    arrowHead(c, { x: r.x0, y: y0 }, { x: r.x1, y: y0 });
    c.ctx.beginPath();
    c.ctx.moveTo(midX, y0);
    c.ctx.lineTo(midX, y1);
    c.ctx.stroke();
    arrowHead(c, { x: midX, y: y0 }, { x: midX, y: y1 });

    if (c.style.showLabels === false) return;
    // Bars come from logical indices, so the count matches the gapless axis
    // rather than raw elapsed time; the calendar span comes from the times.
    const i0 = c.rc.dataLayer.timeToIndexFloat(p[0].time);
    const i1 = c.rc.dataLayer.timeToIndexFloat(p[1].time);
    const bars = Math.abs(Math.round(i1 - i0));
    const sign = up ? '+' : '';
    const lines = [
      `${sign}${c.formatPrice(chg)} (${sign}${pct.toFixed(2)}%)`,
      `${grouped(bars)} bars, ${humanSpan(p[1].time - p[0].time)}`,
    ];
    // Volume over the span, when the pane can hand us the bars.
    const src = c.rc.bars?.();
    if (src !== undefined && src.length > 0) {
      const lo = Math.min(p[0].time, p[1].time);
      const hi = Math.max(p[0].time, p[1].time);
      let vol = 0;
      let seen = false;
      for (const b of src) {
        if (b.time < lo) continue;
        if (b.time > hi) break;
        if (b.volume !== undefined) { vol += b.volume; seen = true; }
      }
      if (seen) lines.push(`Vol ${compactNumber(vol)}`);
    }
    chip(c, lines, midX, Math.max(y0, y1) + 6 * d, tint, { align: 'center', place: 'below' });
  },
  distance: (x, y, h) => distToRect(x, y, h.pts[0], h.pts[1], true),
};

/**
 * Long / short position calculator: entry, target, stop.
 *
 * One click places the whole thing at a 1:1 reward:risk and every anchor stays
 * draggable, so the tool opens with something to adjust rather than asking for
 * three clicks before it shows anything.
 */
function positionTool(id: string, name: string, long: boolean): DrawingTool {
  return {
    id, name, points: 1,
    defaultStyle: { showLabels: true, fillOpacity: 0.13, accountSize: 100000, risk: 1 },
    settings: composeSettings([LINE_FIELDS, OPACITY_FIELD, SHOW_LABELS_FIELD, POSITION_FIELDS, FONT_FIELDS]),
    expand: (clicked, ctx) => {
      const p = clicked[0];
      // 1% of price gives a 1:1 box that reads sensibly on any instrument; the
      // fallback covers a zero/near-zero price where a ratio has no meaning.
      const off = Math.abs(p.price) * 0.01 || 1;
      // ~8% of what is on screen, so the box is grabbable at any zoom instead
      // of a hairline when zoomed out or pane-filling when zoomed in.
      const bars = Math.max(5, Math.round(ctx.visibleBars * 0.08));
      const far = p.time + Math.max(1, ctx.barSeconds) * bars;
      return long
        ? [p, { time: far, price: p.price + off }, { time: far, price: p.price - off }]
        : [p, { time: far, price: p.price - off }, { time: far, price: p.price + off }];
    },
    draw: (c) => {
      // A single-anchor preview exists between the click and `expand`.
      if (c.drawing.points.length < 3 || c.pts.length < 3) return;
      const [entry, target, stop] = c.drawing.points;
      const d = c.rc.dpr;
      const x0 = Math.min(c.pts[0].x, c.pts[1].x, c.pts[2].x);
      const x1 = Math.max(c.pts[0].x, c.pts[1].x, c.pts[2].x);
      const yE = c.rc.priceScale.priceToY(entry.price) * d;
      const yT = c.rc.priceScale.priceToY(target.price) * d;
      const yS = c.rc.priceScale.priceToY(stop.price) * d;
      const band = (yA: number, yB: number, color: string): void => {
        c.ctx.save();
        c.ctx.globalAlpha = c.style.fillOpacity ?? 0.13;
        c.ctx.fillStyle = color;
        c.ctx.fillRect(x0, Math.min(yA, yB), x1 - x0, Math.abs(yB - yA));
        c.ctx.restore();
      };
      band(yE, yT, UP_TINT);
      band(yE, yS, DOWN_TINT);
      applyStroke(c);
      for (const y of [yE, yT, yS]) {
        const yy = Math.round(y) + 0.5;
        c.ctx.beginPath();
        c.ctx.moveTo(x0, yy);
        c.ctx.lineTo(x1, yy);
        c.ctx.stroke();
      }
      c.ctx.setLineDash([]);
      if (c.style.showLabels === false) return;
      const risk = Math.abs(entry.price - stop.price);
      const reward = Math.abs(target.price - entry.price);
      const rr = risk > 0 ? reward / risk : 0;
      // Position size from risk budget over stop distance: the number a trader
      // actually wants off this tool.
      const account = c.style.accountSize ?? 0;
      const riskPct = c.style.risk ?? 0;
      const qty = risk > 0 && account > 0 ? Math.floor((account * riskPct / 100) / risk) : 0;
      const pctOf = (delta: number): string =>
        (entry.price !== 0 ? (delta / entry.price) * 100 : 0).toFixed(3);
      const cash = (delta: number): string => (qty > 0 ? `, Amount: ${grouped(qty * delta)}` : '');
      const cx = (x0 + x1) / 2;
      // Each readout hugs its own line, on the outside of the box: the target
      // chip sits past the target line whichever side of entry it landed on, so
      // it reads the same for a long and an inverted-drag short.
      chip(c, [`Target: ${c.formatPrice(reward)} (${pctOf(reward)}%)${cash(reward)}`],
        cx, yT, UP_TINT, { align: 'center', place: yT <= yE ? 'above' : 'below' });
      chip(c, [`Stop: ${c.formatPrice(risk)} (${pctOf(risk)}%)${cash(risk)}`],
        cx, yS, DOWN_TINT, { align: 'center', place: yS >= yE ? 'below' : 'above' });
      chip(c, [
        `${long ? 'Long' : 'Short'}, Qty: ${qty > 0 ? grouped(qty) : '-'}`,
        `Risk/reward ratio: ${rr.toFixed(2)}`,
      ], cx, yE, c.rc.theme.background, { align: 'center', place: 'middle' });
    },
    distance: (x, y, h) => {
      if (h.pts.length < 3) return null;
      const x0 = Math.min(h.pts[0].x, h.pts[1].x, h.pts[2].x);
      const x1 = Math.max(h.pts[0].x, h.pts[1].x, h.pts[2].x);
      if (x < x0 - 4 || x > x1 + 4) return null;
      const ys = h.drawing.points.map((p) => h.rc.priceScale.priceToY(p.price));
      const lo = Math.min(...ys);
      const hi = Math.max(...ys);
      return y >= lo && y <= hi ? 0 : Math.min(Math.abs(y - lo), Math.abs(y - hi));
    },
  };
}

export const LONG_POSITION = positionTool('long-position', 'Long Position', true);
export const SHORT_POSITION = positionTool('short-position', 'Short Position', false);

// ── annotation ────────────────────────────────────────────────────────────

const TEXT_PAD = 5;
const LINE_GAP = 1.35;
/** The text tool's size when the block sets none. */
const TEXT_SIZE = 14;

/**
 * Split into rendered lines: honour explicit `\n` always, and soft-wrap each
 * paragraph at `maxWidth` when `wrap` is on. Measured with the *live* context
 * so the wrap matches the font actually being drawn.
 */
function textLines(ctx: CanvasRenderingContext2D, t: DrawingText, value: string, maxWidth: number): string[] {
  const paragraphs = value.split('\n');
  if (t.wrap !== true) return paragraphs;
  const out: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter((w) => w !== '');
    if (words.length === 0) { out.push(''); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const next = `${line} ${words[i]}`;
      if (ctx.measureText(next).width > maxWidth) { out.push(line); line = words[i]; }
      else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Measured box of a text drawing, in the context's px, anchored at its top-left. */
function textBox(
  ctx: CanvasRenderingContext2D,
  t: DrawingText,
  value: string,
  dpr: number,
): { lines: string[]; width: number; height: number; lineHeight: number } {
  const size = (t.fontSize ?? TEXT_SIZE) * dpr;
  ctx.font = fontOf(t, size);
  const maxWidth = (t.wrapWidth ?? 220) * dpr;
  const lines = textLines(ctx, t, value, maxWidth);
  let width = 0;
  for (const l of lines) width = Math.max(width, ctx.measureText(l).width);
  const lineHeight = size * LINE_GAP;
  return {
    lines,
    width: width + TEXT_PAD * 2 * dpr,
    height: lines.length * lineHeight + TEXT_PAD * 2 * dpr,
    lineHeight,
  };
}

/**
 * Draw a shape's attached label. Shapes carry an optional text block that
 * renders inside (or just above) their bounds, with its own colour, font and
 * alignment: the outline colour and the label colour are different decisions.
 * `align` and `valign` are the shape's own defaults for when the block sets
 * neither; a rectangle labels its corner, an ellipse its middle.
 */
function shapeLabel(
  c: DrawContext,
  r: { x0: number; y0: number; x1: number; y1: number },
  align: 'left' | 'center' | 'right' = 'left',
  valign: 'top' | 'middle' | 'bottom' = 'top',
): void {
  const { ctx, rc, style } = c;
  const t = textOf(c.drawing);
  if (t.value === '') return;
  const d = rc.dpr;
  const size = (t.fontSize ?? TEXT_SIZE) * d;
  const pad = 6 * d;
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = fontOf(t, size);
  ctx.fillStyle = t.color ?? style.color;
  ctx.textBaseline = 'top';

  // A shape's label wraps to the shape, not to a width of its own.
  const lines = textLines(ctx, t, t.value, Math.max(20 * d, r.x1 - r.x0 - pad * 2));
  const lineHeight = size * LINE_GAP;
  const blockH = lines.length * lineHeight;

  const a = t.align ?? align;
  ctx.textAlign = a;
  const tx = a === 'center' ? (r.x0 + r.x1) / 2 : a === 'right' ? r.x1 - pad : r.x0 + pad;

  // `outside` lifts the block clear of the shape so it never sits on the outline.
  let ty: number;
  if (t.position === 'outside') {
    ty = r.y0 - blockH - pad;
  } else {
    const v = t.valign ?? valign;
    ty = v === 'middle' ? (r.y0 + r.y1 - blockH) / 2
      : v === 'bottom' ? r.y1 - blockH - pad
      : r.y0 + pad;
  }
  for (const line of lines) {
    ctx.fillText(line, tx, ty);
    ty += lineHeight;
  }
  ctx.restore();
}

export const TEXT: DrawingTool = {
  id: 'text', name: 'Text', points: 1,
  defaultText: { value: 'Text', fontSize: TEXT_SIZE },
  settings: composeSettings([TEXT_FIELDS], { textIsContent: true }),
  draw: (c) => {
    const { ctx, rc, style } = c;
    const d = rc.dpr;
    const t = textOf(c.drawing);
    const box = textBox(ctx, t, contentOf(c.drawing, 'Text'), d);
    const x = c.pts[0].x;
    // The anchor is the box's top, middle or bottom edge: `bottom` is how a
    // note sits above a bar instead of covering it.
    const v = t.valign ?? 'top';
    const y = v === 'middle' ? c.pts[0].y - box.height / 2
      : v === 'bottom' ? c.pts[0].y - box.height
      : c.pts[0].y;

    ctx.save();
    ctx.setLineDash([]);
    if (t.background === true) {
      ctx.globalAlpha = t.backgroundOpacity ?? 1;
      ctx.fillStyle = t.backgroundColor ?? rc.theme.background;
      ctx.beginPath();
      ctx.roundRect(x, y, box.width, box.height, 4 * d);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (t.border === true) {
      ctx.strokeStyle = t.borderColor ?? style.color;
      ctx.lineWidth = Math.max(1, style.lineWidth * d);
      ctx.beginPath();
      ctx.roundRect(x, y, box.width, box.height, 4 * d);
      ctx.stroke();
    }

    ctx.font = fontOf(t, (t.fontSize ?? TEXT_SIZE) * d);
    ctx.fillStyle = t.color ?? style.color;
    ctx.textBaseline = 'top';
    const align = t.align ?? 'left';
    ctx.textAlign = align;
    const tx = align === 'center' ? x + box.width / 2
      : align === 'right' ? x + box.width - TEXT_PAD * d
      : x + TEXT_PAD * d;
    let ty = y + TEXT_PAD * d;
    for (const line of box.lines) {
      ctx.fillText(line, tx, ty);
      ty += box.lineHeight;
    }
    ctx.restore();
  },
  distance: (x, y, h) => {
    // Measure with a throwaway 2D context so the hit box matches what is drawn
    // (wrapping and font metrics decide the real size, not a character count).
    const t = textOf(h.drawing);
    const value = contentOf(h.drawing, 'Text');
    const size = t.fontSize ?? TEXT_SIZE;
    const p = h.pts[0];
    const probe = measureContext();
    const box = probe === null
      ? { width: value.length * size * 0.6 + 10, height: size * LINE_GAP + 10 }
      : textBox(probe, t, value, 1);
    const v = t.valign ?? 'top';
    const top = v === 'middle' ? p.y - box.height / 2 : v === 'bottom' ? p.y - box.height : p.y;
    return x >= p.x - 3 && x <= p.x + box.width + 3
      && y >= top - 3 && y <= top + box.height + 3 ? 0 : null;
  },
};

/** A 1x1 offscreen context used only for text measurement. Cached. */
let _probe: CanvasRenderingContext2D | null | undefined;
function measureContext(): CanvasRenderingContext2D | null {
  if (_probe !== undefined) return _probe;
  try {
    _probe = (typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d'));
  } catch {
    _probe = null;
  }
  return _probe;
}

/**
 * Path: click each vertex, double-click to finish, arrowhead on the last leg.
 * The arrow is what separates it from `polyline`: a path points somewhere.
 */
export const PATH: DrawingTool = {
  id: 'path', name: 'Path', points: 0,
  settings: LINE_SETTINGS,
  draw: (c) => {
    if (c.pts.length < 2) return;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(c.pts[0].x, c.pts[0].y);
    for (let i = 1; i < c.pts.length; i++) c.ctx.lineTo(c.pts[i].x, c.pts[i].y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    arrowHead(c, c.pts[c.pts.length - 2], c.pts[c.pts.length - 1]);
  },
  distance: (x, y, h) => (h.pts.length < 2 ? null : distToPolyline(x, y, h.pts)),
};

/**
 * Brush: freehand ink. Press, drag, release. The anchors are the thinned
 * samples of the gesture and the spline between them is what is stroked, so
 * the ink stays a curve after the thinning that keeps a stroke small.
 */
export const BRUSH: DrawingTool = {
  id: 'brush', name: 'Brush', points: 0, freehand: true,
  defaultStyle: { lineWidth: 2 },
  settings: composeSettings([LINE_FIELDS, PRESSURE_FIELD]),
  draw: (c) => {
    if (c.pts.length < 2) return;
    // The dash comes from the style; the width and cap from the ink helper.
    applyStroke(c);
    ink(c, Math.max(1, Math.round(c.style.lineWidth * c.rc.dpr)), 1);
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => (h.pts.length < 2 ? null : distToPolyline(x, y, h.pts)),
};

/**
 * Rotated rectangle: anchors 0 and 1 lay out one edge (and so the rotation),
 * and anchor 2 sets the depth perpendicular to it. An axis-aligned `rectangle`
 * cannot follow a trend channel; this can.
 */
export const ROTATED_RECTANGLE: DrawingTool = {
  id: 'rotated-rectangle', name: 'Rotated Rectangle', points: 3,
  defaultStyle: { fill: true, fillOpacity: 0.12 },
  settings: SHAPE_SETTINGS,
  draw: (c) => {
    if (c.pts.length < 3) return;
    const corners = rotatedCorners(c.pts[0], c.pts[1], c.pts[2]);
    c.ctx.beginPath();
    c.ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) c.ctx.lineTo(corners[i].x, corners[i].y);
    c.ctx.closePath();
    withFill(c, () => c.ctx.fill());
    applyStroke(c);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    shapeLabel(c, boundsOf(corners), 'center', 'middle');
  },
  distance: (x, y, h) => {
    if (h.pts.length < 3) return null;
    const corners = rotatedCorners(h.pts[0], h.pts[1], h.pts[2]);
    if (h.drawing.style.fill === true && pointInPolygon(x, y, corners)) return 0;
    let best = Infinity;
    for (let i = 0; i < 4; i++) {
      best = Math.min(best, distToSegment(x, y, corners[i], corners[(i + 1) % 4]));
    }
    return best;
  },
};

/**
 * The four corners of a rotated rectangle: `a` to `b` is one edge, and `c` is
 * projected onto the perpendicular to give the depth.
 */
function rotatedCorners(a: ScreenPoint, b: ScreenPoint, c: ScreenPoint): ScreenPoint[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // Unit normal to the a-b edge; the signed projection of `c` onto it is depth.
  const nx = -dy / len;
  const ny = dx / len;
  const depth = (c.x - b.x) * nx + (c.y - b.y) * ny;
  return [
    a, b,
    { x: b.x + nx * depth, y: b.y + ny * depth },
    { x: a.x + nx * depth, y: a.y + ny * depth },
  ];
}

/** Even-odd point-in-polygon, for filled shapes that are not axis-aligned. */
function pointInPolygon(x: number, y: number, poly: readonly ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Double curve: an S through three anchors. `curve` bends one way off a single
 * control; this mirrors that control about the midpoint so the second half bends
 * back, which is the shape a rounded top-then-bottom actually needs.
 */
export const DOUBLE_CURVE: DrawingTool = {
  id: 'double-curve', name: 'Double Curve', points: 3,
  settings: LINE_SETTINGS,
  draw: (c) => {
    if (c.pts.length < 3) return;
    const [a, mid, b] = c.pts;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    // Second control is `mid` reflected through the chord's midpoint.
    c.ctx.bezierCurveTo(mid.x, mid.y, a.x + b.x - mid.x, a.y + b.y - mid.y, b.x, b.y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    if (h.pts.length < 3) return null;
    const [a, mid, b] = h.pts;
    const c2 = { x: a.x + b.x - mid.x, y: a.y + b.y - mid.y };
    return distToPolyline(x, y, sampleCubic(a, mid, c2, b, 24));
  },
};

/** Flatten a cubic bezier to `steps` segments, for hit-testing curves. */
function sampleCubic(a: ScreenPoint, c1: ScreenPoint, c2: ScreenPoint, b: ScreenPoint, steps: number): ScreenPoint[] {
  const out: ScreenPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    out.push({
      x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
      y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y,
    });
  }
  return out;
}

// ── cycles ────────────────────────────────────────────────────────────────

/** How many repeats a cycle tool draws past its two anchors. */
const CYCLE_REPEATS = 12;

/**
 * Cyclic lines: vertical lines repeating at the interval the two anchors set,
 * for reading a rhythm forward off a measured swing.
 */
export const CYCLIC_LINES: DrawingTool = {
  id: 'cyclic-lines', name: 'Cyclic Lines', points: 2,
  defaultStyle: { lineStyle: 'dashed' },
  settings: LINE_SETTINGS,
  draw: (c) => {
    const [a, b] = c.pts;
    const step = b.x - a.x;
    if (!Number.isFinite(step) || Math.abs(step) < 0.5) return;
    const h = c.rc.plotHeight * c.rc.dpr;
    const w = c.rc.plotWidth * c.rc.dpr;
    applyStroke(c);
    c.ctx.beginPath();
    for (let i = 0; i <= CYCLE_REPEATS; i++) {
      const x = Math.round(a.x + step * i) + 0.5;
      if (x < 0 || x > w) continue;   // off-plot repeats cost nothing to skip
      c.ctx.moveTo(x, 0);
      c.ctx.lineTo(x, h);
    }
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    void y;
    const step = h.pts[1].x - h.pts[0].x;
    if (!Number.isFinite(step) || Math.abs(step) < 0.5) return null;
    // Distance to the nearest repeat, clamped to the ones actually drawn.
    const k = Math.round((x - h.pts[0].x) / step);
    if (k < 0 || k > CYCLE_REPEATS) return null;
    return Math.abs(x - (h.pts[0].x + step * k));
  },
};

/**
 * Time cycles: semicircles of the anchors' width repeating along the axis, the
 * classic cycle-projection overlay.
 */
export const TIME_CYCLES: DrawingTool = {
  id: 'time-cycles', name: 'Time Cycles', points: 2,
  settings: LINE_SETTINGS,
  draw: (c) => {
    const [a, b] = c.pts;
    const step = b.x - a.x;
    if (!Number.isFinite(step) || Math.abs(step) < 1) return;
    const r = Math.abs(step) / 2;
    applyStroke(c);
    c.ctx.beginPath();
    for (let i = 0; i < CYCLE_REPEATS; i++) {
      const cx = a.x + step * i + step / 2;
      if (cx + r < 0 || cx - r > c.rc.plotWidth * c.rc.dpr) continue;
      c.ctx.moveTo(cx + r, a.y);
      c.ctx.arc(cx, a.y, r, 0, Math.PI, true);   // upper half only
    }
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const [a, b] = h.pts;
    const step = b.x - a.x;
    if (!Number.isFinite(step) || Math.abs(step) < 1) return null;
    const r = Math.abs(step) / 2;
    let best = Infinity;
    for (let i = 0; i < CYCLE_REPEATS; i++) {
      const cx = a.x + step * i + step / 2;
      // Distance to the rim, and only the drawn (upper) half counts.
      if (y > a.y + 2) continue;
      best = Math.min(best, Math.abs(Math.hypot(x - cx, y - a.y) - r));
    }
    return Number.isFinite(best) ? best : null;
  },
};

/**
 * Sine line: a full wave between the anchors. The horizontal span is one
 * period, the vertical offset its amplitude.
 */
export const SINE_LINE: DrawingTool = {
  id: 'sine-line', name: 'Sine Line', points: 2,
  settings: LINE_SETTINGS,
  draw: (c) => {
    const pts = sinePoints(c.pts[0], c.pts[1]);
    if (pts === null) return;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.ctx.lineTo(pts[i].x, pts[i].y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const pts = sinePoints(h.pts[0], h.pts[1]);
    return pts === null ? null : distToPolyline(x, y, pts);
  },
};

/** One period of a sine from `a` to `a.x + span`, amplitude `b.y - a.y`. */
function sinePoints(a: ScreenPoint, b: ScreenPoint): ScreenPoint[] | null {
  const span = b.x - a.x;
  const amp = b.y - a.y;
  if (!Number.isFinite(span) || Math.abs(span) < 1) return null;
  const steps = 64;
  const out: ScreenPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push({ x: a.x + span * t, y: a.y + amp * Math.sin(t * Math.PI * 2) });
  }
  return out;
}

// ── notes & marks ─────────────────────────────────────────────────────────

/** The bubble marks share a colour, their content and a face; nothing else applies. */
const BUBBLE_SETTINGS: SettingsSchema = composeSettings([COLOR_FIELD, TEXT_VALUE_FIELD, FONT_FIELDS], { textIsContent: true });

/**
 * Price label: a pill of the anchored price with a tail pointing at the bar.
 * Reads its value off the anchor, so dragging it re-reads rather than going
 * stale the way a typed-in text would. Text, when given, replaces the price.
 */
export const PRICE_LABEL: DrawingTool = {
  id: 'price-label', name: 'Price Label', points: 1,
  settings: composeSettings([COLOR_FIELD, { ...TEXT_VALUE_FIELD, label: 'Text (blank shows the price)' }, FONT_FIELDS]),
  draw: (c) => {
    const p = c.pts[0];
    const d = c.rc.dpr;
    const text = contentOf(c.drawing, c.formatPrice(c.drawing.points[0].price));
    const box = calloutBox(c, [text], p.x + 18 * d, p.y - 30 * d, 12);
    calloutTail(c, box, p, c.style.color);
    calloutText(c, box, [text], c.style.color, 12);
  },
  distance: (x, y, h) => {
    // The anchor plus a generous box to its upper right: measuring the real
    // text needs a context the hit path does not have.
    const p = h.pts[0];
    const w = 64;
    const hgt = 22;
    const x0 = p.x + 18;
    const y0 = p.y - 30 - hgt / 2;
    if (x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + hgt) return 0;
    return Math.hypot(x - p.x, y - p.y) <= 10 ? 0 : null;
  },
};

/**
 * Callout: a text bubble on its own anchor with a tail back to the point it
 * annotates, so the note can sit clear of the price action it refers to.
 */
export const CALLOUT: DrawingTool = {
  id: 'callout', name: 'Callout', points: 2,
  defaultText: { value: 'Note', fontSize: 12 },
  settings: BUBBLE_SETTINGS,
  draw: (c) => {
    if (c.pts.length < 2) return;
    const [target, seat] = c.pts;
    const lines = contentOf(c.drawing, 'Note').split('\n');
    const box = calloutBox(c, lines, seat.x, seat.y, 12);
    calloutTail(c, box, target, c.style.color);
    calloutText(c, box, lines, c.style.color, 12);
  },
  distance: (x, y, h) => {
    if (h.pts.length < 2) return null;
    const [target, seat] = h.pts;
    // Bubble body, else the tail back to the annotated point.
    if (Math.abs(x - seat.x) <= 60 && Math.abs(y - seat.y) <= 16) return 0;
    return distToSegment(x, y, target, seat);
  },
};

/** Rounded bubble at (x, y) sized to `lines`; returns its device-px box. */
function calloutBox(
  c: DrawContext, lines: readonly string[], x: number, y: number, defaultSize: number,
): { x: number; y: number; w: number; h: number } {
  const d = c.rc.dpr;
  const t = textOf(c.drawing);
  const size = (t.fontSize ?? defaultSize) * d;
  c.ctx.save();
  c.ctx.font = fontOf(t, size);
  let textW = 0;
  for (const s of lines) textW = Math.max(textW, c.ctx.measureText(s).width);
  c.ctx.restore();
  const w = textW + 14 * d;
  const h = size * 1.4 * lines.length + 8 * d;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

/** Bubble fill plus the tail from it to `tip`. */
function calloutTail(
  c: DrawContext, box: { x: number; y: number; w: number; h: number }, tip: ScreenPoint, color: string,
): void {
  const d = c.rc.dpr;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const ang = Math.atan2(tip.y - cy, tip.x - cx);
  // Two base points either side of the bubble-to-tip direction, so the tail
  // always leaves from the edge facing the point it annotates.
  const base = 5 * d;
  const bx = cx + Math.cos(ang) * (box.w / 2 - base);
  const by = cy + Math.sin(ang) * (box.h / 2 - base);
  c.ctx.save();
  c.ctx.setLineDash([]);
  c.ctx.fillStyle = color;
  c.ctx.beginPath();
  c.ctx.moveTo(tip.x, tip.y);
  c.ctx.lineTo(bx - Math.sin(ang) * base, by + Math.cos(ang) * base);
  c.ctx.lineTo(bx + Math.sin(ang) * base, by - Math.cos(ang) * base);
  c.ctx.closePath();
  c.ctx.fill();
  c.ctx.beginPath();
  roundRectPath(c.ctx, box.x, box.y, box.w, box.h, 5 * d);
  c.ctx.fill();
  // Anchor dot, so the exact bar being annotated stays visible.
  c.ctx.beginPath();
  c.ctx.arc(tip.x, tip.y, 2.5 * d, 0, Math.PI * 2);
  c.ctx.fill();
  c.ctx.restore();
}

/** Bubble text, centred, in the block's colour or the one that contrasts with the bubble. */
function calloutText(
  c: DrawContext, box: { x: number; y: number; w: number; h: number },
  lines: readonly string[], color: string, defaultSize: number,
): void {
  const d = c.rc.dpr;
  const t = textOf(c.drawing);
  const size = (t.fontSize ?? defaultSize) * d;
  c.ctx.save();
  c.ctx.setLineDash([]);
  c.ctx.font = fontOf(t, size);
  c.ctx.textAlign = 'center';
  c.ctx.textBaseline = 'middle';
  c.ctx.fillStyle = t.color ?? contrastText(color);
  const lh = size * 1.4;
  const top = box.y + box.h / 2 - (lh * (lines.length - 1)) / 2;
  for (let i = 0; i < lines.length; i++) c.ctx.fillText(lines[i], box.x + box.w / 2, top + lh * i);
  c.ctx.restore();
}

/** A one-anchor glyph: outline plus an optional fill, nothing else applies. */
const MARK_SETTINGS: SettingsSchema = composeSettings([LINE_FIELDS, FILL_FIELDS]);

/** Flag mark: a pennant on a pole at one anchor, for tagging a bar. */
export const FLAG_MARK: DrawingTool = {
  id: 'flag-mark', name: 'Flag Mark', points: 1,
  defaultStyle: { fill: true, fillOpacity: 0.95 },
  settings: MARK_SETTINGS,
  draw: (c) => {
    const p = c.pts[0];
    const d = c.rc.dpr;
    const pole = 22 * d;
    const flagW = 15 * d;
    const flagH = 11 * d;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(p.x, p.y);
    c.ctx.lineTo(p.x, p.y - pole);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    // Pennant off the top of the pole, notched on its trailing edge.
    c.ctx.beginPath();
    c.ctx.moveTo(p.x, p.y - pole);
    c.ctx.lineTo(p.x + flagW, p.y - pole + flagH * 0.28);
    c.ctx.lineTo(p.x + flagW * 0.72, p.y - pole + flagH * 0.5);
    c.ctx.lineTo(p.x + flagW, p.y - pole + flagH * 0.72);
    c.ctx.lineTo(p.x, p.y - pole + flagH);
    c.ctx.closePath();
    // The pennant is filled unless asked not to be: an outlined flag is a
    // legitimate, quieter mark.
    if (c.style.fill !== false) {
      c.ctx.save();
      c.ctx.globalAlpha = c.style.fillOpacity ?? 0.95;
      c.ctx.fillStyle = fillStyleOf(c);
      c.ctx.fill();
      c.ctx.restore();
    }
    c.ctx.stroke();
  },
  distance: (x, y, h) => {
    const p = h.pts[0];
    // Pole plus the pennant box hanging off its top.
    if (x >= p.x - 4 && x <= p.x + 16 && y >= p.y - 24 && y <= p.y + 2) return 0;
    return Math.hypot(x - p.x, y - p.y) <= 8 ? 0 : null;
  },
};


/* ── annotations ───────────────────────────────────────────────────────────
 * Tools whose whole job is to put a human sentence on the chart. They share
 * the plate-and-tail machinery the callout already had, because a note, a
 * balloon and a comment differ in where the tail leaves the plate and how the
 * plate is shaped, not in anything structural.
 */

/** How an annotation's plate is drawn when its text block sets nothing. */
interface PlateDefaults {
  /** Font size in media px. */
  size: number;
  /** Plate opacity, 0..1. */
  opacity: number;
}

/**
 * A plate of text with its top-left at (x, y), returned in device px.
 *
 * Distinct from `calloutBox`, which centres on a point: an annotation that
 * grows downward from where it was dropped stays where the user put it as the
 * text is typed, while a centred one creeps upward a half-line at a time.
 */
function notePlate(
  c: DrawContext, lines: readonly string[], x: number, y: number, def: PlateDefaults,
): { x: number; y: number; w: number; h: number } {
  const d = c.rc.dpr;
  const t = textOf(c.drawing);
  const size = (t.fontSize ?? def.size) * d;
  c.ctx.save();
  c.ctx.font = fontOf(t, size);
  let textW = 0;
  for (const s of lines) textW = Math.max(textW, c.ctx.measureText(s).width);
  c.ctx.restore();
  return { x, y, w: textW + 16 * d, h: size * 1.45 * lines.length + 10 * d };
}

/** The plate's colour: the text block's own, else the drawing's. */
function plateColor(c: DrawContext): string {
  return c.drawing.text?.backgroundColor ?? c.style.color;
}

/** Fill the plate, stroke its border, and lay the lines inside it. */
function paintPlate(
  c: DrawContext,
  box: { x: number; y: number; w: number; h: number },
  lines: readonly string[],
  def: PlateDefaults,
  radius = 6,
): void {
  const d = c.rc.dpr;
  const t = textOf(c.drawing);
  const size = (t.fontSize ?? def.size) * d;
  const bg = plateColor(c);
  c.ctx.save();
  c.ctx.setLineDash([]);
  c.ctx.globalAlpha = t.backgroundOpacity ?? def.opacity;
  c.ctx.fillStyle = bg;
  c.ctx.beginPath();
  roundRectPath(c.ctx, box.x, box.y, box.w, box.h, radius * d);
  c.ctx.fill();
  c.ctx.globalAlpha = 1;
  if (t.border === true) {
    c.ctx.strokeStyle = t.borderColor ?? c.style.color;
    c.ctx.lineWidth = Math.max(1, c.style.lineWidth * d);
    c.ctx.stroke();
  }
  c.ctx.font = fontOf(t, size);
  c.ctx.textAlign = 'left';
  c.ctx.textBaseline = 'middle';
  c.ctx.fillStyle = t.color ?? contrastText(bg);
  const lh = size * 1.45;
  const top = box.y + box.h / 2 - (lh * (lines.length - 1)) / 2;
  for (let i = 0; i < lines.length; i++) {
    c.ctx.fillText(lines[i], box.x + 8 * d, top + lh * i);
  }
  c.ctx.restore();
}

/** Inside the plate, in media px. Annotations are grabbable anywhere on them. */
function insidePlate(
  x: number, y: number, bx: number, by: number, w: number, h: number,
): number | null {
  return x >= bx && x <= bx + w && y >= by && y <= by + h ? 0 : null;
}

/**
 * The plate a hit test assumes, in media px.
 *
 * Hit testing runs without a canvas, so the real text cannot be measured. A
 * fixed box is the honest approximation: it is generous enough that a plate is
 * always grabbable, and the anchor dot below catches the rest.
 */
function notePlateGuess(d: Drawing, lines: number, def: PlateDefaults): { w: number; h: number } {
  const size = d.text?.fontSize ?? def.size;
  return { w: 120, h: size * 1.45 * Math.max(1, lines) + 10 };
}

const linesOf = (d: Drawing, fallback: string): number => contentOf(d, fallback).split('\n').length;

/** A plate on a stem: the stem's colour and width apply, and the plate's text surface. */
const STEMMED_NOTE_SETTINGS: SettingsSchema = composeSettings(
  [COLOR_FIELD, LINE_WIDTH_FIELD, PLATE_TEXT_FIELDS], { textIsContent: true },
);
/** A plate with a tail: only the colour applies outside the text surface. */
const TAILED_NOTE_SETTINGS: SettingsSchema = composeSettings([COLOR_FIELD, PLATE_TEXT_FIELDS], { textIsContent: true });

const NOTE_PLATE: PlateDefaults = { size: 12, opacity: 0.95 };

/**
 * Note: a pin at the bar with its text to the upper right.
 *
 * The pin is the point being annotated and the plate is the annotation, which
 * is why the two are drawn as separate marks joined by a stem rather than as
 * one bubble: the reader needs to see exactly which bar is meant, and a bubble
 * wide enough to hold a sentence covers several.
 */
export const NOTE: DrawingTool = {
  id: 'note', name: 'Note', points: 1,
  defaultText: { value: 'Note', fontSize: NOTE_PLATE.size },
  settings: STEMMED_NOTE_SETTINGS,
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.pts[0];
    const lines = contentOf(c.drawing, 'Note').split('\n');
    const box = notePlate(c, lines, p.x + 16 * d, p.y - 34 * d, NOTE_PLATE);
    c.ctx.save();
    c.ctx.setLineDash([]);
    c.ctx.strokeStyle = c.style.color;
    c.ctx.lineWidth = Math.max(1, c.style.lineWidth * d);
    c.ctx.beginPath();
    c.ctx.moveTo(p.x, p.y);
    c.ctx.lineTo(box.x, box.y + box.h);
    c.ctx.stroke();
    // The pin head, so the annotated bar stays identifiable at any zoom.
    c.ctx.fillStyle = c.style.color;
    c.ctx.beginPath();
    c.ctx.arc(p.x, p.y, 3.5 * d, 0, Math.PI * 2);
    c.ctx.fill();
    c.ctx.restore();
    paintPlate(c, box, lines, NOTE_PLATE);
  },
  distance: (x, y, h) => {
    const p = h.pts[0];
    const g = notePlateGuess(h.drawing, linesOf(h.drawing, 'Note'), NOTE_PLATE);
    const hit = insidePlate(x, y, p.x + 16, p.y - 34, g.w, g.h);
    if (hit !== null) return hit;
    return Math.hypot(x - p.x, y - p.y) <= 8 ? 0 : null;
  },
};

const BALLOON_PLATE: PlateDefaults = { size: 12, opacity: 0.95 };

/**
 * Balloon: a speech bubble sitting above its anchor, tail pointing down.
 *
 * One anchor rather than the callout's two: a balloon is for saying something
 * *about this bar*, so letting the bubble be dragged away from what it labels
 * would only invite it to drift.
 */
export const BALLOON: DrawingTool = {
  id: 'balloon', name: 'Balloon', points: 1,
  defaultText: { value: 'Balloon', fontSize: BALLOON_PLATE.size },
  settings: TAILED_NOTE_SETTINGS,
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.pts[0];
    const lines = contentOf(c.drawing, 'Balloon').split('\n');
    const size = notePlate(c, lines, 0, 0, BALLOON_PLATE);
    const box = { x: p.x - size.w / 2, y: p.y - size.h - 12 * d, w: size.w, h: size.h };
    c.ctx.save();
    c.ctx.setLineDash([]);
    c.ctx.globalAlpha = c.drawing.text?.backgroundOpacity ?? BALLOON_PLATE.opacity;
    c.ctx.fillStyle = plateColor(c);
    c.ctx.beginPath();
    c.ctx.moveTo(p.x, p.y);
    c.ctx.lineTo(p.x - 6 * d, box.y + box.h);
    c.ctx.lineTo(p.x + 6 * d, box.y + box.h);
    c.ctx.closePath();
    c.ctx.fill();
    c.ctx.restore();
    paintPlate(c, box, lines, BALLOON_PLATE, 8);
  },
  distance: (x, y, h) => {
    const p = h.pts[0];
    const g = notePlateGuess(h.drawing, linesOf(h.drawing, 'Balloon'), BALLOON_PLATE);
    const hit = insidePlate(x, y, p.x - g.w / 2, p.y - g.h - 12, g.w, g.h);
    if (hit !== null) return hit;
    return Math.hypot(x - p.x, y - p.y) <= 8 ? 0 : null;
  },
};

const COMMENT_PLATE: PlateDefaults = { size: 11, opacity: 0.92 };

/**
 * Comment: a small square-cornered box with a tail off its bottom left.
 *
 * Deliberately plainer than the balloon: a chart that says something at every
 * other bar needs one of these marks to be quiet, and the shape is the only
 * thing distinguishing them once both are the user's own colour.
 */
export const COMMENT: DrawingTool = {
  id: 'comment', name: 'Comment', points: 1,
  defaultText: { value: 'Comment', fontSize: COMMENT_PLATE.size },
  settings: TAILED_NOTE_SETTINGS,
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.pts[0];
    const lines = contentOf(c.drawing, 'Comment').split('\n');
    const size = notePlate(c, lines, 0, 0, COMMENT_PLATE);
    const box = { x: p.x + 8 * d, y: p.y - size.h - 10 * d, w: size.w, h: size.h };
    c.ctx.save();
    c.ctx.setLineDash([]);
    c.ctx.globalAlpha = c.drawing.text?.backgroundOpacity ?? COMMENT_PLATE.opacity;
    c.ctx.fillStyle = plateColor(c);
    c.ctx.beginPath();
    c.ctx.moveTo(p.x, p.y);
    c.ctx.lineTo(box.x, box.y + box.h - 5 * d);
    c.ctx.lineTo(box.x + 10 * d, box.y + box.h);
    c.ctx.closePath();
    c.ctx.fill();
    c.ctx.restore();
    paintPlate(c, box, lines, COMMENT_PLATE, 3);
  },
  distance: (x, y, h) => {
    const p = h.pts[0];
    const g = notePlateGuess(h.drawing, linesOf(h.drawing, 'Comment'), COMMENT_PLATE);
    const hit = insidePlate(x, y, p.x + 8, p.y - g.h - 10, g.w, g.h);
    if (hit !== null) return hit;
    return Math.hypot(x - p.x, y - p.y) <= 8 ? 0 : null;
  },
};

const SIGNPOST_PLATE: PlateDefaults = { size: 11, opacity: 0.95 };

/**
 * Signpost: a post standing on the bar with its plate at the top.
 *
 * The one annotation anchored to *time* rather than to a level: the post is
 * vertical so the plate can clear the price action entirely while the foot
 * still names an exact bar. Useful for events, which happen at a moment and
 * not at a price.
 */
export const SIGNPOST: DrawingTool = {
  id: 'signpost', name: 'Signpost', points: 1,
  defaultText: { value: 'Event', fontSize: SIGNPOST_PLATE.size },
  settings: STEMMED_NOTE_SETTINGS,
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.pts[0];
    const post = 34 * d;
    const lines = contentOf(c.drawing, 'Event').split('\n');
    const size = notePlate(c, lines, 0, 0, SIGNPOST_PLATE);
    c.ctx.save();
    c.ctx.setLineDash([]);
    c.ctx.strokeStyle = c.style.color;
    c.ctx.lineWidth = Math.max(1, c.style.lineWidth * d);
    c.ctx.beginPath();
    c.ctx.moveTo(p.x, p.y);
    c.ctx.lineTo(p.x, p.y - post);
    c.ctx.stroke();
    c.ctx.fillStyle = c.style.color;
    c.ctx.beginPath();
    c.ctx.arc(p.x, p.y, 3 * d, 0, Math.PI * 2);
    c.ctx.fill();
    c.ctx.restore();
    paintPlate(c, { x: p.x - size.w / 2, y: p.y - post - size.h, w: size.w, h: size.h }, lines, SIGNPOST_PLATE, 4);
  },
  distance: (x, y, h) => {
    const p = h.pts[0];
    const g = notePlateGuess(h.drawing, linesOf(h.drawing, 'Event'), SIGNPOST_PLATE);
    const hit = insidePlate(x, y, p.x - g.w / 2, p.y - 34 - g.h, g.w, g.h);
    if (hit !== null) return hit;
    // The post itself, so a signpost whose plate is off-pane stays grabbable.
    return Math.abs(x - p.x) <= 5 && y >= p.y - 34 && y <= p.y + 4 ? 0 : null;
  },
};

const PRICE_NOTE_PLATE: PlateDefaults = { size: 11, opacity: 0.95 };

/**
 * Price note: the anchored price, with the user's text under it.
 *
 * The price is read off the anchor rather than typed, so dragging the note
 * re-reads it. A typed price is a number that was true once, which on a chart
 * is worse than no number at all.
 */
export const PRICE_NOTE: DrawingTool = {
  id: 'price-note', name: 'Price Note', points: 1,
  defaultText: { value: 'Note', fontSize: PRICE_NOTE_PLATE.size },
  settings: STEMMED_NOTE_SETTINGS,
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.pts[0];
    const lines = [c.formatPrice(c.drawing.points[0].price), ...contentOf(c.drawing, 'Note').split('\n')];
    const box = notePlate(c, lines, p.x + 14 * d, p.y - 12 * d, PRICE_NOTE_PLATE);
    c.ctx.save();
    c.ctx.setLineDash([]);
    c.ctx.strokeStyle = c.style.color;
    c.ctx.lineWidth = Math.max(1, c.style.lineWidth * d);
    c.ctx.beginPath();
    c.ctx.moveTo(p.x, p.y);
    c.ctx.lineTo(box.x, p.y);
    c.ctx.stroke();
    c.ctx.restore();
    paintPlate(c, box, lines, PRICE_NOTE_PLATE, 4);
  },
  distance: (x, y, h) => {
    const p = h.pts[0];
    const g = notePlateGuess(h.drawing, linesOf(h.drawing, 'Note') + 1, PRICE_NOTE_PLATE);
    const hit = insidePlate(x, y, p.x + 14, p.y - 12, g.w, g.h);
    if (hit !== null) return hit;
    return Math.hypot(x - p.x, y - p.y) <= 8 ? 0 : null;
  },
};

const TABLE_SIZE = 11;
const TABLE_OPACITY = 0.92;

/**
 * Table: rows of text in a grid, anchored top-left.
 *
 * Cells come from the text: a newline starts a row and a pipe separates
 * columns, so a whole table is one editable string and survives `getState`
 * with no new shape in the drawing model. The first row is drawn as a header
 * because a table on a chart is nearly always labelled.
 */
export const TABLE: DrawingTool = {
  id: 'table', name: 'Table', points: 1,
  defaultText: { value: 'Level|Price\nEntry|-\nStop|-', fontSize: TABLE_SIZE },
  settings: composeSettings([
    COLOR_FIELD,
    { ...LINE_WIDTH_FIELD, label: 'Border width' },
    TEXT_VALUE_FIELD,
    FONT_FIELDS,
    { path: 'text.backgroundColor', label: 'Background color', kind: 'color', group: 'text' },
    { path: 'text.backgroundOpacity', label: 'Background opacity', kind: 'opacity', min: 0, max: 1, step: 0.01, group: 'text' },
    { path: 'text.border', label: 'Border', kind: 'boolean', group: 'text' },
    { path: 'text.borderColor', label: 'Border color', kind: 'color', group: 'text' },
  ], { textIsContent: true }),
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.pts[0];
    const t = textOf(c.drawing);
    const rows = tableRows(c.drawing);
    const size = (t.fontSize ?? TABLE_SIZE) * d;
    const pad = 7 * d;
    const rowH = size * 1.7;
    c.ctx.save();
    c.ctx.font = fontOf(t, size);
    // Column widths are the widest cell in each column, so a table with one
    // long label does not stretch every other column to match it.
    const cols = Math.max(...rows.map((r) => r.length));
    const widths: number[] = [];
    for (let i = 0; i < cols; i++) {
      let w = 0;
      for (const r of rows) w = Math.max(w, c.ctx.measureText(r[i] ?? '').width);
      widths.push(w + pad * 2);
    }
    const total = widths.reduce((a, b) => a + b, 0);
    const h = rowH * rows.length;
    c.ctx.setLineDash([]);
    c.ctx.globalAlpha = t.backgroundOpacity ?? TABLE_OPACITY;
    c.ctx.fillStyle = t.backgroundColor ?? c.rc.theme.background;
    c.ctx.beginPath();
    roundRectPath(c.ctx, p.x, p.y, total, h, 4 * d);
    c.ctx.fill();
    c.ctx.globalAlpha = 1;
    // A table is bordered unless told otherwise: the grid is what makes the
    // numbers read as a table rather than as loose text.
    if (t.border !== false) {
      c.ctx.strokeStyle = t.borderColor ?? c.style.color;
      c.ctx.lineWidth = Math.max(1, c.style.lineWidth * d);
      c.ctx.stroke();
      // Rules between rows and columns, drawn faintly: the grid should organise
      // the numbers, not compete with them.
      c.ctx.globalAlpha = 0.45;
      c.ctx.beginPath();
      for (let r = 1; r < rows.length; r++) {
        c.ctx.moveTo(p.x, p.y + rowH * r);
        c.ctx.lineTo(p.x + total, p.y + rowH * r);
      }
      let cx = p.x;
      for (let i = 0; i < widths.length - 1; i++) {
        cx += widths[i];
        c.ctx.moveTo(cx, p.y);
        c.ctx.lineTo(cx, p.y + h);
      }
      c.ctx.stroke();
      c.ctx.globalAlpha = 1;
    }
    c.ctx.textBaseline = 'middle';
    c.ctx.textAlign = 'left';
    // The header is a step heavier than the body, and a step heavier again
    // when the body itself is bold, so it stays the header either way.
    const headFont = fontOf(t, size, t.bold === true ? '800' : '600');
    const bodyFont = fontOf(t, size);
    for (let r = 0; r < rows.length; r++) {
      c.ctx.fillStyle = t.color ?? c.style.color;
      c.ctx.font = r === 0 ? headFont : bodyFont;
      let x = p.x;
      for (let i = 0; i < widths.length; i++) {
        c.ctx.fillText(rows[r][i] ?? '', x + pad, p.y + rowH * r + rowH / 2);
        x += widths[i];
      }
    }
    c.ctx.restore();
  },
  distance: (x, y, h) => {
    const p = h.pts[0];
    const rows = tableRows(h.drawing);
    const size = h.drawing.text?.fontSize ?? TABLE_SIZE;
    // Width cannot be measured without a canvas, so a column-count estimate.
    const cols = Math.max(...rows.map((r) => r.length));
    return insidePlate(x, y, p.x, p.y, cols * 70, size * 1.7 * rows.length);
  },
};

/** Rows of cells from the pipe-and-newline encoding. Always at least one cell. */
function tableRows(d: Drawing): string[][] {
  // An empty table is an empty grid, which reads as a rendering fault rather
  // than as a table waiting for content, so it falls back like the rest.
  return contentOf(d, 'Level|Price').split('\n').map((r) => r.split('|'));
}

/**
 * Measurers. `measure` reports price *and* time together; these two constrain it
 * to one axis, which is what you want when the other one is noise: sizing a
 * retracement without caring how long it took, or counting bars to an event
 * without caring where price went.
 */
export const PRICE_RANGE: DrawingTool = {
  id: 'price-range', name: 'Price Range', points: 2,
  defaultStyle: { fill: true, showLabels: true, fillOpacity: 0.1 },
  settings: MEASURE_SETTINGS,
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.drawing.points;
    const chg = p[1].price - p[0].price;
    const pct = p[0].price !== 0 ? (chg / p[0].price) * 100 : 0;
    const up = chg >= 0;
    const tint = up ? UP_TINT : DOWN_TINT;
    // Span the drawn x-range so the band reads as a price zone, not a bare line.
    const x0 = Math.min(c.pts[0].x, c.pts[1].x);
    const x1 = Math.max(c.pts[0].x, c.pts[1].x) + (c.pts[0].x === c.pts[1].x ? 60 * d : 0);
    const y0 = c.pts[0].y;
    const y1 = c.pts[1].y;
    c.ctx.save();
    c.ctx.globalAlpha = c.style.fillOpacity ?? 0.1;
    c.ctx.fillStyle = tint;
    c.ctx.fillRect(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0));
    c.ctx.restore();
    applyStroke(c);
    c.ctx.strokeStyle = tint;
    c.ctx.beginPath();
    for (const y of [y0, y1]) { c.ctx.moveTo(x0, Math.round(y) + 0.5); c.ctx.lineTo(x1, Math.round(y) + 0.5); }
    // The measured leg, with arrow heads at both ends.
    const mx = (x0 + x1) / 2;
    c.ctx.moveTo(mx, y0); c.ctx.lineTo(mx, y1);
    const dir = y1 > y0 ? 1 : -1;
    c.ctx.moveTo(mx - 4 * d, y1 - 5 * d * dir); c.ctx.lineTo(mx, y1); c.ctx.lineTo(mx + 4 * d, y1 - 5 * d * dir);
    c.ctx.moveTo(mx - 4 * d, y0 + 5 * d * dir); c.ctx.lineTo(mx, y0); c.ctx.lineTo(mx + 4 * d, y0 + 5 * d * dir);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    if (c.style.showLabels === false) return;
    const sign = up ? '+' : '';
    label(c, `${sign}${c.formatPrice(chg)}  (${sign}${pct.toFixed(2)}%)`, mx + 6 * d, (y0 + y1) / 2, tint);
  },
  distance: (x, y, h) => distToRect(x, y, h.pts[0], h.pts[1], true),
};

export const DATE_RANGE: DrawingTool = {
  id: 'date-range', name: 'Date Range', points: 2,
  defaultStyle: { fill: true, showLabels: true, fillOpacity: 0.1 },
  settings: composeSettings([LINE_FIELDS, OPACITY_FIELD, SHOW_LABELS_FIELD, FONT_FIELDS]),
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.drawing.points;
    const tint = c.style.color;
    const x0 = c.pts[0].x;
    const x1 = c.pts[1].x;
    const y0 = Math.min(c.pts[0].y, c.pts[1].y);
    const y1 = Math.max(c.pts[0].y, c.pts[1].y) + (c.pts[0].y === c.pts[1].y ? 40 * d : 0);
    c.ctx.save();
    c.ctx.globalAlpha = c.style.fillOpacity ?? 0.1;
    c.ctx.fillStyle = tint;
    c.ctx.fillRect(Math.min(x0, x1), y0, Math.abs(x1 - x0), y1 - y0);
    c.ctx.restore();
    applyStroke(c);
    c.ctx.beginPath();
    for (const x of [x0, x1]) { c.ctx.moveTo(Math.round(x) + 0.5, y0); c.ctx.lineTo(Math.round(x) + 0.5, y1); }
    const my = (y0 + y1) / 2;
    c.ctx.moveTo(x0, my); c.ctx.lineTo(x1, my);
    const dir = x1 > x0 ? 1 : -1;
    c.ctx.moveTo(x1 - 5 * d * dir, my - 4 * d); c.ctx.lineTo(x1, my); c.ctx.lineTo(x1 - 5 * d * dir, my + 4 * d);
    c.ctx.moveTo(x0 + 5 * d * dir, my - 4 * d); c.ctx.lineTo(x0, my); c.ctx.lineTo(x0 + 5 * d * dir, my + 4 * d);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    if (c.style.showLabels === false) return;
    // Counted on logical indices, so it matches the gapless axis rather than
    // raw elapsed time (a weekend is not 48 bars).
    const i0 = c.rc.dataLayer.timeToIndexFloat(p[0].time);
    const i1 = c.rc.dataLayer.timeToIndexFloat(p[1].time);
    const bars = Math.abs(Math.round(i1 - i0));
    label(c, `${bars} bars`, (x0 + x1) / 2, y0 - 10 * d, tint);
  },
  distance: (x, y, h) => distToRect(x, y, h.pts[0], h.pts[1], true),
};

/**
 * Position forecast: project a move from an anchor. Two anchors give the
 * projected leg; the shape extends the same slope past the target as a dashed
 * cone, so the drawing says "if this continues" rather than just marking a line.
 */
export const FORECAST: DrawingTool = {
  id: 'forecast', name: 'Forecast', points: 2,
  defaultStyle: { fill: true, showLabels: true, fillOpacity: 0.12, lineStyle: 'dashed' },
  settings: MEASURE_SETTINGS,
  draw: (c) => {
    const d = c.rc.dpr;
    const p = c.drawing.points;
    const [a, b] = c.pts;
    const chg = p[1].price - p[0].price;
    const pct = p[0].price !== 0 ? (chg / p[0].price) * 100 : 0;
    const up = chg >= 0;
    const tint = up ? UP_TINT : DOWN_TINT;
    // The cone widens with the projected distance: a forecast is less certain
    // the further out it runs, and the shape should say so.
    const spread = Math.abs(b.y - a.y) * 0.35 + 6 * d;
    c.ctx.save();
    c.ctx.globalAlpha = c.style.fillOpacity ?? 0.12;
    c.ctx.fillStyle = tint;
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    c.ctx.lineTo(b.x, b.y - spread);
    c.ctx.lineTo(b.x, b.y + spread);
    c.ctx.closePath();
    c.ctx.fill();
    c.ctx.restore();
    applyStroke(c);
    c.ctx.strokeStyle = tint;
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    c.ctx.lineTo(b.x, b.y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    c.ctx.beginPath();
    c.ctx.arc(a.x, a.y, 3 * d, 0, Math.PI * 2);
    c.ctx.fillStyle = tint;
    c.ctx.fill();
    if (c.style.showLabels === false) return;
    const sign = up ? '+' : '';
    // Anchor chip: where the projection was struck from.
    chip(c, [c.formatPrice(p[0].price), isoDate(p[0].time)], a.x, a.y, tint, { align: 'center' });
    // Projection chip: the move, and what it lands on when.
    chip(c, [
      `${sign}${c.formatPrice(chg)} (${sign}${pct.toFixed(2)}%) in ${humanSpan(p[1].time - p[0].time)}`,
      `${c.formatPrice(p[1].price)}, ${isoDate(p[1].time)}`,
    ], b.x, b.y, tint, { align: 'center', place: 'below' });
    // Verdict, once the window has actually elapsed: did price get there? A
    // forecast nobody scores is just a line.
    const bars = c.rc.bars?.();
    if (bars !== undefined && bars.length > 0 && bars[bars.length - 1].time >= p[1].time) {
      let hit = false;
      for (const bar of bars) {
        if (bar.time < p[0].time) continue;
        if (bar.time > p[1].time) break;
        if (up ? bar.high >= p[1].price : bar.low <= p[1].price) { hit = true; break; }
      }
      chip(c, [hit ? 'SUCCESS' : 'MISSED'], b.x, b.y + 36 * d,
        hit ? '#4a934a' : '#8a4a4a', { align: 'center', place: 'below' });
    }
  },
  distance: (x, y, h) => distToSegment(x, y, h.pts[0], h.pts[1]),
};

// ── shapes ────────────────────────────────────────────────────────────────

/**
 * Circle from centre + a radius handle. The radius is measured in *pixels*, so
 * it stays a circle on screen instead of the ellipse the two axes' differing
 * scales would otherwise produce.
 */
export const CIRCLE: DrawingTool = {
  id: 'circle', name: 'Circle', points: 2,
  defaultStyle: { fill: true },
  settings: SHAPE_SETTINGS,
  draw: (c) => {
    const [a, b] = c.pts;
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    c.ctx.beginPath();
    c.ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
    withFill(c, () => c.ctx.fill());
    applyStroke(c);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    shapeLabel(c, { x0: a.x - r, y0: a.y - r, x1: a.x + r, y1: a.y + r }, 'center', 'middle');
  },
  distance: (x, y, h) => {
    const [a, b] = h.pts;
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    const d = Math.hypot(x - a.x, y - a.y);
    if (h.drawing.style.fill === true && d <= r) return 0;
    return Math.abs(d - r);
  },
};

export const TRIANGLE: DrawingTool = {
  id: 'triangle', name: 'Triangle', points: 3,
  defaultStyle: { fill: true },
  settings: SHAPE_SETTINGS,
  draw: (c) => {
    c.ctx.beginPath();
    c.ctx.moveTo(c.pts[0].x, c.pts[0].y);
    c.ctx.lineTo(c.pts[1].x, c.pts[1].y);
    c.ctx.lineTo(c.pts[2].x, c.pts[2].y);
    c.ctx.closePath();
    withFill(c, () => c.ctx.fill());
    applyStroke(c);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
    shapeLabel(c, boundsOf(c.pts.slice(0, 3)), 'center', 'middle');
  },
  distance: (x, y, h) => distToPolyline(x, y, [...h.pts, h.pts[0]]),
};

/** Free-form polyline: click each vertex, double-click to finish. */
export const POLYLINE: DrawingTool = {
  id: 'polyline', name: 'Polyline', points: 0,
  defaultStyle: { fill: false },
  settings: composeSettings([LINE_FIELDS, FILL_FIELDS]),
  draw: (c) => {
    if (c.pts.length < 2) return;
    c.ctx.beginPath();
    c.ctx.moveTo(c.pts[0].x, c.pts[0].y);
    for (let i = 1; i < c.pts.length; i++) c.ctx.lineTo(c.pts[i].x, c.pts[i].y);
    if (c.style.fill === true) { c.ctx.closePath(); withFill(c, () => c.ctx.fill()); }
    applyStroke(c);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => distToPolyline(x, y, h.pts),
};

/** Sample a quadratic whose control is derived so the curve passes through `m`. */
function quadPoints(a: ScreenPoint, m: ScreenPoint, b: ScreenPoint): ScreenPoint[] {
  const cx = 2 * m.x - (a.x + b.x) / 2;
  const cy = 2 * m.y - (a.y + b.y) / 2;
  const out: ScreenPoint[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y });
  }
  return out;
}

/** Arc through three anchors: the middle one is on the curve, not a handle. */
export const ARC: DrawingTool = {
  id: 'arc', name: 'Arc', points: 3,
  settings: LINE_SETTINGS,
  draw: (c) => {
    const [a, m, b] = c.pts;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    // Lift the control point so the curve passes *through* the middle anchor
    // rather than merely leaning toward it.
    c.ctx.quadraticCurveTo(2 * m.x - (a.x + b.x) / 2, 2 * m.y - (a.y + b.y) / 2, b.x, b.y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => distToPolyline(x, y, quadPoints(h.pts[0], h.pts[1], h.pts[2])),
};

/** Quadratic curve: the middle anchor is a control handle, off the curve. */
export const CURVE: DrawingTool = {
  id: 'curve', name: 'Curve', points: 3,
  settings: LINE_SETTINGS,
  draw: (c) => {
    const [a, m, b] = c.pts;
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    c.ctx.quadraticCurveTo(m.x, m.y, b.x, b.y);
    c.ctx.stroke();
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const [a, m, b] = h.pts;
    const pts: ScreenPoint[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const u = 1 - t;
      pts.push({ x: u * u * a.x + 2 * u * t * m.x + t * t * b.x, y: u * u * a.y + 2 * u * t * m.y + t * t * b.y });
    }
    return distToPolyline(x, y, pts);
  },
};

// ── arrows & brushes ──────────────────────────────────────────────────────

/** A single-anchor marker that points at a bar. `up` sits below, pointing up. */
function arrowMarker(
  id: string, name: string, up: boolean, axis: 'vertical' | 'left' | 'right' = 'vertical',
): DrawingTool {
  return {
    id, name, points: 1,
    defaultStyle: { fill: true, fillOpacity: 0.9 },
    settings: MARK_SETTINGS,
    draw: (c) => {
      const d = c.rc.dpr;
      const { x, y } = c.pts[0];
      const len = 16 * d;
      const w = 6 * d;
      const dir = up ? 1 : -1;
      // Offset off the anchor so the marker sits beside the bar, not on top of it.
      const tipY = y + dir * 2 * d;
      c.ctx.beginPath();
      if (axis !== 'vertical') {
        // The same arrow rotated a quarter turn: the shaft runs along x and the
        // head points at the bar, so a left or right mark reads as pointing
        // *into* the price action rather than along it.
        const h = axis === 'right' ? -1 : 1;
        const tipX = x + h * 2 * d;
        c.ctx.moveTo(tipX, y);
        c.ctx.lineTo(tipX + h * w, y - w);
        c.ctx.lineTo(tipX + h * w, y - w / 2.4);
        c.ctx.lineTo(tipX + h * len, y - w / 2.4);
        c.ctx.lineTo(tipX + h * len, y + w / 2.4);
        c.ctx.lineTo(tipX + h * w, y + w / 2.4);
        c.ctx.lineTo(tipX + h * w, y + w);
        c.ctx.closePath();
      } else {
        c.ctx.moveTo(x, tipY);
        c.ctx.lineTo(x - w, tipY + dir * w);
        c.ctx.lineTo(x - w / 2.4, tipY + dir * w);
        c.ctx.lineTo(x - w / 2.4, tipY + dir * len);
        c.ctx.lineTo(x + w / 2.4, tipY + dir * len);
        c.ctx.lineTo(x + w / 2.4, tipY + dir * w);
        c.ctx.lineTo(x + w, tipY + dir * w);
        c.ctx.closePath();
      }
      if (c.style.fill !== false) {
        c.ctx.save();
        c.ctx.globalAlpha = c.style.fillOpacity ?? 0.9;
        c.ctx.fillStyle = fillStyleOf(c);
        c.ctx.fill();
        c.ctx.restore();
      }
      applyStroke(c);
      c.ctx.stroke();
      c.ctx.setLineDash([]);
    },
    distance: (x, y, hc) => {
      const a = hc.pts[0];
      const dy = up ? y - a.y : a.y - y;
      return Math.abs(x - a.x) <= 8 && dy >= -4 && dy <= 20 ? 0 : null;
    },
  };
}
export const ARROW_UP = arrowMarker('arrow-up', 'Arrow Up', true);
export const ARROW_DOWN = arrowMarker('arrow-down', 'Arrow Down', false);
export const ARROW_LEFT = arrowMarker('arrow-left', 'Arrow Left', true, 'left');
export const ARROW_RIGHT = arrowMarker('arrow-right', 'Arrow Right', true, 'right');

/** Highlighter: the brush with a fat, translucent stroke. */
export const HIGHLIGHTER: DrawingTool = {
  id: 'highlighter', name: 'Highlighter', points: 0, freehand: true,
  defaultStyle: { lineWidth: 12, fillOpacity: 0.28 },
  settings: composeSettings([COLOR_FIELD, LINE_WIDTH_FIELD, OPACITY_FIELD, PRESSURE_FIELD]),
  draw: (c) => {
    if (c.pts.length < 2) return;
    c.ctx.setLineDash([]);
    ink(c, Math.max(2, (c.style.lineWidth || 12) * c.rc.dpr), c.style.fillOpacity ?? 0.28);
  },
  distance: (x, y, h) => {
    const d = distToPolyline(x, y, h.pts);
    return d <= Math.max(6, (h.drawing.style.lineWidth ?? 12) / 2) ? 0 : d;
  },
};

// ── fibonacci & gann ──────────────────────────────────────────────────────

/**
 * A ladder whose colours live entirely in its levels: the drawing's own colour
 * would touch nothing on screen, so it is not offered. Width and dash apply to
 * every rung.
 */
const LADDER_SETTINGS: SettingsSchema = composeSettings([LINE_WIDTH_FIELD, LINE_STYLE_FIELD, LEVEL_FIELDS, FONT_FIELDS]);

/** Fib channel: fib levels spread across a trend leg, parallel to it. */
export const FIB_CHANNEL: DrawingTool = {
  id: 'fib-channel', name: 'Fib Channel', points: 3,
  defaultStyle: { showLabels: true, levels: cloneLevels(DEFAULT_FIB) },
  settings: composeSettings([LINE_WIDTH_FIELD, LINE_STYLE_FIELD, LEVEL_FIELDS, EXTEND_FIELDS, FONT_FIELDS]),
  draw: (c) => {
    const levels = activeLevels(c.style.levels, DEFAULT_FIB);
    const [a, b, w] = c.pts;
    const d = c.rc.dpr;
    // The third anchor sets the channel width; each level is a fraction of it.
    const offX = w.x - b.x;
    const offY = w.y - b.y;
    const left = c.style.extendLeft === true;
    const right = c.style.extendRight === true;
    applyStroke(c);
    for (const lv of levels) {
      const [s, e] = extendSegment(
        { x: a.x + offX * lv.ratio, y: a.y + offY * lv.ratio },
        { x: b.x + offX * lv.ratio, y: b.y + offY * lv.ratio },
        c.rc.plotWidth * d, left, right,
      );
      const color = fibColor(lv);
      c.ctx.strokeStyle = color;
      c.ctx.beginPath();
      c.ctx.moveTo(s.x, s.y);
      c.ctx.lineTo(e.x, e.y);
      c.ctx.stroke();
      if (c.style.showLabels !== false) {
        label(c, fibText(lv), b.x + offX * lv.ratio + 4 * d, b.y + offY * lv.ratio, color);
      }
    }
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const levels = activeLevels(h.drawing.style.levels, DEFAULT_FIB);
    const [a, b, w] = h.pts;
    const left = h.drawing.style.extendLeft === true;
    const right = h.drawing.style.extendRight === true;
    let best = Infinity;
    for (const lv of levels) {
      const [s, e] = extendSegment(
        { x: a.x + (w.x - b.x) * lv.ratio, y: a.y + (w.y - b.y) * lv.ratio },
        { x: b.x + (w.x - b.x) * lv.ratio, y: b.y + (w.y - b.y) * lv.ratio },
        h.rc.plotWidth, left, right,
      );
      const dd = distToSegment(x, y, s, e);
      if (dd < best) best = dd;
    }
    return best;
  },
};

/**
 * Fib time zone: vertical lines at Fibonacci multiples of the base leg's width.
 * Its levels count bars rather than divide a leg, so they carry no convention
 * colour and fall back to the drawing's own.
 */
export const FIB_TIME_ZONE: DrawingTool = {
  id: 'fib-time-zone', name: 'Fib Time Zone', points: 2,
  defaultStyle: { showLabels: true, levels: cloneLevels(DEFAULT_FIB_TIME_ZONE) },
  settings: composeSettings([LINE_FIELDS, LEVEL_FIELDS, FONT_FIELDS]),
  draw: (c) => {
    const [a, b] = c.pts;
    const unit = b.x - a.x;
    if (Math.abs(unit) < 0.5) return;
    const d = c.rc.dpr;
    const maxX = c.rc.plotWidth * d;
    const levels = activeLevels(c.style.levels, DEFAULT_FIB_TIME_ZONE);
    applyStroke(c);
    for (const lv of levels) {
      const x = a.x + unit * lv.ratio;
      if (x < -10 || x > maxX + 10) continue;
      const color = lv.color ?? c.style.color;
      c.ctx.strokeStyle = color;
      c.ctx.beginPath();
      c.ctx.moveTo(Math.round(x) + 0.5, 0);
      c.ctx.lineTo(Math.round(x) + 0.5, c.rc.plotHeight * d);
      c.ctx.stroke();
      if (c.style.showLabels !== false) label(c, lv.label ?? String(lv.ratio), x + 3 * d, 12 * d, color);
    }
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    void y;
    const [a, b] = h.pts;
    const unit = b.x - a.x;
    if (Math.abs(unit) < 0.5) return null;
    let best = Infinity;
    for (const lv of activeLevels(h.drawing.style.levels, DEFAULT_FIB_TIME_ZONE)) {
      best = Math.min(best, Math.abs(x - (a.x + unit * lv.ratio)));
    }
    return Number.isFinite(best) ? best : null;
  },
};

/** Rays from the anchor at fib fractions of the leg: the speed resistance fan. */
export const FIB_FAN: DrawingTool = {
  id: 'fib-fan', name: 'Fib Speed Fan', points: 2,
  defaultStyle: { showLabels: true, levels: cloneLevels(DEFAULT_FIB_FAN) },
  settings: LADDER_SETTINGS,
  draw: (c) => {
    const levels = activeLevels(c.style.levels, DEFAULT_FIB_FAN);
    const [a, b] = c.pts;
    const d = c.rc.dpr;
    const maxX = c.rc.plotWidth * d;
    applyStroke(c);
    for (const lv of levels) {
      // Each ray takes the full run but a fraction of the rise.
      const end = extendSegment(a, { x: b.x, y: a.y + (b.y - a.y) * lv.ratio }, maxX, false, true)[1];
      const color = fibColor(lv);
      c.ctx.strokeStyle = color;
      c.ctx.beginPath();
      c.ctx.moveTo(a.x, a.y);
      c.ctx.lineTo(end.x, end.y);
      c.ctx.stroke();
      if (c.style.showLabels !== false) label(c, fibText(lv), b.x + 4 * d, a.y + (b.y - a.y) * lv.ratio, color);
    }
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const levels = activeLevels(h.drawing.style.levels, DEFAULT_FIB_FAN);
    const [a, b] = h.pts;
    let best = Infinity;
    for (const lv of levels) {
      best = Math.min(best, distToSegment(x, y, a,
        extendSegment(a, { x: b.x, y: a.y + (b.y - a.y) * lv.ratio }, h.rc.plotWidth, false, true)[1]));
    }
    return Number.isFinite(best) ? best : null;
  },
};

/**
 * Gann fan: rays from one anchor at the classic price/time angles. A level's
 * ratio is price per unit of time, so the 1x1 is 1, the 1x2 is 0.5 and the
 * 2x1 is 2; each angle keeps its own colour from the cycle palette.
 */
export const GANN_FAN: DrawingTool = {
  id: 'gann-fan', name: 'Gann Fan', points: 2,
  defaultStyle: { showLabels: true, levels: cloneLevels(DEFAULT_GANN_FAN) },
  settings: LADDER_SETTINGS,
  draw: (c) => {
    const [a, b] = c.pts;
    const d = c.rc.dpr;
    const maxX = c.rc.plotWidth * d;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 0.5) return;
    const levels = activeLevels(c.style.levels, DEFAULT_GANN_FAN);
    applyStroke(c);
    levels.forEach((lv, i) => {
      const end = extendSegment(a, { x: a.x + dx, y: a.y + dy * lv.ratio }, maxX, false, true)[1];
      const color = lv.color ?? cycleColor(i);
      c.ctx.strokeStyle = color;
      c.ctx.beginPath();
      c.ctx.moveTo(a.x, a.y);
      c.ctx.lineTo(end.x, end.y);
      c.ctx.stroke();
      if (c.style.showLabels !== false) label(c, lv.label ?? gannLabel(lv.ratio), b.x + 4 * d, a.y + dy * lv.ratio, color);
    });
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => {
    const [a, b] = h.pts;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (Math.abs(dx) < 0.5) return null;
    let best = Infinity;
    for (const lv of activeLevels(h.drawing.style.levels, DEFAULT_GANN_FAN)) {
      best = Math.min(best, distToSegment(x, y, a,
        extendSegment(a, { x: a.x + dx, y: a.y + dy * lv.ratio }, h.rc.plotWidth, false, true)[1]));
    }
    return Number.isFinite(best) ? best : null;
  },
};

/**
 * Gann box: the drawn rectangle divided at its levels on both axes, plus the
 * 1x1 diagonal. Ratio 0 is the first anchor's price and time, ratio 1 the
 * second's, so the box reads like a retracement laid over a date range.
 */
export const GANN_BOX: DrawingTool = {
  id: 'gann-box', name: 'Gann Box', points: 2,
  defaultStyle: { fill: true, fillOpacity: 0.05, showLabels: true, levels: cloneLevels(DEFAULT_GANN_BOX) },
  settings: composeSettings([LINE_FIELDS, FILL_FIELDS, LEVEL_FIELDS, FONT_FIELDS]),
  draw: (c) => {
    const [a, b] = c.pts;
    const r = rectOf(a, b);
    const d = c.rc.dpr;
    const p = c.drawing.points;
    const levels = activeLevels(c.style.levels, DEFAULT_GANN_BOX);
    withFill(c, () => c.ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0));
    // The diagonal first, in the drawing's colour: it is the 1x1 and the one
    // line of the box that is not a level.
    applyStroke(c);
    c.ctx.beginPath();
    c.ctx.moveTo(a.x, a.y);
    c.ctx.lineTo(b.x, b.y);
    c.ctx.stroke();
    for (const lv of levels) {
      const x = Math.round(a.x + (b.x - a.x) * lv.ratio) + 0.5;
      const price = p[0].price + (p[1].price - p[0].price) * lv.ratio;
      const y = Math.round(c.rc.priceScale.priceToY(price) * d) + 0.5;
      const color = fibColor(lv);
      c.ctx.strokeStyle = color;
      c.ctx.beginPath();
      c.ctx.moveTo(x, r.y0); c.ctx.lineTo(x, r.y1);
      c.ctx.moveTo(r.x0, y); c.ctx.lineTo(r.x1, y);
      c.ctx.stroke();
      if (c.style.showLabels !== false) label(c, fibText(lv), r.x1 + 4 * d, y, color);
    }
    c.ctx.setLineDash([]);
  },
  distance: (x, y, h) => distToRect(x, y, h.pts[0], h.pts[1], h.drawing.style.fill === true),
};

export const BUILTIN_DRAWING_TOOLS: readonly DrawingTool[] = [
  TREND_LINE, RAY, EXTENDED_LINE, ARROW,
  HORIZONTAL_LINE, HORIZONTAL_RAY, VERTICAL_LINE, CROSS_LINE,
  RECTANGLE, ELLIPSE, PARALLEL_CHANNEL,
  FIB_RETRACEMENT, FIB_EXTENSION,
  LONG_POSITION, SHORT_POSITION, FORECAST,
  MEASURE, PRICE_RANGE, DATE_RANGE,
  CIRCLE, TRIANGLE, POLYLINE, ARC, CURVE,
  ROTATED_RECTANGLE, DOUBLE_CURVE,
  ARROW_UP, ARROW_DOWN, HIGHLIGHTER, BRUSH,
  FIB_CHANNEL, FIB_TIME_ZONE, FIB_FAN, GANN_FAN, GANN_BOX,
  CYCLIC_LINES, TIME_CYCLES, SINE_LINE,
  TEXT, PATH, PRICE_LABEL, CALLOUT, FLAG_MARK,
  NOTE, BALLOON, COMMENT, SIGNPOST, PRICE_NOTE, TABLE,
  ARROW_LEFT, ARROW_RIGHT,
];

let _registered = false;

/** Register every built-in tool. Idempotent; called on tier import. */
export function registerBuiltinDrawingTools(): void {
  if (_registered) return;
  _registered = true;
  for (const t of BUILTIN_DRAWING_TOOLS) registerDrawingTool(t);
}

export type { ScreenPoint };
