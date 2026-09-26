/**
 * The icon sets, checked mechanically.
 *
 * Sixty-odd glyphs cannot be kept consistent by review. What makes a set look
 * drawn rather than assembled is not the quality of any single glyph, it is
 * that they share a grid, a stroke weight, a margin and a visual density; and
 * every one of those is a property a test can hold and a reader cannot.
 *
 * The previous hand-drawn sets in the demo and the terminal drifted on exactly
 * these axes because nothing checked them. This file is the reason the next
 * glyph added will match the ones before it, on either grid.
 */
import { describe, it, expect } from 'vitest';
import '../src/indicators/index';
import {
  DRAWING_TOOL_ICONS, drawingToolIcon, drawingToolIconIds,
  ICON_VIEWBOX, ICON_STROKE, ICON_ATTRS,
  CHROME_ICONS, CHROME_ICON_FILLED, chromeIcon, chromeIconIds,
  CHROME_ICON_VIEWBOX, CHROME_ICON_STROKE, CHROME_ICON_ATTRS,
  DRAWING_TOOL_ACCENTS, drawingToolAccent, CHROME_ICON_ACCENTS, chromeIconAccent,
  type IconAttrs,
} from '../src/draw/icons';
import { registeredDrawingTools, registerBuiltinDrawingTools } from '../src/draw/index';
import {
  clotted, coords, drawingKey, gridPoints, isClosed, subpathKey, subpaths,
} from './helpers/icon-geometry';

registerBuiltinDrawingTools();

/**
 * One row per tier. The invariants are the same on both grids; only the
 * numbers differ. The live area keeps the ink one pixel clear of the box at
 * native size: a stroke of 2 reaches a unit past its points, so the points
 * stay two units in on either grid. The minimum span is half the live area.
 */
interface Tier {
  name: string;
  entries: [string, string][];
  accents: [string, string][];
  registry: Readonly<Record<string, string>>;
  accentOf: (id: string) => string | undefined;
  attrs: IconAttrs;
  viewBox: string;
  stroke: number;
  grid: number;
  lo: number;
  hi: number;
  minSpan: number;
  maxCommands: number;
}

const TIERS: Tier[] = [
  {
    name: 'tool', entries: Object.entries(DRAWING_TOOL_ICONS), accents: Object.entries(DRAWING_TOOL_ACCENTS),
    registry: DRAWING_TOOL_ICONS, accentOf: drawingToolAccent, attrs: ICON_ATTRS,
    viewBox: ICON_VIEWBOX, stroke: ICON_STROKE, grid: 24, lo: 2, hi: 22, minSpan: 10, maxCommands: 14,
  },
  {
    name: 'chrome', entries: Object.entries(CHROME_ICONS), accents: Object.entries(CHROME_ICON_ACCENTS),
    registry: CHROME_ICONS, accentOf: chromeIconAccent, attrs: CHROME_ICON_ATTRS,
    viewBox: CHROME_ICON_VIEWBOX, stroke: CHROME_ICON_STROKE, grid: 16, lo: 2, hi: 14, minSpan: 7, maxCommands: 14,
  },
];

describe('the tool set covers the registry', () => {
  it('has a glyph for every registered drawing tool', () => {
    // The whole point of shipping these is that an adopter never has to draw
    // one. A tool with no glyph pushes that work straight back onto them.
    const missing = registeredDrawingTools()
      .map((t) => t.id)
      .filter((id) => drawingToolIcon(id) === undefined);
    expect(missing, `tools with no icon: ${missing.join(', ')}`).toEqual([]);
  });
});

