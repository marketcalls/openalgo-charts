/**
 * The WebGL2 render backend: the series pass rasterised on the GPU, everything
 * else exactly where the 2D backend leaves it.
 *
 * How it sits in the pane. The pane's base canvas keeps its 2D context, and
 * the backend is handed that context at `mount`, the same way the 2D backend
 * is. The GPU draws into a separate surface that is never in the document:
 * one WebGL2 context shared by every pane of every chart on the page (a
 * browser allows around sixteen live contexts, and a dashboard of a few
 * multi-pane charts would exhaust that at one per pane). `endFrame` renders
 * the frame's batch and blits the surface into the base canvas with one
 * `drawImage`, under the pane's current transform and plot clip, at the
 * exact point in the frame where the 2D backend would have painted the same
 * series. The composite is a GPU-side copy in every accelerated browser.
 *
 * That one decision is what keeps the rest of the engine unchanged: the pane
 * still owns one canvas per layer, the grid stays under the series and the
 * price lines and drawings over them, `takeScreenshot` and the context-menu
 * freeze still read `pane.base.element`, and a parity spec counting canvases
 * per pane counts the same number.
 *
 * What is drawn natively is every Family-A type: candles (plain, hollow,
 * volume), bars, high-low, line, line-markers, step, area, HLC area,
 * baseline, column and histogram. Each emitter mirrors its 2D renderer
 * branch for branch and takes its geometry from the same functions
 * (`candleGeometry`, `optimalBarWidth`, `candleTier`, `barGeometry`,
 * `valuePoints`, `stepPoints`), so the two backends agree on which device
 * pixels a bar covers. Anything else (kagi, point and figure, a custom type)
 * falls back: the batch so far is flushed to keep z-order, and the entry's
 * own renderer paints on the 2D context. A lost context takes the same
 * fallback for the whole frame, so the chart never goes blank while the GPU
 * is away; when the context comes back the program is rebuilt and the next
 * frame is on the GPU again.
 */
import type { DrawItem, RendererEntry, SeriesRenderContext, SeriesType } from '../../model/chart-type-registry';
// The two registries come from the package entry, not a deep path. This file
// ships in the webgl tier, which rollup builds as its own bundle with only
// 'openalgo-charts' external: a relative import of the chart-type registry
// would inline a private Map whose entry objects `nativeKind` could never
// match against the base's, and every series would silently take the 2D
// fallback while `chart.rendererKind` still said 'webgl2'. The same rule
// as src/transform/index.ts.
import { getChartType, registeredChartTypes, registerRenderBackend } from 'openalgo-charts';
import type { Bar } from '../../model/bar';
import type { ChartTheme } from '../../theme';
import type { SeriesStyle } from '../series-style';
import type { IRenderBackend } from '../backend';
import {
  candleGeometry, candleTier, optimalBarWidth, DEFAULT_CANDLE_STYLE, type CandleStyle,
} from '../candles';
import { barGeometry } from '../bars';
import { valuePoints, stepPoints, type Pt } from '../line';
import { VertexBatch } from './batch';
import { ColorCache, TRANSPARENT, lerpPremultiplied, normaliseWith2d, type PremultipliedRgba } from './color';
import { bindShapeAttributes, compileShapeProgram, type ShapeProgram } from './shaders';

/**
 * What the shared context is created on: a detached canvas or an
 * OffscreenCanvas. Only the members the device touches, so a test can hand
 * in a plain object with a recording context behind `getContext`.
 */
export interface GlSurface {
  width: number;
  height: number;
  getContext(id: 'webgl2', attributes?: WebGLContextAttributes): WebGL2RenderingContext | null;
  addEventListener?(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
}

/**
 * The context attributes. Anti-aliasing is analytic in the shader, alpha is
 * premultiplied because that is what the batch carries and what `drawImage`
 * expects of a WebGL source, and the drawing buffer need not survive a
 * frame because the blit happens synchronously in the same task as the draw.
 */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  depth: false,
  stencil: false,
};

/** A detached canvas from the document, else an OffscreenCanvas, else nothing. */
function defaultSurface(): GlSurface | null {
  const doc = (globalThis as { document?: Document }).document;
  if (doc !== undefined && typeof doc.createElement === 'function') {
    return doc.createElement('canvas') as unknown as GlSurface;
  }
  const Offscreen = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => unknown }).OffscreenCanvas;
  if (Offscreen !== undefined) return new Offscreen(1, 1) as GlSurface;
  return null;
}

