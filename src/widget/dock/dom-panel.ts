/**
 * Standalone DOM Ladder Panel.
 *
 * An independent, high-frequency depth-of-market ladder panel with its own
 * scroll positioning, price anchoring, order placement affordance, and
 * liquidity heatmaps. Uses shared tick schedules without loading the trade tier.
 */

import { FrameTask } from './frame-task';
import { DomLadderView } from './ladder-view';
import { injectTerminalStyles } from './styles';
import type { MarketDepth } from '../../feed/types';
import { aggregateDepthRows, depthBucket } from '../../feed/depth-rows';
import type { TickSchedule } from '../../index';
import type { DomLadderRow, LinkContext, StandaloneDomOptions, TerminalPanel } from './types';

/**
 * Capability tier from the live market depth payload.
 */
export function ladderCapability(depth: MarketDepth | null | undefined): 'none' | 'compact' | 'deep' {
  if (!depth) return 'none';
  const n = Math.max(depth.bids.length, depth.asks.length);
  if (n === 0) return 'none';
  return n <= 5 ? 'compact' : 'deep';
}

/**
 * Aggregates depth bids and asks into discrete price ladder rows.
 */
export function buildDomRows(
  depth: MarketDepth | null | undefined,
  tickSize: number | TickSchedule,
  groupBy = 1
): DomLadderRow[] {
  if (!depth || (!depth.bids.length && !depth.asks.length)) return [];
  // The same row building as the trade tier's ladder; an object without `round` keeps raw prices.
  return aggregateDepthRows(depth, depthBucket(tickSize, groupBy) ?? ((p: number): number => p));
}

export class StandaloneDomLadder {
  private readonly _doc: Document;
  private readonly _el: HTMLElement;
  private readonly _tableContainer: HTMLElement;
  private readonly _opts: StandaloneDomOptions;
  private _depth: MarketDepth | null = null;
  private _currentLtp: number | null = null;
  private _groupBy: number;
  private _orderQty = 1;
  private _autoCenter = true;
  private readonly _view: DomLadderView;
  private readonly _frame: FrameTask;
  private readonly _summary: HTMLElement;
  private _depthDirty = true;
  private _destroyed = false;

