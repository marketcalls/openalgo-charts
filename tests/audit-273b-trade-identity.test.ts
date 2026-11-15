/**
 * Action identity of two rows of one symbol (re-audit T1).
 *
 * The controller draws a delivery and an intraday position of INFY as two
 * markers since 2.7.3, but both close segments hit-tested as
 * `position:INFY::close` and both product brackets as `bracket-sl:INFY`, so a
 * host handed the id could not tell which row to close or modify, and
 * `BracketState` carried no exchange or product to tell it. A symbol drawn
 * with one row keeps the id hosts parse today; only rows that share a symbol
 * carry the row key, and `positionOf` returns the row an id names. `onLtp`
 * took a symbol alone, so an NSE tick moved a BSE row's P&L.
 */
import { describe, expect, it } from 'vitest';
import { darkTheme } from '../src/theme';
import { TradeController } from '../src/trade/trade-controller';
import { PositionMarker } from '../src/trade/position';
import { BracketGroup } from '../src/trade/bracket';
import type { WorkingOrderLine } from '../src/trade/order-line';
import type { Order, Position } from '../src/trade/types';
import type { IPrimitive, PrimitiveRenderContext } from '../src/primitives/primitive';
import { PriceScale } from '../src/scale/price-scale';
import { TimeScale } from '../src/scale/time-scale';
import { DataLayer } from '../src/model/data-layer';
import { makeCtx } from './helpers/fake-ctx';

const INFY = { symbol: 'INFY', exchange: 'NSE' };
const position = (product: string, avgPrice: number, extra: Partial<Position> = {}): Position =>
  ({ ...INFY, product, netQty: 10, avgPrice, ...extra });
const leg = (id: string, product: string, role: 'sl' | 'tp', price: number): Order => ({ id, ...INFY, product,
  side: 'SELL', type: role === 'sl' ? 'SL-M' : 'LIMIT', qty: 10, filledQty: 0, price, status: 'working', role,
  ...(role === 'sl' ? { triggerPrice: price } : {}) });

class Host {
  public live: IPrimitive[] = [];
  public addPrimitive(p: IPrimitive): void { this.live.push(p); }
  public removePrimitive(p: IPrimitive): void { this.live = this.live.filter((q) => q !== p); }
  public markers(): PositionMarker[] { return this.live.filter((p): p is PositionMarker => p instanceof PositionMarker); }
  public brackets(): BracketGroup[] { return this.live.filter((p): p is BracketGroup => p instanceof BracketGroup); }
}

function rc(): PrimitiveRenderContext {
  const priceScale = new PriceScale();
  priceScale.setHeight(400);
  priceScale.setPriceRange({ min: 80, max: 120 });
  const timeScale = new TimeScale();
  timeScale.setWidth(900);
  return { timeScale, priceScale, dataLayer: new DataLayer(), plotWidth: 900, plotHeight: 400, priceAxisWidth: 56, dpr: 1, theme: darkTheme };
}

/** The id a click on the marker's close segment, found by scanning its line, would carry. */
function closeHit(marker: PositionMarker, r: PrimitiveRenderContext): string {
  marker.draw(makeCtx().ctx, r);
  const y = r.priceScale.priceToY(marker.position.avgPrice);
  for (let x = 0; x <= r.plotWidth; x++) {
    const id = marker.hitTest(x, y, r)?.externalId;
    if (id?.endsWith('::close')) return id;
  }
  throw new Error('no close segment');
}

const stopHit = (b: BracketGroup, r: PrimitiveRenderContext): string =>
  b.hitTest(200, r.priceScale.priceToY(b.state.stop), r)!.externalId;
const targetHit = (b: BracketGroup, r: PrimitiveRenderContext): string =>
  b.hitTest(200, r.priceScale.priceToY(b.state.target), r)!.externalId;

describe('position hit ids', () => {
  it('keep the plain symbol id for the one row of a symbol', () => {
    const host = new Host(), tc = new TradeController(host), r = rc();
    tc.reconcile([], [position('MIS', 100)], INFY);
    expect(closeHit(host.markers()[0]!, r)).toBe('position:INFY::close');
    expect(tc.positionOf('position:INFY::close')).toMatchObject({ product: 'MIS' });
    expect(tc.positionOf('position:INFY')).toMatchObject({ product: 'MIS' });
  });

  it('name each row once two rows share the symbol, and positionOf returns that row', () => {
    const host = new Host(), tc = new TradeController(host), r = rc();
    tc.reconcile([], [position('CNC', 100), position('MIS', 105)], INFY);
    const ids = host.markers().map((m) => closeHit(m, r));
    expect(new Set(ids).size).toBe(2);
    // An id a host parses as `position:<symbol>` today no longer matches either
    // row, so such a host finds nothing to close rather than the wrong product.
    expect(ids).not.toContain('position:INFY::close');
    expect(ids.map((id) => tc.positionOf(id)?.product)).toEqual(['CNC', 'MIS']);
    expect(tc.positionOf('position:INFY::close')).toBeUndefined();
  });

  it('return to the plain id when the other row closes', () => {
    const host = new Host(), tc = new TradeController(host), r = rc();
    tc.reconcile([], [position('CNC', 100), position('MIS', 105)], INFY);
    tc.reconcile([], [position('CNC', 100), position('MIS', 105, { netQty: 0 })], INFY);
    expect(host.markers()).toHaveLength(1);
    expect(closeHit(host.markers()[0]!, r)).toBe('position:INFY::close');
    expect(tc.positionOf('position:INFY::close')).toMatchObject({ product: 'CNC' });
  });

  it('are unchanged on a marker built directly', () => {
    const marker = new PositionMarker(position('MIS', 100));
    expect(closeHit(marker, rc())).toBe('position:INFY::close');
  });
});