/**
 * One WebGL2 context, its program and its buffers, shared by every backend
 * built for the same surface factory. Reference counted by mounted backends
 * so the drawing buffer is given back once the last chart is destroyed; the
 * context itself is kept, because a canvas whose context has been lost on
 * purpose hands back that same lost context on the next `getContext`.
 */
export class GlDevice {
  public readonly colors = new ColorCache();
  private readonly _createSurface: () => GlSurface | null;
  private _surface: GlSurface | null = null;
  private _gl: WebGL2RenderingContext | null = null;
  private _program: ShapeProgram | null = null;
  private _vao: WebGLVertexArrayObject | null = null;
  private _vbo: WebGLBuffer | null = null;
  private _ibo: WebGLBuffer | null = null;
  private _indexCapacity = 0;
  private _refs = 0;
  private _lost = false;
  private _probed = false;
  private _onLost = (e: Event): void => {
    // Without this the browser never tries to restore the context.
    e.preventDefault();
    this._lost = true;
    this._program = null;
    this._vao = null;
    this._vbo = null;
    this._ibo = null;
    this._indexCapacity = 0;
  };
  private _onRestored = (): void => {
    this._lost = false;
  };

  public constructor(createSurface: () => GlSurface | null = defaultSurface) {
    this._createSurface = createSurface;
  }

  /** Whether a WebGL2 context exists or can be created. Probes at most once. */
  public get available(): boolean {
    if (!this._probed) {
      this._probed = true;
      this._surface = this._createSurface();
      const gl = this._surface?.getContext('webgl2', CONTEXT_ATTRIBUTES) ?? null;
      if (gl !== null) {
        this._gl = gl;
        this._surface?.addEventListener?.('webglcontextlost', this._onLost);
        this._surface?.addEventListener?.('webglcontextrestored', this._onRestored);
      }
    }
    return this._gl !== null;
  }

  /** True between a context loss and its restoration: frames go through 2D meanwhile. */
  public get lost(): boolean {
    return this._lost || (this._gl !== null && this._gl.isContextLost());
  }

  public get surface(): GlSurface | null {
    return this._surface;
  }

  public get refs(): number {
    return this._refs;
  }

  public get gl(): WebGL2RenderingContext | null {
    return this._gl;
  }

  public acquire(): boolean {
    if (!this.available) return false;
    this._refs++;
    return true;
  }

  public release(): void {
    if (this._refs === 0) return;
    this._refs--;
    // The last pane is gone: hand back the drawing buffer, keep the context.
    if (this._refs === 0 && this._surface !== null) {
      this._surface.width = 1;
      this._surface.height = 1;
    }
  }

  /** Grow the surface to hold a pane of this bitmap size. Never shrinks while in use. */
  public ensureSize(widthPx: number, heightPx: number): void {
    const s = this._surface;
    if (s === null) return;
    if (s.width < widthPx) s.width = widthPx;
    if (s.height < heightPx) s.height = heightPx;
  }

  /**
   * Draw a batch into the top-left `widthPx` by `heightPx` of the surface,
   * cleared first. Returns false when the context is lost or absent, in
   * which case nothing was drawn and the caller must not blit.
   */
  public render(batch: VertexBatch, widthPx: number, heightPx: number): boolean {
    if (this._gl === null || this._surface === null || this.lost) return false;
    const gl = this._gl;
    if (this._program === null && !this._setup(gl)) return false;
    const p = this._program as ShapeProgram;
    this.ensureSize(widthPx, heightPx);
    // GL's window origin is the bottom-left corner, so a pane smaller than
    // the surface is drawn in a viewport raised to the top edge: in image
    // terms (what `drawImage` reads) it then occupies rows 0..heightPx.
    const y0 = this._surface.height - heightPx;
    gl.viewport(0, y0, widthPx, heightPx);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, y0, widthPx, heightPx);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (batch.quadCount === 0) return true;
    gl.useProgram(p.program);
    gl.uniform2f(p.uResolution, widthPx, heightPx);
    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, batch.vertices, gl.STREAM_DRAW, 0, batch.floatCount);
    // Every batch shares the slot pattern, so the buffer on the GPU serves
    // any batch no larger than the one that last filled it.
    if (batch.indices.length > this._indexCapacity) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, batch.indices, gl.STATIC_DRAW);
      this._indexCapacity = batch.indices.length;
    }
    gl.drawElements(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    return true;
  }

  /** Program, buffers and fixed state, built once per context (and again after a restore). */
  private _setup(gl: WebGL2RenderingContext): boolean {
    let program: ShapeProgram;
    try {
      program = compileShapeProgram(gl);
    } catch {
      // A compile failure on a live context is a driver that cannot run the
      // program at all; the backend paints through 2D from here on.
      this._gl = null;
      return false;
    }
    this._program = program;
    this._vao = gl.createVertexArray();
    this._vbo = gl.createBuffer();
    this._ibo = gl.createBuffer();
    this._indexCapacity = 0;
    gl.bindVertexArray(this._vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
    bindShapeAttributes(gl, program);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return true;
  }
}

