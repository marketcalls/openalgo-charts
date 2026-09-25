/**
 * Explicit pane and scale targets for a study's background shading.
 *
 * `background` used to shade one layer: the study's own pane, behind its plots.
 * A study in its own pane has regimes to state about the candles too, and a
 * study whose plots sit on two panes has one per plot. The hook can now return
 * a list of targeted columns, each naming the price pane (`overlay: true`) or a
 * declared plot (`plot: key`), and the runtime keeps one owned layer per target
 * that follows moves, scale reassignment, hiding, removal and restore, and
 * stacks predictably with the drawing and marker targets.
 *
 * The first block pins what a descriptor that names no target renders. Its
 * digests were recorded before background targets existed, so any change to
 * the default path fails here rather than in someone's chart.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Chart } from '../src/core/chart';
import type { Pane, PaneRenderContext } from '../src/core/pane';
import { registerIndicator, type IndicatorDescriptor } from '../src/model/indicator-registry';
import type { IndicatorApi } from '../src/model/indicator-instance';
import type { Bar } from '../src/model/bar';
import type { IPrimitive, PrimitiveRenderContext } from '../src/primitives/primitive';
import { IndicatorBackground } from '../src/primitives/indicator-background';
import { makeCtx } from './helpers/fake-ctx';
import { fakeDocument, type FakeElement } from './helpers/fake-dom';

const T0 = 1700000000;
const BARS: Bar[] = Array.from({ length: 40 }, (_, i) => {
  const close = 120 + 10 * Math.sin(i / 5);
  return { time: T0 + i * 60, open: close - 1, high: close + 3, low: close - 3, close };
});

const charts: Chart[] = [];
beforeAll(() => { (globalThis as { window?: unknown }).window ??= {}; });
afterEach(() => { for (const chart of charts.splice(0)) chart.destroy(); });

function mount(): Chart {
  const document = fakeDocument();
  const el = document.createElement('div') as unknown as FakeElement;
  const chart = new Chart(el, {
    document, pixelRatio: () => 1, shortcuts: false, timeNavigator: false, animZoom: false, animAutoscale: false,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
  });
  charts.push(chart);
  chart.applySize(800, 600);
  chart.addSeries('candlestick').setData(BARS);
  return chart;
}

interface ChartInternals {
  _renderContext(showTimeAxis: boolean): PaneRenderContext;
  _bottomPaneIndex(): number;
}
interface PaneInternals {
  _primitiveContext(ctx: PaneRenderContext): PrimitiveRenderContext;
  _boundPrimitiveContext(p: IPrimitive, context: PrimitiveRenderContext, ctx: PaneRenderContext): PrimitiveRenderContext;
}

/** Paint one primitive the way its pane would, into a recorder, and return the ops. */
function paint(chart: Chart, paneIndex: number, primitive: IPrimitive): unknown[] {
  const internals = chart as unknown as ChartInternals;
  const pane = chart.panes()[paneIndex] as unknown as PaneInternals;
  const ctx = internals._renderContext(paneIndex === internals._bottomPaneIndex());
  const rc = pane._boundPrimitiveContext(primitive, pane._primitiveContext(ctx), ctx);
  const { ctx: canvas, rec } = makeCtx();
  primitive.draw?.(canvas, rc);
  return rec.ops;
}

const paneOf = (chart: Chart, primitive: IPrimitive): number => chart.panes().findIndex(pane => pane.hasPrimitive(primitive));
const owned = (study: IndicatorApi): { primitive: IPrimitive; overlay: boolean }[] =>
  (study as unknown as { renderResources(): { primitives: { primitive: IPrimitive; overlay: boolean }[] } }).renderResources().primitives;
/** SHA-256 of the JSON form, through the platform digest so the suite needs no runtime typings. */
const digest = async (value: unknown): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
};

/** Every study-owned shading layer: its pane, its binding, its placement role and what it paints. */
function shading(chart: Chart, study: IndicatorApi): { pane: number; scale: string | null; overlay: boolean; ops: unknown[] }[] {
  return owned(study).filter(({ primitive }) => primitive instanceof IndicatorBackground).map(({ primitive, overlay }) => {
    const pane = paneOf(chart, primitive);
    return { pane, scale: chart.panes()[pane]?.primitiveScaleId(primitive) ?? null, overlay, ops: paint(chart, pane, primitive) };
  });
}
const placed = (chart: Chart, study: IndicatorApi) => shading(chart, study).map(({ ops: _ops, ...rest }) => rest);

