/** Trading forms stay separate even from the optional docking tools. */
import type * as TradingPanels from './trading-panels';

export function loadTradingPanels(): Promise<typeof TradingPanels> {
  return import('./trading-panels');
}
