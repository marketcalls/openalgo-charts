/**
 * Interactive split pane dividers.
 *
 * Implements high-performance divider dragging with pointer capture,
 * double-click equalize to 50/50, and keyboard navigation.
 */

import { FrameTask } from './frame-task';
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from './model';

export interface SplitterOptions {
  direction: 'horizontal' | 'vertical';
  currentRatio: number;
  document?: Document | undefined;
  onRatioChange(newRatio: number): void;
  onRatioEnd?(): void;
  onEqualize?(): void;
}

export class DockSplitter {
  private readonly _el: HTMLElement;
  private readonly _opts: SplitterOptions;
  private _dragging = false;
  private _startPos = 0;
  private _startRatio = 0.5;
  private _containerSize = 1;
  private readonly _frame: FrameTask;

  /** The ratio bounds a drag and the arrow keys stop at; Home and End go to them. */
  static readonly MIN_RATIO = MIN_SPLIT_RATIO;
  static readonly MAX_RATIO = MAX_SPLIT_RATIO;

  constructor(opts: SplitterOptions) {
    this._opts = opts;
    const doc = opts.document ?? (typeof document !== 'undefined' ? document : (globalThis as unknown as { document: Document }).document);
    this._el = doc.createElement('div');
    this._frame = new FrameTask(doc, () => {
      this.syncValue();
      this._opts.onRatioChange(this._opts.currentRatio);
    });
    this._el.className = `oac-dock-splitter oac-dock-splitter--${opts.direction}`;
    this._el.setAttribute('role', 'separator');
    this._el.setAttribute('tabindex', '0');
    this._el.setAttribute(
      'aria-orientation',
      opts.direction === 'horizontal' ? 'vertical' : 'horizontal'
    );
    // Named by what it resizes; the value is the first pane's share in percent.
    this._el.setAttribute('aria-label', opts.direction === 'horizontal' ? 'Resize left and right panes' : 'Resize top and bottom panes');
    this._el.setAttribute('aria-valuemin', String(DockSplitter.MIN_RATIO * 100));
    this._el.setAttribute('aria-valuemax', String(DockSplitter.MAX_RATIO * 100));
    this.syncValue();

    const handle = doc.createElement('div');
    handle.className = 'oac-dock-splitter-handle';
    this._el.appendChild(handle);

    this.bindEvents();
  }

  get element(): HTMLElement {
    return this._el;
  }

  private syncValue(): void {
    this._el.setAttribute('aria-valuenow', String(Math.round(this._opts.currentRatio * 100)));
  }

  private bindEvents(): void {
    const isHorizontal = this._opts.direction === 'horizontal';

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      this._dragging = true;
      this._startPos = isHorizontal ? e.clientX : e.clientY;
      this._startRatio = this._opts.currentRatio;

      const parent = this._el.parentElement;
      if (parent) {
        const rect = parent.getBoundingClientRect();
        this._containerSize = Math.max(1, isHorizontal ? rect.width : rect.height);
      }

      this._el.classList.add('is-dragging');
      try {
        this._el.setPointerCapture(e.pointerId);
      } catch {
        // Fallback for browsers with strict pointer capture policies
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (!this._dragging) return;
      const currentPos = isHorizontal ? e.clientX : e.clientY;
      const deltaPx = currentPos - this._startPos;
      const deltaRatio = deltaPx / this._containerSize;

      const newRatio = Math.max(DockSplitter.MIN_RATIO, Math.min(DockSplitter.MAX_RATIO, this._startRatio + deltaRatio));
      this._opts.currentRatio = newRatio;
      this._frame.schedule();
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (!this._dragging) return;
      if (e.type === 'pointerup') onPointerMove(e);
      this._frame.flush();
      this._dragging = false;
      this._el.classList.remove('is-dragging');
      try {
        this._el.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      this._opts.onRatioEnd?.();
    };

    const onDblClick = (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      this._opts.currentRatio = 0.5;
      this._frame.cancel();
      this.syncValue();
      this._opts.onRatioChange(0.5);
      this._opts.onEqualize?.();
      this._opts.onRatioEnd?.();
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      const step = 0.05;
      let ratio = this._opts.currentRatio;

      if ((isHorizontal && e.key === 'ArrowLeft') || (!isHorizontal && e.key === 'ArrowUp')) {
        ratio = Math.max(DockSplitter.MIN_RATIO, ratio - step);
      } else if ((isHorizontal && e.key === 'ArrowRight') || (!isHorizontal && e.key === 'ArrowDown')) {
        ratio = Math.min(DockSplitter.MAX_RATIO, ratio + step);
      } else if (e.key === 'Home') {
        ratio = DockSplitter.MIN_RATIO;
      } else if (e.key === 'End') {
        ratio = DockSplitter.MAX_RATIO;
      } else {
        return;
      }

      // Handled here only: a chart with document-wide shortcuts must not also pan on the key.
      e.preventDefault();
      e.stopPropagation();
      this._opts.currentRatio = ratio;
      this._frame.cancel();
      this.syncValue();
      this._opts.onRatioChange(ratio);
      this._opts.onRatioEnd?.();
    };

    this._el.addEventListener('pointerdown', onPointerDown);
    this._el.addEventListener('pointermove', onPointerMove);
    this._el.addEventListener('pointerup', onPointerUp);
    this._el.addEventListener('pointercancel', onPointerUp);
    this._el.addEventListener('dblclick', onDblClick);
    this._el.addEventListener('keydown', onKeyDown);
  }

  public destroy(): void {
    this._frame.cancel();
    if (this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
  }
}
