/**
 * A drawing a host hands the controller, made into the drawing it stores.
 * Pure: the controller mints the id and appends the result, so this needs no
 * registry, no chart and no history.
 */
import type { Drawing, DrawingInput, DrawingStyle, DrawingTool } from './types';
import { readViewportPoints } from './viewport';
import { readIntervalRange } from './intervals';
import { withWaveOrigin } from './elliott';

/** @internal Reserved persistence metadata; a duplicate is a new drawing lineage. */
export const DRAWING_LINK_METADATA_KEY = 'openalgo-charts/drawing-link';

/** The stored drawing for `drawing` under `id`, its tool's defaults under the caller's own. */
export function drawingFromInput(drawing: DrawingInput, id: string, tool: DrawingTool, defaultStyle: DrawingStyle): Drawing {
  const { id: _dropped, ...rest } = drawing;
  void _dropped;
  const created: Drawing = {
    ...rest,
    id,
    style: { ...defaultStyle, ...tool.defaultStyle, ...drawing.style },
    zIndex: Number.isFinite(drawing.zIndex) ? (drawing.zIndex as number) : 0,
    createdAt: drawing.createdAt ?? Date.now(),
  };
  // A copy: the object the caller keeps is not a switch on this drawing.
  if (drawing.policy) created.policy = { ...drawing.policy };
  // One space, one set of anchors: a viewport drawing keeps no data anchors
  // that could be mistaken for its position, and data is never written out.
  if (drawing.space === 'viewport') {
    created.points = [];
    created.viewportPoints = readViewportPoints(drawing.viewportPoints) ?? [];
  } else {
    delete created.space;
    delete created.viewportPoints;
    // A host written against 2.7.0 adds a wave count without its origin.
    created.points = withWaveOrigin(created.tool, created.points);
  }
  // A copy, and only a range that names a bound: an empty one limits nothing.
  const intervals = readIntervalRange(drawing.intervals);
  if (intervals === null) delete created.intervals;
  else created.intervals = intervals;
  if (created.props?.[DRAWING_LINK_METADATA_KEY] !== undefined) {
    created.props = { ...created.props };
    delete created.props[DRAWING_LINK_METADATA_KEY];
  }
  if (drawing.text !== undefined || tool.defaultText !== undefined) {
    created.text = { value: '', ...tool.defaultText, ...drawing.text };
  }
  return created;
}
