/**
 * OpenAlgo WebSocket adapter (ARCHITECTURE.md §10, C2). Speaks the documented
 * OpenAlgo WS proxy protocol (default port 8765, or wss://host/ws in production):
 *
 *   1. authenticate: { action:'authenticate', api_key }
 *   2. subscribe   : { action:'subscribe', symbol, exchange, mode }   mode 1=LTP 2=Quote 3=Depth
 *                    (Depth adds depth_level, e.g. 5/20/30/50)
 *   3. server pushes { type:'market_data', mode, topic:'SYM.EXCH', data:{...} }
 *   4. heartbeat   : server 'ping' → client 'pong' (30s)
 *
 * Maps inbound LTP / Quote / Depth into typed callbacks the chart consumes
 * (candle builder, last price, DOM ladder). The socket is injectable so the
 * adapter is unit-testable with a fake socket and no network.
 */
import type { MarketDepth } from './types';
import { epochMsToUtcSeconds } from './time';

export type WsMode = 'LTP' | 'Quote' | 'Depth';

/** OpenAlgo numeric data modes (websockets-format.md §Data Modes). */
const MODE_NUMBER: Record<WsMode, number> = { LTP: 1, Quote: 2, Depth: 3 };

/** Minimal socket surface (the browser WebSocket satisfies this). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  /** 1 === OPEN (browser WebSocket.OPEN). Used to gate sends. */
  readyState?: number;
}

export type SocketFactory = (url: string) => SocketLike;

export interface OpenAlgoWsConfig {
  url: string; // e.g. ws://127.0.0.1:8765 (or wss://host/ws)
  apiKey: string;
  socketFactory?: SocketFactory;
}

export interface LtpEvent {
  symbol: string;
  exchange: string;
  ltp: number;
  ltq?: number;
  /** Cumulative day volume (Quote mode) — feeds the candle builder's day-delta mode. */
  volume?: number;
  timeSec: number;
}

/** Pure: the auth handshake message that must precede any subscription. */
export function formatAuthenticate(apiKey: string): string {
  return JSON.stringify({ action: 'authenticate', api_key: apiKey });
}

/**
 * Pure: build a subscribe message — `{ action, symbol, exchange, mode }`, where
 * `mode` is the numeric OpenAlgo data mode. Depth subscriptions may request a
 * `depth_level` (broker-dependent: 5/20/30/50).
 */
export function formatSubscribe(mode: WsMode, symbol: string, exchange: string, depthLevel?: number): string {
  const msg: Record<string, unknown> = { action: 'subscribe', symbol, exchange, mode: MODE_NUMBER[mode] };
  if (mode === 'Depth' && depthLevel !== undefined) msg.depth_level = depthLevel;
  return JSON.stringify(msg);
}

export function formatUnsubscribe(mode: WsMode, symbol: string, exchange: string): string {
  return JSON.stringify({ action: 'unsubscribe', symbol, exchange, mode: MODE_NUMBER[mode] });
}

interface DepthLevel { price: number; quantity: number; orders?: number }
interface RawData {
  symbol?: string;
  exchange?: string;
  ltp?: number;
  last_price?: number;
  last_trade_quantity?: number;
  ltq?: number;
  volume?: number; // cumulative day volume (Quote mode)
  timestamp?: number | string;
  depth?: { buy?: DepthLevel[]; sell?: DepthLevel[] };
}
interface RawMsg {
  type?: string;
  mode?: number;
  topic?: string;
  data?: RawData;
}

