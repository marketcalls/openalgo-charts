/**
 * Top-level chart orchestrator (ARCHITECTURE.md §3.3). Owns the panes, the
 * invalidate mask, and the render loop. Pan/zoom, scales, series, and the
 * shared time scale arrive in later phases; Phase 1 lays out panes and paints
 * a grid, repainting on resize.
 */
import { InvalidateMask, InvalidationLevel } from './invalidate-mask';
import { RenderLoop, type RafScheduler, type RafCanceller } from './render-loop';
import { Pane, type PaneTheme, DEFAULT_PANE_THEME } from './pane';

export interface ChartOptions {
  /** Injectable document (defaults to the global one). */
  document?: Document;
  /** Device-pixel-ratio provider (defaults to window.devicePixelRatio). */
  pixelRatio?: () => number;
  /** Injectable rAF scheduler/canceller (mainly for tests). */
  raf?: { schedule: RafScheduler; cancel?: RafCanceller };
  theme?: PaneTheme;
}

function defaultPixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

export class Chart {
  private readonly _container: HTMLElement;
  private readonly _doc: Document;
  private readonly _pixelRatio: () => number;
  private readonly _theme: PaneTheme;
  private readonly _panes: Pane[] = [];
  private readonly _loop: RenderLoop;
  private _pending: InvalidateMask | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _width = 0;
  private _height = 0;

  public constructor(container: HTMLElement, options: ChartOptions = {}) {
    this._container = container;
    this._doc = options.document ?? container.ownerDocument;
    this._pixelRatio = options.pixelRatio ?? defaultPixelRatio;
    this._theme = options.theme ?? DEFAULT_PANE_THEME;

    container.style.position = container.style.position || 'relative';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';

    this._loop = options.raf
      ? new RenderLoop(() => this._onFrame(), options.raf.schedule, options.raf.cancel)
      : new RenderLoop(() => this._onFrame());

    // One price pane to start; addPane() stacks more (volume, indicators).
    this.addPane();

    this._observeSize();
    this.applySize(container.clientWidth, container.clientHeight);
  }

  /** Add a stacked pane and return it. Invalidates Full. */
  public addPane(): Pane {
    const pane = new Pane(this._doc, this._theme);
    this._panes.push(pane);
    this._container.appendChild(pane.element);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    return pane;
  }

  public panes(): readonly Pane[] {
    return this._panes;
  }

  /** Merge work into the pending mask and schedule a frame. */
  public invalidate(build: (mask: InvalidateMask) => void): void {
    if (this._pending === null) this._pending = new InvalidateMask();
    build(this._pending);
    this._loop.requestFrame();
  }

  /** Apply an explicit size (used by the ResizeObserver and tests). */
  public applySize(width: number, height: number): void {
    if (width === this._width && height === this._height) return;
    this._width = width;
    this._height = height;
    const dpr = this._pixelRatio();
    const paneHeight = this._panes.length > 0 ? height / this._panes.length : height;
    for (const pane of this._panes) pane.resize(width, paneHeight, dpr);
    this.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
  }

  private _observeSize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this._resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        this.applySize(width, height);
      }
    });
    this._resizeObserver.observe(this._container);
  }

  private _onFrame(): void {
    const mask = this._pending;
    this._pending = null;
    if (mask === null || mask.isEmpty()) return;

    // Phase 1: scale/tick recompute on Full is a no-op (added in Phase 2).
    const global = mask.globalLevel;
    for (let i = 0; i < this._panes.length; i++) {
      const pane = this._panes[i];
      const perPane = mask.paneInvalidation(i);
      const level = Math.max(global, perPane?.level ?? InvalidationLevel.None);
      if (level >= InvalidationLevel.Light) pane.paintBase();
      if (level >= InvalidationLevel.Cursor) pane.paintTop();
    }
  }

  /** Tear down observers and DOM. */
  public destroy(): void {
    this._loop.stop();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    for (const pane of this._panes) pane.element.remove();
    this._panes.length = 0;
  }
}

/** Create a chart inside the given container element. */
export function createChart(container: HTMLElement, options: ChartOptions = {}): Chart {
  return new Chart(container, options);
}
