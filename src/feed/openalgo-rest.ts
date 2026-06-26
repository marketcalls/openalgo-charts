/**
 * OpenAlgo REST adapter (ARCHITECTURE.md §10.0). The chart depends only on the
 * `DataFeed` interface; this is the only file that knows OpenAlgo's REST shape.
 *
 * History endpoint: POST `${baseUrl}/api/v1/history`.
 * NOTE: the exact request/response field names must be verified against the
 * running OpenAlgo build and pinned here; the mapper below is tolerant of
 * epoch-seconds, epoch-ms, and IST date/time string timestamps.
 */
import type { Bar } from '../model/bar';
import type { BarsRequest, DataFeed, UnsubscribeFn } from './types';
import { epochMsToUtcSeconds, istStringToUtcSeconds, utcSecondsToIstDateString } from './time';

export interface OpenAlgoConfig {
  baseUrl: string;
  apiKey: string;
  /** Injectable fetch (defaults to global fetch); lets the adapter be tested offline. */
  fetchImpl?: typeof fetch;
}

interface HistoryRow {
  timestamp?: number | string;
  time?: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface HistoryResponse {
  status?: string;
  data?: HistoryRow[];
}

/** Pure: coerce a row timestamp (epoch s / epoch ms / IST string) to UTC seconds. */
export function rowTimeToUtcSeconds(value: number | string): number {
  if (typeof value === 'number') {
    // Heuristic: > 1e12 is almost certainly milliseconds.
    return value > 1e12 ? epochMsToUtcSeconds(value) : Math.floor(value);
  }
  // Numeric-looking string?
  const asNum = Number(value);
  if (value.trim() !== '' && !Number.isNaN(asNum) && !/[-T :]/.test(value.trim())) {
    return asNum > 1e12 ? epochMsToUtcSeconds(asNum) : Math.floor(asNum);
  }
  return istStringToUtcSeconds(value);
}

/** Pure: map an OpenAlgo history response into sorted internal bars. */
export function mapHistoryResponse(json: HistoryResponse): Bar[] {
  const rows = json.data ?? [];
  const bars: Bar[] = [];
  for (const r of rows) {
    const ts = r.timestamp ?? r.time;
    if (ts === undefined) continue;
    bars.push({
      time: rowTimeToUtcSeconds(ts),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    });
  }
  return bars.sort((a, b) => a.time - b.time);
}

export class OpenAlgoDataFeed implements DataFeed {
  private readonly _config: OpenAlgoConfig;
  private readonly _fetch: typeof fetch;

  public constructor(config: OpenAlgoConfig) {
    this._config = config;
    const f = config.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (f === undefined) throw new Error('openalgo-charts: no fetch available; pass config.fetchImpl');
    this._fetch = f;
  }

  public async getBars(req: BarsRequest): Promise<Bar[]> {
    // OpenAlgo /api/v1/history requires start_date/end_date as IST YYYY-MM-DD
    // (mandatory). Convert the internal UTC-seconds range to IST date strings.
    if (req.from === undefined || req.to === undefined) {
      throw new Error('openalgo-charts: getBars requires `from` and `to` (UTC seconds) — OpenAlgo history needs a date range');
    }
    const res = await this._fetch(`${this._config.baseUrl}/api/v1/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: this._config.apiKey,
        symbol: req.symbol,
        exchange: req.exchange,
        interval: req.interval,
        start_date: utcSecondsToIstDateString(req.from),
        end_date: utcSecondsToIstDateString(req.to),
      }),
    });
    if (!res.ok) throw new Error(`openalgo-charts: history request failed (${res.status})`);
    return mapHistoryResponse((await res.json()) as HistoryResponse);
  }

  public subscribeBars(_req: BarsRequest, _onBar: (bar: Bar) => void): UnsubscribeFn {
    // Live subscription is wired in Phase 4 (WS + candle builder).
    return () => {};
  }
}
