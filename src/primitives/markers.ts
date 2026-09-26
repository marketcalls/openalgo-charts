/**
 * Series markers (ARCHITECTURE.md §8.1): buy/sell signals and shapes anchored
 * to bars. Visible-range culled, per-bar stacked, four discrete sizes.
 */
import type { Bar } from '../model/bar';
import type { SeriesId } from '../model/data-layer';
import type { PriceScale } from '../scale/price-scale';
import type { IPrimitive, PrimitiveHost, PrimitiveRenderContext, PrimitiveHit, ZOrder } from './primitive';
import { roundRectPath, contrastText } from '../render/pill';
import { hasTextStyle, textFont, validateTextStyle } from '../render/text-style';

/**
 * `labelUp` / `labelDown` are text plates with a tail, for named signals ("Buy",
 * "Sell") rather than bare glyphs. The tail points *at* the anchor price and the
 * body sits clear of it: `labelUp`'s tail points up so its body hangs below the
 * anchor, `labelDown` is the mirror. Both require `text`.
 */
export type MarkerShape =
  | 'arrowUp' | 'arrowDown' | 'circle' | 'square'
  | 'triangleUp' | 'triangleDown' | 'diamond' | 'flag' | 'text'
  | 'labelUp' | 'labelDown'
  | 'cross' | 'xcross';
/**
 * `paneTop` and `paneBottom` pin the glyph to the edge of the plot rather than
 * to a price, so a squeeze dot or a session flag sits in a fixed row whatever
 * the scale does. They need no bar under them and no `price`.
 */
export type MarkerPosition = 'aboveBar' | 'belowBar' | 'inBar' | 'atPrice' | 'paneTop' | 'paneBottom';
export type MarkerSize = 'tiny' | 'small' | 'medium' | 'big';

export interface SeriesMarker {
  time: number;
  position: MarkerPosition;
  price?: number;
  shape: MarkerShape;
  size: MarkerSize;
  color: string;
  text?: string;
  /** Overrides marker-matching text or contrasting label text without changing the glyph fill. */
  textColor?: string;
  /** Positive finite CSS pixels. Defaults to max(9, the size preset), independently of bar spacing. */
  fontSize?: number;
  /** CSS font-family list. Defaults to system-ui, sans-serif. */
  fontFamily?: string;
  /** Label plates default to semibold; other marker text defaults to normal. */
  bold?: boolean;
  italic?: boolean;
  /** Multiline row alignment inside the centered text block. Defaults to center. */
  textAlign?: 'left' | 'center' | 'right';
  id?: string;
}

const SIZE_PX: Record<MarkerSize, number> = { tiny: 6, small: 9, medium: 12, big: 16 };

/** Base glyph size in CSS px for a marker size preset. */
export function markerSizePx(size: MarkerSize): number {
  return SIZE_PX[size];
}

/** Effective glyph px, clamped so it never exceeds the current bar spacing. */
export function effectiveMarkerPx(size: MarkerSize, barSpacing: number): number {
  return Math.max(4, Math.min(SIZE_PX[size], Math.floor(barSpacing)));
}

export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: MarkerShape,
  cx: number,
  cy: number,
  px: number,
  color: string,
): void {
  const r = px / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.beginPath();
  switch (shape) {
    case 'arrowUp':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath(); ctx.fill();
      break;
    case 'triangleUp':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath(); ctx.fill();
      break;
    case 'arrowDown':
      ctx.moveTo(cx, cy + r); ctx.lineTo(cx + r, cy - r); ctx.lineTo(cx - r, cy - r); ctx.closePath(); ctx.fill();
      break;
    case 'triangleDown':
      ctx.moveTo(cx, cy + r); ctx.lineTo(cx + r, cy - r); ctx.lineTo(cx - r, cy - r); ctx.closePath(); ctx.fill();
      break;
    case 'circle':
      ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      break;
    case 'square':
      ctx.fillRect(cx - r, cy - r, px, px);
      break;
    case 'diamond':
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); ctx.fill();
      break;
    case 'flag':
      ctx.fillRect(cx - 1, cy - r, Math.max(1, px / 8), px); // pole
      ctx.fillRect(cx, cy - r, r, r * 0.8); // flag
      break;
    case 'cross': {
      // Two filled bars rather than a stroke, so the arms stay crisp at the
      // integer widths every other glyph here lands on.
      const t = Math.max(1, Math.round(px / 6));
      ctx.fillRect(cx - r, cy - Math.floor(t / 2), px, t);
      ctx.fillRect(cx - Math.floor(t / 2), cy - r, t, px);
      break;
    }
    case 'xcross':
      ctx.lineWidth = Math.max(1, Math.round(px / 6));
      ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
      ctx.stroke();
      break;
    case 'text':
    case 'labelUp':
    case 'labelDown':
      // text-bearing markers: nothing drawn here; the caller has the string,
      // the font, and the device ratio. See `drawLabel`.
      break;
  }
}

