/**
 * Frame scheduler (ARCHITECTURE.md §3.2). Coalesces many `requestFrame()` calls
 * within a single tick into one `onFrame` invocation. The rAF function is
 * injectable so the loop is deterministically testable without a browser.
 */

export type RafScheduler = (cb: () => void) => number;
export type RafCanceller = (handle: number) => void;

const noopCancel: RafCanceller = () => {};

function defaultRaf(): { schedule: RafScheduler; cancel: RafCanceller } {
  if (typeof requestAnimationFrame === 'function') {
    return { schedule: (cb) => requestAnimationFrame(cb), cancel: (h) => cancelAnimationFrame(h) };
  }
  // Fallback for non-browser hosts (kept out of the hot path in real use).
  return { schedule: (cb) => setTimeout(cb, 16) as unknown as number, cancel: (h) => clearTimeout(h) };
}

export class RenderLoop {
  private readonly _onFrame: () => void;
  private readonly _schedule: RafScheduler;
  private readonly _cancel: RafCanceller;
  private _handle: number | null = null;

  public constructor(
    onFrame: () => void,
    schedule?: RafScheduler,
    cancel?: RafCanceller,
  ) {
    this._onFrame = onFrame;
    if (schedule) {
      this._schedule = schedule;
      this._cancel = cancel ?? noopCancel;
    } else {
      const def = defaultRaf();
      this._schedule = def.schedule;
      this._cancel = def.cancel;
    }
  }

  /** Whether a frame is currently scheduled but not yet run. */
  public get scheduled(): boolean {
    return this._handle !== null;
  }

  /** Request a frame. Repeated calls before the frame runs are coalesced into one. */
  public requestFrame(): void {
    if (this._handle !== null) return;
    // Mark scheduled up front so a synchronous scheduler (tests, unusual hosts)
    // that runs the callback before returning still leaves `_handle` null after
    // the frame, instead of getting overwritten with the stale return value.
    this._handle = -1;
    const handle = this._schedule(() => {
      this._handle = null;
      this._onFrame();
    });
    if (this._handle !== null) this._handle = handle; // async path: not yet run
  }

  /** Cancel a pending frame, if any. */
  public stop(): void {
    if (this._handle !== null) {
      this._cancel(this._handle);
      this._handle = null;
    }
  }
}
