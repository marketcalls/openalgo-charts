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
 * # Two tiers, one weight
 *
 * Tool glyphs live on a 24-unit grid and are shown at 24px in the rail. Host
 * chrome (undo, close, the settings tab rail) is shown at 16px beside them, and
 * a 24-grid glyph scaled to 16 lands its 2-unit stroke on 1.33 pixels, blurred
 * across two rows on every edge. So chrome has its own registry drawn on a
 * 16-unit grid with a 1.5 stroke. The two strokes are deliberately not in exact
 * proportion: a small glyph needs a slightly heavier relative stroke than a
 * large one to read as the same weight, and `tests/draw-icons.test.ts` holds
 * the chrome tier inside that band rather than at parity.
 *
 * # The grid
 *
 * Every glyph is authored to the same constraints, and `tests/draw-icons.test.ts`
 * enforces all of them mechanically, because a set of this size cannot be kept
 * consistent by review:
 *
 *  - **One viewBox per tier.** 24 by 24 for tools, 16 by 16 for chrome, so a
 *    host sets the size once per surface.
 *  - **A margin all round.** Live area 2 to 22 on the tool grid, 1 to 15 on the
 *    chrome grid. Without it, glyphs that happen to reach the edge look larger
 *    than their neighbours and the rail reads as ragged.
 *  - **Integer coordinates.** With `STROKE` of 2, an orthogonal edge centred on
 *    an integer covers exactly two device pixels at 1:1, which is what makes it
 *    crisp. Half-unit coordinates were the previous set's crispness bug: at a
 *    1.5 stroke on integers, nothing landed on a pixel boundary at any size.
 *  - **One stroke weight per tier.** Three different weights across identically
 *    sized boxes is the single most visible tell of a set assembled rather than
 *    drawn.
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
 * Path data by tool id, plus a few keys a host toolbar needs that are not
 * themselves tools (`cursor`, the group headers).
 *
 * Values are the `d` attribute of one `<path>`. Multiple subpaths are joined
 * into the same string rather than split across elements, so a host renders one
 * node per glyph.
 */
