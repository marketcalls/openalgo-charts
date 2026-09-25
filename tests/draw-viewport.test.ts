/**
 * Viewport-anchored drawings: anchors stored as fractions of the pane's plot
 * area instead of time and price. Each contract here is checked through the
 * real chart and the real layer, because the failure this feature exists to
 * prevent (an annotation that slides when the chart pans) only shows up where
 * the chart's own scales move under the drawing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chart } from '../src/core/chart';
import {
  DrawingController, DrawingLayer, migrateDrawings, encodeClipboardPayload, decodeClipboardPayload, createDrawingLinkGroup,
  BUILTIN_DRAWING_TOOLS, registerDrawingTool, drawingSettingsSchema, readDrawingSetting, applyDrawingSettings, SPACE_FIELD,
  type ClipboardPort, type Drawing, type DrawingInput,
} from '../src/draw/index';
import { darkTheme } from '../src/theme';
import { fakeDocument, pointer, type FakeElement } from './helpers/fake-dom';
import { makeCtx, type RecordingContext } from './helpers/fake-ctx';

const T0 = 1700000000;
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.unstubAllGlobals(); });

const bars = Array.from({ length: 100 }, (_, i) => {
  const c = 100 + Math.sin(i / 6) * 4;
  return { time: T0 + i * 60, open: c - 0.5, high: c + 1, low: c - 1, close: c };
});

function memoryPort(): ClipboardPort & { text: string } {
  const port = { text: '', writeText: async (t: string) => { port.text = t; }, readText: async () => port.text };
  return port;
}

function mount(width = 800, height = 600, options: { panes?: number; clipboard?: ClipboardPort } = {}) {
  vi.stubGlobal('window', {});
  const doc = fakeDocument();
  const el = doc.createElement('div') as unknown as FakeElement;
  const chart = new Chart(el as unknown as HTMLElement, { document: doc, raf: { schedule: () => 0 }, shortcuts: false, timeNavigator: false });
  chart.applySize(width, height);
  chart.addSeries('candlestick').setData(bars);
  for (let pane = 1; pane < (options.panes ?? 1); pane++) chart.addSeries('line', { paneIndex: pane }).setData(bars.map(b => ({ time: b.time, value: b.close })));
  chart.setVisibleLogicalRange({ from: 0, to: 99 });
  const draw = new DrawingController(chart, options.clipboard === undefined ? {} : { clipboard: options.clipboard });
  cleanups.push(() => chart.destroy(), () => draw.destroy());
  const move = (x: number, y: number, pressed = false) => el.dispatch('pointermove', pointer('move', x, y, { buttons: pressed ? 1 : 0 }));
  const dragBy = (x: number, y: number, dx: number, dy: number) => {
    move(x, y);
    el.dispatch('pointerdown', pointer('down', x, y));
    for (let i = 1; i <= 5; i++) move(x + (dx * i) / 5, y + (dy * i) / 5, true);
    el.dispatch('pointerup', pointer('up', x + dx, y + dy));
  };
  const click = (x: number, y: number) => {
    move(x, y);
    el.dispatch('pointerdown', pointer('down', x, y));
    el.dispatch('pointerup', pointer('up', x, y));
  };
  const size = (paneIndex = 0) => ({ w: chart.timeScale.width, h: chart.panes()[paneIndex].priceScale.height });
  /** Paint a pane's top drawing layer the way the chart would, at `dpr`. */
  const paint = (paneIndex = 0, dpr = 1): RecordingContext => {
    const { ctx, rec } = makeCtx();
    const pane = chart.panes()[paneIndex];
    const layer = pane.primitives().find(p => p instanceof DrawingLayer && p.zOrder() === 'top') as DrawingLayer;
    const { w, h } = size(paneIndex);
    layer.draw(ctx, { timeScale: chart.timeScale, dataLayer: chart.dataLayer, priceScale: pane.priceScale,
      plotWidth: w, plotHeight: h, priceAxisWidth: 56, dpr, theme: darkTheme } as never);
    return rec;
  };
  const hit = (x: number, y: number, paneIndex = 0) => {
    const pane = chart.panes()[paneIndex];
    const layer = pane.primitives().find(p => p instanceof DrawingLayer && p.zOrder() === 'top') as DrawingLayer;
    const { w, h } = size(paneIndex);
    return layer.hitTest(x, y, { timeScale: chart.timeScale, dataLayer: chart.dataLayer, priceScale: pane.priceScale,
      plotWidth: w, plotHeight: h, priceAxisWidth: 56, dpr: 1, theme: darkTheme } as never);
  };
  return { chart, draw, el, move, click, dragBy, paint, hit, size };
}

