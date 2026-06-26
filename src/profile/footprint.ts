/**
 * Footprint & order flow (ARCHITECTURE.md §6A, Family C). Per-candle bid/ask
 * volume at each price, delta, and imbalance — plus cumulative delta and
 * stacked-imbalance detection across bars.
 *
 * DATA DEPENDENCY (honest): this needs trade-by-trade data classified bid/ask
 * (was each print at the bid or the ask?). OpenAlgo serves live depth + tick LTP
 * but does not store historical classified trades by default, so footprint is
 * either live-session-only or needs a tick-recorder backend. The computation
 * here is pure and broker-agnostic; feeding it is the integration step.
 */
import type { FootprintBar, FootprintCell } from './profile-model';
import { bucketPrice } from './profile-model';

export interface ClassifiedTrade {
  price: number;
  qty: number;
  /** Whether the print hit the bid (sell-initiated) or the ask (buy-initiated). */
  side: 'bid' | 'ask';
}

/** Build one bar's footprint from its classified trades. */
export function computeFootprint(time: number, trades: readonly ClassifiedTrade[], tickSize: number): FootprintBar {
  const map = new Map<number, FootprintCell>();
  for (const t of trades) {
    const price = bucketPrice(t.price, tickSize);
    let cell = map.get(price);
    if (cell === undefined) { cell = { price, bidVol: 0, askVol: 0 }; map.set(price, cell); }
    if (t.side === 'bid') cell.bidVol += t.qty; else cell.askVol += t.qty;
  }
  const cells = Array.from(map.values()).sort((a, b) => b.price - a.price);
  const delta = cells.reduce((s, c) => s + (c.askVol - c.bidVol), 0);
  return { time, cells, delta };
}

export interface Imbalance {
  price: number;
  side: 'buy' | 'sell';
}

/**
 * Diagonal imbalances: buy when ask volume at price P dominates bid volume at
 * P−1 tick by `ratio`; sell when bid at P dominates ask at P+1 tick.
 */
export function diagonalImbalances(cells: readonly FootprintCell[], ratio = 3): Imbalance[] {
  // cells sorted high → low; index+1 is one tick lower
  const out: Imbalance[] = [];
  for (let i = 0; i < cells.length; i++) {
    const here = cells[i];
    const below = cells[i + 1];
    const above = cells[i - 1];
    if (below && here.askVol >= ratio * Math.max(1, below.bidVol)) out.push({ price: here.price, side: 'buy' });
    if (above && here.bidVol >= ratio * Math.max(1, above.askVol)) out.push({ price: here.price, side: 'sell' });
  }
  return out;
}

/** Running cumulative delta across a sequence of footprint bars. */
export function cumulativeDelta(bars: readonly FootprintBar[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const b of bars) { acc += b.delta; out.push(acc); }
  return out;
}

export interface StackedImbalance {
  startPrice: number;
  endPrice: number;
  side: 'buy' | 'sell';
  count: number;
}

/** Runs of `minStack`+ consecutive same-side diagonal imbalances. */
export function stackedImbalances(cells: readonly FootprintCell[], ratio = 3, minStack = 3): StackedImbalance[] {
  const imb = diagonalImbalances(cells, ratio);
  const bySide = new Map<number, 'buy' | 'sell'>();
  for (const i of imb) bySide.set(i.price, i.side);
  // cells are tick-ordered (high→low); find consecutive runs of same side
  const out: StackedImbalance[] = [];
  let run: { side: 'buy' | 'sell'; prices: number[] } | null = null;
  for (const c of cells) {
    const side = bySide.get(c.price);
    if (side !== undefined && (run === null || run.side === side)) {
      run = run ?? { side, prices: [] };
      run.prices.push(c.price);
    } else {
      if (run && run.prices.length >= minStack) {
        out.push({ startPrice: run.prices[0], endPrice: run.prices[run.prices.length - 1], side: run.side, count: run.prices.length });
      }
      run = side !== undefined ? { side, prices: [c.price] } : null;
    }
  }
  if (run && run.prices.length >= minStack) {
    out.push({ startPrice: run.prices[0], endPrice: run.prices[run.prices.length - 1], side: run.side, count: run.prices.length });
  }
  return out;
}