/** Coerce a WS timestamp (epoch s/ms or ISO-8601 string) to UTC seconds. */
function toSec(ts: number | string | undefined): number {
  if (typeof ts === 'number') return ts > 1e12 ? epochMsToUtcSeconds(ts) : Math.floor(ts);
  if (typeof ts === 'string' && ts.trim() !== '') {
    const ms = Date.parse(ts); // ISO-8601 with 'Z' is unambiguous UTC
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

/** True if the inbound frame is a heartbeat ping (plain "ping" or { type:'ping' }). */
export function isPing(raw: unknown): boolean {
  if (raw === 'ping') return true;
  return typeof raw === 'object' && raw !== null && (raw as { type?: string }).type === 'ping';
}

/**
 * Pure: classify + normalise an inbound message into an LTP or Depth event.
 * Payload fields live under `data` per the protocol, but the parser also
 * tolerates a flat shape for resilience across broker adapters.
 */
export function parseMessage(raw: unknown): { kind: 'ltp'; event: LtpEvent } | { kind: 'depth'; symbol: string; exchange: string; depth: MarketDepth } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as RawMsg & RawData;
  const d: RawData = m.data ?? m;
  const symbol = d.symbol ?? '';
  const exchange = d.exchange ?? '';
  if (d.depth && (d.depth.buy || d.depth.sell)) {
    const bids = (d.depth.buy ?? []).map((b) => ({ price: b.price, qty: b.quantity }));
    const asks = (d.depth.sell ?? []).map((a) => ({ price: a.price, qty: a.quantity }));
    const ltp = d.ltp ?? d.last_price ?? (bids[0]?.price ?? 0);
    return { kind: 'depth', symbol, exchange, depth: { bids, asks, ltp } };
  }
  const price = d.ltp ?? d.last_price;
  if (typeof price === 'number') {
    return { kind: 'ltp', event: { symbol, exchange, ltp: price, ltq: d.last_trade_quantity ?? d.ltq, volume: d.volume, timeSec: toSec(d.timestamp) } };
  }
  return null;
}

export class OpenAlgoWsFeed {
  private readonly _config: OpenAlgoWsConfig;
  private readonly _factory: SocketFactory;
  private _sock: SocketLike | null = null;
  private _open = false;
  private readonly _queue: string[] = [];
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
    sock.onopen = (): void => this._onOpen();
    sock.onclose = (): void => { this._open = false; };
    this._sock = sock;
    // Some sockets connect synchronously (readyState OPEN) before onopen fires.
    if (sock.readyState === 1) this._onOpen();
  }

  /** Authenticate first, then flush any queued subscriptions (protocol order). */
  private _onOpen(): void {
    if (this._open) return;
    this._open = true;
    this._sock?.send(formatAuthenticate(this._config.apiKey));
    this._flush();
  }

  /** Send now if open; otherwise queue until onopen (browsers throw on send-before-open). */
  private _send(msg: string): void {
    if (this._sock !== null && this._open) this._sock.send(msg);
    else this._queue.push(msg);
  }

  private _flush(): void {
    if (this._sock === null) return;
    for (const msg of this._queue) this._sock.send(msg);
    this._queue.length = 0;
  }

  public onLtp(cb: (e: LtpEvent) => void): () => void {
    this._ltpCbs.add(cb);
    return () => this._ltpCbs.delete(cb);
  }

  public onDepth(cb: (symbol: string, exchange: string, depth: MarketDepth) => void): () => void {
    this._depthCbs.add(cb);
    return () => this._depthCbs.delete(cb);
  }

  public subscribe(mode: WsMode, symbol: string, exchange: string, depthLevel?: number): void {
    this._send(formatSubscribe(mode, symbol, exchange, depthLevel));
  }

  public unsubscribe(mode: WsMode, symbol: string, exchange: string): void {
    this._send(formatUnsubscribe(mode, symbol, exchange));
  }

  public close(): void {
    this._sock?.close();
    this._sock = null;
    this._open = false;
    this._queue.length = 0;
  }

  private _dispatch(data: string): void {
    let raw: unknown;
    try { raw = JSON.parse(data); } catch { raw = data; } // heartbeats may be plain text
    if (isPing(raw)) { this._sock?.send(JSON.stringify({ action: 'pong' })); return; }
    const parsed = parseMessage(raw);
    if (parsed === null) return;
    if (parsed.kind === 'ltp') for (const cb of this._ltpCbs) cb(parsed.event);
    else for (const cb of this._depthCbs) cb(parsed.symbol, parsed.exchange, parsed.depth);
  }
}