let shared: GlDevice | null = null;

/** The page-wide device every default backend shares. */
export function sharedGlDevice(): GlDevice {
  if (shared === null) shared = new GlDevice();
  return shared;
}

/** Whether this device can run the WebGL2 backend. Probes once and remembers. */
export function isWebGL2Supported(): boolean {
  if (typeof (globalThis as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext === 'undefined') return false;
  return sharedGlDevice().available;
}

// ── colour resolution, mirroring the registry's private helpers ─────────────

/** The registry's `candleStyle`: style over theme, plus the type's own switches. */
function resolveCandleStyle(s: SeriesStyle, theme: ChartTheme, extra: Partial<CandleStyle> = {}): CandleStyle {
  return {
    ...DEFAULT_CANDLE_STYLE,
    upColor: s.upColor ?? theme.upColor,
    downColor: s.downColor ?? theme.downColor,
    borderUpColor: s.borderUpColor ?? theme.upColor,
    borderDownColor: s.borderDownColor ?? theme.downColor,
    wickUpColor: s.wickUpColor ?? theme.wickUpColor,
    wickDownColor: s.wickDownColor ?? theme.wickDownColor,
    borderVisible: s.borderVisible ?? DEFAULT_CANDLE_STYLE.borderVisible,
    bodyVisible: s.bodyVisible ?? true,
    wickVisible: s.wickVisible ?? DEFAULT_CANDLE_STYLE.wickVisible,
    colorByPreviousClose: s.colorByPreviousClose,
    ...extra,
  };
}

type ColorOf = (css: string) => PremultipliedRgba;

// ── emitters, one per 2D renderer ───────────────────────────────────────────

/**
 * The region a 2D `strokeRect(x, y, w, h)` covers at line width `L`: the
 * ring between the path rect grown by half the width and shrunk by half of
 * it. A rect too narrow or too short to hold that inner hole is stroked
 * solid, which is also what the 2D context does with a degenerate path.
 */
function strokeRing(batch: VertexBatch, x: number, y: number, w: number, h: number, L: number, c: PremultipliedRgba): void {
  const ox = x - L / 2;
  const oy = y - L / 2;
  const ow = w + L;
  const oh = h + L;
  if (w - L <= 0 || h - L <= 0) {
    batch.rect(ox, oy, ow, oh, c);
    return;
  }
  batch.rect(ox, oy, ow, L, c);
  batch.rect(ox, oy + oh - L, ow, L, c);
  batch.rect(ox, oy + L, L, oh - 2 * L, c);
  batch.rect(ox + ow - L, oy + L, L, oh - 2 * L, c);
}

/** `drawCandles`, branch for branch. */
function emitCandles(
  batch: VertexBatch, items: readonly DrawItem[], priceToY: (p: number) => number,
  barSpacing: number, dpr: number, style: CandleStyle, color: ColorOf,
): void {
  const bodyW = optimalBarWidth(barSpacing, dpr);
  const wickW = Math.max(1, Math.floor(dpr));
  const uniformTier = style.widthScale ? null : candleTier(bodyW, wickW, style);
  for (let i = 0; i < items.length; i++) {
    const { x, bar } = items[i];
    const ref = i > 0 ? items[i - 1].bar.close : items[i].prevClose;
    const up = style.colorByPreviousClose === true && ref !== undefined && Number.isFinite(ref)
      ? bar.close >= ref
      : bar.close >= bar.open;
    const yOpen = Math.round(priceToY(bar.open) * dpr);
    const yClose = Math.round(priceToY(bar.close) * dpr);
    const yHigh = Math.round(priceToY(bar.high) * dpr);
    const yLow = Math.round(priceToY(bar.low) * dpr);
    const geo = candleGeometry(x, barSpacing, dpr, style.widthScale ? style.widthScale(bar) : 1);
    const cx = geo.cx;
    const w = geo.bodyW;
    const halfW = cx - geo.bodyX;
    const over = bar.color;

    if (style.wickVisible) {
      batch.rect(geo.wickX, yHigh, geo.wickW, Math.max(1, yLow - yHigh), color(over ?? (up ? style.wickUpColor : style.wickDownColor)));
    }
    if ((uniformTier ?? candleTier(w, wickW, style)) === 'wick') continue;

    const top = Math.min(yOpen, yClose);
    const bodyH = Math.max(1, Math.abs(yClose - yOpen));
    const body = over ?? (up ? style.upColor : style.downColor);
    const border = over ?? (up ? style.borderUpColor : style.borderDownColor);

    if (style.hollow && up) {
      strokeRing(batch, cx - halfW + 0.5, top + 0.5, w - 1, bodyH - 1, Math.max(1, wickW), color(style.borderVisible ? border : body));
    } else {
      const filled = style.bodyVisible !== false;
      if (filled) batch.rect(cx - halfW, top, w, bodyH, color(body));
      if (style.borderVisible && (!filled || w >= 3)) {
        strokeRing(batch, cx - halfW + 0.5, top + 0.5, w - 1, bodyH - 1, 1, color(border));
      }
    }
  }
}

/** `drawBars`: the range, then the open and close ticks unless high-low only. */
function emitBars(
  batch: VertexBatch, items: readonly DrawItem[], toY: (v: number) => number,
  barSpacing: number, dpr: number, style: SeriesStyle, highLowOnly: boolean, color: ColorOf,
): void {
  const tick = Math.max(1, Math.floor(optimalBarWidth(barSpacing, dpr) / 2));
  const lw = Math.max(1, Math.floor(dpr));
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const g = barGeometry(item, toY, dpr);
    const ref = i > 0 ? items[i - 1].bar.close : item.prevClose;
    const up = style.colorByPreviousClose === true && ref !== undefined && Number.isFinite(ref)
      ? item.bar.close >= ref
      : g.up;
    const c = color(item.bar.color ?? (up ? (style.upColor ?? '#26a69a') : (style.downColor ?? '#ef5350')));
    batch.rect(g.cx - Math.floor(lw / 2), g.yHigh, lw, Math.max(1, g.yLow - g.yHigh), c);
    if (!highLowOnly) {
      batch.rect(g.cx - tick, g.yOpen, tick, lw, c);
      batch.rect(g.cx, g.yClose, tick, lw, c);
    }
  }
}