const viewportRect = (draw: DrawingController, extra: Partial<DrawingInput> = {}): Drawing => draw.add({
  tool: 'rectangle', paneIndex: 0, style: { color: '#ff00ff' }, points: [], space: 'viewport',
  viewportPoints: [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }], ...extra,
});

const dataRect = (draw: DrawingController): Drawing => draw.add({
  tool: 'rectangle', paneIndex: 0, style: { color: '#00ffff' },
  points: [{ time: bars[40].time, price: 101 }, { time: bars[60].time, price: 99 }],
});

/** The strokeRect a rectangle paints, as [x, y, w, h]. */
const strokeOf = (rec: RecordingContext, color: string): number[] | undefined =>
  rec.ops.find(op => op.type === 'strokeRect' && op.strokeStyle === color)?.args;

const close = (a: readonly number[] | undefined, b: readonly number[], digits = 6): void => {
  expect(a).toBeDefined();
  expect(a!.length).toBe(b.length);
  a!.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
};

describe('a viewport drawing on screen', () => {
  it('paints at its fraction of the plot and stays there through pan, zoom and a price range change', () => {
    const { chart, draw, paint, size } = mount();
    viewportRect(draw);
    dataRect(draw);
    const { w, h } = size();
    const expected = [0.2 * w, 0.2 * h, 0.3 * w, 0.3 * h];
    close(strokeOf(paint(), '#ff00ff'), expected);
    const dataBefore = strokeOf(paint(), '#00ffff');
    chart.setVisibleLogicalRange({ from: 30, to: 70 });
    const scale = chart.panes()[0].priceScale;
    scale.setAutoScale(false);
    scale.setPriceRange({ min: 90, max: 110 });
    close(strokeOf(paint(), '#ff00ff'), expected);
    // The data rectangle is the control: the same changes do move it.
    expect(strokeOf(paint(), '#00ffff')).not.toEqual(dataBefore);
  });

  it('stays put under a real pointer pan of the chart', () => {
    const { draw, paint, dragBy, size } = mount();
    viewportRect(draw);
    const { w, h } = size();
    dragBy(700, 520, -180, -60);
    close(strokeOf(paint(), '#ff00ff'), [0.2 * w, 0.2 * h, 0.3 * w, 0.3 * h]);
  });

  it('keeps its proportions when the chart is resized', () => {
    const { chart, draw, paint, size } = mount();
    viewportRect(draw);
    chart.applySize(1000, 720);
    const { w, h } = size();
    close(strokeOf(paint(), '#ff00ff'), [0.2 * w, 0.2 * h, 0.3 * w, 0.3 * h]);
  });

  it('multiplies by the device pixel ratio like every other drawing', () => {
    const { draw, paint, size } = mount();
    viewportRect(draw);
    draw.add({ tool: 'text', paneIndex: 0, style: {}, points: [], space: 'viewport', viewportPoints: [{ x: 0.1, y: 0.05 }], text: { value: 'Pinned' } });
    const { w, h } = size();
    close(strokeOf(paint(0, 2), '#ff00ff'), [0.4 * w, 0.4 * h, 0.6 * w, 0.6 * h]);
    const text1 = paint(0, 1).ops.find(op => op.type === 'fillText' && op.text === 'Pinned')!.args;
    const text2 = paint(0, 2).ops.find(op => op.type === 'fillText' && op.text === 'Pinned')!.args;
    expect(text2[0]).toBeCloseTo(text1[0] * 2, 6);
    expect(text2[1]).toBeCloseTo(text1[1] * 2, 6);
  });

  it('hit-tests where it paints, body and handles alike', () => {
    const { chart, draw, hit, size } = mount();
    const r = viewportRect(draw);
    const { w, h } = size();
    expect(hit(0.35 * w, 0.35 * h)?.externalId).toBe(`draw:${r.id}`);
    expect(hit(0.9 * w, 0.9 * h)).toBeNull();
    draw.select(r.id);
    expect(hit(0.5 * w, 0.5 * h)?.externalId).toBe(`draw:${r.id}#1`);
    chart.setVisibleLogicalRange({ from: 10, to: 40 });
    expect(hit(0.35 * w, 0.35 * h)?.externalId).toBe(`draw:${r.id}`);
  });

  it('skips a saved viewport entry whose tool cannot be anchored to the screen, without throwing', () => {
    const { draw, paint, hit, size } = mount();
    draw.fromJSON({ version: 2, drawings: [{ id: 'h', tool: 'horizontal-line', paneIndex: 0, zIndex: 0, style: { color: '#ff00ff' },
      points: [], space: 'viewport', viewportPoints: [{ x: 0.5, y: 0.5 }] }] });
    expect(draw.drawings()).toHaveLength(1);
    expect(() => paint()).not.toThrow();
    expect(paint().count('stroke')).toBe(0);
    const { w, h } = size();
    expect(hit(0.5 * w, 0.5 * h)).toBeNull();
  });
});

