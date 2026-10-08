/**
 * Adapters for turning charts, watchlists, news, objects, and data into TerminalPanels.
 */

import type { DataFeed } from '../../index';
import { createWidget, type Widget, type WidgetOptions } from '../widget';
import type { LinkColor, LinkContext, TerminalPanel } from './types';

export interface ChartPanelOptions {
  id?: string;
  symbol: string;
  interval: string;
  feed: DataFeed;
  theme?: string;
  linkGroup?: LinkColor | null;
  widgetOptions?: Partial<WidgetOptions>;
  /** Chart-local tools; callbacks read the current widget instrument at click time. */
  tools?: readonly { label: string; open(widget: Widget, panelId: string): void }[];
  onInstrumentChange?(panelId: string, instrument: { symbol: string; exchange: string }): void;
}

export interface ChartTerminalPanel extends TerminalPanel {
  /** Null before mounting and after removal. */
  widget(): Widget | null;
}

export function createChartPanel(options: ChartPanelOptions): ChartTerminalPanel {
  let widgetInstance: Widget | null = null;
  const panelId = options.id ?? `chart_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

  return {
    id: panelId,
    widget: () => widgetInstance,
    type: 'chart',
    title: `${options.symbol} (${options.interval})`,
    minWidth: 320,
    minHeight: 240,
    linkGroup: options.linkGroup ?? null,
    mount(host: HTMLElement) {
      widgetInstance = createWidget(host, {
        feed: options.feed,
        symbol: options.symbol,
        interval: options.interval,
        theme: (options.theme as 'dark' | 'light') ?? 'dark',
        mobile: 'never',
        persist: false,
        ...options.widgetOptions,
      });
      if (options.tools?.length) {
        const tools = host.ownerDocument.createElement('div');
        tools.className = 'oac-chart-tools';
        tools.setAttribute('role', 'toolbar');
        tools.setAttribute('aria-label', 'Chart tools');
        for (const tool of options.tools) {
          const button = host.ownerDocument.createElement('button');
          button.type = 'button';
          button.textContent = tool.label;
          button.addEventListener('click', () => { if (widgetInstance) tool.open(widgetInstance, panelId); });
          tools.appendChild(button);
        }
        widgetInstance.root.appendChild(tools);
      }

      let titleChangeCb: ((t: string) => void) | null = null;
      let linkBroadcastCb: ((ctx: { symbol: string; interval?: string | undefined; exchange?: string | undefined }) => void) | null = null;

      const notifyChange = (sym: string, intv: string, ex?: string) => {
        options.symbol = sym;
        options.interval = intv;
        options.onInstrumentChange?.(panelId, { symbol: sym, exchange: ex ?? '' });
        titleChangeCb?.(`${sym} (${intv})`);
        linkBroadcastCb?.({ symbol: sym, interval: intv, exchange: ex });
      };

      widgetInstance.chart.on('symbol', (payload: unknown) => {
        const p = payload as { symbol?: string; exchange?: string } | undefined;
        const sym = p?.symbol ?? widgetInstance?.symbol() ?? options.symbol;
        const ex = p?.exchange ?? widgetInstance?.exchange() ?? '';
        const intv = widgetInstance?.interval() ?? options.interval;
        notifyChange(sym, intv, ex);
      });

      widgetInstance.chart.on('interval_change', (newInterval: unknown) => {
        const sym = widgetInstance?.symbol() ?? options.symbol;
        const ex = widgetInstance?.exchange() ?? '';
        const intv = typeof newInterval === 'string' ? newInterval : (widgetInstance?.interval() ?? options.interval);
        notifyChange(sym, intv, ex);
      });

      return {
        destroy() {
          if (widgetInstance) {
            widgetInstance.destroy();
            widgetInstance = null;
          }
        },
        resize(w: number, h: number) {
          if (widgetInstance && w > 0 && h > 0) {
            widgetInstance.chart.resize(w, h);
          }
        },
        onTitleChange(cb) {
          titleChangeCb = cb;
        },
        onLinkBroadcast(cb) {
          linkBroadcastCb = cb;
        },
        onLinkUpdate(ctx: LinkContext) {
          if (widgetInstance) {
            if (ctx.symbol) {
              widgetInstance.setSymbol(ctx.symbol, ctx.exchange); // none keeps the chart's exchange
            }
            if (ctx.interval) {
              widgetInstance.setInterval(ctx.interval);
            }
          }
        },
        state() {
          return {
            symbol: widgetInstance?.symbol() ?? options.symbol,
            interval: widgetInstance?.interval() ?? options.interval,
            chartState: widgetInstance?.getState(),
          };
        },
        restore(raw: unknown) {
          if (raw && typeof raw === 'object' && widgetInstance) {
            const s = raw as Record<string, unknown>;
            if (typeof s.symbol === 'string') {
              options.symbol = s.symbol;
              widgetInstance.setSymbol(s.symbol);
            }
            if (typeof s.interval === 'string') {
              options.interval = s.interval;
              widgetInstance.setInterval(s.interval);
            }
            if (s.chartState) {
              widgetInstance.restoreState(s.chartState);
            }
          }
        },
      };
    },
    onLinkUpdate(ctx: LinkContext) {
      if (ctx.symbol) options.symbol = ctx.symbol;
      if (ctx.interval) options.interval = ctx.interval;
      if (widgetInstance) {
        if (ctx.symbol) widgetInstance.setSymbol(ctx.symbol, ctx.exchange);
        if (ctx.interval) widgetInstance.setInterval(ctx.interval);
      }
    },
    state() {
      return {
        symbol: widgetInstance?.symbol() ?? options.symbol,
        interval: widgetInstance?.interval() ?? options.interval,
        chartState: widgetInstance?.getState(),
        linkGroup: options.linkGroup,
      };
    },
    restore(raw: unknown) {
      if (raw && typeof raw === 'object') {
        const s = raw as Record<string, unknown>;
        if (typeof s.symbol === 'string') {
          options.symbol = s.symbol;
          if (widgetInstance) widgetInstance.setSymbol(s.symbol);
        }
        if (typeof s.interval === 'string') {
          options.interval = s.interval;
          if (widgetInstance) widgetInstance.setInterval(s.interval);
        }
        if (s.chartState && widgetInstance) {
          widgetInstance.restoreState(s.chartState);
        }
      }
    },
  };
}

export interface SimplePanelOptions {
  id?: string;
  type: 'watchlist' | 'news' | 'data' | 'objects' | 'orders' | 'positions' | 'custom';
  title: string;
  minWidth?: number;
  minHeight?: number;
  linkGroup?: LinkColor | null;
  mountContent(host: HTMLElement): { destroy(): void };
}

export function createSimpleDockPanel(options: SimplePanelOptions): TerminalPanel {
  let contentHandle: { destroy(): void } | null = null;
  const panelId = options.id ?? `${options.type}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;

  return {
    id: panelId,
    type: options.type,
    title: options.title,
    minWidth: options.minWidth ?? 260,
    minHeight: options.minHeight ?? 200,
    linkGroup: options.linkGroup ?? null,
    mount(host: HTMLElement) {
      contentHandle = options.mountContent(host);
      return {
        destroy() {
          contentHandle?.destroy();
          contentHandle = null;
        },
      };
    },
  };
}
