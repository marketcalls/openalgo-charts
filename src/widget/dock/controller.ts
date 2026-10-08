/**
 * Terminal Workspace Dock Controller.
 *
 * Coordinates the hierarchical dock tree, split pane dividers, tab stacks,
 * floating windows, drag-and-drop snap previews, link groups, and persistence.
 */

import { releasePanel } from '../panel-lifetime';
import { TerminalStorage } from './storage';
import { parseTerminalDocument } from './validate-document';
import { PanelDragSession } from './drag-session';
import { FrameTask } from './frame-task';
import { FloatingPanelWindow } from './floating';
import { calculateSnapTarget, type PaneRectInfo } from './hit-zones';
import { LinkHub } from './link-hub';
import {
  findNodeContainingPanel,
  collectPanelIds,
  generateNodeId,
  insertPanel,
  movePanel,
  removePanel,
} from './model';
import {
  buildDocumentFromWorkspace,
  TERMINAL_STORAGE_KEY,
} from './persist';
import { TERMINAL_PRESETS } from './presets';
import { DockPreviewOverlay } from './preview';
import { DockSplitter } from './splitter';
import { injectTerminalStyles } from './styles';
import type {
  DockDropPosition,
  DockNode,
  DockPanelNode,
  DockSplitNode,
  DockTabsNode,
  LinkColor,
  PanelHandle,
  TerminalDocument,
  TerminalOptions,
  TerminalPanel,
  TerminalWorkspace,
} from './types';

/** One tab: the chrome item (drag, badge, close) and the `role="tab"` label inside it. */
interface TabElements { item: HTMLElement; tab: HTMLElement }

let nextTabsViewId = 0;

/** Selection state of a tab, mirrored on the tab panel that it labels. */
function selectTab({ item, tab }: TabElements, selected: boolean, body: HTMLElement): void {
  item.classList.toggle('is-active', selected);
  tab.setAttribute('aria-selected', String(selected));
  tab.setAttribute('tabindex', selected ? '0' : '-1');
  if (selected) body.setAttribute('aria-labelledby', tab.id);
}

export class TerminalDockController implements TerminalWorkspace {
  private readonly _doc: Document;
  private readonly _root: HTMLElement;
  private readonly _treeContainer: HTMLElement;
  private readonly _opts: TerminalOptions;
  private readonly _storage: TerminalStorage;
  private readonly _storageKey: string;
  private readonly _linkHub = new LinkHub();
  private readonly _preview: DockPreviewOverlay;

  private _layout: DockNode | null = null;
  private readonly _panels = new Map<string, TerminalPanel>();
  private readonly _mountedHandles = new Map<string, PanelHandle>();
  private readonly _panelHosts = new Map<string, HTMLElement>();
  private readonly _floatingWindows = new Map<string, FloatingPanelWindow>();
  private readonly _splitters: DockSplitter[] = [];

  private _topZIndex = 100;
  private _resizeObserver: ResizeObserver | null = null;
  private _destroyed = false;
  private _restoring = false;
  private _pendingDocument: TerminalDocument | null = null;
  private _reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _pendingPanelStates = new Map<string, unknown>();
  private _applyingLink = false;
  private readonly _resizeFrame: FrameTask;
  private readonly _resizeQueue = new Map<string, { width: number; height: number } | null>();
  private readonly _lastSizes = new Map<string, { width: number; height: number }>();
  private readonly _tabViews = new Map<string, { body: HTMLElement; tabs: Map<string, TabElements> }>();
  readonly ready: Promise<void>;
  private _loading = false;
  private _changedWhileLoading = false;
  private _invalidSaved = false;
  private readonly _saveFrame: FrameTask;
  private readonly _pageHide = () => { void this.flush(); };
  private readonly _visibility = () => { if (this._doc.hidden) void this.flush(); };

  constructor(container: HTMLElement | string, options: TerminalOptions = {}) {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) {
      throw new Error(`Terminal container element was not found.`);
    }

    const doc = el.ownerDocument ?? (typeof document !== 'undefined' ? document : (globalThis as unknown as { document: Document }).document);
    this._doc = doc;
    this._resizeFrame = new FrameTask(doc, () => this.flushPanelResizes());
    this._saveFrame = new FrameTask(doc, () => this.writeState());

    injectTerminalStyles(this._doc);

    this._root = el;
    this._root.classList.add('oac-terminal');

    this._treeContainer = this._doc.createElement('div');
    this._treeContainer.className = 'oac-dock-tree';
    this._root.appendChild(this._treeContainer);

    this._preview = new DockPreviewOverlay(this._root);

