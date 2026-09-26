/**
 * Glyphs for the drawing tools and for host chrome, as path data.
 *
 * The engine ships no DOM, and this does not change that: an icon here is a
 * string of SVG path commands, not an element. The host still builds its own
 * toolbar, flyouts and rail; what it no longer has to do is draw every glyph
 * before it can show them. `icon-svg.ts` turns these into markup strings for a
 * host that wants the convenience; this file is the single source both of them
 * and every other surface read from.
 *
 * That was the real cost of leaving them out. Every adopter drew their own set,
 * each drifted on stroke weight, grid and visual density independently, and the
 * result read as sixty icons rather than as one set, however carefully any
 * single glyph was made. A shipped set is worth more than a better glyph.
 *
 * # Two tiers, one line
 *
 * Tool glyphs live on a 24-unit grid and are shown at 24px in the rail. Host
 * chrome (undo, close, the settings tab rail) is shown at 16px beside them, and
 * a 24-grid glyph scaled to 16 lands its 2-unit stroke on 1.33 pixels, blurred
 * across two rows on every edge. So chrome has its own registry drawn on a
 * 16-unit grid. Both tiers draw a 2-unit stroke, and since each is shown at its
 * grid size, that is the same 2px line on screen in both rails: a lock under
 * the tools reads as part of the same set, only smaller.
 *
 * The chrome stroke was 1.5 through 2.5.5, chosen to match the tool weight as a
 * fraction of the box. On integer coordinates a 1.5 stroke covers 0.75 of two
 * pixel rows, so no edge was ever solid (0.18 of its inked pixels, against 0.59
 * for the tools). A 1px stroke on half-unit coordinates was tried as well: as
 * crisp on straight edges, but faint on every curve and visibly lighter than
 * the tool rail beside it, on both themes. Two it is, with the few glyphs that
 * were too dense for it redrawn with more air.
 *
 * # The grid
 *
 * Every glyph is authored to the same constraints, and `tests/draw-icons.test.ts`
 * enforces all of them mechanically, because a set of this size cannot be kept
 * consistent by review:
 *
 *  - **One viewBox per tier.** 24 by 24 for tools, 16 by 16 for chrome, so a
 *    host sets the size once per surface.
 *  - **A margin all round.** Live area 2 to 22 on the tool grid, 2 to 14 on the
 *    chrome grid, so the ink stops a pixel short of the box. Without it,
 *    glyphs that happen to reach the edge look larger than their neighbours
 *    and the rail reads as ragged.
 *  - **Integer coordinates.** With a stroke of 2, an orthogonal edge centred on
 *    an integer covers exactly two device pixels at 1:1, which is what makes it
 *    crisp.
 *  - **One stroke weight.** Different weights across identically sized boxes
 *    is the single most visible tell of a set assembled rather than drawn.
 *  - **The whole glyph in its path.** The marks that tell siblings apart (a
 *    segment ends in two dots, a ray starts at one, a path ends in a head)
 *    are small closed shapes drawn in the path itself, so a host that renders
 *    the path data and nothing else still gets every one of them. An accent
 *    registry repeats those marks for a fill on top: a dot then paints solid
 *    rather than as a ring, which adds weight, never identity.
 *
 * # Rendering
 *
 * Tool glyphs are crispest at 24px, and at any integer multiple of it. At 18px
 * the 0.75 scale puts a 2-unit stroke on 1.5 device pixels and every edge is
 * anti-aliased across two rows: that is a host sizing choice, not something the
 * path data can fix. Prefer 24, or 12 with a heavier weight. Chrome glyphs are
 * drawn for 16px and its multiples.
 */

/** The viewBox every glyph is authored in. */
export const ICON_VIEWBOX = '0 0 24 24';

/**
 * Stroke width in viewBox units. Paths carry no presentation attributes, so a
 * host that wants a lighter set overrides this once rather than editing glyphs.
 */
export const ICON_STROKE = 2;

