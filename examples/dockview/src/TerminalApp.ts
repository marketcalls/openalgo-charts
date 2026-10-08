import {
  createDockview,
  type DockviewApi,
  type SerializedDockview,
  type AddPanelOptions
} from 'dockview-core';
import 'dockview-core/dist/styles/dockview.css';
import { OpenAlgoDataFeed, type DataFeed } from 'openalgo-charts';
import { ChartPanel, type ChartPanelParameters } from './ChartPanel';

export class TerminalApp {
  private _api: DockviewApi | null = null;
  private _container: HTMLElement;
  private _feed: DataFeed;
  private readonly STORAGE_KEY = 'mmt_terminal_layout_v1';

  constructor(containerElementId: string, customFeed?: DataFeed) {
    const el = document.getElementById(containerElementId);
    if (!el) {
      throw new Error(`Root element with id "${containerElementId}" was not found.`);
    }
    this._container = el;

    // Shared market data feed
    this._feed = customFeed ?? new OpenAlgoDataFeed({
      baseUrl: 'http://127.0.0.1:5000',
      apiKey: 'YOUR_API_KEY'
    });

    this.initLayout();
  }

  private initLayout(): void {
    this._api = createDockview(this._container, {
      createComponent: (options) => {
        if (options.name === 'chart_panel') {
          return new ChartPanel(this._feed, () => this.saveLayout());
        }
        throw new Error(`Unsupported component type: ${options.name}`);
      }
    });

    // Auto-save layout state on dock / drop / resize
    this._api.onDidLayoutChange(() => {
      this.saveLayout();
    });

    const restored = this.loadLayout();
    if (!restored) {
      this.setupDefaultGrid();
    }
  }

  public addChart(
    symbol: string,
    interval: string,
    referencePanelId?: string,
    direction: 'left' | 'right' | 'above' | 'below' | 'within' = 'right'
  ): void {
    if (!this._api) return;

    const id = `chart_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const params: ChartPanelParameters = {
      symbol,
      interval
    };

    const referencePanel = referencePanelId
      ? this._api.getPanel(referencePanelId)
      : undefined;

    const panelOptions: AddPanelOptions<ChartPanelParameters> = {
      id,
      component: 'chart_panel',
      title: `${symbol} (${interval})`,
      params,
    };
    if (referencePanel) {
      panelOptions.position = { referencePanel, direction };
    }
    this._api.addPanel(panelOptions);
  }

  private setupDefaultGrid(): void {
    if (!this._api) return;

    // 1. Primary Left Chart
    const p1 = this._api.addPanel({
      id: 'panel_nifty',
      component: 'chart_panel',
      title: 'NIFTY (5m)',
      params: { symbol: 'NIFTY', interval: '5m' }
    });

    // 2. Right Top Chart (snapped to the right of panel 1)
    const p2 = this._api.addPanel({
      id: 'panel_banknifty',
      component: 'chart_panel',
      title: 'BANKNIFTY (15m)',
      params: { symbol: 'BANKNIFTY', interval: '15m' },
      position: { referencePanel: p1, direction: 'right' }
    });

    // 3. Right Bottom Chart (snapped below panel 2)
    this._api.addPanel({
      id: 'panel_reliance',
      component: 'chart_panel',
      title: 'RELIANCE (1h)',
      params: { symbol: 'RELIANCE', interval: '1h' },
      position: { referencePanel: p2, direction: 'below' }
    });
  }

  public saveLayout(): void {
    if (!this._api) return;
    try {
      const layout = this._api.toJSON();
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // Ignore storage quota / security errors
    }
  }

  public loadLayout(): boolean {
    if (!this._api) return false;
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as SerializedDockview;
      this._api.fromJSON(parsed);
      return true;
    } catch {
      return false;
    }
  }

  public resetLayout(): void {
    if (!this._api) return;
    this._api.clear();
    try {
      localStorage.removeItem(this.STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
    this.setupDefaultGrid();
  }
}
