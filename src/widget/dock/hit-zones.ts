/**
 * Hit zone calculation for docking snap zones.
 *
 * Translates pointer position over a dock panel or tab strip into one of five
 * snap zones: left, right, top, bottom, or center (tab grouping).
 */

import type { DockDropPosition, SnapHitResult } from './types';

export interface PaneRectInfo {
  targetNodeId: string;
  rect: DOMRect;
  headerRect?: DOMRect | undefined;
}

export function calculateSnapTarget(
  clientX: number,
  clientY: number,
  panes: PaneRectInfo[],
  containerRect: DOMRect
): SnapHitResult | null {
  for (const pane of panes) {
    const { targetNodeId, rect, headerRect } = pane;

    // Check if pointer is over the header strip (triggers tab grouping)
    if (
      headerRect &&
      clientX >= headerRect.left &&
      clientX <= headerRect.right &&
      clientY >= headerRect.top &&
      clientY <= headerRect.bottom
    ) {
      return {
        targetNodeId,
        position: 'center',
        rect: {
          left: rect.left - containerRect.left,
          top: rect.top - containerRect.top,
          width: rect.width,
          height: rect.height,
        },
      };
    }

    // Check if pointer is inside the panel bounding box
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      const relX = (clientX - rect.left) / rect.width;
      const relY = (clientY - rect.top) / rect.height;

      let position: DockDropPosition = 'center';

      // Edge proximity detection (outer 25% on each edge)
      const edgeThreshold = 0.25;

      if (relX < edgeThreshold) {
        position = 'left';
      } else if (relX > 1 - edgeThreshold) {
        position = 'right';
      } else if (relY < edgeThreshold) {
        position = 'top';
      } else if (relY > 1 - edgeThreshold) {
        position = 'bottom';
      } else {
        position = 'center';
      }

      const preview = calculatePreviewRect(rect, position, containerRect);

      return {
        targetNodeId,
        position,
        rect: preview,
      };
    }
  }

  return null;
}

function calculatePreviewRect(
  targetRect: DOMRect,
  position: DockDropPosition,
  containerRect: DOMRect
): { left: number; top: number; width: number; height: number } {
  const baseLeft = targetRect.left - containerRect.left;
  const baseTop = targetRect.top - containerRect.top;
  const w = targetRect.width;
  const h = targetRect.height;

  switch (position) {
    case 'left':
      return { left: baseLeft, top: baseTop, width: w / 2, height: h };
    case 'right':
      return { left: baseLeft + w / 2, top: baseTop, width: w / 2, height: h };
    case 'top':
      return { left: baseLeft, top: baseTop, width: w, height: h / 2 };
    case 'bottom':
      return { left: baseLeft, top: baseTop + h / 2, width: w, height: h / 2 };
    case 'center':
    default:
      return { left: baseLeft, top: baseTop, width: w, height: h };
  }
}