/**
 * The attribute bag a tier hands its host. Structural, so the markup builders
 * in `icon-svg.ts` take either tier's bag through one signature.
 */
export interface IconAttrs {
  readonly viewBox: string;
  readonly fill: 'none';
  readonly stroke: 'currentColor';
  readonly strokeWidth: number;
  readonly strokeLinecap: 'round';
  readonly strokeLinejoin: 'round';
}

/** Attributes a host should apply to the `<svg>`, so every set matches. */
export const ICON_ATTRS = {
  viewBox: ICON_VIEWBOX,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: ICON_STROKE,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const satisfies IconAttrs;

/**
 * A round mark of radius `r` centred on a grid point: two half-turn arcs, so
 * the path closes where it starts. Stroked with the glyph's line, radius 1
 * paints a solid dot of radius 2, twice the line, which is what makes it read
 * as an anchor; radius 2 is a ring the accent fills.
 */
function dot(x: number, y: number, r = 1): string {
  return `M${x - r} ${y}a${r} ${r} 0 0 0 ${2 * r} 0a${r} ${r} 0 0 0 ${-2 * r} 0z`;
}

/*
 * The closed marks of the tool glyphs, written once: each is drawn in its
 * glyph's path and repeated in `DRAWING_TOOL_ACCENTS` for the fill.
 */
const MAGNET_CAPS = 'M5 3h2v3H5zM17 3h2v3h-2z';
const SEGMENT_ENDS = dot(6, 18) + dot(18, 6);
const RAY_ORIGIN = dot(4, 18);
const EXTENDED_DOTS = dot(8, 16) + dot(16, 8);
const ARROW_HEAD = 'M20 4l-2 8-6-6z';
const HRAY_ORIGIN = dot(8, 12);
const CROSS_CENTRE = dot(12, 12);
const PATH_HEAD = 'M20 8l-6 2 4 4z';
const POLYLINE_VERTICES = dot(4, 19, 2) + dot(9, 7, 2) + dot(14, 16, 2);
const LONG_DIRECTION = 'M10 11l3-4 3 4z';
const SHORT_DIRECTION = 'M10 13l3 4 3-4z';

/**
 * Path data by tool id, plus a few keys a host toolbar needs that are not
 * themselves tools (`cursor`, the group headers).
 *
 * Values are the `d` attribute of one `<path>`. Multiple subpaths are joined
 * into the same string rather than split across elements, so a host renders one
 * node per glyph, and that node is the whole glyph: its dots and heads are in
 * the string as outlines. `DRAWING_TOOL_ACCENTS` repeats those marks for a
 * host that also wants them filled.
 */
export const DRAWING_TOOL_ICONS: Readonly<Record<string, string>> = {
  // ── chrome ──────────────────────────────────────────────────────────────
  // A pointer, not a cross: the button puts the chart back in its plain mode,
  // and a cross beside the cross-line tool and a plus read as the same button.
  cursor: 'M6 3v15l4-4h7zM11 15l3 6',
  magnet: 'M6 7v5a6 6 0 0 0 12 0V7' + MAGNET_CAPS,

  // ── lines ───────────────────────────────────────────────────────────────
  // Told apart by their ends, which is what differs between the tools: two
  // anchor dots, one origin dot and an open end, dots inside a line that runs
  // to both edges, and a head. The ray also leaves at a shallower angle: on
  // the segment's diagonal, its open end ran through the segment's second
  // dot and the two overlapped by 87 percent at 24px. A line that extends
  // runs to the edge of the live area; one that stops ends on its dot.
  'trend-line': 'M6 18 18 6' + SEGMENT_ENDS,
  ray: 'M4 18 22 6' + RAY_ORIGIN,
  'extended-line': 'M2 22 22 2' + EXTENDED_DOTS,
  arrow: 'M4 20 15 9' + ARROW_HEAD,
  'horizontal-line': 'M2 12h20',
  // The ray leaves from its anchor a third of the way in and runs to the far
  // edge. Trimmed from the same line with its dot held only in the accent, it
  // was the horizontal line at 86 percent overlap for a host drawing the path.
  'horizontal-ray': 'M8 12h14' + HRAY_ORIGIN,
  'vertical-line': 'M12 2v20',
  'cross-line': 'M2 12h20M12 2v20' + CROSS_CENTRE,
  'trend-angle': 'M4 20 18 8M4 20h12M8 20a8 8 0 0 0 2-5',
  'info-line': 'M6 18 18 6M3 3h8v5H3z' + SEGMENT_ENDS,
  // A path points somewhere and a polyline only joins its vertices, which is
  // the difference between the tools: a head on one, vertex rings on the other.
  path: 'M3 20 7 7l5 9 5-5' + PATH_HEAD,
  polyline: 'M4 19 9 7l5 9 6-11' + POLYLINE_VERTICES,

  // ── channels ────────────────────────────────────────────────────────────
  'parallel-channel': 'M2 16 14 4M8 22 20 10',
  'disjoint-channel': 'M2 16 14 6M8 22 22 14',
  'flat-bottom': 'M2 14 14 4M2 20h20',
  'fib-channel': 'M2 14 14 4M4 18 16 8M6 22 18 12',
  'regression-trend': 'M2 18 20 6M4 20 22 8M2 14 20 2',

  'flat-top-bottom': 'M3 6h18M3 20 21 12M3 6v14',
  'regression-channel': 'M3 18 19 6M5 21 21 9M3 12 17 2M10 16h4',
  'pitchfork': 'M4 21 16 9M4 9 16 21M10 15 22 3M4 9 10 3M16 21l6-6',
  'schiff-pitchfork': 'M4 19 18 5M4 11 12 19M8 15 20 3M4 11l6-6M12 19l8-8',
  'modified-schiff-pitchfork': 'M4 20 20 4M4 12 12 20M8 16 20 4M4 12l8-8M12 20l8-8',
  'inside-pitchfork': 'M4 20 20 4M6 10 14 18M6 10l6-6M14 18l6-6',
  'fib-extension-two-point': 'M3 4h18M3 10h18M3 16h18M3 21h18M6 4v12',
  'fib-speed-resistance-fan': 'M3 21V3M3 21h18M3 21 21 3M3 21 12 3M3 21 21 12',
  'icon-stamp': 'M12 3l3 6 6 3-6 3-3 6-3-6-6-3 6-3z',
  // ── shapes ──────────────────────────────────────────────────────────────
  rectangle: 'M3 5h18v14H3z',
  'rotated-rectangle': 'M2 14 10 4l12 6-8 10z',
  ellipse: 'M12 5c5 0 9 3 9 7s-4 7-9 7-9-3-9-7 4-7 9-7z',
  circle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  triangle: 'M12 4 21 20H3z',
  arc: 'M3 19a12 12 0 0 1 18 0',
  curve: 'M3 18c4-12 14-12 18 0',
  'double-curve': 'M3 18c3-9 7-9 9 0 2 9 6 9 9 0',
  brush: 'M3 19c4 0 4-8 8-8s4 8 9 4',
  highlighter: 'M4 16 14 6l4 4-10 10H4z',

  // ── fibonacci and gann ──────────────────────────────────────────────────
  'fib-retracement': 'M3 4h18M3 9h18M3 14h18M3 19h18',
  'fib-extension': 'M3 5h18M3 12h18M3 19h18M8 5v14',
  'fib-fan': 'M3 20 21 4M3 20 21 10M3 20 21 16M3 20h18',
  'fib-time-zone': 'M4 3v18M8 3v18M14 3v18M22 3v18',
  'fib-circles': 'M12 20A5 5 0 0 1 12 10M12 20A9 9 0 0 1 12 2M10 20h4',
  'fib-spiral': 'M12 13A3 3 0 1 1 15 10A7 7 0 1 1 8 3A9 9 0 1 1 21 12',
  'fib-wedge': 'M3 20 21 4M3 20 21 12M3 20a12 12 0 0 0 10-6',
  'fib-speed-fan': 'M3 20V4M3 20h18M3 20 21 4M3 20 13 4',
  'gann-fan': 'M3 20 21 2M3 20 21 9M3 20 21 15M3 20h18',
  'gann-box': 'M3 3h18v18H3zM3 3l18 18M3 21 21 3',
  'trend-fib-time': 'M3 20 8 8 12 15M12 3v18M16 3v18M22 3v18',
  'fib-speed-resistance-arcs': 'M3 21a6 6 0 0 0 6-6M3 21a12 12 0 0 0 12-12M3 21a18 18 0 0 0 18-18M3 21 21 3',
  'gann-square': 'M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18M3 21 21 3',
  'dedekind-tessellation': 'M3 21a9 9 0 0 1 18 0M3 21a4 4 0 0 1 8 0M13 21a4 4 0 0 1 8 0M12 3v18',
  sonic: 'M3 12a9 9 0 0 1 18 0M6 12a6 6 0 0 1 12 0M9 12a3 3 0 0 1 6 0M3 12h18',
  supersonic: 'M3 12 21 3M3 12l18 9M7 12a5 5 0 0 1 10 0M10 12a3 3 0 0 1 6 0',
  'golden-sonic': 'M3 12a9 9 0 0 1 18 0M7 12a5 5 0 0 1 10 0M10 12a2 2 0 0 1 4 0M3 16h18M12 16v5',
  'golden-supersonic': 'M3 12 21 3M3 12l18 9M6 12a6 6 0 0 1 12 0M10 12a2 2 0 0 1 4 0M18 11v2',

  'xabcd-pattern': 'M3 19 7 4 12 16 16 8 21 20M3 19 12 16 21 20M7 4 16 8',
  'abcd-pattern': 'M3 18 9 4 15 15 21 3M3 18 15 15M9 4 21 3',
  'elliott-impulse': 'M2 21 6 12 9 17 13 5 17 11 22 2',
  'elliott-correction': 'M3 4 9 18 15 8 21 21M3 4h4M17 21h4',
  'head-shoulders': 'M2 20 5 10 8 17 12 3 16 17 19 10 22 20M3 17h18',
  gartley: 'M3 20 7 3 12 13 16 7 21 17M3 20 12 13 21 17',
  bat: 'M3 21 7 3 12 11 16 6 21 19M7 3 16 6M3 21 21 19',
  butterfly: 'M3 16 7 3 12 14 16 7 21 21M3 16 12 14 21 21',
  crab: 'M3 12 7 3 12 10 16 5 21 22M3 12 12 10 21 22',
  shark: 'M3 17 7 10 12 20 16 3 21 18M3 17 21 18M7 10 16 3',
  cypher: 'M3 20 7 9 12 16 16 3 21 18M3 20 12 16M7 9 16 3',

  // ── measure and range ───────────────────────────────────────────────────
  measure: 'M4 16h16M4 12v8M20 12v8M8 4h8M12 4v6',
  'anchored-vwap': 'M4 4v16M4 15 8 12 12 14 16 8 20 6M2 4h4',
  'fixed-range-volume-profile': 'M4 3v18M4 5h8v3H4M4 10h16v3H4M4 15h12v3H4',
  'price-range': 'M12 4v16M7 9l5-5 5 5M7 15l5 5 5-5',
  'date-range': 'M4 12h16M9 7l-5 5 5 5M15 7l5 5-5 5',
  'date-price-range': 'M5 6h14v12H5zM5 12h14M12 6v12',

  // ── cycles ──────────────────────────────────────────────────────────────
  'cyclic-lines': 'M4 4v16M10 4v16M16 4v16M22 4v16',
  'time-cycles': 'M4 12a4 4 0 0 1 8 0 4 4 0 0 0 8 0M4 4v16',
  'sine-line': 'M2 12c3-9 6-9 9 0 3 9 6 9 9 0',

  // ── positions and forecast ──────────────────────────────────────────────
  // A position is one frame split at the entry into its two zones, the
  // target the taller, with a tick out to the left at the entry price and
  // the direction solid in the target. A short is the long turned over.
  // They were one picture in 2.5.5, and the box over a thin stop bar that
  // replaced it read as an eject key or a laptop. The risk-reward pair
  // measures instead: from one entry line, the reward as a tall span with a
  // cap, the risk as a short one the other way, flipped for the short.
  'long-position': 'M2 14h4M6 3h15v17H6zM6 14h15' + LONG_DIRECTION,
  'short-position': 'M2 10h4M6 4h15v17H6zM6 10h15' + SHORT_DIRECTION,
  forecast: 'M3 18 9 10l4 4 8-10M13 4h8v8',
  'risk-reward-long': 'M2 14h20M8 14V3M5 3h6M17 14v6M14 20h6',
  'risk-reward-short': 'M2 10h20M8 10v11M5 21h6M17 10V4M14 4h6',

  // ── annotations ─────────────────────────────────────────────────────────
  text: 'M4 5h16M12 5v14M8 19h8',
  note: 'M4 20 9 15M9 5h13v10H9zM4 20v-4',
  // A callout's tail runs back to a point it annotates, well clear of the
  // box; a balloon's is a stub under its own anchor, and a comment's smaller.
  callout: 'M3 3h18v9H11l-6 8 1-8H3z',
  balloon: 'M3 4h18v12H9l-4 4v-4H3z',
  comment: 'M3 5h18v10H3zM6 15v4l4-4',
  signpost: 'M12 21V9M5 3h14v6H5z',
  'price-label': 'M3 12 8 7h13v10H8z',
  'price-note': 'M2 12h5M7 6h15v12H7zM10 12h9',
  table: 'M3 5h18v14H3zM3 10h18M9 10v9M15 10v9',
  'flag-mark': 'M6 21V3M6 3h12l-3 4 3 4H6',
  'arrow-up': 'M12 3v18M6 9l6-6 6 6',
  'arrow-down': 'M12 3v18M6 15l6 6 6-6',
  'arrow-left': 'M3 12h18M9 6l-6 6 6 6',
  'arrow-right': 'M3 12h18M15 6l6 6-6 6',
};

/**
 * The fills of the tool glyphs' marks, by tool id: anchor dots, pole caps and
 * arrowheads. Optional: most glyphs have none.
 *
 * Every mark here is also drawn, as an outline, in the glyph's own path, so a
 * host that renders only `DRAWING_TOOL_ICONS` still shows each one. This adds
 * the fill: a second `<path>` painted in `currentColor` with no stroke of its
 * own, after the glyph's path. The markup builders in `icon-svg.ts` add it; a
 * host wrapping the path data itself adds
 * `<path d="..." fill="currentColor" stroke="none"/>` for the same result.
 */
export const DRAWING_TOOL_ACCENTS: Readonly<Record<string, string>> = {
  magnet: MAGNET_CAPS,
  'trend-line': SEGMENT_ENDS,
  ray: RAY_ORIGIN,
  'extended-line': EXTENDED_DOTS,
  arrow: ARROW_HEAD,
  'horizontal-ray': HRAY_ORIGIN,
  'cross-line': CROSS_CENTRE,
  'info-line': SEGMENT_ENDS,
  path: PATH_HEAD,
  polyline: POLYLINE_VERTICES,
  'long-position': LONG_DIRECTION,
  'short-position': SHORT_DIRECTION,
};

/**
 * The glyph for a tool, or `undefined` when it has none.
 *
 * Undefined rather than a placeholder: a host that renders an empty box has a
 * visible gap to fix, while one handed a question mark ships it.
 */
export function drawingToolIcon(toolId: string): string | undefined {
  return DRAWING_TOOL_ICONS[toolId];
}

/** The filled accent for a tool glyph, or `undefined` when it has none. */
export function drawingToolAccent(toolId: string): string | undefined {
  return DRAWING_TOOL_ACCENTS[toolId];
}

/** Every id this set covers, for a host building a palette from it. */
export function drawingToolIconIds(): string[] {
  return Object.keys(DRAWING_TOOL_ICONS);
}

// ── the chrome tier ─────────────────────────────────────────────────────────

/** The viewBox every chrome glyph is authored in. */
export const CHROME_ICON_VIEWBOX = '0 0 16 16';

/**
 * Chrome stroke width in viewBox units. The same 2 as the tool tier, which at
 * the two native sizes is the same 2px line on screen. It was 1.5 through 2.5.5:
 * matched to the tool weight as a fraction of the box, and never crisp, since
 * a 1.5 stroke on whole units puts every edge three quarters of the way
 * across a pixel. See the file comment for the 1px alternative and why it
 * lost.
 */
export const CHROME_ICON_STROKE = 2;

/** Attributes a host should apply to the `<svg>` around a chrome glyph. */
export const CHROME_ICON_ATTRS = {
  viewBox: CHROME_ICON_VIEWBOX,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: CHROME_ICON_STROKE,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const satisfies IconAttrs;

/* The closed marks of the chrome glyphs, as above for the tools. */
const CHROME_MAGNET_CAPS = 'M3 2h2v2H3zM11 2h2v2h-2z';
const CHROME_PUPIL = dot(8, 8);
const CHROME_KNOBS = dot(5, 5, 2) + dot(11, 11, 2);
const CHROME_LENS = dot(8, 9);

/**
 * Path data for host chrome: the buttons around the chart rather than the
 * tools in it. Same rules as the tool tier (the whole glyph in one path, its
 * marks included; no presentation attributes; integer coordinates) on the 16
 * grid with a 2..14 live area.
 *
 * At a 2px line a 16px glyph has room for about four parallel strokes with a
 * pixel between them, so the dense glyphs are drawn with that in mind: two
 * sliders rather than three, a lens and a pupil as small solid dots rather
 * than rings, and no plus squeezed inside a square.
 *
 * The pair `cursor` / `magnet` / `text` also exist in the tool registry, at 24.
 * They are drawn twice on purpose: a rail button and a toolbar button are
 * different sizes, and the whole point of a second grid is not scaling one
 * drawing to both.
 */
export const CHROME_ICONS: Readonly<Record<string, string>> = {
  // ── pointer and snapping ────────────────────────────────────────────────
  // A pointer, not the cross it was: that cross overlapped `plus` by 92
  // percent at 16px.
  cursor: 'M4 2v10l3-3h5zM8 10l2 4',
  magnet: 'M4 5v3a4 4 0 0 0 8 0V5' + CHROME_MAGNET_CAPS,

  // ── state ───────────────────────────────────────────────────────────────
  // Unlocked swings the shackle off to the side. Leaving it in place with
  // one leg shortened, as before, let the round cap close the gap: the two
  // overlapped by more than 99 percent at 16px.
  lock: 'M3 8h10v6H3zM5 8V6a3 3 0 0 1 6 0v2',
  unlock: 'M3 8h10v6H3zM8 8V5a3 3 0 0 0-6 0',
  eye: 'M2 8c2-3 4-5 6-5s4 2 6 5c-2 3-4 5-6 5s-4-2-6-5z' + CHROME_PUPIL,
  'eye-off': 'M2 8c2-3 4-5 6-5s4 2 6 5c-2 3-4 5-6 5s-4-2-6-5zM3 3l10 10',
  star: 'M8 2l2 4h4l-3 3 1 5-4-3-4 3 1-5-3-3h4z',
  // A pentagram rather than the outline: filled with the default nonzero rule
  // its centre has a winding of two and fills solid, so one path is both a
  // star and its filled state. See CHROME_ICON_FILLED.
  'star-filled': 'M8 2l4 12-10-8h12L4 14z',

  // ── editing ─────────────────────────────────────────────────────────────
  trash: 'M2 4h12M6 4V2h4v2M3 4l1 10h8l1-10',
  settings: 'M2 5h12M2 11h12' + CHROME_KNOBS,
  undo: 'M3 6h7a4 4 0 0 1 0 8H6M6 3 3 6l3 3',
  redo: 'M13 6H6a4 4 0 0 0 0 8h4M10 3l3 3-3 3',
  copy: 'M6 6h8v8H6zM10 6V2H2v8h4',
  // A board with its clip and two lines of content: the empty board beside
  // the trash can's lid and handle overlapped it by 72 percent at 16px.
  paste: 'M3 3h10v11H3zM6 2h4v2H6zM6 8h4M6 11h4',
  // The copy of a square, as a square and a plus: a plus inside the front
  // square of `copy` leaves no pixel between the two at this weight.
  duplicate: 'M8 8h6v6H8zM5 2v6M2 5h6',
  front: 'M2 9h6v5H2zM11 14V2M8 5l3-3 3 3',
  back: 'M2 2h6v5H2zM11 2v12M8 11l3 3 3-3',
  text: 'M3 3h10M8 3v10M6 13h4',

  // ── navigation ──────────────────────────────────────────────────────────
  'chevron-down': 'M3 6l5 5 5-5',
  'chevron-right': 'M6 3l5 5-5 5',
  close: 'M3 3l10 10M13 3 3 13',
  plus: 'M8 2v12M2 8h12',
  minus: 'M2 8h12',
  search: 'M7 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 11l3 3',
  grid: 'M2 2h12v12H2zM2 8h12M8 2v12',
  // Two half links and the bar between them; unlinked drops the bar and
  // marks the break.
  link: 'M6 5H5a3 3 0 0 0 0 6h1M10 5h1a3 3 0 0 1 0 6h-1M6 8h4',
  unlink: 'M6 5H5a3 3 0 0 0 0 6h1M10 5h1a3 3 0 0 1 0 6h-1M8 2v1M8 13v1',

  // ── capture ─────────────────────────────────────────────────────────────
  camera: 'M2 5h3l1-2h4l1 2h3v8H2z' + CHROME_LENS,
  download: 'M8 2v9M4 7l4 4 4-4M2 14h12',
};

/**
 * The fills of the chrome glyphs' marks, as `DRAWING_TOOL_ACCENTS` is for the
 * tools: each mark is outlined in the glyph's path, and this paints it solid.
 * At 16px a ring of a 2px line is mostly line already, so the fill matters
 * most for the slider knobs.
 */
export const CHROME_ICON_ACCENTS: Readonly<Record<string, string>> = {
  magnet: CHROME_MAGNET_CAPS,
  eye: CHROME_PUPIL,
  settings: CHROME_KNOBS,
  camera: CHROME_LENS,
};

/**
 * Chrome glyphs meant to be painted solid. Paths carry no presentation
 * attributes, so the fill is applied by the wrapper (`chromeIconSvg` does it,
 * a host with its own wrapper reads this set) and the registry stays pure.
 */
export const CHROME_ICON_FILLED: ReadonlySet<string> = new Set(['star-filled']);

/** The chrome glyph for an id, or `undefined` when there is none. */
export function chromeIcon(id: string): string | undefined {
  return CHROME_ICONS[id];
}

/** The filled accent for a chrome glyph, or `undefined` when it has none. */
export function chromeIconAccent(id: string): string | undefined {
  return CHROME_ICON_ACCENTS[id];
}

/** Every id the chrome tier covers. */
export function chromeIconIds(): string[] {
  return Object.keys(CHROME_ICONS);
}
