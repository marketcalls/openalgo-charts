import { test, expect } from '@playwright/test';

// Real-browser smoke: catches the class of bugs unit tests (fake canvas) miss —
// blank/collapsed render, fetch "Illegal invocation", a chart type that throws,
// and broken wheel/keyboard interaction.

test('renders a non-blank chart with no console/page errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ready === true);

  // the base canvas actually painted candles/grid/axes (not all background)
  const painted = await page.evaluate(() => {
    const cv = document.querySelector('#c canvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    let nonbg = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 20 || data[i + 1] > 20 || data[i + 2] > 30) nonbg++;
    return nonbg;
  });
  expect(painted).toBeGreaterThan(2000);
  expect(errors).toEqual([]);
});

test('the global fetch is bound (no "Illegal invocation")', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ready === true);
  const result = await page.evaluate(() => (window as any).__fetchCall());
  // a 404/network error is fine; an "Illegal invocation" TypeError is the regression we guard.
  expect(result).not.toContain('Illegal invocation');
});

test('every base chart type renders without throwing', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ready === true);
  const types: string[] = await page.evaluate(() => (window as any).__baseTypes);
  for (const t of types) {
    expect.soft(await page.evaluate((tt) => (window as any).__addType(tt), t), `type ${t}`).toBe(true);
  }
});

test('wheel zooms in (bar spacing grows)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ready === true);
  const before = await page.evaluate(() => (window as any).__api.chart.timeScale.barSpacing);
  await page.mouse.move(300, 200);
  await page.mouse.wheel(0, -360);
  const after = await page.evaluate(() => (window as any).__api.chart.timeScale.barSpacing);
  expect(after).toBeGreaterThan(before);
});

test('resetScale re-fits after a manual zoom', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__ready === true);
  await page.mouse.move(300, 200);
  await page.mouse.wheel(0, 360);
  await page.evaluate(() => (window as any).__api.chart.resetScale());
  const ok = await page.evaluate(() => Number.isFinite((window as any).__api.chart.priceToCoordinate(100)));
  expect(ok).toBe(true);
});
