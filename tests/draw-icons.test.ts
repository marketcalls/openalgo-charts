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
  type IconAttrs,
} from '../src/draw/icons';
import { registeredDrawingTools, registerBuiltinDrawingTools } from '../src/draw/index';

registerBuiltinDrawingTools();

/** Every coordinate in a path, as numbers. */
function coords(d: string): number[] {
  return (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
}

/**
 * Coordinates that are positions on the grid, excluding the arc parameters of
 * `A rx ry rot large sweep x y`, whose flags and radii are not grid points.
 */
function gridPoints(d: string): number[] {
  // A path walker, not a number scraper. Relative commands carry the pen from
  // the current point, so scraping the literals reports a span of zero for a
  // glyph drawn with h and v, and the balance check silently passes.
  const out: number[] = [];
  let x = 0;
  let y = 0;
  let started = false;
  const put = (px: number, py: number): void => { out.push(px, py); x = px; y = py; };
  for (const m of d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^A-Za-z]*)/g)) {
    const cmd = m[1];
    const n = (m[2].match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    switch (cmd) {
      case 'M': case 'L':
        for (let i = 0; i + 1 < n.length; i += 2) put(n[i], n[i + 1]);
        started = true;
        break;
      case 'm': case 'l':
        for (let i = 0; i + 1 < n.length; i += 2) put(started ? x + n[i] : n[i], started ? y + n[i + 1] : n[i + 1]);
        started = true;
        break;
      case 'H': for (const v of n) put(v, y); break;
      case 'h': for (const v of n) put(x + v, y); break;
      case 'V': for (const v of n) put(x, v); break;
      case 'v': for (const v of n) put(x, y + v); break;
      // Curves: the endpoint is the only part that has to sit on the grid.
      case 'C': for (let i = 5; i < n.length; i += 6) put(n[i - 1], n[i]); break;
      case 'c': for (let i = 5; i < n.length; i += 6) put(x + n[i - 1], y + n[i]); break;
      case 'S': case 'Q': for (let i = 3; i < n.length; i += 4) put(n[i - 1], n[i]); break;
      case 's': case 'q': for (let i = 3; i < n.length; i += 4) put(x + n[i - 1], y + n[i]); break;
      case 'A': for (let i = 6; i < n.length; i += 7) put(n[i - 1], n[i]); break;
      case 'a': for (let i = 6; i < n.length; i += 7) put(x + n[i - 1], y + n[i]); break;
      default: break; // Z closes; T is unused here.
    }
  }
  return out;
}

/**
 * One row per tier. The invariants are the same on both grids; only the
 * numbers differ, and they differ in proportion: the margin is a twelfth of
 * the box, the minimum span half the live area.
 */
interface Tier {
  name: string;
  entries: [string, string][];
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
    name: 'tool', entries: Object.entries(DRAWING_TOOL_ICONS), attrs: ICON_ATTRS,
    viewBox: ICON_VIEWBOX, stroke: ICON_STROKE, grid: 24, lo: 2, hi: 22, minSpan: 10, maxCommands: 14,
  },
  {
    name: 'chrome', entries: Object.entries(CHROME_ICONS), attrs: CHROME_ICON_ATTRS,
    viewBox: CHROME_ICON_VIEWBOX, stroke: CHROME_ICON_STROKE, grid: 16, lo: 1, hi: 15, minSpan: 7, maxCommands: 14,
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
      const pts = gridPoints(d);
      if (pts.length < 4) continue;
      const xs = pts.filter((_, i) => i % 2 === 0);
      const ys = pts.filter((_, i) => i % 2 === 1);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      expect(span, `${id} spans only ${span} units`).toBeGreaterThanOrEqual(tier.minSpan);
    }
  });

  it('has no duplicate glyph, which would make two buttons indistinguishable', () => {
    const seen = new Map<string, string>();
    for (const [id, d] of tier.entries) {
      const prev = seen.get(d);
      expect(prev, `${id} draws the same as ${prev}`).toBeUndefined();
      seen.set(d, id);
    }
  });
});

describe('the two tiers read as one set', () => {
  it('pins each tier to the stroke it was drawn for', () => {
    expect(ICON_STROKE).toBe(2);
    expect(CHROME_ICON_STROKE).toBe(1.5);
  });

  it('holds the chrome stroke within the band that matches the tool weight by eye', () => {
    // Stroke as a fraction of the box. Exact proportion would be 1.33 at 16,
    // and 1.33 reads thin beside the 24 rail: a small glyph needs a little more
    // relative weight than a large one to look the same. So the band is
    // one-sided, from parity to fifteen percent heavier: lighter than the tool
    // tier, or heavier than that, and the two rails read as two sets.
    const tool = ICON_STROKE / 24;
    const chrome = CHROME_ICON_STROKE / 16;
    const ratio = chrome / tool;
    expect(ratio).toBeGreaterThanOrEqual(1);
    expect(ratio).toBeLessThanOrEqual(1.15);
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
