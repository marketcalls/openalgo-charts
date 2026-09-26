/**
 * The chart's navigation motion: the kinetic glide after a flick, the eased
 * wheel-zoom glide, and the autoscale easing either one starts.
 *
 * Its own module because this state (the glides in flight, their clocks and
 * frame counts) belongs to these few methods alone. The chart reaches it
 * through `Chart._motion`, and the motion reaches the chart through
 * `MotionHost`. Members the chart still calls or reads are public on this
 * internal class; no entry point exports the class and the chart holds it in
 * a private field, so none of it reaches the published declarations.
 *
 * Neither glide schedules a frame of its own. The render loop steps them at
 * the top of its frame (`_step`), before it takes the frame's mask, so the
 * paint in that frame shows the step it made. On animation frames of their
 * own, each step asked the loop for a paint that ran in the frame after, so
 * the chart showed every step a frame late and asked for two callbacks per
 * frame.
 */
import { InvalidationLevel } from './invalidate-mask';
import type { Chart } from './chart';
import { KineticAnimation } from '../input/kinetic';
import { ZoomGlide } from '../input/zoom-glide';

/** Hard ceiling on glide frames, about ten seconds at 60fps. See `_stepKinetic`. */
const KINETIC_MAX_FRAMES = 600;
/** Same ceiling, same reason, for the zoom glide (see `_stepKinetic`). */
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
  readonly _loop: Chart['_loop'];
  readonly _timeScale: Chart['_timeScale'];
  _now: Chart['_now'];
  _mutateTimeScale: Chart['_mutateTimeScale'];
  _maybeLoadHistory: Chart['_maybeLoadHistory'];
  invalidate: Chart['invalidate'];
  _emitViewport: Chart['_emitViewport'];
}

/** A kinetic glide in flight: its curve, its clock, how far it has moved the view and the frames it has used. */
interface KineticGlide {
  readonly anim: KineticAnimation;
  readonly start: number;
  travelled: number;
  frames: number;
}

export class ChartMotion {
  private readonly _host: MotionHost;
  private _kinetic: KineticGlide | null = null;
  /** The glide in flight, so a second wheel tick folds into it (see ZoomGlide.add). */
  public _zoomGlide: ZoomGlide | null = null;
  private _zoomFocus = 0;
  private _zoomFrames = 0;
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

  /**
   * Advance both glides by one frame. The render loop calls this before it
   * takes the frame's mask, so what a step invalidates is painted in the same
   * frame. Returns whether a glide is still running: the loop then asks for
   * the next frame once this one is painted.
   */
  public _step(): boolean {
    this._stepZoomGlide();
    this._stepKinetic();
    return this._zoomGlide !== null || this._kinetic !== null;
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
    this._zoomGlide = new ZoomGlide(logFactor);
    this._zoomFocus = focusX;
    this._zoomGlideStart = this._host._now();
    this._zoomGlideApplied = 0;
    this._zoomFrames = 0;
    this._host._loop.requestFrame();
  }

  private _stepZoomGlide(): void {
    const glide = this._zoomGlide;
    if (glide === null) return;
    // Cleared rather than left behind: a glide still set keeps the loop asking for frames.
    if (this._host._destroyed || this._host._navigation.zoomEnabled === false) { this._zoomGlide = null; return; }
    const elapsed = this._host._now() - this._zoomGlideStart;
    const applied = glide.appliedAt(elapsed);
    const delta = applied - this._zoomGlideApplied;
    this._zoomGlideApplied = applied;
    // A frame that moved nothing still costs a full-pane repaint, so skip it.
    if (delta !== 0) this._applyZoom(this._zoomFocus, delta);
    if (this._zoomGlide !== glide || this._host._destroyed) return;
    if (glide.finished(elapsed) || ++this._zoomFrames >= ZOOM_GLIDE_MAX_FRAMES) {
      // Land exactly on the target: the curve only approaches it.
      const remainder = glide.totalLogFactor - this._zoomGlideApplied;
      if (remainder !== 0) this._applyZoom(this._zoomFocus, remainder);
      if (this._zoomGlide === glide) this._zoomGlide = null;
    }
  }

  public _beginAutoscaleMotion(): void {
    if (!this._animAutoscale || this._autoscaleTime !== null) return;
    this._autoscaleTime = this._host._now() - 16;
    this._autoscaleFrames = 0;
  }

  /**
   * How far this frame's autoscale moves each pane toward its measured range:
   * the whole way unless a navigation motion started an easing, and the whole
   * way once the easing has run 90 frames, so it always lands.
   */
  public _autoscaleFraction(): number {
    const now = this._host._now();
    const fraction = this._autoscaleTime === null || ++this._autoscaleFrames >= 90
      ? 1 : 1 - Math.exp(-Math.max(1, now - this._autoscaleTime) / 80);
    if (this._autoscaleTime !== null) this._autoscaleTime = now;
    return fraction;
  }

  public _stopNavigationMotion(): void {
    this._navigationEpoch++;
    this._stopZoomGlide();
    this._stopKinetic();
    this._autoscaleTime = null;
  }

  /** Stop what a navigation policy just switched off: panning, zooming or both. */
  public _stopDisabled(pan: boolean, zoom: boolean): void {
    if (zoom) {
      this._navigationEpoch++;
      this._stopZoomGlide();
    }
    if (pan) this._stopKinetic();
    this._autoscaleTime = null;
  }

  public _stopZoomGlide(): void {
    this._zoomGlide = null;
  }

  /** Coast after a flick: the render loop moves the view on each frame until the glide stops. */
  public _startKinetic(velocity: number): void {
    if (this._host._navigation.panEnabled === false) return;
    this._stopKinetic();
    const anim = new KineticAnimation(velocity);
    if (anim.durationMs <= 0) return;
    this._kinetic = { anim, start: this._host._now(), travelled: 0, frames: 0 };
    this._host._loop.requestFrame();
  }

  private _stepKinetic(): void {
    const glide = this._kinetic;
    if (glide === null) return;
    if (this._host._destroyed || this._host._navigation.panEnabled === false) { this._kinetic = null; return; }
    const elapsed = this._host._now() - glide.start;
    const dist = glide.anim.distanceAt(elapsed);
    const delta = dist - glide.travelled;
    glide.travelled = dist;
    this._beginAutoscaleMotion();
    this._host._mutateTimeScale(() => this._host._timeScale.setRightOffset(this._host._timeScale.rightOffset - delta / this._host._timeScale.barSpacing));
    this._host._maybeLoadHistory();
    this._host.invalidate((m) => m.invalidateGlobal(InvalidationLevel.Full));
    // The glide is a pan like any other and has to say so. Without this the
    // drag emits its last event at the moment the pointer lifts, and everything
    // downstream (a linked chart, a host tracking the visible range) is left on
    // that window while this one coasts on for another few hundred milliseconds.
    this._host._emitViewport('pan');
    // A frame budget as well as a time budget. The glide is bounded in time,
    // but the loop asks for the next frame through the injected scheduler, and
    // a host may run that synchronously with a clock that does not move (the
    // test harness does, deliberately, so a repaint is observable inline).
    // Time-based termination alone then never fires and the frames recurse
    // until the stack goes. A glide is well under a second, so ten seconds of
    // frames is a ceiling no real animation reaches.
    if (this._kinetic === glide && (glide.anim.finished(elapsed) || ++glide.frames >= KINETIC_MAX_FRAMES)) this._kinetic = null;
  }

  public _stopKinetic(): void {
    this._kinetic = null;
  }
}
