import { describe, expect, it, vi } from 'vitest';
import {
  collectPanelIds,
  insertPanel,
  movePanel,
  removePanel,
  validateAndSanitizeTree,
  equalizeSplit,
} from '../src/widget/dock/model';
import { calculateSnapTarget } from '../src/widget/dock/hit-zones';
import { LinkHub } from '../src/widget/dock/link-hub';
import { TERMINAL_PRESETS } from '../src/widget/dock/presets';
import {
  buildDocumentFromWorkspace,
  loadTerminalDocument,
  saveTerminalDocument,
} from '../src/widget/dock/persist';
import { StandaloneDomLadder, buildDomRows, ladderCapability } from '../src/widget/dock/dom-panel';
import { createTerminalWorkspace } from '../src/widget/dock/controller';
import { fakeWidgetDocument } from './helpers/fake-dom-widget';
import type { DockNode, DockSplitNode, TerminalPanel } from '../src/widget/dock/types';
import type { MarketDepth } from '../src/feed/types';

describe('Terminal Dock Tree Model (Phases 1 & 2)', () => {
  it('inserts panels into an empty tree and splits horizontally/vertically', () => {
    let tree: DockNode | null = null;

    // 1. First panel becomes root
    tree = insertPanel(tree, 'p_chart1', '', 'center');
    expect(tree.type).toBe('panel');
    expect((tree as any).panelId).toBe('p_chart1');

    // 2. Insert second panel to the right
    tree = insertPanel(tree, 'p_dom', tree.id, 'right');
    expect(tree.type).toBe('split');
    const splitH = tree as DockSplitNode;
    expect(splitH.direction).toBe('horizontal');
    expect(splitH.children.length).toBe(2);
    expect(collectPanelIds(tree)).toEqual(['p_chart1', 'p_dom']);

    // 3. Insert third panel below p_chart1
    const p1 = splitH.children[0]!;
    tree = insertPanel(tree, 'p_chart2', p1.id, 'bottom');
    expect(collectPanelIds(tree)).toEqual(['p_chart1', 'p_chart2', 'p_dom']);
  });

  it('groups panels into tab stacks when dropped center', () => {
    let tree: DockNode = {
      type: 'panel',
      id: 'panel_1',
      panelId: 'chart_main',
    };

    // Center drop on existing panel creates tabs
    tree = insertPanel(tree, 'dom_main', 'panel_1', 'center');
    expect(tree.type).toBe('tabs');
    expect((tree as any).panels).toEqual(['chart_main', 'dom_main']);
    expect((tree as any).active).toBe('dom_main');

    // Center drop on tabs appends to tabs
    tree = insertPanel(tree, 'news_main', tree.id, 'center');
    expect(tree.type).toBe('tabs');
    expect((tree as any).panels).toEqual(['chart_main', 'dom_main', 'news_main']);
    expect((tree as any).active).toBe('news_main');
  });

  it('prunes and simplifies tree when panels are removed', () => {
    let tree: DockNode = {
      type: 'split',
      id: 'split_1',
      direction: 'horizontal',
      ratio: 0.5,
      children: [
        { type: 'panel', id: 'p1', panelId: 'chart1' },
        {
          type: 'tabs',
          id: 't1',
          active: 'dom1',
          panels: ['dom1', 'watchlist1'],
        },
      ],
    };

    // Remove one tab from tab stack -> leaves 1 tab which collapses to panel
    tree = removePanel(tree, 'watchlist1')!;
    expect(tree).not.toBeNull();
    const split = tree as DockSplitNode;
    expect(split.children[1]!.type).toBe('panel');
    expect((split.children[1]! as any).panelId).toBe('dom1');

    // Remove remaining panel from that side -> split collapses to single surviving panel
    tree = removePanel(tree, 'dom1')!;
    expect(tree.type).toBe('panel');
    expect((tree as any).panelId).toBe('chart1');

    // Remove last panel -> null tree
    const empty = removePanel(tree, 'chart1');
    expect(empty).toBeNull();
  });

  it('moves an existing panel to a new position', () => {
    let tree: DockNode = {
      type: 'panel',
      id: 'p1',
      panelId: 'chart1',
    };
    tree = insertPanel(tree, 'dom1', 'p1', 'right');
    expect(collectPanelIds(tree)).toEqual(['chart1', 'dom1']);

    // Move dom1 to be tabbed with chart1
    tree = movePanel(tree, 'dom1', 'chart1', 'center');
    expect(tree.type).toBe('tabs');
    expect(collectPanelIds(tree)).toEqual(['chart1', 'dom1']);
  });

  it('equalizes split ratios to 0.5', () => {
    const split: DockSplitNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      ratio: 0.25,
      children: [
        { type: 'panel', id: 'p1', panelId: 'c1' },
        { type: 'panel', id: 'p2', panelId: 'c2' },
      ],
    };

    equalizeSplit(split);
    expect(split.ratio).toBe(0.5);
  });

  it('validates and sanitizes malformed tree JSON', () => {
    expect(validateAndSanitizeTree(null)).toBeNull();
    expect(validateAndSanitizeTree({})).toBeNull();

    const validPanel = validateAndSanitizeTree({ type: 'panel', panelId: 'foo' });
    expect(validPanel).not.toBeNull();
    expect(validPanel?.type).toBe('panel');

    const validTabs = validateAndSanitizeTree({
      type: 'tabs',
      panels: ['a', 'b'],
      active: 'b',
    });
    expect(validTabs?.type).toBe('tabs');
    expect((validTabs as any).active).toBe('b');
  });
});

