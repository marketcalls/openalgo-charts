/**
 * Live candle aggregation (ARCHITECTURE.md §10.2). The WS feed does not deliver
 * interval candles — LTP mode gives a tick price (+ last-traded-qty), Quote mode
 * gives a *cumulative day* volume. This builder buckets ticks into interval OHLC
 * with explicit volume, session-reset, and late-tick policies. Pure and
 * deterministic (no Date/rAF) so it is fully unit-testable.
 */
import type { Bar, UTCSeconds } from '../model/bar';

export type VolumeMode = 'ltq-sum' | 'day-delta';
export type LateTickPolicy = 'foldIntoBar' | 'dropOlderThanPrevBar';

export interface CandleBuilderOptions {
  intervalSec: number;
  /** 'ltq-sum' accumulates last-traded-qty; 'day-delta' diffs cumulative day volume. */
  volumeMode: VolumeMode;
  lateTickPolicy: LateTickPolicy;
  /**
   * UTC-seconds of a known session open. Buckets align to it so e.g. 5-minute
   * bars start at 09:15, not at an arbitrary epoch floor. Defaults to 0 (epoch).
   */
  sessionAnchorSec: number;
}

export const DEFAULT_CANDLE_BUILDER_OPTIONS: CandleBuilderOptions = {
  intervalSec: 60,
  volumeMode: 'ltq-sum',
  lateTickPolicy: 'foldIntoBar',
  sessionAnchorSec: 0,
};

export interface Tick {
  time: UTCSeconds;
  price: number;
  /** Last-traded quantity (LTP mode). */
  ltq?: number;
  /** Cumulative day volume (Quote mode). */
  cumDayVolume?: number;
}

export interface CandleUpdate {
  bar: Bar;
  /** True when this tick started a new interval bar (append vs mutate-in-place). */
  isNew: boolean;
}

export class CandleBuilder {
  private readonly _opts: CandleBuilderOptions;
  private _current: Bar | null = null;
  private _cumAtBarStart = 0;
  private _lastCum = 0;
  private _hasCum = false;

  public constructor(options: Partial<CandleBuilderOptions> = {}) {
    this._opts = { ...DEFAULT_CANDLE_BUILDER_OPTIONS, ...options };
  }

  /** Seed with the last historical bar so the first live tick continues it. */
  public seed(lastBar: Bar, cumDayVolumeSoFar?: number): void {
    this._current = { ...lastBar };
    if (cumDayVolumeSoFar !== undefined) {
      this._lastCum = cumDayVolumeSoFar;
      this._cumAtBarStart = cumDayVolumeSoFar - (lastBar.volume ?? 0);
      this._hasCum = true;
    }
  }

  public current(): Bar | null {
    return this._current === null ? null : { ...this._current };
  }

  /** Bucket-start (bar-open) time for a tick, aligned to the session anchor. */
  public bucketStart(time: UTCSeconds): UTCSeconds {
    const a = this._opts.sessionAnchorSec;
    const i = this._opts.intervalSec;
    return a + Math.floor((time - a) / i) * i;
  }

  /**
   * Feed one tick. Returns the affected bar (mutated current or a fresh one),
   * or `null` if the tick was dropped by the late-tick policy.
   */
  public onTick(tick: Tick): CandleUpdate | null {
    const bs = this.bucketStart(tick.time);

    if (this._current !== null && bs < this._current.time) {
      // Tick older than the current bar's open.
      if (this._opts.lateTickPolicy === 'dropOlderThanPrevBar') return null;
      // foldIntoBar: merge into the current bar.
      this._foldInto(this._current, tick);
      return { bar: { ...this._current }, isNew: false };
    }

    if (this._current === null || bs > this._current.time) {
      // Start a new bar.
      const vol = this._volumeForNewBar(tick);
      const bar: Bar = {
        time: bs,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        volume: vol,
      };
      this._current = bar;
      return { bar: { ...bar }, isNew: true };
    }

    // Same bucket → update the current bar in place.
    this._foldInto(this._current, tick);
    return { bar: { ...this._current }, isNew: false };
  }

  private _foldInto(bar: Bar, tick: Tick): void {
    if (tick.price > bar.high) bar.high = tick.price;
    if (tick.price < bar.low) bar.low = tick.price;
    bar.close = tick.price;
    bar.volume = this._volumeForSameBar(bar, tick);
  }

  private _volumeForNewBar(tick: Tick): number {
    if (this._opts.volumeMode === 'ltq-sum') return tick.ltq ?? 0;
    const cum = tick.cumDayVolume ?? 0;
    if (!this._hasCum) {
      // First observation: this bar starts at the current cumulative (volume 0).
      this._cumAtBarStart = cum;
    } else if (cum < this._lastCum) {
      // Daily reset (cumulative dropped) → new day's bar starts from 0.
      this._cumAtBarStart = 0;
    } else {
      // Carry from the previous bar's closing cumulative.
      this._cumAtBarStart = this._lastCum;
    }
    this._lastCum = cum;
    this._hasCum = true;
    return Math.max(0, cum - this._cumAtBarStart);
  }

  private _volumeForSameBar(bar: Bar, tick: Tick): number {
    if (this._opts.volumeMode === 'ltq-sum') return (bar.volume ?? 0) + (tick.ltq ?? 0);
    const cum = tick.cumDayVolume ?? 0;
    this._lastCum = cum;
    return Math.max(0, cum - this._cumAtBarStart);
  }
}
