/**
 * The markup builders over the icon registries.
 *
 * `tests/draw-icons.test.ts` holds the path data to one grid. This file holds
 * the strings built from it: that every `<svg>` carries the tier's attribute
 * bag and nothing else, that a sprite and its `<use>`s agree on ids, and that
 * a cursor value is something a browser will actually take.
 */
import { describe, it, expect } from 'vitest';
import {
  iconSvg, chromeIconSvg, iconSprite, iconUse, toolCursor, ICON_SYMBOL_PREFIX,
} from '../src/draw/icon-svg';
import {
  DRAWING_TOOL_ICONS, drawingToolIconIds, ICON_VIEWBOX, ICON_STROKE,
  CHROME_ICONS, CHROME_ICON_FILLED, chromeIconIds, CHROME_ICON_VIEWBOX, CHROME_ICON_STROKE,
} from '../src/draw/icons';

const TOOL_IDS = drawingToolIconIds();
const CHROME_IDS = chromeIconIds();

/** The `<path .../>` elements of a markup string, in document order, attributes as a map. */
function paths(svg: string): Record<string, string>[] {
  return [...svg.matchAll(/<path ([^>]*)\/>/g)].map((m) => {
    const out: Record<string, string> = {};
    for (const a of m[1].matchAll(/([a-z-]+)="([^"]*)"/g)) out[a[1]] = a[2];
    return out;
  });
}

/** Attributes of the outermost `<svg>`. */
function root(svg: string): Record<string, string> {
  const open = /^<svg ([^>]*)>/.exec(svg);
  expect(open, 'starts with an <svg> open tag').not.toBeNull();
  const out: Record<string, string> = {};
  for (const a of open![1].matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) out[a[1]] = a[2];
  return out;
}

describe('iconSvg', () => {
  it('wraps the registry path in the tier attribute bag, and nothing else', () => {
    const svg = iconSvg('trend-line');
    const r = root(svg);
    expect(r.xmlns).toBe('http://www.w3.org/2000/svg');
    expect(r.viewBox).toBe(ICON_VIEWBOX);
    expect(r.width).toBe('24');
    expect(r.height).toBe('24');
    expect(r.fill).toBe('none');
    expect(r.stroke).toBe('currentColor');
    expect(r['stroke-width']).toBe(String(ICON_STROKE));
    expect(r['stroke-linecap']).toBe('round');
    expect(r['stroke-linejoin']).toBe('round');
    expect(r['aria-hidden']).toBe('true');
    expect(r.class).toBeUndefined();
    expect(paths(svg)).toEqual([{ d: DRAWING_TOOL_ICONS['trend-line'] }]);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).not.toMatch(/\n/);
  });

  it.each(TOOL_IDS)('%s renders its own registry path', (id) => {
    expect(paths(iconSvg(id))).toEqual([{ d: DRAWING_TOOL_ICONS[id] }]);
  });

  it('takes a pixel size, or a unit string for text-relative sizing', () => {
    expect(root(iconSvg('ray', { size: 48 })).width).toBe('48');
    expect(root(iconSvg('ray', { size: 48 })).height).toBe('48');
    expect(root(iconSvg('ray', { size: '1em' })).width).toBe('1em');
    expect(root(iconSvg('ray', { size: '1em' })).height).toBe('1em');
  });

  it('lets a host override the stroke once, on the frame, not the path', () => {
    const svg = iconSvg('ray', { stroke: 1.5 });
    expect(root(svg)['stroke-width']).toBe('1.5');
    expect(paths(svg)[0]['stroke-width']).toBeUndefined();
  });

  it('escapes a class name, since it is host input inside an attribute', () => {
    const svg = iconSvg('ray', { className: 'rail__icon "x" <y> & z' });
    expect(root(svg).class).toBe('rail__icon &quot;x&quot; &lt;y&gt; &amp; z');
    expect(svg).not.toMatch(/"x"/);
  });

  it('throws for an unknown id, naming it', () => {
    // The registry returns undefined so a host can probe; a string builder has
    // no such value, and an empty button is harder to trace than a stack.
    expect(() => iconSvg('no-such-tool')).toThrow(/no-such-tool/);
  });
});

