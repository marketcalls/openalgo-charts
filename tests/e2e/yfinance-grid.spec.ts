import { test, expect, type Page } from '@playwright/test';

// The reference host's grid view over the fixture server: four instruments,
// presets, links and persistence, and the hand-off from the main page of a
// layout whose geometry only the grid view can draw.
const ORIGIN = `http://127.0.0.1:${process.env.OAC_E2E_DEMO_PORT || '8124'}`;

test.use({ viewport: { width: 1360, height: 900 } });
test.beforeEach(async ({ request }) => {
  const up = await request.get(ORIGIN + '/api/history?symbol=AAPL&interval=1d&period=1mo').then(r => r.ok(), () => false);
  test.skip(!up, 'the yfinance fixture server is not available');
});

const grid = <T>(page: Page, fn: (grid: any) => T): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__grid)`) as Promise<T>;
const loaded = (page: Page): Promise<boolean> => grid(page, g => g.cells().every((cell: any) => cell.widget.series.getData().length > 0));
/** Whether a main page chart's window reaches its newest bar, rather than bars it does not have. */
const onNewest = (page: Page, key: string): Promise<boolean> => page.evaluate(name => {
  const chart = (window as any).__oac.app[name];
  const count = chart.primaryBars().length, range = chart.getVisibleLogicalRange();
  return count > 1 && range.from < count - 1 && range.to >= count - 1;
}, key);

test('the grid view loads four instruments, switches presets and links, and keeps them across a reload', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ORIGIN + '/examples/yfinance/grid.html?test=1');
  await page.waitForFunction(() => (window as any).__grid?.cells().length === 4);
  await expect.poll(() => loaded(page), { timeout: 20_000 }).toBe(true);
  expect(await grid(page, g => g.cells().map((cell: any) => cell.widget.symbol()))).toEqual(['AAPL', 'MSFT', 'RELIANCE.NS', '^NSEI']);
  await expect(page.getByRole('button', { name: 'Two by two' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath('yfinance-grid-2x2.png') });

  await page.locator('.oac-grid__cell .oac-chart').nth(1).click();
  await page.getByRole('button', { name: 'Two columns' }).click();
  await expect(page.locator('.oac-grid__cell')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Two columns' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Symbol', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Symbol', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => grid(page, g => g.cells().map((cell: any) => cell.widget.symbol()))).toEqual(['MSFT', 'MSFT']);
  await expect.poll(() => loaded(page), { timeout: 20_000 }).toBe(true);

  await page.reload();
  await page.waitForFunction(() => (window as any).__grid?.cells().length === 2);
  expect(await grid(page, g => g.cells().map((cell: any) => cell.widget.symbol()))).toEqual(['MSFT', 'MSFT']);
  expect(await grid(page, g => g.linkOptions().symbol)).toBe(true);
  await expect(page.getByRole('button', { name: 'Two columns' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => loaded(page), { timeout: 20_000 }).toBe(true);
  await page.screenshot({ path: info.outputPath('yfinance-grid-restored.png') });

  // A reload straight after a change keeps it: nothing waits on a timer or on unload.
  await page.getByRole('button', { name: 'Three columns' }).click();
  await page.reload();
  await page.waitForFunction(() => (window as any).__grid?.cells().length > 0);
  expect(await grid(page, g => g.cells().length)).toBe(3);
  expect(errors).toEqual([]);
});

test('the grid view lets a chart put its price pane below a study, and a reload keeps it there', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ORIGIN + '/examples/yfinance/grid.html?test=1');
  await page.waitForFunction(() => (window as any).__grid?.cells().length === 4);
  await expect.poll(() => loaded(page), { timeout: 20_000 }).toBe(true);
  // The grid view opts in, as the main page does, so a layout either one saves opens in the other.
  expect(await grid(page, g => g.cells().map((cell: any) => cell.widget.chart.movablePrimaryPane()))).toEqual([true, true, true, true]);
  await grid(page, g => { g.cells()[0].widget.chart.addIndicator('rsi'); });
  const box = await grid(page, g => {
    const r = g.cells()[0].widget.chart.panes()[0].element.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y, { button: 'right' });
  const row = page.locator('.oac-ctx__row[data-act="pane-down"]');
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  await row.click();
  await expect.poll(() => grid(page, g => g.cells()[0].widget.chart.primaryPaneIndex())).toBe(1);
  await expect.poll(() => grid(page, g => g.cells()[0].widget.chart.indicators()[0].paneIndex)).toBe(0);
  await page.screenshot({ path: info.outputPath('yfinance-grid-price-below.png') });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('oac-widget:yfinance-grid:grid') ?? '{}').panes?.[0].chart.primaryPane)).toBe(1);
  await page.reload();
  await page.waitForFunction(() => (window as any).__grid?.cells().length === 4);
  expect(await grid(page, g => g.cells()[0].widget.chart.primaryPaneIndex())).toBe(1);
  expect(await grid(page, g => g.cells()[0].widget.chart.indicators().map((item: any) => [item.indicatorId, item.paneIndex]))).toEqual([['rsi', 0]]);
  await expect.poll(() => loaded(page), { timeout: 20_000 }).toBe(true);
  await page.screenshot({ path: info.outputPath('yfinance-grid-price-below-reloaded.png') });
  expect(errors).toEqual([]);
});

test('a saved grid the page cannot restore is kept and reported, not overwritten', async ({ page }) => {
  await page.goto(ORIGIN + '/examples/yfinance/grid.html?test=1');
  await page.waitForFunction(() => (window as any).__grid?.cells().length === 4);
  const text = await page.evaluate(() => {
    const payload = (window as any).__grid.getWorkspace();
    payload.panes[0].chart.indicators = [{ indicatorId: 'registered-later', settings: {}, paneIndex: 0 }];
    const value = JSON.stringify(payload);
    (window as any).__grid.destroy();
    localStorage.setItem('oac-widget:yfinance-grid:grid', value);
    return value;
  });
  await page.reload();
  await page.waitForFunction(() => (window as any).__grid?.cells().length === 4);
  await expect(page.locator('#grid-status')).toContainText('could not be restored');
  await expect(page.locator('#grid-status')).toContainText('registered-later');
  await expect.poll(() => loaded(page), { timeout: 20_000 }).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('oac-widget:yfinance-grid:grid'))).toBe(text);
});

const handPane = (id: string, symbol: string, historyPeriod?: string) => ({ id, symbol, exchange: '', interval: '1d', chartType: 'candlestick',
  chart: { version: 1 }, settings: {}, volume: true, magnet: 'off', stay: false, comparisons: [] as unknown[], comparisonMode: 'percent',
  ...(historyPeriod === undefined ? {} : { historyPeriod }) });
const deskOf = (panes: ReturnType<typeof handPane>[]) => ({ kind: 'workspace', version: 1, id: 'desk', name: 'Desk', createdAt: 1, updatedAt: 1,
  panes, activePaneId: panes[2].id,
  layout: { rows: 2, columns: 2, slots: panes.map((pane, i) => ({ paneId: pane.id, row: Math.floor(i / 2), column: i % 2, rowSpan: 1, columnSpan: 1 })) },
  sync: { crosshair: true, viewport: false, symbol: false, interval: false } });

test('the main page refuses, before leaving, a layout the grid view could not open', async ({ page }) => {
  await page.goto(ORIGIN + '/examples/yfinance/index.html?test=1');
  await page.waitForFunction(() => (window as any).__oac?.app.chart && !(window as any).__oac.app.loading);
  const panes = [handPane('a', 'AAPL'), handPane('b', 'MSFT'), handPane('c', 'TSLA'), handPane('d', 'NVDA')];
  panes[1].comparisons = [{ id: 'q', symbol: 'QQQ', exchange: '', visible: true }];
  await page.getByRole('button', { name: 'Layouts', exact: true }).click();
  await page.locator('#ws-file').setInputFiles({ name: 'compared.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(deskOf(panes))) });
  await expect(page.locator('#ws-error')).toContainText('MSFT: comparison symbols');
  await expect(page.getByRole('button', { name: 'Open in grid view' })).toBeHidden();
  expect(page.url()).toContain('index.html');
});

test('the main page hands a layout it cannot draw to the grid view, which opens it whole', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // The grid view's own saved desk, which the hand-off replaces before any of its charts loads.
  await page.goto(ORIGIN + '/examples/yfinance/grid.html?test=1');
  await page.waitForFunction(() => (window as any).__grid?.cells().length === 4);
  await page.evaluate(() => { for (const cell of (window as any).__grid.cells()) cell.widget.setSymbol('IBM'); });
  await expect.poll(() => grid(page, g => g.cells().every((cell: any) => cell.widget.series.getData().length > 0 && cell.widget.symbol() === 'IBM')), { timeout: 20_000 }).toBe(true);
  const asked: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/history') asked.push(`${url.searchParams.get('symbol')}:${url.searchParams.get('period')}`);
  });
  await page.goto(ORIGIN + '/examples/yfinance/index.html?test=1');
  await page.waitForFunction(() => (window as any).__oac?.app.chart && !(window as any).__oac.app.loading);
  const desk = deskOf([handPane('a', 'AAPL'), handPane('b', 'MSFT', '5y'), handPane('c', 'TSLA', '6mo'), handPane('d', 'NVDA')]);
  await page.getByRole('button', { name: 'Layouts', exact: true }).click();
  await page.locator('#ws-file').setInputFiles({ name: 'desk.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(desk)) });
  await expect(page.locator('#ws-notice')).toContainText('grid view');
  await page.screenshot({ path: info.outputPath('yfinance-grid-handoff.png') });
  await page.getByRole('button', { name: 'Open in grid view' }).click();
  await page.waitForURL(/grid\.html/);
  await expect(page.locator('.oac-grid__cell')).toHaveCount(4);
  await expect(page.locator('#grid-status')).toContainText('Opened the layout from the main view: 4 charts');
  await expect(page.locator('.oac-grid__cell').nth(2)).toHaveAttribute('data-active', 'true');
  // Each chart loads the history period the layout saved, or its interval's usual one.
  await expect.poll(() => ['MSFT:5y', 'TSLA:6mo', 'NVDA:2y'].every(ask => asked.includes(ask)), { timeout: 20_000 }).toBe(true);
  await expect(page.locator('.oac-grid__cell .oac-data-status').first()).not.toContainText('Loading');
  await page.screenshot({ path: info.outputPath('yfinance-grid-opened.png') });
  // The saved IBM desk was built first and then replaced. A feed that started
  // its requests before the hand-off was applied would have sent IBM here.
  expect(asked.filter(ask => ask.startsWith('IBM:'))).toEqual([]);
  // The periods stay with the charts, so the saved grid and an exported layout carry them back.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('oac-widget:yfinance-grid:grid')!).panes
    .map((pane: { historyPeriod?: string }) => pane.historyPeriod ?? null))).toEqual([null, '5y', '6mo', null]);
  expect(errors).toEqual([]);
});

test('a one or two chart layout the grid view exports opens on the main page', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ORIGIN + '/examples/yfinance/grid.html?test=1');
  await page.waitForFunction(() => (window as any).__grid?.cells().length === 4);
  await page.getByRole('button', { name: 'Two columns' }).click();
  await expect(page.locator('.oac-grid__cell')).toHaveCount(2);
  await page.evaluate(() => (window as any).__grid.cells()[0].widget.setInterval('1w'));
  const pending = page.waitForEvent('download');
  await page.locator('#grid-export').click();
  const file = await (await pending).path();
  if (!file) throw new Error('Export did not create a file');
  await page.goto(ORIGIN + '/examples/yfinance/index.html?test=1');
  await page.waitForFunction(() => (window as any).__oac?.app.chart && !(window as any).__oac.app.loading);
  await page.getByRole('button', { name: 'Layouts', exact: true }).click();
  await page.locator('#ws-file').setInputFiles(file);
  await expect(page.locator('#ws-current')).toHaveText('Current: Chart grid');
  // The widget's weekly code opens as the page's own, beside the second chart.
  await expect.poll(() => page.evaluate(() => {
    const app = (window as any).__oac.app;
    return app.chart2 && !app.workspaceLoading ? { primary: app.req, secondary: { symbol: app.p2.symbol, interval: app.p2.interval, period: app.p2.period } } : null;
  }), { timeout: 20_000 }).toEqual({ primary: { symbol: 'AAPL', interval: '1wk', period: '1y' }, secondary: { symbol: 'MSFT', interval: '1d', period: '1y' } });
  // Each chart shows its newest bars, not an empty plot: the grid view's window counted other bars.
  await page.getByRole('button', { name: 'Close', exact: true }).first().click();
  for (const key of ['chart', 'chart2']) await expect.poll(() => onNewest(page, key), { timeout: 20_000 }).toBe(true);
  await page.screenshot({ path: info.outputPath('yfinance-grid-export-main.png') });
  expect(errors).toEqual([]);
});
