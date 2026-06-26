// Trade-management tier (opt-in entry point: "openalgo-charts/trade").
// Phase 8: read-only order/position/bracket primitives + live P&L, reconciled
// from book snapshots. Phase 9 adds the place/modify/cancel write path.

export const TRADE_TIER = 'trade' as const;

export type { Order, Position, OrderSide, OrderType, OrderStatus, OrderRole } from './types';
export { isWorking } from './types';
export { unrealizedPnl, unrealizedPnlPercent, breakeven, riskReward, bracketValid } from './pnl';
export { WorkingOrderLine } from './order-line';
export { PositionMarker } from './position';
export { BracketGroup, type BracketState } from './bracket';
export { TradeController, type TradeHost } from './trade-controller';
export { FakeBroker } from './fake-broker';
