import { describe, it, expect, vi } from 'vitest';
import { TradingController } from '../src/core/trading-controller';
import type { TradingHost } from '../src/core/trading-controller';
import { PriceLine } from '../src/primitives/price-line';
import type { IPrimitive } from '../src/primitives/primitive';

function fakeHost() {
  const added: IPrimitive[] = [];
  let clickCb: (id: string) => void = () => {};
  let dragCb: (id: string, p: number) => void = () => {};
  let dragEndCb: (id: string, p: number) => void = () => {};
  const host: TradingHost = {
    addPrimitive: (p) => { added.push(p); },
    removePrimitive: (p) => { const i = added.indexOf(p); if (i >= 0) added.splice(i, 1); },
    subscribeClick: (cb) => { clickCb = cb; },
    subscribeDrag: (onDrag, onEnd) => { dragCb = onDrag; if (onEnd) dragEndCb = onEnd; },
  };
  return {
    host, added,
    click: (id: string) => clickCb(id),
    drag: (id: string, p: number) => dragCb(id, p),
    dragEnd: (id: string, p: number) => dragEndCb(id, p),
    lines: () => added.filter((p): p is PriceLine => p instanceof PriceLine),
  };
}

describe('TradingController', () => {
  it('renders positions and orders as price-line pills', () => {
    const h = fakeHost();
    const tc = new TradingController(h.host);
    tc.setPositions([{ id: 'p1', side: 'long', entryPrice: 50000, size: 1.5, pnlText: '+$100.00' }]);
    tc.setOrders([{ id: 'o1', type: 'limit', side: 'buy', price: 48000, size: 0.5 }]);

    expect(tc.getPositions()).toHaveLength(1);
    expect(tc.getOrders()).toHaveLength(1);
    const [pos, ord] = h.lines().map((l) => l.options());
    expect(pos.leftLabel).toBe('LONG 1.5  +$100.00');
    expect(pos.closeButton).toBe(true);
    expect(ord.leftLabel).toBe('BUY 0.5 LIMIT');
    expect(ord.cursor).toBe('ns-resize'); // draggable by default
  });

  it('emits close / cancel on the x button', () => {
    const h = fakeHost();
    const tc = new TradingController(h.host);
    const onClose = vi.fn();
    const onCancel = vi.fn();
    tc.on('trading:position_close', onClose);
    tc.on('trading:order_cancel', onCancel);
    tc.setPositions([{ id: 'p1', side: 'short', entryPrice: 100, size: 1 }]);
    tc.setOrders([{ id: 'o1', type: 'stop', side: 'sell', price: 90, size: 1 }]);

    h.click('pos:p1::close');
    h.click('ord:o1::close');
    expect(onClose).toHaveBeenCalledWith({ positionId: 'p1' });
    expect(onCancel).toHaveBeenCalledWith({ orderId: 'o1' });
  });

  it('emits order_modify after a drag', () => {
    const h = fakeHost();
    const tc = new TradingController(h.host);
    const onModify = vi.fn();
    tc.on('trading:order_modify', onModify);
    tc.setOrders([{ id: 'o1', type: 'limit', side: 'buy', price: 100, size: 1 }]);

    h.drag('ord:o1', 105);
    h.dragEnd('ord:o1', 106);
    expect(onModify).toHaveBeenCalledWith({ orderId: 'o1', newPrice: 106, previousPrice: 100 });
    expect(tc.getOrders()[0].price).toBe(106); // optimistic update
  });

  it('replaces on setOrders and removes bracket children with the parent', () => {
    const h = fakeHost();
    const tc = new TradingController(h.host);
    tc.setOrders([
      { id: 'o1', type: 'limit', side: 'buy', price: 100, size: 1 },
      { id: 'tp', type: 'limit', side: 'sell', price: 110, size: 1, parentId: 'o1', bracketRole: 'tp' },
    ]);
    expect(h.lines()).toHaveLength(2);
    tc.removeOrder('o1'); // removes o1 + its child tp
    expect(h.lines()).toHaveLength(0);
    expect(tc.getOrders()).toHaveLength(0);
  });

  it('line-only variant has no pill or close button', () => {
    const h = fakeHost();
    const tc = new TradingController(h.host);
    tc.setOrders([{ id: 'o1', type: 'limit', side: 'buy', price: 100, size: 1, variant: 'line-only' }]);
    const opts = h.lines()[0].options();
    expect(opts.leftLabel).toBeUndefined();
    expect(opts.closeButton).toBe(false);
    expect(opts.cursor).toBeUndefined();
  });

  it('updatePositionPnl refreshes the pill without recreating the line', () => {
    const h = fakeHost();
    const tc = new TradingController(h.host);
    tc.setPositions([{ id: 'p1', side: 'long', entryPrice: 100, size: 2, pnlText: '+$0.00' }]);
    const line = h.lines()[0];
    tc.updatePositionPnl('p1', 250, '+$250.00', '+2.50%');
    expect(line.options().leftLabel).toBe('LONG 2  +$250.00');
    expect(h.lines()).toHaveLength(1); // same line, not recreated
  });

  it('syncState and readOnly (no close button)', () => {
    const h = fakeHost();
    const tc = new TradingController(h.host);
    tc.syncState({
      positions: [{ id: 'p1', side: 'long', entryPrice: 100, size: 1, readOnly: true }],
      trades: [{ id: 't1', side: 'buy', price: 100, size: 1, timestamp: 1700000000000 }],
    });
    expect(h.lines()[0].options().closeButton).toBe(false);
    expect(tc.getTrades()).toHaveLength(1);
  });
});