/**
 * Row pitch for `\n`-separated marker text, as a multiple of the font size.
 * Same pitch the drawings tier uses for its plates, so a label reads the same
 * whichever tier ends up painting it.
 */
const LINE_H = 1.35;
type MarkerTextStyle = Pick<SeriesMarker, 'fontFamily' | 'bold' | 'italic' | 'textAlign' | 'textColor'>;

function labelLayout(ctx: CanvasRenderingContext2D, up: boolean, anchorY: number, text: string, fontPx: number) {
  const padX = fontPx * 0.5;
  const lines = text.indexOf('\n') < 0 ? undefined : text.split('\n');
  let textW = ctx.measureText(lines === undefined ? text : lines[0]).width;
  if (lines !== undefined) for (let i = 1; i < lines.length; i++) textW = Math.max(textW, ctx.measureText(lines[i]).width);
  const lh = fontPx * LINE_H;
  const w = textW + padX * 2;
  const h = fontPx + fontPx * 0.64 + (lines === undefined ? 0 : lh * (lines.length - 1));
  const tail = fontPx * 0.42;
  return { lines, lh, w, h, tail, textW, top: up ? anchorY + tail : anchorY - tail - h };
}

/**
 * A signal label: rounded plate, contrasting text, and a tail that points at
 * `anchorY`. All coordinates are bitmap px — the caller has already applied dpr.
 * `up` puts the tail on the top edge and the body below the anchor.
 *
 * `text` may carry `\n`: the plate widens to the longest row and grows
 * downward-and-upward about its own centre, so it stays centred on `cx` and the
 * tail keeps meeting the anchor price.
 */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  up: boolean,
  cx: number,
  anchorY: number,
  text: string,
  color: string,
  fontPx: number,
): void {
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  // The overwhelmingly common label is one row, so it never pays for a split:
  // undefined here keeps the original single-measure, single-fillText path and
  // with it the exact plate geometry markers have always had.
  const layout = labelLayout(ctx, up, anchorY, text, fontPx);
  paintLabel(ctx, up, cx, anchorY, text, color, fontPx, layout);
}

function paintLabel(ctx: CanvasRenderingContext2D, up: boolean, cx: number, anchorY: number, text: string,
  color: string, fontPx: number, layout: ReturnType<typeof labelLayout>, style?: MarkerTextStyle): void {
  const { w, h, top, tail, lines, lh, textW } = layout;

  ctx.fillStyle = color;
  ctx.beginPath();
  roundRectPath(ctx, cx - w / 2, top, w, h, Math.min(fontPx * 0.3, h / 2));
  ctx.fill();
  // The tail overlaps the plate edge by a pixel so the two fills read as one
  // shape instead of showing a hairline seam at fractional dpr.
  const base = up ? top + 1 : top + h - 1;
  ctx.beginPath();
  ctx.moveTo(cx, anchorY);
  ctx.lineTo(cx - tail, base);
  ctx.lineTo(cx + tail, base);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = style?.textColor ?? contrastText(color);
  ctx.textAlign = style?.textAlign ?? 'center';
  ctx.textBaseline = 'middle';
  const tx = style?.textAlign === 'left' ? cx - textW / 2 : style?.textAlign === 'right' ? cx + textW / 2 : cx;
  if (lines === undefined) {
    ctx.fillText(text, tx, top + h / 2);
    return;
  }
  const first = top + h / 2 - (lh * (lines.length - 1)) / 2;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], tx, first + lh * i);
}

