// The shell bar's icons: each action keeps a picture of its own.
import { describe, it, expect } from 'vitest';
import { ticon, CHART_TYPES, chartTypeIcon } from '../src/toolbar.js';

describe('toolbar icons', () => {
  it('draws grid lines for Grid and a divided frame for the grid view, not one icon for both', () => {
    expect(ticon('grid')).toContain('M3 8h14');
    expect(ticon('gridView')).toContain('<rect');
    expect(ticon('grid')).not.toBe(ticon('gridView'));
  });

  it('gives every chart type a glyph of its own, from the draw tier', () => {
    // Three kinds of line once shared one silhouette, and five types the candle pair.
    const types = CHART_TYPES.filter((t) => t.v);
    const drawn = types.map((t) => ticon(t.icon));
    expect(new Set(drawn).size).toBe(types.length);
    for (const t of types) expect(t.icon, t.v).toMatch(/^chart-/);
    // On the tier's 16 grid at the bar's box, classed so the sheet keeps its line weight.
    expect(ticon('chart-step')).toContain('viewBox="0 0 16 16"');
    expect(ticon('chart-step')).toContain('class="tglyph"');
    expect(chartTypeIcon('t:range')).toBe('chart-range-bars');
    expect(chartTypeIcon('not-a-type')).toBe('chart-candlestick');
  });
});
