/**
 * Dock tree model operations.
 *
 * Implements pure functional tree transformations for adding, removing,
 * moving, splitting, and tab-grouping dock nodes without side effects.
 */

import type {
  DockDropPosition,
  DockNode,
  DockPanelNode,
  DockSplitNode,
  DockTabsNode,
} from './types';

/** The share of a split its first pane may hold; a divider stops at these and a restore is clamped to them. */
export const MIN_SPLIT_RATIO = 0.05;
export const MAX_SPLIT_RATIO = 0.95;
export const clampSplitRatio = (ratio: number): number => Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));

let nextId = 1;
export function generateNodeId(prefix = 'dock_node'): string {
  return `${prefix}_${Date.now().toString(36)}_${(nextId++).toString(36)}`;
}

export function cloneNode(node: DockNode): DockNode {
  if (node.type === 'panel') {
    return { ...node };
  }
  if (node.type === 'tabs') {
    return { ...node, panels: [...node.panels] };
  }
  return {
    ...node,
    children: node.children.map(cloneNode),
  };
}

export function findNodeById(root: DockNode | null, id: string): DockNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  if (root.type === 'split') {
    for (const child of root.children) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  return null;
}

export function findParentNode(
  root: DockNode | null,
  childId: string
): { parent: DockSplitNode; index: number } | null {
  if (!root || root.type !== 'split') return null;

  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i]!;
    if (child.id === childId) {
      return { parent: root, index: i };
    }
    if (child.type === 'split') {
      const sub = findParentNode(child, childId);
      if (sub) return sub;
    }
  }
  return null;
}

export function findNodeContainingPanel(
  root: DockNode | null,
  panelId: string
): DockPanelNode | DockTabsNode | null {
  if (!root) return null;
  if (root.type === 'panel' && root.panelId === panelId) {
    return root;
  }
  if (root.type === 'tabs' && root.panels.includes(panelId)) {
    return root;
  }
  if (root.type === 'split') {
    for (const child of root.children) {
      const found = findNodeContainingPanel(child, panelId);
      if (found) return found;
    }
  }
  return null;
}

export function collectPanelIds(root: DockNode | null): string[] {
  if (!root) return [];
  if (root.type === 'panel') return [root.panelId];
  if (root.type === 'tabs') return [...root.panels];
  const result: string[] = [];
  for (const child of root.children) {
    result.push(...collectPanelIds(child));
  }
  return result;
}

/**
 * Remove a panel from the tree.
 * Prunes empty tabs and simplifies binary splits when a child is removed.
 */
export function removePanel(root: DockNode | null, panelId: string): DockNode | null {
  if (!root) return null;

  if (root.type === 'panel') {
    return root.panelId === panelId ? null : root;
  }

  if (root.type === 'tabs') {
    if (!root.panels.includes(panelId)) return root;
    const remaining = root.panels.filter((p) => p !== panelId);
    if (remaining.length === 0) return null;
    if (remaining.length === 1) {
      return {
        type: 'panel',
        id: root.id,
        panelId: remaining[0]!,
      };
    }
    const newActive = root.active === panelId ? remaining[0]! : root.active;
    return {
      ...root,
      panels: remaining,
      active: newActive,
    };
  }

  // Split node
  const newChildren: DockNode[] = [];
  for (const child of root.children) {
    const updated = removePanel(child, panelId);
    if (updated !== null) {
      newChildren.push(updated);
    }
  }

  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0]!;

  return {
    ...root,
    children: newChildren,
  };
}

/**
 * Insert a panel relative to a target node in the tree.
 */
export function insertPanel(
  root: DockNode | null,
  panelId: string,
  targetId: string,
  position: DockDropPosition
): DockNode {
  const newPanelNode: DockPanelNode = {
    type: 'panel',
    id: generateNodeId('panel'),
    panelId,
  };

  if (!root) {
    return newPanelNode;
  }

  // If tree already contains panelId, prune it first
  const cleanRoot = removePanel(root, panelId) ?? root;

  // If target node is root and position is edge split
  if (cleanRoot.id === targetId || cleanRoot.type === 'panel' && (cleanRoot as DockPanelNode).panelId === targetId) {
    return placeRelativeToNode(cleanRoot, newPanelNode, position);
  }

  return insertRecursive(cleanRoot, newPanelNode, targetId, position);
}

