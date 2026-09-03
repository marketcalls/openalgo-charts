/**
 * Markup for the shipped glyphs: whole `<svg>` strings, a sprite, and a CSS
 * cursor. Strings only, so the engine still ships no DOM; a host drops them
 * into `innerHTML`, a template literal, or `style.cursor` and is done.
 *
 * Path data stays in `icons.ts`. Everything here is derived from that registry
 * and its attribute bag, which is what makes it safe to offer: a host that
 * takes the convenience gets the same grid, stroke and caps as one that wraps
 * the path itself, and the tests on the registry hold for both.
 *
 * Unknown ids throw. The registry returns `undefined` so a host can probe, but
 * a string builder has no such value to hand back, and an empty button in a
 * rail is harder to trace than a stack that names the id.
 */
import {
  CHROME_ICON_ATTRS, CHROME_ICON_FILLED, CHROME_ICONS,
  DRAWING_TOOL_ICONS, ICON_ATTRS, ICON_STROKE,
  type IconAttrs,
} from './icons';

const XMLNS = 'http://www.w3.org/2000/svg';

/** Prefix of every `<symbol id>` in the sprite, and of every `<use href>`. */
export const ICON_SYMBOL_PREFIX = 'oac-icon-';

/** Options shared by the inline builders. */
export interface IconSvgOptions {
  /**
   * Width and height. A number is CSS pixels; a string is written verbatim, so
   * `'1em'` sizes the glyph with the surrounding text. Default: the grid's
   * native size (24 for tools, 16 for chrome), where the stroke is crispest.
   */
  size?: number | string;
  /** Stroke width in viewBox units. Default: the tier's `*_STROKE`. */
  stroke?: number;
  /** A class for the host's own styling. */
  className?: string;
}

/** Options for `toolCursor`. */
export interface ToolCursorOptions {
  /** Cursor image size in CSS pixels. Default 20. Browsers reject images over 128. */
  size?: number;
  /** The pointer's active pixel, from the image's top-left. Default: the centre. */
  hotspot?: readonly [number, number];
  /** Glyph colour. Default white. */
  color?: string;
  /**
   * Halo colour. Default: black under a light `color`, white under a dark one,
   * judged from a hex colour. A non-hex `color` gets a black halo unless this
   * is set.
   */
  halo?: string;
  /** The keyword after the image, for a browser that will not take it. Default `crosshair`. */
  fallback?: string;
}

/** Attribute-value escaping. Ids come from the registry; everything else is host input. */
function attr(value: string | number): string {
  return String(value).replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  ));
}

function glyph(registry: Readonly<Record<string, string>>, id: string, tier: string): string {
  const d = registry[id];
  if (d === undefined) throw new Error(`openalgo-charts: no ${tier} icon "${id}"`);
  return d;
}

/** Grid size from a viewBox, so the cursor's pixel maths follows the registry. */
function gridOf(attrs: IconAttrs): number {
  return Number(attrs.viewBox.split(' ')[2]);
}

/**
 * The `<svg>` around one glyph or one `<use>`. Presentation lives here and
 * nowhere else, so overriding the stroke once changes every glyph.
 */
function frame(inner: string, attrs: IconAttrs, fill: string, opts: IconSvgOptions): string {
  const size = attr(opts.size ?? gridOf(attrs));
  const stroke = opts.stroke ?? attrs.strokeWidth;
  const cls = opts.className ? ` class="${attr(opts.className)}"` : '';
  return `<svg xmlns="${XMLNS}" viewBox="${attrs.viewBox}" width="${size}" height="${size}"`
    + ` fill="${fill}" stroke="${attrs.stroke}" stroke-width="${stroke}"`
    + ` stroke-linecap="${attrs.strokeLinecap}" stroke-linejoin="${attrs.strokeLinejoin}"`
    + `${cls} aria-hidden="true">${inner}</svg>`;
}

/**
 * A complete inline `<svg>` for one tool glyph, stroked in `currentColor`.
 *
 * ```ts
 * button.innerHTML = iconSvg('trend-line');
 * button.innerHTML = iconSvg('trend-line', { size: '1em' });
 * ```
 */
export function iconSvg(id: string, opts: IconSvgOptions = {}): string {
  const d = glyph(DRAWING_TOOL_ICONS, id, 'tool');
  return frame(`<path d="${d}"/>`, ICON_ATTRS, ICON_ATTRS.fill, opts);
}