/** `drawColumns`: per-bar colour, then the flat colour, then the up/down pair. */
function emitColumns(
  batch: VertexBatch, items: readonly DrawItem[], toY: (v: number) => number,
  barSpacing: number, dpr: number, style: SeriesStyle, color: ColorOf,
): void {
  const w = optimalBarWidth(barSpacing, dpr);
  const half = Math.floor(w / 2);
  const baseY = Math.round(toY(style.base ?? 0) * dpr);
  for (const item of items) {
    const g = barGeometry(item, toY, dpr);
    const css = item.bar.color ?? style.color ?? (g.up ? (style.upColor ?? '#26a69a') : (style.downColor ?? '#ef5350'));
    const top = Math.min(baseY, g.yClose);
    batch.rect(g.cx - half, top, w, Math.max(1, Math.abs(baseY - g.yClose)), color(css));
  }
}

/** `drawHistogram` with the registry's resolved style: `color` and `base` only. */
function emitHistogram(
  batch: VertexBatch, items: readonly DrawItem[], valueToY: (v: number) => number,
  barSpacing: number, dpr: number, fill: string, base: number, color: ColorOf,
): void {
  const w = optimalBarWidth(barSpacing, dpr);
  const half = Math.floor(w / 2);
  const baseY = Math.round(valueToY(base) * dpr);
  for (const { x, bar } of items) {
    const cx = Math.round(x * dpr);
    const y = Math.round(valueToY(bar.close) * dpr);
    const top = Math.min(baseY, y);
    batch.rect(cx - half, top, w, Math.max(1, Math.abs(baseY - y)), color(bar.color ?? fill));
  }
}

/** The line renderer's own dash table (it does not share the grid's). */
function lineDash(style: SeriesStyle, dpr: number): number[] {
  if (style.lineStyle === 'dashed') return [6 * dpr, 4 * dpr];
  if (style.lineStyle === 'dotted') return [1 * dpr, 3 * dpr];
  return [];
}

/** The line renderer's per-point colours: one per polyline point, or nothing. */
function pointColors(items: readonly DrawItem[], step: boolean): (string | undefined)[] | undefined {
  let any = false;
  for (const it of items) if (it.bar.color !== undefined) { any = true; break; }
  if (!any) return undefined;
  const out: (string | undefined)[] = [];
  for (const it of items) {
    if (step && out.length > 0) out.push(it.bar.color);
    out.push(it.bar.color);
  }
  return out;
}

/** Where a dash walk stands: which pattern entry, and how much of it is left. */
interface DashState {
  idx: number;
  rem: number;
}

