import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto('/tests/e2e/navigation-wheel-fixture.html');
  await page.waitForFunction(() => (window as any).ready && (window as any).chart.panes()[0].priceScale.scaled);
});

test('trackpad magnitude, horizontal pan and price-axis wheel stay independent', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const chart = (window as any).chart;
    const host = document.getElementById('chart')!;
    const wheel = (x: number, dx: number, dy: number) => host.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: 200, deltaX: dx, deltaY: dy }));
    const before = chart.timeScale.barSpacing;
    wheel(400, 0, -1);
    await new Promise(r => setTimeout(r, 450));
    const tiny = chart.timeScale.barSpacing / before;
    const from = chart.getVisibleLogicalRange().from;
    const spacing = chart.timeScale.barSpacing;
    wheel(400, 80, 0);
    await new Promise(r => setTimeout(r, 450));
    const pan = { spacing: chart.timeScale.barSpacing, from: chart.getVisibleLogicalRange().from };
    const scale = chart.panes()[0].priceScale;
    const span = scale.priceRange().max - scale.priceRange().min;
    const price = scale.yToPrice(200);
    wheel(1190, 0, -100);
    await new Promise(r => setTimeout(r, 100));
    return { tiny, from, spacing, pan, axisSpacing: chart.timeScale.barSpacing, axisSpan: scale.priceRange().max - scale.priceRange().min, span, priceY: scale.priceToY(price) };
  });
  expect(result.tiny).toBeCloseTo(1.0009535561, 8);
  expect(result.pan.spacing).toBe(result.spacing);
  expect(result.pan.from).toBeGreaterThan(result.from);
  expect(result.axisSpacing).toBe(result.spacing);
  expect(result.axisSpan).toBeLessThan(result.span);
  expect(result.priceY).toBeCloseTo(200, 7);
});

test('a newly visible extreme eases on canvas and settles on the full price range', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const samples = await page.evaluate(async () => {
    const chart = (window as any).chart;
    const values = [chart.priceToCoordinate(23800)];
    document.getElementById('chart')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 1130, clientY: 200, deltaY: 100 }));
    const started = performance.now();
    while (performance.now() - started < 1000) {
      await new Promise(requestAnimationFrame);
      values.push(chart.priceToCoordinate(23800));
    }
    return { values, range: chart.panes()[0].priceScale.priceRange() };
  });
  const travel = Math.abs(samples.values.at(-1)! - samples.values[0]);
  const steps = samples.values.slice(1).map((y, i) => Math.abs(y - samples.values[i]));
  expect(travel).toBeGreaterThan(100);
  expect(Math.max(...steps)).toBeLessThan(travel * 0.5);
  expect(samples.range).toEqual({ min: 23738.75, max: 24251.25 });
  expect(errors).toEqual([]);
  await info.attach('settled price transition', { body: await page.screenshot(), contentType: 'image/png' });
});
