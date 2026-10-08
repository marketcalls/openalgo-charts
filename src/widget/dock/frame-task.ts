/** Coalesces visual work without timers that keep hidden pages busy. */
export class FrameTask {
  private _pending: number | null = null;

  constructor(private readonly _doc: Document, private readonly _run: () => void) {}

  schedule(): void {
    if (this._pending !== null) return;
    const view = this._doc.defaultView;
    if (!view?.requestAnimationFrame) { this._run(); return; }
    this._pending = view.requestAnimationFrame(() => {
      this._pending = null;
      this._run();
    });
  }

  flush(): void {
    if (this._pending === null) return;
    this.cancel();
    this._run();
  }

  cancel(): void {
    if (this._pending !== null) this._doc.defaultView?.cancelAnimationFrame(this._pending);
    this._pending = null;
  }
}