describe('adding a viewport drawing', () => {
  it('keeps the fractions, clears the data anchors and copies what it was given', () => {
    const { draw } = mount();
    const given = [{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }];
    const r = draw.add({ tool: 'rectangle', paneIndex: 0, style: {}, space: 'viewport', viewportPoints: given,
      points: [{ time: T0, price: 100 }] });
    expect(r.space).toBe('viewport');
    expect(r.points).toEqual([]);
    expect(r.viewportPoints).toEqual(given);
    given[0].x = 0.9;
    expect(draw.get(r.id)?.viewportPoints?.[0].x).toBe(0.2);
    // A data drawing carries no space and no viewport anchors at all.
    const d = dataRect(draw);
    expect('space' in d).toBe(false);
    expect('viewportPoints' in d).toBe(false);
  });

  it('refuses a tool that cannot be anchored to the screen, and anchors that are not numbers', () => {
    const { draw } = mount();
    expect(() => draw.add({ tool: 'trend-line', paneIndex: 0, style: {}, points: [], space: 'viewport',
      viewportPoints: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] })).toThrow(/viewport/);
    expect(() => draw.add({ tool: 'rectangle', paneIndex: 0, style: {}, points: [], space: 'viewport',
      viewportPoints: [{ x: Number.NaN, y: 0.1 }, { x: 0.2, y: 0.2 }] })).toThrow(/viewport/);
    expect(() => draw.add({ tool: 'rectangle', paneIndex: 0, style: {}, points: [], space: 'viewport' })).toThrow(/viewport/);
    expect(draw.drawings()).toHaveLength(0);
  });

  it('places one with the pointer when the tool is armed for the viewport', () => {
    const { draw, click, size, chart } = mount();
    expect(() => draw.setTool('trend-line', { space: 'viewport' })).toThrow(/viewport/);
    draw.setTool('text', { space: 'viewport' });
    expect(draw.activeToolSpace()).toBe('viewport');
    click(300, 200);
    const [t] = draw.drawings();
    const { w, h } = size();
    expect(t.space).toBe('viewport');
    expect(t.viewportPoints![0].x).toBeCloseTo(300 / w, 6);
    expect(t.viewportPoints![0].y).toBeCloseTo(200 / h, 6);
    chart.setVisibleLogicalRange({ from: 50, to: 60 });
    const [at] = draw.screenPoints(t.id)!;
    expect(at.x).toBeCloseTo(300, 6);
    expect(at.y).toBeCloseTo(200, 6);
    // Disarmed, the next tool places in data space again.
    draw.setTool('rectangle');
    expect(draw.activeToolSpace()).toBe('data');
  });
});

