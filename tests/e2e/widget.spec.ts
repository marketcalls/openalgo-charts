import { test, expect, type Page } from '@playwright/test';

// The widget tier in a real browser. The unit suites drive the shell through a
// fake DOM, which proves the wiring but cannot see a stylesheet that failed to
// apply, a rail that mounted zero pixels wide, or a dialog that opened behind
// the chart. This spec mounts createWidget from the built bundle, the way a
// page would, and checks what a user would: the chart painted inside the
// chrome, a rail button arms its tool, the settings dialog opens and closes,
// and Escape unwinds one layer at a time.

const SETTINGS = '.oac-topbar button[aria-label="Chart settings"]';
const DIALOG = '.oac-dialog[role="dialog"]';
const TREND = '.oac-rail .oac-rail__fav[data-tools="trend-line"]';

async function mount(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto('/tests/e2e/widget-fixture.html');
  await page.waitForFunction(() => (window as any).__ready === true && (window as any).__loaded > 0);
  return errors;
}

/** Non-background pixels on the chart's base canvas. */
const countPainted = (): number => {
  const cv = document.querySelector('.oac-widget .oac-chart canvas') as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
  let nonbg = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] > 20 || data[i + 1] > 20 || data[i + 2] > 30) nonbg++;
  return nonbg;
};

test('mounts the chrome around a painted chart with no console or page errors', async ({ page }) => {
  const errors = await mount(page);

  await expect(page.locator('.oac-widget .oac-topbar')).toBeVisible();
  await expect(page.locator('.oac-widget .oac-rail')).toBeVisible();
  await expect(page.locator('.oac-widget .oac-statusline')).toBeVisible();
  const rail = await page.locator('.oac-widget .oac-rail').boundingBox();
  expect(rail!.width).toBeGreaterThan(20);

  // The stylesheet applied: the root took its grid layout and the dark tokens.
  const styled = await page.evaluate(() => {
    const root = document.querySelector('.oac-widget') as HTMLElement;
    const cs = getComputedStyle(root);
    return { display: cs.display, bg: cs.backgroundColor, theme: root.dataset.theme };
  });
  expect(styled.display).toBe('grid');
  expect(styled.theme).toBe('dark');
  expect(styled.bg).not.toBe('rgba(0, 0, 0, 0)');

  // The feed's bars reached the canvas. Polled: the frame lands after __ready.
  await page.waitForFunction(
    (fn) => new Function('return (' + fn + ')()')() > 2000,
    countPainted.toString(),
    { timeout: 5000 },
  );
  expect(await page.evaluate(countPainted)).toBeGreaterThan(2000);

  // The status line names the instrument it was asked for.
  await expect(page.locator('.oac-widget .oac-statusline')).toContainText('FIXTURE');
  expect(await page.evaluate(() => (window as any).__widgetErrors)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a rail button arms its tool and Escape disarms it', async ({ page }) => {
  const errors = await mount(page);
  const trend = page.locator(TREND);
  await expect(trend).toBeVisible();

  await trend.click();
  expect(await page.evaluate(() => (window as any).__widget.draw.activeTool())).toBe('trend-line');
  await expect(trend).toHaveAttribute('aria-pressed', 'true');
  // The armed tool rides the chart container as a cursor.
  const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('.oac-widget .oac-chart') as HTMLElement).cursor);
  expect(cursor).not.toBe('auto');

  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).__widget.draw.activeTool())).toBeNull();
  await expect(trend).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('the settings dialog opens from the top bar and closes from its own button', async ({ page }) => {
  const errors = await mount(page);
  await expect(page.locator(DIALOG)).toHaveCount(0);

  await page.locator(SETTINGS).click();
  const dialog = page.locator(DIALOG);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // Generated from the chart's own settings schema: at least one tab and one
  // control, and every row has something behind it.
  expect(await dialog.locator('.oac-tab').count()).toBeGreaterThan(1);
  expect(await dialog.locator('.oac-form .oac-row').count()).toBeGreaterThan(0);
  // Focus moved into the dialog, so the keyboard user is where the mouse user is.
  expect(await page.evaluate(() => document.activeElement?.closest('.oac-dialog') !== null)).toBe(true);

  await dialog.locator('.oac-dialog__head button[aria-label="Close"]').click();
  await expect(page.locator(DIALOG)).toHaveCount(0);
  // Focus came back to the button that opened it.
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label'))).toBe('Chart settings');
  expect(errors).toEqual([]);
});

test('Escape closes the top overlay first and only then reaches the chart', async ({ page }) => {
  const errors = await mount(page);

  // Arm a tool, then open the dialog over it: Escape must close the dialog and
  // leave the tool armed, because a chord never fires past an open overlay.
  await page.locator(TREND).click();
  await page.locator(SETTINGS).click();
  await expect(page.locator(DIALOG)).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator(DIALOG)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__widget.draw.activeTool())).toBe('trend-line');

  // With nothing open, the same key reaches the widget scope and disarms.
  await page.mouse.move(600, 350);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).__widget.draw.activeTool())).toBeNull();
  expect(errors).toEqual([]);
});

test('destroy removes every piece of chrome', async ({ page }) => {
  const errors = await mount(page);
  await page.evaluate(() => (window as any).__widget.destroy());
  expect(await page.locator('.oac-widget').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).__widget.isDestroyed)).toBe(true);
  expect(errors).toEqual([]);
});
