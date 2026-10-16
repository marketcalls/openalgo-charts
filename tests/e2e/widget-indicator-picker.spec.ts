import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 600 }]) {
  test(`running studies stay reachable above the catalog at ${viewport.width}px`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto('/tests/e2e/widget-ui-253-fixture.html');
    await page.waitForFunction(() => Boolean((window as any).__ui253?.widget.chart.timeScale.width));
    await page.locator('#host').evaluate(element => { element.style.height = '100vh'; });
    const studies = await page.evaluate(() => {
      const { widget, first, second } = (window as any).__ui253;
      for (let i = 0; i < 7; i++) widget.chart.addIndicator('ema');
      const hidden = widget.chart.addIndicator('ema', {}, { policy: { listed: false } }).id;
      const protectedId = widget.chart.addIndicator('ema', {}, { policy: { removable: false } }).id;
      widget.openIndicatorPicker();
      return { first, second, hidden, protectedId };
    });
    const picker = page.locator('.oac-pick');
    const find = picker.getByRole('searchbox', { name: 'Search indicators', exact: true });
    const running = picker.locator('.oac-pick__running');
    const catalog = picker.getByRole('listbox', { name: 'Indicators', exact: true });
    await expect(find).toBeFocused();
    await expect(running.locator('.oac-pick__running-row')).toHaveCount(11);
    await expect(running.locator(`[data-instance-id="${studies.hidden}"]`)).toHaveCount(0);
    await expect(running.locator(`[data-instance-id="${studies.protectedId}"] button`)).toBeDisabled();
    const searchBox = (await find.boundingBox())!;
    const runningBox = (await running.boundingBox())!;
    const catalogBox = (await catalog.boundingBox())!;
    const pickerBox = (await picker.boundingBox())!;
    expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(runningBox.y);
    expect(runningBox.y + runningBox.height).toBeLessThanOrEqual(catalogBox.y);
    expect(runningBox.height).toBeLessThanOrEqual(132);
    expect(catalogBox.height).toBeLessThanOrEqual(300);
    expect(pickerBox.y).toBeGreaterThanOrEqual(0);
    expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(viewport.height);
    expect(await running.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await catalog.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await catalog.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await catalog.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await running.evaluate(element => element.scrollTop)).toBe(0);
    expect(await find.boundingBox()).toEqual(searchBox);
    await info.attach('running controls above the scrolled catalog', {
      body: await page.screenshot({ path: info.outputPath('indicator-picker-dark.png') }), contentType: 'image/png',
    });
    await running.locator(`[data-instance-id="${studies.first}"] button`).click();
    await expect(find).toBeFocused();
    const ids = await page.evaluate(() => (window as any).__ui253.widget.chart.indicators().map((study: any) => study.id));
    expect(ids).not.toContain(studies.first);
    expect(ids).toContain(studies.second);
    expect(ids).toContain(studies.hidden);
    expect(ids).toContain(studies.protectedId);
    const catalogScroll = await catalog.evaluate(element => element.scrollTop);
    await running.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await running.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await catalog.evaluate(element => element.scrollTop)).toBe(catalogScroll);
    await find.fill('ema');
    const matches = await catalog.locator('.oac-pick__row').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id));
    expect(matches.length).toBeGreaterThan(1);
    await find.press('ArrowDown');
    await expect(catalog.locator('[aria-selected="true"]')).toHaveAttribute('data-id', matches[1]!);
    await find.press('ArrowUp');
    await expect(catalog.locator('[aria-selected="true"]')).toHaveAttribute('data-id', matches[0]!);
    await expect(find).toBeFocused();
    await find.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__ui253.widget.chart.indicators().length)).toBe(ids.length + 1);
    await expect(find).toBeFocused();
    await page.evaluate(() => (window as any).__ui253.widget.setTheme('light'));
    await info.attach('running controls in the light theme', {
      body: await page.screenshot({ path: info.outputPath('indicator-picker-light.png') }), contentType: 'image/png',
    });
    expect(errors).toEqual([]);
  });
}
