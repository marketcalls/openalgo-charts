/**
 * Drop preview indicator.
 *
 * Renders a semi-transparent blueprint ghost overlay that snaps smoothly
 * to the drop target zone. Only `transform` animates (composited); the size is set
 * directly so a drag update never animates layout properties.
 */

const TRANSITION = 'transform 120ms cubic-bezier(0.16, 1, 0.3, 1)';

export class DockPreviewOverlay {
  private readonly _el: HTMLElement;
  private _visible = false;

  constructor(parent: HTMLElement) {
    const doc = parent.ownerDocument ?? (typeof document !== 'undefined' ? document : (globalThis as unknown as { document: Document }).document);
    this._el = doc.createElement('div');
    this._el.className = 'oac-dock-preview';
    this._el.style.position = 'absolute';
    this._el.style.pointerEvents = 'none';
    this._el.style.display = 'none';
    this._el.style.zIndex = '9999';
    this._el.style.boxSizing = 'border-box';
    this._el.style.left = '0px';
    this._el.style.top = '0px';
    this._el.style.willChange = 'transform';
    this._el.style.transition = TRANSITION;
    parent.appendChild(this._el);
  }

  public show(rect: { left: number; top: number; width: number; height: number }): void {
    const transform = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
    this._el.style.display = 'block';
    if (this._visible) this._el.style.transform = transform;
    else {
      // Appear in place: only moves between drop zones animate, not one from the origin.
      this._el.style.transition = 'none';
      this._el.style.transform = transform;
      void this._el.offsetWidth;
      this._el.style.transition = TRANSITION;
    }
    this._el.style.width = `${Math.max(10, Math.round(rect.width))}px`;
    this._el.style.height = `${Math.max(10, Math.round(rect.height))}px`;
    this._visible = true;
  }

  public hide(): void {
    if (!this._visible) return;
    this._el.style.display = 'none';
    this._visible = false;
  }

  public destroy(): void {
    if (this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
  }
}