  constructor(opts: StandaloneDomOptions) {
    this._opts = opts;
    this._doc = opts.document ?? (typeof document !== 'undefined' ? document : (globalThis as unknown as { document: Document }).document);
    this._groupBy = Math.max(1, opts.groupBy ?? 1);
    this._depth = opts.depth ?? null;

    if (this._depth) {
      if (typeof this._depth.ltp === 'number' && Number.isFinite(this._depth.ltp)) {
        this._currentLtp = this._depth.ltp;
      } else if (this._depth.bids.length > 0 && this._depth.asks.length > 0) {
        this._currentLtp = (this._depth.bids[0]!.price + this._depth.asks[0]!.price) / 2;
      } else if (this._depth.bids.length > 0) {
        this._currentLtp = this._depth.bids[0]!.price;
      } else if (this._depth.asks.length > 0) {
        this._currentLtp = this._depth.asks[0]!.price;
      }
    }

    this._el = this._doc.createElement('div');
    this._el.className = 'oac-dom-panel';
    injectTerminalStyles(this._doc);

    // 1. Controls Topbar
    const toolbar = this.renderToolbar();
    this._el.appendChild(toolbar);

    // 2. Action buttons bar (Buy Mkt, Sell Mkt, Flatten)
    const actionBar = this.renderActionBar();
    this._el.appendChild(actionBar);

    // 3. Ladder Grid Container
    this._tableContainer = this._doc.createElement('div');
    this._tableContainer.className = 'oac-dom-ladder-container';
    this._el.appendChild(this._tableContainer);

    this._view = new DomLadderView(this._tableContainer);
    this._summary = this._doc.createElement('div');
    this._summary.className = 'oac-dom-summary';
    this._el.appendChild(this._summary);
    this._frame = new FrameTask(this._doc, () => this.paint());
    this._tableContainer.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('.oac-dom-cell-btn') as HTMLElement | null;
      if (!button || !this._tableContainer.contains(button)) return;
      event.stopPropagation();
      const side = button.dataset.side, price = Number(button.dataset.price);
      if ((side === 'buy' || side === 'sell') && Number.isFinite(price)) {
        this._opts.onOrder?.(side, 'limit', price, this._orderQty);
      }
    });
    this.bindScrollEvents();

    this.rebuild();
  }

  get element(): HTMLElement {
    return this._el;
  }

  public setDepth(depth: MarketDepth): void {
    if (this._destroyed) return;
    this._depth = depth;
    if (typeof depth.ltp === 'number' && Number.isFinite(depth.ltp)) {
      this._currentLtp = depth.ltp;
    } else if (depth.bids.length > 0 && depth.asks.length > 0) {
      this._currentLtp = (depth.bids[0]!.price + depth.asks[0]!.price) / 2;
    } else if (depth.bids.length > 0) {
      this._currentLtp = depth.bids[0]!.price;
    } else if (depth.asks.length > 0) {
      this._currentLtp = depth.asks[0]!.price;
    } else this._currentLtp = null;
    this.rebuild();
  }

  public setGroupBy(value: number): void {
    if (!Number.isInteger(value) || value < 1 || value > 1000 || this._destroyed) return;
    this._groupBy = value; this._opts.groupBy = value;
    const select = this._el.querySelector<HTMLSelectElement>('.oac-dom-select');
    if (select) {
      if (![...select.querySelectorAll('option')].some(option => option.value === String(value))) {
        const option = this._doc.createElement('option'); option.value = String(value); option.textContent = `${value}T`; select.appendChild(option);
      }
      select.value = String(value);
    }
    this.rebuild();
  }

  public setLtp(price: number): void {
    if (!Number.isFinite(price) || this._destroyed) return;
    this._currentLtp = price;
    this._frame.schedule();
  }

  public setSymbol(symbol: string): void {
    this._opts.symbol = symbol;
    const titleEl = this._el.querySelector('.oac-dom-symbol');
    if (titleEl) titleEl.textContent = symbol;
  }

  private renderToolbar(): HTMLElement {
    const bar = this._doc.createElement('div');
    bar.className = 'oac-dom-toolbar';

    const left = this._doc.createElement('div');
    left.className = 'oac-dom-toolbar-left';

    const symbol = this._doc.createElement('span');
    symbol.className = 'oac-dom-symbol';
    symbol.textContent = this._opts.symbol;

    const tierBadge = this._doc.createElement('span');
    tierBadge.className = 'oac-dom-tier-badge';
    tierBadge.textContent = this._depth ? ladderCapability(this._depth).toUpperCase() : 'NO DEPTH';

    left.append(symbol, tierBadge);

    const right = this._doc.createElement('div');
    right.className = 'oac-dom-toolbar-right';

    // Group By selector
    const groupSelect = this._doc.createElement('select');
    groupSelect.className = 'oac-dom-select';
    for (const g of [1, 2, 5, 10]) {
      const opt = this._doc.createElement('option');
      opt.value = String(g);
      opt.textContent = `${g}T`;
      if (g === this._groupBy) opt.selected = true;
      groupSelect.appendChild(opt);
    }
    groupSelect.addEventListener('change', () => {
      this.setGroupBy(parseInt(groupSelect.value, 10));
    });

    // Center button
    const centerBtn = this._doc.createElement('button');
    centerBtn.type = 'button';
    centerBtn.className = 'oac-dom-btn oac-dom-btn--secondary';
    centerBtn.textContent = 'Center';
    centerBtn.title = 'Recenter ladder to current price';
    centerBtn.addEventListener('click', () => {
      this._autoCenter = true;
      this.centerOnLtp();
    });

    right.append(groupSelect, centerBtn);
    bar.append(left, right);
    return bar;
  }

  private renderActionBar(): HTMLElement {
    const bar = this._doc.createElement('div');
    bar.className = 'oac-dom-actionbar';

    const buyMkt = this._doc.createElement('button');
    buyMkt.type = 'button';
    buyMkt.className = 'oac-dom-btn oac-dom-btn--buy';
    buyMkt.textContent = 'Buy Mkt';
    buyMkt.addEventListener('click', () => {
      this._opts.onOrder?.('buy', 'market', this._currentLtp ?? 0, this._orderQty);
    });

    const sellMkt = this._doc.createElement('button');
    sellMkt.type = 'button';
    sellMkt.className = 'oac-dom-btn oac-dom-btn--sell';
    sellMkt.textContent = 'Sell Mkt';
    sellMkt.addEventListener('click', () => {
      this._opts.onOrder?.('sell', 'market', this._currentLtp ?? 0, this._orderQty);
    });

    const cancelAll = this._doc.createElement('button');
    cancelAll.type = 'button';
    cancelAll.className = 'oac-dom-btn oac-dom-btn--cancel';
    cancelAll.textContent = 'Cancel';
    cancelAll.addEventListener('click', () => {
      this._opts.onCancelAll?.();
    });

    const flatten = this._doc.createElement('button');
    flatten.type = 'button';
    flatten.className = 'oac-dom-btn oac-dom-btn--flatten';
    flatten.textContent = 'Flatten';
    flatten.addEventListener('click', () => {
      this._opts.onFlatten?.();
    });

    bar.append(buyMkt, sellMkt, cancelAll, flatten);
    return bar;
  }

  private rebuild(): void {
    this._depthDirty = true;
    this._frame.schedule();
  }

  private paint(): void {
    if (this._destroyed) return;
    if (this._depthDirty) {
      const ticks = this._opts.tickSchedule ?? this._opts.tickSize ?? 0.05;
      this._view.setTick(typeof ticks === 'number' ? ticks : ticks.minMove);
      this._view.setRows(buildDomRows(this._depth, ticks, this._groupBy));
      this._depthDirty = false;
      const badge = this._el.querySelector('.oac-dom-tier-badge');
      if (badge) badge.textContent = this._depth ? ladderCapability(this._depth).toUpperCase() : 'NO DEPTH';
      const bid = this._depth?.bids.reduce((total, level) => total + level.qty, 0) ?? 0;
      const ask = this._depth?.asks.reduce((total, level) => total + level.qty, 0) ?? 0;
      const spread = this._depth?.bids[0] && this._depth.asks[0]
        ? this._view.formatPrice(this._depth.asks[0].price - this._depth.bids[0].price) : '--';
      this._summary.textContent = this._depth ? `Spread ${spread}  |  Bid ${bid}  Ask ${ask}`
        : 'Waiting for market depth';
    }
    this._view.setLtp(this._currentLtp);
    if (this._autoCenter) this._view.center();
    this._view.render();
  }

  private centerOnLtp(): void {
    this._frame.schedule();
  }

  private bindScrollEvents(): void {
    this._tableContainer.addEventListener('pointerdown', (event) => {
      if (!(event.target as HTMLElement).closest('.oac-dom-cell-btn')) this._autoCenter = false;
    });
    this._tableContainer.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) this._autoCenter = false;
    });
    this._tableContainer.addEventListener('scroll', () => this._frame.schedule(), { passive: true });
    this._tableContainer.addEventListener('wheel', () => {
      this._autoCenter = false;
    }, { passive: true });
  }

  public resize(): void { this._frame.schedule(); }

  public destroy(): void {
    this._destroyed = true;
    this._frame.cancel();
    if (this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
  }
}

