/** Verify the marketing chart, responsive theme and regenerated API reference. */
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = (process.argv[2] ?? 'http://127.0.0.1:4174/openalgo-charts').replace(/\/$/, '');
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('img[src*="screenshots/market-profile"]')).toHaveCount(0);
  await expect(page.locator('.oac-profile-demo')).toHaveCount(0);
  await expect(page.locator('.oac-example__code')).toHaveCount(0);
  const widget = page.locator('.oac-widget').first();
  await expect(widget.locator('canvas').first()).toBeVisible();
  await expect(widget.locator('.oac-rail')).toBeVisible();
  const trend = widget.getByRole('button', { name: 'Trend Line', exact: true });
  await trend.click();
  await expect(trend).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(trend).toHaveAttribute('aria-pressed', 'false');
  await widget.getByRole('button', { name: 'Indicators', exact: true }).click();
  const picker = page.getByRole('dialog');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('option').first()).toBeVisible();
  await picker.getByRole('button', { name: 'Close', exact: true }).click();
  await widget.getByRole('button', { name: 'Chart settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForFunction(() => scrollY === 0);
  await page.screenshot({ path: 'artifacts/website-premium-home.png', fullPage: true });

  for (const route of ['/', '/docs/getting-started/', '/examples/']) {
    await page.goto(`${base}${route}`);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} must fit ${width}px viewport`);
    }
  }
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await page.goto(`${base}/docs/getting-started/`);
  await expect(page.locator('html')).toHaveClass(/light/);
  await page.screenshot({ path: 'artifacts/website-premium-docs-light.png' });
  await page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.screenshot({ path: 'artifacts/website-premium-docs-dark.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${base}/`);
  await expect(widget.locator('canvas').first()).toBeVisible();
  const activeAnimations = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length);
  assert.equal(activeAnimations, 0, 'Reduced motion must disable intro animations');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/website-premium-home-mobile.png', fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/api/`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('v2.1.0');
  const css = page.locator('link[rel="stylesheet"][href*="custom.css"]');
  assert.equal(await css.count(), 1);
  const cssHref = await css.evaluate(node => node.href);
  assert.match(cssHref, /cache=/);
  assert.equal((await page.request.get(cssHref)).status(), 200);
  await expect(page.locator('#tsd-toolbar-links').getByRole('link', { name: 'Live demos', exact: true })).toHaveAttribute('href', '/openalgo-charts/examples/');
  for (const href of await page.locator('.oac-api-links a, .tsd-typography table a').evaluateAll(nodes => nodes.map(node => node.href))) {
    assert.equal((await page.request.get(href)).status(), 200, href);
  }
  await page.screenshot({ path: 'artifacts/website-premium-api.png' });
  await page.locator('label[for="tsd-search-field"]').click();
  await page.locator('#tsd-search-field').fill('setSessionSplit');
  await expect(page.locator('#tsd-search .results a').first()).toContainText('setSessionSplit');
  await page.locator('#tsd-search .results a').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('MarketProfile');
  const apiBody = await page.locator('body').innerText();
  assert.match(apiBody, /setSessionSplit/);
  assert.match(apiBody, /isSessionSplit/);
  await page.goto(`${base}/api/interfaces/profile.MarketProfilePrimitiveOptions.html`);
  const options = await page.locator('body').innerText();
  assert.match(options, /showSessionOpen/);
  assert.match(options, /showLastPrice/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/api/`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'API mobile page must not overflow');
  await page.getByRole('link', { name: 'Menu', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/has-menu/);
  await page.screenshot({ path: 'artifacts/website-premium-api-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('Site design checks passed: interactive homepage tools and dialogs, responsive pages, dark/light docs, reduced motion, current versioned API, working API search and mobile navigation.');
} finally {
  await browser.close();
}
