/** Offline bars for the terminal demos, using the bundled OpenAlgo responses. */
import { bucketStartOf, mapHistoryResponse, resolveInterval, type Bar, type BarsRequest, type DataFeed, type SymbolSearchRequest, type SymbolMatch } from 'openalgo-charts';

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'RELIANCE', 'SENSEX', 'TCS'];
/** The fixture clock keeps demos reproducible after the recorded sessions end. */
export const SAMPLE_NOW = Date.parse('2026-10-06T14:17:00+05:30');

export class SampleMarketDataFeed implements DataFeed {
  private readonly _cache = new Map<string, Bar[]>();

  constructor(private readonly _baseDataUrl = './data/') {}

  async getBars(req: BarsRequest): Promise<Bar[]> {
    req.signal?.throwIfAborted();
    const symbol = req.symbol.toUpperCase().replace(/^NIFTY50$/, 'NIFTY');
    if (!SYMBOLS.includes(symbol)) throw new Error(`openalgo-charts: no sample data for ${symbol}`);
    const rule = resolveInterval(req.interval).bucketing;
    if (rule.mode !== 'interval' && rule.mode !== 'calendar') {
      throw new Error('openalgo-charts: sample data needs a time interval');
    }
    if (rule.mode === 'interval' && rule.seconds < 60) {
      throw new RangeError('openalgo-charts: sample data has minute resolution');
    }
    let source = this._cache.get(symbol);
    if (!source) {
      const response = await fetch(`${this._baseDataUrl}${symbol}.json`, req.signal ? { signal: req.signal } : {});
      if (!response.ok) throw new Error(`openalgo-charts: sample request failed (${response.status})`);
      const raw: unknown = await response.json();
      req.signal?.throwIfAborted();
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { data?: unknown }).data)) {
        throw new TypeError('openalgo-charts: sample response needs a data array');
      }
      source = mapHistoryResponse(raw as Parameters<typeof mapHistoryResponse>[0]);
      this._cache.set(symbol, source);
    }
    req.signal?.throwIfAborted();
    // These fixtures cover Indian sessions: intraday bars open at 09:15 IST,
    // while a daily bar belongs to the local trading date.
    const bucketing = rule.mode === 'interval' ? {
      ...rule, anchorSec: rule.anchorSec ?? (rule.seconds < 86400 ? 13500 : -19800),
    } : rule;
    const buckets = new Map<number, Bar>();
    for (const bar of source) {
      const time = bucketStartOf(bucketing, bar.time, 'Asia/Kolkata');
      const current = buckets.get(time);
      if (current) {
        current.high = Math.max(current.high, bar.high);
        current.low = Math.min(current.low, bar.low);
        current.close = bar.close;
        current.volume = (current.volume ?? 0) + (bar.volume ?? 0);
      } else buckets.set(time, { ...bar, time, volume: bar.volume ?? 0 });
    }
    let bars = [...buckets.values()].filter(bar =>
      (req.from === undefined || bar.time >= req.from) && (req.to === undefined || bar.time <= req.to));
    if (req.countBack !== undefined && req.countBack > 0) bars = bars.slice(-req.countBack);
    return bars;
  }

  async searchSymbols(request: SymbolSearchRequest): Promise<SymbolMatch[]> {
    request.signal?.throwIfAborted();
    return SYMBOLS.filter(symbol => symbol.includes(request.query.toUpperCase()))
      .map(symbol => ({ symbol, exchange: 'NSE', name: symbol }));
  }
}
