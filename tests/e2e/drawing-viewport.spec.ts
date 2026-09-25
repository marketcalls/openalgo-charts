import { test, expect, type Page } from '@playwright/test';

/**
 * Viewport-anchored drawings in a real browser: a note and a box pinned to the
 * screen must hold their pixels through a pan, move with the hand when
 * dragged, scale with the chart, and read the same at a device pixel ratio of
 * two. A data-space box painted beside them is the control that does move.
 */

type Box = { x0: number; y0: number; x1: number; y1: number; count: number };

const MAGENTA = 'magenta';
const CYAN = 'cyan';
const YELLOW = 'yellow';

async function mount(page: Page, width = 1200, height = 760) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ready);
  await page.evaluate(async () => {
    (window as any).__api.chart.destroy();
    const { createChart } = await import('/dist/openalgo-charts.mjs');
    const { DrawingController } = await import('/dist/openalgo-charts.draw.mjs');
    const chart = createChart(document.getElementById('c'), { priceAxisWidth: 64, timeAxisHeight: 28, timeNavigator: false });
    const bars = Array.from({ length: 200 }, (_, i) => {
      const close = 23800 + Math.sin(i / 8) * 160;
      return { time: 1750000000 + i * 86400, open: close - 20, high: close + 35, low: close - 40, close };
    });
    chart.addSeries('candlestick').setData(bars);
    chart.setVisibleLogicalRange({ from: 60, to: 160 });
    const draw = new DrawingController(chart);
    const note = draw.add({ tool: 'text', paneIndex: 0, points: [], space: 'viewport', viewportPoints: [{ x: 0.04, y: 0.05 }],
      style: {}, text: { value: 'Pinned note', color: '#ffd400', fontSize: 18, bold: true } });
    const box = draw.add({ tool: 'rectangle', paneIndex: 0, points: [], space: 'viewport',
      viewportPoints: [{ x: 0.55, y: 0.12 }, { x: 0.8, y: 0.3 }], style: { color: '#ff00ff', lineWidth: 4 } });
    const moving = draw.add({ tool: 'rectangle', paneIndex: 0,
      points: [{ time: bars[100].time, price: 23700 }, { time: bars[120].time, price: 23600 }], style: { color: '#00ffff', lineWidth: 4 } });
    (window as any).__pin = { chart, draw, note: note.id, box: box.id, moving: moving.id };
  });
  // Park the pointer off the plot so no hover ring is in the pixels.
  await page.mouse.move(2, 2);
  return errors;
}

/** Bounding box, in device px, of the pixels of one colour on the pane's top canvas. */
async function inkBox(page: Page, color: string, selector = '#c canvas', index = 1): Promise<Box> {
  return page.locator(selector).nth(index).evaluate((element, which) => {
    const c = element as HTMLCanvasElement;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, count: 0 };
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
        if (a < 120) continue;
        const hit = which === 'magenta' ? r > 180 && g < 90 && b > 180
          : which === 'cyan' ? r < 90 && g > 180 && b > 180
          : r > 200 && g > 170 && b < 80;
        if (!hit) continue;
        box.count++;
        box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y);
        box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y);
      }
    }
    return box;
  }, color);
}

const same = (a: Box, b: Box, tolerance = 1) => {
  expect(a.count).toBeGreaterThan(20);
  expect(Math.abs(a.x0 - b.x0)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(a.y0 - b.y0)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(a.x1 - b.x1)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(a.y1 - b.y1)).toBeLessThanOrEqual(tolerance);
};

/** Pan the chart by dragging empty plot, the way a user does. */
async function pan(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  await page.mouse.up();
  await page.mouse.move(2, 2);
}

test('a pinned note and box hold their pixels through a pan while a data box moves', async ({ page }, info) => {
  const errors = await mount(page);
  const before = { box: await inkBox(page, MAGENTA), note: await inkBox(page, YELLOW), moving: await inkBox(page, CYAN) };
  expect(before.moving.count).toBeGreaterThan(20);
  await page.screenshot({ path: info.outputPath('before-pan.png') });
  const range0 = await page.evaluate(() => (window as any).__pin.chart.getVisibleLogicalRange());
  await pan(page, { x: 200, y: 640 }, -260, -40);
  const range1 = await page.evaluate(() => (window as any).__pin.chart.getVisibleLogicalRange());
  expect(Math.abs(range1.from - range0.from)).toBeGreaterThan(5);
  await page.screenshot({ path: info.outputPath('after-pan.png') });
  same(await inkBox(page, MAGENTA), before.box);
  same(await inkBox(page, YELLOW), before.note);
  const moved = await inkBox(page, CYAN);
  expect(Math.abs(moved.x0 - before.moving.x0)).toBeGreaterThan(50);
  // Zoom with the wheel: still where it was.
  await page.mouse.move(500, 500);
  await page.mouse.wheel(0, -400);
  await page.mouse.move(2, 2);
  const span = () => page.evaluate(() => {
    const range = (window as any).__pin.chart.getVisibleLogicalRange();
    return range.to - range.from;
  });
  await expect.poll(async () => Math.abs((await span()) - (range1.to - range1.from))).toBeGreaterThan(2);
  same(await inkBox(page, MAGENTA), before.box);
  same(await inkBox(page, YELLOW), before.note);
  await page.screenshot({ path: info.outputPath('after-zoom.png') });
  expect(errors).toEqual([]);
});

