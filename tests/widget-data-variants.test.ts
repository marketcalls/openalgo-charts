import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Bar, BarsRequest, DataFeed, UnsubscribeFn } from '../src/index';
import { createWidget, type Widget, type WidgetOptions } from '../src/widget/widget';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument, type FakeElement } from './helpers/fake-dom-widget';

// The widget is a host: it picks a variant, carries it into every load, the
// chart's data context and its saved state, and says so when the provider
// does not serve it. It never makes one series out of another.

beforeAll(ensureWindowGlobal);
const live: Widget[] = [];
afterEach(() => { for (const widget of live.splice(0)) widget.destroy(); vi.restoreAllMocks(); });
const bar = (time: number, close = 10): Bar => ({ time, open: 10, high: Math.max(12, close), low: 9, close });
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const last = <T>(items: readonly T[]): T => items[items.length - 1];
const extended = { session: 'extended' as const };
function make(options: WidgetOptions = {}) {
  const doc = fakeWidgetDocument();
  const widget = createWidget(fakeContainer(doc) as unknown as HTMLElement, {
    document: doc as unknown as Document, pixelRatio: () => 1,
    raf: { schedule: cb => { cb(); return 1; }, cancel: () => {} },
    symbol: 'AAA', exchange: 'X', interval: '1m', now: () => 60_000_000, ...options,
  });
  widget.chart.applySize(800, 600);
  live.push(widget);
  return { widget, root: widget.root as unknown as FakeElement, doc };
}
/** Extended hours is a different series: its bars close at 50, the regular ones at 10. */
function sessionFeed(extra: Partial<DataFeed> = {}): DataFeed & { requests: BarsRequest[] } {
  const requests: BarsRequest[] = [];
  return {
    requests,
    dataVariants: () => ({ sessions: ['regular', 'extended'] }),
    getBars: async request => {
      requests.push(request);
      return [bar(60, request.variant?.session === 'extended' ? 50 : 10), bar(120, request.variant?.session === 'extended' ? 51 : 11)];
    },
    ...extra,
  };
}
function memoryStorage() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}