describe.each(TIERS)('the $name set shares one grid', (tier) => {
  it.each(tier.entries)(`%s stays inside the ${tier.lo}..${tier.hi} live area`, (_id, d) => {
    // A glyph that reaches the edge of the box looks larger than its
    // neighbours, and a rail of them reads as ragged.
    for (const n of gridPoints(d)) {
      expect(n).toBeGreaterThanOrEqual(tier.lo);
      expect(n).toBeLessThanOrEqual(tier.hi);
    }
  });

  it.each(tier.entries)('%s lands on whole units', (_id, d) => {
    // With a stroke of 2, an orthogonal edge centred on an integer covers
    // exactly two device pixels at 1:1. Half units were the old set's
    // crispness bug: nothing landed on a pixel boundary at any size.
    for (const n of coords(d)) expect(Number.isInteger(n), `${n} in ${d}`).toBe(true);
  });

  it.each(tier.entries)('%s carries no presentation attributes of its own', (_id, d) => {
    // Weight, cap and colour belong to the host's one `<svg>`, so a glyph
    // cannot quietly opt out of the set.
    expect(d).not.toMatch(/stroke|fill|width|style|class/i);
  });

  it.each(tier.entries)('%s is a path, not a document', (_id, d) => {
    expect(d).not.toMatch(/[<>]/);
    expect(d.trim()).toMatch(/^[Mm]/);
  });
});

describe.each(TIERS)('the $name set has one visual weight', (tier) => {
  it('declares a single stroke, applied by the host', () => {
    expect(tier.attrs.strokeWidth).toBe(tier.stroke);
    expect(tier.attrs.fill).toBe('none');
    expect(tier.attrs.stroke).toBe('currentColor');
  });

  it('rounds every cap and join, so no glyph ends square beside a round one', () => {
    expect(tier.attrs.strokeLinecap).toBe('round');
    expect(tier.attrs.strokeLinejoin).toBe('round');
  });

  it('shares one viewBox', () => {
    expect(tier.viewBox).toBe(`0 0 ${tier.grid} ${tier.grid}`);
    expect(tier.attrs.viewBox).toBe(tier.viewBox);
  });
});

