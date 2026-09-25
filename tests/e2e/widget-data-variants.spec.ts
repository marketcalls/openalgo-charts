import { test, expect, type Page } from '@playwright/test';
import { VERSION } from '../../src/version';

// A data variant in a real browser: the widget asks the provider for the
// extended series, draws its extra bars, names it on the status line, and
// says plainly when the provider does not serve it rather than drawing the
// regular series under the extended name.

async function mount(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto('/tests/e2e/widget-data-variants-fixture.html');
  await page.waitForFunction(version => (window as any).fixture?.version === version, VERSION);
  return errors;
}
const count = (page: Page): Promise<number> => page.evaluate(() => (window as any).fixture.widget.series.getData().length);
const requests = (page: Page): Promise<{ interval: string; variant: unknown }[]> => page.evaluate(() => (window as any).fixture.requests);

test('extended hours load as their own series, and an undeclared variant is reported', async ({ page }, info) => {
  const errors = await mount(page);
  await expect.poll(() => count(page)).toBe(40);
  const label = page.locator('.oac-statusline__variant');
  await expect(label).toBeHidden();
  await page.screenshot({ path: info.outputPath('widget-regular.png') });

  await page.evaluate(() => (window as any).fixture.widget.setDataVariant({ session: 'extended' }));
  await expect.poll(() => count(page)).toBe(60);
  await expect(label).toBeVisible();
  await expect(label).toHaveText('Extended hours');
  expect((await requests(page)).map(request => request.variant)).toEqual([null, { session: 'extended' }]);
  expect(await page.evaluate(() => (window as any).fixture.widget.chart.getDataContext().variant)).toEqual({ session: 'extended' });
  await page.screenshot({ path: info.outputPath('widget-extended.png') });

  // Daily bars have no extended hours at this provider: nothing is fetched,
  // the chart is empty and the overlay says what is missing, with no retry.
  await page.evaluate(() => (window as any).fixture.widget.setInterval('1d'));
  const status = page.locator('.oac-data-status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('Not available from this source: Extended hours');
  await expect(status.getByRole('button')).toHaveCount(0);
  expect(await count(page)).toBe(0);
  expect(await requests(page)).toHaveLength(2);
  await page.screenshot({ path: info.outputPath('widget-variant-unsupported.png') });

  await page.evaluate(() => (window as any).fixture.widget.setDataVariant(undefined));
  await expect.poll(() => count(page)).toBe(40);
  await expect(status).toBeHidden();
  await expect(label).toBeHidden();
  const sent = await requests(page);
  expect(sent[sent.length - 1]).toEqual({ interval: '1d', variant: null });
  expect(errors).toEqual([]);
});
