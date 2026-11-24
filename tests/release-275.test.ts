/**
 * Three reports fixed together: a fit that dropped the host's right offset,
 * a right-click menu with no way back to the default view, and dialogs that
 * could not be moved off the study being tuned.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Chart, TimeScale, type Bar, type ContextMenuEvent } from '../src/index';
import { contextMenuEntries, createWidget, type MenuItem, type Widget } from '../src/widget/index';
import { createOverlayStack } from '../src/widget/context';
import { clampDialogOffset } from '../src/widget/dialog-drag';
import { fakeDocument } from './helpers/fake-dom';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument, fire, type FakeElement } from './helpers/fake-dom-widget';

beforeAll(ensureWindowGlobal);
const widgets: Widget[] = [];
afterEach(() => { for (const widget of widgets.splice(0)) widget.destroy(); });

const BARS: Bar[] = Array.from({ length: 300 }, (_, i) => ({ time: 1_700_000_000 + i * 300, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10 }));

function chartWith(timeScale?: Record<string, unknown>): Chart {
  const doc = fakeDocument();
  const chart = new Chart(doc.createElement('div'), {
    document: doc, pixelRatio: () => 1, shortcuts: false,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
    ...(timeScale === undefined ? {} : { timeScale }),
  });
  chart.applySize(800, 600);
  chart.addSeries('candlestick').setData(BARS);
  return chart;
}

describe('the right offset a host configures', () => {
  it('is the gap the chart opens with, and the one a fit and a reset return to', () => {
    const chart = chartWith({ rightOffset: 27 });
    expect(chart.timeScale.rightOffset).toBe(27);
    chart.timeScale.setRightOffset(-40);
    chart.fitContent();
    expect(chart.timeScale.rightOffset).toBe(27);
    chart.timeScale.setRightOffset(-40);
    chart.resetScale();
    expect(chart.timeScale.rightOffset).toBe(27);
    chart.destroy();
  });

  it('stays the built-in four bars for a host that sets none, or spreads an unset value in', () => {
    for (const options of [undefined, {}, { rightOffset: undefined }, { rightOffset: Number.NaN }]) {
      const chart = chartWith(options);
      expect(chart.timeScale.rightOffset).toBe(4);
      expect(Number.isFinite(chart.timeScale.barSpacing)).toBe(true);
      chart.destroy();
    }
    const scale = new TimeScale({ rightOffset: 0 });
    scale.setWidth(1000);
    scale.fitContent(100);
    expect(scale.rightOffset).toBe(0);
  });
});

function make(): Widget {
  const document = fakeWidgetDocument();
  const widget = createWidget(fakeContainer(document) as unknown as HTMLElement, {
    document: document as unknown as Document, mobile: 'never', symbol: 'AAPL', exchange: 'US',
    raf: { schedule: callback => { callback(); return 1; }, cancel: () => {} },
  });
  widget.chart.applySize(800, 600);
  widget.series.setData(BARS);
  widgets.push(widget);
  return widget;
}
const event = { target: { kind: 'series', id: null, seriesType: 'candlestick' }, paneIndex: 0, price: 100, index: 0, time: BARS[0]!.time,
  point: { x: 100, y: 100 }, preventDefault: () => {} } as unknown as ContextMenuEvent;
const row = (widget: Widget, id: string): MenuItem =>
  contextMenuEntries(widget.context, event, {}).find((item): item is MenuItem => 'id' in item && item.id === id)!;

describe('Reset view on the right-click menu', () => {
  it('restores the default bar count and puts a dragged price axis back on auto-fit', () => {
    const widget = make();
    const chart = widget.chart;
    const home = chart.getVisibleLogicalRange();
    chart.timeScale.setBarSpacing(40);
    chart.timeScale.setRightOffset(-120);
    chart.setPriceAxisAutoFit(0, 'right', false);
    expect(chart.getVisibleLogicalRange()).not.toEqual(home);
    const reset = row(widget, 'chart-reset');
    expect(reset.label).toBe('Reset view');
    expect(reset.disabled).toBe(false);
    reset.run!();
    expect(chart.getVisibleLogicalRange()).toEqual(home);
    expect(chart.priceAxisState(0, 'right')).toMatchObject({ autoFit: true });
  });

  it('is disabled, and does nothing, where the host has switched zooming off', () => {
    const widget = make();
    const stale = row(widget, 'chart-reset');
    widget.chart.timeScale.setRightOffset(-120);
    widget.chart.setNavigationOptions({ zoomEnabled: false });
    const before = widget.chart.getVisibleLogicalRange();
    expect(row(widget, 'chart-reset').disabled).toBe(true);
    stale.run!();
    expect(widget.chart.getVisibleLogicalRange()).toEqual(before);
  });
});

describe('dragging a dialog by its title bar', () => {
  const bounds = { width: 800, height: 600 };
  const rest = { left: 200, top: 150, width: 400, head: 40 };

  it('follows the pointer while the bar stays reachable', () => {
    expect(clampDialogOffset(rest, bounds, 120, -60)).toEqual({ x: 120, y: -60 });
  });

  it('keeps the whole height of the bar and a catchable width of it inside the widget', () => {
    expect(clampDialogOffset(rest, bounds, 0, -900).y).toBe(-150);
    expect(clampDialogOffset(rest, bounds, 0, 900).y).toBe(600 - 40 - 150);
    expect(clampDialogOffset(rest, bounds, -900, 0).x).toBe(64 - 400 - 200);
    expect(clampDialogOffset(rest, bounds, 900, 0).x).toBe(800 - 64 - 200);
  });

  it('pins a dialog to the top left of a widget too small to hold its bar', () => {
    expect(clampDialogOffset({ left: 0, top: 0, width: 30, head: 40 }, { width: 20, height: 10 }, 50, 50)).toEqual({ x: 0, y: 0 });
  });

  function opened(className = '') {
    const doc = fakeWidgetDocument();
    const root = fakeContainer(doc, 800, 600);
    const stack = createOverlayStack(root as unknown as HTMLElement, doc as unknown as Document);
    const panel = doc.createElement('div');
    if (className !== '') panel.classList.add(className);
    panel.rect = { left: 200, top: 150, width: 400, height: 300 };
    const head = doc.createElement('div');
    head.className = 'oac-dialog__head';
    head.offsetHeight = 40;
    const title = doc.createElement('span');
    const close = doc.createElement('button');
    head.appendChild(title);
    head.appendChild(close);
    panel.appendChild(head);
    const body = doc.createElement('div');
    panel.appendChild(body);
    return { stack, panel, head, title, close, body, open: (opts = {}) => stack.open(panel as unknown as HTMLElement, opts) };
  }
  const translate = (el: FakeElement): string | undefined => (el.style as unknown as { translate?: string }).translate;

  it('moves a centred dialog with the pointer, and stops when the press ends', () => {
    const f = opened();
    f.open();
    fire(f.title, 'pointerdown', { button: 0, clientX: 300, clientY: 160, pointerId: 1 });
    fire(f.head, 'pointermove', { clientX: 350, clientY: 200 });
    expect(translate(f.panel)).toBe('50px 40px');
    fire(f.head, 'pointerup');
    fire(f.head, 'pointermove', { clientX: 500, clientY: 500 });
    expect(translate(f.panel)).toBe('50px 40px');
  });

  it('carries on from where the last drag left it', () => {
    const f = opened();
    f.open();
    fire(f.title, 'pointerdown', { button: 0, clientX: 300, clientY: 160 });
    fire(f.head, 'pointermove', { clientX: 350, clientY: 200 });
    fire(f.head, 'pointerup');
    // The browser reports the moved box; the fake has to be told.
    f.panel.rect = { left: 250, top: 190, width: 400, height: 300 };
    fire(f.title, 'pointerdown', { button: 0, clientX: 350, clientY: 200 });
    fire(f.head, 'pointermove', { clientX: 360, clientY: 190 });
    expect(translate(f.panel)).toBe('60px 30px');
  });

  it('leaves a press on the close button, the body, a secondary button and a bottom sheet alone', () => {
    const cases: Array<[string, (f: ReturnType<typeof opened>) => void]> = [
      ['close', f => { fire(f.close, 'pointerdown', { button: 0, clientX: 300, clientY: 160 }); }],
      ['body', f => { fire(f.body, 'pointerdown', { button: 0, clientX: 300, clientY: 160 }); }],
      ['secondary', f => { fire(f.title, 'pointerdown', { button: 2, clientX: 300, clientY: 160 }); }],
    ];
    for (const [, press] of cases) {
      const f = opened();
      f.open();
      press(f);
      fire(f.head, 'pointermove', { clientX: 350, clientY: 200 });
      expect(translate(f.panel)).toBeUndefined();
    }
    const sheet = opened('oac-mobile-sheet');
    sheet.open();
    fire(sheet.title, 'pointerdown', { button: 0, clientX: 300, clientY: 160 });
    fire(sheet.head, 'pointermove', { clientX: 350, clientY: 200 });
    expect(translate(sheet.panel)).toBeUndefined();
  });

  it('does not make an anchored popover draggable', () => {
    const f = opened();
    const anchor = f.panel.ownerDocument.createElement('button');
    f.open({ anchor: anchor as unknown as HTMLElement });
    fire(f.title, 'pointerdown', { button: 0, clientX: 300, clientY: 160 });
    fire(f.head, 'pointermove', { clientX: 350, clientY: 200 });
    expect(translate(f.panel)).toBeUndefined();
  });
});