describe('widget data variants', () => {
  it('loads the configured variant and publishes it on the chart context and the saved state', async () => {
    const feed = sessionFeed();
    const { widget } = make({ feed, variant: extended });
    await flush();
    expect(feed.requests.map(request => request.variant)).toEqual([extended]);
    expect(widget.variant()).toEqual(extended);
    expect(widget.chart.getDataContext()).toEqual({ symbol: 'AAA', exchange: 'X', interval: '1m', variant: extended });
    expect(widget.series.getData().map(value => value.close)).toEqual([50, 51]);
    expect(widget.getState().variant).toEqual(extended);
  });

  it('switches variant as a change of source: aborts, clears, reloads and announces it', async () => {
    let released = 0;
    const signals: (AbortSignal | undefined)[] = [];
    let hold = false;
    const feed = sessionFeed({
      subscribeBars: (): UnsubscribeFn => () => { released++; },
    });
    const plain = feed.getBars;
    feed.getBars = request => {
      signals.push(request.signal);
      return hold ? new Promise<Bar[]>(() => {}) : plain(request);
    };
    const { widget } = make({ feed });
    await flush();
    expect(widget.series.getData().map(value => value.close)).toEqual([10, 11]);
    const announced: unknown[] = [];
    widget.on('variant', payload => announced.push(payload));
    // A repair of the regular series is still on the wire when the session switches.
    hold = true;
    void widget.reload();
    await flush();
    widget.setDataVariant(extended);
    expect(last(signals)?.aborted).toBe(true);
    expect(released).toBe(1);
    expect(widget.series.getData()).toEqual([]);
    expect(widget.chart.getDataContext()?.variant).toEqual(extended);
    expect(announced).toEqual([{ variant: extended }]);
    hold = false;
    await flush();
    expect(last(feed.requests)?.variant).toEqual(extended);
    // The same variant again is not a reload.
    const count = feed.requests.length;
    widget.setDataVariant({ session: 'extended' });
    await flush();
    expect(feed.requests).toHaveLength(count);
    // Back to the provider default drops the field altogether.
    widget.setDataVariant(undefined);
    await flush();
    expect(last(feed.requests)).not.toHaveProperty('variant');
    expect(widget.variant()).toBeUndefined();
    expect(widget.chart.getDataContext()).toEqual({ symbol: 'AAA', exchange: 'X', interval: '1m' });
  });

  it('restores a saved variant as another dataset, so the old view is dropped', async () => {
    const feed = sessionFeed();
    const { widget } = make({ feed });
    await flush();
    const saved = { ...widget.getState(), variant: extended };
    const report = widget.restoreState(saved);
    expect(report.applied).toBe(true);
    await flush();
    expect(last(feed.requests)?.variant).toEqual(extended);
    expect(widget.variant()).toEqual(extended);
    // A state from before variants existed names none and keeps the current one.
    const { variant: _dropped, ...older } = widget.getState();
    const count = feed.requests.length;
    expect(widget.restoreState(older).applied).toBe(true);
    await flush();
    expect(widget.variant()).toEqual(extended);
    expect(feed.requests).toHaveLength(count);
    // One this build cannot read is refused before anything else is applied.
    expect(widget.restoreState({ ...older, theme: 'light', variant: { session: 'overnight' } })).toMatchObject({ applied: false });
    expect(widget.theme()).toBe('dark');
  });

  it('keeps the variant between visits', async () => {
    const storage = memoryStorage();
    const first = make({ feed: sessionFeed(), persist: 'variants', storage }).widget;
    await flush();
    first.setDataVariant(extended);
    first.destroy();
    const feed = sessionFeed();
    const second = make({ feed, persist: 'variants', storage }).widget;
    await flush();
    expect(second.variant()).toEqual(extended);
    expect(feed.requests[0].variant).toEqual(extended);
  });

  it('shows a variant the provider does not declare as unsupported, fetches nothing and offers no retry', async () => {
    const requests: BarsRequest[] = [];
    const { widget, root } = make({ feed: { getBars: async request => { requests.push(request); return [bar(60)]; } }, variant: extended });
    await flush();
    expect(requests).toHaveLength(0);
    expect(widget.dataController?.getState()).toMatchObject({ status: 'unsupported', unsupported: 'session' });
    const status = root.querySelector('.oac-data-status')!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('Not available from this source: Extended hours');
    expect(status.querySelector('button')).toBeNull();
    expect(root.querySelector('.oac-statusline__msg')!.textContent).toContain('Not available from this source: Extended hours');
    // Choosing the default again is served at once.
    widget.setDataVariant(undefined);
    await flush();
    expect(requests).toHaveLength(1);
    expect(status.hidden).toBe(true);
  });

  it('names a non-default variant on the status line, localised', async () => {
    const { widget, root } = make({ feed: sessionFeed(), translate: (key, fallback) => key === 'Extended hours' ? 'Hors seance' : fallback });
    await flush();
    const label = root.querySelector('.oac-statusline__variant')!;
    expect(label.hidden).toBe(true);
    widget.setDataVariant({ session: 'extended', currency: 'USD' });
    await flush();
    expect(label.hidden).toBe(false);
    expect(label.textContent).toBe('Hors seance USD');
  });

  it('refuses a malformed variant at the call site', () => {
    expect(() => make({ variant: { session: 'overnight' as never } })).toThrow(TypeError);
    const { widget } = make();
    expect(() => widget.setDataVariant({ adjustment: 'split' as never })).toThrow(TypeError);
    expect(widget.variant()).toBeUndefined();
  });

  it('clears host-supplied bars and publishes the context when there is no feed', () => {
    const { widget } = make();
    widget.series.setData([bar(60)]);
    widget.setDataVariant({ adjustment: 'raw' });
    expect(widget.series.getData()).toEqual([]);
    expect(widget.chart.getDataContext()?.variant).toEqual({ adjustment: 'raw' });
  });
});
