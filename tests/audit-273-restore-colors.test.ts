/**
 * A drawing's colour is text from outside: a saved layout, a paste, a host
 * call. It is checked as a colour where it comes in (the migration a load and
 * a paste both run), and the one place the widget writes colours into a
 * stylesheet value, the mixed swatch, writes only colours it has parsed. A
 * colour that closes the gradient and adds a `url()` layer would otherwise
 * make the browser fetch it as soon as two such drawings are selected.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Bar } from '../src/index';
import { decodeClipboardPayload, DRAWING_CLIPBOARD_KEY, migrateDrawings, sanitizeDrawing } from '../src/draw/index';
import { createWidget, type Widget } from '../src/widget/index';
import { ensureWindowGlobal, fakeContainer, fakeWidgetDocument, type FakeElement } from './helpers/fake-dom-widget';

const HOSTILE = 'red, blue), url(//probe.invalid/b), linear-gradient(red';
const T0 = 1_700_000_000;
const entry = (color: string, price: number, extra: Record<string, unknown> = {}) => ({
  tool: 'horizontal-line', points: [{ time: T0, price }], style: { color, ...extra }, paneIndex: 0, zIndex: 0,
});

describe('a drawing colour is checked where it comes in', () => {
  it('the migration keeps every colour CSS writes and drops anything else', () => {
    const kept = ['#f0a020', '#fff', '#11223344', 'red', 'transparent', 'rgba(41, 98, 255, 0.2)', 'rgb(1 2 3 / 50%)',
      'hsl(120deg 50% 50%)', 'oklch(0.7 0.1 120)', 'color(display-p3 1 0 0)', 'color-mix(in srgb, red 40%, blue)'];
    const doc = migrateDrawings(kept.map((color, i) => entry(color, i, { fillColor: color })));
    expect(doc.drawings.map(d => d.style.color)).toEqual(kept);
    expect(doc.drawings.map(d => d.style.fillColor)).toEqual(kept);
    const refused = [HOSTILE, 'url(//probe.invalid/a)', 'red;background:url(x)', 'var(--x)', 'rgb(1, 2, 3)) , url(x', '', 'expression(alert(1))'];
    const dropped = migrateDrawings(refused.map((color, i) => ({ ...entry(color, i, { fillColor: color }),
      style: { color, fillColor: color, levels: [{ ratio: 0.5, color }] } })));
    // The drawing stays, as for any field of the wrong type; only the colour goes.
    expect(dropped.drawings).toHaveLength(refused.length);
    for (const d of dropped.drawings) {
      expect(d.style.color).toBeUndefined();
      expect(d.style.fillColor).toBeUndefined();
      expect(d.style.levels).toEqual([{ ratio: 0.5 }]);
    }
  });

  it('a paste, and the gate a host runs on its own transport, take no colour that is not one', () => {
    const payload = JSON.stringify({ [DRAWING_CLIPBOARD_KEY]: { version: 2, drawings: [entry(HOSTILE, 120), entry('lime', 130)] } });
    const decoded = decodeClipboardPayload(payload);
    expect(decoded?.map(d => d.style.color)).toEqual([undefined, 'lime']);
    expect(sanitizeDrawing(entry(HOSTILE, 120))?.style.color).toBeUndefined();
    expect(sanitizeDrawing({ ...entry('#000', 1), style: { levels: [{ ratio: 1, color: HOSTILE }] } })?.style.levels).toEqual([{ ratio: 1 }]);
  });
});

describe('the mixed colour swatch', () => {
  beforeAll(ensureWindowGlobal);
  const live: Widget[] = [];
  afterEach(() => { for (const w of live.splice(0)) if (!w.isDestroyed) w.destroy(); });

  it('writes only parsed colours into the gradient, whatever text a host gave the drawings', () => {
    const doc = fakeWidgetDocument();
    const w = createWidget(fakeContainer(doc, 1000, 640) as unknown as HTMLElement, {
      document: doc as unknown as Document, mobile: 'never', pixelRatio: () => 1,
      raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
    });
    live.push(w);
    w.chart.applySize(900, 560);
    const bars: Bar[] = Array.from({ length: 60 }, (_, i) => ({ time: T0 + i * 300, open: 100, high: 102, low: 99, close: 101 }));
    w.series.setData(bars);
    const at = (color: string, from: number) => w.draw.add({ tool: 'trend-line', paneIndex: 0, style: { color },
      points: [{ time: bars[from]!.time, price: 100 }, { time: bars[from + 20]!.time, price: 101 }] });
    // A host call is not migrated, so the swatch is the last line.
    const a = at(HOSTILE, 5), b = at('rgba(42, 157, 244, 0.5)', 10);
    w.draw.select([a.id, b.id]);
    const swatch = (w.root as unknown as FakeElement).querySelector('[data-drawbar="color"]') as FakeElement;
    const image = swatch.style.backgroundImage;
    expect(image).not.toContain('url(');
    // One gradient of two stops and nothing after it: the text that is not a
    // colour shows as the theme's line colour, the other as it parses.
    expect(image).toMatch(/^linear-gradient\(135deg, (#[\da-f]{3,8}|rgba\([\d.,]+\)) 0 50%, rgba\(42,157,244,0\.5\) 50% 100%\)$/i);
    const c = at('#f0a020', 15);
    w.draw.select([b.id, c.id]);
    expect(swatch.style.backgroundImage).toContain('#f0a020');
  });
});