describe('editing a viewport drawing', () => {
  it('moves by the pointer delta as a fraction of the plot, and undoes in one step', () => {
    const { chart, draw, dragBy, size } = mount();
    const r = viewportRect(draw);
    const { w, h } = size();
    dragBy(0.35 * w, 0.35 * h, 50, 30);
    const moved = draw.get(r.id)!.viewportPoints!;
    expect(moved[0].x).toBeCloseTo(0.2 + 50 / w, 6);
    expect(moved[0].y).toBeCloseTo(0.2 + 30 / h, 6);
    expect(moved[1].x).toBeCloseTo(0.5 + 50 / w, 6);
    expect(draw.get(r.id)!.points).toEqual([]);
    // The chart did not pan under the drag.
    expect(chart.getVisibleLogicalRange().from).toBeCloseTo(0, 6);
    expect(draw.undo()).toBe(true);
    expect(draw.get(r.id)!.viewportPoints).toEqual([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }]);
  });

  it('resizes by a handle to the pointer position', () => {
    const { draw, dragBy, size } = mount();
    const r = viewportRect(draw);
    draw.select(r.id);
    const { w, h } = size();
    dragBy(0.5 * w, 0.5 * h, 0.1 * w, 0.2 * h);
    const [a, b] = draw.get(r.id)!.viewportPoints!;
    expect(a).toEqual({ x: 0.2, y: 0.2 });
    expect(b.x).toBeCloseTo(0.6, 6);
    expect(b.y).toBeCloseTo(0.7, 6);
  });

  it('never drags an anchor out of its pane, where no gesture could reach it again', () => {
    const { draw, dragBy, size } = mount();
    const r = viewportRect(draw);
    const { w, h } = size();
    dragBy(0.35 * w, 0.35 * h, 2000, 2000);
    expect(draw.get(r.id)!.viewportPoints).toEqual([{ x: 0.7, y: 0.7 }, { x: 1, y: 1 }]);
    draw.select(r.id);
    dragBy(0.2 * w + 0.7 * w - 0.2 * w, 0.7 * h, -3000, -3000);
    const [a] = draw.get(r.id)!.viewportPoints!;
    expect(a).toEqual({ x: 0, y: 0 });
  });

  it('nudges by screen pixels', () => {
    const { draw, size } = mount();
    const r = viewportRect(draw);
    const { w, h } = size();
    draw.nudge([r.id], 10, -5);
    const [a] = draw.get(r.id)!.viewportPoints!;
    expect(a.x).toBeCloseTo(0.2 + 10 / w, 9);
    expect(a.y).toBeCloseTo(0.2 - 5 / h, 9);
  });

  it('has no price for an alert to read, even on a tool that offers alerts in data space', () => {
    const { draw } = mount();
    registerDrawingTool({
      id: 'test-viewport-level', name: 'Level', points: 1, viewport: true,
      alertValue: c => ({ price: c.fromY(c.pts[0].y) ?? Number.NaN }),
      draw: () => {}, distance: () => null,
    });
    const level = draw.add({ tool: 'test-viewport-level', paneIndex: 0, style: {}, points: [{ time: bars[50].time, price: 100 }] });
    expect(draw.alertInfo(level.id).available).toBe(true);
    const pinned = draw.add({ tool: 'test-viewport-level', paneIndex: 0, style: {}, points: [], space: 'viewport', viewportPoints: [{ x: 0.5, y: 0.5 }] });
    const info = draw.alertInfo(pinned.id);
    expect(info.available).toBe(false);
    expect(info.reason).toMatch(/screen/);
    expect(draw.valueAt(pinned.id, bars[50].time)).toBeUndefined();
  });
});

