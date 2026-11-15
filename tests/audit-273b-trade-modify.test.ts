/**
 * `commitModify` waits for the modify `requestModify` already sent (re-audit T3).
 *
 * `requestModify` sends at once when its interval has passed, which on a drag
 * release is nearly always, and that send takes the patch off the queue. The
 * `commitModify` that follows found nothing queued and resolved at once, so a
 * host that read the book on it, as the documented recipe does, read it
 * before the broker had taken the write and repainted the order at its old
 * price, with nothing to read it again on the acknowledgement.
 */
import { describe, expect, it } from 'vitest';
import { OrderEngine, type ModifyPatch, type OrderFeed } from '../src/trade/order-engine';

function engine(minModifyIntervalMs = 150) {
  const answers: (() => void)[] = [];
  const sent: ModifyPatch[] = [];
  let now = 0;
  const feed: OrderFeed = {
    place: async () => ({ orderId: 'B1' }),
    modify: (_id, patch) => { sent.push({ ...patch }); return new Promise<void>((resolve) => { answers.push(resolve); }); },
    cancel: async () => {},
  };
  const eng = new OrderEngine({ feed, armed: true, constraints: { tickSize: 0.05 }, minModifyIntervalMs, now: () => now });
  return { eng, sent, answer: (i: number) => answers[i]!(), tick: (ms: number) => { now += ms; } };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('commitModify joins the writes already out', () => {
  it('resolves only once the broker has answered the modify requestModify sent', async () => {
    const h = engine();
    const placed = await h.eng.placeOrder({ symbol: 'INFY', side: 'BUY', type: 'LIMIT', qty: 10, price: 100 });
    h.eng.requestModify(placed.clientId!, 105);
    let done = false;
    void h.eng.commitModify(placed.clientId!).then(() => { done = true; });
    await settle();
    expect(h.sent).toEqual([{ price: 105 }]);
    expect(done).toBe(false);
    h.answer(0);
    await settle();
    expect(done).toBe(true);
    expect(h.eng.intentState(placed.clientId!)).toBe('ACKNOWLEDGED');
  });

  it('waits for the sent write and the queued one it flushes', async () => {
    const h = engine();
    const placed = await h.eng.placeOrder({ symbol: 'INFY', side: 'BUY', type: 'LIMIT', qty: 10, price: 100 });
    h.eng.requestModify(placed.clientId!, 101);   // sent at once
    h.eng.requestModify(placed.clientId!, 102);   // inside the interval: queued
    let done = false;
    void h.eng.commitModify(placed.clientId!).then(() => { done = true; });
    await settle();
    expect(h.sent).toEqual([{ price: 101 }, { price: 102 }]);
    h.answer(1);
    await settle();
    expect(done).toBe(false);
    h.answer(0);
    await settle();
    expect(done).toBe(true);
  });

  it('resolves at once with nothing sent or queued', async () => {
    const h = engine();
    const placed = await h.eng.placeOrder({ symbol: 'INFY', side: 'BUY', type: 'LIMIT', qty: 10, price: 100 });
    let done = false;
    void h.eng.commitModify(placed.clientId!).then(() => { done = true; });
    await settle();
    expect(done).toBe(true);
    expect(h.sent).toEqual([]);
  });
});
