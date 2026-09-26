/**
 * The widget's own glyphs: the few pictures the chrome tier does not carry, a
 * settings tab or a stacking order. They are drawn to the chrome tier's rules
 * (a 16 grid, whole units, a 2..14 live area) and shown through `glyphSvg` at
 * `CHROME_ICON_STROKE`, so they sit beside registry glyphs at one weight, and
 * `tests/widget-glyphs.test.ts` holds them to that grid.
 *
 * They were drawn for the old 1.5 line and kept when the chrome line became
 * 2: the price tab's wicks ran through the insides of its candle bodies and
 * the heavier line filled them solid, the style brush sat on half units and
 * reached the box edge, and the front and back arrows touched their bars.
 */

/**
 * A glyph per chart settings tab, keyed by the schema's tab id rather than by
 * position so a reordering in the engine cannot shuffle the pictures; a tab
 * this table does not know draws none. The price tab is a hollow candle and a
 * solid one, their wicks stopping at the body.
 */
export const TAB_GLYPH: Readonly<Record<string, string>> = {
  price: 'M5 2v3M3 5h4v6H3zM5 11v3M12 3v10M11 5h2v6h-2z',
  readout: 'M2 4h8M2 8h12M2 12h9',
  axes: 'M3 2v11h11M3 6h2M3 10h2M7 13v-2M11 13v-2',
  appearance: 'M2 3h12v10H2zM2 8h12M7 3v10',
  trading: 'M2 11l4-4 3 2 5-5M11 4h3v3M2 14h12',
};

/** The indicator settings style tab: a brush, its tip solid. */
export const STYLE_GLYPH = 'M14 2 9 7M9 7 7 5M9 7l-2 4-4 2 2-4z';

/** A drawing in front of the series: an arrow up to a bar, a pixel short of it. */
export const ABOVE_GLYPH = 'M3 3h10M8 14V7M5 10l3-3 3 3';

/** A drawing behind the series: an arrow down to a bar, a pixel short of it. */
export const BEHIND_GLYPH = 'M3 13h10M8 2v7M5 6l3 3 3-3';

/** Fit every bar: a double arrow across. */
export const FIT_GLYPH = 'M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3';
