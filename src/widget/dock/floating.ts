/**
 * Floating panel window manager.
 *
 * Provides floating window behavior for undocked panels with draggable titlebars,
 * edge/corner resizing, z-index elevation, and edge snap preview integration.
 */

import type { FloatingPanelState, TerminalPanel } from './types';
import type { LinkHub } from './link-hub';

export interface FloatingPanelOptions {
  panel: TerminalPanel;
  initialBounds?: { x: number; y: number; width: number; height: number; zIndex?: number | undefined } | undefined;
  container: HTMLElement;
  linkHub: LinkHub;
  onDock(panelId: string): void;
  onLinkGroupChange?(panelId: string, group: TerminalPanel['linkGroup']): void;
  onClose(panelId: string): void;
  onBoundsChange(state: FloatingPanelState): void;
  /** A pointer went down anywhere in the window: raise it above the other floating windows. */
  onActivate?(panelId: string): void;
  onDragMove?(clientX: number, clientY: number): void;
  onDragEnd?(clientX: number, clientY: number): void;
}

export class FloatingPanelWindow {
  private readonly _doc: Document;
  private readonly _el: HTMLElement;
  private readonly _bodyEl: HTMLElement;
  private readonly _opts: FloatingPanelOptions;
  private _state: FloatingPanelState;
  private _dragging = false;
  private _resizing: string | null = null;
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _initialLeft = 0;
  private _initialTop = 0;
  private _initialW = 0;
  private _initialH = 0;