describe('converting between spaces', () => {
  it('keeps the drawing where it is on screen both ways, and each way is one undo step', () => {
    const { chart, draw } = mount();
    const r = dataRect(draw);
    const original = draw.get(r.id)!.points.map(p => ({ ...p }));
    const before = draw.screenPoints(r.id)!;
    draw.update(r.id, { space: 'viewport' });
    const pinned = draw.get(r.id)!;
    expect(pinned.space).toBe('viewport');
    expect(pinned.points).toEqual([]);
    expect(pinned.viewportPoints).toHaveLength(2);
    draw.screenPoints(r.id)!.forEach((p, i) => { expect(p.x).toBeCloseTo(before[i].x, 6); expect(p.y).toBeCloseTo(before[i].y, 6); });
    // Pan and zoom: still where it was.
    chart.setVisibleLogicalRange({ from: 20, to: 60 });
    draw.screenPoints(r.id)!.forEach((p, i) => { expect(p.x).toBeCloseTo(before[i].x, 6); expect(p.y).toBeCloseTo(before[i].y, 6); });
    // Back to time and price, at the view in force now.
    draw.update(r.id, { space: 'data' });
    const back = draw.get(r.id)!;
    expect('space' in back).toBe(false);
    expect('viewportPoints' in back).toBe(false);
    expect(back.points).toHaveLength(2);
    draw.screenPoints(r.id)!.forEach((p, i) => { expect(p.x).toBeCloseTo(before[i].x, 6); expect(p.y).toBeCloseTo(before[i].y, 6); });
    expect(draw.undo()).toBe(true);
    expect(draw.get(r.id)!.space).toBe('viewport');
    expect(draw.undo()).toBe(true);
    expect(draw.get(r.id)!.space).toBeUndefined();
    expect(draw.get(r.id)!.points).toEqual(original);
    expect(draw.redo()).toBe(true);
    expect(draw.get(r.id)!.space).toBe('viewport');
  });

  it('converts what it can in one edit and leaves a tool that cannot be anchored to the screen in data space', () => {
    const { draw } = mount();
    const line = draw.add({ tool: 'trend-line', paneIndex: 0, style: {},
      points: [{ time: bars[10].time, price: 100 }, { time: bars[20].time, price: 102 }] });
    const r = dataRect(draw);
    draw.updateMany([line.id, r.id].map(id => ({ id, patch: { space: 'viewport' as const, style: { color: '#123456' } } })));
    expect(draw.get(r.id)!.space).toBe('viewport');
    expect(draw.get(r.id)!.viewportPoints).toHaveLength(2);
    expect(draw.get(line.id)!.space).toBeUndefined();
    expect(draw.get(line.id)!.style.color).toBe('#123456');
    expect(draw.get(line.id)!.points).toHaveLength(2);
    expect(draw.undo()).toBe(true);
    expect(draw.get(r.id)!.space).toBeUndefined();
    expect(draw.get(line.id)!.style.color).toBeUndefined();
  });

  it('takes the anchors of the new space as given when the patch carries them', () => {
    const { draw } = mount();
    const r = dataRect(draw);
    draw.update(r.id, { space: 'viewport', viewportPoints: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.4 }] });
    expect(draw.get(r.id)!.viewportPoints).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.4 }]);
  });
});

describe('panes', () => {
  it('follows its pane when the pane moves, at the same fraction of the new slot', () => {
    const { chart, draw, size } = mount(800, 700, { panes: 3 });
    const note = draw.add({ tool: 'text', paneIndex: 1, style: {}, points: [], space: 'viewport',
      viewportPoints: [{ x: 0.25, y: 0.5 }], text: { value: 'Pane note' } });
    expect(chart.movePane(1, 1)).toBe(true);
    const moved = draw.get(note.id)!;
    expect(moved.paneIndex).toBe(2);
    expect(moved.viewportPoints).toEqual([{ x: 0.25, y: 0.5 }]);
    const [at] = draw.screenPoints(note.id)!;
    const top = chart.priceToCoordinate(chart.panes()[2].yToPrice(0), 2)!;
    expect(at.x).toBeCloseTo(0.25 * size(2).w, 6);
    expect(at.y).toBeCloseTo(top + 0.5 * size(2).h, 6);
  });

  it('survives a pane collapse and comes back where it was', () => {
    const { chart, draw } = mount(800, 700, { panes: 2 });
    const note = draw.add({ tool: 'text', paneIndex: 1, style: {}, points: [], space: 'viewport',
      viewportPoints: [{ x: 0.4, y: 0.3 }], text: { value: 'Folded' } });
    const before = draw.screenPoints(note.id)!;
    expect(chart.setPaneCollapsed(1, true)).toBe(true);
    // A strip plots nothing, so it has no place on screen for the note.
    expect(draw.screenPoints(note.id)).toBeNull();
    expect(draw.get(note.id)!.viewportPoints).toEqual([{ x: 0.4, y: 0.3 }]);
    // Nor can it be converted while folded: the strip is not the plot it is a fraction of.
    draw.update(note.id, { space: 'data' });
    expect(draw.get(note.id)!.space).toBe('viewport');
    expect(chart.setPaneCollapsed(1, false)).toBe(true);
    const after = draw.screenPoints(note.id)!;
    expect(after[0].x).toBeCloseTo(before[0].x, 6);
    expect(after[0].y).toBeCloseTo(before[0].y, 6);
  });
});

