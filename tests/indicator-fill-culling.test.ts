/**
 * An indicator fill paints the points in view, not its whole history (audit C4).
 *
 * The band used to project every point and path a polygon of up to twice the
 * history on every base paint, almost all of it outside the clip: at 200,000
 * bars one RSI cost a pan frame milliseconds against a tenth of one for the
 * rest. Culling has to leave the picture inside the plot exactly as it was,
 * at the edges too, so the second half samples what each polygon covers there
 * and holds it to what the full walk drew.
 */
import { describe, expect, it } from 'vitest';
import { IndicatorFill, type FillPoint, type IndicatorFillOptions } from '../src/primitives/indicator-fill';
import type { PrimitiveRenderContext } from '../src/primitives/primitive';
import { makeCtx, type RecordingContext } from './helpers/fake-ctx';

const WIDTH = 400, HEIGHT = 500;

/** A render context whose time scale shows `from..to` across the plot; `projections` counts index-to-x calls. */
function context(from: number, to: number, shown = { from, to }): PrimitiveRenderContext & { projections: number } {
  const rc = {
    projections: 0, dpr: 1, plotWidth: WIDTH, plotHeight: HEIGHT,
    timeScale: { indexToX: (i: number) => { rc.projections++; return (i - from) * WIDTH / (to - from); }, visibleRange: () => shown },
    priceScale: { priceToY: (v: number) => (100 - v) * 5 },
  };
  return rc as unknown as PrimitiveRenderContext & { projections: number };
}

function paint(fill: IndicatorFill, rc: PrimitiveRenderContext): RecordingContext {
  const { ctx, rec } = makeCtx();
  fill.draw(ctx, rc);
  return rec;
}

describe('IndicatorFill on a long history', () => {
  it('projects and paths only the points in view', () => {
    const fill = new IndicatorFill({ colorUp: 'red', colorDown: 'blue' });
    fill.setPoints(Array.from({ length: 200_000 }, (_, index) => ({ index, a: 2 + Math.sin(index / 7), b: 1 })));
    const rc = context(199_800, 199_999);
    const rec = paint(fill, rc);
    // 200 bars in view: a point either side, each projected once, a vertex per side.
    expect(rc.projections).toBeLessThan(500);
    expect(rec.count('lineTo')).toBeLessThan(500);
    expect(rec.count('fill')).toBe(1);
  });

  it('measures a gradient band against the whole band, once per set of points', () => {
    const fill = new IndicatorFill({ colorUp: 'red', colorDown: 'blue', gradient: { topColor: '#fff', bottomColor: '#000' } });
    const points: FillPoint[] = Array.from({ length: 1000 }, (_, index) => ({ index, a: index === 0 ? 90 : 55, b: index === 0 ? 10 : 50 }));
    fill.setPoints(points);
    const gradientAt = (rec: RecordingContext): number[] => rec.ops.find(op => op.type === 'createLinearGradient')!.args;
    // The extremes sit at bar 0, far out of view, and still anchor the stops.
    expect(gradientAt(paint(fill, context(900, 999)))).toEqual([0, (100 - 90) * 5, 0, (100 - 10) * 5]);
    let reads = 0;
    const counted = new Proxy(points[0]!, { get: (target, key) => { if (key === 'a') reads++; return target[key as keyof FillPoint]; } });
    fill.setPoints([counted, ...points.slice(1)]);
    paint(fill, context(900, 999));
    paint(fill, context(900, 999));
    expect(reads).toBe(1);
  });
});

/** Each filled polygon: its vertices and what it was filled with. */
function polygons(rec: RecordingContext): { points: [number, number][]; style: string }[] {
  const out: { points: [number, number][]; style: string }[] = [];
  let path: [number, number][] = [];
  for (const op of rec.ops) {
    if (op.type === 'beginPath') path = [];
    else if (op.type === 'moveTo' || op.type === 'lineTo') path.push([op.args[0]!, op.args[1]!]);
    else if (op.type === 'fill') out.push({ points: path, style: String(op.fillStyle) });
  }
  return out;
}

function inside(poly: readonly [number, number][], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** What paints each sample point of the plot, in paint order: the picture a clip to the plot leaves. */
function coverage(rec: RecordingContext): string[] {
  const polys = polygons(rec), out: string[] = [];
  for (let x = 0.37; x < WIDTH; x += 3.1) {
    for (let y = 0.41; y < HEIGHT; y += 4.3) out.push(polys.filter(p => inside(p.points, x, y)).map(p => p.style).join(','));
  }
  return out;
}

const gradients = (rec: RecordingContext): string[] => rec.ops.filter(op => op.type === 'createLinearGradient').map(op => op.args.join(' '));

describe('IndicatorFill culled to the view', () => {
  // Crossings, a gap, a run in its own colour and a run with its own gradient.
  const points: FillPoint[] = Array.from({ length: 60 }, (_, i) => ({
    index: i,
    a: i === 20 || i === 21 ? null : 50 + 10 * Math.sin(i / 4),
    b: 50 + 10 * Math.cos(i / 5),
    color: i >= 30 && i < 40 ? '#ff00ff' : undefined,
    gradient: i >= 45 && i < 55 ? { topValue: 60, bottomValue: 40, topColor: '#0f0', bottomColor: '#00f' } : undefined,
  }));
  const options: IndicatorFillOptions[] = [
    { colorUp: 'red', colorDown: 'blue' },
    { colorUp: 'red', colorDown: 'blue', gradient: { topColor: '#fff', bottomColor: '#000' } },
  ];
  // Mid run, across a gap, across the colour and gradient changes, the whole
  // band, past either end, and a view narrower than one bar.
  const views: [number, number][] = [[10.3, 25.7], [18.6, 23.4], [28.5, 41.2], [44.9, 58.1], [0, 59], [-5, 3], [57, 70], [12.2, 12.8], [7, 8]];

  for (const [k, option] of options.entries()) {
    for (const [from, to] of views) {
      it(`paints ${from}..${to} as the full walk does (options ${k})`, () => {
        const fill = new IndicatorFill(option);
        fill.setPoints(points);
        const culled = paint(fill, context(from, to));
        const full = paint(fill, context(from, to, { from: -Infinity, to: Infinity }));
        expect(coverage(culled)).toEqual(coverage(full));
        // A band gradient keeps the stops of the whole band, not of the points in view.
        for (const gradient of gradients(culled)) expect(gradients(full)).toContain(gradient);
      });
    }
  }
});
