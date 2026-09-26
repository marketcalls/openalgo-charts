/**
 * The widget's own glyphs, held to the chrome tier's grid.
 *
 * A handful of pictures (settings tabs, stacking order, fit) live in the
 * widget because the chrome registry does not carry them. They are drawn on
 * the same 16 grid and shown at the same stroke, and when that stroke moved
 * from 1.5 to 2 they were not redrawn: the price tab's wicks filled its
 * candle bodies solid, and the style brush sat on half units and reached the
 * edge of its box. Nothing checked them, because the registry tests only walk
 * the registry.
 */
import { describe, it, expect } from 'vitest';
import { CHROME_ICON_STROKE, CHROME_ICON_ATTRS } from '../src/draw/icons';
import { glyphSvg } from '../src/widget/form';
import { ABOVE_GLYPH, BEHIND_GLYPH, FIT_GLYPH, STYLE_GLYPH, TAB_GLYPH } from '../src/widget/glyphs';
import { clotted, coords, subpaths } from './helpers/icon-geometry';

const GLYPHS: [string, string][] = [
  ...Object.entries(TAB_GLYPH).map(([id, d]): [string, string] => [`tab ${id}`, d]),
  ['style', STYLE_GLYPH], ['above', ABOVE_GLYPH], ['behind', BEHIND_GLYPH], ['fit', FIT_GLYPH],
];

describe('the widget-local glyphs', () => {
  it('are drawn in the chrome frame, at the chrome stroke', () => {
    // One weight beside the registry glyphs in the same tab rail or menu.
    const svg = glyphSvg('M2 8h12');
    expect(svg).toContain(`viewBox="${CHROME_ICON_ATTRS.viewBox}"`);
    expect(svg).toContain(`stroke-width="${CHROME_ICON_STROKE}"`);
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('stroke-linejoin="round"');
  });

  it.each(GLYPHS)('%s lands on whole units', (_id, d) => {
    // With a stroke of 2, an orthogonal edge on a whole unit covers exactly
    // two pixels at 16px; a half unit blurs it across three.
    for (const n of coords(d)) expect(Number.isInteger(n), `${n} in ${d}`).toBe(true);
  });

  it.each(GLYPHS)('%s stays inside the 2..14 live area, curves included', (_id, d) => {
    // The ink reaches a unit past the centre line, so a point past 14 puts it
    // on the box edge, where the glyph looks larger than its neighbours.
    for (const s of subpaths(d)) {
      for (const [x, y] of s.extent) {
        expect(x, d).toBeGreaterThanOrEqual(2 - 1e-9);
        expect(x, d).toBeLessThanOrEqual(14 + 1e-9);
        expect(y, d).toBeGreaterThanOrEqual(2 - 1e-9);
        expect(y, d).toBeLessThanOrEqual(14 + 1e-9);
      }
    }
  });

  it.each(GLYPHS)('%s keeps its hollow shapes hollow at the chrome stroke', (_id, d) => {
    expect(clotted(d, CHROME_ICON_STROKE)).toEqual([]);
  });
});
