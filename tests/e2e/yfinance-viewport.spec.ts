import { test, expect, type Page } from '@playwright/test';

/**
 * The reference host's pin toggle, in a real browser: a box pinned from the
 * properties bar keeps its pixels while the chart pans under it, and unpinning
 * puts it back on the bars it covers.
 */

const PAGE = '/examples/yfinance/index.html?test=1';
const PROBE = '/api/history?symbol=AAPL&interval=1d&period=1mo';
let serverUp: boolean | null = null;

test.beforeEach(async ({ request, page }) => {
  if (serverUp === null) serverUp = await request.get(PROBE).then(response => response.ok(), () => false);
  test.skip(!serverUp, 'The reference fixture server is unavailable');
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(PAGE);
  await page.waitForFunction(() => Boolean((window as any).__oac?.app?.currentBars?.length));
});

type Box = { x0: number; y0: number; x1: number; y1: number; count: number };

/** Bounding box of the magenta outline on the main pane's top canvas, in device px. */
async function magenta(page: Page): Promise<Box> {
  return page.locator('#chart canvas').nth(1).evaluate(element => {
    const c = element as HTMLCanvasElement;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, count: 0 };
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (data[i + 3] < 120 || data[i] < 180 || data[i + 1] > 90 || data[i + 2] < 180) continue;
        box.count++;
        box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y);
        box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y);
      }
    }
    return box;
  });
}

test('the pin toggle keeps a box in place through a pan, and unpinning returns it to the bars', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = await page.evaluate(() => {
    const app = (window as any).__oac.app;
    const bars = app.currentBars;
    const a = bars[bars.length - 40];
    const b = bars[bars.length - 20];
    const drawing = app.draw.add({ tool: 'rectangle', paneIndex: 0, style: { color: '#ff00ff', lineWidth: 4 },
      points: [{ time: a.time, price: Math.max(a.high, b.high) }, { time: b.time, price: Math.min(a.low, b.low) }] });
    app.draw.select(drawing.id);
    return drawing.id;
  });
  const pin = page.locator('#propbar [data-path="space"]');
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#propbar').screenshot({ path: info.outputPath('host-pinned-bar.png') });
  expect(await page.evaluate(i => (window as any).__oac.app.draw.get(i).space, id)).toBe('viewport');
  // Deselect so the handles and the bar are out of the pixels.
  await page.evaluate(() => (window as any).__oac.app.draw.select(null));
  const box = await page.locator('#chart').boundingBox();
  if (!box) throw new Error('Chart is not visible');
  await page.mouse.move(box.x + 5, box.y + 5);
  await expect.poll(async () => (await magenta(page)).count).toBeGreaterThan(20);
  const before = await magenta(page);
  await page.screenshot({ path: info.outputPath('host-before-pan.png') });
  const range0 = await page.evaluate(() => (window as any).__oac.app.chart.getVisibleLogicalRange());
  await page.mouse.move(box.x + 120, box.y + box.height - 90);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + box.height - 90, { steps: 10 });
  await page.mouse.up();
  await page.mouse.move(box.x + 5, box.y + 5);
  const range1 = await page.evaluate(() => (window as any).__oac.app.chart.getVisibleLogicalRange());
  expect(Math.abs(range1.from - range0.from)).toBeGreaterThan(3);
  await page.screenshot({ path: info.outputPath('host-after-pan.png') });
  const after = await magenta(page);
  for (const key of ['x0', 'y0', 'x1', 'y1'] as const) expect(Math.abs(after[key] - before[key])).toBeLessThanOrEqual(1);
  // Unpin: back on time and price, under the same pixels it was pinned at.
  await page.evaluate(i => (window as any).__oac.app.draw.select(i), id);
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  const back = await page.evaluate(i => (window as any).__oac.app.draw.get(i), id);
  expect(back.space).toBeUndefined();
  expect(back.points).toHaveLength(2);
  expect(errors).toEqual([]);
});
