import { test, expect } from '@playwright/test';

test.use({ hasTouch: true });

test('touch drawing controls work in portrait and remain available in landscape', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto('/tests/e2e/widget-mobile-fixture.html');
  await page.waitForFunction(() => (window as any).__loaded > 0);
  await page.locator('[data-mobile-action=draw]').tap();
  await page.locator('[data-tool=trend-line].oac-mobile__tool').tap();
  await page.touchscreen.tap(90, 260);
  await page.touchscreen.tap(240, 400);
  await page.waitForFunction(() => (window as any).__widget.draw.drawings().length === 1);
  expect(await page.evaluate(() => (window as any).__widget.draw.drawings()[0].points.length)).toBe(2);
  await page.locator('[data-mobile-action=lock]').tap();
  expect(await page.evaluate(() => (window as any).__widget.draw.drawings()[0].locked)).toBe(true);
  await page.locator('[data-mobile-action=delete]').tap();
  expect(await page.evaluate(() => (window as any).__widget.draw.drawings().length)).toBe(0);
  await page.setViewportSize({ width: 740, height: 390 });
  await expect(page.locator('[data-mobile-action=draw]')).toBeVisible();
  await page.locator('[data-mobile-action=draw]').tap();
  const panel = page.locator('.oac-mobile-sheet');
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(741);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(391);
  await info.attach('landscape touch controls', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('symbol search keeps the final result reachable in a short embedded widget', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/tests/e2e/widget-mobile-fixture.html');
  await page.waitForFunction(() => (window as any).__loaded > 0);
  await page.evaluate(async () => {
    (window as any).__widget.destroy();
    const host = document.getElementById('t')!;
    host.style.cssText = 'position:absolute;left:0;top:0;width:390px;height:300px';
    const { createWidget } = await import('/dist/openalgo-charts.widget.mjs');
    const matches = Array.from({ length: 20 }, (_, index) => ({
      symbol: `SYM${String(index).padStart(2, '0')}`,
      exchange: 'NSE',
      name: `Company ${index + 1}`,
    }));
    (window as any).__widget = createWidget(host, {
      mobile: 'always',
      symbol: 'START',
      interval: '5m',
      symbolSearch: () => matches,
    });
  });

  const input = page.locator('.oac-mobile__symbol');
  await input.fill('sym');
  const results = page.locator('.oac-mobile-results');
  const list = page.locator('.oac-mobile-results__list');
  const last = page.locator('[data-mobile-action=pick-symbol]').last();
  await expect(results).toBeVisible();
  await expect(last).toHaveText(/SYM19/);
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });

  const panelBox = await results.boundingBox();
  const lastBox = await last.boundingBox();
  expect(lastBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);
  await last.tap();
  await expect(results).toBeHidden();
  expect(await page.evaluate(() => (window as any).__widget.symbol())).toBe('SYM19');
});