/** The bar at exactly `time` in a time-sorted series, by binary search. */
function barAtTime(bars: readonly Bar[], time: number): Bar | undefined {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = bars[mid].time;
    if (t === time) return bars[mid];
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

export class SeriesMarkers implements IPrimitive {
  private readonly _seriesId: SeriesId;
  private readonly _fallbackBars: (() => readonly Bar[]) | undefined;
  private readonly _priceScale: (() => PriceScale) | undefined;
  private _markers: SeriesMarker[] = [];
  private _host: PrimitiveHost | null = null;
  private _lastPositions: { id: string; x: number; y: number; clip?: { width: number; height: number } }[] = [];

  /**
   * @param seriesId The series whose pane and price scale the marks live on.
   * @param fallbackBars Bars to position against where that series has none.
   *
   * The second argument exists because a marker's series decides *where* it is
   * drawn while the bar under it decides *how high*, and those are not always
   * the same row of data. An indicator that draws one line in an uptrend and
   * another in a downtrend has a gap in each, and a mark that lands in a gap
   * had no bar to measure from and was dropped without a word. The caller
   * passes the instrument's own bars, which have no gaps.
   */
  public constructor(seriesId: SeriesId, fallbackBars?: () => readonly Bar[], priceScale?: () => PriceScale) {
    this._seriesId = seriesId;
    this._fallbackBars = fallbackBars;
    this._priceScale = priceScale;
  }

  public attached(host: PrimitiveHost): void { this._host = host; }
  public detached(): void { this._host = null; this._lastPositions = []; }
  public zOrder(): ZOrder { return 'normal'; }

  public setMarkers(markers: readonly SeriesMarker[]): void {
    for (const marker of markers) {
      validateTextStyle(marker);
      if (marker.textColor !== undefined && (typeof marker.textColor !== 'string' || marker.textColor.trim() === '')) {
        throw new TypeError('Marker textColor must be a nonempty color string');
      }
    }
    this._markers = markers.slice().sort((a, b) => a.time - b.time);
    this._lastPositions = [];
    this._host?.requestUpdate();
  }

  public draw(ctx: CanvasRenderingContext2D, rc: PrimitiveRenderContext): void {
    this._lastPositions = [];
    if (this._markers.length === 0) return;
    // Bars are looked up per drawn marker, never collected up front: a paint
    // runs on every live tick, and indexing the whole history here made the
    // frame cost grow with the history length instead of with what is shown.
    const own = rc.dataLayer.seriesBars(this._seriesId);
    let fallback: readonly Bar[] | undefined;
    let fallbackByTime: Map<number, Bar> | undefined;
    const barAt = (time: number): Bar | undefined => {
      // A real point on the marker's own series wins; indicator null columns
      // retain their timestamp as NaN points. Where that series has a gap the
      // instrument's bar stands in, which is the whole point: the mark is drawn
      // rather than lost.
      const bar = barAtTime(own, time);
      if (bar !== undefined && Number.isFinite(bar.close)) return bar;
      if (this._fallbackBars === undefined) return undefined;
      fallback ??= this._fallbackBars();
      // The fallback comes from the host and is not promised to be sorted. An
      // exact hit is right either way; only a miss has to be confirmed by
      // indexing it, at most once per paint.
      const hit = barAtTime(fallback, time);
      if (hit !== undefined) return hit;
      if (fallbackByTime === undefined) {
        fallbackByTime = new Map();
        for (const b of fallback) fallbackByTime.set(b.time, b);
      }
      return fallbackByTime.get(time);
    };
    const priceScale = this._priceScale?.() ?? rc.priceScale;
    const range = rc.timeScale.visibleRange();
    const stackByTime = new Map<number, number>();

    ctx.save();
    for (const m of this._markers) {
      const styled = hasTextStyle(m) || m.textColor !== undefined;
      const index = rc.dataLayer.timeToIndex(m.time);
      if (index === undefined || (!styled && (index < range.from - 1 || index > range.to + 1))) continue;
      const bar = m.position === 'paneTop' || m.position === 'paneBottom' ? undefined : barAt(m.time);
      const px =effectiveMarkerPx(m.size, rc.timeScale.barSpacing) * rc.dpr;
      const x = rc.timeScale.indexToX(index) * rc.dpr;
      const stack = stackByTime.get(m.time) ?? 0;
      const gap = (px + 4 * rc.dpr) * stack;
      let y: number;
      if (m.position === 'paneTop') {
        // Pinned to the plot edge, stacking inward, so the row never moves
        // with the scale and needs no bar under it.
        y = px / 2 + 4 * rc.dpr + gap;
      } else if (m.position === 'paneBottom') {
        y = rc.plotHeight * rc.dpr - px / 2 - 4 * rc.dpr - gap;
      } else if (m.position === 'atPrice' && m.price !== undefined) {
        y = priceScale.priceToY(m.price) * rc.dpr;
      } else if (bar !== undefined && m.position === 'aboveBar') {
        y = priceScale.priceToY(bar.high) * rc.dpr - px - gap;
      } else if (bar !== undefined && m.position === 'belowBar') {
        y = priceScale.priceToY(bar.low) * rc.dpr + px + gap;
      } else if (bar !== undefined) {
        y = priceScale.priceToY((bar.open + bar.close) / 2) * rc.dpr;
      } else {
        continue;
      }
      if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
      stackByTime.set(m.time, stack + 1);
      const fontPx = (m.fontSize ?? Math.max(9, markerSizePx(m.size))) * rc.dpr;
      const label = m.shape === 'labelUp' || m.shape === 'labelDown';
      const validFont = Number.isFinite(fontPx) && fontPx > 0;
      if (label && !validFont) continue;
      let drawText = validFont && m.text !== undefined;
      const below = m.position === 'belowBar' || m.position === 'paneTop';
      const ty = below ? y + px : y - px;
      let textW = 0, layout: ReturnType<typeof labelLayout> | undefined;
      if (styled) {
        if (drawText) ctx.font = textFont(m, fontPx, 'system-ui, sans-serif', label);
        let left = x - px / 2, right = x + px / 2, top = y - px / 2, bottom = y + px / 2;
        if (drawText && m.text !== undefined) {
          if (label) {
            layout = labelLayout(ctx, m.shape === 'labelUp', y, m.text, fontPx);
            left = x - layout.w / 2; right = x + layout.w / 2;
            top = Math.min(y, layout.top); bottom = Math.max(y, layout.top + layout.h);
          } else {
            const lines = m.text.split('\n');
            for (const line of lines) textW = Math.max(textW, ctx.measureText(line).width);
            const textH = fontPx + (lines.length - 1) * fontPx * LINE_H;
            left = Math.min(left, x - textW / 2); right = Math.max(right, x + textW / 2);
            top = Math.min(top, below ? ty : ty - textH); bottom = Math.max(bottom, below ? ty + textH : ty);
          }
        }
        if (!label && ![left, right, top, bottom].every(Number.isFinite)) {
          // Unrenderable text cannot erase an independently sized signal glyph.
          drawText = false;
          left = x - px / 2; right = x + px / 2; top = y - px / 2; bottom = y + px / 2;
        }
        if (![left, right, top, bottom].every(Number.isFinite) || right < 0 || left > rc.plotWidth * rc.dpr
          || bottom < 0 || top > rc.plotHeight * rc.dpr) continue;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, rc.plotWidth * rc.dpr, rc.plotHeight * rc.dpr); ctx.clip();
      }
      const clip = styled ? { width: rc.plotWidth, height: rc.plotHeight } : undefined;
      if (m.shape === 'labelUp' || m.shape === 'labelDown') {
        if (m.text !== undefined) {
          if (layout) paintLabel(ctx, m.shape === 'labelUp', x, y, m.text, m.color, fontPx, layout, m);
          else drawLabel(ctx, m.shape === 'labelUp', x, y, m.text, m.color, fontPx);
        }
        if (m.id !== undefined) this._lastPositions.push({ id: m.id, x: x / rc.dpr, y: y / rc.dpr, clip });
        if (styled) ctx.restore();
        continue;
      }
      drawShape(ctx, m.shape, x, y, px, m.color);
      if (drawText && m.text !== undefined) {
        ctx.fillStyle = m.textColor ?? m.color;
        ctx.font = textFont(m, fontPx, 'system-ui, sans-serif');
        ctx.textAlign = m.textAlign ?? 'center';
        // Text grows away from the edge a pinned marker sits on, the way it
        // grows away from the bar for the bar-anchored positions.
        ctx.textBaseline = below ? 'top' : 'bottom';
        const tx = m.textAlign === 'left' ? x - textW / 2 : m.textAlign === 'right' ? x + textW / 2 : x;
        if (m.text.indexOf('\n') < 0) {
          ctx.fillText(m.text, tx, ty);
        } else {
          // Rows grow away from the bar (down below it, up above it) and the
          // block is written from the anchor outward, so whichever edge the
          // baseline pins stays put and the text never runs back over the candle.
          const lines = m.text.split('\n');
          const lh = fontPx * LINE_H;
          for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[below ? i : lines.length - 1 - i], tx, below ? ty + lh * i : ty - lh * i);
          }
        }
      }
      if (m.id !== undefined) this._lastPositions.push({ id: m.id, x: x / rc.dpr, y: y / rc.dpr, clip });
      if (styled) ctx.restore();
    }
    ctx.restore();
  }

  public hitTest(x: number, y: number): PrimitiveHit | null {
    let best: PrimitiveHit | null = null;
    for (const p of this._lastPositions) {
      if (p.clip && (x < 0 || y < 0 || x > p.clip.width || y > p.clip.height)) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= 8 && (best === null || d < best.distance)) {
        best = { externalId: p.id, zOrder: 'normal', distance: d, cursor: 'pointer' };
      }
    }
    return best;
  }
}