/**
 * One segment of a dashed stroke. Each "on" run is its own round-capped
 * piece, the way a 2D context caps every dash, and the pattern phase carries
 * across segments of one subpath through `state`.
 */
function emitDashedSegment(
  batch: VertexBatch, ax: number, ay: number, bx: number, by: number,
  hw: number, c: PremultipliedRgba, dash: readonly number[], state: DashState,
): void {
  const len = Math.hypot(bx - ax, by - ay);
  if (len === 0) return;
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  let t = 0;
  while (t < len) {
    const step = Math.min(state.rem, len - t);
    if (state.idx % 2 === 0 && step > 0) {
      batch.segment(ax + ux * t, ay + uy * t, ax + ux * (t + step), ay + uy * (t + step), hw, c, true);
    }
    t += step;
    state.rem -= step;
    if (state.rem <= 1e-9) {
      state.idx = (state.idx + 1) % dash.length;
      state.rem = dash[state.idx];
    }
  }
}

/**
 * The line renderer's `strokePolyline`: media-px points, broken at any
 * non-finite point, the segment arriving at point `i` in that point's own
 * colour when the series carries per-point colours. A colour change restarts
 * the path in the 2D version, which also restarts the dash phase, so it does
 * here too.
 */
function emitPolyline(
  batch: VertexBatch, pts: readonly Pt[], dpr: number, hw: number, fallback: string,
  colors: readonly (string | undefined)[] | undefined, dash: readonly number[], color: ColorOf,
): void {
  // A 2D context repeats an odd pattern to make it even, and treats a pattern
  // with no length at all as solid.
  let pattern = dash;
  if (pattern.length % 2 === 1) pattern = pattern.concat(pattern);
  let total = 0;
  for (const d of pattern) total += d;
  const dashed = pattern.length > 0 && total > 0;
  const state: DashState = { idx: 0, rem: dashed ? pattern[0] : 0 };
  let prev: Pt | undefined;
  let run: string | undefined;
  let c = color(fallback);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { prev = undefined; continue; }
    if (prev === undefined) {
      prev = p;
      state.idx = 0;
      state.rem = dashed ? pattern[0] : 0;
      continue;
    }
    const own = colors === undefined ? run : colors[i];
    if (own !== run) {
      run = own;
      c = color(own ?? fallback);
      state.idx = 0;
      state.rem = dashed ? pattern[0] : 0;
    }
    if (dashed) emitDashedSegment(batch, prev.x * dpr, prev.y * dpr, p.x * dpr, p.y * dpr, hw, c, pattern, state);
    else batch.segment(prev.x * dpr, prev.y * dpr, p.x * dpr, p.y * dpr, hw, c, true);
    prev = p;
  }
}

/** `drawLine`: the stroke (unless markers only), then a dot per point. */
function emitLine(
  batch: VertexBatch, items: readonly DrawItem[], toY: (v: number) => number,
  dpr: number, style: SeriesStyle, color: ColorOf,
): void {
  const base = valuePoints(items, toY);
  const pts = style.step ? stepPoints(base) : base;
  const cols = pointColors(items, style.step === true);
  const fill = style.color ?? '#4f8cff';
  const hw = Math.max(1, (style.lineWidth ?? 1.5) * dpr) / 2;
  if (!style.markersOnly) emitPolyline(batch, pts, dpr, hw, fill, cols, lineDash(style, dpr), color);
  if (style.markers || style.markersOnly) {
    const r = (style.markerRadius ?? 2) * dpr;
    for (let i = 0; i < base.length; i++) {
      const p = base[i];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const c = color(cols !== undefined ? (items[i].bar.color ?? fill) : fill);
      batch.segment(p.x * dpr, p.y * dpr, p.x * dpr, p.y * dpr, r, c, true);
    }
  }
}

type BaseSide = 'above' | 'below' | 'both';

/**
 * The region between a polyline and a horizontal base, the polygon the area
 * and baseline renderers fill: one trapezoid per span, split into its two
 * lobes where the span crosses the base. A non-finite point is skipped, not
 * a break, because a 2D path ignores a NaN `lineTo` and its polygon runs on
 * to the next point. `colorAt` gives the fill at a device y, so a gradient
 * is evaluated at the corners and the GPU interpolates it across.
 */
