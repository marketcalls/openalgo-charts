/**
 * Composed OpenAlgo live data feed (resolves audit V2-M1). Implements the full
 * `DataFeed` contract by combining history (REST), live ticks (WS), and a
 * per-subscription `CandleBuilder` — so `subscribeBars()` actually delivers live
 * interval bars instead of being a no-op trap.
 */
import type { Bar } from '../model/bar';
import type { BarsRequest, DataFeed, MarketDepth, UnsubscribeFn } from './types';
import { OpenAlgoDataFeed, type OpenAlgoConfig } from './openalgo-rest';
import { OpenAlgoWsFeed } from './openalgo-ws';
import { CandleBuilder, type VolumeMode } from './candle-builder';

export interface OpenAlgoLiveConfig extends OpenAlgoConfig {
  /** WS proxy URL, e.g. ws://127.0.0.1:8765. */
  wsUrl: string;
  /** Volume accounting for the live candle builder (default 'ltq-sum'). */
  volumeMode?: VolumeMode;
}

/** Map an interval token (e.g. '1m','5m','1h','D') to seconds for bucketing. */
export function intervalToSeconds(interval: string): number {
  const m = /^(\d+)\s*([smhdw])$/i.exec(interval.trim());
  if (m === null) return 60;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 604800;
  return n * mult;
}

export class OpenAlgoLiveDataFeed implements DataFeed {
  private readonly _rest: OpenAlgoDataFeed;
  private readonly _ws: OpenAlgoWsFeed;
  private readonly _volumeMode: VolumeMode;

  public constructor(config: OpenAlgoLiveConfig) {
    this._rest = new OpenAlgoDataFeed(config);
    this._ws = new OpenAlgoWsFeed({ url: config.wsUrl, apiKey: config.apiKey });
    this._volumeMode = config.volumeMode ?? 'ltq-sum';
    this._ws.connect();
  }

  public getBars(req: BarsRequest): Promise<Bar[]> {
    return this._rest.getBars(req);
  }

  /** Live interval bars: WS LTP → CandleBuilder → onBar (mutated/append bar). */
  public subscribeBars(req: BarsRequest, onBar: (bar: Bar) => void): UnsubscribeFn {
    const builder = new CandleBuilder({ intervalSec: intervalToSeconds(req.interval), volumeMode: this._volumeMode });
    const off = this._ws.onLtp((e) => {
      if (e.symbol !== req.symbol) return;
      const u = builder.onTick({ time: e.timeSec, price: e.ltp, ltq: e.ltq });
      if (u !== null) onBar(u.bar);
    });
    this._ws.subscribe('LTP', req.symbol, req.exchange);
    return () => { off(); this._ws.unsubscribe('LTP', req.symbol, req.exchange); };
  }

  public subscribeDepth(req: BarsRequest, onDepth: (depth: MarketDepth) => void): UnsubscribeFn {
    const off = this._ws.onDepth((symbol, _ex, depth) => { if (symbol === req.symbol) onDepth(depth); });
    this._ws.subscribe('Depth', req.symbol, req.exchange);
    return () => { off(); this._ws.unsubscribe('Depth', req.symbol, req.exchange); };
  }

  public close(): void {
    this._ws.close();
  }
}
