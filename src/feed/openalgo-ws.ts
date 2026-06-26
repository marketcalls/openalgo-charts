/**
 * OpenAlgo WebSocket adapter (ARCHITECTURE.md §10, C2). Subscribes to the
 * OpenAlgo unified WS proxy (default port 8765) for LTP / Quote / Depth and maps
 * events into typed callbacks the chart consumes (candle builder, last price,
 * DOM ladder depth).
 *
 * The socket is injectable (like the REST adapter's fetch) so the adapter is
 * unit-testable with a fake socket and no network. The subscribe-message and
 * inbound-message *schemas* below follow OpenAlgo's documented LTP/Quote/Depth
 * modes but MUST be verified against your running OpenAlgo build before
 * production — the parse/format helpers are isolated and pure for that reason.
 */
import type { MarketDepth } from './types';
import { epochMsToUtcSeconds } from './time';

export type WsMode = 'LTP' | 'Quote' | 'Depth';

/** Minimal socket surface (the browser WebSocket satisfies this). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface OpenAlgoWsConfig {
  url: string; // e.g. ws://127.0.0.1:8765
  apiKey: string;
  socketFactory?: SocketFactory;
}

export interface LtpEvent {
  symbol: string;
  exchange: string;
  ltp: number;
  ltq?: number;
  timeSec: number;
}

/** Pure: build the JSON subscribe message OpenAlgo expects. */
export function formatSubscribe(apiKey: string, mode: WsMode, symbol: string, exchange: string): string {
  return JSON.stringify({ action: 'subscribe', apikey: apiKey, mode, symbol, exchange });
}

export function formatUnsubscribe(apiKey: string, mode: WsMode, symbol: string, exchange: string): string {
  return JSON.stringify({ action: 'unsubscribe', apikey: apiKey, mode, symbol, exchange });
}

type RawMsg = {
  type?: string;
  mode?: string;
  symbol?: string;
  exchange?: string;
  ltp?: number;
  last_price?: number;
  ltq?: number;
  timestamp?: number | string;
  depth?: { buy?: { price: number; quantity: number }[]; sell?: { price: number; quantity: number }[] };
};

function toSec(ts: number | string | undefined): number {
  if (typeof ts === 'number') return ts > 1e12 ? epochMsToUtcSeconds(ts) : Math.floor(ts);
  return 0;
}

/** Pure: classify + normalise an inbound message into an LTP or Depth event. */
export function parseMessage(raw: unknown): { kind: 'ltp'; event: LtpEvent } | { kind: 'depth'; symbol: string; exchange: string; depth: MarketDepth } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as RawMsg;
  const symbol = m.symbol ?? '';
  const exchange = m.exchange ?? '';
  if (m.depth && (m.depth.buy || m.depth.sell)) {
    const bids = (m.depth.buy ?? []).map((b) => ({ price: b.price, qty: b.quantity }));
    const asks = (m.depth.sell ?? []).map((a) => ({ price: a.price, qty: a.quantity }));
    const ltp = m.ltp ?? m.last_price ?? (bids[0]?.price ?? 0);
    return { kind: 'depth', symbol, exchange, depth: { bids, asks, ltp } };
  }
  const price = m.ltp ?? m.last_price;
  if (typeof price === 'number') {
    return { kind: 'ltp', event: { symbol, exchange, ltp: price, ltq: m.ltq, timeSec: toSec(m.timestamp) } };
  }
  return null;
}

export class OpenAlgoWsFeed {
  private readonly _config: OpenAlgoWsConfig;
  private readonly _factory: SocketFactory;
  private _sock: SocketLike | null = null;
  private readonly _ltpCbs = new Set<(e: LtpEvent) => void>();
  private readonly _depthCbs = new Set<(symbol: string, exchange: string, depth: MarketDepth) => void>();

  public constructor(config: OpenAlgoWsConfig) {
    this._config = config;
    const f = config.socketFactory
      ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    this._factory = f;
  }

  public connect(): void {
    if (this._sock !== null) return;
    const sock = this._factory(this._config.url);
    sock.onmessage = (ev): void => this._dispatch(ev.data);
    this._sock = sock;
  }

  public onLtp(cb: (e: LtpEvent) => void): () => void {
    this._ltpCbs.add(cb);
    return () => this._ltpCbs.delete(cb);
  }

  public onDepth(cb: (symbol: string, exchange: string, depth: MarketDepth) => void): () => void {
    this._depthCbs.add(cb);
    return () => this._depthCbs.delete(cb);
  }

  public subscribe(mode: WsMode, symbol: string, exchange: string): void {
    this._sock?.send(formatSubscribe(this._config.apiKey, mode, symbol, exchange));
  }

  public unsubscribe(mode: WsMode, symbol: string, exchange: string): void {
    this._sock?.send(formatUnsubscribe(this._config.apiKey, mode, symbol, exchange));
  }

  public close(): void {
    this._sock?.close();
    this._sock = null;
  }

  private _dispatch(data: string): void {
    let raw: unknown;
    try { raw = JSON.parse(data); } catch { return; }
    const parsed = parseMessage(raw);
    if (parsed === null) return;
    if (parsed.kind === 'ltp') for (const cb of this._ltpCbs) cb(parsed.event);
    else for (const cb of this._depthCbs) cb(parsed.symbol, parsed.exchange, parsed.depth);
  }
}