describe('Snap Hit Zones (Phase 2)', () => {
  it('detects 5-zone drop targets correctly', () => {
    const containerRect = {
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
    } as DOMRect;

    const paneRect = {
      left: 100,
      top: 100,
      right: 900,
      bottom: 700,
      width: 800,
      height: 600,
    } as DOMRect;

    const headerRect = {
      left: 100,
      top: 100,
      right: 900,
      bottom: 132,
      width: 800,
      height: 32,
    } as DOMRect;

    const panes = [
      {
        targetNodeId: 'target_pane',
        rect: paneRect,
        headerRect,
      },
    ];

    // Pointer on header -> center tab snap
    const hitHeader = calculateSnapTarget(500, 115, panes, containerRect);
    expect(hitHeader).not.toBeNull();
    expect(hitHeader?.position).toBe('center');

    // Pointer on far left (<25% of width) -> left snap
    const hitLeft = calculateSnapTarget(150, 400, panes, containerRect);
    expect(hitLeft?.position).toBe('left');
    expect(hitLeft?.rect.width).toBe(400);

    // Pointer on far right (>75% of width) -> right snap
    const hitRight = calculateSnapTarget(850, 400, panes, containerRect);
    expect(hitRight?.position).toBe('right');
    expect(hitRight?.rect.width).toBe(400);

    // Pointer near top edge -> top snap
    const hitTop = calculateSnapTarget(500, 150, panes, containerRect);
    expect(hitTop?.position).toBe('top');

    // Pointer near bottom edge -> bottom snap
    const hitBottom = calculateSnapTarget(500, 680, panes, containerRect);
    expect(hitBottom?.position).toBe('bottom');

    // Pointer in middle body -> center snap
    const hitCenter = calculateSnapTarget(500, 400, panes, containerRect);
    expect(hitCenter?.position).toBe('center');
  });
});

describe('Panel Link Groups (Phase 5)', () => {
  it('synchronizes symbol and interval across linked panels', () => {
    const hub = new LinkHub();

    hub.setPanelGroup('chart_1', 'red');
    hub.setPanelGroup('dom_1', 'red');
    hub.setPanelGroup('chart_2', 'blue');

    const chart1Callback = vi.fn();
    const dom1Callback = vi.fn();
    const chart2Callback = vi.fn();

    hub.registerListener('chart_1', chart1Callback);
    hub.registerListener('dom_1', dom1Callback);
    hub.registerListener('chart_2', chart2Callback);

    // Broadcast on Red group from Chart 1
    hub.broadcast('red', 'BANKNIFTY', '5m', 'chart_1');

    // Dom 1 receives update
    expect(dom1Callback).toHaveBeenCalledWith({
      group: 'red',
      symbol: 'BANKNIFTY',
      interval: '5m',
    });

    // Chart 1 (sender) is excluded from its own echo
    expect(chart1Callback).not.toHaveBeenCalled();

    // Chart 2 (blue group) does NOT receive update
    expect(chart2Callback).not.toHaveBeenCalled();
  });
});

describe('Standalone DOM Ladder Panel (Phase 4)', () => {
  it('builds ladder rows and renders interactive depth columns', () => {
    const depth: MarketDepth = {
      ltp: 100.5,
      bids: [
        { price: 100.5, qty: 50 },
        { price: 100.45, qty: 120 },
        { price: 100.4, qty: 300 },
      ],
      asks: [
        { price: 100.55, qty: 80 },
        { price: 100.6, qty: 250 },
        { price: 100.65, qty: 400 },
      ],
    };

    const onOrder = vi.fn();
    const doc = fakeWidgetDocument() as unknown as Document;
    const ladder = new StandaloneDomLadder({
      symbol: 'TCS',
      document: doc,
      tickSize: 0.05,
      depth,
      onOrder,
    });

    const calculatedRows = buildDomRows(depth, 0.05);
    expect(calculatedRows.length).toBe(6);
    expect(ladderCapability(depth)).toBe('compact');

    expect(ladder.element.classList.contains('oac-dom-panel')).toBe(true);

    // Verify DOM contains price rows
    const rows = ladder.element.querySelectorAll('.oac-dom-row');
    expect(rows.length).toBe(6);

    // Test order placement click
    const buyBtn = ladder.element.querySelector('.oac-dom-cell-btn--buy') as HTMLButtonElement | null;
    expect(buyBtn).not.toBeNull();
    buyBtn?.click();

    expect(onOrder).toHaveBeenCalledWith('buy', 'limit', expect.any(Number), 1);
  });
});