export interface StandaloneDomPanel extends TerminalPanel {
  setDepth(depth: MarketDepth): void;
  setLtp(price: number): void;
  setSymbol(symbol: string): void;
}

/**
 * Factory creating a standalone DOM panel complying with the TerminalPanel interface.
 */
export function createStandaloneDomPanel(options: StandaloneDomOptions): StandaloneDomPanel {
  let instance: StandaloneDomLadder | null = null;
  let titleChangeCb: ((title: string) => void) | null = null;

  const panel: StandaloneDomPanel = {
    id: options.id ?? `dom_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`,
    type: 'dom',
    title: `DOM ${options.symbol}`,
    minWidth: 260,
    minHeight: 300,
    linkGroup: options.linkGroup ?? null,
    mount(host: HTMLElement) {
      instance = new StandaloneDomLadder(options);
      host.appendChild(instance.element);
      return {
        destroy() {
          instance?.destroy();
          instance = null;
        },
        resize() {
          instance?.resize();
        },
        onTitleChange(cb) {
          titleChangeCb = cb;
        },
        onLinkUpdate(ctx: LinkContext) {
          if (ctx.symbol) {
            panel.setSymbol(ctx.symbol);
          }
        },
        state() {
          return {
            symbol: options.symbol,
            groupBy: options.groupBy,
          };
        },
        restore(raw: unknown) { panel.restore?.(raw); },
      };
    },
    setDepth(depth: MarketDepth) {
      options.depth = depth;
      instance?.setDepth(depth);
    },
    setLtp(price: number) {
      instance?.setLtp(price);
    },
    setSymbol(symbol: string) {
      options.symbol = symbol;
      panel.title = `DOM ${symbol}`;
      titleChangeCb?.(`DOM ${symbol}`);
      instance?.setSymbol(symbol);
    },
    onLinkUpdate(ctx: LinkContext) {
      if (ctx.symbol) {
        panel.setSymbol(ctx.symbol);
      }
    },
    state() {
      return {
        symbol: options.symbol,
        groupBy: options.groupBy,
        linkGroup: options.linkGroup,
      };
    },
    restore(raw: unknown) {
      if (raw && typeof raw === 'object') {
        const s = raw as Record<string, unknown>;
        if (typeof s.symbol === 'string') panel.setSymbol(s.symbol);
        if (typeof s.groupBy === 'number' && Number.isInteger(s.groupBy) && s.groupBy >= 1 && s.groupBy <= 1000) {
          options.groupBy = s.groupBy; instance?.setGroupBy(s.groupBy);
        }
      }
    },
  };

  return panel;
}
