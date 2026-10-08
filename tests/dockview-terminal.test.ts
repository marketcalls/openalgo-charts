import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createChart } from '../src/core/chart';
import { createWidget } from '../src/widget/widget';
import type { WidgetInstance } from '../src/widget/index';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument } from './helpers/fake-dom-widget';

beforeAll(ensureWindowGlobal);

describe('dockview multi-chart terminal compatibility', () => {
  it('exposes chart.resize and widget.resize', () => {
    const doc = fakeWidgetDocument();
    const el = fakeContainer(doc);
    const chart = createChart(el as unknown as HTMLElement);

    const sizes: { width: number; height: number }[] = [];
    chart.on('resize', size => { sizes.push({ width: size.width, height: size.height }); });
    chart.resize(500, 400);
    expect(sizes[sizes.length - 1]).toEqual({ width: 500, height: 400 });
    // Larger than the 800x600 container: clamped to the container.
    chart.resize(2000, 1500);
    expect(sizes[sizes.length - 1]).toEqual({ width: 800, height: 600 });

    chart.destroy();
  });

  it('emits symbol_change on widget and chart bus', () => {
    const doc = fakeWidgetDocument();
    const el = fakeContainer(doc);
    const widget: WidgetInstance = createWidget(el as unknown as HTMLElement, {
      document: doc as unknown as Document,
      symbol: 'NIFTY',
      interval: '5m',
      theme: 'dark'
    });

    const receivedSymbolChanges: string[] = [];
    widget.chart.on('symbol_change', (s: string) => {
      receivedSymbolChanges.push(s);
    });
    // The widget bus names the same fact `symbol` (and `interval`).
    const busSymbols: { symbol: string; exchange: string }[] = [];
    const busIntervals: string[] = [];
    widget.on('symbol', payload => { busSymbols.push(payload); });
    widget.on('interval', ({ interval }) => { busIntervals.push(interval); });

    widget.setSymbol('BANKNIFTY');
    expect(receivedSymbolChanges).toEqual(['BANKNIFTY']);
    expect(busSymbols).toEqual([{ symbol: 'BANKNIFTY', exchange: widget.exchange() }]);
    widget.setInterval('15m');
    expect(busIntervals).toEqual(['15m']);

    widget.destroy();
  });

  it('chart panel lifecycle handles resize and disposal cleanly', () => {
    const doc = fakeWidgetDocument();
    const container = fakeContainer(doc);
    const widget = createWidget(container as unknown as HTMLElement, {
      document: doc as unknown as Document,
      symbol: 'NIFTY',
      interval: '5m',
      theme: 'dark'
    });

    const mockApi = {
      setTitle: vi.fn()
    };

    widget.chart.on('symbol_change', (newSymbol: string) => {
      mockApi.setTitle(`${newSymbol} (5m)`);
    });

    widget.setSymbol('RELIANCE');
    expect(mockApi.setTitle).toHaveBeenCalledWith('RELIANCE (5m)');

    // Resize
    expect(typeof widget.resize).toBe('function');
    expect(() => widget.resize?.(500, 400)).not.toThrow();
    expect(() => widget.chart.resize(500, 400)).not.toThrow();

    // Cleanup
    widget.destroy();
  });
});
