import { test, expect, type Page } from '@playwright/test';

// The reference host's timeline with real input. The demo rebuilds its chart
// on a type switch, so the switch is a command that rebuilds again, and the
// steps around it survive the rebuild: a study added from the shell's picker,
// a trend line placed with two clicks, a price scale inverted from the axis
// menu, all walked with Ctrl+Z and Ctrl+Y and the toolbar's Undo and Redo.

const ORIGIN = `http://127.0.0.1:${process.env.OAC_E2E_DEMO_PORT || '8124'}`;

test.use({ viewport: { width: 1360, height: 900 } });
test.beforeEach(async ({ page, request }) => {
  const up = await request.get(ORIGIN + '/api/history?symbol=AAPL&interval=1d&period=1mo').then(r => r.ok(), () => false);
  test.skip(!up, 'the yfinance fixture server is not available');
  await page.goto(ORIGIN + '/examples/yfinance/index.html?test=1');
  await page.waitForFunction(() => (window as any).__oac?.app.chart && !(window as any).__oac.app.loading && (window as any).__oac.app.history);
});

async function paint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const model = (page: Page) => page.evaluate(() => {
  const app = (window as any).__oac.app;
  return {
    studies: app.chart.indicators().map((s: any) => s.indicatorId),
    type: app.chart.primarySeriesInfo()?.type,
    drawings: app.draw.drawings().length,
    inverted: app.chart.priceAxisState(app.chart.primaryPaneIndex(), 'right')?.inverted,
    // The axis menu inverts one scale: every study pane stays upright.
    studyPanesInverted: app.chart.panes().map((_: unknown, i: number) => i)
      .filter((i: number) => i !== app.chart.primaryPaneIndex())
      .some((i: number) => app.chart.priceAxisState(i, 'right')?.inverted),
    // The demo's own copy of the study list, which it rebuilds the chart from.
    remembered: app.activeIndicators.map((s: any) => s.indicatorId),
  };
});

async function chartBox(page: Page) {
  return page.evaluate(() => {
    const app = (window as any).__oac.app;
    const r = app.chart.panes()[app.chart.primaryPaneIndex()].element.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
}

test('Ctrl+Z and Ctrl+Y walk a study, a line, a scale and a type rebuild on the reference host', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // What the page loaded is where the timeline starts.
  await page.evaluate(() => (window as any).__oac.app.history.clear());
  const start = await model(page);
  expect(start.type).toBe('candlestick');

  // A study from the shell's picker.
  await page.locator('#shellbar .tbtn', { hasText: 'Indicators' }).click();
  await page.getByRole('searchbox', { name: 'Search indicators' }).fill('MACD');
  await page.locator('.oac-pick__list [role="option"][data-id="macd"]').click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => model(page).then(m => m.studies)).toEqual([...start.studies, 'macd']);

  // A line placed with two clicks.
  await page.locator('#rail .rail__group[data-group="lines"]').click();
  const box = await chartBox(page);
  await page.mouse.click(box.x + box.width * 0.30, box.y + box.height * 0.45);
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.30);
  await expect.poll(() => model(page).then(m => m.drawings)).toBe(1);
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.7);

  // The price scale inverted from its axis menu, a change the chart does not announce.
  await page.mouse.click(box.x + box.width - 20, box.y + box.height * 0.5, { button: 'right' });
  await expect(page.locator('#axmenu')).toBeVisible();
  await page.locator('#axmenu .axrow', { hasText: 'Invert' }).first().click();
  await expect.poll(() => model(page).then(m => m.inverted)).toBe(true);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);

  // A chart type, which the demo builds as a new chart.
  await page.getByRole('button', { name: 'Chart type', exact: true }).click();
  await page.getByRole('button', { name: 'Line', exact: true }).click();
  await expect.poll(() => model(page).then(m => m.type)).toBe('line');
  await paint(page);
  await page.screenshot({ path: info.outputPath('reference-all-steps.png') });

  // Back through all four, the pointer over the chart.
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => model(page).then(m => m.type)).toBe('candlestick');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => model(page).then(m => m.inverted)).toBe(false);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => model(page).then(m => m.drawings)).toBe(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => model(page)).toMatchObject({ studies: start.studies, remembered: start.studies });
  const undo = page.locator('#rail .rail__btn[aria-label="Undo"]');
  const redo = page.locator('#rail .rail__btn[aria-label="Redo"]');
  await expect(undo).toHaveAttribute('aria-disabled', 'true');
  await paint(page);
  await page.screenshot({ path: info.outputPath('reference-all-undone.png') });

  // Forward again: the chord for the first two, the rail's Redo for the rest.
  await page.keyboard.press('ControlOrMeta+y');
  await expect.poll(() => model(page).then(m => m.remembered)).toEqual([...start.studies, 'macd']);
  await page.keyboard.press('ControlOrMeta+y');
  await expect.poll(() => model(page).then(m => m.drawings)).toBe(1);
  await expect(redo).toHaveAttribute('aria-disabled', 'false');
  await redo.click();
  await expect.poll(() => model(page).then(m => m.inverted)).toBe(true);
  await redo.click();
  await expect.poll(() => model(page)).toMatchObject({
    studies: [...start.studies, 'macd'], drawings: 1, inverted: true, studyPanesInverted: false, type: 'line',
  });
  await expect(redo).toHaveAttribute('aria-disabled', 'true');
  await paint(page);
  await page.screenshot({ path: info.outputPath('reference-all-redone.png') });
  expect(await page.evaluate(() => (window as any).__oac.app.orders.length)).toBe(0);
  expect(errors).toEqual([]);
});
