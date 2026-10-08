import type { DomLadderRow } from './types';

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 26;
const OVERSCAN = 6;

interface RowElements {
  element: HTMLElement;
  price: HTMLElement;
  bid: HTMLElement;
  ask: HTMLElement;
  bidBar: HTMLElement;
  askBar: HTMLElement;
  buy: HTMLButtonElement;
  sell: HTMLButtonElement;
}

/**
 * Decimal places that show every price on a grid of `step` (0.05 -> 2, 0.001 -> 3),
 * never fewer than two, so distinct ticks never print as the same label.
 */
export function priceDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 2;
  for (let digits = 0; digits <= 10; digits++) {
    const units = step * 10 ** digits;
    if (Math.abs(units - Math.round(units)) <= 1e-9 * Math.max(1, units)) return Math.max(2, digits);
  }
  return 10;
}

function text(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

/** Keeps both node count and update work bounded by the visible ladder. */
export class DomLadderView {
  private readonly _body: HTMLElement;
  private readonly _top: HTMLElement;
  private readonly _bottom: HTMLElement;
  private _rows: DomLadderRow[] = [];
  private _visible = new Map<number, RowElements>();
  private _maxQty = 1;
  private _nearest = -1;
  private _decimals = 2;

  constructor(private readonly _container: HTMLElement) {
    const doc = _container.ownerDocument;
    const table = doc.createElement('table');
    table.className = 'oac-dom-table';
    table.setAttribute('aria-label', 'Market depth price ladder');
    const head = doc.createElement('thead'), row = doc.createElement('tr');
    for (const [label, cls] of [['Bid Size', 'col-bid-qty'], ['Buy', 'col-bid-action'],
      ['Price', 'col-price'], ['Sell', 'col-ask-action'], ['Ask Size', 'col-ask-qty']]) {
      const cell = doc.createElement('th');
      cell.className = cls!;
      cell.textContent = label!;
      cell.setAttribute('scope', 'col');
      row.appendChild(cell);
    }
    head.appendChild(row);
    this._body = doc.createElement('tbody');
    this._top = this.spacer();
    this._bottom = this.spacer();
    this._body.append(this._top, this._bottom);
    table.append(head, this._body);
    _container.appendChild(table);
  }

  private spacer(): HTMLElement {
    const row = this._container.ownerDocument.createElement('tr');
    row.className = 'oac-dom-spacer';
    row.setAttribute('aria-hidden', 'true');
    const cell = this._container.ownerDocument.createElement('td');
    cell.setAttribute('colspan', '5');
    row.appendChild(cell);
    return row;
  }

  setRows(rows: DomLadderRow[]): void {
    // Establish the scroll range before the first auto-center, when no rows exist yet.
    if (this._rows.length === 0) {
      (this._bottom.firstElementChild as HTMLElement).style.height = `${rows.length * ROW_HEIGHT}px`;
    }
    this._rows = rows;
    this._maxQty = rows.reduce((max, row) => Math.max(max, row.bidQty, row.askQty), 1);
  }

  /** Format prices to the instrument's tick (or a schedule's finest grid). */
  setTick(step: number): void {
    this._decimals = priceDecimals(step);
  }

  formatPrice(price: number): string {
    return price.toFixed(this._decimals);
  }

  setLtp(price: number | null): void {
    this._nearest = -1;
    if (price === null || !Number.isFinite(price)) return;
    let low = 0, high = this._rows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this._rows[mid]!.price > price) low = mid + 1;
      else high = mid;
    }
    const before = Math.max(0, low - 1), after = Math.min(this._rows.length - 1, low);
    if (after >= 0) this._nearest = Math.abs(this._rows[before]!.price - price)
      <= Math.abs(this._rows[after]!.price - price) ? before : after;
  }

  center(): void {
    if (this._nearest < 0) return;
    const height = this._container.clientHeight || 440;
    this._container.scrollTop = Math.max(0, Math.min(
      this._rows.length * ROW_HEIGHT + HEADER_HEIGHT - height,
      HEADER_HEIGHT + this._nearest * ROW_HEIGHT + ROW_HEIGHT / 2 - height / 2
    ));
  }

  render(): void {
    const height = this._container.clientHeight || 440;
    const scroll = this._container.scrollTop || 0;
    const first = Math.max(0, Math.min(this._rows.length, Math.floor(scroll / ROW_HEIGHT) - OVERSCAN));
    const end = Math.min(this._rows.length, first + Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2);
    const prices = new Set(this._rows.slice(first, end).map(row => row.price));
    const spare = [...this._visible.entries()].filter(([price]) => !prices.has(price)).map(([, elements]) => elements);
    const visible = new Map<number, RowElements>();
    let previous = this._top;
    for (let index = first; index < end; index++) {
      const row = this._rows[index]!;
      let elements = this._visible.get(row.price);
      if (!elements) {
        elements = spare.pop() ?? this.createRow();
        const focused = this._container.ownerDocument.activeElement as HTMLElement | null;
        if (focused && elements.element.contains(focused)) focused.blur();
      }
      this.updateRow(elements, row, index === this._nearest);
      if (previous.nextSibling !== elements.element) this._body.insertBefore(elements.element, previous.nextSibling);
      previous = elements.element;
      visible.set(row.price, elements);
    }
    for (const elements of spare) elements.element.remove();
    this._visible = visible;
    (this._top.firstElementChild as HTMLElement).style.height = `${first * ROW_HEIGHT}px`;
    (this._bottom.firstElementChild as HTMLElement).style.height = `${(this._rows.length - end) * ROW_HEIGHT}px`;
  }

  private createRow(): RowElements {
    const doc = this._container.ownerDocument;
    const element = doc.createElement('tr');
    element.className = 'oac-dom-row';
    const cell = (cls: string): HTMLElement => {
      const result = doc.createElement('td');
      result.className = cls;
      element.appendChild(result);
      return result;
    };
    const qty = (side: 'bid' | 'ask'): [HTMLElement, HTMLElement] => {
      const host = cell(`col-${side}-qty`), bar = doc.createElement('div'), label = doc.createElement('span');
      bar.className = `oac-dom-heat-bar oac-dom-heat-bar--${side}`;
      label.className = 'oac-dom-qty-text';
      host.append(bar, label);
      return [label, bar];
    };
    const action = (side: 'buy' | 'sell', cls: string): HTMLButtonElement => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = `oac-dom-cell-btn oac-dom-cell-btn--${side}`;
      button.dataset.side = side;
      button.textContent = 'LMT';
      cell(cls).appendChild(button);
      return button;
    };
    const [bid, bidBar] = qty('bid');
    const buy = action('buy', 'col-bid-action'), price = cell('col-price');
    const sell = action('sell', 'col-ask-action'), [ask, askBar] = qty('ask');
    return { element, price, bid, ask, bidBar, askBar, buy, sell };
  }

  private updateRow(elements: RowElements, row: DomLadderRow, current: boolean): void {
    const price = String(row.price);
    elements.element.dataset.price = price;
    elements.element.classList.toggle('is-ltp', current);
    const label = this.formatPrice(row.price);
    text(elements.price, label);
    text(elements.bid, row.bidQty ? String(row.bidQty) : '');
    text(elements.ask, row.askQty ? String(row.askQty) : '');
    for (const [bar, qty] of [[elements.bidBar, row.bidQty], [elements.askBar, row.askQty]] as const) {
      const width = `${Math.round(qty / this._maxQty * 100)}%`;
      if (bar.style.width !== width) bar.style.width = width;
    }
    for (const button of [elements.buy, elements.sell]) {
      const title = `${button.dataset.side === 'buy' ? 'Buy' : 'Sell'} limit at ${label}`;
      if (button.dataset.price !== price || button.title !== title) {
        button.dataset.price = price;
        button.title = title;
        button.setAttribute('aria-label', button.title);
      }
    }
  }
}