/**
 * A complete inline `<svg>` for one chrome glyph, on the 16 grid. Glyphs in
 * `CHROME_ICON_FILLED` are painted solid as well as stroked.
 */
export function chromeIconSvg(id: string, opts: IconSvgOptions = {}): string {
  const d = glyph(CHROME_ICONS, id, 'chrome');
  const fill = CHROME_ICON_FILLED.has(id) ? 'currentColor' : CHROME_ICON_ATTRS.fill;
  return frame(`<path d="${d}"/>`, CHROME_ICON_ATTRS, fill, opts);
}

/**
 * One hidden `<svg>` of `<symbol>`s, for a host that shows many glyphs and
 * wants each path in the document once. Inject it once, then place glyphs with
 * `iconUse`. Symbols carry the path and viewBox only; stroke and fill inherit
 * from the `<svg>` around each `<use>`, so one sprite serves every weight.
 *
 * Default: every tool glyph. Repeated ids collapse to one symbol, since a
 * duplicate element id is an invalid document.
 */
export function iconSprite(ids: readonly string[] = Object.keys(DRAWING_TOOL_ICONS)): string {
  let symbols = '';
  for (const id of new Set(ids)) {
    const d = glyph(DRAWING_TOOL_ICONS, id, 'tool');
    symbols += `<symbol id="${ICON_SYMBOL_PREFIX}${id}" viewBox="${ICON_ATTRS.viewBox}"><path d="${d}"/></symbol>`;
  }
  return `<svg xmlns="${XMLNS}" style="display:none" aria-hidden="true">${symbols}</svg>`;
}

/** An `<svg>` that references a symbol from `iconSprite`. Same frame as `iconSvg`. */
export function iconUse(id: string, opts: IconSvgOptions = {}): string {
  glyph(DRAWING_TOOL_ICONS, id, 'tool');
  return frame(`<use href="#${ICON_SYMBOL_PREFIX}${id}"/>`, ICON_ATTRS, ICON_ATTRS.fill, opts);
}

/** Black or white, whichever a hex colour will stand out against. */
function contrastOf(color: string): string {
  const m = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (!m) return '#000';
  const hex = m[1];
  // Short forms double each digit; alpha, when present, does not affect luminance.
  const wide = hex.length < 6 ? hex.split('').map((c) => c + c).join('') : hex;
  const r = parseInt(wide.slice(0, 2), 16);
  const g = parseInt(wide.slice(2, 4), 16);
  const b = parseInt(wide.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? '#000' : '#fff';
}

/**
 * A CSS `cursor` value carrying the tool's glyph, for the canvas while that
 * tool is armed.
 *
 * The glyph is drawn twice: once in `halo`, one pixel wider on each side, and
 * once in `color` on top, so it reads on a light chart and a dark one without
 * the host choosing per theme. The value is `url("data:image/svg+xml,...") x y,
 * fallback`, ready for `canvas.style.cursor`.
 */
export function toolCursor(id: string, opts: ToolCursorOptions = {}): string {
  const d = glyph(DRAWING_TOOL_ICONS, id, 'tool');
  const size = opts.size ?? 20;
  if (!(Number.isFinite(size) && size > 0 && size <= 128)) {
    throw new RangeError(`openalgo-charts: cursor size ${size} is outside 1..128`);
  }
  const [hx, hy] = opts.hotspot ?? [size / 2, size / 2];
  const color = opts.color ?? '#fff';
  const halo = opts.halo ?? contrastOf(color);
  const fallback = opts.fallback ?? 'crosshair';
  // One CSS pixel is this many grid units at the requested size; the halo
  // clears the glyph by a pixel on each side.
  const unit = gridOf(ICON_ATTRS) / size;
  const haloWidth = Math.round((ICON_STROKE + 2 * unit) * 100) / 100;
  const svg = `<svg xmlns="${XMLNS}" viewBox="${ICON_ATTRS.viewBox}" width="${size}" height="${size}"`
    + ` fill="none" stroke-linecap="${ICON_ATTRS.strokeLinecap}" stroke-linejoin="${ICON_ATTRS.strokeLinejoin}">`
    + `<path d="${d}" stroke="${attr(halo)}" stroke-width="${haloWidth}"/>`
    + `<path d="${d}" stroke="${attr(color)}" stroke-width="${ICON_STROKE}"/>`
    + '</svg>';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.round(hx)} ${Math.round(hy)}, ${fallback}`;
}
