// Price-dependent ticks for the demo's instruments. yfinance reports no tick
// size at all, so the only schedule here belongs to the fixture server's
// synthetic BANDED symbol, which trades around 100 so its boundary is on screen.
import * as engine from '/dist/openalgo-charts.mjs';
import { round2 } from './ui.js';

// Read off the namespace, like the other version-dependent surfaces: an older
// dist/ without schedules still loads and draws every other symbol.
const { Instrument } = engine;

/**
 * Host-supplied instrument metadata, keyed by symbol. Synthetic, not any
 * venue's rules: a real host reads these from its own instrument master and
 * hands them to the library, which validates them (the bands, and that the
 * price tick is the grid every band lies on) before anything snaps to them.
 * The fixture server rounds BANDED's bars onto the same grid.
 */
export const HOST_INSTRUMENTS = Object.freeze({
  BANDED: Object.freeze({
    symbol: 'BANDED', exchange: 'DEMO', timezone: 'Asia/Kolkata',
    priceTick: 0.01, pricePrecision: 2, quantityStep: 1,
    tickBands: Object.freeze([Object.freeze({ tick: 0.01 }), Object.freeze({ from: 100, tick: 0.05 })]),
    intervals: Object.freeze(['5m', '15m', '30m', '1h', '1d']),
    calendar: Object.freeze({ sessions: Object.freeze(['0915-1530:23456']) }),
  }),
});

/** The validated instrument for a symbol, or null when the host holds no metadata for it. */
export function instrumentFor(symbol) {
  const meta = HOST_INSTRUMENTS[String(symbol || '').toUpperCase()];
  return meta && Instrument ? new Instrument(meta) : null;
}

/** The instrument's tick schedule, or null: no metadata, a constant tick, or a dist/ without schedules. */
export const tickScheduleFor = (symbol) => instrumentFor(symbol)?.tickSchedule ?? null;

/**
 * The price axis minimum move: the instrument's price tick, which with bands
 * is the grid every band lies on, or the host's market guess without metadata.
 */
export function axisMinMove(symbol, fallback) {
  const instrument = instrumentFor(symbol);
  return instrument ? instrument.metadata.priceTick : fallback;
}

/** A price as the loaded instrument quotes it; two decimals without a schedule, as before. */
export const snapPrice = (ticks, price) => (ticks ? ticks.round(price) : round2(price));

/** Names the tick in force after a price on a scheduled instrument, and nothing otherwise. */
export const tickNote = (ticks, price) => (ticks ? `, tick ${ticks.tickAt(price)}` : '');