export const DRAWING_TOOL_ICONS: Readonly<Record<string, string>> = {
  // ── chrome ──────────────────────────────────────────────────────────────
  cursor: 'M12 3v6M12 15v6M3 12h6M15 12h6',
  magnet: 'M6 4v8a6 6 0 0 0 12 0V4M6 9h4M14 9h4',

  // ── lines ───────────────────────────────────────────────────────────────
  'trend-line': 'M4 20 20 4',
  ray: 'M4 20 20 4M2 18 6 22',
  'extended-line': 'M2 22 22 2',
  arrow: 'M4 20 18 6M18 6h-6M18 6v6',
  'horizontal-line': 'M2 12h20',
  'horizontal-ray': 'M6 12H22M4 10V14',
  'vertical-line': 'M12 2v20',
  'cross-line': 'M2 12h20M12 2v20',
  'trend-angle': 'M4 20 18 8M4 20h12M8 20a8 8 0 0 0 2-5',
  'info-line': 'M4 20 20 4M8 8h8',
  path: 'M2 18 8 8l4 6 4-10',
  polyline: 'M2 18 8 8l4 6 4-10 4 4',

  // ── channels ────────────────────────────────────────────────────────────
  'parallel-channel': 'M2 16 14 4M8 22 20 10',
  'disjoint-channel': 'M2 16 14 6M8 22 22 14',
  'flat-bottom': 'M2 14 14 4M2 20h20',
  'fib-channel': 'M2 14 14 4M4 18 16 8M6 22 18 12',
  'regression-trend': 'M2 18 20 6M4 20 22 8M2 14 20 2',

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

  // ── measure and range ───────────────────────────────────────────────────
  measure: 'M4 16h16M4 12v8M20 12v8M8 4h8M12 4v6',
  'price-range': 'M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4',
  'date-range': 'M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4',
  'date-price-range': 'M4 6h16v12H4zM4 12h16M12 6v12',

  // ── cycles ──────────────────────────────────────────────────────────────
  'cyclic-lines': 'M4 4v16M10 4v16M16 4v16M22 4v16',
  'time-cycles': 'M4 12a4 4 0 0 1 8 0 4 4 0 0 0 8 0M4 4v16',
  'sine-line': 'M2 12c3-9 6-9 9 0 3 9 6 9 9 0',

  // ── positions and forecast ──────────────────────────────────────────────
  'long-position': 'M3 15h18v5H3zM3 5h18v5H3zM12 10v5',
  'short-position': 'M3 5h18v5H3zM3 15h18v5H3zM12 10v5',
  forecast: 'M3 18 9 10l4 4 8-10M13 4h8v8',
  'risk-reward-long': 'M3 14h18v6H3zM3 4h18v6H3zM12 10v4M6 7h4',
  'risk-reward-short': 'M3 4h18v6H3zM3 14h18v6H3zM12 10v4M6 17h4',

  // ── annotations ─────────────────────────────────────────────────────────
  text: 'M4 5h16M12 5v14M8 19h8',
  note: 'M4 20 9 15M9 5h13v10H9zM4 20v-4',
  callout: 'M3 4h18v11H3zM8 15l-2 5 6-5',
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
 * The glyph for a tool, or `undefined` when it has none.
 *
 * Undefined rather than a placeholder: a host that renders an empty box has a
 * visible gap to fix, while one handed a question mark ships it.
 */
export function drawingToolIcon(toolId: string): string | undefined {
  return DRAWING_TOOL_ICONS[toolId];
}

/** Every id this set covers, for a host building a palette from it. */
export function drawingToolIconIds(): string[] {
  return Object.keys(DRAWING_TOOL_ICONS);
}

// ── the chrome tier ─────────────────────────────────────────────────────────

/** The viewBox every chrome glyph is authored in. */
export const CHROME_ICON_VIEWBOX = '0 0 16 16';

/**
 * Chrome stroke width in viewBox units. Not the tool stroke scaled (that would
 * be 1.33): at 16px a glyph needs a touch more relative weight than at 24px to
 * read as the same line, and 1.5 is where the two rails match by eye.
 */
export const CHROME_ICON_STROKE = 1.5;

/** Attributes a host should apply to the `<svg>` around a chrome glyph. */
export const CHROME_ICON_ATTRS = {
  viewBox: CHROME_ICON_VIEWBOX,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: CHROME_ICON_STROKE,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const satisfies IconAttrs;

/**
 * Path data for host chrome: the buttons around the chart rather than the
 * tools in it. Same rules as the tool tier (one path per glyph, no presentation
 * attributes, integer coordinates) on the 16 grid with a 1..15 live area.
 *
 * The pair `cursor` / `magnet` / `text` also exist in the tool registry, at 24.
 * They are drawn twice on purpose: a rail button and a toolbar button are
 * different sizes, and the whole point of a second grid is not scaling one
 * drawing to both.
 */
export const CHROME_ICONS: Readonly<Record<string, string>> = {
  // ── pointer and snapping ────────────────────────────────────────────────
  cursor: 'M8 2v4M8 10v4M2 8h4M10 8h4',
  magnet: 'M3 2v6a5 5 0 0 0 10 0V2M3 5h3M10 5h3',

  // ── state ───────────────────────────────────────────────────────────────
  lock: 'M3 7h10v7H3zM5 7V5a3 3 0 0 1 6 0v2',
  unlock: 'M3 7h10v7H3zM5 7V5a3 3 0 0 1 6 0',
  eye: 'M1 8c2-4 4-6 7-6s5 2 7 6c-2 4-4 6-7 6s-5-2-7-6zM10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  'eye-off': 'M1 8c2-4 4-6 7-6s5 2 7 6c-2 4-4 6-7 6s-5-2-7-6zM2 2l12 12',
  star: 'M8 1l2 5h5l-4 3 1 5-4-3-4 3 1-5-4-3h5z',
  // A pentagram rather than the outline: filled with the default nonzero rule
  // its centre has a winding of two and fills solid, so one path is both a
  // star and its filled state. See CHROME_ICON_FILLED.
  'star-filled': 'M8 1 12 14 1 6h14L4 14z',

  // ── editing ─────────────────────────────────────────────────────────────
  trash: 'M2 4h12M6 4V2h4v2M3 4l1 10h8l1-10',
  settings: 'M2 4h12M2 8h12M2 12h12M5 2v4M11 6v4M7 10v4',
  undo: 'M3 6h7a4 4 0 0 1 0 8H6M6 3 3 6l3 3',
  redo: 'M13 6H6a4 4 0 0 0 0 8h4M10 3l3 3-3 3',
  copy: 'M6 6h8v8H6zM10 6V2H2v8h4',
  paste: 'M4 3H3v11h10V3h-1M6 2h4v2H6z',
  duplicate: 'M6 6h8v8H6zM10 6V2H2v8h4M10 8v4M8 10h4',
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
  link: 'M6 10l4-4M7 4l1-1a3 3 0 0 1 4 4l-1 1M9 12l-1 1a3 3 0 0 1-4-4l1-1',
  unlink: 'M7 4l1-1a3 3 0 0 1 4 4l-1 1M9 12l-1 1a3 3 0 0 1-4-4l1-1M4 4l8 8',

  // ── capture ─────────────────────────────────────────────────────────────
  camera: 'M2 5h3l1-2h4l1 2h3v8H2zM8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  download: 'M8 2v9M4 7l4 4 4-4M2 14h12',
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

/** Every id the chrome tier covers. */
export function chromeIconIds(): string[] {
  return Object.keys(CHROME_ICONS);
}