describe('bracket hit ids and state', () => {
  it('carry the exchange and product of the position they protect', () => {
    const host = new Host(), tc = new TradeController(host), r = rc();
    tc.reconcile([leg('s', 'MIS', 'sl', 95), leg('t', 'MIS', 'tp', 110)], [position('MIS', 100)], INFY);
    const [bracket] = host.brackets();
    expect(bracket!.state).toMatchObject({ symbol: 'INFY', exchange: 'NSE', product: 'MIS' });
    expect([stopHit(bracket!, r), targetHit(bracket!, r)]).toEqual(['bracket-sl:INFY', 'bracket-tp:INFY']);
    expect(tc.positionOf('bracket-sl:INFY')).toMatchObject({ product: 'MIS' });
  });

  it('name each product once two positions share the symbol', () => {
    const host = new Host(), tc = new TradeController(host), r = rc();
    tc.reconcile([
      leg('cs', 'CNC', 'sl', 90), leg('ct', 'CNC', 'tp', 110),
      leg('ms', 'MIS', 'sl', 95), leg('mt', 'MIS', 'tp', 115),
    ], [position('CNC', 100), position('MIS', 105)], INFY);
    const brackets = host.brackets();
    const stops = brackets.map((b) => stopHit(b, r));
    expect(new Set(stops).size).toBe(2);
    expect(stops).not.toContain('bracket-sl:INFY');
    expect(stops.map((id) => tc.positionOf(id)?.product)).toEqual(['CNC', 'MIS']);
    expect(brackets.map((b) => tc.positionOf(targetHit(b, r))?.product)).toEqual(['CNC', 'MIS']);
    expect(brackets.map((b) => b.state.product)).toEqual(['CNC', 'MIS']);
  });

  it('are unchanged on a bracket built directly', () => {
    const r = rc();
    const b = new BracketGroup({ symbol: 'INFY', side: 'BUY', entry: 100, stop: 95, target: 110 });
    expect([stopHit(b, r), targetHit(b, r)]).toEqual(['bracket-sl:INFY', 'bracket-tp:INFY']);
  });
});

describe('onLtp can name the exchange', () => {
  function priced(): { tc: TradeController; ltps: () => [string | undefined, number][] } {
    const host = new Host(), tc = new TradeController(host);
    tc.reconcile([{ id: 'o', symbol: 'INFY', exchange: 'BSE', side: 'BUY', type: 'LIMIT', qty: 1, filledQty: 0,
      price: 100, status: 'working' }], [position('MIS', 100), position('CNC', 100, { exchange: 'BSE' })]);
    const seen = new Map<IPrimitive, number>();
    for (const p of host.live) {
      const set = (p as PositionMarker | WorkingOrderLine).setLtp.bind(p);
      (p as PositionMarker).setLtp = (ltp: number): void => { seen.set(p, ltp); set(ltp); };
    }
    const ltps = (): [string | undefined, number][] => host.live.map((p) =>
      [p instanceof PositionMarker ? p.position.exchange : (p as WorkingOrderLine).order.exchange, seen.get(p) ?? NaN]);
    return { tc, ltps };
  }

  it('updates only that exchange when it is named', () => {
    const { tc, ltps } = priced();
    tc.onLtp('INFY', 107, 'NSE');
    expect(ltps()).toEqual([['BSE', NaN], ['NSE', 107], ['BSE', NaN]]);
  });

  it('updates every row of the symbol when it is not, as before', () => {
    const { tc, ltps } = priced();
    tc.onLtp('INFY', 107);
    expect(ltps()).toEqual([['BSE', 107], ['NSE', 107], ['BSE', 107]]);
  });

  it('gives a row drawn later the price of its own exchange', () => {
    const host = new Host(), tc = new TradeController(host);
    tc.onLtp('INFY', 99, 'BSE');
    tc.onLtp('INFY', 107, 'NSE');
    tc.reconcile([], [position('MIS', 100, { exchange: 'BSE' })]);
    const r = rc();
    const { ctx, rec } = makeCtx();
    host.markers()[0]!.draw(ctx, r);
    // Long 10 from 100 at the BSE price 99 is -10.00, not +70.00 from the NSE tick.
    expect(JSON.stringify(rec.ops)).toContain('-10.00');
  });
});