describe.each(TIERS)('the $name set is balanced', (tier) => {
  it('keeps every glyph within a sane complexity band', () => {
    // A glyph far busier than the rest dominates a rail whatever its weight.
    // Fib retracement and Gann box are the densest by nature; nothing should
    // be denser than they are.
    for (const [id, d] of tier.entries) {
      const commands = (d.match(/[A-Za-z]/g) ?? []).length;
      expect(commands, `${id} has ${commands} commands`).toBeLessThanOrEqual(tier.maxCommands);
      expect(commands, `${id} is empty`).toBeGreaterThan(0);
    }
  });

  it('uses most of the live area rather than floating small in the box', () => {
    // A glyph occupying a third of its box reads as a different size from one
    // that fills it, even at the same nominal dimensions.
    for (const [id, d] of tier.entries) {
      // Measured along the arcs, not only between endpoints: the halves of
      // the chrome `link` end two units inside the curves that give it its
      // width, and an endpoint span calls a twelve-unit glyph six.
      const pts = subpaths(d).flatMap((s) => s.extent);
      if (pts.length < 2) continue;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const span = Math.round(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
      expect(span, `${id} spans only ${span} units`).toBeGreaterThanOrEqual(tier.minSpan);
    }
  });

  it('has no duplicate glyph, however its subpaths are ordered or directed', () => {
    // 2.5.5 shipped long-position and short-position as one picture: the same
    // two boxes and stem, written in the other order. A string comparison
    // passed it. The key walks each glyph into absolute subpaths, sorts them
    // and reads each from a fixed end, so only a different drawing gets a
    // different key. The path alone is keyed, accents aside: it is the whole
    // glyph for a host that draws nothing else. The raster spec (icon-raster)
    // is the check for glyphs that differ on paper and still look alike.
    const seen = new Map<string, string>();
    for (const [id, d] of tier.entries) {
      const key = drawingKey(d);
      const prev = seen.get(key);
      expect(prev, `${id} draws the same as ${prev}`).toBeUndefined();
      seen.set(key, id);
    }
  });

  it('keys a glyph by its drawing, not by how the string was written', () => {
    // The key itself, pinned: a check that silently compares strings again
    // would pass every glyph set.
    expect(drawingKey('M3 5h18v5H3zM3 15h18v5H3z')).toBe(drawingKey('M3 15h18v5H3zM21 5H3v5h18z'));
    expect(drawingKey('M4 20 20 4')).toBe(drawingKey('M20 4 4 20'));
    expect(drawingKey('M2 12h20m-10-10v20')).toBe(drawingKey('M12 2v20M22 12H2'));
    expect(drawingKey('M4 20 20 4')).not.toBe(drawingKey('M4 20 20 5'));
    expect(drawingKey('M3 5h18v5H3z')).not.toBe(drawingKey('M3 5h18v5H3'));
    expect(drawingKey('M4 20 20 4M3 21a1 1 0 0 0 2 0a1 1 0 0 0-2 0z')).not.toBe(drawingKey('M4 20 20 4'));
  });

  it('keys curves and arcs by their drawing too', () => {
    // Lines and polygons were normalised and curves were not, so the same arc
    // drawn from its other end, or a dot started on its far side, keyed as a
    // different glyph. A curve reverses with its control points, an arc with
    // its sweep, and a closed ring of either may start at any of its joints.
    expect(drawingKey('M3 19a12 12 0 0 1 18 0')).toBe(drawingKey('M21 19a12 12 0 0 0-18 0'));
    expect(drawingKey('M4 19a1 1 0 0 0 2 0a1 1 0 0 0-2 0z')).toBe(drawingKey('M6 19a1 1 0 0 0-2 0a1 1 0 0 0 2 0z'));
    expect(drawingKey('M4 19a1 1 0 0 0 2 0a1 1 0 0 0-2 0z')).toBe(drawingKey('M4 19a1 1 0 0 1 2 0a1 1 0 0 1-2 0z'));
    expect(drawingKey('M3 18c4-12 14-12 18 0')).toBe(drawingKey('M21 18c-4-12-14-12-18 0'));
    expect(drawingKey('M2 12c3-9 6-9 9 0s6 9 9 0')).toBe(drawingKey('M2 12c3-9 6-9 9 0 3 9 6 9 9 0'));
    expect(drawingKey('M12 5c5 0 9 3 9 7s-4 7-9 7-9-3-9-7 4-7 9-7z'))
      .toBe(drawingKey('M21 12c0 4-4 7-9 7s-9-3-9-7 4-7 9-7 9 3 9 7z'));
    expect(drawingKey('M3 19a12 12 0 0 1 18 0')).not.toBe(drawingKey('M3 19a12 12 0 0 0 18 0'));
    expect(drawingKey('M3 18c4-12 14-12 18 0')).not.toBe(drawingKey('M3 18c4-11 14-12 18 0'));
  });

  it('leaves no hollow shape filled in by its own strokes', () => {
    // A shape wide enough to show a hole at the tier's line is drawn hollow
    // on purpose; if another stroke of the glyph runs through its middle, the
    // 2px line fills it and the glyph turns into a block. Marks an accent
    // fills are meant solid.
    for (const [id, d] of tier.entries) {
      if (tier.name === 'chrome' && CHROME_ICON_FILLED.has(id)) continue;
      const marks = new Set(subpaths(tier.accentOf(id) ?? '').map(subpathKey));
      expect(clotted(d, tier.stroke, marks), `${id} fills a hollow shape solid`).toEqual([]);
    }
  });
});

describe.each(TIERS)('the $name accents', (tier) => {
  // An accent fills the marks a glyph may carry: an anchor dot, a pole cap,
  // an arrowhead. The glyph's own path already draws each of them, so a host
  // that renders the path data and nothing else still gets every mark that
  // tells a glyph from its siblings, only outlined; the accent is the fill on
  // top, a second path because a fill is a presentation choice.
  const accents = tier.accents;

  it('belong to glyphs of their own tier', () => {
    for (const [id] of accents) expect(tier.registry[id], `${id} has an accent but no glyph`).toBeDefined();
    expect(accents.length).toBeGreaterThan(0);
  });

  it.each(accents)('%s fills marks its glyph already draws', (id, a) => {
    // The accent carries weight, never identity: every mark in it is also a
    // subpath of the glyph, so leaving it out loses a fill and nothing else.
    // Accents that held the only arrowhead or origin dot shipped a path-only
    // horizontal ray at 0.86 overlap with the horizontal line.
    const drawn = new Set(subpaths(tier.registry[id]).map(subpathKey));
    for (const mark of subpaths(a)) {
      expect(drawn.has(subpathKey(mark)), `${id}: the path does not draw ${subpathKey(mark)}`).toBe(true);
    }
  });

  it.each(accents)('%s lands on whole units inside the live area', (_id, a) => {
    // The same grid as the glyph it marks. The extent includes the arcs of a
    // dot, not only their endpoints: a dot is all arc.
    for (const n of coords(a)) expect(Number.isInteger(n), `${n} in ${a}`).toBe(true);
    for (const s of subpaths(a)) {
      for (const [px, py] of s.extent) {
        expect(px, a).toBeGreaterThanOrEqual(tier.lo - 1e-9);
        expect(px, a).toBeLessThanOrEqual(tier.hi + 1e-9);
        expect(py, a).toBeGreaterThanOrEqual(tier.lo - 1e-9);
        expect(py, a).toBeLessThanOrEqual(tier.hi + 1e-9);
      }
    }
  });

  it.each(accents)('%s carries no presentation attributes of its own', (_id, a) => {
    // The one-stroke rule holds for accents too: the fill is the only thing
    // the builders add, and the stroke comes from the frame like the glyph's.
    expect(a).not.toMatch(/stroke|fill|width|style|class|[<>]/i);
    expect(a.trim()).toMatch(/^M/);
  });

  it.each(accents)('%s is made of closed, small marks', (_id, a) => {
    // Closed, or the fill has no edge to stop at. Small, or it is a second
    // glyph painted solid: a mark spans at most a third of the grid.
    const marks = subpaths(a);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.length, `${a} has ${marks.length} marks`).toBeLessThanOrEqual(3);
    for (const s of marks) {
      expect(isClosed(s), `open mark in ${a}`).toBe(true);
      const xs = s.extent.map((p) => p[0]);
      const ys = s.extent.map((p) => p[1]);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      expect(span, `${a} spans ${span}`).toBeLessThanOrEqual(tier.grid / 3);
    }
  });

  it('answers undefined for a glyph that has none, and never for one that has', () => {
    for (const [id, a] of accents) expect(tier.accentOf(id)).toBe(a);
    const plain = tier.entries.find(([id]) => tier.accentOf(id) === undefined);
    expect(plain, 'every glyph has an accent, so none is optional').toBeDefined();
    expect(tier.accentOf('no-such-glyph')).toBeUndefined();
  });
});

