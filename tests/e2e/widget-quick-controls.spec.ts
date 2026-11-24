import { test, expect, type Page } from '@playwright/test';
import { VERSION } from '../../src/version';

// The widget's host menu rows, study placement rows, session choice and full
// screen button in a real browser: each is clicked the way a user would, and
// the chart is read back afterwards.

async function mount(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto('/tests/e2e/widget-quick-controls-fixture.html');
  await page.waitForFunction(version => (window as any).fixture?.version === version, VERSION);
  await expect.poll(() => count(page)).toBe(40);
  return errors;
}
const count = (page: Page): Promise<number> => page.evaluate(() => (window as any).fixture.widget.series.getData().length);
const panes = (page: Page): Promise<number> => page.evaluate(() => (window as any).fixture.widget.chart.panes().length);
/** Raise the widget's menu on a study, the way the chart's own right-click does. */
const menuOn = (page: Page, instanceId: string): Promise<void> => page.evaluate((id) => {
  const chart = (window as any).fixture.widget.chart;
  chart.emit('contextmenu', { target: { kind: 'indicator', id, instanceId: id }, paneIndex: chart.primaryPaneIndex(),
    price: 100, time: null, index: null, point: { x: 300, y: 200 }, preventDefault() {} });
}, instanceId);

test('a host row rides the right-click menu and runs with the event', async ({ page }, info) => {
  const errors = await mount(page);
  const box = (await page.locator('.oac-widget canvas').first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  const row = page.locator('[data-act="host-row"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Send to scanner');
  await page.screenshot({ path: info.outputPath('host-row.png') });
  await row.click();
  expect(await page.evaluate(() => (window as any).fixture.hostRows.length)).toBe(1);
  expect(errors).toEqual([]);
});

test('a price overlay moves to its own pane and back from its menu', async ({ page }, info) => {
  const errors = await mount(page);
  const id = await page.evaluate(() => (window as any).fixture.widget.chart.addIndicator('ema').id as string);
  expect(await panes(page)).toBe(1);
  await menuOn(page, id);
  await page.locator('[data-act="ind-new-pane"]').click();
  expect(await panes(page)).toBe(2);
  await page.screenshot({ path: info.outputPath('ema-own-pane.png') });
  await menuOn(page, id);
  await expect(page.locator('[data-act="ind-new-pane"]')).toHaveCount(0);
  await page.locator('[data-act="ind-price-pane"]').click();
  expect(await panes(page)).toBe(1);
  await page.screenshot({ path: info.outputPath('ema-price-pane.png') });
  expect(errors).toEqual([]);
});

test('the session button asks the source for extended hours and back', async ({ page }, info) => {
  const errors = await mount(page);
  const button = page.locator('.oac-bottombar__session');
  await expect(button).toBeVisible();
  await button.click();
  await page.locator('.oac-menu button', { hasText: 'With extended hours' }).click();
  await expect.poll(() => count(page)).toBe(60);
  await expect(button).toHaveAttribute('data-session', 'extended');
  await page.screenshot({ path: info.outputPath('extended.png') });
  await button.click();
  await page.locator('.oac-menu button', { hasText: 'Regular hours only' }).click();
  await expect.poll(() => count(page)).toBe(40);
  await expect(button).toHaveAttribute('data-session', 'regular');
  // Daily bars have one session at this provider, and regular is it: the
  // chart keeps loading and the choice goes away.
  await page.evaluate(() => (window as any).fixture.widget.setInterval('1d'));
  await expect.poll(() => count(page)).toBe(40);
  await expect(button).toBeHidden();

  // Extended hours carried to daily bars is a series the provider does not
  // serve. The chart says so, and the control stays as the way back.
  await page.evaluate(() => (window as any).fixture.widget.setInterval('1m'));
  await expect(button).toBeVisible();
  await button.click();
  await page.locator('.oac-menu button', { hasText: 'With extended hours' }).click();
  await expect.poll(() => count(page)).toBe(60);
  await page.evaluate(() => (window as any).fixture.widget.setInterval('1d'));
  await expect(page.locator('.oac-data-status')).toContainText('Not available from this source');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('.oac-menu button', { hasText: 'With extended hours' })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('stranded.png') });
  await page.locator('.oac-menu button', { hasText: 'Regular hours only' }).click();
  await expect.poll(() => count(page)).toBe(40);
  await expect(page.locator('.oac-data-status')).toBeHidden();
  expect(errors).toEqual([]);
});

test('the full screen button is offered where the page may enter full screen', async ({ page, browserName }) => {
  const errors = await mount(page);
  const enabled = await page.evaluate(() => document.fullscreenEnabled === true);
  const button = page.locator('.oac-topbar__fullscreen');
  if (!enabled) { await expect(button).toHaveCount(0); return; }
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.click();
  // A headless engine may refuse the request; the widget then says so and stays as it was.
  const entered = await page.waitForFunction(() => document.fullscreenElement !== null, null, { timeout: 2000 }).then(() => true, () => false);
  if (entered) {
    expect(await page.evaluate(() => document.fullscreenElement === (window as any).fixture.widget.root)).toBe(true);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(() => document.exitFullscreen());
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  } else {
    test.info().annotations.push({ type: 'limitation', description: `${browserName} headless refused full screen` });
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
  expect(errors).toEqual([]);
});
