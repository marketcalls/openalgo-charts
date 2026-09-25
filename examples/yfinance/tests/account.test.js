import { describe, it, expect } from 'vitest';
import { createDesk, fingerprint, ticketRequest, SANDBOX_ACCOUNTS, TICKET_DURATIONS } from '../src/account.js';

const NOW = 1_800_000_000;
const ticket = (extra = {}) => ({ side: 'BUY', type: 'MARKET', qty: 10, price: 100, duration: 'DAY', expiresAt: undefined, leverage: undefined, ...extra });

async function ready() {
  const desk = createDesk({ now: () => NOW });
  await desk.accounts.refresh();
  desk.broker.setMark('AAPL', 100);
  return desk;
}

describe('sandbox broker desk', () => {
  it('shows only the analyzer accounts and names them', async () => {
    const desk = await ready();
    expect(desk.accounts.getState().accounts.map((a) => a.id)).toEqual(['SBX-CASH', 'SBX-MARGIN']);
    expect(SANDBOX_ACCOUNTS.some((a) => a.mode === 'live')).toBe(true);
    expect(desk.accounts.getState().snapshot).toMatchObject({ accountId: 'SBX-CASH', mode: 'analyzer', equity: 100000 });
  });

  it('builds the request the ticket describes, with a price and expiry only where they apply', () => {
    expect(ticketRequest(ticket(), 'AAPL')).toEqual({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 10, duration: 'DAY' });
    expect(ticketRequest(ticket({ type: 'LIMIT', duration: 'GTD', expiresAt: NOW + 60, leverage: 2 }), 'AAPL'))
      .toEqual({ symbol: 'AAPL', side: 'BUY', type: 'LIMIT', qty: 10, price: 100, duration: 'GTD', expiresAt: NOW + 60, leverage: 2 });
    expect(TICKET_DURATIONS).toEqual(['DAY', 'IOC', 'GTC', 'GTD']);
  });

  it('places only the ticket that was approved, once', async () => {
    const desk = await ready();
    const req = ticketRequest(ticket(), 'AAPL');
    expect(await desk.engine.placeOrder(req)).toMatchObject({ ok: false, reason: 'not confirmed' });
    desk.approveOrder(req);
    expect(await desk.engine.placeOrder({ ...req, qty: 11 })).toMatchObject({ ok: false, reason: 'not confirmed' });
    desk.approveOrder(req);
    const placed = await desk.engine.placeOrder(req);
    expect(placed).toMatchObject({ ok: true });
    expect(desk.engine.brokerStatus(placed.clientId)).toBe('filled');
    expect(await desk.engine.placeOrder(req)).toMatchObject({ ok: false, reason: 'not confirmed' });
    expect(desk.broker.accountPositions('SBX-CASH')).toEqual([{ symbol: 'AAPL', netQty: 10, avgPrice: 100 }]);
    expect(fingerprint(req)).not.toBe(fingerprint({ ...req, duration: 'IOC' }));
  });

  it('closes part, reverses and closes through the provider, each approved by its own click', async () => {
    const desk = await ready();
    const req = ticketRequest(ticket(), 'AAPL');
    desk.approveOrder(req);
    await desk.engine.placeOrder(req);
    expect(await desk.engine.closePosition({ symbol: 'AAPL', qty: 4 })).toMatchObject({ ok: false, reason: 'not confirmed' });
    desk.approveCommand('close');
    expect(await desk.engine.closePosition({ symbol: 'AAPL', qty: 4 })).toMatchObject({ ok: true, kind: 'close' });
    desk.approveCommand('close');
    expect(await desk.engine.reversePosition({ symbol: 'AAPL' })).toMatchObject({ ok: false, reason: 'not confirmed' });
    desk.approveCommand('reverse');
    expect(await desk.engine.reversePosition({ symbol: 'AAPL' })).toMatchObject({ ok: true, kind: 'reverse' });
    expect(desk.broker.accountPositions('SBX-CASH')).toEqual([{ symbol: 'AAPL', netQty: -6, avgPrice: 100 }]);
    desk.approveCommand('close');
    await desk.engine.closePosition({ symbol: 'AAPL' });
    expect(desk.broker.accountPositions('SBX-CASH')).toEqual([]);
    const executions = await desk.accounts.executions({ symbol: 'AAPL' });
    expect(executions.ok && executions.rows.map((row) => `${row.side} ${row.qty}`)).toEqual(['BUY 6', 'SELL 12', 'SELL 4', 'BUY 10']);
  });

  it('settles every write a dropped connection left open when it reconnects', async () => {
    const desk = await ready();
    const req = ticketRequest(ticket({ qty: 50 }), 'AAPL');
    desk.approveOrder(req);
    desk.track(await desk.engine.placeOrder(req));
    // The broker applies this close; its answer is lost with the connection.
    desk.broker.muteOrderUpdates(true);
    desk.broker.failNext('close', 'lost-response');
    desk.approveCommand('close');
    const lost = desk.track(await desk.engine.closePosition({ symbol: 'AAPL', qty: 20 }));
    expect(lost).toMatchObject({ ok: false, intent: 'AMBIGUOUS' });
    // This order is lost before the broker applies it.
    desk.broker.failNext('place', 'timeout');
    const other = ticketRequest(ticket({ qty: 5 }), 'MSFT');
    desk.approveOrder(other);
    const never = desk.track(await desk.engine.placeOrder(other));
    expect(never).toMatchObject({ ok: false, intent: 'AMBIGUOUS' });
    desk.broker.muteOrderUpdates(false);
    desk.broker.disconnect();
    desk.approveCommand('close');
    expect(await desk.engine.closePosition({ symbol: 'AAPL', qty: 20 })).toMatchObject({ ok: false, intent: 'BLOCKED' });

    expect(await desk.reconnect()).toMatchObject({ ok: true });
    expect([desk.engine.intentState(lost.clientId), desk.engine.brokerStatus(lost.clientId)]).toEqual(['SETTLED', 'filled']);
    expect(desk.engine.intentState(never.clientId)).toBeUndefined();
    desk.approveCommand('close');
    expect(await desk.engine.closePosition({ symbol: 'AAPL', qty: 20 })).toMatchObject({ ok: true });
    expect(desk.broker.accountPositions('SBX-CASH')).toEqual([{ symbol: 'AAPL', netQty: 10, avgPrice: 100 }]);
  });

  it('previews without placing and reports what the provider would refuse', async () => {
    const desk = await ready();
    const preview = await desk.engine.previewOrder(ticketRequest(ticket({ qty: 5000 }), 'AAPL'));
    expect(preview).toMatchObject({ ok: true, preview: { estimatedValue: 500000, rejectReason: expect.stringContaining('Insufficient margin') } });
    expect(desk.broker.accountPositions('SBX-CASH')).toEqual([]);
  });
});