    this._opts = options;
    this._storageKey = typeof options.persist === 'string'
      ? options.persist
      : (options.storageKey ?? TERMINAL_STORAGE_KEY);
    this._storage = new TerminalStorage(this._storageKey, options.storage, !!options.persist, options.onStorageError);

    this.setupResizeObserver();

    const restore = () => {
      try {
        if (this._destroyed) return;
        this._loading = false;
        if (this._changedWhileLoading) { this.saveState(); return; }
        const raw = this._opts.persist ? this._storage.get() : null;
        const savedDoc = raw === null ? null : this.validDocument(raw);
        if (raw !== null && !savedDoc) { this._invalidSaved = true; this.reportRestoreError('Invalid terminal workspace document'); }
        if (savedDoc) {
          this._pendingDocument = savedDoc;
          if (!Object.keys(savedDoc.panels).length) { this._pendingDocument = null; this.restoreLayout(savedDoc); return; }
          if (options.createPanel) {
            const panels: TerminalPanel[] = [];
            for (const [id, info] of Object.entries(savedDoc.panels)) {
              // A factory returns nothing for a panel this build no longer offers; the rest restore.
              const panel = options.createPanel(id, info);
              if (!panel) continue;
              if (panel.id !== id || panel.type !== info.type) throw new Error('Panel factory returned a different identity');
              panels.push(panel);
            }
            const created = new Set(panels.map(panel => panel.id));
            const available = created.size === Object.keys(savedDoc.panels).length
              ? savedDoc : pruneDocument(savedDoc, id => created.has(id));
            this._pendingDocument = available;
            if (!panels.length) { this._pendingDocument = null; this.restoreLayout(available); }
            else for (const panel of panels) this.addPanel(panel);
          }
        }
      } catch (error) {
        this._loading = false; this._pendingDocument = null; this._invalidSaved = true;
        this.reportRestoreError(String(error));
      }
    };
    this._loading = !this._storage.shared.loaded;
    if (this._loading) this.ready = this._storage.shared.load().then(restore).catch(error => {
      this._loading = false; this._pendingDocument = null; this.reportRestoreError(String(error));
    });
    else { restore(); this.ready = Promise.resolve(); }
    this._doc.defaultView?.addEventListener?.('pagehide', this._pageHide);
    this._doc.addEventListener('visibilitychange', this._visibility);
  }

  get root(): HTMLElement {
    return this._root;
  }

  private setupResizeObserver(): void {
    if (typeof ResizeObserver === 'undefined') return;

    this._resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (entry.target === this._root) {
          this.notifyAllPanelResizes();
        } else {
          const panelId = (entry.target as HTMLElement).dataset.panelId;
          if (panelId && width > 0 && height > 0) {
            this._resizeQueue.set(panelId, { width, height });
            this._resizeFrame.schedule();
          }
        }
      }
    });

    this._resizeObserver.observe(this._root);
  }

  public addPanel(panel: TerminalPanel, targetId?: string, position?: DockDropPosition): void {
    if (this._destroyed) return;
    this._panels.set(panel.id, panel);

    {
      const savedDoc = this._pendingDocument;
      if (savedDoc?.panels?.[panel.id]) {
        const info = savedDoc.panels[panel.id]!;
        if (info.linkGroup !== undefined) {
          panel.linkGroup = info.linkGroup;
        }
      }
    }

    if (panel.linkGroup) {
      this._linkHub.setPanelGroup(panel.id, panel.linkGroup);
    }

    if (this._pendingDocument) {
      const doc = this._pendingDocument;
      this.cancelReconcile();
      if (Object.keys(doc.panels).every(id => this._panels.has(id))) {
        this._pendingDocument = null;
        this.applyRestored(doc, false);
      } else {
        // A saved panel the application never registers again would hold the restore (and every
        // later addPanel) forever: once the current task's registrations are done, restore
        // what is registered and drop the rest.
        this._reconcileTimer = setTimeout(() => { this._reconcileTimer = null; this.reconcilePending(); }, 0);
      }
      return;
    }

    if (!this._layout) {
      this._layout = {
        type: 'panel',
        id: generateNodeId('panel'),
        panelId: panel.id,
      };
    } else {
      const tgt = targetId ?? (this._layout.id);
      const pos = position ?? 'right';
      this._layout = insertPanel(this._layout, panel.id, tgt, pos);
    }

    this.render();
    this.saveState();
  }

  private cancelReconcile(): void {
    if (this._reconcileTimer !== null) clearTimeout(this._reconcileTimer);
    this._reconcileTimer = null;
  }

  /** Restore the saved panels that are registered; the saved IDs nobody registered are dropped. */
  private reconcilePending(): void {
    const doc = this._pendingDocument;
    if (!doc || this._destroyed) return;
    const missing = Object.keys(doc.panels).filter(id => !this._panels.has(id));
    // Nothing registered yet: the next addPanel tries again.
    if (missing.length === Object.keys(doc.panels).length) return;
    this._pendingDocument = null;
    this.reportRestoreError(`Saved panels are not registered and were dropped: ${missing.join(', ')}`);
    this.applyRestored(pruneDocument(doc, id => this._panels.has(id)), true);
  }

  /**
   * Apply a saved document whose panels are all registered, then place any panel registered
   * meanwhile that the document does not mention (or every panel, if the document is refused).
   */
  private applyRestored(doc: TerminalDocument, changed: boolean): void {
    const restored = this.restoreLayout(doc);
    if (!restored) {
      // Like an invalid document: the stored one stays untouched until explicitly cleared.
      this._invalidSaved = true;
      this.reportRestoreError('Saved terminal layout does not match the registered panels');
    }
    const placed = new Set([
      ...(this._layout ? collectPanelIds(this._layout) : []),
      ...this._floatingWindows.keys(),
    ]);
    let added = false;
    for (const id of this._panels.keys()) {
      if (placed.has(id)) continue;
      this._layout = this._layout ? insertPanel(this._layout, id, this._layout.id, 'right')
        : { type: 'panel', id: generateNodeId('panel'), panelId: id };
      added = true;
    }
    if (added) this.render();
    if (added || changed) this.saveState();
  }

  public removePanel(panelId: string): void {
    if (this._destroyed) return;

    // Check if floating
    const floatWin = this._floatingWindows.get(panelId);
    if (floatWin) {
      floatWin.destroy();
      this._floatingWindows.delete(panelId);
    }

    if (this._layout) {
      this._layout = removePanel(this._layout, panelId);
    }

    const handle = this._mountedHandles.get(panelId);
    if (handle) {
      releasePanel(handle);
      this._mountedHandles.delete(panelId);
    }

    const host = this._panelHosts.get(panelId);
    if (host) {
      this._resizeObserver?.unobserve(host);
      host.remove();
      this._panelHosts.delete(panelId);
    }

    this._linkHub.unregisterListener(panelId);
    this._panels.delete(panelId);
    this._lastSizes.delete(panelId);
    this._resizeQueue.delete(panelId);

    this.render();
    this.saveState();
  }

  public floatPanel(
    panelId: string,
    bounds?: { x: number; y: number; width: number; height: number; zIndex?: number | undefined } | undefined
  ): void {
    const panel = this._panels.get(panelId);
    if (!panel) return;

    if (this._floatingWindows.has(panelId)) return;

    if (this._layout) {
      this._layout = removePanel(this._layout, panelId);
      this.render();
    }

    const host = this.getOrCreatePanelHost(panel);

    const win = new FloatingPanelWindow({
      panel,
      initialBounds: bounds,
      container: this._root,
      linkHub: this._linkHub,
      onLinkGroupChange: (id, group) => this.setPanelLinkGroup(id, group ?? null),
      onDock: (pId) => {
        this.dockFloatingPanel(pId);
      },
      onClose: (pId) => {
        this.removePanel(pId);
      },
      onActivate: (pId) => {
        const target = this._floatingWindows.get(pId);
        if (target && target.state.zIndex < this._topZIndex) target.bringToFront(++this._topZIndex);
      },
      onBoundsChange: () => {
        this.saveState();
      },
      onDragMove: (cx, cy) => {
        const hit = this.findDropHit(cx, cy);
        if (hit) this._preview.show(hit.rect);
        else this._preview.hide();
      },
      onDragEnd: (cx, cy) => {
        this._preview.hide();
        const hit = this.findDropHit(cx, cy);
        if (hit) {
          this.dockPanel(panelId, hit.targetNodeId, hit.position);
        }
      },
    });

    win.bodyElement.appendChild(host);
    this._floatingWindows.set(panelId, win);
    const z = bounds?.zIndex ?? ++this._topZIndex;
    this._topZIndex = Math.max(this._topZIndex, z);
    win.bringToFront(z);

    this.saveState();
  }

  private dockFloatingPanel(panelId: string): void {
    const floatWin = this._floatingWindows.get(panelId);
    if (!floatWin) return;

    floatWin.destroy();
    this._floatingWindows.delete(panelId);

    if (!this._layout) {
      this._layout = {
        type: 'panel',
        id: generateNodeId('panel'),
        panelId,
      };
    } else {
      this._layout = insertPanel(this._layout, panelId, this._layout.id, 'right');
    }

    this.render();
    this.saveState();
  }

  public dockPanel(panelId: string, targetId: string, position: DockDropPosition): void {
    const floatWin = this._floatingWindows.get(panelId);
    if (floatWin) {
      floatWin.destroy();
      this._floatingWindows.delete(panelId);
    }

    if (!this._layout) {
      this._layout = {
        type: 'panel',
        id: generateNodeId('panel'),
        panelId,
      };
    } else {
      this._layout = movePanel(this._layout, panelId, targetId, position);
    }

    this.render();
    this.saveState();
  }

  public activateTab(panelId: string): void {
    if (!this._layout) return;
    const node = findNodeContainingPanel(this._layout, panelId);
    if (node && node.type === 'tabs') {
      if (node.active === panelId) return;
      node.active = panelId;
      const view = this._tabViews.get(node.id), panel = this._panels.get(panelId);
      if (view && panel) {
        for (const [id, tab] of view.tabs) selectTab(tab, id === panelId, view.body);
        while (view.body.firstChild) view.body.removeChild(view.body.firstChild);
        view.body.appendChild(this.getOrCreatePanelHost(panel));
        if (panel.type === 'dom') this._lastSizes.delete(panelId);
        this.queuePanelResizes([panelId]);
      } else this.render();
      this.saveState();
    }
  }

  public getPanel(panelId: string): TerminalPanel | undefined {
    return this._panels.get(panelId);
  }

  public getLayout(): DockNode | null {
    return this._layout;
  }

  public setLayout(layout: DockNode): void {
    const candidate = this.saveLayout(); candidate.layout = layout;
    const valid = this.validDocument(candidate); if (!valid) return;
    this._layout = valid.layout;
    this.render();
    this.saveState();
  }

  public setPanelLinkGroup(panelId: string, group: LinkColor | null): void {
    const panel = this._panels.get(panelId);
    if (panel) {
      panel.linkGroup = group;
      this._linkHub.setPanelGroup(panelId, group);
      for (const badge of this._root.querySelectorAll<HTMLElement>('.oac-dock-link-badge')) {
        if (badge.dataset.panelId === panelId) this._linkHub.updateLinkBadge(badge, group);
      }
      this.saveState();
    }
  }

  public getPanelLinkGroup(panelId: string): LinkColor | null {
    return this._linkHub.getPanelGroup(panelId) ?? this._panels.get(panelId)?.linkGroup ?? null;
  }

  public broadcastLink(
    group: LinkColor,
    symbol: string,
    interval?: string | undefined,
    exchange?: string | undefined,
    senderPanelId?: string
  ): void {
    this._linkHub.broadcast(group, symbol, interval, senderPanelId, exchange);
  }

  public loadPreset(presetName: string): boolean {
    // Own keys only: an inherited name such as `toString` is not a preset.
    if (!Object.prototype.hasOwnProperty.call(TERMINAL_PRESETS, presetName)) return false;
    const preset = TERMINAL_PRESETS[presetName];
    if (!preset) return false;

    // Pick panel IDs
    const panelList = Array.from(this._panels.values());
    if (panelList.length === 0) return false;

    const chartPanels = panelList.filter((p) => p.type === 'chart');
    const domPanels = panelList.filter((p) => p.type === 'dom');
    const watchlistPanels = panelList.filter((p) => p.type === 'watchlist');
    const newsPanels = panelList.filter((p) => p.type === 'news');

    if (!chartPanels[0]) return false;

    const newLayout = preset.buildLayout({
      chart1: chartPanels[0].id,
      chart2: chartPanels[1]?.id,
      chart3: chartPanels[2]?.id,
      chart4: chartPanels[3]?.id,
      dom: domPanels[0]?.id,
      watchlist: watchlistPanels[0]?.id,
      news: newsPanels[0]?.id,
    });

    const ids = collectPanelIds(newLayout);
    if (new Set(ids).size !== ids.length || ids.some(id => !this._panels.has(id))) return false;

    this.setLayout(newLayout);
    return true;
  }

  public saveLayout(): TerminalDocument {
    const floatingStates = Array.from(this._floatingWindows.values()).map((w) => w.state);
    const doc = buildDocumentFromWorkspace(this._layout, floatingStates, this._panels);
    for (const [id, state] of this._pendingPanelStates) {
      if (doc.panels[id]) doc.panels[id]!.state = state;
    }
    for (const [id, handle] of this._mountedHandles.entries()) {
      const hState = handle.state?.();
      if (hState !== undefined && doc.panels[id]) {
        doc.panels[id]!.state = hState;
      }
    }
    return doc;
  }

  public restoreLayout(doc: TerminalDocument): boolean {
    const valid = this.validDocument(doc);
    if (!valid || Object.entries(valid.panels).some(([id, info]) => this._panels.get(id)?.type !== info.type)) return false;
    doc = valid;
    this._restoring = true;
    try {

      if (doc.panels) {
        for (const [id, info] of Object.entries(doc.panels)) {
          const existing = this._panels.get(id);
          if (existing) {
            if (info.linkGroup !== undefined) {
              existing.linkGroup = info.linkGroup;
              this._linkHub.setPanelGroup(id, info.linkGroup);
            }
            if (info.state !== undefined) {
              const handle = this._mountedHandles.get(id);
              if (handle?.restore) handle.restore(info.state);
              else if (handle) existing.restore?.(info.state);
              else this._pendingPanelStates.set(id, info.state);
            }
          }
        }
      }

      for (const win of this._floatingWindows.values()) {
        win.destroy();
      }
      this._floatingWindows.clear();

      this._layout = doc.layout ?? null;
      this.render();

      if (Array.isArray(doc.floating)) {
        for (const f of doc.floating) {
          if (this._panels.has(f.panelId)) {
            this.floatPanel(f.panelId, {
              x: f.x,
              y: f.y,
              width: f.width,
              height: f.height,
              zIndex: f.zIndex,
            });
          }
        }
      }

      return true;
    } finally {
      this._restoring = false;
    }
  }

  public resetLayout(): void {
    if (this._opts.defaultPreset) {
      this.loadPreset(this._opts.defaultPreset);
    } else {
      const ids = Array.from(this._panels.keys());
      if (ids.length > 0) {
        this._layout = {
          type: 'panel',
          id: generateNodeId('panel'),
          panelId: ids[0]!,
        };
        for (let i = 1; i < ids.length; i++) {
          this._layout = insertPanel(this._layout, ids[i]!, this._layout.id, 'right');
        }
      } else {
        this._layout = null;
      }
      this.render();
      this.saveState();
    }
  }

  public resize(): void {
    this.notifyAllPanelResizes();
  }

  private notifyAllPanelResizes(): void {
    this.queuePanelResizes(this._panelHosts.keys());
  }

  private queuePanelResizes(ids: Iterable<string>): void {
    for (const id of ids) if (!this._resizeQueue.has(id)) this._resizeQueue.set(id, null);
    this._resizeFrame.schedule();
  }

  private flushPanelResizes(): void {
    if (this._destroyed) return;
    const measured: { panelId: string; width: number; height: number }[] = [];
    for (const [panelId, observed] of this._resizeQueue) {
      const host = this._panelHosts.get(panelId);
      if (!host) continue;
      const width = observed?.width ?? host.clientWidth, height = observed?.height ?? host.clientHeight;
      const previous = this._lastSizes.get(panelId);
      if (width > 0 && height > 0 && (!previous || previous.width !== width || previous.height !== height)) {
        measured.push({ panelId, width, height });
      }
    }
    this._resizeQueue.clear();
    // Complete reads before chart resize callbacks write canvas dimensions.
    for (const { panelId, width, height } of measured) {
      const handle = this._mountedHandles.get(panelId);
      this._lastSizes.set(panelId, { width, height });
      handle?.resize?.(width, height);
    }
  }

  private saveState(): void {
    if (this._loading && !this._restoring) this._changedWhileLoading = true;
    // Scheduled for a listener as well as for storage: onLayoutChange is how a host that keeps
    // its own layout state learns of user edits (a closed panel, a dragged splitter).
    const wanted = !!this._opts.persist || !!this._opts.onLayoutChange;
    if (wanted && !this._loading && !this._restoring && !this._pendingDocument && !this._invalidSaved) this._saveFrame.schedule();
  }

  private reportRestoreError(reason: string): void {
    try { this._opts.onRestoreError?.(reason); } catch { /* Reporting cannot reject readiness. */ }
  }

  private validDocument(raw: unknown): TerminalDocument | null {
    const doc = parseTerminalDocument(raw);
    if (!doc) return null;
    try {
      if (this._opts.validatePanelState && Object.entries(doc.panels).some(([id, info]) => !this._opts.validatePanelState!(id, info))) return null;
    } catch { return null; }
    return doc;
  }

  private writeState(): void {
    const doc = this.validDocument(this.saveLayout());
    if (!doc) { this.reportRestoreError('Invalid terminal panel state'); return; }
    if (this._opts.persist) this._storage.set(doc);
    this._opts.onLayoutChange?.(doc);
  }

  public async flush(): Promise<void> { this._saveFrame.flush(); await this._storage.shared.flush(); }

  public async clearSavedLayout(): Promise<void> {
    this._saveFrame.cancel(); this._invalidSaved = false; this._storage.clear(); await this._storage.shared.flush();
  }

  public render(): void {
    this.clearSplitters();
    this._tabViews.clear();
    this._treeContainer.innerHTML = '';

    if (!this._layout) {
      const empty = this._doc.createElement('div');
      empty.className = 'oac-dom-empty';
      empty.textContent = 'Workspace is empty. Add a panel to begin.';
      this._treeContainer.appendChild(empty);
      return;
    }

    const rootDom = this.renderNode(this._layout);
    if (rootDom) {
      this._treeContainer.appendChild(rootDom);
    }

    // Measure and notify panels
    // Reparenting can reset a ladder's scroll offset without changing its size.
    for (const panel of this._panels.values()) if (panel.type === 'dom') this._lastSizes.delete(panel.id);
    this.notifyAllPanelResizes();
  }

  private clearSplitters(): void {
    for (const splitter of this._splitters) {
      splitter.destroy();
    }
    this._splitters.length = 0;
  }

  private renderNode(node: DockNode): HTMLElement | null {
    if (node.type === 'panel') {
      return this.renderPanelNode(node);
    }
    if (node.type === 'tabs') {
      return this.renderTabsNode(node);
    }
    if (node.type === 'split') {
      return this.renderSplitNode(node);
    }
    return null;
  }

  private renderPanelNode(node: DockPanelNode): HTMLElement {
    const panel = this._panels.get(node.panelId);
    const container = this._doc.createElement('div');
    container.className = 'oac-dock-panel';
    container.dataset.nodeId = node.id;
    container.dataset.panelId = node.panelId;

    if (!panel) {
      const empty = this._doc.createElement('div');
      empty.className = 'oac-dom-empty';
      empty.textContent = `Panel not found (${node.panelId})`;
      container.appendChild(empty);
      return container;
    }

    // Header
    const header = this._doc.createElement('div');
    header.className = 'oac-dock-panel-header';

    const titleArea = this._doc.createElement('div');
    titleArea.className = 'oac-dock-panel-title-area';

    const linkBadge = this._linkHub.renderLinkBadge(
      panel.id,
      panel.linkGroup ?? null,
      (newGroup) => {
        this.setPanelLinkGroup(panel.id, newGroup);
      },
      this._doc
    );

    const title = this._doc.createElement('span');
    title.className = 'oac-dock-title-text';
    title.textContent = panel.title;

    titleArea.append(linkBadge, title);

    const actions = this._doc.createElement('div');
    actions.className = 'oac-dock-panel-actions';

    const floatBtn = this._doc.createElement('button');
    floatBtn.type = 'button';
    floatBtn.className = 'oac-dock-btn oac-dock-btn--float';
    floatBtn.title = 'Detach into floating window';
    floatBtn.textContent = '^';
    floatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.floatPanel(panel.id);
    });

    const closeBtn = this._doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'oac-dock-btn oac-dock-btn--close';
    closeBtn.title = 'Close panel';
    closeBtn.textContent = 'x';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.removePanel(panel.id);
    });

    actions.append(floatBtn, closeBtn);
    header.append(titleArea, actions);

    // Body
    const body = this._doc.createElement('div');
    body.className = 'oac-dock-panel-body';

    const host = this.getOrCreatePanelHost(panel);
    body.appendChild(host);

    container.append(header, body);

    this.bindHeaderDrag(header, panel.id, panel.title);

    return container;
  }

  private renderTabsNode(node: DockTabsNode): HTMLElement {
    const container = this._doc.createElement('div');
    container.className = 'oac-dock-tabs-container';
    container.dataset.nodeId = node.id;

    const header = this._doc.createElement('div');
    header.className = 'oac-dock-tabs-header';
    header.setAttribute('role', 'tablist');

    const activePanelId = node.active || (node.panels[0] ?? '');
    const tabs = new Map<string, TabElements>();
    const viewId = `oac-dock-tabs-${++nextTabsViewId}`;

    const body = this._doc.createElement('div');
    body.className = 'oac-dock-tabs-body';
    body.id = `${viewId}-panel`;
    body.setAttribute('role', 'tabpanel');

    node.panels.forEach((panelId, index) => {
      const panel = this._panels.get(panelId);
      if (!panel) return;

      // The chrome item carries the drag, the link badge and the close button; only the label
      // is the tab, because a tab's descendants are presentational and would hide the buttons.
      const item = this._doc.createElement('div');
      item.className = 'oac-dock-tab';
      item.dataset.panelId = panelId;
      item.setAttribute('role', 'presentation');

      const tab = this._doc.createElement('span');
      tab.className = 'oac-dock-tab-label';
      tab.id = `${viewId}-tab-${index}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', body.id);
      const elements = { item, tab };
      tabs.set(panelId, elements);
      selectTab(elements, panelId === activePanelId, body);

      const linkBadge = this._linkHub.renderLinkBadge(
        panel.id,
        panel.linkGroup ?? null,
        (newGroup) => {
          this.setPanelLinkGroup(panel.id, newGroup);
        },
        this._doc
      );

      const title = this._doc.createElement('span');
      title.className = 'oac-dock-title-text';
      title.textContent = panel.title;
      tab.appendChild(title);

      const close = this._doc.createElement('button');
      close.type = 'button';
      close.className = 'oac-dock-tab-close';
      close.textContent = 'x';
      close.setAttribute('aria-label', `Close ${panel.title}`);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removePanel(panelId);
      });

      item.append(linkBadge, tab, close);

      item.addEventListener('click', () => {
        this.activateTab(panelId);
      });
      tab.addEventListener('keydown', (event) => {
        const position = node.panels.indexOf(panelId);
        let next: string | undefined;
        if (event.key === 'ArrowRight') next = node.panels[(position + 1) % node.panels.length];
        else if (event.key === 'ArrowLeft') next = node.panels[(position + node.panels.length - 1) % node.panels.length];
        else if (event.key === 'Home') next = node.panels[0];
        else if (event.key === 'End') next = node.panels[node.panels.length - 1];
        else if (event.key === 'Enter' || event.key === ' ') next = panelId;
        if (!next) return;
        event.preventDefault();
        this.activateTab(next);
        tabs.get(next)?.tab.focus();
      });

      this.bindHeaderDrag(item, panel.id, panel.title);

      header.appendChild(item);
    });

    this._tabViews.set(node.id, { body, tabs });

    const activePanel = this._panels.get(activePanelId);
    if (activePanel) {
      const host = this.getOrCreatePanelHost(activePanel);
      body.appendChild(host);
    }

    container.append(header, body);
    return container;
  }

  private renderSplitNode(node: DockSplitNode): HTMLElement {
    const container = this._doc.createElement('div');
    container.className = `oac-dock-split oac-dock-split--${node.direction}`;
    container.dataset.nodeId = node.id;

    if (node.children.length < 2) {
      if (node.children[0]) {
        const childDom = this.renderNode(node.children[0]);
        if (childDom) container.appendChild(childDom);
      }
      return container;
    }

    const first = node.children[0]!;
    const second = node.children[1]!;

    const firstPane = this._doc.createElement('div');
    firstPane.className = 'oac-dock-split-pane';
    firstPane.style.flex = `${node.ratio} 1 0%`;

    const secondPane = this._doc.createElement('div');
    secondPane.className = 'oac-dock-split-pane';
    secondPane.style.flex = `${1 - node.ratio} 1 0%`;

    const firstDom = this.renderNode(first);
    if (firstDom) firstPane.appendChild(firstDom);

    const secondDom = this.renderNode(second);
    if (secondDom) secondPane.appendChild(secondDom);

    const splitter = new DockSplitter({
      direction: node.direction,
      currentRatio: node.ratio,
      document: this._doc,
      onRatioChange: (newRatio) => {
        node.ratio = newRatio;
        firstPane.style.flex = `${newRatio} 1 0%`;
        secondPane.style.flex = `${1 - newRatio} 1 0%`;
        this.queuePanelResizes(collectPanelIds(node));
      },
      onRatioEnd: () => {
        this.saveState();
      },
      onEqualize: () => {
        node.ratio = 0.5;
        firstPane.style.flex = `0.5 1 0%`;
        secondPane.style.flex = `0.5 1 0%`;
        this.queuePanelResizes(collectPanelIds(node));
      },
    });

    this._splitters.push(splitter);

    container.append(firstPane, splitter.element, secondPane);
    return container;
  }

  private getOrCreatePanelHost(panel: TerminalPanel): HTMLElement {
    let host = this._panelHosts.get(panel.id);
    if (!host) {
      host = this._doc.createElement('div');
      host.className = 'oac-panel-host';
      host.style.width = '100%';
      host.style.height = '100%';
      host.style.overflow = 'hidden';
      host.dataset.panelId = panel.id;

      const handle = panel.mount(host);
      this._mountedHandles.set(panel.id, handle);
      this._panelHosts.set(panel.id, host);

      if (this._pendingPanelStates.has(panel.id)) {
        const state = this._pendingPanelStates.get(panel.id);
        if (handle.restore) handle.restore(state);
        else panel.restore?.(state);
        this._pendingPanelStates.delete(panel.id);
      }

      this._linkHub.registerListener(panel.id, (ctx) => {
        this._applyingLink = true;
        try {
          if (handle.onLinkUpdate) handle.onLinkUpdate(ctx);
          else panel.onLinkUpdate?.(ctx);
        } finally { this._applyingLink = false; }
      });

      handle.onTitleChange?.((newTitle) => {
        panel.title = newTitle;
        this.updatePanelTitleInDom(panel.id, newTitle);
        this.saveState();
      });

      handle.onLinkBroadcast?.((ctx) => {
        if (this._applyingLink || this._restoring) return;
        const grp = this.getPanelLinkGroup(panel.id);
        if (grp) {
          this.broadcastLink(grp, ctx.symbol, ctx.interval, ctx.exchange, panel.id);
        }
      });

      if (this._resizeObserver) {
        this._resizeObserver.observe(host);
      }
    }
    return host;
  }

  private updatePanelTitleInDom(panelId: string, newTitle: string): void {
    // Matched by dataset, not an attribute selector: a panel ID may hold any character.
    for (const owner of this._root.querySelectorAll<HTMLElement>('.oac-dock-panel, .oac-dock-tab')) {
      if (owner.dataset.panelId !== panelId) continue;
      const title = owner.querySelector('.oac-dock-title-text');
      if (title) title.textContent = newTitle;
    }
    const floatWin = this._floatingWindows.get(panelId);
    if (floatWin) floatWin.setTitle(newTitle);
  }

  private bindHeaderDrag(header: HTMLElement, panelId: string, title: string): void {
    header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.oac-dock-btn, .oac-dock-tab-close, .oac-dock-link-badge')) {
        return;
      }
      if (e.button !== 0) return;

      const dragSession = new PanelDragSession({
        panelId,
        title,
        container: this._root,
        preview: this._preview,
        getPanes: () => this.collectPanes(),
        onDock: (pId, tgtId, pos) => {
          this.dockPanel(pId, tgtId, pos);
        },
        onFloat: (pId, x, y) => {
          this.floatPanel(pId, { x, y, width: 360, height: 300 });
        },
      });

      dragSession.start(e);
    });
  }

  private collectPanes(): PaneRectInfo[] {
    const list: PaneRectInfo[] = [];
    const elements = this._treeContainer.querySelectorAll('.oac-dock-panel, .oac-dock-tabs-container');

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as HTMLElement;
      const nodeId = el.dataset.nodeId;
      if (nodeId) {
        const header = el.querySelector('.oac-dock-panel-header, .oac-dock-tabs-header') as HTMLElement | null;
        list.push({
          targetNodeId: nodeId,
          rect: el.getBoundingClientRect(),
          headerRect: header ? header.getBoundingClientRect() : undefined,
        });
      }
    }

    return list;
  }

  private findDropHit(cx: number, cy: number) {
    const panes = this.collectPanes();
    const containerRect = this._root.getBoundingClientRect();
    return calculateSnapTarget(cx, cy, panes, containerRect);
  }

  public destroy(): void {
    if (this._destroyed) return;
    void this.flush(); this._storage.shared.close();
    this._doc.defaultView?.removeEventListener?.('pagehide', this._pageHide);
    this._doc.removeEventListener('visibilitychange', this._visibility);
    this._destroyed = true;
    this.cancelReconcile();
    this._resizeFrame.cancel();
    this._resizeQueue.clear();
    this._lastSizes.clear();
    this._tabViews.clear();

    this.clearSplitters();

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    for (const win of this._floatingWindows.values()) {
      win.destroy();
    }
    this._floatingWindows.clear();

    for (const handle of this._mountedHandles.values()) {
      releasePanel(handle);
    }
    this._mountedHandles.clear();

    this._preview.destroy();
    this._linkHub.destroy();
    this._treeContainer.remove();
    this._root.classList.remove('oac-terminal');
  }
}

/**
 * Factory creating an OpenAlgo Terminal Workspace.
 */
export function createTerminalWorkspace(
  container: HTMLElement | string,
  options: TerminalOptions = {}
): TerminalWorkspace {
  return new TerminalDockController(container, options);
}

/** The document without the panels `keep` rejects: their layout leaves, floating windows and records. */
function pruneDocument(doc: TerminalDocument, keep: (id: string) => boolean): TerminalDocument {
  let layout = doc.layout;
  const panels: TerminalDocument['panels'] = {};
  for (const [id, info] of Object.entries(doc.panels)) {
    if (keep(id)) panels[id] = info;
    else layout = removePanel(layout, id);
  }
  return { ...doc, layout, floating: doc.floating.filter(window => keep(window.panelId)), panels };
}
