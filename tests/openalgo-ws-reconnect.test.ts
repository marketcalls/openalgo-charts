import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAlgoWsFeed } from '../src/feed/openalgo-ws';

function fakeSocket(): any {
  const s: any = {
    sent: [] as string[], readyState: 1,
    onopen: null, onclose: null, onerror: null, onmessage: null,
    send(d: string) { s.sent.push(d); },
    close() {},
  };
  return s;
}

afterEach(() => { vi.useRealTimers(); });

describe('OpenAlgoWsFeed reconnect', () => {
  it('reconnects with backoff and replays subscriptions after an unexpected close', () => {
    vi.useFakeTimers();
    const sockets: any[] = [];
    const ws = new OpenAlgoWsFeed({
      url: 'ws://x', apiKey: 'k', reconnect: { baseDelayMs: 100 },
      socketFactory: () => { const s = fakeSocket(); sockets.push(s); return s; },
    });
    ws.connect();
    ws.subscribe('LTP', 'X', 'NSE');
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.some((m: string) => m.includes('subscribe') && m.includes('X'))).toBe(true);

    // Unexpected drop -> should schedule a reconnect.
    sockets[0].onclose();
    vi.advanceTimersByTime(100);

    // A fresh socket authenticated and replayed the subscription.
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent.some((m: string) => m.includes('authenticate'))).toBe(true);
    expect(sockets[1].sent.some((m: string) => m.includes('subscribe') && m.includes('X'))).toBe(true);
    ws.close();
  });

  it('does not reconnect after an intentional close()', () => {
    vi.useFakeTimers();
    const sockets: any[] = [];
    const ws = new OpenAlgoWsFeed({
      url: 'ws://x', apiKey: 'k', reconnect: { baseDelayMs: 50 },
      socketFactory: () => { const s = fakeSocket(); sockets.push(s); return s; },
    });
    ws.connect();
    ws.subscribe('LTP', 'X', 'NSE');
    ws.close();
    sockets[0].onclose(); // the browser fires onclose after close()
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(1); // no reconnect
  });

  it('honors reconnect.enabled = false', () => {
    vi.useFakeTimers();
    const sockets: any[] = [];
    const ws = new OpenAlgoWsFeed({
      url: 'ws://x', apiKey: 'k', reconnect: { enabled: false },
      socketFactory: () => { const s = fakeSocket(); sockets.push(s); return s; },
    });
    ws.connect();
    sockets[0].onclose();
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
    ws.close();
  });
});
