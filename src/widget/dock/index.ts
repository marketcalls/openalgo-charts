/**
 * Terminal docking architecture and standalone DOM.
 *
 * Provides a framework-free, zero-dependency professional trading terminal
 * workspace with hierarchical split panes, tab stacks, floating windows,
 * spatial snap zones, color link groups, and independent DOM ladders.
 */

export { createTerminalWorkspace, TerminalDockController } from './controller';
export { StandaloneDomLadder, createStandaloneDomPanel, buildDomRows, ladderCapability, type StandaloneDomPanel } from './dom-panel';
export { createChartPanel, createSimpleDockPanel, type ChartPanelOptions, type SimplePanelOptions } from './panel-adapters';
export { loadTradingPanels } from './trading-loader';
export { TERMINAL_PRESETS } from './presets';
export { TERMINAL_STORAGE_KEY, loadTerminalDocument, saveTerminalDocument } from './persist';
export { parseTerminalDocument } from './validate-document';
export { TERMINAL_CSS, injectTerminalStyles } from './styles';
export { LinkHub, LINK_COLORS } from './link-hub';
export {
  cloneNode,
  collectPanelIds,
  findNodeById,
  findNodeContainingPanel,
  generateNodeId,
  insertPanel,
  movePanel,
  removePanel,
  validateAndSanitizeTree,
} from './model';

export type {
  DockDropPosition,
  DockNode,
  DockPanelNode,
  DockSplitNode,
  DockTabsNode,
  FloatingPanelState,
  LinkColor,
  LinkContext,
  PanelHandle,
  TerminalPanelHandle,
  PanelType,
  SnapHitResult,
  StandaloneDomOptions,
  DomLadderRow,
  TerminalDocument,
  SerializedPanelInfo,
  TerminalOptions,
  TerminalPanel,
  TerminalPreset,
  TerminalWorkspace,
} from './types';
