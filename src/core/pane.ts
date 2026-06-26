/**
 * A pane is one vertically-stacked drawing region (price pane, volume pane,
 * indicator pane). It owns a base + top canvas (ARCHITECTURE.md §3.1). Series,
 * price scales, and axis widgets attach in later phases; Phase 1 paints a grid.
 */
import { CanvasLayer } from './canvas';
import { computeGridLines, drawGrid, type GridStyle } from '../render/grid';

export interface PaneTheme {
  background: string;
  grid: GridStyle;
}

export const DEFAULT_PANE_THEME: PaneTheme = {
  background: '#0d0e12',
  grid: { color: '#1c2030', lineWidth: 1 },
};

export class Pane {
  public readonly element: HTMLElement;
  public readonly base: CanvasLayer;
  public readonly top: CanvasLayer;
  private _width = 0;
  private _height = 0;
  private _dpr = 1;
  private readonly _theme: PaneTheme;

  public constructor(doc: Document, theme: PaneTheme = DEFAULT_PANE_THEME) {
    this._theme = theme;
    this.element = doc.createElement('div');
    this.element.style.position = 'relative';
    this.element.style.width = '100%';
    this.element.style.flex = '1 1 auto';
    this.element.style.overflow = 'hidden';
    this.base = new CanvasLayer(doc, 0);
    this.top = new CanvasLayer(doc, 1);
    this.element.appendChild(this.base.element);
    this.element.appendChild(this.top.element);
  }

  public resize(width: number, height: number, dpr: number): void {
    this._width = width;
    this._height = height;
    this._dpr = dpr;
    this.base.resize(width, height, dpr);
    this.top.resize(width, height, dpr);
  }

  /** Phase 1: paint background + grid on the base canvas (bitmap scope). */
  public paintBase(): void {
    const ctx = this.base.ctx;
    this.base.clearBitmap();
    const w = Math.round(this._width * this._dpr);
    const h = Math.round(this._height * this._dpr);
    ctx.fillStyle = this._theme.background;
    ctx.fillRect(0, 0, w, h);
    const lines = computeGridLines(this._width, this._height, { spacing: 60 });
    drawGrid(ctx, lines, this._width, this._height, this._dpr, this._theme.grid);
  }

  /** Phase 1: top canvas (crosshair/overlay) is cleared; content lands in Phase 3. */
  public paintTop(): void {
    this.top.clearBitmap();
  }
}
