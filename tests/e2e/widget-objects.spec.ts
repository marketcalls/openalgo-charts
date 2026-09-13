import { expect, test, type Page } from '@playwright/test';
import type { Widget } from '../../src/widget/widget';

declare global {
  interface Window {
    __objectsDemo: {
      widget: Widget; lineId: string; futureId: string; indicatorId: string;
      profileVisible: boolean; orderCalls: number; recreate(): void;
    };
  }
}

async function mount(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/tests/e2e/widget-objects-fixture.html');
  await page.waitForFunction(() => !!window.__objectsDemo);
  return errors;
}

async function open(page: Page) {
  const opener = page.getByRole('button', { name: 'Objects', exact: true });
  await expect(opener).toBeVisible();
  await opener.focus();
  await opener.press('Enter');
  const panel = page.locator('.oac-objects');
  await expect(panel.getByRole('searchbox')).toBeFocused();
  return panel;
}

async function drawingInk(page: Page): Promise<number> {
  return page.locator('.oac-chart canvas').nth(1).evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 180 && pixels[i + 1] < 90 && pixels[i + 2] > 180 && pixels[i + 3] > 80) count++;
    }
    return count;
  });
}

test('drawing rows follow canvas selection and operate on the real drawing with undo', async ({ page }, info) => {
  const errors = await mount(page);
  await expect.poll(() => drawingInk(page)).toBeGreaterThan(50);
  const point = await page.evaluate(() => {
    const { widget, lineId } = window.__objectsDemo;
    const points = widget.draw.get(lineId)!.points;
    const rect = widget.root.querySelector('.oac-chart')!.getBoundingClientRect();
    return { x: rect.left + widget.chart.timeToCoordinate((points[0].time + points[1].time) / 2)!,
      y: rect.top + widget.chart.priceToCoordinate((points[0].price + points[1].price) / 2)! };
  });
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(() => window.__objectsDemo.widget.draw.selection())).toEqual([
    await page.evaluate(() => window.__objectsDemo.lineId),
  ]);
  const panel = await open(page);
  const line = panel.locator('[data-object-id^="drawing:"]').filter({ has: page.getByText('Trend line', { exact: true }) });
  await expect(line.getByRole('button', { name: 'Select Trend line', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('searchbox').fill('trend');
  await page.evaluate(() => window.__objectsDemo.widget.draw.select(null));
  await expect(panel.getByRole('searchbox')).toBeFocused();
  await expect(line.getByRole('button', { name: 'Select Trend line', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await line.getByRole('button', { name: 'Hide Trend line', exact: true }).click();
  await expect.poll(() => drawingInk(page)).toBe(0);
  await line.getByRole('button', { name: 'Show Trend line', exact: true }).click();
  await expect.poll(() => drawingInk(page)).toBeGreaterThan(50);
  await line.getByRole('button', { name: 'Lock Trend line', exact: true }).click();
  expect(await page.evaluate(() => window.__objectsDemo.widget.draw.get(window.__objectsDemo.lineId)!.locked)).toBe(true);
  await expect(line.getByRole('button', { name: 'Unlock Trend line', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('drawing-objects.png') });
  await line.getByRole('button', { name: 'Remove Trend line', exact: true }).click();
  await expect(line).toHaveCount(0);
  await page.evaluate(() => window.__objectsDemo.widget.draw.undo());
  await expect(line).toHaveCount(1);
  expect(await page.evaluate(() => window.__objectsDemo.orderCalls)).toBe(0);
  expect(errors).toEqual([]);
});

test('focus brings future anchors into view and primary/profile actions reflect their capabilities', async ({ page }, info) => {
  const errors = await mount(page);
  const panel = await open(page);
  const primary = panel.locator('[data-object-id="source:primary"]');
  await expect(primary).toContainText('OBJECTS SIM');
  await expect(primary.locator('[data-action="remove"]')).toHaveCount(0);
  const profile = panel.locator('[data-object-id="custom:session-profile"]');
  await expect(profile.locator('button')).toHaveCount(2);
  await profile.getByRole('button', { name: 'Hide Session profile', exact: true }).click();
  expect(await page.evaluate(() => window.__objectsDemo.profileVisible)).toBe(false);
  await profile.getByRole('button', { name: 'Show Session profile', exact: true }).click();
  const future = panel.locator('[data-object-id^="drawing:"]').filter({ has: page.getByText('Rectangle', { exact: true }) });
  await future.getByRole('button', { name: 'Focus Rectangle', exact: true }).click();
  await page.keyboard.press('Escape');
  const coordinates = await page.evaluate(() => {
    const { widget, futureId } = window.__objectsDemo;
    const pane = widget.chart.panes()[0];
    return { width: widget.chart.timeScale.width, height: pane.priceScale.height,
      points: widget.draw.get(futureId)!.points.map(point => ({
        x: widget.chart.timeToCoordinate(point.time), y: widget.chart.priceToCoordinate(point.price),
      })) };
  });
  for (const point of coordinates.points) {
    expect(point.x).toBeGreaterThan(0);
    expect(point.x).toBeLessThan(coordinates.width);
    expect(point.y).toBeGreaterThan(0);
    expect(point.y).toBeLessThan(coordinates.height);
  }
  await page.screenshot({ path: info.outputPath('future-object-focus.png') });
  await open(page);
  await profile.getByRole('button', { name: 'Remove Session profile', exact: true }).click();
  await expect(profile).toHaveCount(0);
  expect(await page.evaluate(() => window.__objectsDemo.widget.objects.remove('source:primary'))).toBe(false);
  expect(errors).toEqual([]);
});

test('hidden indicator state survives widget replacement and direct removal refreshes the inventory', async ({ page }) => {
  const errors = await mount(page);
  const panel = await open(page);
  const study = panel.locator('[data-object-id^="indicator:"]');
  await study.locator('[data-action="visibility"]').click();
  await expect(study).toContainText('Hidden');
  await page.evaluate(() => window.__objectsDemo.recreate());
  await expect(panel).toHaveCount(0);
  await open(page);
  await expect(study).toContainText('Hidden');
  expect(await page.evaluate(() => window.__objectsDemo.widget.chart.indicators()[0].visible())).toBe(false);
  await page.evaluate(() => window.__objectsDemo.widget.chart.indicators()[0].remove());
  await expect(study).toHaveCount(0);
  expect(await page.evaluate(() => window.__objectsDemo.widget.chart.panes().length)).toBe(1);
  await page.evaluate(() => window.__objectsDemo.widget.destroy());
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate(() => window.__objectsDemo.widget.objects.list())).toEqual([]);
  expect(errors).toEqual([]);
});

for (const [width, height] of [[350, 440], [350, 240], [700, 240]]) {
  test(`Objects controls stay reachable in a ${width}x${height} host`, async ({ page }, info) => {
    const errors = await mount(page);
    await page.locator('#host').evaluate((node, size) => {
      (node as HTMLElement).style.width = `${size[0]}px`;
      (node as HTMLElement).style.height = `${size[1]}px`;
    }, [width, height]);
    const panel = await open(page);
    await expect(panel).toBeVisible();
    const host = (await page.locator('#host').boundingBox())!;
    const bounds = (await panel.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(host.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(host.x + host.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(host.y + host.height + 1);
    const done = panel.getByRole('button', { name: 'Done', exact: true });
    const actionBounds = (await done.boundingBox())!;
    expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(host.y + host.height);
    expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await panel.getByRole('searchbox').fill('pane 2');
    await expect(panel.locator('.oac-objects__row')).toHaveCount(1);
    await panel.getByRole('searchbox').fill('missing');
    await expect(panel.getByText('No objects match your search.', { exact: true })).toBeVisible();
    await panel.getByRole('searchbox').fill('');
    await page.screenshot({ path: info.outputPath(`objects-${width}x${height}.png`) });
    await done.click();
    await expect(panel).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
