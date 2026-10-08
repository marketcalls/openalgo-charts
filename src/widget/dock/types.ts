/**
 * Terminal docking architecture types and interfaces.
 *
 * Implements a framework-free, zero-dependency hierarchical dock tree
 * supporting split panes, tab stacks, floating panels, drag-and-drop snap zones,
 * independent DOM ladder panels, link groups, and persistent workspace layouts.
 */

import type { StorageLike, AsyncStorageLike, WidgetStorageError } from '../context';
import type { MarketDepth } from '../../feed/types';
import type { TickSchedule } from '../../index';

export type PanelType =
  | 'chart'
  | 'dom'
  | 'watchlist'
  | 'orders'
  | 'positions'
  | 'news'
  | 'data'
  | 'objects'
  | 'custom';

export type DockDropPosition = 'left' | 'right' | 'top' | 'bottom' | 'center';

export type LinkColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple';

export interface TerminalPanelHandle {
  /** Clean up resources when the panel is permanently removed. */
  destroy(): void;
  /** Invoked when the panel host element size changes. */
  resize?(width: number, height: number): void;
  /** Focus active control inside the panel. */
  focus?(): void;
  /** Subscribe to title changes from within the panel (e.g. symbol change). */
  onTitleChange?(callback: (title: string) => void): void;
  /** Receive synchronized link context from workspace link hub. */
  onLinkUpdate?(ctx: LinkContext): void;
  /** Register callback to broadcast instrument changes to workspace link hub. */
  onLinkBroadcast?(callback: (ctx: { symbol: string; interval?: string | undefined; exchange?: string | undefined }) => void): void;
  /** Export panel specific state for serialization. */
  state?(): unknown;
  /** Restore panel specific state from serialized document. */
  restore?(state: unknown): void;
}

export type PanelHandle = TerminalPanelHandle;

export interface TerminalPanel {
  id: string;
  type: PanelType;
  title: string;
  minWidth?: number;
  minHeight?: number;
  linkGroup?: LinkColor | null;
  /** Mounts the panel into the host container and returns its handle. */
  mount(host: HTMLElement): PanelHandle;
  /** Receive synchronized link context directly. */
  onLinkUpdate?(ctx: LinkContext): void;
  /** Retrieve custom state for serialization. */
  state?(): unknown;
  /** Restore custom state from serialization. */
  restore?(state: unknown): void;
}

export interface DockSplitNode {
  type: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  children: DockNode[];
}

export interface DockTabsNode {
  type: 'tabs';
  id: string;
  active: string;
  panels: string[];
}

export interface DockPanelNode {
  type: 'panel';
  id: string;
  panelId: string;
}

export type DockNode = DockSplitNode | DockTabsNode | DockPanelNode;

export interface FloatingPanelState {
  id: string;
  panelId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

export interface LinkContext {
  group: LinkColor;
  symbol: string;
  exchange?: string | undefined;
  interval?: string | undefined;
}

export interface SerializedPanelInfo {
  type: PanelType;
  title: string;
  linkGroup?: LinkColor | null | undefined;
  state?: unknown;
}

export interface TerminalDocument {
  version: number;
  layout: DockNode | null;
  floating: FloatingPanelState[];
  panels: Record<string, SerializedPanelInfo>;
}

export interface TerminalPreset {
  id: string;
  name: string;
  description: string;
  build(): {
    layout: DockNode;
    panels: TerminalPanel[];
  };
}

export interface SnapHitResult {
  targetNodeId: string;
  position: DockDropPosition;
  rect: { left: number; top: number; width: number; height: number };
}

export interface TerminalOptions {
  storage?: StorageLike | AsyncStorageLike | null | undefined;
  storageKey?: string | undefined;
  persist?: boolean | string | undefined;
  defaultPreset?: string | undefined;
  /**
   * Recreate panel instances before applying a saved document on startup. Return nothing for a
   * saved panel this application no longer offers: it is dropped and the rest restore.
   */
  createPanel?(id: string, info: SerializedPanelInfo): TerminalPanel | null | undefined;
  /**
   * Called (once per frame) after every layout change -- dock, float, close, tab, split
   * ratio, link group -- whether or not the layout is persisted.
   */
  onLayoutChange?(doc: TerminalDocument): void;
  onStorageError?(failure: WidgetStorageError): void;
  onRestoreError?(reason: string): void;
  /** Validate bounded custom panel state before applying any part of a layout. */
  validatePanelState?(id: string, info: SerializedPanelInfo): boolean;
}

export interface TerminalWorkspace {
  readonly root: HTMLElement;
  /** Saved state has been read and applied, or reported unavailable. Never rejects. */
  readonly ready: Promise<void>;
  flush(): Promise<void>;
  clearSavedLayout(): Promise<void>;
  addPanel(panel: TerminalPanel, targetId?: string, position?: DockDropPosition): void;
  removePanel(panelId: string): void;
  floatPanel(panelId: string, bounds?: { x: number; y: number; width: number; height: number }): void;
  dockPanel(panelId: string, targetId: string, position: DockDropPosition): void;
  activateTab(tabId: string): void;
  getPanel(panelId: string): TerminalPanel | undefined;
  getLayout(): DockNode | null;
  setLayout(layout: DockNode): void;
  setPanelLinkGroup(panelId: string, group: LinkColor | null): void;
  broadcastLink(group: LinkColor, symbol: string, interval?: string, exchange?: string): void;
  loadPreset(presetName: string): boolean;
  saveLayout(): TerminalDocument;
  restoreLayout(doc: TerminalDocument): boolean;
  resetLayout(): void;
  resize(): void;
  destroy(): void;
}

export interface StandaloneDomOptions {
  id?: string | undefined;
  symbol: string;
  document?: Document | undefined;
  tickSize?: number | undefined;
  tickSchedule?: TickSchedule | null | undefined;
  groupBy?: number | undefined;
  linkGroup?: LinkColor | null | undefined;
  depth?: MarketDepth | null | undefined;
  onOrder?(side: 'buy' | 'sell', type: 'limit' | 'market', price: number, qty: number): void;
  onFlatten?(): void;
  onCancelAll?(): void;
}

export interface DomLadderRow {
  price: number;
  bidQty: number;
  askQty: number;
}