describe('copy, paste and restore', () => {
  it('pastes at the same fraction plus the paste offset, on this chart and on another of a different size', async () => {
    const port = memoryPort();
    const a = mount(800, 600, { clipboard: port });
    const r = viewportRect(a.draw);
    expect(await a.draw.copy(r.id)).toBe(true);
    const [same] = await a.draw.paste();
    const { w, h } = a.size();
    expect(same.space).toBe('viewport');
    expect(same.viewportPoints![0].x).toBeCloseTo(0.2 + 16 / w, 9);
    expect(same.viewportPoints![0].y).toBeCloseTo(0.2 + 16 / h, 9);
    const b = mount(1000, 720, { clipboard: port });
    const [other] = await b.draw.paste();
    const size = b.size();
    expect(other.space).toBe('viewport');
    expect(other.viewportPoints![0].x).toBeCloseTo(0.2 + 16 / size.w, 9);
    expect(other.viewportPoints![1].y).toBeCloseTo(0.5 + 16 / size.h, 9);
    const [dup] = a.draw.duplicate([r.id]);
    expect(dup.space).toBe('viewport');
    expect(dup.viewportPoints![0].x).toBeCloseTo(0.2 + 16 / w, 9);
  });

  it('round-trips through the chart state and a restore', () => {
    const a = mount();
    const r = viewportRect(a.draw, { text: { value: 'Box' } });
    dataRect(a.draw);
    const state = JSON.parse(JSON.stringify(a.chart.getState()));
    const b = mount(1000, 700);
    b.chart.restoreState(state);
    const restored = b.draw.get(r.id)!;
    expect(restored.space).toBe('viewport');
    expect(restored.viewportPoints).toEqual([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }]);
    expect(restored.points).toEqual([]);
    const { w, h } = b.size();
    close(strokeOf(b.paint(), '#ff00ff'), [0.2 * w, 0.2 * h, 0.3 * w, 0.3 * h]);
    // A controller made after the restore reads the same slot.
    const late = new DrawingController(b.chart);
    cleanups.push(() => late.destroy());
    expect(late.get(r.id)?.viewportPoints).toEqual([{ x: 0.2, y: 0.2 }, { x: 0.5, y: 0.5 }]);
  });
});

describe('persistence formats', () => {
  it('loads a document with no viewport drawings exactly as before', () => {
    const doc = { version: 2, drawings: [
      { id: 'a', tool: 'rectangle', points: [{ time: 1, price: 2 }, { time: 3, price: 4 }], style: { color: '#fff' }, paneIndex: 0, zIndex: 0 },
      { id: 'b', tool: 'text', points: [{ time: 5, price: 6 }], style: {}, paneIndex: 1, zIndex: -1, text: { value: 'hi' } },
    ] };
    expect(JSON.stringify(migrateDrawings(doc))).toBe(JSON.stringify(doc));
    // A 1.9 bare array still upgrades, and still gains no space.
    const legacy = migrateDrawings([{ id: 'c', tool: 'text', points: [{ time: 1, price: 1 }], style: { text: 'old' }, paneIndex: 0 }]);
    expect(legacy.drawings[0].text?.value).toBe('old');
    expect('space' in legacy.drawings[0]).toBe(false);
  });

  it('round-trips a viewport drawing and drops one whose anchors are unusable', () => {
    const doc = migrateDrawings({ version: 2, drawings: [
      { id: 'v', tool: 'rectangle', points: [], space: 'viewport', viewportPoints: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], style: {}, paneIndex: 0, zIndex: 0 },
      { id: 'bad', tool: 'rectangle', points: [], space: 'viewport', viewportPoints: [{ x: 'a', y: 0.2 }], style: {}, paneIndex: 0, zIndex: 0 },
      { id: 'none', tool: 'text', points: [{ time: 1, price: 1 }], space: 'viewport', style: {}, paneIndex: 0, zIndex: 0 },
      { id: 'data', tool: 'text', points: [{ time: 1, price: 1 }], space: 'data', style: {}, paneIndex: 0, zIndex: 0 },
    ] });
    expect(doc.drawings.map(d => d.id)).toEqual(['v', 'data']);
    expect(doc.drawings[0]).toMatchObject({ space: 'viewport', points: [], viewportPoints: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] });
    // Data is the default, so it is not written out.
    expect('space' in doc.drawings[1]).toBe(false);
    expect(JSON.stringify(migrateDrawings(doc))).toBe(JSON.stringify(doc));
  });

  it('carries the space through the clipboard payload and refuses a tool that cannot hold it', () => {
    mount();
    const v: Drawing = { id: 'v', tool: 'rectangle', points: [], space: 'viewport', viewportPoints: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], style: {}, paneIndex: 0, zIndex: 0 };
    const [back] = decodeClipboardPayload(encodeClipboardPayload([v]))!;
    expect(back).toMatchObject({ space: 'viewport', points: [], viewportPoints: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] });
    expect(decodeClipboardPayload(encodeClipboardPayload([{ ...v, tool: 'horizontal-line', viewportPoints: [{ x: 0.1, y: 0.2 }] }]))).toBeNull();
    expect(decodeClipboardPayload(encodeClipboardPayload([{ ...v, viewportPoints: [{ x: 0.1, y: Number.NaN }] }]))).toBeNull();
  });
});