test('a pinned box moves with the pointer, stays proportional on resize and restores', async ({ page }, info) => {
  const errors = await mount(page);
  const before = await inkBox(page, MAGENTA);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  // Grab the box by its edge (its outline is the part that answers the pointer).
  const grab = { x: (before.x0 + before.x1) / 2 / dpr, y: before.y0 / dpr + 2 };
  await pan(page, grab, 80, 40);
  const dragged = await inkBox(page, MAGENTA);
  expect(dragged.x0 - before.x0).toBeGreaterThan(80 * dpr - 3);
  expect(dragged.x0 - before.x0).toBeLessThan(80 * dpr + 3);
  expect(dragged.y0 - before.y0).toBeGreaterThan(40 * dpr - 3);
  expect(dragged.y0 - before.y0).toBeLessThan(40 * dpr + 3);
  const stored = await page.evaluate(() => {
    const { draw, box } = (window as any).__pin;
    return draw.get(box);
  });
  expect(stored.space).toBe('viewport');
  expect(stored.points).toEqual([]);
  await page.screenshot({ path: info.outputPath('after-drag.png') });
  // Resize: the corners stay at the same fraction of the smaller plot.
  await page.setViewportSize({ width: 900, height: 560 });
  await expect.poll(() => page.evaluate(() => (window as any).__pin.chart.timeScale.width)).toBeLessThan(900);
  await page.mouse.move(2, 2);
  const size = await page.evaluate(() => {
    const { chart, draw, box } = (window as any).__pin;
    return { w: chart.timeScale.width, h: chart.panes()[0].priceScale.height, anchors: draw.get(box).viewportPoints };
  });
  await expect.poll(async () => (await inkBox(page, MAGENTA)).x0).toBeLessThan(dragged.x0);
  const resized = await inkBox(page, MAGENTA);
  expect(Math.abs(resized.x0 - size.anchors[0].x * size.w * dpr)).toBeLessThanOrEqual(4);
  expect(Math.abs(resized.y0 - size.anchors[0].y * size.h * dpr)).toBeLessThanOrEqual(4);
  expect(Math.abs(resized.x1 - size.anchors[1].x * size.w * dpr)).toBeLessThanOrEqual(4);
  expect(Math.abs(resized.y1 - size.anchors[1].y * size.h * dpr)).toBeLessThanOrEqual(4);
  await page.screenshot({ path: info.outputPath('after-resize.png') });
  // A save and a restore into a fresh controller put it back where it was.
  await page.evaluate(() => {
    const api = (window as any).__pin;
    const saved = JSON.parse(JSON.stringify(api.draw.toJSON()));
    api.draw.fromJSON({ version: 2, drawings: [] });
    api.draw.fromJSON(saved);
  });
  await page.mouse.move(3, 3);
  same(await inkBox(page, MAGENTA), resized);
  expect(errors).toEqual([]);
});

test.describe('at a device pixel ratio of two', () => {
  test.use({ deviceScaleFactor: 2 });

  test('paints at the same fraction in device px and holds through a pan', async ({ page }, info) => {
    const errors = await mount(page);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    const size = await page.evaluate(() => {
      const { chart } = (window as any).__pin;
      return { w: chart.timeScale.width, h: chart.panes()[0].priceScale.height };
    });
    const before = await inkBox(page, MAGENTA);
    // The outline is centred on the anchors, so its outer edge sits half a line out.
    expect(Math.abs(before.x0 - 0.55 * size.w * 2)).toBeLessThanOrEqual(6);
    expect(Math.abs(before.y1 - 0.3 * size.h * 2)).toBeLessThanOrEqual(6);
    await page.screenshot({ path: info.outputPath('dpr2-before-pan.png') });
    await pan(page, { x: 200, y: 640 }, -260, -40);
    await page.screenshot({ path: info.outputPath('dpr2-after-pan.png') });
    same(await inkBox(page, MAGENTA), before);
    expect(errors).toEqual([]);
  });
});

test('the widget pins a drawing from its properties, and a pan leaves it in place', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto('/tests/e2e/drawing-viewport-fixture.html');
  await page.waitForFunction(() => !!(window as any).__viewport);
  const canvas = '.oac-chart canvas';
  await expect.poll(async () => (await inkBox(page, MAGENTA, canvas)).count).toBeGreaterThan(20);
  // Right-click the box's outline, then Properties.
  const edge = await page.evaluate(() => {
    const { widget, rectId } = (window as any).__viewport;
    const [a, b] = widget.draw.screenPoints(rectId);
    const rect = widget.root.querySelector('.oac-chart').getBoundingClientRect();
    return { x: rect.left + (a.x + b.x) / 2, y: rect.top + Math.min(a.y, b.y) };
  });
  await page.mouse.click(edge.x, edge.y, { button: 'right' });
  await page.getByRole('menuitem', { name: /^Properties/ }).click();
  const anchor = page.locator('.oac-props [data-key="space"] select');
  await expect(anchor).toHaveValue('data');
  await anchor.selectOption('viewport');
  await expect.poll(() => page.evaluate(() => {
    const { widget, rectId } = (window as any).__viewport;
    return widget.draw.get(rectId).space;
  })).toBe('viewport');
  await expect(anchor).toHaveValue('viewport');
  await anchor.scrollIntoViewIfNeeded();
  await page.locator('.oac-props').screenshot({ path: info.outputPath('widget-anchor-row.png') });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.mouse.move(5, 5);
  const before = await inkBox(page, MAGENTA, canvas);
  await page.screenshot({ path: info.outputPath('widget-before-pan.png') });
  const plot = await page.evaluate(() => (window as any).__viewport.widget.root.querySelector('.oac-chart').getBoundingClientRect().toJSON());
  await pan(page, { x: plot.left + 300, y: plot.top + plot.height - 80 }, -220, 0);
  await page.screenshot({ path: info.outputPath('widget-after-pan.png') });
  same(await inkBox(page, MAGENTA, canvas), before);
  expect(errors).toEqual([]);
});