function emitFillToBase(
  batch: VertexBatch, pts: readonly Pt[], dpr: number, baseY: number,
  colorAt: (y: number) => PremultipliedRgba, side: BaseSide,
): void {
  const cBase = colorAt(baseY);
  let px = NaN;
  let py = NaN;
  for (const p of pts) {
    const x = p.x * dpr;
    const y = p.y * dpr;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Number.isFinite(px)) {
      const aAbove = py <= baseY;
      const bAbove = y <= baseY;
      if (aAbove === bAbove) {
        if (side === 'both' || (side === 'above') === aAbove) {
          batch.quad(px, py, colorAt(py), x, y, colorAt(y), px, baseY, cBase, x, baseY, cBase);
        }
      } else {
        const xc = px + (x - px) * (baseY - py) / (y - py);
        if (side === 'both' || (side === 'above') === aAbove) {
          batch.triangle(px, py, colorAt(py), xc, baseY, cBase, px, baseY, cBase);
        }
        if (side === 'both' || (side === 'above') === bAbove) {
          batch.triangle(x, y, colorAt(y), xc, baseY, cBase, x, baseY, cBase);
        }
      }
    }
    px = x;
    py = y;
  }
}

/** `drawArea`: gradient fill to the plot bottom, then the line over it. */
function emitArea(
  batch: VertexBatch, items: readonly DrawItem[], toY: (v: number) => number,
  dpr: number, plotHeight: number, style: SeriesStyle, color: ColorOf,
): void {
  const pts = valuePoints(items, toY);
  if (pts.length === 0) return;
  const baseY = plotHeight * dpr;
  if (baseY > 0) {
    const top = color(style.areaTopColor ?? 'rgba(79,140,255,0.40)');
    const bottom = color(style.areaBottomColor ?? 'rgba(79,140,255,0.00)');
    emitFillToBase(batch, pts, dpr, baseY, (y) => lerpPremultiplied(top, bottom, y / baseY), 'both');
  }
  emitLine(batch, items, toY, dpr, {
    color: style.color ?? '#4f8cff',
    lineWidth: style.lineWidth ?? 1.5,
    lineStyle: style.lineStyle,
  }, color);
}

/** `drawBaseline`: faded fill above the base, flat fill below, split stroke. */
function emitBaseline(
  batch: VertexBatch, items: readonly DrawItem[], toY: (v: number) => number,
  dpr: number, style: SeriesStyle, color: ColorOf,
): void {
  const baseY = toY(style.baseValue ?? 0) * dpr;
  const pts = valuePoints(items, toY);
  if (pts.length === 0 || !Number.isFinite(baseY)) return;
  if (baseY > 0) {
    const topFill = color(style.areaTopColor ?? 'rgba(38,166,154,0.20)');
    emitFillToBase(batch, pts, dpr, baseY, (y) => lerpPremultiplied(topFill, TRANSPARENT, y / baseY), 'above');
  }
  const botFill = color(style.areaBottomColor ?? 'rgba(239,83,80,0.20)');
  emitFillToBase(batch, pts, dpr, baseY, () => botFill, 'below');
  // Each span is its own stroke in the 2D version, so butt caps, no joins.
  const hw = Math.max(1, Math.round((style.lineWidth ?? 1.5) * dpr)) / 2;
  const topLine = color(style.topColor ?? '#26a69a');
  const bottomLine = color(style.bottomColor ?? '#ef5350');
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
    const above = (a.y + b.y) / 2 <= baseY / dpr;
    batch.segment(a.x * dpr, a.y * dpr, b.x * dpr, b.y * dpr, hw, above ? topLine : bottomLine, false);
  }
}

/** `drawHlcArea`: the band, its optional edges, then the close line. */
function emitHlcArea(
  batch: VertexBatch, items: readonly DrawItem[], toY: (v: number) => number,
  dpr: number, style: SeriesStyle, color: ColorOf,
): void {
  if (items.length === 0) return;
  const highs = valuePoints(items, toY, (b) => b.high);
  const lows = valuePoints(items, toY, (b) => b.low);
  const band = color(style.areaTopColor ?? 'rgba(79,140,255,0.15)');
  let prev = -1;
  for (let i = 0; i < items.length; i++) {
    const h = highs[i];
    const l = lows[i];
    if (!Number.isFinite(h.x) || !Number.isFinite(h.y) || !Number.isFinite(l.y)) continue;
    if (prev >= 0) {
      const ph = highs[prev];
      const pl = lows[prev];
      batch.quad(ph.x * dpr, ph.y * dpr, band, h.x * dpr, h.y * dpr, band, pl.x * dpr, pl.y * dpr, band, l.x * dpr, l.y * dpr, band);
    }
    prev = i;
  }
  const edgeHw = Math.max(1, Math.round((style.lineWidth ?? 1.5) * dpr)) / 2;
  for (const [css, pts] of [[style.highColor, highs], [style.lowColor, lows]] as const) {
    if (css === undefined) continue;
    emitPolyline(batch, pts, dpr, edgeHw, css, undefined, [], color);
  }
  emitLine(batch, items, toY, dpr, { color: style.closeColor ?? '#4f8cff', lineWidth: style.lineWidth ?? 1.5 }, color);
}

