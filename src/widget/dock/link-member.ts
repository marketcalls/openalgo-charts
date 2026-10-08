import { createLinkGroup, type LinkChart, type LinkGroup } from 'openalgo-charts';

/** Non-chart panels follow only selection channels through the same engine as the grid. */
export function selectionGroup(): LinkGroup {
  return createLinkGroup({ crosshair: false, viewport: false, symbol: true, interval: true });
}

/** A selection-only host has no timeline or canvas. Those channels stay disabled. */
export function selectionMember(): LinkChart {
  return {
    on: () => () => {}, panes: () => [null],
    getVisibleLogicalRange: () => ({ from: 0, to: 0 }), setVisibleLogicalRange() {},
    addPrimitive() {}, removePrimitive() {},
    dataLayer: { length: 0, indexToTime: () => undefined, timeToIndex: () => undefined,
      indexToTimeFloat: () => NaN, timeToIndexFloat: () => NaN },
  };
}