describe('drawing links', () => {
  it('never shares a viewport drawing, and a shared drawing moved to the screen leaves the link on that chart only', () => {
    const a = mount();
    const b = mount();
    const group = createDrawingLinkGroup({ enabled: true });
    cleanups.push(() => group.destroy());
    group.add(a.chart, a.draw, { symbol: 'X', exchange: 'NSE' });
    group.add(b.chart, b.draw, { symbol: 'X', exchange: 'NSE' });
    viewportRect(a.draw);
    expect(b.draw.drawings()).toHaveLength(0);
    expect(group.share(a.chart)).toBe(0);
    const shared = dataRect(a.draw);
    expect(b.draw.drawings()).toHaveLength(1);
    const copy = b.draw.drawings()[0];
    a.draw.update(shared.id, { space: 'viewport' });
    // The peer keeps its copy where it was, as a drawing of its own.
    expect(b.draw.get(copy.id)?.space).toBeUndefined();
    expect(b.draw.get(copy.id)?.points).toHaveLength(2);
    // Editing the peer no longer reaches the drawing now pinned to the screen.
    b.draw.update(copy.id, { style: { color: '#abcdef' } });
    expect(a.draw.get(shared.id)?.style.color).toBe('#00ffff');
    expect(a.draw.get(shared.id)?.space).toBe('viewport');
    expect(a.draw.get(shared.id)?.props?.['openalgo-charts/drawing-link']).toBeUndefined();
  });
});

describe('the settings schema', () => {
  it('offers the anchor field on exactly the tools that can be anchored to the screen', () => {
    const viewport = BUILTIN_DRAWING_TOOLS.filter(t => t.viewport === true).map(t => t.id).sort();
    expect(viewport).toEqual(['ellipse', 'rectangle', 'table', 'text']);
    const offering = BUILTIN_DRAWING_TOOLS.filter(t => drawingSettingsSchema(t.id).fields.some(f => f.path === 'space')).map(t => t.id).sort();
    expect(offering).toEqual(viewport);
    expect(SPACE_FIELD.options?.map(o => o.value)).toEqual(['data', 'viewport']);
  });

  it('reads and writes the space by its path', () => {
    const d: Drawing = { id: 'x', tool: 'rectangle', points: [], style: {}, paneIndex: 0, zIndex: 0 };
    const schema = drawingSettingsSchema('rectangle');
    expect(readDrawingSetting(d, 'space')).toBeUndefined();
    expect(readDrawingSetting({ ...d, space: 'viewport' }, 'space')).toBe('viewport');
    expect(applyDrawingSettings(d, { space: 'viewport' }, schema)).toEqual({ space: 'viewport' });
    expect(applyDrawingSettings(d, { space: 'sideways' }, schema)).toEqual({});
  });
});
