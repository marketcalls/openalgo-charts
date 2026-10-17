import { expect, test, type Page } from '@playwright/test';
import type { Bar, IndicatorApi } from '../../src/index';
import type { Widget } from '../../src/widget/widget';

declare global {
  interface Window {
    __legendActions: { widget: Widget; study: IndicatorApi; latest: Bar; hover: string | null };
  }
}

async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function mount(page: Page, width: number) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/tests/e2e/widget-fixture.html');
  await page.waitForFunction(() => (window as unknown as { __loaded: number }).__loaded > 0);
  await page.evaluate(width => {
    const widget = (window as unknown as { __widget: Widget }).__widget;
    widget.setTheme(width < 600 ? 'light' : 'dark');
    const study = widget.chart.addIndicator('macd');
    window.__legendActions = { widget, study, latest: widget.chart.primaryBars().at(-1)!, hover: null };
    widget.chart.on('hover', event => { window.__legendActions.hover = event.id; });
  }, width);
  await paint(page);
  return errors;
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const { widget, study, hover } = window.__legendActions;
    const legend = study.legend()!;
    const pane = widget.chart.panes()[study.paneIndex].element.getBoundingClientRect();
    const options = legend.options();
    const state = legend as unknown as { _buttons: { id: string; x: number; y: number }[]; _values: { text: string }[] };
    return {
      row: { x: pane.left + 40, y: pane.top + (options.top ?? 6) + (options.row ?? 0) * 18 + 8 },
      buttons: state._buttons.map(button => ({ id: button.id, x: pane.left + button.x + 8, y: pane.top + button.y + 8 })),
      values: state._values.map(value => value.text), hover,
    };
  });
}

for (const width of [1280, 480]) {
  test(`legend hover and clicks stay on the same actions at ${width}px`, async ({ page }, info) => {
    const errors = await mount(page, width);
    const row = (await geometry(page)).row;
    await page.mouse.move(row.x, row.y);
    await paint(page);
    const before = await geometry(page);
    const gear = before.buttons.find(button => button.id.endsWith('::settings'))!;
    expect(gear).toBeDefined();
    await page.mouse.move(gear.x, gear.y);
    await paint(page);
    const after = await geometry(page);
    expect(after.values).not.toEqual(before.values);
    expect(after.buttons).toEqual(before.buttons);
    for (const offset of [-4, 0, 4, 0]) {
      await page.mouse.move(gear.x + offset, gear.y);
      await paint(page);
      expect((await geometry(page)).buttons).toEqual(before.buttons);
      expect((await geometry(page)).hover).toBe(gear.id);
    }
    await expect(page.locator('.oac-tip.is-on')).toContainText('Settings for');
    await page.screenshot({ path: info.outputPath(`legend-hover-${width}.png`) });
    await page.mouse.click(gear.x, gear.y);
    await expect(page.locator('.oac-indset')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.oac-indset')).toHaveCount(0);
    const hide = before.buttons.find(button => button.id.endsWith('::hide'))!;
    await page.mouse.click(hide.x, hide.y);
    expect(await page.evaluate(() => window.__legendActions.study.visible())).toBe(false);
    await paint(page);
    expect((await geometry(page)).buttons).toEqual(before.buttons);
    await page.mouse.click(hide.x, hide.y);
    expect(await page.evaluate(() => window.__legendActions.study.visible())).toBe(true);
    const close = before.buttons.find(button => button.id.endsWith('::close'))!;
    await page.mouse.click(close.x, close.y);
    expect(await page.evaluate(() => window.__legendActions.widget.chart.indicators().length)).toBe(0);
    expect(errors).toEqual([]);
  });

  test(`live readings do not move the hovered settings target at ${width}px`, async ({ page }, info) => {
    const errors = await mount(page, width);
    const row = (await geometry(page)).row;
    await page.mouse.move(row.x, row.y);
    await paint(page);
    const before = await geometry(page);
    const gear = before.buttons.find(button => button.id.endsWith('::settings'))!;
    await page.mouse.move(gear.x, gear.y);
    await paint(page);
    // Hosts may request latest readings while the pointer stays on the controls.
    await page.evaluate(() => window.__legendActions.study.updateLegendValues());
    await paint(page);
    const values = (await geometry(page)).values;
    for (const close of [10000, 1, 100]) {
      await page.evaluate(close => {
        const { widget, study, latest } = window.__legendActions;
        widget.series.update({ ...latest, close, high: Math.max(latest.high, close), low: Math.min(latest.low, close) });
        study.updateLegendValues();
      }, close);
      await paint(page);
      expect((await geometry(page)).buttons).toEqual(before.buttons);
    }
    expect((await geometry(page)).values).not.toEqual(values);
    await page.screenshot({ path: info.outputPath(`legend-live-${width}.png`) });
    await page.mouse.click(gear.x, gear.y);
    await expect(page.locator('.oac-indset')).toBeVisible();
    expect(errors).toEqual([]);
  });
}
