import { test, expect, type Page } from '@playwright/test';
import { VERSION } from '../../src/version';

// The widget's host menu rows, study placement rows, session choice and full
// screen button in a real browser: each is clicked the way a user would, and
// the chart is read back afterwards.

async function mount(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto('/tests/e2e/widget-quick-controls-fixture.html' + query);
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

// 2.7.5: the host's right offset, Reset view on the menu, and dialogs that move.

test('the chart opens with the right offset its host configured', async ({ page }) => {
  const errors = await mount(page, '?offset=27');
  const offset = (): Promise<number> => page.evaluate(() => (window as any).fixture.widget.chart.timeScale.rightOffset);
  expect(await offset()).toBe(27);
  await page.evaluate(() => { const chart = (window as any).fixture.widget.chart; chart.timeScale.setRightOffset(-10); chart.fitContent(); });
  expect(await offset()).toBe(27);
  expect(errors).toEqual([]);
});

test('Reset view on the right-click menu returns a panned chart and a dragged axis to the default', async ({ page }, info) => {
  const errors = await mount(page);
  const view = (): Promise<{ from: number; to: number; auto: boolean }> => page.evaluate(() => {
    const chart = (window as any).fixture.widget.chart;
    const range = chart.getVisibleLogicalRange();
    return { from: Math.round(range.from * 100) / 100, to: Math.round(range.to * 100) / 100, auto: chart.priceAxisState(0, 'right').autoFit };
  });
  const home = await view();
  expect(home.auto).toBe(true);
  const box = (await page.locator('.oac-widget canvas').first().boundingBox())!;
  // Pan the bars, then drag the price axis, which takes it off auto-fit.
  await page.mouse.move(box.x + 500, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 300, { steps: 6 });
  await page.mouse.up();
  await page.mouse.move(box.x + box.width - 20, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 20, box.y + 320, { steps: 6 });
  await page.mouse.up();
  const moved = await view();
  expect(moved.from).not.toBe(home.from);
  expect(moved.auto).toBe(false);
  await page.screenshot({ path: info.outputPath('before-reset.png') });
  await page.mouse.click(box.x + 400, box.y + 300, { button: 'right' });
  const row = page.locator('[data-act="chart-reset"]');
  await expect(row).toContainText('Reset view');
  await row.click();
  await expect.poll(view).toEqual(home);
  await page.screenshot({ path: info.outputPath('after-reset.png') });
  expect(errors).toEqual([]);
});

test('a settings dialog is dragged by its title bar, stays reachable, and opens centred again', async ({ page }, info) => {
  const errors = await mount(page);
  const id = await page.evaluate(() => (window as any).fixture.widget.chart.addIndicator('ema').id as string);
  for (const open of [
    async () => { await menuOn(page, id); await page.locator('[data-act="ind-settings"]').click(); },
    async () => {
      const box = (await page.locator('.oac-widget canvas').first().boundingBox())!;
      await page.mouse.click(box.x + 400, box.y + 300, { button: 'right' });
      await page.locator('[data-act="chart-settings"]').click();
    },
  ]) {
    await open();
    const dialog = page.locator('.oac-dialog');
    await expect(dialog).toBeVisible();
    const title = dialog.locator('.oac-dialog__title');
    const rest = (await dialog.boundingBox())!;
    const root = (await page.locator('.oac-widget').boundingBox())!;
    expect(Math.abs(rest.x + rest.width / 2 - (root.x + root.width / 2))).toBeLessThan(2);
    const grip = (await title.boundingBox())!;
    await page.mouse.move(grip.x + 20, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 20 - 180, grip.y + grip.height / 2 + 90, { steps: 8 });
    await page.mouse.up();
    const moved = (await dialog.boundingBox())!;
    expect(Math.round(moved.x - rest.x)).toBe(-180);
    expect(Math.round(moved.y - rest.y)).toBe(90);
    expect(Math.round(moved.width)).toBe(Math.round(rest.width));
    // A drag across the title must not select its text.
    expect(await page.evaluate(() => String(window.getSelection()))).toBe('');
    await page.screenshot({ path: info.outputPath(`dragged-${Math.round(rest.width)}.png`) });
    // Thrown far past the corner, the bar stops inside the widget.
    const again = (await title.boundingBox())!;
    await page.mouse.move(again.x + 20, again.y + again.height / 2);
    await page.mouse.down();
    await page.mouse.move(again.x + 3000, again.y + 3000, { steps: 8 });
    await page.mouse.up();
    const head = (await dialog.locator('.oac-dialog__head').boundingBox())!;
    expect(head.y + head.height).toBeLessThanOrEqual(root.y + root.height + 1);
    expect(head.x).toBeLessThanOrEqual(root.x + root.width - 63);
    // The controls in the dialog still work where it now sits.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await open();
    const reopened = (await dialog.boundingBox())!;
    expect(Math.round(reopened.x)).toBe(Math.round(rest.x));
    expect(Math.round(reopened.y)).toBe(Math.round(rest.y));
    // A press on the close button closes; it does not start a drag.
    await dialog.locator('.oac-dialog__head button').click();
    await expect(dialog).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
