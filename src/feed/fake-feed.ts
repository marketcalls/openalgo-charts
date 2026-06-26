import type { Bar } from '../model/bar';
import type { BarsRequest, DataFeed, UnsubscribeFn } from './types';

/**
 * Deterministic, in-memory data feed for tests and demos. No network.
 * Generates a reproducible synthetic OHLC walk from a fixed seed so that
 * pixel-diff and unit tests are stable across runs (no Math.random / Date.now).
 */
export class FakeDataFeed implements DataFeed {
  private readonly intervalSec: number;

  constructor(intervalSec = 60) {
    this.intervalSec = intervalSec;
  }

  async getBars(req: BarsRequest): Promise<Bar[]> {
    const count = 500;
    const start = req.from ?? 1_700_000_000;
    return generateBars(start, count, this.intervalSec);
  }

  subscribeBars(_req: BarsRequest, _onBar: (bar: Bar) => void): UnsubscribeFn {
    // Phase 4 wires live emission; the stub is a no-op subscription for now.
    return () => {};
  }
}

/** Pure, seeded synthetic bar generator (deterministic — no global randomness). */
export function generateBars(startTime: number, count: number, intervalSec: number): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  let seed = 0x9e3779b9 >>> 0;
  const next = (): number => {
    // xorshift32 — deterministic pseudo-random in [0, 1)
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < count; i++) {
    const drift = (next() - 0.5) * 2;
    const open = price;
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + next();
    const low = Math.min(open, close) - next();
    bars.push({
      time: startTime + i * intervalSec,
      open,
      high,
      low,
      close,
      volume: Math.round(1000 + next() * 9000),
    });
    price = close;
  }
  return bars;
}
