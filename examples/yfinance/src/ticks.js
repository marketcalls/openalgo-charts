// Price-dependent ticks for the demo's instruments. yfinance reports no tick
// size at all, so the only schedule here belongs to the fixture server's
// synthetic BANDED symbol, which trades around 100 so its boundary is on screen.
import * as engine from '/dist/openalgo-charts.mjs';
import { round2 } from './ui.js';

// Read off the namespace, like the other version-dependent surfaces: an older
// dist/ without schedules still loads and draws every other symbol.
const { TickSchedule } = engine;

/**
 * Host-supplied rules, keyed by symbol. Synthetic, not any venue's schedule:
 * a real host reads its bands from its own instrument master and hands them
 * to the library. The fixture server rounds BANDED's bars onto the same grid.
 */
export const HOST_TICK_BANDS = Object.freeze({
  BANDED: Object.freeze([{ tick: 0.01 }, { from: 100, tick: 0.05 }]),
});

/** The schedule for a symbol, or null when the host holds no rules for it. */
export function tickScheduleFor(symbol) {
  const bands = HOST_TICK_BANDS[String(symbol || '').toUpperCase()];
  return bands && TickSchedule ? new TickSchedule(bands) : null;
}

/** A price as the loaded instrument quotes it; two decimals without a schedule, as before. */
export const snapPrice = (ticks, price) => (ticks ? ticks.round(price) : round2(price));

/** Names the tick in force after a price on a scheduled instrument, and nothing otherwise. */
export const tickNote = (ticks, price) => (ticks ? `, tick ${ticks.tickAt(price)}` : '');
