import { test, expect, type Page } from '@playwright/test';

const ORIGIN = 'http://127.0.0.1:8124';
const PAGE = ORIGIN + '/examples/yfinance/index.html?test=1';
const PROBE = ORIGIN + '/api/history?symbol=AAPL&interval=1d&period=1mo';

let serverUp: boolean | null = null;

test.use({
  viewport: { width: 390, height: 740 },
  hasTouch: true,
});

test.beforeEach(async ({ request }) => {
  if (serverUp === null) serverUp = await request.get(PROBE).then((response) => response.ok(), () => false);
  test.skip(!serverUp, 'the yfinance fixture server is not available');
});

async function openDemo(page: Page): Promise<void> {
  await page.goto(PAGE);
  await page.waitForFunction(() => {
    const host = (window as any).__oac;
    return Boolean(host && host.chart && host.draw && host.app.currentBars.length > 0);
  });
}

test('compact touch controls draw, undo and navigate in portrait and landscape', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(String(error)));
  await openDemo(page);

  const bar = page.locator('#mobilebar');
  await expect(bar).toBeVisible();
  await expect(page.locator('#rail')).toBeHidden();
  const sizes = await bar.locator('select, button').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(44);

  await page.locator('#mobile-draw').selectOption('trend-line');
  expect(await page.evaluate(() => (window as any).__oac.draw.activeTool())).toBe('trend-line');
  const chart = page.locator('#chart');
  const box = await chart.boundingBox();
  if (!box) throw new Error('the chart has no layout box');
  await page.touchscreen.tap(box.x + box.width * 0.28, box.y + box.height * 0.46);
  await page.touchscreen.tap(box.x + box.width * 0.58, box.y + box.height * 0.30);
  await expect.poll(() => page.evaluate(() => (window as any).__oac.draw.drawings().length)).toBe(1);

  await page.locator('#mobile-cursor').click();
  await page.keyboard.press('Control+z');
  await expect.poll(() => page.evaluate(() => (window as any).__oac.draw.drawings().length)).toBe(0);
  await expect(page.locator('#mobile-undo')).toBeDisabled();
  await expect(page.locator('#mobile-redo')).toBeEnabled();
  await page.locator('#mobile-redo').click();
  await expect.poll(() => page.evaluate(() => (window as any).__oac.draw.drawings().length)).toBe(1);
  await page.locator('#mobile-undo').click();
  await expect.poll(() => page.evaluate(() => (window as any).__oac.draw.drawings().length)).toBe(0);
  await page.locator('#mobile-redo').click();
  await expect.poll(() => page.evaluate(() => (window as any).__oac.draw.drawings().length)).toBe(1);

  const span = () => page.evaluate(() => {
    const range = (window as any).__oac.chart.getVisibleLogicalRange();
    return range.to - range.from;
  });
  const before = await span();
  await page.locator('#mobile-zoom-in').click();
  expect(await span()).toBeLessThan(before);

  await page.setViewportSize({ width: 740, height: 390 });
  await expect(bar).toBeVisible();
  const shell = await page.locator('#shellbar').boundingBox();
  const landscapeChart = await chart.boundingBox();
  expect(shell?.height).toBeLessThanOrEqual(54);
  expect(landscapeChart?.height).toBeGreaterThan(200);
  expect(await page.evaluate(() => (window as any).__oac.draw.drawings().length)).toBe(1);

  await page.setViewportSize({ width: 1024, height: 600 });
  await expect(bar).toBeVisible();
  await page.getByRole('button', { name: 'Replay this session bar by bar' }).click();
  await expect(page.locator('#replaypick')).toBeVisible();
  const wideChart = await chart.boundingBox();
  if (!wideChart) throw new Error('the wide chart has no layout box');
  await page.touchscreen.tap(wideChart.x + wideChart.width * 0.4, wideChart.y + wideChart.height * 0.4);
  await expect(page.locator('#replaybar')).toBeVisible();
  const replayBox = await page.locator('#replaybar').boundingBox();
  const mobileBox = await bar.boundingBox();
  if (!replayBox || !mobileBox) throw new Error('the replay or mobile controls have no layout box');
  expect(replayBox.y + replayBox.height).toBeLessThanOrEqual(mobileBox.y);
  const magnetHit = await page.locator('#mobile-magnet').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('#mobile-magnet') === node;
  });
  expect(magnetHit).toBe(true);
  expect(errors).toEqual([]);
});

test('reduced motion makes wheel navigation settle in the input frame', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openDemo(page);
  const wheelSpacing = (selector: '#chart' | '#chart2', key: 'chart' | 'chart2') => page.locator(selector).evaluate((node, chartKey) => {
    const host = (window as any).__oac;
    const chart = chartKey === 'chart2' ? host.app.chart2 : host.chart;
    const before = chart.timeScale.barSpacing;
    const rect = node.getBoundingClientRect();
    node.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
      cancelable: true,
    }));
    return {
      before,
      after: chart.timeScale.barSpacing,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  }, key);

  const wheelFactor = Math.exp(Math.log(1.1) * 1.2);
  const primary = await wheelSpacing('#chart', 'chart');
  expect(primary.reduced).toBe(true);
  expect(primary.after).toBeCloseTo(primary.before * wheelFactor, 8);

  await page.getByRole('button', { name: /Open a second, linked chart/ }).click();
  await page.waitForFunction(() => {
    const second = (window as any).__oac.app.chart2;
    return Boolean(second && second.dataLayer.length > 0);
  });
  const second = await wheelSpacing('#chart2', 'chart2');
  expect(second.after).toBeCloseTo(second.before * wheelFactor, 8);
});
