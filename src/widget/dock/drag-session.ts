/**
 * Panel and tab drag session manager.
 *
 * Coordinates live pointer dragging of tab headers and panel titlebars,
 * ghost element creation, hit zone evaluation, and drop execution.
 */

import type { DockDropPosition } from './types';
import { calculateSnapTarget, type PaneRectInfo } from './hit-zones';
import type { DockPreviewOverlay } from './preview';

export interface DragSessionOptions {
  panelId: string;
  title: string;
  container: HTMLElement;
  preview: DockPreviewOverlay;
  getPanes(): PaneRectInfo[];
  onDock(panelId: string, targetNodeId: string, position: DockDropPosition): void;
  onFloat(panelId: string, x: number, y: number): void;
}

export class PanelDragSession {
  private readonly _opts: DragSessionOptions;
  private _ghostEl: HTMLElement | null = null;
  private _isDragging = false;

  constructor(opts: DragSessionOptions) {
    this._opts = opts;
  }

  public start(e: PointerEvent): void {
    if (this._isDragging) return;
    this._isDragging = true;
    const startX = e.clientX, startY = e.clientY;
    let moved = false;
    const doc = this._opts.container.ownerDocument;
    const view = doc.defaultView ?? window;

    // Create ghost indicator
    this._ghostEl = doc.createElement('div');
    this._ghostEl.className = 'oac-dock-drag-ghost';
    this._ghostEl.textContent = this._opts.title;
    this._ghostEl.style.position = 'fixed';
    this._ghostEl.style.pointerEvents = 'none';
    this._ghostEl.style.zIndex = '10001';
    this._ghostEl.style.left = `${e.clientX + 10}px`;
    this._ghostEl.style.top = `${e.clientY + 10}px`;

    doc.body.appendChild(this._ghostEl);

    const onPointerMove = (moveEv: PointerEvent): void => {
      if (!this._isDragging) return;
      moved ||= Math.hypot(moveEv.clientX - startX, moveEv.clientY - startY) >= 5;
      if (!moved) return;
      if (this._ghostEl) {
        this._ghostEl.style.left = `${moveEv.clientX + 10}px`;
        this._ghostEl.style.top = `${moveEv.clientY + 10}px`;
      }

      const containerRect = this._opts.container.getBoundingClientRect();
      const panes = this._opts.getPanes();

      const hit = calculateSnapTarget(
        moveEv.clientX,
        moveEv.clientY,
        panes,
        containerRect
      );

      if (hit) {
        this._opts.preview.show(hit.rect);
      } else {
        this._opts.preview.hide();
      }
    };

    const onPointerUp = (upEv: PointerEvent): void => {
      const containerRect = this._opts.container.getBoundingClientRect();
      const panes = this._opts.getPanes();
      moved ||= Math.hypot(upEv.clientX - startX, upEv.clientY - startY) >= 5;
      const hit = calculateSnapTarget(
        upEv.clientX,
        upEv.clientY,
        panes,
        containerRect
      );

      cleanup();
      if (!moved) return;

      const insideWorkspace =
        upEv.clientX >= containerRect.left &&
        upEv.clientX <= containerRect.right &&
        upEv.clientY >= containerRect.top &&
        upEv.clientY <= containerRect.bottom;

      if (hit) {
        this._opts.onDock(
          this._opts.panelId,
          hit.targetNodeId,
          hit.position
        );
      } else if (!insideWorkspace) {
        // Dragged outside -> Float panel
        this._opts.onFloat(
          this._opts.panelId,
          Math.max(20, upEv.clientX - 100),
          Math.max(20, upEv.clientY - 20)
        );
      }
    };

    const onKeyDown = (keyEv: KeyboardEvent): void => {
      if (keyEv.key === 'Escape') {
        cleanup();
      }
    };

    const cleanup = (): void => {
      this._isDragging = false;
      this._opts.preview.hide();
      if (this._ghostEl) {
        this._ghostEl.remove();
        this._ghostEl = null;
      }
      view.removeEventListener('pointermove', onPointerMove);
      view.removeEventListener('pointerup', onPointerUp);
      view.removeEventListener('pointercancel', cleanup);
      view.removeEventListener('keydown', onKeyDown);
    };

    view.addEventListener('pointermove', onPointerMove);
    view.addEventListener('pointerup', onPointerUp);
    view.addEventListener('pointercancel', cleanup);
    view.addEventListener('keydown', onKeyDown);
  }
}
