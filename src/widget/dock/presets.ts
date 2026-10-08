/**
 * Terminal Workspace Layout Presets.
 *
 * Professional presets for multi-chart, DOM, order flow, scalper, and analysis desks.
 */

import type { DockNode } from './types';

export interface LayoutPresetDefinition {
  id: string;
  name: string;
  description: string;
  buildLayout(panelIds: {
    chart1: string;
    chart2?: string | undefined;
    chart3?: string | undefined;
    chart4?: string | undefined;
    dom?: string | undefined;
    watchlist?: string | undefined;
    news?: string | undefined;
    orders?: string | undefined;
  }): DockNode;
}

export const TERMINAL_PRESETS: Record<string, LayoutPresetDefinition> = {
  'chart-dom': {
    id: 'chart-dom',
    name: 'Chart + DOM',
    description: 'Main candlestick chart on left with independent DOM ladder on right',
    buildLayout({ chart1, dom = 'dom_primary' }) {
      return {
        type: 'split',
        id: 'split_main',
        direction: 'horizontal',
        ratio: 0.72,
        children: [
          { type: 'panel', id: 'pane_chart1', panelId: chart1 },
          { type: 'panel', id: 'pane_dom', panelId: dom },
        ],
      };
    },
  },

  'two-charts-dom': {
    id: 'two-charts-dom',
    name: '2 Charts + DOM',
    description: 'Two stacked charts on left (higher/lower timeframe) with DOM ladder on right',
    buildLayout({ chart1, chart2 = 'chart_secondary', dom = 'dom_primary' }) {
      return {
        type: 'split',
        id: 'split_main',
        direction: 'horizontal',
        ratio: 0.72,
        children: [
          {
            type: 'split',
            id: 'split_charts',
            direction: 'vertical',
            ratio: 0.5,
            children: [
              { type: 'panel', id: 'pane_chart1', panelId: chart1 },
              { type: 'panel', id: 'pane_chart2', panelId: chart2 },
            ],
          },
          { type: 'panel', id: 'pane_dom', panelId: dom },
        ],
      };
    },
  },

  scalper: {
    id: 'scalper',
    name: 'Scalper Desk',
    description: 'Fast 1m chart left, DOM ladder in the center, and anchor 5m/15m chart right',
    buildLayout({ chart1, chart2 = 'chart_secondary', dom = 'dom_primary' }) {
      return {
        type: 'split',
        id: 'split_scalper',
        direction: 'horizontal',
        ratio: 0.35,
        children: [
          { type: 'panel', id: 'pane_chart1', panelId: chart1 },
          {
            type: 'split',
            id: 'split_dom_right',
            direction: 'horizontal',
            ratio: 0.46,
            children: [
              { type: 'panel', id: 'pane_dom', panelId: dom },
              { type: 'panel', id: 'pane_chart2', panelId: chart2 },
            ],
          },
        ],
      };
    },
  },

  'order-flow': {
    id: 'order-flow',
    name: 'Order Flow',
    description: 'Chart on left with tabbed DOM, watchlist, and news panels on right',
    buildLayout({ chart1, dom = 'dom_primary', watchlist = 'watchlist_primary', news = 'news_primary' }) {
      return {
        type: 'split',
        id: 'split_orderflow',
        direction: 'horizontal',
        ratio: 0.7,
        children: [
          { type: 'panel', id: 'pane_chart1', panelId: chart1 },
          {
            type: 'tabs',
            id: 'tabs_sidebar',
            active: dom,
            panels: [dom, watchlist, news],
          },
        ],
      };
    },
  },

  analysis: {
    id: 'analysis',
    name: 'Multi-Timeframe Analysis',
    description: 'Quad 2x2 multi-chart grid',
    buildLayout({
      chart1,
      chart2 = 'chart_2',
      chart3 = 'chart_3',
      chart4 = 'chart_4',
    }) {
      return {
        type: 'split',
        id: 'split_row',
        direction: 'vertical',
        ratio: 0.5,
        children: [
          {
            type: 'split',
            id: 'split_top',
            direction: 'horizontal',
            ratio: 0.5,
            children: [
              { type: 'panel', id: 'pane_c1', panelId: chart1 },
              { type: 'panel', id: 'pane_c2', panelId: chart2 },
            ],
          },
          {
            type: 'split',
            id: 'split_bottom',
            direction: 'horizontal',
            ratio: 0.5,
            children: [
              { type: 'panel', id: 'pane_c3', panelId: chart3 },
              { type: 'panel', id: 'pane_c4', panelId: chart4 },
            ],
          },
        ],
      };
    },
  },
};
