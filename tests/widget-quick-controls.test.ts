/**
 * Four controls the widget gained together: rows a host adds to the
 * right-click menu, full screen from the top bar, a study's placement and
 * stacking from its menu, and the choice between regular and extended hours
 * in the bottom bar. Each is drawn only where something stands behind it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Bar, ContextMenuEvent, DataFeed, DataVariantCapabilities } from '../src/index';
import '../src/indicators/index';
import { contextMenuEntries, createWidget, type MenuItem, type Widget, type WidgetOptions } from '../src/widget/index';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument, fire, FakeElement, type FakeDocument } from './helpers/fake-dom-widget';

beforeAll(ensureWindowGlobal);
const widgets: Widget[] = [];
afterEach(() => { for (const widget of widgets.splice(0)) widget.destroy(); });

const BARS: Bar[] = Array.from({ length: 60 }, (_, i) => ({ time: 1_700_000_000 + i * 300, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10 }));

function make(options: WidgetOptions = {}, document: FakeDocument = fakeWidgetDocument()): Widget {
  const widget = createWidget(fakeContainer(document) as unknown as HTMLElement, {
    document: document as unknown as Document, mobile: 'never', symbol: 'AAPL', exchange: 'US',
    raf: { schedule: callback => { callback(); return 1; }, cancel: () => {} }, ...options,
  });
  widget.chart.applySize(800, 600);
  if (options.feed === undefined) widget.series.setData(BARS);
  widgets.push(widget);
  return widget;
}
const root = (widget: Widget): FakeElement => widget.root as unknown as FakeElement;
const event = (target: Record<string, unknown> = { kind: 'series', id: null, seriesType: 'candlestick' }): ContextMenuEvent => {
  let prevented = 0;
  return { target, paneIndex: 0, price: 100, index: 0, time: BARS[0]!.time, point: { x: 100, y: 100 },
    preventDefault: () => { prevented++; }, prevented: () => prevented } as unknown as ContextMenuEvent;
};
const ids = (widget: Widget, e: ContextMenuEvent): string[] =>
  contextMenuEntries(widget.context, e, {}).filter((item): item is MenuItem => 'id' in item && item.id !== undefined).map(item => item.id!);
const settled = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe('rows a host adds to the right-click menu', () => {
  it('reach the menu the chart event opens, with the event that raised it', () => {
    const run = vi.fn();
    const contextMenuItems = vi.fn((_event: ContextMenuEvent) => [{ id: 'host-row', label: 'Send to scanner', run }]);
    const widget = make({ contextMenuItems });
    const e = event();
    widget.chart.emit('contextmenu', e);
    expect(contextMenuItems).toHaveBeenCalledWith(e);
    const row = root(widget).querySelector('[data-act="host-row"]');
    expect(row?.textContent).toContain('Send to scanner');
    fire(row!, 'click');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a hook that throws adds nothing and keeps the chart rows', () => {
    const widget = make({ contextMenuItems: () => { throw new Error('host bug'); } });
    widget.chart.emit('contextmenu', event());
    expect(root(widget).querySelector('[data-act="chart-settings"]')).not.toBeNull();
  });

  it('draws no extra row without the option', () => {
    const widget = make();
    widget.chart.emit('contextmenu', event());
    expect(root(widget).querySelector('[data-act="host-row"]')).toBeNull();
    expect(root(widget).querySelector('[data-act="chart-settings"]')).not.toBeNull();
  });
});

describe('full screen from the top bar', () => {
  /** A document that may enter full screen, and a record of which element holds it. */
  function fullscreenDocument(): { document: FakeDocument; holder: () => FakeElement | null; restore: () => void } {
    const document = fakeWidgetDocument();
    let holder: FakeElement | null = null;
    Object.defineProperty(document, 'fullscreenEnabled', { value: true });
    Object.defineProperty(document, 'fullscreenElement', { get: () => holder });
    const change = (next: FakeElement | null): Promise<void> => { holder = next; fire(document, 'fullscreenchange'); return Promise.resolve(); };
    Object.assign(document, { exitFullscreen: () => change(null) });
    const proto = FakeElement.prototype as unknown as { requestFullscreen?: () => Promise<void> };
    proto.requestFullscreen = function (this: FakeElement) { return change(this); };
    return { document, holder: () => holder, restore: () => { delete proto.requestFullscreen; } };
  }

  it('is left out where the page cannot enter full screen, and unless the host asks for it', () => {
    expect(root(make({ fullscreen: true })).querySelector('.oac-topbar__fullscreen')).toBeNull();
    const page = fullscreenDocument();
    try {
      // A host that draws its order ticket outside the widget would lose it in full screen.
      expect(root(make({}, page.document)).querySelector('.oac-topbar__fullscreen')).toBeNull();
      expect(root(make({ fullscreen: false }, page.document)).querySelector('.oac-topbar__fullscreen')).toBeNull();
    } finally { page.restore(); }
  });

  it('puts the element the host names on the display, so its own chrome comes along', () => {
    const page = fullscreenDocument();
    try {
      const shell = page.document.createElement('div');
      page.document.body.appendChild(shell);
      const widget = make({ fullscreen: shell as unknown as HTMLElement }, page.document);
      const button = root(widget).querySelector('.oac-topbar__fullscreen')!;
      fire(button, 'click');
      expect(page.holder()).toBe(shell);
      expect(button.getAttribute('aria-pressed')).toBe('true');
    } finally { page.restore(); }
  });

  it('puts the widget on the whole display and brings it back', () => {
    const page = fullscreenDocument();
    try {
      const widget = make({ fullscreen: true }, page.document);
      const button = root(widget).querySelector('.oac-topbar__fullscreen')!;
      expect(button.getAttribute('aria-pressed')).toBe('false');
      fire(button, 'click');
      expect(page.holder()).toBe(root(widget));
      expect(button.getAttribute('aria-pressed')).toBe('true');
      fire(button, 'click');
      expect(page.holder()).toBeNull();
      expect(button.getAttribute('aria-pressed')).toBe('false');
    } finally { page.restore(); }
  });

  it('follows a change it did not make, and stops listening once destroyed', () => {
    const page = fullscreenDocument();
    try {
      const widget = make({ fullscreen: true }, page.document);
      const button = root(widget).querySelector('.oac-topbar__fullscreen')!;
      void (root(widget) as unknown as { requestFullscreen(): Promise<void> }).requestFullscreen();
      expect(button.getAttribute('aria-pressed')).toBe('true');
      void (page.document as unknown as { exitFullscreen(): Promise<void> }).exitFullscreen();
      expect(button.getAttribute('aria-pressed')).toBe('false');
      widget.destroy();
      expect(() => fire(page.document, 'fullscreenchange')).not.toThrow();
    } finally { page.restore(); }
  });

  it('says so when the browser refuses', async () => {
    const page = fullscreenDocument();
    const proto = FakeElement.prototype as unknown as { requestFullscreen?: () => Promise<void> };
    try {
      const widget = make({ fullscreen: true }, page.document);
      proto.requestFullscreen = () => Promise.reject(new Error('denied'));
      fire(root(widget).querySelector('.oac-topbar__fullscreen')!, 'click');
      await settled();
      expect(root(widget).textContent).toContain('The browser refused full screen');
    } finally { page.restore(); }
  });
});

