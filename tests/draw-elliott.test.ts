/**
 * The Elliott wave counts: labels in a degree's notation, and the origin the
 * impulse and the correction gained in 2.7.1. A count saved by 2.7.0 has one
 * anchor fewer, and the engine neither paints nor hit-tests a drawing with
 * fewer anchors than its tool takes, so without the upgrade every saved
 * impulse and correction would vanish from the chart it was drawn on.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Chart } from '../src/core/chart';
import { fakeDocument } from './helpers/fake-dom';
import { DrawingController, getDrawingTool } from '../src/draw/index';
import { migrateDrawings } from '../src/draw/migrate';
import { ELLIOTT_FIELDS, elliottLabels, withWaveOrigin } from '../src/draw/elliott';
import { PATTERN_DRAWING_TOOLS } from '../src/draw/pattern-tools';
import { paintGeometry } from '../src/draw/advanced-shared';
import { RecordingContext } from './helpers/fake-ctx';
import type { Bar } from '../src/model/bar';
import type { Drawing, DrawingPoint } from '../src/draw/types';
import type { PrimitiveRenderContext } from '../src';

beforeAll(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= {};
});

const IMPULSE = ['0', '1', '2', '3', '4', '5'];
const CORRECTION = ['0', 'A', 'B', 'C'];
const texts = (degree: string, tokens: readonly string[], labelStyle?: string): string[] =>
  elliottLabels(tokens, { degree, ...(labelStyle === undefined ? {} : { labelStyle }) }).map(l => l.ring ? `[${l.text}]` : l.text);

describe('wave labels by degree', () => {
  it.each([
    // Three numeral families, each circled, in parentheses and plain, largest degree first.
    ['grand-supercycle', ['[0]', '[I]', '[II]', '[III]', '[IV]', '[V]'], ['[0]', '[A]', '[B]', '[C]']],
    ['supercycle', ['(0)', '(I)', '(II)', '(III)', '(IV)', '(V)'], ['(0)', '(A)', '(B)', '(C)']],
    ['cycle', ['0', 'I', 'II', 'III', 'IV', 'V'], ['0', 'A', 'B', 'C']],
    ['primary', ['[0]', '[1]', '[2]', '[3]', '[4]', '[5]'], ['[0]', '[A]', '[B]', '[C]']],
    ['intermediate', ['(0)', '(1)', '(2)', '(3)', '(4)', '(5)'], ['(0)', '(A)', '(B)', '(C)']],
    ['minor', IMPULSE, CORRECTION],
    ['minute', ['[0]', '[i]', '[ii]', '[iii]', '[iv]', '[v]'], ['[0]', '[a]', '[b]', '[c]']],
    ['minuette', ['(0)', '(i)', '(ii)', '(iii)', '(iv)', '(v)'], ['(0)', '(a)', '(b)', '(c)']],
    ['subminuette', ['0', 'i', 'ii', 'iii', 'iv', 'v'], ['0', 'a', 'b', 'c']],
  ])('%s', (degree, impulse, correction) => {
    // [x] is a label drawn inside a ring.
    expect(texts(degree, IMPULSE)).toEqual(impulse);
    expect(texts(degree, CORRECTION)).toEqual(correction);
  });

  it('writes the combinations and the triangle in the degree\'s letter case', () => {
    expect(texts('minute', ['0', 'W', 'X', 'Y', 'X', 'Z'])).toEqual(['[0]', '[w]', '[x]', '[y]', '[x]', '[z]']);
    expect(texts('cycle', ['0', 'A', 'B', 'C', 'D', 'E'])).toEqual(['0', 'A', 'B', 'C', 'D', 'E']);
  });

  it('lets the label style override the degree\'s own form, never its numerals', () => {
    expect(texts('primary', IMPULSE, 'plain')).toEqual(IMPULSE);
    expect(texts('minor', IMPULSE, 'circled')).toEqual(IMPULSE.map(t => `[${t}]`));
    expect(texts('cycle', CORRECTION, 'parentheses')).toEqual(['(0)', '(A)', '(B)', '(C)']);
    expect(texts('subminuette', IMPULSE, 'degree')).toEqual(['0', 'i', 'ii', 'iii', 'iv', 'v']);
  });

  it('reads an unknown degree or style, or none at all, as plain Minor', () => {
    expect(texts('nonsense', IMPULSE, 'nonsense')).toEqual(IMPULSE);
    expect(elliottLabels(IMPULSE, undefined).map(l => l.text)).toEqual(IMPULSE);
    expect(elliottLabels(CORRECTION, {}).every(l => !l.ring)).toBe(true);
  });

  it('defaults its settings to the labels the wave tools always drew', () => {
    expect(ELLIOTT_FIELDS.map(f => [f.path, f.defaultValue])).toEqual([['props.degree', 'minor'], ['props.labelStyle', 'degree']]);
    expect(ELLIOTT_FIELDS[0]!.options).toHaveLength(9);
  });
});

const rc = (dpr = 1): PrimitiveRenderContext => ({
  plotWidth: 800, plotHeight: 600, dpr, priceAxisWidth: 60,
  priceScale: { priceToY: (price: number) => 600 - price, format: String },
  timeScale: { indexToX: (index: number) => index },
  dataLayer: { timeToIndexFloat: (time: number) => time },
} as unknown as PrimitiveRenderContext);
const point = (time: number, price: number): DrawingPoint => ({ time, price });
const tool = (id: string) => PATTERN_DRAWING_TOOLS.find(t => t.id === id)!;
function paint(d: Drawing, context = rc()): RecordingContext {
  const rec = new RecordingContext();
  tool(d.tool).draw({
    ctx: rec as unknown as CanvasRenderingContext2D, rc: context,
    pts: d.points.map(p => ({ x: p.time * context.dpr, y: (600 - p.price) * context.dpr })),
    drawing: d, style: { color: '#3366cc', lineWidth: 2, ...d.style }, selected: false, formatPrice: String,
  });
  return rec;
}
const wave = (id: string, points: DrawingPoint[], props?: Record<string, unknown>): Drawing =>
  ({ id: 'w', tool: id, points, style: { showLabels: true }, paneIndex: 0, zIndex: 0, ...(props ? { props } : {}) });
const labelsOf = (rec: RecordingContext): string[] => rec.ops.filter(op => op.type === 'fillText').map(op => op.text!);
const IMPULSE_POINTS = [point(100, 100), point(200, 300), point(300, 200), point(400, 450), point(500, 350), point(600, 500)];

describe('a wave count on the chart', () => {
  it('draws a ring round each circled label, solid whatever the line\'s dash', () => {
    const plain = paint(wave('elliott-impulse', IMPULSE_POINTS));
    const circled = paint(wave('elliott-impulse', IMPULSE_POINTS, { degree: 'primary' }));
    expect(labelsOf(circled)).toEqual(IMPULSE);
    expect(circled.count('arc') - plain.count('arc')).toBe(6);
    const dashed = wave('elliott-impulse', IMPULSE_POINTS, { labelStyle: 'circled' });
    dashed.style.lineStyle = 'dashed';
    const rec = paint(dashed);
    // The legs are dashed, and each ring sets the dash back to solid before it strokes.
    const dashes = rec.ops.filter(op => op.type === 'setLineDash');
    expect(dashes.some(op => op.args.length > 0)).toBe(true);
    expect(dashes.filter(op => op.args.length === 0)).toHaveLength(6);
  });

  it('labels the degree it is given', () => {
    expect(labelsOf(paint(wave('elliott-correction', IMPULSE_POINTS.slice(0, 4), { degree: 'minuette' }))))
      .toEqual(['(0)', '(a)', '(b)', '(c)']);
  });

  it('keeps two circled labels that land close together from overlapping', () => {
    // Text widths alone kept these apart, but their rings, which stand past
    // the text on every side, crossed.
    const rec = new RecordingContext();
    const context = rc();
    paintGeometry({
      ctx: rec as unknown as CanvasRenderingContext2D, rc: context, pts: [],
      drawing: wave('elliott-impulse', []), style: { color: '#3366cc', lineWidth: 2 }, selected: false, formatPrice: String,
    }, { paths: [], labels: [{ at: { x: 100, y: 100 }, text: '1', ring: true }, { at: { x: 112, y: 100 }, text: '2', ring: true }] });
    const rings = rec.ops.filter(op => op.type === 'arc').map(op => op.args as number[]);
    expect(rings).toHaveLength(2);
    const [a, b] = rings as [number[], number[]];
    expect(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)).toBeGreaterThanOrEqual(a[2]! + b[2]!);
  });

  it('shows the origin of a count placed with one, even on its first wave\'s end', () => {
    // Only a tool that had no origin through 2.7.0 can carry one that stands for none.
    const points = [point(100, 100), point(100, 100), point(300, 200), point(400, 50), point(500, 150), point(600, 100)];
    expect(labelsOf(paint(wave('elliott-triangle', points)))).toEqual(['0', 'A', 'B', 'C', 'D', 'E']);
  });

  it('hides the origin of an upgraded count until it is moved off wave one', () => {
    // A 2.7.0 impulse, upgraded: its origin is a copy of its first anchor.
    const upgraded = wave('elliott-impulse', withWaveOrigin('elliott-impulse', IMPULSE_POINTS.slice(1)));
    const rec = paint(upgraded);
    expect(labelsOf(rec)).toEqual(['1', '2', '3', '4', '5']);
    // Four legs, as 2.7.0 drew: no zero-length leg from the origin to wave one.
    expect(rec.count('stroke')).toBe(4);
    const moved = paint(wave('elliott-impulse', IMPULSE_POINTS));
    expect(labelsOf(moved)).toEqual(IMPULSE);
    expect(moved.count('stroke')).toBe(5);
  });
});

describe('the origin upgrade', () => {
  const old = IMPULSE_POINTS.slice(1);

  it('gives a 2.7.0 impulse or correction an origin on its first anchor, and nothing else one', () => {
    expect(withWaveOrigin('elliott-impulse', old)).toEqual([old[0], ...old]);
    expect(withWaveOrigin('elliott-correction', old.slice(0, 3))).toEqual([old[0], ...old.slice(0, 3)]);
    expect(withWaveOrigin('elliott-impulse', old)[0]).not.toBe(old[0]);
    for (const [id, points] of [['elliott-impulse', IMPULSE_POINTS], ['elliott-correction', IMPULSE_POINTS.slice(0, 4)],
      ['elliott-triangle', old], ['abcd-pattern', old.slice(0, 3)], ['trend-line', []]] as const) {
      expect(withWaveOrigin(id, [...points])).toEqual(points);
    }
  });

  it('runs on every load, once', () => {
    const saved = {
      version: 3,
      drawings: [
        { id: 'i', tool: 'elliott-impulse', points: old, style: { showLabels: true, color: '#123456' }, paneIndex: 0, zIndex: 1 },
        { id: 'c', tool: 'elliott-correction', points: old.slice(0, 3), style: {}, paneIndex: 1, zIndex: 0, locked: true },
        { id: 't', tool: 'trend-line', points: old.slice(0, 2), style: {}, paneIndex: 0, zIndex: 0 },
      ],
    };
    const once = migrateDrawings(structuredClone(saved));
    expect(once.drawings.map(d => d.points.length)).toEqual([6, 4, 2]);
    expect(once.drawings[0]!.points[0]).toEqual(old[0]);
    expect(once.drawings[0]!.style.color).toBe('#123456');
    expect(once.drawings[1]!.locked).toBe(true);
    expect(migrateDrawings(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('leaves a 2.7.0 count visible and editable after a restore and on add', () => {
    const chart = new Chart(fakeDocument().createElement('div') as unknown as HTMLElement, {
      document: fakeDocument(),
      raf: { schedule: (cb: (t: number) => void) => { cb(0); return 0; } },
      pixelRatio: () => 1, shortcuts: false,
    });
    chart.applySize(800, 600);
    const bars: Bar[] = Array.from({ length: 120 }, (_, i) => ({ time: 1700000000 + i * 60, open: 100, high: 102, low: 98, close: 100 }));
    chart.addSeries('candlestick').setData(bars);
    const draw = new DrawingController(chart);
    const at = (i: number, price: number): DrawingPoint => ({ time: 1700000000 + i * 60, price });
    const saved = [at(10, 99), at(20, 101), at(30, 100), at(40, 102), at(50, 101)];
    draw.fromJSON({ version: 2, drawings: [{ id: 'old', tool: 'elliott-impulse', points: saved, style: {}, paneIndex: 0, zIndex: 0 }] });
    const restored = draw.get('old')!;
    expect(restored.points).toHaveLength(getDrawingTool('elliott-impulse').points);
    expect(draw.screenPoints('old')).toHaveLength(6);
    const added = draw.add({ tool: 'elliott-correction', points: saved.slice(0, 3), style: {}, paneIndex: 0 });
    expect(added.points).toHaveLength(getDrawingTool('elliott-correction').points);
    expect(draw.toJSON().drawings.map(d => d.points.length)).toEqual([6, 4]);
  });
});