// ── which entries are drawn natively ────────────────────────────────────────

const NATIVE_TYPES: readonly SeriesType[] = [
  'candlestick', 'hollow-candle', 'volume-candle', 'bar', 'high-low',
  'line', 'line-markers', 'step', 'area', 'hlc-area', 'baseline', 'column', 'histogram',
];

/**
 * Entry object to the built-in type it is registered under, or null for a
 * renderer this backend does not know (kagi, point and figure, a host's own
 * type). Keyed by the entry object itself: a host that re-registers a
 * built-in name with its own entry gets the fallback for that entry, and
 * the original object keeps the answer it had.
 */
const nativeKinds = new WeakMap<RendererEntry, SeriesType | null>();

function nativeKind(entry: RendererEntry): SeriesType | null {
  let kind = nativeKinds.get(entry);
  if (kind === undefined) {
    kind = null;
    const registered = new Set(registeredChartTypes());
    for (const name of NATIVE_TYPES) {
      if (registered.has(name) && getChartType(name) === entry) { kind = name; break; }
    }
    nativeKinds.set(entry, kind);
  }
  return kind;
}

// ── the backend ─────────────────────────────────────────────────────────────

export class WebGL2Backend implements IRenderBackend {
  public readonly kind = 'webgl2';
  public readonly device: GlDevice;
  private readonly _batch = new VertexBatch();
  private _canvas: HTMLCanvasElement | null = null;
  private _ctx: CanvasRenderingContext2D | null = null;
  private _widthPx = 0;
  private _heightPx = 0;
  /** Whether `mount` took a reference on the device, so `destroy` gives back exactly that. */
  private _acquired = false;
  /** Set at `beginFrame` when the GPU is unavailable: the whole frame goes through 2D. */
  private _frame2d = false;
  /** Colour lookup bound to this pane's 2D context for the strings the parser cannot read. */
  private readonly _color: ColorOf = (css) => this.device.colors.get(css, this._normalise);
  private readonly _normalise = (css: string): string | null => (this._ctx === null ? null : normaliseWith2d(this._ctx, css));

  public constructor(device: GlDevice = sharedGlDevice()) {
    this.device = device;
  }

  /** The batch under construction, for tests that check what a series emits. */
  public get batch(): VertexBatch {
    return this._batch;
  }

  public mount(canvas: HTMLCanvasElement, ctx2d: CanvasRenderingContext2D | null): void {
    this._canvas = canvas;
    this._ctx = ctx2d ?? canvas.getContext('2d');
    if (this._ctx === null) throw new Error('openalgo-charts: 2D canvas context is not available');
    this._widthPx = canvas.width;
    this._heightPx = canvas.height;
    this._acquired = this.device.acquire();
    this.device.ensureSize(this._widthPx, this._heightPx);
  }

  /** The pane sized its own canvas already; only the shared surface has to keep up. */
  public resize(widthPx: number, heightPx: number, dpr: number): void {
    this._widthPx = Math.round(widthPx * dpr);
    this._heightPx = Math.round(heightPx * dpr);
    this.device.ensureSize(this._widthPx, this._heightPx);
  }

  /** The 2D backend's clear (which is `CanvasLayer.clearBitmap`), plus an empty batch. */
  public beginFrame(clear: boolean): void {
    this._batch.reset();
    this._frame2d = this.device.lost || this.device.gl === null;
    if (!clear || this._ctx === null || this._canvas === null) return;
    this._ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  }

