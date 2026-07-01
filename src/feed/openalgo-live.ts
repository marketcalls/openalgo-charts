/**
 * Composed OpenAlgo live data feed (resolves audit V2-M1). Implements the full
 * `DataFeed` contract by combining history (REST), live ticks (WS), and a
 * per-subscription `CandleBuilder` — so `subscribeBars()` actually delivers live
 * interval bars instead of being a no-op trap.
 */
import type { Bar } from '../model/bar';
import type { BarsRequest, DataFeed, MarketDepth, UnsubscribeFn } from './types';
import { OpenAlgoDataFeed, type OpenAlgoConfig } from './openalgo-rest';
import { OpenAlgoWsFeed, type SocketFactory } from './openalgo-ws';
import { CandleBuilder, type VolumeMode } from './candle-builder';

export interface OpenAlgoLiveConfig extends OpenAlgoConfig {
  /** WS proxy URL, e.g. ws://127.0.0.1:8765. */
  wsUrl: string;
  /** Volume accounting for the live candle builder (default 'ltq-sum'). */
  volumeMode?: VolumeMode;
  /** Inject a custom socket (tests, React Native, non-browser runtimes). */
  socketFactory?: SocketFactory;
}

/**
 * Map an interval token to seconds for bucketing. The count is optional so the
 * bare OpenAlgo tokens `D` and `W` (daily / weekly) work alongside `1d`/`1w`,
 * e.g. `D` -> 86400, `1m` -> 60, `1h` -> 3600. Unknown tokens fall back to 60.
 */
export function intervalToSeconds(interval: string): number {
  const m = /^(\d*)\s*([smhdw])$/i.exec(interval.trim());
  if (m === null) return 60;
  const n = m[1] === '' ? 1 : Number(m[1]);
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
    this._ws = new OpenAlgoWsFeed({ url: config.wsUrl, apiKey: config.apiKey, socketFactory: config.socketFactory });
    this._volumeMode = config.volumeMode ?? 'ltq-sum';
    this._ws.connect();
  }

  public getBars(req: BarsRequest): Promise<Bar[]> {
    return this._rest.getBars(req);
  }

  /**
   * Live interval bars: WS LTP -> CandleBuilder -> onBar (mutated/append bar).
   * Pass `opts.seedFrom` (the last history bar) to continue that bar's bucket
   * seamlessly instead of starting a fresh one, and `opts.cumDayVolumeSoFar`
   * so a `day-delta` builder diffs against the right baseline.
   */
  public subscribeBars(
    req: BarsRequest,
    onBar: (bar: Bar) => void,
    opts?: { seedFrom?: Bar; cumDayVolumeSoFar?: number },
  ): UnsubscribeFn {
    const builder = new CandleBuilder({ intervalSec: intervalToSeconds(req.interval), volumeMode: this._volumeMode });
    if (opts?.seedFrom) builder.seed(opts.seedFrom, opts.cumDayVolumeSoFar);
    const off = this._ws.onLtp((e) => {
      // Match both symbol and exchange (a broker can multiplex venues on one socket).
      if (e.symbol !== req.symbol) return;
      if (e.exchange && req.exchange && e.exchange !== req.exchange) return;
      // A broker may omit the tick timestamp; never bucket at the epoch, use now.
      const time = e.timeSec && e.timeSec > 0 ? e.timeSec : Math.floor(Date.now() / 1000);
      // cumDayVolume is only consumed in 'day-delta' mode; harmless otherwise.
      const u = builder.onTick({ time, price: e.ltp, ltq: e.ltq, cumDayVolume: e.volume });
      if (u !== null) onBar(u.bar);
    });
    this._ws.subscribe('LTP', req.symbol, req.exchange);
    return () => { off(); this._ws.unsubscribe('LTP', req.symbol, req.exchange); };
  }

  public subscribeDepth(req: BarsRequest, onDepth: (depth: MarketDepth) => void): UnsubscribeFn {
    const off = this._ws.onDepth((symbol, ex, depth) => {
      if (symbol !== req.symbol) return;
      if (ex && req.exchange && ex !== req.exchange) return;
      onDepth(depth);
    });
    this._ws.subscribe('Depth', req.symbol, req.exchange);
    return () => { off(); this._ws.unsubscribe('Depth', req.symbol, req.exchange); };
  }

  public close(): void {
    this._ws.close();
  }
}
