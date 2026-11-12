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
 * Tool glyphs live on a 24-unit grid and are shown at 20px in the rail. Host
 * chrome (undo, close, the settings tab rail) is shown at 16px beside them on
 * a registry of its own, drawn on a 16-unit grid, because a 24-grid glyph
 * scaled to 16 loses its detail. Each tier's stroke is set so that it lands
 * on the same line on screen at its display size: 1.6 units at 20px and 1.3
 * units at 16px are both about 1.3px, so a lock under the tools reads as part
 * of the same set, only smaller.
 *
 * Through 2.6.2 both tiers drew a 2-unit stroke at their grid size (24px and
 * 16px), which put every edge on a pixel boundary. Crisp, but a line half
 * again as wide on tool glyphs a fifth larger is nearly twice the ink, and a
 * rail of them read as heavy beside the chart it frames: on screen, weight is
 * noticed long before edge sharpness.
 * Earlier still the chrome stroke was 1.5 at 16px, the lightest of the three,
 * and the tool rail beside it the heaviest; one line across both is the rule
 * that survived every revision.
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
 *    chrome grid, so the ink stops short of the box. Without it, glyphs that
 *    happen to reach the edge look larger than their neighbours and the rail
 *    reads as ragged.
 *  - **Whole units for chrome, half units for tools.** Parallel strokes keep
 *    an even gap and a family of glyphs shares its anchor points, so siblings
 *    line up in a list. A 16px box has room for whole units and no more. The
 *    tool glyphs are authored on half units, and a stroke cut back to the
 *    edge of an anchor lands wherever its angle puts it, to two decimals.
 *    Through 2.6.9 the tools sat on whole units too, a rule made for a
 *    2-unit line shown at 24px, where a unit was a device pixel. At 20px a
 *    unit is five sixths of a pixel and nothing lands on one, so the rule
 *    bought no sharpness and cost every glyph its proportions: no corner
 *    could be rounded, no line could stop short of a mark, and every slope
 *    was one of a handful.
 *  - **One stroke weight.** Different weights across identically sized boxes
 *    is the single most visible tell of a set assembled rather than drawn.
 *  - **An anchor is an open ring, and a line stops at it.** A tool glyph is
 *    its drawing as the chart shows it selected, in miniature: the layer
 *    paints each point the user placed as a hollow handle, so the glyph
 *    draws each as a ring of radius 2 and ends its strokes on the ring's
 *    edge. The rings carry the reading: two at the ends are a segment, one
 *    at the start is a ray, two inside a line that runs on are an extended
 *    line, and one at each pivot is a pattern, a size smaller there so five
 *    of them fit. Through 2.6.9 an anchor was a dot of radius 1 with the line run
 *    into it, which at 20px was a blot three pixels across on the end of a
 *    stroke: too small to read as a point, and the same ink as the line.
 *  - **Corners are rounded.** A box, a bubble or a tag turns its corners on
 *    a radius of 1.5 to 2, so a frame reads as a drawn object and not as a
 *    table cell. The round join alone gave a radius of half the line.
 *  - **The whole glyph in its path.** The marks that tell siblings apart (a
 *    segment ends in two rings, a ray starts at one, a path ends in a head)
 *    are drawn in the path itself, so a host that renders the path data and
 *    nothing else still gets every one of them. An accent registry repeats
 *    the few marks meant solid (a magnet's poles) for a fill on top, which
 *    adds weight, never identity.
 *
 * # Rendering
 *
 * Tool glyphs are drawn for 20px and chrome glyphs for 16px, which is what
 * `iconSvg` and `chromeIconSvg` default to. A host that shows a glyph larger
 * scales the line with it; one that wants the same line at another size sets
 * the stroke to keep it near 1.3px.
 */

/** The viewBox every glyph is authored in. */
export const ICON_VIEWBOX = '0 0 24 24';

/**
 * The CSS pixel size a tool glyph is drawn for: the rail, a flyout row and
 * `iconSvg` by default.
 */
export const ICON_SIZE = 20;

/**
 * Stroke width in viewBox units: about 1.3px at `ICON_SIZE`. Paths carry no
 * presentation attributes, so a host that wants another weight overrides this
 * once rather than editing glyphs.
 */
export const ICON_STROKE = 1.6;

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

/** A coordinate as a path spells it: two decimals at most, no trailing zeros. */
const num = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * A round mark of radius `r` centred on a grid point: two half-turn arcs, so
 * the path closes where it starts. Stroked with the chrome line, radius 1
 * paints a near-solid dot over twice the line across, which is what makes it
 * read as a mark at 16px; radius 2 is a ring the accent fills.
 */
function dot(x: number, y: number, r = 1): string {
  return `M${num(x - r)} ${num(y)}a${r} ${r} 0 0 0 ${2 * r} 0a${r} ${r} 0 0 0 ${-2 * r} 0z`;
}

/**
 * A circle that stays open: the same two half turns as `dot`, at a radius the
 * line cannot fill. On the tool grid it is an anchor at its default radius,
 * the point a user places, and at any other a part of the drawing (a level,
 * a wave). Named apart because a ring is never a mark an accent paints solid.
 */
const ring = (x: number, y: number, r = 2): string => dot(x, y, r);

/**
 * A stroke from one point to another that stops `a` short of the first and
 * `b` short of the second: by a ring's radius where it ends on an anchor, so
 * the line meets the ring's edge at any angle and never crosses its centre.
 */
function link(x1: number, y1: number, x2: number, y2: number, a = 0, b = 0): string {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  return `M${num(x1 + ux * a)} ${num(y1 + uy * a)} ${num(x2 - ux * b)} ${num(y2 - uy * b)}`;
}

/** An upright box that turns its corners on radius `r`, clockwise from its top edge. */
function box(x: number, y: number, w: number, h: number, r = 2): string {
  const across = num(w - 2 * r);
  const down = num(h - 2 * r);
  return `M${num(x + r)} ${num(y)}h${across}a${r} ${r} 0 0 1 ${r} ${r}v${down}a${r} ${r} 0 0 1 ${-r} ${r}`
    + `h-${across}a${r} ${r} 0 0 1 ${-r} ${-r}v-${down}a${r} ${r} 0 0 1 ${r} ${-r}z`;
}

/**
 * The radius of a pivot ring, for a glyph that packs its points close: a
 * pattern's five pivots, a position's three levels. Its rings are a size
 * under an anchor's: at radius 2 the rings of neighbouring pivots closed on
 * each other and the legs between them were stubs.
 */
const PIVOT = 1.5;

/** A stroke through `points` in turn, cut back to the pivot ring at each, and those rings. */
function zigzag(points: readonly (readonly [number, number])[]): string {
  let legs = '';
  let rings = '';
  let from: readonly [number, number] | undefined;
  for (const to of points) {
    if (from !== undefined) legs += link(from[0], from[1], to[0], to[1], PIVOT, PIVOT);
    rings += ring(to[0], to[1], PIVOT);
    from = to;
  }
  return legs + rings;
}

/**
 * The characters an Elliott glyph is captioned with, as polylines of x, y
 * pairs from the character's top left, five units tall. Each polyline is one
 * command however often it turns, which keeps a captioned count in the set's
 * complexity band. `width` is where the character's middle falls, doubled:
 * the stem of a 1 is its middle, not the middle of its flag and stem.
 */
const CAPTION: Readonly<Record<string, { width: number; strokes: readonly (readonly number[])[] }>> = {
  1: { width: 2, strokes: [[0, 1, 1, 0, 1, 5]] },
  5: { width: 3, strokes: [[3, 0, 0, 0, 0, 2.5, 2.5, 2.5, 3, 3, 3, 4.5, 2.5, 5, 0, 5]] },
  A: { width: 3, strokes: [[0, 5, 1.5, 0, 3, 5], [0.5, 3.5, 2.5, 3.5]] },
  C: { width: 3, strokes: [[3, 0, 1, 0, 0, 1, 0, 4, 1, 5, 3, 5]] },
  E: { width: 3, strokes: [[3, 0, 0, 0, 0, 5, 3, 5], [0, 2.5, 2.5, 2.5]] },
  W: { width: 4, strokes: [[0, 0, 1, 5, 2, 1.5, 3, 5, 4, 0]] },
  Y: { width: 3, strokes: [[0, 0, 1.5, 2.5, 3, 0], [1.5, 2.5, 1.5, 5]] },
  Z: { width: 3, strokes: [[0, 0, 3, 0, 0, 5, 3, 5]] },
};

/** `char` across the top of the live area, centred on column `x`. */
function caption(x: number, char: string): string {
  const glyph = CAPTION[char]!; // only the counts below caption, with characters the table has
  const left = x - glyph.width / 2;
  return glyph.strokes.map(s => 'M' + s.map((v, i) => num(i % 2 === 0 ? left + v : 2 + v)).join(' ')).join('');
}

/**
 * An Elliott count: its pivots from the origin, ringed and joined, with its
 * first wave and its last named above the figure. The origin is a point, not
 * a wave, so it is not named, as the chart does not label it either.
 */
function count(points: readonly (readonly [number, number])[], first: string, last: string): string {
  return zigzag(points) + caption(points[1]![0], first) + caption(points[points.length - 1]![0], last); // two pivots or more
}

/**
 * A harmonic pattern through X, A, B, C and D, given as heights on five
 * evenly spaced columns, with a ring at each pivot, then the bases XB and BD
 * of the two triangles its tool fills. Price runs up the grid, so a smaller
 * number is a higher price.
 */
function harmonic(x: number, a: number, b: number, c: number, d: number): string {
  return zigzag([[3.5, x], [7.75, a], [12, b], [16.25, c], [20.5, d]])
    + link(3.5, x, 12, b, PIVOT, PIVOT) + link(12, b, 20.5, d, PIVOT, PIVOT);
}

/*
 * The marks of the tool glyphs that are written twice: each is drawn in its
 * glyph's path and repeated in `DRAWING_TOOL_ACCENTS` for the fill.
 */
const MAGNET_POLES = 'M5 3.5h4v4H5zM15 3.5h4v4h-4z';
/** A pitchfork's head: two outer tines and the crossbar between them. */
const FORK_HEAD = 'M5 2.5v8h14v-8';

/**
 * Path data by tool id, plus a few keys a host toolbar needs that are not
 * themselves tools (`cursor`, the group headers).
 *
 * Values are the `d` attribute of one `<path>`. Multiple subpaths are joined
 * into the same string rather than split across elements, so a host renders one
 * node per glyph, and that node is the whole glyph: its rings and heads are in
 * the string. `DRAWING_TOOL_ACCENTS` repeats the marks a host may also fill.
 */
export const DRAWING_TOOL_ICONS: Readonly<Record<string, string>> = {
  // ── chrome ──────────────────────────────────────────────────────────────
  // A pointer, not a cross: the button puts the chart back in its plain mode,
  // and a cross beside the cross-line tool and a plus read as the same button.
  // Drawn as the outline of the pointer with its tail: a bare wedge with a
  // stroke hanging off it, as before, read as a broken arrowhead.
  cursor: 'M6 3.5v14.5l3.9-3.6 2.6 6.1 2.3-1-2.6-6h5.3z',
  // Two legs and the two poles on them. One line bent into a U with squares
  // on its ends, as before, was a letter with serifs at 20px.
  magnet: 'M5 7.5V12a7 7 0 0 0 14 0V7.5M9 7.5V12a3 3 0 0 0 6 0V7.5' + MAGNET_POLES,

  // ── lines ───────────────────────────────────────────────────────────────
  // Told apart by their anchors, which is what differs between the tools: a
  // segment has one at each end, a ray one at its start and an open end, an
  // extended line two inside a line that runs to both edges, and an arrow
  // one at its tail and a head. The ray also leaves at a shallower angle: on
  // the segment's diagonal the two overlapped by 87 percent at 24px. A line
  // that extends runs to the edge of the live area; one that stops ends on
  // its ring. A horizontal or vertical line has the one anchor it is placed
  // by, at its middle, and the horizontal ray has it at its start.
  'trend-line': link(4.5, 19.5, 19.5, 4.5, 2, 2) + ring(4.5, 19.5) + ring(19.5, 4.5),
  ray: link(4.5, 18.5, 21.5, 6.5, 2) + ring(4.5, 18.5),
  'extended-line': link(2.5, 21.5, 8.5, 15.5, 0, 2) + link(8.5, 15.5, 15.5, 8.5, 2, 2) + link(15.5, 8.5, 21.5, 2.5, 2)
    + ring(8.5, 15.5) + ring(15.5, 8.5),
  // An open head. Filled, it was a wedge a third of the glyph's ink on the
  // end of a hairline.
  arrow: link(4.5, 19.5, 19.5, 4.5, 2) + 'M12.5 4.5h7v7' + ring(4.5, 19.5),
  'horizontal-line': 'M2.5 12H10M14 12h7.5' + ring(12, 12),
  'horizontal-ray': 'M6.5 12h15' + ring(4.5, 12),
  'vertical-line': 'M12 2.5V10M12 14v7.5' + ring(12, 12),
  'cross-line': 'M2.5 12H10M14 12h7.5M12 2.5V10M12 14v7.5' + ring(12, 12),
  'trend-angle': link(4.5, 19.5, 19.5, 6.5, 2) + 'M6.5 19.5h13M13.5 19.5A9 9 0 0 0 11.3 13.6' + ring(4.5, 19.5),
  // A segment that also labels itself: the plate, with a line of text in it.
  'info-line': link(4.5, 19.5, 19.5, 10.5, 2, 2) + ring(4.5, 19.5) + ring(19.5, 10.5) + box(2.5, 3, 10.5, 6.5, 1.5) + 'M5.5 6.25h4.5',
  // A path points somewhere and a polyline only joins its vertices, which is
  // the difference between the tools: a head on one, a ring to end the other.
  path: link(4.5, 19, 9.5, 9.5, 2, 2) + link(9.5, 9.5, 14.5, 15.5, 2, 2) + link(14.5, 15.5, 21, 5.5, 2) + 'M16 5.5h5v5'
    + ring(4.5, 19) + ring(9.5, 9.5) + ring(14.5, 15.5),
  polyline: link(4.5, 18.5, 9.5, 7.5, 2, 2) + link(9.5, 7.5, 14.5, 16, 2, 2) + link(14.5, 16, 19.5, 5.5, 2, 2)
    + ring(4.5, 18.5) + ring(9.5, 7.5) + ring(14.5, 16) + ring(19.5, 5.5),

  // ── channels ────────────────────────────────────────────────────────────
  // A channel is two rails, and the two plain ones ring both ends of both.
  // The disjoint channel places all four; the parallel one places three and
  // derives the second rail, but one rail with rings over a bare line read
  // as a segment with a stray stroke under it, not as a channel. The disjoint
  // rails close toward one side, far enough apart that their rings do not
  // touch. The rest carry two anchors on the line the user places, and the
  // lines the tool derives from it are bare, clear of the rings by more than
  // a line's width, or a ring and the stroke under it close up.
  'parallel-channel': link(4.5, 11.5, 19.5, 4.5, 2, 2) + link(4.5, 19.5, 19.5, 12.5, 2, 2)
    + ring(4.5, 11.5) + ring(19.5, 4.5) + ring(4.5, 19.5) + ring(19.5, 12.5),
  'disjoint-channel': link(4.5, 4.5, 19.5, 8.5, 2, 2) + link(4.5, 19.5, 19.5, 15.5, 2, 2)
    + ring(4.5, 4.5) + ring(19.5, 8.5) + ring(4.5, 19.5) + ring(19.5, 15.5),
  'flat-bottom': link(4.5, 12.5, 19.5, 4.5, 2, 2) + ring(4.5, 12.5) + ring(19.5, 4.5) + 'M2.5 19.5h19',
  'fib-channel': link(4.5, 10, 19.5, 4.5, 2, 2) + ring(4.5, 10) + ring(19.5, 4.5) + 'M4.5 15 19.5 9.5M4.5 21 19.5 15.5',
  // A regression line is fitted between its two anchors, with a band on
  // each side: the middle line is the placed one.
  'regression-trend': link(4.5, 15, 19.5, 9, 2, 2) + ring(4.5, 15) + ring(19.5, 9) + 'M4.5 9.5 19.5 3.5M4.5 20.5 19.5 14.5',

  'flat-top-bottom': 'M6.5 5h11' + ring(4.5, 5) + ring(19.5, 5) + 'M4.5 20.5 19.5 12.5',
  // The fitted line dashed between its two deviation bands, edge to edge. A
  // path carries no dash pattern (that would be a presentation attribute),
  // so a dashed line is the strokes it is made of.
  'regression-channel': 'M2.5 16 5.63 14.68M8.86 13.32 15.13 10.68M18.35 9.32 21.5 8M2.5 10.5 21.5 2.5M2.5 21.5 21.5 13.5',

  // ── pitchforks ──────────────────────────────────────────────────────────
  // One trident, upright so it reads as one, and the pivot as its anchor.
  // The four tools differ only in where the median starts, so that is what
  // the glyphs show, each as its tool constructs it, turned so the tines
  // point up: time runs up the glyph and price across it. The standard
  // median starts at the pivot. The Schiff median starts at the pivot's time
  // and halfway to the second anchor's price, so the handle stops short and
  // turns square to the pivot. The modified one also moves halfway in time,
  // to the middle of the swing from the pivot to the second anchor, and
  // draws that swing. The inside median starts on the crossbar itself; the
  // swing from the pivot to both crossbar ends stands for the lines that
  // tool draws below it. Drawn diagonally through 2.5.8, the four crossed
  // their tines through the handle and read as an X.
  pitchfork: FORK_HEAD + 'M12 2.5v15' + ring(12, 19.5),
  'schiff-pitchfork': FORK_HEAD + 'M12 2.5v12h5' + ring(19, 14.5),
  'modified-schiff-pitchfork': FORK_HEAD + 'M12 2.5V15' + link(5, 10.5, 19, 19.5, 0, 2) + ring(19, 19.5),
  // Its head is shorter than the one the other three share, and the swing
  // under it longer: on the shared head, with the pivot ring at the foot of
  // both, it was the standard fork at three quarters overlap at 20px.
  'inside-pitchfork': 'M5 2.5v6h14v-6M12 2.5v6' + link(5, 8.5, 12, 19.5, 0, 2) + link(19, 8.5, 12, 19.5, 0, 2) + ring(12, 19.5),

  // The two anchors stacked on the left, each at the level it sets, and the
  // levels projected past them.
  'fib-extension-two-point': 'M4.5 17.5v-3M6.5 19.5h15M6.5 12.5h15M2.5 8h19M2.5 3.5h19' + ring(4.5, 19.5) + ring(4.5, 12.5),
  // The tool marks the box its anchors span by the two far edges alone and
  // fans out to both from the first anchor: the diagonal, and the half level
  // on each edge. With the near axes it was the speed fan again with one
  // more ray; with the whole box it was the Gann box and Gann square beside
  // it in the same flyout, at 0.68 and 0.71 overlap. The two anchors are the
  // corner it fans from and the far corner, and the diagonal joins them.
  'fib-speed-resistance-fan': 'M4.5 4.5h13M19.5 6.5v13' + link(4.5, 19.5, 19.5, 4.5, 2, 2) + link(4.5, 19.5, 19.5, 12, 2)
    + link(4.5, 19.5, 12, 4.5, 2) + ring(4.5, 19.5) + ring(19.5, 4.5),
  // A four-point star with its sides drawn in, so it is not the diamond a
  // straight-sided one rasterises to at 20px.
  'icon-stamp': 'M12 2.5c0.6 5.2 4.3 8.9 9.5 9.5-5.2 0.6-8.9 4.3-9.5 9.5-0.6-5.2-4.3-8.9-9.5-9.5 5.2-0.6 8.9-4.3 9.5-9.5z',
  // ── shapes ──────────────────────────────────────────────────────────────
  // A shape carries the anchors that place it, as a line does: the two
  // opposite corners of a rectangle, the edge a rotated one is dragged out
  // from, a point on the rim of a circle or an ellipse, the three corners of
  // a triangle. Without them the first three were a stop key, a diamond and
  // a radio button.
  rectangle: 'M6.5 6H18a1.5 1.5 0 0 1 1.5 1.5V16M17.5 18H6a1.5 1.5 0 0 1-1.5-1.5V8' + ring(4.5, 6) + ring(19.5, 18),
  'rotated-rectangle': link(4.5, 13, 13.5, 5, 2, 2) + link(13.5, 5, 19.28, 11.5, 2) + 'M19.28 11.5 10.28 19.5'
    + link(10.28, 19.5, 4.5, 13, 0, 2) + ring(4.5, 13) + ring(13.5, 5),
  ellipse: 'M20.21 8.73A9.5 6.5 0 1 1 16.96 6.45' + ring(18.72, 7.4),
  circle: 'M19.25 7.56A8.5 8.5 0 1 1 16.44 4.75' + ring(18, 6),
  triangle: link(12, 4.5, 19.5, 19.5, 2, 2) + link(19.5, 19.5, 4.5, 19.5, 2, 2) + link(4.5, 19.5, 12, 4.5, 2, 2)
    + ring(12, 4.5) + ring(19.5, 19.5) + ring(4.5, 19.5),
  // An arc runs through its three anchors, the middle one on the curve; a
  // curve joins two and bows off the line between them. Both as a dome with
  // a ring at each foot, they overlapped as one glyph.
  arc: 'M5.19 14.62A7.69 7.69 0 0 1 10.02 10.76M13.98 10.76A7.69 7.69 0 0 1 18.81 14.62' + ring(4.5, 16.5) + ring(12, 10.5) + ring(19.5, 16.5),
  curve: 'M4.9 17.54C6.5 9.5 11.5 5.5 17.52 4.8' + ring(4.5, 19.5) + ring(19.5, 4.5),
  'double-curve': 'M5.5 10.3C7 5 10 5 12 12s5 7 6.5 1.7' + ring(4.5, 12) + ring(19.5, 12),
  // The tools themselves, since a freehand stroke has no anchors to show: a
  // brush with its head of bristles, and a marker over the line it has laid.
  // The squiggle the brush was drawn as before was the sine line again.
  brush: 'M13.5 10.5 20.5 3.5M13.5 10.5c2 2 1.7 5.2-0.6 6.8-2.6 1.8-6 1.2-8.9 2.7 1.5-2.9 0.9-6.3 2.7-8.9 1.6-2.3 4.8-2.6 6.8-0.6z',
  highlighter: 'M14.5 4.5l5 5-8.5 8.5-5-5zM6 13 4.5 19.5 11 18M13.5 20.5h8',

  // ── fibonacci and gann ──────────────────────────────────────────────────
  // Levels, and the anchors that set them. A retracement's two anchors sit
  // on its outer levels, and the inner pair are closer to each other than to
  // those, as 0.382 and 0.618 are. An extension projects its levels past the
  // swing its anchors mark. Four evenly spaced lines, as before, were a menu.
  'fib-retracement': 'M6.5 4.5h15M2.5 10h19M2.5 14h19M2.5 19.5h15' + ring(4.5, 4.5) + ring(19.5, 19.5),
  'fib-extension': 'M2.5 4h19M2.5 9h19' + link(4.5, 19.5, 19.5, 14.5, 2, 2) + ring(4.5, 19.5) + ring(19.5, 14.5),
  // The Fibonacci fan hangs its rays under the trend its two anchors mark;
  // the Gann fan spreads from one anchor about the diagonal. As two fans of
  // three rays and a base from one corner, they were one glyph twice.
  'fib-fan': link(4.5, 19.5, 19.5, 4.5, 2, 2) + ring(4.5, 19.5) + ring(19.5, 4.5) + link(4.5, 19.5, 21.5, 11, 2) + link(4.5, 19.5, 21.5, 16.5, 2),
  // The gaps grow as 4, 5 and 8 from the two lines the anchors set: the first
  // anchor is the origin and the second the unit. They are a pivot's size, an
  // anchor's would close on the next line, and set at two heights, as two
  // points placed on a chart are.
  'fib-time-zone': 'M4.5 2.5v11M4.5 16.5v5M8.5 2.5v5M8.5 10.5v11M13.5 2.5v19M21.5 2.5v19'
    + ring(4.5, 15, PIVOT) + ring(8.5, 9, PIVOT),
  // The tool rings one centre at each level, and that centre is its anchor.
  'fib-circles': ring(12, 12, 5.5) + ring(12, 12, 9.5) + ring(12, 12),
  // Quarter turns of radius 3, 5, 8 and 13 from the anchor the spiral
  // starts at, each leaving where the last ended and heading the same way:
  // the golden spiral the tool draws, in whole units. The last, radius 13,
  // turns 67 degrees rather than 90 and ends on a 5, 12, 13 triangle, which
  // keeps it on the grid and inside the box. The arcs it replaced did not
  // meet, and the last one, too short a chord for its radius, bulged out
  // past the edge as a tail. The turn of radius 2 it began with through
  // 2.6.9 is where the anchor's ring is now.
  'fib-spiral': 'M9.33 6.12A3 3 0 0 0 7 5 5 5 0 0 0 2 10 8 8 0 0 0 10 18 13 13 0 0 0 22 10' + ring(10, 8),
  // A sector: its three anchors, the two radii between them and its levels
  // as arcs. A 3, 4, 5 edge puts every level on whole units.
  'fib-wedge': 'M7 18h11' + link(5, 18, 14, 6, 2, 2) + 'M10 18A5 5 0 0 0 8 14M15 18A10 10 0 0 0 11 10M19.87 16.01A15 15 0 0 0 15.52 7.3'
    + ring(5, 18) + ring(20, 18) + ring(14, 6),
  'fib-speed-fan': 'M3 20V4M3 20h18M3 20 21 4M3 20 13 4',
  'gann-fan': link(4.5, 19.5, 21.5, 2.5, 2) + link(4.5, 19.5, 12.5, 2.5, 2) + link(4.5, 19.5, 21.5, 11, 2)
    + link(4.5, 19.5, 21.5, 15.5, 2) + ring(4.5, 19.5),
  // A box, wider than it is tall, where the Gann square beside it is square:
  // on one frame with the same two corners ringed, the two were one glyph at
  // 0.79 overlap.
  'gann-box': 'M17.5 6.5h-13v9M6.5 17.5h13v-9M4.5 6.5l15 11' + link(4.5, 17.5, 19.5, 6.5, 2, 2) + ring(4.5, 17.5) + ring(19.5, 6.5),
  'trend-fib-time': link(4.5, 19.5, 9, 8.5, 2, 2) + link(9, 8.5, 12.5, 15, 2) + ring(4.5, 19.5) + ring(9, 8.5)
    + 'M12.5 2.5v19M16.5 2.5v19M21.5 2.5v19',
  // Half circles about the trend's first anchor, turned to face along it,
  // with the trend through their crowns. Each arc's radius is written short
  // of its chord on purpose: SVG scales such a radius up to half the chord,
  // which makes the arc an exact half turn on a diagonal whose true radius
  // is not a whole number. The trend runs between its two anchors.
  'fib-speed-resistance-arcs': link(10, 14, 20, 4, 2, 2) + 'M3.5 7.5a9 9 0 0 1 13 13M6.5 10.5a4 4 0 0 1 7 7' + ring(10, 14) + ring(20, 4),
  'gann-square': 'M17.5 4.5h-13v13M6.5 19.5h13v-13M9.5 4.5v15M14.5 4.5v15M4.5 9.5h15M4.5 14.5h15'
    + link(4.5, 19.5, 19.5, 4.5, 2, 2) + ring(4.5, 19.5) + ring(19.5, 4.5),
  // The tool's own figure: a square as tall as the unit arcs, which stand on
  // its bottom corners, arcs a third as high on the same base, and the wall
  // at half. The half rings under a pole it replaced read as an umbrella.
  // Its anchors are the other pair of corners from the Gann square's: on the
  // same pair the two were 0.82 alike.
  'dedekind-tessellation': 'M6.5 4.5h13v13M4.5 6.5v13h13M6.5 4.63A15 15 0 0 1 19.37 17.5M19.5 4.5A15 15 0 0 0 4.5 19.5'
    + 'M4.5 19.5a5 5 0 0 1 10 0M9.5 19.5A5 5 0 0 1 19.1 17.54M12 4.5v15' + ring(4.5, 4.5) + ring(19.5, 19.5),
  // The four wave studies take two anchors, and the first wave's diameter
  // runs between them: so each glyph is that wave on its two rings, a
  // pivot's size since they sit on its rim. A sonic wave touches the
  // wavefront, the line across the first anchor, and the next wave is twice
  // it, centred on the second anchor. The golden one nests a wave at the
  // golden ratio inside the first instead. A supersonic wave sits in its
  // Mach cone, on the axis and tangent to both sides, as the tool draws it.
  // The two supersonic tools differ only in their levels, which one wave
  // cannot show, so the golden one keeps the narrower cone it has always had.
  // The half rings over a line the sonic pair were through 2.6.9, and the
  // half rings across the cone before that, matched nothing a tool draws.
  sonic: 'M4 2.5v8M4 13.5v8M12.75 13.48A4.5 4.5 0 0 1 4.25 13.48M4.25 10.52A4.5 4.5 0 0 1 12.75 10.52M4.13 10.51A9 9 0 1 1 4.13 13.49'
    + ring(4, 12, PIVOT) + ring(13, 12, PIVOT),
  supersonic: 'M18.95 2.5 2.5 12 18.95 21.5M16.51 13.48A4.75 4.75 0 0 1 7.49 13.48M7.49 10.52A4.75 4.75 0 0 1 16.51 10.52'
    + ring(7.25, 12, PIVOT) + ring(16.75, 12, PIVOT),
  'golden-sonic': 'M4 2.5v8M4 13.5v8M14.8 13.49A5.5 5.5 0 0 1 4.2 13.49M4.2 10.51A5.5 5.5 0 0 1 14.8 10.51M4.33 10.54A3.4 3.4 0 1 1 4.33 13.46'
    + ring(4, 12, PIVOT) + ring(15, 12, PIVOT),
  'golden-supersonic': 'M21.5 4.15 2.5 12 21.5 19.85M17.43 13.48A4.2 4.2 0 0 1 9.56 13.48M9.56 10.52A4.2 4.2 0 0 1 17.43 10.52'
    + ring(9.3, 12, PIVOT) + ring(17.7, 12, PIVOT),

  // ── patterns ────────────────────────────────────────────────────────────
  // A pattern is its pivots joined up, so each pivot the user places is a
  // ring, as an anchor is on a line, and the legs run between them. Bare
  // zigzags, as before, were lines folded at random: the pivots are what a
  // trader reads a pattern by. The general five-point pattern also joins A
  // to C, as its tool does to measure that leg; the four-point one joins A
  // to C and B to D. An Elliott count is its pivots from the origin it
  // starts at, under a caption naming its first wave and its last, and the
  // five counts are told apart by how they move as well: the impulse climbs
  // in five waves, the correction falls in three, the triangle narrows in
  // five, and the two combinations run sideways between level highs and
  // lows, in three waves and in five. The caption takes the top of the box,
  // so a count's pivots share the rest of it. Head and shoulders
  // rings the three pivots its tool names, over the neckline: all seven
  // would be a row of rings with no figure left between them.
  'xabcd-pattern': harmonic(18.5, 3.5, 16.5, 6.5, 20.5) + link(7.75, 3.5, 16.25, 6.5, PIVOT, PIVOT),
  'abcd-pattern': zigzag([[3.5, 4], [9, 15], [15, 8], [20.5, 20]])
    + link(3.5, 4, 15, 8, PIVOT, PIVOT) + link(9, 15, 20.5, 20, PIVOT, PIVOT),
  'elliott-impulse': count([[3.5, 20.5], [7, 16], [10.5, 19], [13.5, 12], [17, 15.5], [20.5, 11.5]], '1', '5'),
  'elliott-correction': count([[3.5, 11.5], [9, 18], [15, 14], [20.5, 20.5]], 'A', 'C'),
  'elliott-triangle': count([[3.5, 11.5], [7, 20.5], [10.5, 13], [13.5, 19], [17, 14.5], [20.5, 17.5]], 'A', 'E'),
  'elliott-double-combo': count([[3.5, 12], [9, 20], [15, 12], [20.5, 20]], 'W', 'Y'),
  'elliott-triple-combo': count([[3.5, 12], [7, 20], [10.5, 12], [13.5, 20], [17, 12], [20.5, 20]], 'W', 'Z'),
  'head-shoulders': link(2.5, 20, 6, 11.5, 0, PIVOT) + link(6, 11.5, 9, 16.5, PIVOT) + link(9, 16.5, 12, 4, 0, PIVOT)
    + link(12, 4, 15, 16.5, PIVOT) + link(15, 16.5, 18, 11.5, 0, PIVOT) + link(18, 11.5, 21.5, 20, PIVOT) + 'M2.5 16.5h19'
    + ring(6, 11.5, PIVOT) + ring(12, 4, PIVOT) + ring(18, 11.5, PIVOT),
  // The six harmonics are one zigzag and differ only in where B, C and D
  // fall against XA, so each is drawn to its own ratios, and its tool accepts
  // it as a valid instance of itself and of no other harmonic. Each sits
  // toward the end of its tool's range that its neighbours do not share, so
  // the six are six figures at 20px and not one. Gartley: B at 0.65 of XA, a
  // shallow C, D at 0.76. Bat: a shallow B at 0.41, C nearly back at A, a
  // deep D at 0.88. Butterfly: B at 0.8, D beyond X at 1.36. Crab: D far
  // beyond X, at 1.62, after a leg 3.6 times BC. Shark: C above A, D back at
  // X. Cypher: C above A, D at 0.76 of XC. Drawn by eye, as they first were,
  // five of the six failed their own tool's check.
  gartley: harmonic(20.5, 3.5, 14.5, 10, 16.5),
  bat: harmonic(20.5, 3.5, 10.5, 4.5, 18.5),
  butterfly: harmonic(16, 3.5, 13.5, 7.5, 20.5),
  crab: harmonic(14, 3.5, 9, 4.5, 20.5),
  shark: harmonic(20.5, 6.5, 12.5, 3.5, 20.5),
  cypher: harmonic(20.5, 8, 15.5, 3.5, 16.5),

  // ── measure and range ───────────────────────────────────────────────────
  // A rule for the tool that measures both ways, and for each range the two
  // limits it runs between with the span marked across them: levels for
  // price, bars for time, the opposite corners of the box for both. The bare
  // double arrows they were before were the scale buttons of the chrome tier.
  measure: 'M16.6 3.2 20.8 7.4 7.4 20.8 3.2 16.6zM6.55 13.25l1.4 1.4M9.9 9.9l1.8 1.8M13.25 6.55l1.4 1.4',
  // What the study is: an average of the candles, from the anchor on. One
  // candle rides above the average and one below, so it crosses their wicks
  // and never a body: through a body four units wide, the line and the frame
  // were one blot at 20px. The average leaves its anchor level and arrives
  // level, an S and not the slash a straight rise is. A bar the height of
  // the glyph through the ring, as it was first redrawn, buried the ring in
  // the bar and said nothing of price.
  'anchored-vwap': 'M10 2.5v1.5M8 4h4v6H8zM10 10v7.5M17.5 3v8M15.5 11h4v6h-4zM17.5 17v2.5'
    + 'M6.5 15.5c3.2 0 4.6-1.2 6.2-4.4s3.6-5.6 8.8-5.6' + ring(4.5, 15.5),
  // The range between its two anchors, and the volume at each price along it.
  'fixed-range-volume-profile': 'M4.5 6.5v11M4.5 7h7v3h-7M4.5 10.5h15.5v3H4.5M4.5 14h10.5v3H4.5' + ring(4.5, 4.5) + ring(4.5, 19.5),
  'price-range': 'M2.5 3.5h19M2.5 20.5h19M12 7v10M9 10l3-3 3 3M9 14l3 3 3-3',
  'date-range': 'M3.5 2.5v19M20.5 2.5v19M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3',
  'date-price-range': 'M3 8.5V3h5.5M21 15.5V21h-5.5M7 17 17 7M12 7h5v5M12 17H7v-5',

  // ── cycles ──────────────────────────────────────────────────────────────
  // Evenly spaced, from the two anchors on the first two lines that set the
  // period, level with each other where the Fibonacci time zones set theirs
  // at two heights and spread out.
  'cyclic-lines': 'M4.5 2.5v8M4.5 13.5v8M10 2.5v8M10 13.5v8M15.5 2.5v19M21 2.5v19' + ring(4.5, 12, PIVOT) + ring(10, 12, PIVOT),
  // Arches standing on their anchors, the second running off the edge as
  // the cycles do. Taller than they are wide, so the glyph fills its box.
  'time-cycles': 'M4.5 15.5A4.5 9 0 0 1 13.5 15.5M13.5 15.5A4.5 9 0 0 1 21.5 9.84' + ring(4.5, 17.5) + ring(13.5, 17.5),
  'sine-line': 'M2.5 12c2.1-7.5 4.2-7.5 6.33 0s4.2 7.5 6.33 0 4.2-7.5 6.34 0',

  // ── positions and forecast ──────────────────────────────────────────────
  // A position is its three levels, the target, the entry and the stop, each
  // on the anchor that sets it, with the target the farther from the entry
  // and the direction as an arrow in that gap. The rings are a pivot's size,
  // so the entry's and the stop's do not touch. A short is the long turned
  // over. They were one picture in 2.5.5; the box over a thin stop bar that
  // replaced it read as an eject key or a laptop, and the frame with an
  // arrow in it after that as a file being sent. With the rings on
  // alternate ends the three levels were a row of sliders. The risk-reward pair
  // measures instead: from one entry line, the reward as a tall span with a
  // cap, the risk as a short one the other way, flipped for the short. A
  // forecast is the segment its tool draws broken, as dots: each is a stroke
  // of no length, which the round cap paints as a disc. As dashes, the caps
  // closed the gaps and it was the trend line at 93 percent overlap.
  'long-position': 'M5.5 4.5h16M5.5 13.5h16M5.5 19.5h16M13.5 11V7M11 9.5l2.5-2.5 2.5 2.5'
    + ring(4, 4.5, PIVOT) + ring(4, 13.5, PIVOT) + ring(4, 19.5, PIVOT),
  'short-position': 'M5.5 19.5h16M5.5 10.5h16M5.5 4.5h16M13.5 13v4M11 14.5l2.5 2.5 2.5-2.5'
    + ring(4, 19.5, PIVOT) + ring(4, 10.5, PIVOT) + ring(4, 4.5, PIVOT),
  forecast: 'M8.18 15.82h0M10.72 13.28h0M13.27 10.73h0M15.81 8.19h0' + ring(4.5, 19.5) + ring(19.5, 4.5),
  'risk-reward-long': 'M6.5 14h15M13.5 14V4M10 4h7M13.5 14v6M10 20h7' + ring(4.5, 14),
  'risk-reward-short': 'M6.5 10h15M13.5 10v10M10 20h7M13.5 10V4M10 4h7' + ring(4.5, 10),

  // ── annotations ─────────────────────────────────────────────────────────
  // A letter with its serifs, so it is a T and not the I-beam it was.
  text: 'M5 7V4.5h14V7M12 4.5v15M9 19.5h6',
  // Five plates in one flyout, so each is its own object. A note is a sheet
  // with its corner turned and writing on it. A callout is a plate on a
  // leader that runs back to the point it annotates. A balloon is round, a
  // comment square, each with its tail under it. A price note is a plate
  // level with the price it hangs on.
  note: 'M5 3.5h14a1.5 1.5 0 0 1 1.5 1.5v9.5l-5.5 6H5a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5z'
    + 'M20.5 14.5h-4a1.5 1.5 0 0 0-1.5 1.5v4.5M7.5 8h9M7.5 12h5',
  callout: box(7, 3, 14.5, 9.5) + link(9.5, 12.5, 4.5, 19.5, 0, 2) + ring(4.5, 19.5),
  balloon: 'M12 3.5c5 0 9 3.1 9 7s-4 7-9 7c-1 0-2-0.1-2.9-0.4L4.5 20l1.3-4.4C4.1 14.3 3 12.5 3 10.5c0-3.9 4-7 9-7z',
  comment: 'M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-4 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  signpost: box(4.5, 3, 15, 7, 1.5) + 'M12 10v7.5' + ring(12, 19.5),
  'price-label': 'M8 6.5h11a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8L3 12zM11 12h6',
  'price-note': 'M6.5 12h3' + box(9.5, 7, 12, 10) + 'M12.5 12h6' + ring(4.5, 12),
  table: box(3, 4.5, 18, 15) + 'M3 9.5h18M9 9.5v10M15 9.5v10',
  'flag-mark': 'M5.5 21.5v-18M5.5 4.5h13l-3 4 3 4h-13',
  // The marker the tool stamps on the chart, in outline. As a shaft with a
  // chevron they were the stacking and scale arrows of the chrome tier.
  'arrow-up': 'M12 3.5l7 7.5h-4v9.5H9V11H5z',
  'arrow-down': 'M12 20.5l7-7.5h-4V3.5H9V13H5z',
  'arrow-left': 'M3.5 12l7.5-7v4h9.5v6H11v4z',
  'arrow-right': 'M20.5 12l-7.5-7v4H3.5v6H13v4z',
};

/**
 * The fills of the tool glyphs' solid marks, by tool id. Optional: an anchor
 * is an open ring and takes no fill, so nearly every glyph has none.
 *
 * Every mark here is also drawn, as an outline, in the glyph's own path, so a
 * host that renders only `DRAWING_TOOL_ICONS` still shows each one. This adds
 * the fill: a second `<path>` painted in `currentColor` with no stroke of its
 * own, after the glyph's path. The markup builders in `icon-svg.ts` add it; a
 * host wrapping the path data itself adds
 * `<path d="..." fill="currentColor" stroke="none"/>` for the same result.
 */
export const DRAWING_TOOL_ACCENTS: Readonly<Record<string, string>> = {
  magnet: MAGNET_POLES,
};

/**
 * A registry's own entry. The registries are plain objects, so `toString` or
 * `constructor` would otherwise come back as an inherited function: drawn as
 * path data where an unknown id must give `undefined`.
 */
const own = (registry: Readonly<Record<string, string>>, id: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(registry, id) ? registry[id] : undefined;

/**
 * The glyph for a tool, or `undefined` when it has none.
 *
 * Undefined rather than a placeholder: a host that renders an empty box has a
 * visible gap to fix, while one handed a question mark ships it.
 */
export function drawingToolIcon(toolId: string): string | undefined {
  return own(DRAWING_TOOL_ICONS, toolId);
}

/** The filled accent for a tool glyph, or `undefined` when it has none. */
export function drawingToolAccent(toolId: string): string | undefined {
  return own(DRAWING_TOOL_ACCENTS, toolId);
}

/** Every id this set covers, for a host building a palette from it. */
export function drawingToolIconIds(): string[] {
  return Object.keys(DRAWING_TOOL_ICONS);
}

// ── the chrome tier ─────────────────────────────────────────────────────────

/** The viewBox every chrome glyph is authored in. */
export const CHROME_ICON_VIEWBOX = '0 0 16 16';

/** The CSS pixel size a chrome glyph is drawn for, and `chromeIconSvg`'s default. */
export const CHROME_ICON_SIZE = 16;

/**
 * Chrome stroke width in viewBox units: about 1.3px at `CHROME_ICON_SIZE`, the
 * line the tool tier draws at its own size, so the two rails read as one set.
 */
export const CHROME_ICON_STROKE = 1.3;

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
const CHROME_ENDS = dot(4, 12) + dot(12, 4);
const CHROME_MARKERS = dot(5, 5, 2) + dot(10, 11, 2);
const CHROME_HEAD = dot(8, 5, 2);
/** The clipboard's clip: the board's top edge runs through it, so it is filled. */
const CHROME_CLIP = 'M6 2h4v2H6z';

/**
 * A pip: a stroke of no length, which the round cap paints as a disc one
 * line wide. The small marks of the chrome tier (an i's dot, a row of keys,
 * a grip) are pips rather than `dot`s, whose ring is a disc over twice the
 * line across and crowds a 16px box.
 */
const pip = (x: number, y: number): string => `M${x} ${y}h0`;

/**
 * Path data for host chrome: the buttons around the chart rather than the
 * tools in it. Same rules as the tool tier (the whole glyph in one path, its
 * marks included; no presentation attributes; integer coordinates) on the 16
 * grid with a 2..14 live area.
 *
 * The set was drawn for a 2px line, where a 16px glyph has room for about four
 * parallel strokes with a pixel between them, and keeps that air at the finer
 * line it is shown with now: two
 * sliders rather than three, a lens and a pupil as small solid dots rather
 * than rings, and no plus squeezed inside a square.
 *
 * The pair `cursor` / `magnet` / `text` also exist in the tool registry, at 24.
 * They are drawn twice on purpose: a rail button and a toolbar button are
 * different sizes, and the whole point of a second grid is not scaling one
 * drawing to both.
 *
 * The tier also carries a glyph for each chart type and transform, under
 * `chart-<id>` (see `chartTypeIcon`), so a chart-type menu reads from the
 * same set as the buttons around it. A layout picker's tiles are derived
 * rather than listed (`layoutIconPath`).
 */
export const CHROME_ICONS: Readonly<Record<string, string>> = {
  // ── pointer and snapping ────────────────────────────────────────────────
  // A pointer, not the cross it was: that cross overlapped `plus` by 92
  // percent at 16px. It is the tool tier's pointer on this grid, in outline
  // with its tail. The magnet stays one line with its poles: two legs, as
  // the tool tier draws it, are more strokes than a 16px box carries.
  cursor: 'M4 2v10l3-2 2 4 2-1-2-4h4z',
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
  paste: 'M3 3h10v11H3z' + CHROME_CLIP + 'M6 8h4M6 11h4',
  // The copy of a square, as a square and a plus: a plus inside the front
  // square of `copy` leaves no pixel between the two at this weight.
  duplicate: 'M8 8h6v6H8zM5 2v6M2 5h6',
  front: 'M2 9h6v5H2zM11 14V2M8 5l3-3 3 3',
  back: 'M2 2h6v5H2zM11 2v12M8 11l3 3 3-3',
  text: 'M3 5V3h10v2M8 3v10M6 13h4',

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
  // Viewfinder corners round four panes. A camera with a grid in its body
  // overlapped `camera`, which sits beside it in one menu, by 81 percent.
  'capture-grid': 'M2 5 2 2 5 2M11 2 14 2 14 5M14 11 14 14 11 14M5 14 2 14 2 11'
    + pip(6, 6) + pip(10, 6) + pip(6, 10) + pip(10, 10),

  // ── navigation, continued ───────────────────────────────────────────────
  'chevron-up': 'M3 10l5-5 5 5',
  'chevron-left': 'M10 3 5 8l5 5',
  // A panel folding away and coming back: the rail's collapse and its tab.
  'chevrons-left': 'M8 4 4 8l4 4M12 4 8 8l4 4',
  'chevrons-right': 'M4 4l4 4-4 4M8 4l4 4-4 4',
  // The widget's menu tick moved onto whole units: its short leg ran from
  // 3,8.5 to an elbow at 6.5,12, and on the grid that elbow is 7,12, so a
  // menu that adopts this glyph keeps the tick it already shows.
  check: 'M3 8l4 4 6-8',
  // Stacked, so it is not read as the dotted line style beside it.
  more: pip(8, 3) + pip(8, 8) + pip(8, 13),
  grip: pip(6, 4) + pip(10, 4) + pip(6, 8) + pip(10, 8) + pip(6, 12) + pip(10, 12),
  refresh: 'M10 12A5 5 0 1 1 12 8M10 6l2 2 2-2',
  swap: 'M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3',

  // ── the grid of charts ──────────────────────────────────────────────────
  // Loose tiles, not a split frame: `grid` is already a split frame, and a
  // layout glyph is the picker for one. The tiles of a particular layout
  // come from `layoutIconPath`, not from this registry.
  layout: 'M2 2 6 2 6 14 2 14zM10 2 14 2 14 6 10 6zM10 10 14 10 14 14 10 14z',
  // A cell grows to fill the grid along its diagonal, and shrinks back to
  // its centre; fullscreen is the whole display, so its marks are the
  // display's corners. The heads are three units, as on the set's other
  // arrows, and the two arrows of each glyph leave the centre clear, which
  // is where maximize and restore differ.
  maximize: 'M10 6 14 2M11 2h3v3M6 10 2 14M2 11v3h3',
  restore: 'M13 3 9 7M12 7H9V4M3 13l4-4M4 9h3v3',
  fullscreen: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4',
  'fullscreen-exit': 'M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4',
  // The channels a group of charts shares: two panes joined, a drawing by its
  // anchors, a reticle, a span of time and a palette. The reticle keeps its
  // centre open: a cross with a gap in the middle was `plus` at 92 percent.
  'link-group': 'M2 3h4v10H2zM10 3h4v10h-4zM6 8h4',
  'drawing-sync': 'M4 12 12 4' + CHROME_ENDS,
  crosshair: ring(8, 8, 4) + 'M8 2 8 4M8 12 8 14M2 8 4 8M12 8 14 8',
  'time-range': 'M3 4v8M13 4v8M3 8h10',
  palette: 'M8 14A6 6 0 1 1 14 8L10 10z' + pip(5, 8) + pip(7, 5) + pip(10, 5),

  // ── time and the market ─────────────────────────────────────────────────
  // A ring with a mark inside is info, clock and globe at once unless the
  // rings differ: at one radius the ring is most of each glyph's ink, and
  // clock and info overlapped by 87 percent. The clock is drawn a size
  // smaller than the other two for that reason.
  // The rings sit a third of the way in, not near the corners, and the
  // holiday below is the same page with the day struck off.
  calendar: 'M2 4h12v10H2zM2 7h12M6 2v3M10 2v3M5 10h2',
  clock: ring(8, 8, 5) + 'M8 6v2h2',
  globe: ring(8, 8, 6) + 'M8 2a3 6 0 0 0 0 12a3 6 0 0 0 0-12M2 8h12',
  // The session as a day on a horizon: the sun up, rising, setting, the moon,
  // and a day struck off the calendar. As rings with a dot or a bar inside,
  // open and closed were the clock at 85 and 89 percent, and each other.
  // The setting sun sits lower than the rising one: with the same sun and
  // only the arrow turned over, the two overlapped by 84 percent. The arrows
  // have shafts, the rising one's head at the top of the box and the setting
  // one's just over its sun: a bare chevron over the small setting sun read
  // as an hourglass at 16px, and one shaft for both was 72 percent alike.
  'market-open': ring(8, 8, 2) + 'M8 2 8 3M2 8 3 8M13 8 14 8M3 3 4 4M13 3 12 4M2 13h12',
  'market-pre': 'M2 13h12M5 13a3 3 0 0 1 6 0M8 7V2M5 5l3-3 3 3',
  'market-post': 'M2 13h12M6 13a2 2 0 0 1 4 0M8 3v5M5 5l3 3 3-3',
  'market-closed': 'M8 2A4 4 0 1 0 12 6 4 4 0 0 1 8 2zM2 13h12',
  'market-holiday': 'M2 4h12v10H2zM6 2v3M10 2v3M6 8l4 4M10 8l-4 4',

  // ── replay ──────────────────────────────────────────────────────────────
  // The solid media set, filled through CHROME_ICON_FILLED. The pause bars
  // are three pixels wide rather than four so the stop square beside them
  // is not the same block of ink (69 percent at four).
  replay: 'M8 3v10L2 8zM14 3v10L8 8z',
  play: 'M5 3v10l8-5z',
  pause: 'M4 3h1v10H4zM11 3h1v10h-1z',
  stop: 'M4 4h8v8H4z',
  'step-forward': 'M3 3v10l6-5zM12 3v10',
  'step-back': 'M13 3v10L7 8zM4 3v10',
  record: dot(8, 8, 4),

  // ── the price scale ─────────────────────────────────────────────────────
  'scale-auto': 'M8 2v12M5 5l3-3 3 3M5 11l3 3 3-3',
  'scale-log': 'M2 2v12h12M4 12C8 11 11 8 13 3',
  'scale-percent': 'M13 3 3 13' + ring(4, 4, 2) + ring(12, 12, 2),

  // ── layouts and files ───────────────────────────────────────────────────
  // One menu, so drawn apart: save-as leaves out the disk's shutter for its
  // plus (with it the two were 78 percent alike), and autosave is two arrows
  // round rather than a third disk. Recent is the one arrow turned back, with
  // hands; refresh is the one arrow forward.
  folder: 'M2 3h4l2 2h6v8H2z',
  save: 'M2 2h9l3 3v9H2zM5 2v4h5V2M5 14v-4h6v4',
  'save-as': 'M9 14H2V2h9l3 3v4M12 10v4M10 12h4',
  autosave: 'M3 8A5 5 0 0 1 12 5M12 2v3H9M13 8A5 5 0 0 1 4 11M4 14v-3h3',
  rename: 'M9 5H2v6h7M12 3v10M10 3h4M10 13h4',
  recent: 'M6 12A5 5 0 1 0 4 8M6 6 4 8 2 6M9 6v2h2',
  template: 'M2 2h12v4H2zM2 9h5v5H2zM10 9h4M10 12h4',
  keyboard: 'M2 3h12v10H2z' + pip(5, 6) + pip(8, 6) + pip(11, 6) + 'M5 10h6',

  // ── status ──────────────────────────────────────────────────────────────
  bell: 'M4 11V7a4 4 0 0 1 8 0v4M2 11h12M7 14h2',
  'bell-off': 'M4 11V7a4 4 0 0 1 8 0v4M2 11h12M7 14h2M2 2l12 12',
  pin: 'M5 2h6M6 2v5l-2 3h8l-2-3V2M8 10v4',
  'pin-filled': 'M5 2h6M6 2h4v5l2 3H4l2-3zM8 10v4',
  // Three outlines, so the level reads before the mark inside does. An
  // octagon for the error rasterised as a circle at 16px, 93 percent info.
  info: ring(8, 8, 6) + pip(8, 5) + 'M8 8v3',
  warning: 'M8 2l6 12H2zM8 7v1' + pip(8, 11),
  error: 'M8 2l6 6-6 6-6-6zM8 5v2' + pip(8, 10),
  sun: ring(8, 8, 2) + 'M8 2 8 3M8 13 8 14M2 8 3 8M13 8 14 8M3 3 4 4M12 12 13 13M13 3 12 4M3 13 4 12',
  moon: 'M12 11A5 5 0 1 1 5 4a7 7 0 0 0 7 7z',

  // ── drawing and text ────────────────────────────────────────────────────
  eraser: 'M2 10 8 4l6 6-4 4H6zM5 7l6 6',
  measure: 'M2 5h12v6H2zM5 5v3M8 5v2M11 5v3',
  fill: 'M8 2l4 6a4 4 0 1 1-8 0z',
  bold: 'M4 2h5a3 3 0 0 1 0 6H4zM4 8h6a3 3 0 0 1 0 6H4z',
  italic: 'M7 2h6M3 14h6M10 2 6 14',

  // ── panels ──────────────────────────────────────────────────────────────
  watchlist: pip(3, 4) + pip(3, 8) + pip(3, 12) + 'M6 4h8M6 8h8M6 12h8',
  news: 'M4 12V3h10v10H3a1 1 0 0 1-1-1V6h2M7 6h4M7 9h4',
  account: CHROME_HEAD + 'M3 14a5 4 0 0 1 10 0',
  compare: 'M2 7 6 3 10 6 14 2M2 14 6 10 10 12 14 8',
  indicators: 'M4 14V5a2 2 0 0 1 2-2h1M2 7h4M9 8l5 6M14 8l-5 6',

  // ── trading ─────────────────────────────────────────────────────────────
  // Buy and sell are one solid triangle turned over, since the direction is
  // the difference. Closing a position is leaving it: a box with a cross in
  // it was the square frame of save and grid again. A bracket is the entry
  // with its target above and its stop below, the three levels on one stem,
  // and the depth of market is the ladder traders call it. Each was drawn
  // before as short bars off a stem, and each read as a letter at 16px.
  buy: 'M8 3l6 9H2z',
  sell: 'M8 13 2 4h12z',
  'close-position': 'M9 2H2v12h7M6 8h8M11 5l3 3-3 3',
  reverse: 'M5 13V3M2 6l3-3 3 3M11 3v10M8 10l3 3 3-3',
  bracket: 'M2 8h12M4 3h8M4 13h8M8 3v10',
  'dom-ladder': 'M4 2v12M12 2v12M4 5h8M4 8h8M4 11h8',

  // ── settings tabs and menu marks ────────────────────────────────────────
  // The pictures the widget drew for itself outside the registry, so its
  // settings tabs, stacking order and line style control can read from here
  // and be held to the same checks. The solid line style is `minus`, which
  // is the same drawing. Dashes are two, four pixels apart and set in from
  // the ends: with one pixel between them the round caps closed the gaps (the
  // dashed line was `minus` at 86 percent), and three short dashes with two
  // between them were the dotted line's dots, a little longer.
  legend: 'M2 4h8M2 8h12M2 12h9',
  axes: 'M3 2v11h11M3 6h2M3 10h2M7 13v-2M11 13v-2',
  panels: 'M2 3h12v10H2zM2 8h12M7 3v10',
  trading: 'M2 11l4-4 3 2 5-5M11 4h3v3M2 14h12',
  brush: 'M14 2 9 7M9 7 7 5M9 7l-2 4-4 2 2-4z',
  'above-series': 'M3 3h10M8 14V7M5 10l3-3 3 3',
  'behind-series': 'M3 13h10M8 2v7M5 6l3 3 3-3',
  fit: 'M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3',
  coordinates: 'M3 2v11h11' + pip(10, 6) + 'M3 6h4M10 13v-4',
  'line-dashed': 'M3 8h2M11 8h2',
  'line-dotted': pip(2, 8) + pip(6, 8) + pip(10, 8) + pip(14, 8),
  'line-mixed': 'M2 5h12M3 11h2M11 11h2',

  // ── chart types and transforms ──────────────────────────────────────────
  // One per registered chart type and per transform, read through
  // `chartTypeIcon`. A chart-type menu lists them together, so each family
  // is told apart by what its renderer does differently. Candles: a hollow
  // and a solid body; two hollow; widths that vary; bodies that open halfway
  // up the one before, with no lower wick. Bars: ticks for open and close,
  // or a bare range. Lines: plain, with markers, stepped, and the long
  // verticals and short shoulders of a kagi line. Blocks: bricks corner to
  // corner, bars of one height stepping, boxes of any height, columns on a
  // base, a histogram about zero. A solid body is two units wide and drawn as
  // three strokes side by side, solid at any line; a hollow one is four, with
  // its wicks stopping at it.
  'chart-candlestick': 'M5 2 5 5M3 5h4v6H3zM5 11 5 14M12 3 12 13M11 5 11 11M13 5 13 11',
  'chart-hollow-candle': 'M5 2 5 4M3 4h4v5H3zM5 9 5 12M11 4 11 7M9 7h4v5H9zM11 12 11 14',
  'chart-volume-candle': 'M4 3 4 13M3 5 3 10M5 5 5 10M8 4h6v7H8zM11 2 11 4M11 11 11 14',
  'chart-heikin-ashi': 'M3 8h4v6H3zM5 6 5 8M9 4h4v7H9zM11 2 11 4',
  'chart-bar': 'M5 2 5 14M2 5 5 5M5 11 8 11M11 3 11 12M8 9 11 9M11 5 14 5',
  'chart-high-low': 'M4 3 4 11M8 5 8 14M12 2 12 9',
  'chart-line': 'M2 12 6 6 9 10 14 3',
  'chart-line-markers': 'M2 10 5 5 10 11 14 4' + CHROME_MARKERS,
  'chart-step': 'M2 12h3V8h4v3h3V4h2',
  'chart-area': 'M2 14V10l4-5 3 3 5-6v12z',
  'chart-hlc-area': 'M2 6 6 4 10 6 14 3V9l-4 3-4-2-4 2z',
  'chart-baseline': 'M2 8h12M2 12 6 4 10 12 14 5',
  'chart-column': 'M3 14 3 9M6 14 6 5M9 14 9 8M12 14 12 3',
  'chart-histogram': 'M2 8h12M4 8 4 4M7 8 7 2M10 8 10 12M13 8 13 14',
  'chart-point-figure': 'M2 2 6 6M6 2 2 6M2 8 6 12M6 8 2 12' + ring(11, 5, 2) + ring(11, 11, 2),
  'chart-kagi': 'M3 13V5h4v6h3V3h3v7',
  'chart-renko': 'M2 10 6 10 6 14 2 14zM6 6 10 6 10 10 6 10zM10 2 14 2 14 6 10 6z',
  'chart-range-bars': 'M3 9 4 9 4 14 3 14zM7 6 8 6 8 11 7 11zM11 3 12 3 12 8 11 8z',
  'chart-line-break': 'M2 9 6 9 6 14 2 14zM6 4 10 4 10 9 6 9zM10 7 14 7 14 11 10 11z',
};

/**
 * The fills of the chrome glyphs' marks, as `DRAWING_TOOL_ACCENTS` is for the
 * tools: each mark is outlined in the glyph's path, and this paints it solid.
 * At 16px a ring of radius 1 is mostly line already, so the fill matters
 * most for the rings of radius 2: the slider knobs, a head, a line's markers.
 */
export const CHROME_ICON_ACCENTS: Readonly<Record<string, string>> = {
  magnet: CHROME_MAGNET_CAPS,
  eye: CHROME_PUPIL,
  paste: CHROME_CLIP,
  settings: CHROME_KNOBS,
  camera: CHROME_LENS,
  'drawing-sync': CHROME_ENDS,
  account: CHROME_HEAD,
  'chart-line-markers': CHROME_MARKERS,
};

/**
 * Chrome glyphs meant to be painted solid. Paths carry no presentation
 * attributes, so the fill is applied by the wrapper (`chromeIconSvg` does it,
 * a host with its own wrapper reads this set) and the registry stays pure.
 */
export const CHROME_ICON_FILLED: ReadonlySet<string> = new Set([
  // A second state of an outline glyph.
  'star-filled', 'pin-filled',
  // Media controls, read as solid shapes by convention.
  'replay', 'play', 'stop', 'step-forward', 'step-back', 'record',
  // Solid marks: a direction, and the moon of the theme and the market.
  'buy', 'sell', 'moon', 'market-closed',
]);

/** The chrome glyph for an id, or `undefined` when there is none. */
export function chromeIcon(id: string): string | undefined {
  return own(CHROME_ICONS, id);
}

/** The filled accent for a chrome glyph, or `undefined` when it has none. */
export function chromeIconAccent(id: string): string | undefined {
  return own(CHROME_ICON_ACCENTS, id);
}

/** Every id the chrome tier covers. */
export function chromeIconIds(): string[] {
  return Object.keys(CHROME_ICONS);
}

/**
 * The chrome glyph for a chart type or a transform, by its id: a registered
 * type (`candlestick`, `point-figure`) or one of the transforms that render
 * as candles (`heikin-ashi`, `renko`, `range-bars`, `line-break`). It is the
 * `chart-<id>` entry of `CHROME_ICONS`, so `chromeIconSvg('chart-' + id)`
 * draws the same picture. `undefined` for a type a host registered itself,
 * which has no glyph until the host draws one.
 */
export function chartTypeIcon(type: string): string | undefined {
  return own(CHROME_ICONS, `chart-${type}`);
}

/** One chart's place in a layout glyph: a cell, and how many rows and columns it spans. */
export interface LayoutIconSlot {
  readonly row: number;
  readonly column: number;
  /** Default 1. */
  readonly rowSpan?: number;
  /** Default 1. */
  readonly columnSpan?: number;
}

/** The most rows or columns a 16px tile shows with a pixel of clear between its lines. */
const LAYOUT_MAX = 4;

/**
 * A chrome glyph for a grid of charts: the frame, split into `rows` by
 * `columns` cells, with the dividers inside a spanning slot left out, so a
 * chart that spans two cells reads as one pane. Cells no slot claims are
 * drawn as their own panes. Without `slots`, every cell is one chart.
 *
 * Derived rather than drawn per layout, so a host's layout picker gets a
 * tile for every layout it offers, uneven ones included, without an entry in
 * this registry for each. The path is on the chrome grid and to its rules
 * (whole units, the 2..14 live area, no presentation attributes), and draws
 * through the chrome attribute bag like any `CHROME_ICONS` value.
 *
 * One to four a side: twelve units split four ways leaves clear space
 * between two lines even at the 2px stroke the set was drawn for, and five
 * would close it up. Throws a
 * `RangeError` for anything else, and for a slot outside the grid or over
 * another. A chart grid takes up to eight a side, so a caller that draws the
 * current layout falls back to the `layout` glyph past four.
 */
export function layoutIconPath(rows: number, columns: number, slots?: readonly LayoutIconSlot[]): string {
  const count = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= LAYOUT_MAX;
  if (!count(rows) || !count(columns)) {
    throw new RangeError(`openalgo-charts: a layout glyph takes 1..${LAYOUT_MAX} rows and columns, not ${rows}x${columns}`);
  }
  // Each cell's owner: its slot's index, or a negative id of its own when no
  // slot claims it. A divider is drawn wherever two neighbours differ.
  const owner = Array.from({ length: rows * columns }, (_, i) => -1 - i);
  (slots ?? []).forEach((s, k) => {
    const rs = s.rowSpan ?? 1;
    const cs = s.columnSpan ?? 1;
    if (!(Number.isInteger(s.row) && Number.isInteger(s.column) && Number.isInteger(rs) && Number.isInteger(cs)
      && s.row >= 0 && s.column >= 0 && rs >= 1 && cs >= 1 && s.row + rs <= rows && s.column + cs <= columns)) {
      throw new RangeError(`openalgo-charts: layout slot ${k} is outside a ${rows}x${columns} grid`);
    }
    for (let r = s.row; r < s.row + rs; r++) {
      for (let c = s.column; c < s.column + cs; c++) {
        // Inside the grid, checked above.
        if (owner[r * columns + c]! >= 0) throw new RangeError(`openalgo-charts: layout slot ${k} overlaps slot ${owner[r * columns + c]}`);
        owner[r * columns + c] = k;
      }
    }
  });
  // Twelve units divide evenly by one to four, so every line is whole.
  const at = (i: number, n: number): number => 2 + (12 / n) * i;
  let d = 'M2 2h12v12H2z';
  // A divider runs along each inner grid line, broken where a slot spans it.
  const lines = (outer: number, inner: number, split: (o: number, i: number) => boolean,
    seg: (o: number, from: number, to: number) => string): void => {
    for (let o = 1; o < outer; o++) {
      let from = -1;
      for (let i = 0; i <= inner; i++) {
        const cut = i < inner && split(o, i);
        if (cut && from < 0) from = i;
        if (!cut && from >= 0) { d += seg(o, from, i); from = -1; }
      }
    }
  };
  lines(columns, rows, (c, r) => owner[r * columns + c - 1] !== owner[r * columns + c],
    (c, from, to) => `M${at(c, columns)} ${at(from, rows)} ${at(c, columns)} ${at(to, rows)}`);
  lines(rows, columns, (r, c) => owner[(r - 1) * columns + c] !== owner[r * columns + c],
    (r, from, to) => `M${at(from, columns)} ${at(r, rows)} ${at(to, columns)} ${at(r, rows)}`);
  return d;
}