describe('the two tiers read as one set', () => {
  it('pins each tier to the stroke it was drawn for', () => {
    expect(ICON_STROKE).toBe(2);
    expect(CHROME_ICON_STROKE).toBe(2);
  });

  it.each(TIERS)('puts the $name stroke edges on pixel boundaries at native size', (tier) => {
    // At native size one unit is one pixel, and a stroke of width w centred
    // on a whole unit covers c - w/2 to c + w/2. Those are pixel boundaries
    // only when w/2 is whole. The chrome tier's old 1.5 put every edge 0.75
    // of the way across a pixel, so no edge was ever solid (the audit
    // measured 0.18 of its inked pixels solid, against 0.59 for the tools).
    expect(Number.isInteger(tier.stroke / 2), `${tier.name} stroke ${tier.stroke}`).toBe(true);
  });

  it('draws one line width on screen in both rails', () => {
    // Each tier is shown at its grid size, so a unit is a CSS pixel in both,
    // and the 16px chrome line beside a 24px tool is the same 2px line. The
    // old rule matched the stroke as a fraction of the box instead, which is
    // what left the chrome tier on a fractional width.
    const toolPx = ICON_STROKE * (24 / Number(ICON_VIEWBOX.split(' ')[2]));
    const chromePx = CHROME_ICON_STROKE * (16 / Number(CHROME_ICON_VIEWBOX.split(' ')[2]));
    expect(chromePx).toBe(toolPx);
  });
});