describe('Workspace Layout Presets & Persistence (Phases 6 & 7)', () => {
  it('builds standard presets cleanly', () => {
    const chartDomPreset = TERMINAL_PRESETS['chart-dom']!;
    const layout = chartDomPreset.buildLayout({
      chart1: 'chart_nifty',
      dom: 'dom_nifty',
    });

    expect(layout.type).toBe('split');
    expect(collectPanelIds(layout)).toEqual(['chart_nifty', 'dom_nifty']);

    const scalperPreset = TERMINAL_PRESETS['scalper']!;
    const scalperLayout = scalperPreset.buildLayout({
      chart1: 'c1',
      chart2: 'c2',
      dom: 'dom1',
    });
    expect(collectPanelIds(scalperLayout)).toEqual(['c1', 'dom1', 'c2']);
  });

  it('serializes and rehydrates workspace documents', () => {
    const panelMap = new Map<string, TerminalPanel>();
    panelMap.set('chart_1', {
      id: 'chart_1',
      type: 'chart',
      title: 'NIFTY (5m)',
      linkGroup: 'red',
      mount: () => ({ destroy: vi.fn() }),
      state: () => ({ symbol: 'NIFTY', interval: '5m' }),
    });

    const layout: DockNode = {
      type: 'panel',
      id: 'pane_1',
      panelId: 'chart_1',
    };

    const doc = buildDocumentFromWorkspace(layout, [], panelMap);
    expect(doc.version).toBe(1);
    expect(doc.panels['chart_1']?.linkGroup).toBe('red');

    // Persistence test
    const mockStorage = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mockStorage.get(k) ?? null,
      setItem: (k: string, v: string) => { mockStorage.set(k, v); },
      removeItem: (k: string) => { mockStorage.delete(k); },
    };

    saveTerminalDocument(storage, 'test_key', doc);
    const restored = loadTerminalDocument(storage, 'test_key');

    expect(restored).not.toBeNull();
    expect(restored?.layout?.type).toBe('panel');
    expect(restored?.panels['chart_1']).toMatchObject({ title: 'NIFTY (5m)', state: { symbol: 'NIFTY', interval: '5m' } });
  });
});

describe('Terminal Workspace Controller (Lifecycle & Integration)', () => {
  it('mounts, adds panels, floats, docks into tabs, and destroys cleanly', () => {
    const doc = fakeWidgetDocument();
    const container = doc.createElement('div');
    const ws = createTerminalWorkspace(container as unknown as HTMLElement);

    const destroyChart = vi.fn(), destroyDom = vi.fn();
    const p1: TerminalPanel = {
      id: 'chart_1',
      type: 'chart',
      title: 'Chart 1',
      mount: (host) => {
        host.textContent = 'Chart 1 mounted';
        return { destroy: destroyChart, resize: vi.fn() };
      },
    };

    const p2: TerminalPanel = {
      id: 'dom_1',
      type: 'dom',
      title: 'DOM 1',
      mount: (host) => {
        host.textContent = 'DOM 1 mounted';
        return { destroy: destroyDom, resize: vi.fn() };
      },
    };

    ws.addPanel(p1);
    expect(ws.getPanel('chart_1')).toBe(p1);
    expect(ws.getLayout()?.type).toBe('panel');

    ws.addPanel(p2, 'chart_1', 'right');
    expect(ws.getLayout()?.type).toBe('split');

    ws.floatPanel('dom_1');
    expect(ws.getLayout()?.type).toBe('panel');

    ws.dockPanel('dom_1', 'chart_1', 'center');
    expect(ws.getLayout()?.type).toBe('tabs');

    ws.activateTab('chart_1');
    expect(destroyChart).not.toHaveBeenCalled();
    expect(destroyDom).not.toHaveBeenCalled();

    ws.destroy();
    expect(destroyChart).toHaveBeenCalledOnce();
    expect(destroyDom).toHaveBeenCalledOnce();
  });
});

