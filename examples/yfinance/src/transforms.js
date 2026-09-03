import {
  runTransform, HeikinAshiTransform, RenkoTransform, RangeBarsTransform,
  LineBreakTransform, PointFigureTransform, KagiTransform,
} from '/dist/openalgo-charts.transform.mjs';
import { el } from './ui.js';

// ── Family-B transforms ────────────────────────────────────────────────
// A transform re-buckets bars by price movement rather than the clock, so one
// source bar can emit zero, one, or many elements. Renko/Range/Line Break/HA
// plot as candles; P&F and Kagi have their own renderers (transform tier).
export function applyTransform(kind, bars) {
  if (!bars.length) return { type: 'candlestick', data: bars };
  // Scale the box/range to the instrument so one setting suits AAPL and BTC.
  const span = bars.reduce((m, b) => Math.max(m, b.high), 0) - bars.reduce((m, b) => Math.min(m, b.low), Infinity);
  const box = Math.max(1e-6, span / 40);
  switch (kind) {
    case 'heikin-ashi':
      return { type: 'candlestick', data: runTransform(new HeikinAshiTransform(), bars) };
    case 'renko':
      return { type: 'candlestick', data: runTransform(new RenkoTransform({ boxSize: box }), bars) };
    case 'range':
      return { type: 'candlestick', data: runTransform(new RangeBarsTransform({ range: box * 2 }), bars) };
    case 'line-break':
      return { type: 'candlestick', data: runTransform(new LineBreakTransform({ lines: 3 }), bars) };
    case 'kagi':
      return { type: 'kagi', data: runTransform(new KagiTransform({ reversal: box * 2 }), bars) };
    case 'point-figure': {
      // Box-size modes are new: 'atr' and 'percent' re-resolve the box each
      // time a column opens, so the grid tracks volatility / price level.
      const mode = el('pfmode').value;
      const opts = mode === 'atr' ? { mode: 'atr', atrPeriod: 14, reversal: 3 }
        : mode === 'percent' ? { mode: 'percent', percent: 1, reversal: 3 }
        : { boxSize: box, reversal: 3 };
      // Columns carry their own boxSize, so the series needs no style.boxSize.
      return { type: 'point-figure', data: runTransform(new PointFigureTransform(opts), bars) };
    }
    default:
      return { type: 'candlestick', data: bars };
  }
}