describe('look-alike glyphs are drawn apart', () => {
  // Read from the path data alone, which is all some hosts draw: the marks
  // that tell siblings apart have to be in it, not only in the accent.
  const tool = (id: string): string => DRAWING_TOOL_ICONS[id];
  /** The closed marks of a glyph's path: its dots and heads. */
  const marks = (id: string) => subpaths(tool(id)).filter((s) => isClosed(s));
  /** The open strokes of a glyph's path. */
  const strokes = (id: string) => subpaths(tool(id)).filter((s) => !isClosed(s));
  /** The centre of each mark, from the extent it covers. */
  const centres = (id: string): [number, number][] => marks(id).map((s) => {
    const xs = s.extent.map((p) => p[0]);
    const ys = s.extent.map((p) => p[1]);
    return [Math.round((Math.min(...xs) + Math.max(...xs)) / 2), Math.round((Math.min(...ys) + Math.max(...ys)) / 2)];
  });
  const ends = (id: string): [number, number][] => {
    const s = strokes(id)[0];
    return [[s.start[0], s.start[1]], [s.points[s.points.length - 1][0], s.points[s.points.length - 1][1]]];
  };

  it('starts the ray at an origin dot, with no tick across it', () => {
    // The ray was a line with a short stroke across its start, which read as
    // a check mark. It is one line now, from a dot, open at the far end.
    expect(strokes('ray')).toHaveLength(1);
    expect(centres('ray')).toEqual([ends('ray')[0]]);
  });

  it('tells the line family apart by its ends', () => {
    // Same diagonal, different ends, because the ends are what differ between
    // the tools: a segment stops at both anchors, a ray at one, an extended
    // line at neither, and an arrow ends in a head.
    expect(centres('trend-line')).toEqual(ends('trend-line'));
    const [a, b] = ends('extended-line');
    for (const [cx, cy] of centres('extended-line')) {
      expect(cx).toBeGreaterThan(Math.min(a[0], b[0]));
      expect(cx).toBeLessThan(Math.max(a[0], b[0]));
      expect(cy).toBeGreaterThan(Math.min(a[1], b[1]));
      expect(cy).toBeLessThan(Math.max(a[1], b[1]));
    }
    expect(centres('extended-line')).toHaveLength(2);
    expect(marks('arrow')).toHaveLength(1);
    const keys = ['trend-line', 'ray', 'extended-line', 'arrow'].map((id) => marks(id).map(subpathKey).sort().join(' | '));
    expect(new Set(keys).size).toBe(keys.length);
    // The info line is a segment that also labels itself: a segment's ends,
    // and a label the plain segment does not have.
    expect(centres('info-line').filter(([x, y]) => centres('trend-line').some(([u, v]) => u === x && v === y)))
      .toEqual(centres('trend-line'));
    expect(subpaths(tool('info-line')).length).toBeGreaterThan(subpaths(tool('trend-line')).length);
  });

  it('starts the horizontal ray at a dot inside the grid, where the line runs edge to edge', () => {
    // The two sat at 0.86 overlap as path data: the ray was the line with its
    // start trimmed, and its dot lived only in the accent. The ray now leaves
    // from an anchor a third of the way in and reaches the far edge, as the
    // diagonal ray does, and the line keeps the full width.
    expect(centres('horizontal-ray')).toEqual([ends('horizontal-ray')[0]]);
    expect(ends('horizontal-ray')[0][0]).toBeGreaterThanOrEqual(8);
    expect(ends('horizontal-ray')[1][0]).toBe(22);
    expect(ends('horizontal-line').map(([x]) => x).sort((p, q) => p - q)).toEqual([2, 22]);
  });

  it('draws a short position as the long one turned over, not as the same picture', () => {
    // The direction is the difference, so the direction is what the glyph
    // shows: flipping one vertically gives the other, and nothing else does.
    const flip = (d: string): string => d.replace(/([MLHVCSQTA])([^A-Za-z]*)/gi, (_m, c: string, args: string) => {
      const n = (args.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
      const up = c.toUpperCase();
      const abs = c === up;
      const out = n.map((v, i) => {
        if (up === 'V') return abs ? 24 - v : -v;
        if (up === 'H') return v;
        if (up === 'A') return i % 7 === 4 ? 1 - v : i % 7 === 6 ? (abs ? 24 - v : -v) : v;
        return i % 2 === 1 ? (abs ? 24 - v : -v) : v;
      });
      return c + out.join(' ');
    });
    for (const [long, short] of [['long-position', 'short-position'], ['risk-reward-long', 'risk-reward-short']]) {
      expect(drawingKey(tool(long))).not.toBe(drawingKey(tool(short)));
      expect(drawingKey(flip(tool(long)))).toBe(drawingKey(tool(short)));
      const acc = drawingToolAccent(long);
      if (acc !== undefined) expect(drawingKey(flip(acc))).toBe(drawingKey(drawingToolAccent(short) ?? ''));
    }
  });
});

describe('the chrome tier', () => {
  it('ships every glyph a host rail and dialog need', () => {
    // A missing chrome glyph sends the host back to drawing its own, which is
    // the drift this registry exists to end.
    const needed = [
      'cursor', 'magnet', 'lock', 'unlock', 'eye', 'eye-off', 'trash', 'settings',
      'undo', 'redo', 'copy', 'paste', 'duplicate', 'star', 'star-filled',
      'chevron-down', 'chevron-right', 'close', 'plus', 'minus', 'front', 'back',
      'text', 'search', 'grid', 'link', 'unlink', 'camera', 'download',
    ];
    const missing = needed.filter((id) => chromeIcon(id) === undefined);
    expect(missing, `chrome glyphs missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('marks only glyphs it actually has as filled', () => {
    for (const id of CHROME_ICON_FILLED) expect(chromeIcon(id), id).toBeDefined();
    expect(CHROME_ICON_FILLED.has('star-filled')).toBe(true);
    expect(CHROME_ICON_FILLED.has('star')).toBe(false);
  });

  it('draws the filled star as a closed pentagram, so the nonzero rule fills its centre', () => {
    // The outline star has ten vertices and an empty middle. The pentagram is
    // five crossing edges: its centre pentagon has a winding of two and fills
    // solid under the default rule, which is what makes one path both a star
    // and its solid state without a presentation attribute in the registry.
    const d = chromeIcon('star-filled')!;
    expect(d.endsWith('z')).toBe(true);
    expect(gridPoints(d).length / 2).toBe(5);
    expect(gridPoints(chromeIcon('star')!).length / 2).toBe(10);
  });

  it('lists every id it covers, and nothing the tool tier covers by accident', () => {
    expect(chromeIconIds().length).toBe(Object.keys(CHROME_ICONS).length);
    expect(chromeIconIds()).toContain('undo');
    expect(chromeIcon('trend-line')).toBeUndefined();
  });
});

describe('the lookup', () => {
  it('returns undefined for an unknown tool rather than a placeholder', () => {
    // A host handed a question mark ships it; one handed nothing sees the gap.
    expect(drawingToolIcon('no-such-tool')).toBeUndefined();
    expect(chromeIcon('no-such-button')).toBeUndefined();
  });

  it('lists every id it covers', () => {
    expect(drawingToolIconIds().length).toBe(Object.keys(DRAWING_TOOL_ICONS).length);
    expect(drawingToolIconIds()).toContain('trend-line');
  });
});