describe('chromeIconSvg', () => {
  it('mirrors iconSvg on the 16 grid with the chrome stroke', () => {
    const r = root(chromeIconSvg('undo'));
    expect(r.viewBox).toBe(CHROME_ICON_VIEWBOX);
    expect(r.width).toBe('16');
    expect(r.height).toBe('16');
    expect(r['stroke-width']).toBe(String(CHROME_ICON_STROKE));
    expect(r.stroke).toBe('currentColor');
    expect(r['stroke-linecap']).toBe('round');
    expect(r['stroke-linejoin']).toBe('round');
    expect(paths(chromeIconSvg('undo'))).toEqual([{ d: CHROME_ICONS.undo }]);
  });

  it.each(CHROME_IDS)('%s renders its own registry path', (id) => {
    expect(paths(chromeIconSvg(id))).toEqual([{ d: CHROME_ICONS[id] }]);
  });

  it('paints the filled glyphs solid, and only those', () => {
    // The registry carries no fill, so this is the one place the filled state
    // exists; a host that reads the path itself consults CHROME_ICON_FILLED.
    for (const id of CHROME_IDS) {
      const expected = CHROME_ICON_FILLED.has(id) ? 'currentColor' : 'none';
      expect(root(chromeIconSvg(id)).fill, id).toBe(expected);
    }
    expect(root(chromeIconSvg('star-filled')).fill).toBe('currentColor');
    expect(root(chromeIconSvg('star')).fill).toBe('none');
  });

  it('honours size, stroke and class like the tool builder', () => {
    const r = root(chromeIconSvg('close', { size: 32, stroke: 2, className: 'x' }));
    expect(r.width).toBe('32');
    expect(r['stroke-width']).toBe('2');
    expect(r.class).toBe('x');
  });

  it('throws for a tool id, which lives on the other grid', () => {
    expect(() => chromeIconSvg('trend-line')).toThrow(/trend-line/);
  });
});

describe('iconSprite', () => {
  const symbols = (svg: string): { id: string; viewBox: string; body: string }[] =>
    [...svg.matchAll(/<symbol id="([^"]+)" viewBox="([^"]+)">(.*?)<\/symbol>/g)]
      .map((m) => ({ id: m[1], viewBox: m[2], body: m[3] }));

  it('is one hidden svg with one symbol per glyph by default', () => {
    const svg = iconSprite();
    expect(root(svg).style).toBe('display:none');
    expect(root(svg)['aria-hidden']).toBe('true');
    const syms = symbols(svg);
    expect(syms.length).toBe(TOOL_IDS.length);
    expect(syms.map((s) => s.id)).toEqual(TOOL_IDS.map((id) => ICON_SYMBOL_PREFIX + id));
    for (const s of syms) expect(s.viewBox).toBe(ICON_VIEWBOX);
  });

  it('keeps each symbol presentation-free, so stroke and fill inherit from the use site', () => {
    // One sprite serves every weight only if nothing inside it fixes one.
    for (const s of symbols(iconSprite())) {
      expect(s.body).toMatch(/^<path d="[^"]+"\/>$/);
      expect(s.body).not.toMatch(/stroke|fill/);
    }
  });

  it('takes a subset, and collapses repeats to one symbol', () => {
    // A repeated element id is an invalid document, and browsers resolve
    // <use> to the first match anyway.
    const syms = symbols(iconSprite(['ray', 'arrow', 'ray']));
    expect(syms.map((s) => s.id)).toEqual([`${ICON_SYMBOL_PREFIX}ray`, `${ICON_SYMBOL_PREFIX}arrow`]);
    expect(syms[0].body).toBe(`<path d="${DRAWING_TOOL_ICONS.ray}"/>`);
  });

  it('throws for an unknown id rather than emitting an empty symbol', () => {
    expect(() => iconSprite(['ray', 'no-such-tool'])).toThrow(/no-such-tool/);
  });
});

describe('iconUse', () => {
  it.each(TOOL_IDS)('%s references a symbol the default sprite defines', (id) => {
    const use = iconUse(id);
    const href = /<use href="#([^"]+)"\/>/.exec(use);
    expect(href).not.toBeNull();
    expect(iconSprite()).toContain(`<symbol id="${href![1]}"`);
  });

  it('carries the same frame as iconSvg, since the symbol carries nothing', () => {
    const a = root(iconUse('ray', { size: 32, className: 'k' }));
    const b = root(iconSvg('ray', { size: 32, className: 'k' }));
    expect(a).toEqual(b);
    expect(paths(iconUse('ray'))).toEqual([]);
  });

  it('throws for an unknown id, so a dangling href never ships', () => {
    expect(() => iconUse('no-such-tool')).toThrow(/no-such-tool/);
  });
});

