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
export {
  OrderEngine,
  type OrderEngineOptions,
  type OrderFeed,
  type PlaceRequest,
  type PlaceResult,
  type TradeMode,
  type GateFn,
} from './order-engine';
export {
  transition,
  canTransition,
  isTerminal,
  type ClientOrderState,
  type OrderEvent,
} from './order-state-machine';
export { validateOrder, withinPriceBand, type OrderConstraints, type PriceBand, type ValidationResult } from './validation';
export {
  DomLadder,
  ladderCapability,
  buildRows,
  visibleRows,
  DEFAULT_DOM_LADDER_OPTIONS,
  type LadderTier,
  type LadderRow,
  type DomLadderOptions,
} from './dom-ladder';