  public drawSeries(
    entry: RendererEntry,
    items: readonly DrawItem[],
    priceToY: (price: number) => number,
    barSpacing: number,
    dpr: number,
    style: SeriesStyle,
    rc: SeriesRenderContext,
  ): void {
    if (this._ctx === null) return;
    // A context lost mid-frame takes the rest of the frame to 2D; whatever
    // was batched before it went cannot be drawn and is dropped for this
    // frame only.
    if (!this._frame2d && this.device.lost) {
      this._frame2d = true;
      this._batch.reset();
    }
    const kind = this._frame2d ? null : nativeKind(entry);
    if (kind === null) {
      // Keep z-order: what was batched lands before this series paints.
      this._flush();
      entry.draw(this._ctx, items, priceToY, barSpacing, dpr, style, rc);
      return;
    }
    const b = this._batch;
    const c = this._color;
    const theme = rc.theme;
    switch (kind) {
      case 'candlestick':
        emitCandles(b, items, priceToY, barSpacing, dpr, resolveCandleStyle(style, theme), c);
        break;
      case 'hollow-candle':
        emitCandles(b, items, priceToY, barSpacing, dpr, resolveCandleStyle(style, theme, { hollow: true }), c);
        break;
      case 'volume-candle': {
        const max = rc.maxVolume;
        const widthScale = (bar: Bar): number => (max > 0 ? (bar.volume ?? 0) / max : 1);
        emitCandles(b, items, priceToY, barSpacing, dpr, resolveCandleStyle(style, theme, { widthScale }), c);
        break;
      }
      case 'bar':
      case 'high-low':
        emitBars(b, items, priceToY, barSpacing, dpr, {
          ...style, upColor: style.upColor ?? theme.upColor, downColor: style.downColor ?? theme.downColor,
        }, kind === 'high-low', c);
        break;
      case 'line':
        emitLine(b, items, priceToY, dpr, { ...style, color: style.color ?? theme.lineColor }, c);
        break;
      case 'line-markers':
        emitLine(b, items, priceToY, dpr, { ...style, color: style.color ?? theme.lineColor, markers: true }, c);
        break;
      case 'step':
        emitLine(b, items, priceToY, dpr, { ...style, color: style.color ?? theme.lineColor, step: true }, c);
        break;
      case 'area':
        emitArea(b, items, priceToY, dpr, rc.plotHeight, {
          ...style,
          color: style.color ?? theme.lineColor,
          areaTopColor: style.areaTopColor ?? theme.areaTopColor,
          areaBottomColor: style.areaBottomColor ?? theme.areaBottomColor,
        }, c);
        break;
      case 'hlc-area':
        emitHlcArea(b, items, priceToY, dpr, { ...style, closeColor: style.closeColor ?? theme.lineColor }, c);
        break;
      case 'baseline':
        emitBaseline(b, items, priceToY, dpr, {
          ...style,
          topColor: style.topColor ?? theme.baselineTopLine,
          bottomColor: style.bottomColor ?? theme.baselineBottomLine,
          areaTopColor: style.areaTopColor ?? theme.baselineTopFill,
          areaBottomColor: style.areaBottomColor ?? theme.baselineBottomFill,
        }, c);
        break;
      case 'column':
        emitColumns(b, items, priceToY, barSpacing, dpr, {
          ...style, upColor: style.upColor ?? theme.upColor, downColor: style.downColor ?? theme.downColor,
        }, c);
        break;
      case 'histogram':
        emitHistogram(b, items, priceToY, barSpacing, dpr, style.color ?? '#3a4666', style.base ?? 0, c);
        break;
    }
  }

  public endFrame(): void {
    this._flush();
  }

  public overlay2d(): CanvasRenderingContext2D | null {
    return this._ctx;
  }

  public destroy(): void {
    if (this._acquired) this.device.release();
    this._acquired = false;
    this._batch.reset();
    this._ctx = null;
    this._canvas = null;
  }

  /**
   * Render the batch and blit it into the base canvas. The blit is drawn
   * under whatever transform and clip the pane has in force, which is the
   * plot's, so the surface lands exactly where the series would have been
   * painted directly. A batch with nothing in it costs no GPU work at all.
   */
  private _flush(): void {
    const b = this._batch;
    if (b.quadCount === 0 || this._ctx === null) return;
    const w = this._widthPx;
    const h = this._heightPx;
    const surface = this.device.surface;
    if (w > 0 && h > 0 && surface !== null && this.device.render(b, w, h)) {
      this._ctx.drawImage(surface as unknown as CanvasImageSource, 0, 0, w, h, 0, 0, w, h);
    }
    b.reset();
  }
}

/**
 * The `webgl2` factory: a backend on the shared device, or null when this
 * device has no WebGL2, in which case the chart takes the 2D backend.
 */
export function createWebGL2Backend(device?: GlDevice): IRenderBackend | null {
  if (device === undefined) {
    if (!isWebGL2Supported()) return null;
    return new WebGL2Backend(sharedGlDevice());
  }
  return device.available ? new WebGL2Backend(device) : null;
}

/**
 * Register the factory under `webgl2`, so `renderer: 'auto'` picks it up
 * and `renderer: 'webgl2'` stops throwing. Not a side effect of importing
 * this module: registering changes what every chart on the page gets from
 * `'auto'`, and that is a decision for the host or the tier entry to make.
 */
export function registerWebGL2Backend(device?: GlDevice): void {
  registerRenderBackend('webgl2', () => createWebGL2Backend(device));
}