describe('toolCursor', () => {
  const SHAPE = /^url\("data:image\/svg\+xml,([^"]+)"\) (-?\d+) (-?\d+), ([a-z-]+)$/;

  /** The decoded image and the parsed pieces of a cursor value. */
  function parse(value: string) {
    const m = SHAPE.exec(value);
    expect(m, `not a cursor value: ${value.slice(0, 60)}`).not.toBeNull();
    return { svg: decodeURIComponent(m![1]), payload: m![1], x: Number(m![2]), y: Number(m![3]), fallback: m![4] };
  }

  it('is a CSS cursor value: an image url, a hotspot and a keyword', () => {
    const c = parse(toolCursor('trend-line'));
    expect(c.x).toBe(10);
    expect(c.y).toBe(10);
    expect(c.fallback).toBe('crosshair');
  });

  it('encodes the image so nothing in it can end the url or the declaration', () => {
    const c = parse(toolCursor('trend-line'));
    expect(c.payload).toMatch(/^[A-Za-z0-9%\-_.!~*'()]*$/);
    expect(c.payload).not.toMatch(/[#"<>\s]/);
  });

  it('decodes to a sized svg carrying the glyph twice: a halo under the stroke', () => {
    const c = parse(toolCursor('trend-line'));
    const r = root(c.svg);
    expect(r.width).toBe('20');
    expect(r.height).toBe('20');
    expect(r.viewBox).toBe(ICON_VIEWBOX);
    expect(r.fill).toBe('none');
    const [halo, glyph] = paths(c.svg);
    expect(halo.d).toBe(DRAWING_TOOL_ICONS['trend-line']);
    expect(glyph.d).toBe(DRAWING_TOOL_ICONS['trend-line']);
    expect(glyph.stroke).toBe('#fff');
    expect(glyph['stroke-width']).toBe(String(ICON_STROKE));
    expect(halo.stroke).toBe('#000');
    // The halo has to clear the glyph by exactly one CSS pixel each side at
    // the requested size, whatever that size is.
    const px = (Number(halo['stroke-width']) - ICON_STROKE) * 20 / 24;
    expect(px).toBeCloseTo(2, 5);
  });

  it('scales the halo with the image so it stays one pixel at any size', () => {
    const [halo] = paths(parse(toolCursor('ray', { size: 32 })).svg);
    expect((Number(halo['stroke-width']) - ICON_STROKE) * 32 / 24).toBeCloseTo(2, 2);
  });

  it('picks the halo that contrasts: black under a light glyph, white under a dark one', () => {
    expect(paths(parse(toolCursor('ray', { color: '#000' })).svg)[0].stroke).toBe('#fff');
    expect(paths(parse(toolCursor('ray', { color: '#1a1a1a' })).svg)[0].stroke).toBe('#fff');
    expect(paths(parse(toolCursor('ray', { color: '#ffd700' })).svg)[0].stroke).toBe('#000');
    expect(paths(parse(toolCursor('ray', { color: '#2962ff' })).svg)[0].stroke).toBe('#fff');
    expect(paths(parse(toolCursor('ray', { color: '#fffc' })).svg)[0].stroke).toBe('#000');
  });

  it('lets an explicit halo win, and falls back to black for a colour it cannot read', () => {
    expect(paths(parse(toolCursor('ray', { color: '#000', halo: '#f00' })).svg)[0].stroke).toBe('#f00');
    expect(paths(parse(toolCursor('ray', { color: 'rgb(0,0,0)' })).svg)[0].stroke).toBe('#000');
    expect(paths(parse(toolCursor('ray', { color: 'rgb(0,0,0)' })).svg)[1].stroke).toBe('rgb(0,0,0)');
  });

  it('takes a hotspot, a size and a fallback keyword', () => {
    const c = parse(toolCursor('arrow', { size: 24, hotspot: [3, 21], fallback: 'pointer' }));
    expect(root(c.svg).width).toBe('24');
    expect(c.x).toBe(3);
    expect(c.y).toBe(21);
    expect(c.fallback).toBe('pointer');
  });

  it('rounds the hotspot, which browsers read as whole pixels', () => {
    expect(parse(toolCursor('arrow', { size: 21 })).x).toBe(11);
    expect(parse(toolCursor('arrow', { hotspot: [2.4, 7.6] })).x).toBe(2);
    expect(parse(toolCursor('arrow', { hotspot: [2.4, 7.6] })).y).toBe(8);
  });

  it('rejects a size a browser would refuse', () => {
    expect(() => toolCursor('arrow', { size: 129 })).toThrow(RangeError);
    expect(() => toolCursor('arrow', { size: 0 })).toThrow(RangeError);
    expect(() => toolCursor('arrow', { size: Number.NaN })).toThrow(RangeError);
    expect(() => toolCursor('arrow', { size: 128 })).not.toThrow();
  });

  it.each(TOOL_IDS)('%s stays under 4 KB and decodes to markup with its path', (id) => {
    // A cursor value lands in a style attribute on every tool switch; a large
    // one is a layout cost and some browsers drop it silently.
    const value = toolCursor(id);
    expect(value.length).toBeLessThan(4096);
    const c = parse(value);
    expect(c.svg).toContain(`d="${DRAWING_TOOL_ICONS[id]}"`);
    expect(c.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('throws for an unknown id', () => {
    expect(() => toolCursor('no-such-tool')).toThrow(/no-such-tool/);
  });
});