describe('a study placed and stacked from its menu', () => {
  const on = (instanceId: string): ContextMenuEvent => event({ kind: 'indicator', id: instanceId, instanceId });
  const run = (widget: Widget, e: ContextMenuEvent, id: string): void => {
    const row = contextMenuEntries(widget.context, e, {}).find((item): item is MenuItem => 'id' in item && item.id === id);
    row!.run!();
  };

  it('moves a price overlay to a pane of its own and back', () => {
    const widget = make();
    const ema = widget.chart.addIndicator('ema');
    const price = widget.chart.primaryPaneIndex();
    expect(ema.paneIndex).toBe(price);
    expect(ids(widget, on(ema.id))).toContain('ind-new-pane');
    expect(ids(widget, on(ema.id))).not.toContain('ind-price-pane');
    run(widget, on(ema.id), 'ind-new-pane');
    expect(ema.paneIndex).not.toBe(price);
    expect(widget.chart.panes()).toHaveLength(2);
    expect(ids(widget, on(ema.id))).toContain('ind-price-pane');
    expect(ids(widget, on(ema.id))).not.toContain('ind-new-pane');
    run(widget, on(ema.id), 'ind-price-pane');
    expect(ema.paneIndex).toBe(widget.chart.primaryPaneIndex());
    expect(widget.chart.panes()).toHaveLength(1);
  });

  it('does not offer the price pane to a study that reads on its own scale', () => {
    const widget = make();
    const rsi = widget.chart.addIndicator('rsi');
    const rows = ids(widget, on(rsi.id));
    expect(rows).not.toContain('ind-price-pane');
    // Alone in its pane already, so a new pane would change nothing.
    expect(rows).not.toContain('ind-new-pane');
  });

  it('offers a stacking step only where there is a neighbour to step past', () => {
    const widget = make();
    const first = widget.chart.addIndicator('ema');
    expect(ids(widget, on(first.id)).filter(id => id === 'ind-forward' || id === 'ind-backward')).toEqual([]);
    const second = widget.chart.addIndicator('sma');
    expect(ids(widget, on(first.id))).toContain('ind-forward');
    expect(ids(widget, on(first.id))).not.toContain('ind-backward');
    expect(ids(widget, on(second.id))).toContain('ind-backward');
    run(widget, on(first.id), 'ind-forward');
    expect(widget.chart.indicators().map(i => i.id)).toEqual([second.id, first.id]);
    run(widget, on(first.id), 'ind-backward');
    expect(widget.chart.indicators().map(i => i.id)).toEqual([first.id, second.id]);
  });

  it('withholds every placement row from a study its host pinned', () => {
    const widget = make();
    const ema = widget.chart.addIndicator('ema');
    widget.chart.addIndicator('sma');
    ema.setPolicy({ movable: false });
    expect(ids(widget, on(ema.id)).filter(id => /^ind-(new-pane|price-pane|forward|backward)$/.test(id))).toEqual([]);
  });
});

