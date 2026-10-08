import {
  type IContentRenderer,
  type GroupPanelPartInitParameters,
  type DockviewPanelApi
} from 'dockview-core';
import { createWidget, type WidgetInstance } from 'openalgo-charts/widget';
import type { DataFeed } from 'openalgo-charts';
import { SAMPLE_NOW } from '../../sample-feed';

// Alias for framework-agnostic panel renderer contract
export type IDockviewPanelRenderer = IContentRenderer;

export interface ChartPanelParameters {
  symbol: string;
  interval: string;
  feed?: DataFeed;
}

export class ChartPanel implements IDockviewPanelRenderer {
  private readonly _element: HTMLElement;
  private _chartContainer: HTMLElement | null = null;
  private _widget: WidgetInstance | null = null;
  private _resizeObserver: ResizeObserver | null = null;

  private readonly _defaultFeed?: DataFeed | undefined;
  private readonly _onChange?: (() => void) | undefined;

  /** `onChange` runs after the chart's symbol or interval changes, so the host can save its layout. */
  constructor(defaultFeed?: DataFeed, onChange?: () => void) {
    this._defaultFeed = defaultFeed;
    this._onChange = onChange;
    this._element = document.createElement('div');
    this._element.style.width = '100%';
    this._element.style.height = '100%';
    this._element.style.overflow = 'hidden';
    this._element.style.display = 'flex';
    this._element.style.flexDirection = 'column';
    this._element.style.minHeight = '0';
    this._element.style.minWidth = '0';
    this._element.style.position = 'relative';
  }

  get element(): HTMLElement {
    return this._element;
  }

  public init(params: GroupPanelPartInitParameters): void {
    const api = params.api as DockviewPanelApi;
    const config = params.params as unknown as ChartPanelParameters;

    this._chartContainer = document.createElement('div');
    this._chartContainer.style.width = '100%';
    this._chartContainer.style.height = '100%';
    this._chartContainer.style.overflow = 'hidden';
    this._chartContainer.style.minHeight = '0';
    this._chartContainer.style.minWidth = '0';
    this._chartContainer.style.position = 'relative';
    this._chartContainer.style.flex = '1 1 0%';
    this._element.appendChild(this._chartContainer);

    const feed = (config.feed && typeof (config.feed as unknown as { getBars?: unknown }).getBars === 'function')
      ? config.feed
      : this._defaultFeed;
    if (!feed) {
      throw new Error('ChartPanel: missing market data feed instance');
    }

    // Initialize OpenAlgo Charts Widget with isolated storage
    this._widget = createWidget(this._chartContainer, {
      feed,
      symbol: config.symbol,
      interval: config.interval,
      theme: 'dark',
      mobile: 'never',
      persist: false,
      now: () => SAMPLE_NOW,
      lookbackBars: 10000,
    });

    // Handle dynamic resize when splitters drag or windows snap
    this._resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && this._widget?.chart) {
          this._widget.chart.resize(width, height);
        }
      }
    });

    this._resizeObserver.observe(this._chartContainer);

    const updateTitle = () => {
      const sym = this._widget?.symbol?.() ?? config.symbol;
      const intv = this._widget?.interval?.() ?? config.interval;
      config.symbol = sym;
      config.interval = intv;
      api.updateParameters({ symbol: sym, interval: intv });
      api.setTitle(`${sym} (${intv})`);
      // A parameter change is no layout change, so the host's layout listener would miss it.
      this._onChange?.();
    };
    this._widget.chart.on('symbol_change', updateTitle);
    this._widget.chart.on('interval_change', updateTitle);
  }

  public dispose(): void {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    if (this._widget) {
      this._widget.destroy();
      this._widget = null;
    }

    if (this._chartContainer && this._chartContainer.parentNode) {
      this._chartContainer.parentNode.removeChild(this._chartContainer);
      this._chartContainer = null;
    }
  }
}
