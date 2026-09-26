/**
 * The chart's navigation motion: the kinetic glide after a flick, the eased
 * wheel-zoom glide, and the autoscale easing either one starts.
 *
 * Its own module because this state (frame handles, epochs, the glide in
 * flight) belongs to these few methods alone. The chart reaches it through
 * `Chart._motion`, and the motion reaches the chart through `MotionHost`.
 * Members the chart still calls or reads are public on this internal class;
 * no entry point exports the class and the chart holds it in a private
 * field, so none of it reaches the published declarations.
 */
import { InvalidationLevel } from './invalidate-mask';
import type { Chart } from './chart';
import { KineticAnimation } from '../input/kinetic';
import { ZoomGlide } from '../input/zoom-glide';

/** Hard ceiling on glide frames, about ten seconds at 60fps. See `_startKinetic`. */
const KINETIC_MAX_FRAMES = 600;
/** Same ceiling, same reason, for the zoom glide (see `_startKinetic`). */
const ZOOM_GLIDE_MAX_FRAMES = 600;

/**
 * The slice of the chart the motion reads and drives. The chart itself is the
 * host: each member carries the name and the type of the chart's own, so the
 * moved code reads as it did in chart.ts, and a member the chart renames or
 * retypes fails to compile here.
 */
export interface MotionHost {
  readonly _navigation: Chart['_navigation'];
  readonly _destroyed: Chart['_destroyed'];
  readonly _raf: Chart['_raf'];
  readonly _timeScale: Chart['_timeScale'];
  _now: Chart['_now'];
  _mutateTimeScale: Chart['_mutateTimeScale'];
  _maybeLoadHistory: Chart['_maybeLoadHistory'];
  invalidate: Chart['invalidate'];
  _emitViewport: Chart['_emitViewport'];
}

export class ChartMotion {
  private readonly _host: MotionHost;
  private _kineticHandle: number | null = null;
  private _kineticEpoch = 0;
  private _zoomHandle: number | null = null;
  /** The glide in flight, so a second wheel tick folds into it (see ZoomGlide.add). */
  public _zoomGlide: ZoomGlide | null = null;
  private _zoomGlideStart = 0;
  public _zoomGlideApplied = 0;
  private readonly _animAutoscale: boolean;
  public _autoscaleTime: number | null = null;
  public _autoscaleFrames = 0;
  public _navigationEpoch = 0;

  public constructor(host: MotionHost, animAutoscale: boolean) {
    this._host = host;
    this._animAutoscale = animAutoscale;
  }

  /** One zoom step, applied now. Shared by the instant path and each glide frame. */
  public _applyZoom(focusX: number, logFactor: number): void {
    if (this._host._navigation.zoomEnabled === false) return;
    this._beginAutoscaleMotion();
    this._host._mutateTimeScale(() => this._host._timeScale.zoomAtX(focusX, Math.exp(logFactor)));
    this._host._maybeLoadHistory();
    this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    this._host._emitViewport('zoom');
  }

  public _startZoomGlide(focusX: number, logFactor: number): void {
    if (this._host._navigation.zoomEnabled === false) return;
    const glide = new ZoomGlide(logFactor);
    this._zoomGlide = glide;
    this._zoomGlideStart = this._host._now();
    this._zoomGlideApplied = 0;
    let frames = 0;
    const step = (): void => {
      if (this._zoomGlide !== glide || this._host._destroyed || this._host._navigation.zoomEnabled === false) return;
      const elapsed = this._host._now() - this._zoomGlideStart;
      const applied = glide.appliedAt(elapsed);
      const delta = applied - this._zoomGlideApplied;
      this._zoomGlideApplied = applied;
      // A frame that moved nothing still costs a full-pane repaint, so skip it.
      if (delta !== 0) this._applyZoom(focusX, delta);
      if (this._zoomGlide !== glide || this._host._destroyed) return;
      if (!glide.finished(elapsed) && ++frames < ZOOM_GLIDE_MAX_FRAMES) {
        this._zoomHandle = this._host._raf.schedule(step);
      } else {
        // Land exactly on the target: the curve only approaches it.
        const remainder = glide.totalLogFactor - this._zoomGlideApplied;
        if (remainder !== 0) this._applyZoom(focusX, remainder);
        this._zoomHandle = null;
        this._zoomGlide = null;
      }
    };
    this._zoomHandle = this._host._raf.schedule(step);
  }

  public _beginAutoscaleMotion(): void {
    if (!this._animAutoscale || this._autoscaleTime !== null) return;
    this._autoscaleTime = this._host._now() - 16;
    this._autoscaleFrames = 0;
  }

  public _stopNavigationMotion(): void {
    this._navigationEpoch++;
    this._stopZoomGlide();
    this._stopKinetic();
    this._autoscaleTime = null;
  }

  public _stopZoomGlide(): void {
    if (this._zoomHandle !== null) {
      this._host._raf.cancel(this._zoomHandle);
      this._zoomHandle = null;
    }
    this._zoomGlide = null;
  }

  /**
   * Coast after a flick. Runs on the INJECTED scheduler, not the global
   * requestAnimationFrame: a host that supplies its own raf expects to own
   * every frame this chart schedules, and reaching past it also made the
   * glide untestable, which is why the missing pan event on each frame went
   * unnoticed until a browser drove it.
   */
  public _startKinetic(velocity: number): void {
    if (this._host._navigation.panEnabled === false) return;
    this._stopKinetic();
    const epoch = this._kineticEpoch;
    const anim = new KineticAnimation(velocity);
    if (anim.durationMs <= 0) return;
    const start = this._host._now();
    let lastDist = 0;
    // A frame budget as well as a time budget. The loop is bounded in time, but
    // it re-schedules itself through the injected scheduler, and a host may run
    // that synchronously (the test harness does, deliberately, so a repaint is
    // observable inline). Time-based termination alone then never fires and the
    // loop recurses until the stack goes. A glide is well under a second, so
    // ten seconds of frames is a ceiling no real animation reaches.
    let frames = 0;
    const step = (): void => {
      if (epoch !== this._kineticEpoch || this._host._destroyed || this._host._navigation.panEnabled === false) return;
      const elapsed = this._host._now() - start;
      const dist = anim.distanceAt(elapsed);
      const delta = dist - lastDist;
      lastDist = dist;
      this._beginAutoscaleMotion();
      this._host._mutateTimeScale(() => this._host._timeScale.setRightOffset(this._host._timeScale.rightOffset - delta / this._host._timeScale.barSpacing));
      this._host._maybeLoadHistory();
      this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
      // The glide is a pan like any other and has to say so. Without this the
      // drag emits its last event at the moment the pointer lifts, and everything
      // downstream (a linked chart, a host tracking the visible range) is left on
      // that window while this one coasts on for another few hundred milliseconds.
      this._host._emitViewport('pan');
      if (epoch !== this._kineticEpoch || this._host._destroyed) return;
      if (!anim.finished(elapsed) && ++frames < KINETIC_MAX_FRAMES) {
        this._kineticHandle = this._host._raf.schedule(step);
      } else {
        this._kineticHandle = null;
      }
    };
    this._kineticHandle = this._host._raf.schedule(step);
  }

  public _stopKinetic(): void {
    this._kineticEpoch++;
    if (this._kineticHandle !== null) {
      this._host._raf.cancel(this._kineticHandle);
      this._kineticHandle = null;
    }
  }
}