describe('regular or extended hours in the bottom bar', () => {
  interface Probe { symbol: string; interval: string; answer(capabilities: DataVariantCapabilities): void }
  function variantFeed(reply?: (probe: { symbol: string }) => DataVariantCapabilities | Promise<DataVariantCapabilities>): { feed: DataFeed; variants: (string | undefined)[]; probes: Probe[] } {
    const variants: (string | undefined)[] = [];
    const probes: Probe[] = [];
    const feed: DataFeed = {
      getBars: async request => { variants.push(request.variant?.session); return BARS; },
      ...(reply === undefined ? {} : {
        dataVariants: (query) => {
          const answer = reply(query);
          if (!(answer instanceof Promise)) return answer;
          return new Promise<DataVariantCapabilities>(resolve => { probes.push({ symbol: query.symbol, interval: query.interval, answer: resolve }); });
        },
      }),
    };
    return { feed, variants, probes };
  }
  const BOTH: DataVariantCapabilities = { sessions: ['regular', 'extended'] };
  const control = (widget: Widget): FakeElement => root(widget).querySelector('.oac-bottombar__session')!;
  const choose = (widget: Widget, label: string): void => {
    fire(control(widget), 'click');
    const row = root(widget).querySelectorAll('.oac-menu button').find(button => button.textContent?.includes(label));
    fire(row!, 'click');
  };

  it('is left out for a source that declares no variants, or one session', async () => {
    const plain = make({ feed: variantFeed().feed, interval: '5m' });
    await settled();
    expect(control(plain).hidden).toBe(true);
    const single = make({ feed: variantFeed(() => ({ sessions: ['regular'] })).feed, interval: '5m' });
    await settled();
    expect(control(single).hidden).toBe(true);
  });

  it('asks the source for the series the user picks, and marks only an explicit choice', async () => {
    const source = variantFeed(() => BOTH);
    const widget = make({ feed: source.feed, interval: '5m' });
    await settled();
    expect(control(widget).hidden).toBe(false);
    // The source's default is on screen: neither session is claimed.
    expect(control(widget).dataset.session).toBeUndefined();
    choose(widget, 'With extended hours');
    await settled();
    expect(widget.variant()).toEqual({ session: 'extended' });
    expect(source.variants[source.variants.length - 1]).toBe('extended');
    expect(control(widget).dataset.session).toBe('extended');
    choose(widget, 'Regular hours only');
    await settled();
    expect(widget.variant()).toEqual({ session: 'regular' });
    expect(control(widget).dataset.session).toBe('regular');
  });

  it('keeps the rest of the variant when the session changes', async () => {
    const widget = make({ feed: variantFeed(() => ({ ...BOTH, adjustments: ['adjusted', 'raw'] })).feed, interval: '5m', variant: { adjustment: 'raw' } });
    await settled();
    choose(widget, 'With extended hours');
    expect(widget.variant()).toEqual({ session: 'extended', adjustment: 'raw' });
  });

  it('drops an answer that arrives after the instrument changed', async () => {
    const source = variantFeed(query => (query.symbol === 'AAPL' ? Promise.resolve(BOTH) : {}));
    const widget = make({ feed: source.feed, interval: '5m' });
    await settled();
    expect(source.probes).toHaveLength(1);
    widget.setSymbol('INFY', 'NSE');
    await settled();
    source.probes[0]!.answer(BOTH);
    await settled();
    expect(control(widget).hidden).toBe(true);
  });

  it('asks again for the next interval', async () => {
    const asked: string[] = [];
    const feed: DataFeed = { getBars: async () => BARS, dataVariants: (query) => { asked.push(query.interval); return query.interval === '5m' ? BOTH : {}; } };
    const widget = make({ feed, interval: '5m' });
    await settled();
    expect(control(widget).hidden).toBe(false);
    widget.setInterval('1d');
    await settled();
    expect(asked).toEqual(['5m', '1d']);
    expect(control(widget).hidden).toBe(true);
  });

  it('offers the same choice in the phone layout sheet', async () => {
    const widget = make({ feed: variantFeed(() => BOTH).feed, interval: '5m', mobile: 'always' });
    await settled();
    const more = root(widget).querySelectorAll('button').find(button => button.dataset.mobileAction === 'more');
    fire(more!, 'click');
    const rows = root(widget).querySelectorAll('button').filter(button => button.dataset.mobileAction === 'session');
    expect(rows.map(button => button.textContent)).toEqual(['Regular hours only', 'With extended hours']);
    fire(rows[1]!, 'click');
    expect(widget.variant()).toEqual({ session: 'extended' });
  });

  it('keeps a way back when the chart asks for a session the next interval does not have', async () => {
    const asked: (string | undefined)[] = [];
    const feed: DataFeed = {
      getBars: async request => { asked.push(request.variant?.session); return BARS; },
      dataVariants: query => (query.interval === '5m' ? BOTH : {}),
    };
    const widget = make({ feed, interval: '5m' });
    await settled();
    choose(widget, 'With extended hours');
    await settled();
    widget.setInterval('1d');
    await settled();
    // The source serves no named session on daily bars, so the chart reports
    // the series unavailable. The control must stay, or nothing in the widget
    // could take the chart back to a series the source does serve.
    expect(widget.variant()).toEqual({ session: 'extended' });
    expect(control(widget).hidden).toBe(false);
    fire(control(widget), 'click');
    const rows = root(widget).querySelectorAll('.oac-menu button');
    expect(rows.map(button => button.textContent)).toEqual([
      expect.stringContaining('Regular hours only'), expect.stringContaining('With extended hours'), expect.stringContaining('Source default'),
    ]);
    // A session the source does not serve here cannot be picked.
    fire(rows[0]!, 'click');
    expect(widget.variant()).toEqual({ session: 'extended' });
    fire(control(widget), 'click');
    fire(root(widget).querySelectorAll('.oac-menu button').find(button => button.textContent?.includes('Source default'))!, 'click');
    await settled();
    expect(widget.variant()).toBeUndefined();
    expect(asked[asked.length - 1]).toBeUndefined();
    expect(control(widget).hidden).toBe(true);
  });

  it('tells the source a superseded question is no longer wanted', async () => {
    const signals: AbortSignal[] = [];
    const feed: DataFeed = { getBars: async () => BARS, dataVariants: (query) => { signals.push(query.signal!); return new Promise(() => {}); } };
    const widget = make({ feed, interval: '5m' });
    await settled();
    widget.setInterval('15m');
    await settled();
    expect(signals.map(signal => signal.aborted)).toEqual([true, false]);
    widget.destroy();
    expect(signals[1]!.aborted).toBe(true);
  });
});

describe('the timezone list', () => {
  it('holds valid IANA zones, each once, with the default among them', async () => {
    const { CHART_TIMEZONES } = await import('../src/model/chart-settings');
    const { isValidTimezone } = await import('../src/feed/time');
    expect(new Set(CHART_TIMEZONES).size).toBe(CHART_TIMEZONES.length);
    expect(CHART_TIMEZONES.filter(zone => !isValidTimezone(zone))).toEqual([]);
    expect(CHART_TIMEZONES).toContain('Asia/Kolkata');
    // The zones a chart saved before the list grew are still on it.
    expect(CHART_TIMEZONES).toHaveLength(30);
    for (const zone of ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Hong_Kong',
      'Asia/Tokyo', 'Australia/Sydney', 'America/Sao_Paulo', 'America/New_York', 'America/Chicago', 'America/Los_Angeles']) {
      expect(CHART_TIMEZONES, zone).toContain(zone);
    }
  });
});
