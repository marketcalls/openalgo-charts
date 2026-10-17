import { describe, expect, it } from 'vitest';
import { PaneLegend } from '../src/primitives/pane-legend';
import type { PrimitiveRenderContext } from '../src/primitives/primitive';
import { PriceScale } from '../src/scale/price-scale';
import { TimeScale } from '../src/scale/time-scale';
import { DataLayer } from '../src/model/data-layer';
import { darkTheme } from '../src/theme';
import { makeCtx } from './helpers/fake-ctx';

function paint(legend: PaneLegend, width: number, hoverId = 'study::row', dpr = 1) {
  const { ctx, rec } = makeCtx();
  const rc: PrimitiveRenderContext = { priceScale: new PriceScale(), timeScale: new TimeScale(),
    dataLayer: new DataLayer(), plotWidth: width, plotHeight: 100, priceAxisWidth: 60,
    dpr, theme: darkTheme, hoverId };
  legend.draw(ctx, rc);
  const buttons = (legend as unknown as { _buttons: { id: string; x: number; y: number }[] })._buttons;
  return { buttons, text: rec.ops.filter(op => op.type === 'fillText') };
}

describe('stationary legend controls', () => {
  it.each([1, 2])('keeps every action and click target fixed while readings change at pixel ratio %s', dpr => {
    const legend = new PaneLegend({ id: 'study', title: 'MACD', params: '12 26 9',
      actions: ['hide', 'settings', 'source', 'up', 'down', 'collapse', 'maximize', 'close'] });
    legend.setValues([{ text: '100.00' }]);
    const before = paint(legend, 900, 'study::row', dpr).buttons;
    expect(before).toHaveLength(8);
    for (const values of [[], ['9.99'], ['-100.00', '0.01', '999999.99'], ['100.00']]) {
      legend.setValues(values.map(text => ({ text })));
      expect(paint(legend, 900, 'study::settings', dpr).buttons).toEqual(before);
      for (const button of before) {
        expect(legend.hitTest(button.x + 8, button.y + 8)?.externalId).toBe(button.id);
      }
    }
  });

  it('places the controls between the parameters and the changing readings', () => {
    const legend = new PaneLegend({ id: 'study', title: 'EMA', params: '20 close' });
    legend.setValue('100.00');
    const { buttons, text } = paint(legend, 900);
    const params = text.find(op => op.text === '20 close')!;
    const value = text.find(op => op.text === '100.00')!;
    expect(buttons[0]!.x).toBeGreaterThan(params.args[0] + '20 close'.length * 6);
    expect(value.args[0]).toBeGreaterThanOrEqual(buttons[buttons.length - 1]!.x + 16);
  });

  it.each([100, 180, 260])('does not let reading width change the title or action positions in a %s px plot', width => {
    const legend = new PaneLegend({ id: 'study', title: 'A long indicator name that must fit', params: '14 close 200' });
    legend.setValue('1.00');
    const before = paint(legend, width);
    const title = before.text.find(op => op.text !== '1.00' && op.text !== '14 close 200');
    expect(before.buttons.map(button => button.id)).toContain('study::settings');
    for (const values of [[], ['-999999999.99'], ['1.00', '100.00', '200.00']]) {
      legend.setValues(values.map(text => ({ text })));
      const after = paint(legend, width, 'study::settings');
      expect(after.buttons).toEqual(before.buttons);
      expect(after.text[0]?.text).toBe(title?.text);
      for (const button of after.buttons) expect(button.x + 16).toBeLessThanOrEqual(width);
      expect(legend.hitTest(width + 1, 14)).toBeNull();
    }
  });

  it('retains complete readings after the controls and drops readings that cannot fit', () => {
    const legend = new PaneLegend({ id: 'study', title: 'A', actions: ['settings'] });
    legend.setValues([{ label: 'C', text: '123.45', priority: 10 }, { label: 'Long', text: '123456789012.34' }]);
    const { buttons, text } = paint(legend, 130);
    expect(text.map(op => op.text)).toEqual(['A', 'C', '123.45']);
    expect(text[1]!.args[0]).toBeGreaterThanOrEqual(buttons[0]!.x + 16);
  });

  it('anchors actions independently of changing status fields and a hidden title', () => {
    const legend = new PaneLegend({ id: 'study', title: 'EMA', params: '20 close', statusLine: { title: false },
      status: { marketStatus: { text: 'Open' }, lastDayChange: { text: '+1.00' } } });
    const before = paint(legend, 500).buttons;
    legend.setOptions({ status: { marketStatus: { text: 'Market closed' }, lastDayChange: { text: '-10000.00' } } });
    legend.setValue('9876.54');
    expect(paint(legend, 500).buttons).toEqual(before);
  });

  it('still hides controls off the row and restores the same targets when hovered again', () => {
    const legend = new PaneLegend({ id: 'study', title: 'EMA', params: '20 close' });
    legend.setValue('100.00');
    const before = paint(legend, 500).buttons;
    expect(paint(legend, 500, '').buttons).toEqual([]);
    legend.setValue('-1.00');
    expect(paint(legend, 500).buttons).toEqual(before);
  });
});
