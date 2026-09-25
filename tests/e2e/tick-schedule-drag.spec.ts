import { expect, test, type Page } from '@playwright/test';
import type { Chart, TickSchedule } from '../../src/index';

declare global {
  interface Window {
    __ticks: {
      chart: Chart; ticks: TickSchedule;
      events: { type: string; id?: string; price?: number; newPrice?: number; previousPrice?: number; orderId?: string; bracketRole?: string }[];
      preview(id: string): number | undefined;
    };
  }
}

const pageErrors = new WeakMap<Page, string[]>();
test.use({ viewport: { width: 1200, height: 900 } });
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/e2e/tick-schedule-drag-fixture.html');
  await page.waitForFunction(() => !!window.__ticks);
  await paint(page);
});
test.afterEach(async ({ page }, info) => {
  const errors = pageErrors.get(page) ?? [];
  if (info.status !== info.expectedStatus || errors.length) await page.screenshot({ path: info.outputPath('failure.png') });
  expect(errors).toEqual([]);
});

async function paint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** A page point on a price, near the right end of the order lines. */
async function point(page: Page, price: number): Promise<{ x: number; y: number; price: number }> {
  return page.evaluate(price => {
    const { chart } = window.__ticks;
    const rect = document.getElementById('chart')!.getBoundingClientRect();
    const y = Math.round(rect.top + chart.priceToCoordinate(price, 0)!);
    return { x: Math.round(rect.left + (rect.width - 72) * 0.93), y, price: chart.coordinateToPrice(y - rect.top, 0)! };
  }, price);
}

/** The grid a price lies on: whole cents below 100, whole nickels from 100. */
function onGrid(price: number): boolean {
  const units = price >= 100 ? price * 20 : price * 100;
  return Math.abs(units - Math.round(units)) < 1e-6;
}

test('a dragged order previews and commits the tick of the band it crosses into', async ({ page }, info) => {
  const from = await point(page, 99.5);
  const up = await point(page, 100.33);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(up.x, up.y, { steps: 10 });
  await paint(page);
  const raw = await page.evaluate(() => window.__ticks.events.filter(event => event.type === 'drag').at(-1)!.price!);
  const preview = await page.evaluate(() => window.__ticks.preview('ord:limit')!);
  // The pointer's own price is not on the 0.05 grid; the line is.
  expect(raw).toBeGreaterThan(100);
  expect(preview).toBe(await page.evaluate(price => window.__ticks.ticks.round(price), raw));
  expect(onGrid(preview)).toBe(true);
  expect(Math.round(preview * 100) % 5).toBe(0);
  await page.screenshot({ path: info.outputPath('tick-schedule-drag-upper-band.png') });

  const down = await point(page, 99.73);
  await page.mouse.move(down.x, down.y, { steps: 10 });
  await paint(page);
  const lower = await page.evaluate(() => window.__ticks.preview('ord:limit')!);
  expect(lower).toBeLessThan(100);
  expect(onGrid(lower)).toBe(true);
  await page.mouse.move(up.x, up.y, { steps: 10 });
  await page.mouse.up();
  await paint(page);

  const modify = await page.evaluate(() => window.__ticks.events.filter(event => event.type === 'order'));
  expect(modify).toHaveLength(1);
  expect(modify[0]).toMatchObject({ orderId: 'limit', previousPrice: 99.5, newPrice: preview });
  expect(await page.evaluate(() => window.__ticks.chart.trading.getOrders().find(order => order.id === 'limit')!.price)).toBe(preview);
  await page.screenshot({ path: info.outputPath('tick-schedule-order-released.png') });
});

test('a dragged bracket leg lands on the finer grid below the boundary', async ({ page }, info) => {
  const from = await point(page, 101.5);
  const to = await point(page, 99.87);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await paint(page);
  const bracket = await page.evaluate(() => window.__ticks.events.filter(event => event.type === 'bracket'));
  expect(bracket).toHaveLength(1);
  const expected = await page.evaluate(price => window.__ticks.ticks.round(price), to.price);
  expect(bracket[0]).toMatchObject({ bracketRole: 'tp', newPrice: expected });
  expect(bracket[0].newPrice!).toBeLessThan(100);
  expect(onGrid(bracket[0].newPrice!)).toBe(true);
  await page.screenshot({ path: info.outputPath('tick-schedule-bracket-released.png') });
});