function placeRelativeToNode(
  target: DockNode,
  newPanel: DockPanelNode,
  position: DockDropPosition
): DockNode {
  if (position === 'center') {
    if (target.type === 'tabs') {
      return {
        ...target,
        panels: target.panels.includes(newPanel.panelId)
          ? target.panels
          : [...target.panels, newPanel.panelId],
        active: newPanel.panelId,
      };
    }
    if (target.type === 'panel') {
      return {
        type: 'tabs',
        id: generateNodeId('tabs'),
        active: newPanel.panelId,
        panels: [target.panelId, newPanel.panelId],
      };
    }
    // If target is split, wrap in tabs
    const targetPanels = collectPanelIds(target);
    return {
      type: 'tabs',
      id: generateNodeId('tabs'),
      active: newPanel.panelId,
      panels: [...targetPanels, newPanel.panelId],
    };
  }

  const isHorizontal = position === 'left' || position === 'right';
  const isBefore = position === 'left' || position === 'top';

  const children = isBefore ? [newPanel, target] : [target, newPanel];

  return {
    type: 'split',
    id: generateNodeId('split'),
    direction: isHorizontal ? 'horizontal' : 'vertical',
    ratio: 0.5,
    children,
  };
}

function insertRecursive(
  current: DockNode,
  newPanel: DockPanelNode,
  targetId: string,
  position: DockDropPosition
): DockNode {
  if (
    current.id === targetId ||
    (current.type === 'panel' && current.panelId === targetId) ||
    (current.type === 'tabs' && current.panels.includes(targetId))
  ) {
    return placeRelativeToNode(current, newPanel, position);
  }

  if (current.type === 'split') {
    const updatedChildren = current.children.map((child) =>
      insertRecursive(child, newPanel, targetId, position)
    );
    return {
      ...current,
      children: updatedChildren,
    };
  }

  return current;
}

/**
 * Move an existing panel to a new position relative to a target node.
 */
export function movePanel(
  root: DockNode,
  panelId: string,
  targetId: string,
  position: DockDropPosition
): DockNode {
  const pruned = removePanel(root, panelId);
  // A self drop or stale target must never remove a panel from the workspace.
  if (!pruned || !(findNodeById(pruned, targetId) || findNodeContainingPanel(pruned, targetId))) return root;
  return insertPanel(pruned, panelId, targetId, position);
}

/**
 * Equalize the ratio of a split node to balanced 0.5 proportions.
 */
export function equalizeSplit(node: DockSplitNode): void {
  node.ratio = 0.5;
}

/**
 * Validate and sanitize an arbitrary JSON structure into a valid DockNode tree.
 */
export function validateAndSanitizeTree(raw: unknown): DockNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (obj.type === 'panel' && typeof obj.panelId === 'string') {
    return {
      type: 'panel',
      id: typeof obj.id === 'string' ? obj.id : generateNodeId('panel'),
      panelId: obj.panelId,
    };
  }

  if (obj.type === 'tabs' && Array.isArray(obj.panels) && obj.panels.length > 0) {
    const panels = obj.panels.filter((p): p is string => typeof p === 'string');
    if (panels.length === 0) return null;
    const active = typeof obj.active === 'string' && panels.includes(obj.active)
      ? obj.active
      : panels[0]!;
    return {
      type: 'tabs',
      id: typeof obj.id === 'string' ? obj.id : generateNodeId('tabs'),
      active,
      panels,
    };
  }

  if (obj.type === 'split' && Array.isArray(obj.children) && obj.children.length >= 2) {
    const direction = obj.direction === 'vertical' ? 'vertical' : 'horizontal';
    const ratio = typeof obj.ratio === 'number' && Number.isFinite(obj.ratio)
      ? clampSplitRatio(obj.ratio)
      : 0.5;

    const children: DockNode[] = [];
    for (const child of obj.children) {
      const sanitizedChild = validateAndSanitizeTree(child);
      if (sanitizedChild) children.push(sanitizedChild);
    }

    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;

    return {
      type: 'split',
      id: typeof obj.id === 'string' ? obj.id : generateNodeId('split'),
      direction,
      ratio,
      children,
    };
  }

  return null;
}