  constructor(opts: FloatingPanelOptions) {
    this._opts = opts;
    this._doc = opts.container.ownerDocument ?? (typeof document !== 'undefined' ? document : (globalThis as unknown as { document: Document }).document);
    const b = opts.initialBounds ?? {
      x: 60 + Math.round(Math.random() * 80),
      y: 60 + Math.round(Math.random() * 80),
      width: Math.max(300, opts.panel.minWidth ?? 360),
      height: Math.max(240, opts.panel.minHeight ?? 320),
    };

    this._state = {
      id: `float_${opts.panel.id}`,
      panelId: opts.panel.id,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      zIndex: typeof b.zIndex === 'number' ? b.zIndex : 50,
    };

    // Opened inside the workspace as a drag keeps it: a drop at the far edge or a layout saved on
    // a larger screen must not place the titlebar out of reach.
    this.clampTo(b.x, b.y);
    this._el = this._doc.createElement('div');
    this._el.className = 'oac-dock-floating';
    this._el.style.left = `${this._state.x}px`;
    this._el.style.top = `${this._state.y}px`;
    this._el.style.width = `${this._state.width}px`;
    this._el.style.height = `${this._state.height}px`;
    this._el.style.zIndex = String(this._state.zIndex);

    // Build header
    const header = this._doc.createElement('div');
    header.className = 'oac-dock-floating-header';

    const titleArea = this._doc.createElement('div');
    titleArea.className = 'oac-dock-floating-title-area';

    const linkBadge = opts.linkHub.renderLinkBadge(
      opts.panel.id,
      opts.panel.linkGroup ?? null,
      (newGroup) => {
        opts.panel.linkGroup = newGroup;
        if (opts.onLinkGroupChange) opts.onLinkGroupChange(opts.panel.id, newGroup);
        else opts.linkHub.setPanelGroup(opts.panel.id, newGroup);
      },
      this._doc
    );

    const title = this._doc.createElement('span');
    title.className = 'oac-dock-floating-title';
    title.textContent = opts.panel.title;

    titleArea.append(linkBadge, title);

    const actions = this._doc.createElement('div');
    actions.className = 'oac-dock-floating-actions';

    const dockBtn = this._doc.createElement('button');
    dockBtn.type = 'button';
    dockBtn.className = 'oac-dock-btn oac-dock-btn--dock';
    dockBtn.title = 'Dock into workspace';
    dockBtn.textContent = 'D';
    dockBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onDock(opts.panel.id);
    });

    const closeBtn = this._doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'oac-dock-btn oac-dock-btn--close';
    closeBtn.title = 'Close panel';
    closeBtn.textContent = 'x';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onClose(opts.panel.id);
    });

    actions.append(dockBtn, closeBtn);
    header.append(titleArea, actions);

    // Body
    this._bodyEl = this._doc.createElement('div');
    this._bodyEl.className = 'oac-dock-floating-body';

    this._el.append(header, this._bodyEl);

    // Add resize handles
    this.createResizeHandles();
    this.bindInteractions(header);

    opts.container.appendChild(this._el);
  }

  get bodyElement(): HTMLElement {
    return this._bodyEl;
  }

  get state(): FloatingPanelState {
    return { ...this._state };
  }

  /** Moves to (x, y) kept inside the workspace (which clips overflow), so the titlebar stays reachable. */
  private clampTo(x: number, y: number): void {
    const { clientWidth: w, clientHeight: h } = this._opts.container, s = this._state;
    s.x = Math.min(Math.max(0, x), w > 0 ? Math.max(0, w - s.width) : Infinity);
    s.y = Math.min(Math.max(0, y), h > 0 ? Math.max(0, h - s.height) : Infinity);
  }

  public bringToFront(topZIndex: number): void {
    this._state.zIndex = topZIndex;
    this._el.style.zIndex = String(topZIndex);
  }

  private createResizeHandles(): void {
    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    for (const pos of handles) {
      const h = this._doc.createElement('div');
      h.className = `oac-dock-resize-handle oac-dock-resize-handle--${pos}`;
      h.dataset.pos = pos;
      this._el.appendChild(h);
    }
  }

  private bindInteractions(header: HTMLElement): void {
    this._el.addEventListener('pointerdown', () => {
      this._opts.onActivate?.(this._opts.panel.id);
      this._opts.onBoundsChange(this._state);
    });

    // Dragging window by header
    header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.oac-dock-btn, .oac-dock-link-badge')) return;
      if (e.button !== 0) return;

      this._dragging = true;
      this._dragStartX = e.clientX;
      this._dragStartY = e.clientY;
      this._initialLeft = this._state.x;
      this._initialTop = this._state.y;
      this._el.classList.add('is-dragging');

      try {
        header.setPointerCapture(e.pointerId);
      } catch {
        // Fallback
      }
      e.preventDefault();
    });

    header.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      const dx = e.clientX - this._dragStartX;
      const dy = e.clientY - this._dragStartY;

      this.clampTo(this._initialLeft + dx, this._initialTop + dy);
      this._el.style.left = `${this._state.x}px`;
      this._el.style.top = `${this._state.y}px`;

      this._opts.onDragMove?.(e.clientX, e.clientY);
    });

    const finishDrag = (e: PointerEvent): void => {
      if (!this._dragging) return;
      this._dragging = false;
      this._el.classList.remove('is-dragging');
      try {
        header.releasePointerCapture(e.pointerId);
      } catch {
        // Fallback
      }
      this._opts.onDragEnd?.(e.clientX, e.clientY);
      this._opts.onBoundsChange(this._state);
    };

    header.addEventListener('pointerup', finishDrag);
    header.addEventListener('pointercancel', finishDrag);

    // Resizing window
    this._el.addEventListener('pointerdown', (e) => {
      const target = (e.target as HTMLElement).closest('.oac-dock-resize-handle') as HTMLElement | null;
      if (!target || !target.dataset.pos) return;
      if (e.button !== 0) return;

      this._resizing = target.dataset.pos;
      this._dragStartX = e.clientX;
      this._dragStartY = e.clientY;
      this._initialLeft = this._state.x;
      this._initialTop = this._state.y;
      this._initialW = this._state.width;
      this._initialH = this._state.height;

      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // Fallback
      }
      e.preventDefault();
      e.stopPropagation();
    });

    this._el.addEventListener('pointermove', (e) => {
      if (!this._resizing) return;
      const dx = e.clientX - this._dragStartX;
      const dy = e.clientY - this._dragStartY;
      const minW = Math.max(200, this._opts.panel.minWidth ?? 240);
      const minH = Math.max(160, this._opts.panel.minHeight ?? 180);

      if (this._resizing.includes('e')) {
        this._state.width = Math.max(minW, this._initialW + dx);
      }
      if (this._resizing.includes('s')) {
        this._state.height = Math.max(minH, this._initialH + dy);
      }
      if (this._resizing.includes('w')) {
        const newW = Math.max(minW, this._initialW - dx);
        this._state.x = this._initialLeft + (this._initialW - newW);
        this._state.width = newW;
      }
      if (this._resizing.includes('n')) {
        const newH = Math.max(minH, this._initialH - dy);
        this._state.y = this._initialTop + (this._initialH - newH);
        this._state.height = newH;
      }

      this._el.style.left = `${this._state.x}px`;
      this._el.style.top = `${this._state.y}px`;
      this._el.style.width = `${this._state.width}px`;
      this._el.style.height = `${this._state.height}px`;
    });

    const finishResize = (_e: PointerEvent): void => {
      if (!this._resizing) return;
      this._resizing = null;
      this._opts.onBoundsChange(this._state);
    };

    this._el.addEventListener('pointerup', finishResize);
    this._el.addEventListener('pointercancel', finishResize);
  }

  public setTitle(title: string): void {
    const titleEl = this._el.querySelector('.oac-dock-floating-title');
    if (titleEl) {
      titleEl.textContent = title;
    }
  }

  public destroy(): void {
    if (this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
  }
}