/** Two states and gaps, including a warmup and a hole in the middle of a run. */
const REGIME = (bars: readonly Bar[]): (string | null)[] =>
  bars.map((_, i) => (i < 5 || i % 7 === 5 ? null : i % 7 < 3 ? 'rgba(38,166,154,0.2)' : 'rgba(239,83,80,0.2)'));

const untargetedPane: IndicatorDescriptor = {
  id: 'bg-untargeted-pane', name: 'Untargeted pane', placement: 'pane', inputs: [],
  plots: [{ key: 'osc', type: 'line', title: 'Osc' }, { key: 'alt', type: 'line', title: 'Alt' }],
  calc: bars => ({ osc: bars.map((_, i) => 30 + i), alt: bars.map((_, i) => 60 - i / 2) }),
  background: ({ bars }) => REGIME(bars),
};

const untargetedPrice: IndicatorDescriptor = {
  id: 'bg-untargeted-price', name: 'Untargeted price', placement: 'onchart', inputs: [],
  plots: [{ key: 'mid', type: 'line', title: 'Mid' }],
  calc: bars => ({ mid: bars.map(bar => (bar.open + bar.close) / 2) }),
  background: ({ bars }) => bars.map((_, i) => (i >= 10 && i < 20 ? '#123456' : null)),
};

/** Class names of what the pane draws, in the order it draws them, for the named studies' layers. */
function stackOn(chart: Chart, studies: Record<string, IndicatorApi>, pane: Pane): string[] {
  return pane.primitives().flatMap(primitive => {
    const owner = Object.entries(studies).find(([, study]) => owned(study).some(item => item.primitive === primitive))?.[0];
    return owner === undefined ? [] : [`${owner} ${primitive.constructor.name}`];
  });
}

describe('shading that names no target', () => {
  it('keeps one unbound layer in the study pane, painted exactly as before', async () => {
    registerIndicator(untargetedPane);
    registerIndicator(untargetedPrice);
    const chart = mount();
    const pane = chart.addIndicator(untargetedPane.id);
    const price = chart.addIndicator(untargetedPrice.id);
    expect(placed(chart, pane)).toEqual([{ pane: 1, scale: null, overlay: false }]);
    expect(placed(chart, price)).toEqual([{ pane: 0, scale: null, overlay: false }]);
    const ops = [...shading(chart, pane), ...shading(chart, price)].map(layer => layer.ops);
    expect(ops.every(list => list.length > 2)).toBe(true);
    expect(await digest(ops)).toBe('6e7481c26ab5d9a90a7ca7baf38ab43d6c441376ad0ab285e26930ae43634f27');
  });

  it('stacks behind the study\'s other layers where it always did', () => {
    const id = `bg-untargeted-stack-${seq++}`;
    registerIndicator({
      ...untargetedPane, id,
      draws: ({ bars }) => [{ kind: 'box', from: { time: bars[10].time, price: 40 }, to: { time: bars[20].time, price: 50 }, id: 'zone' }],
      markers: ({ bars }) => [{ time: bars[12].time, position: 'aboveBar', shape: 'circle', size: 'small', color: '#ef5350' }],
    });
    const chart = mount();
    const study = chart.addIndicator(id);
    expect(stackOn(chart, { S: study }, chart.panes()[1])).toEqual([
      'S PaneLegend', 'S SeriesMarkers', 'S IndicatorDrawings', 'S IndicatorBackground',
    ]);
  });

  it('moves with the study, hides in place and goes with it', () => {
    const chart = mount();
    registerIndicator(untargetedPane);
    const study = chart.addIndicator(untargetedPane.id);
    const [layer] = owned(study).filter(({ primitive }) => primitive instanceof IndicatorBackground).map(({ primitive }) => primitive);
    expect(chart.moveIndicator(study.id, 0)).toBe(true);
    expect(placed(chart, study)).toEqual([{ pane: 0, scale: null, overlay: false }]);
    study.setVisible(false);
    expect(shading(chart, study).map(item => item.ops)).toEqual([[]]);
    study.setVisible(true);
    expect(owned(study).some(item => item.primitive === layer)).toBe(true);
    study.remove();
    expect(chart.panes()[0].primitives().some(primitive => primitive instanceof IndicatorBackground)).toBe(false);
  });
});

let seq = 0;
