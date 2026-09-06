/** Browser checks against the built website, including its embedded demo. */
import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = (process.argv[2] ?? 'http://127.0.0.1:4174/openalgo-charts').replace(/\/$/, '');
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/docs/market-profile-examples/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Profile demo & themes' })).toBeVisible();
  await expect(page.locator('.oac-profile-gallery .oac-profile-shot')).toHaveCount(5);
  const images = await page.locator('.oac-profile-shot img').evaluateAll(nodes => nodes.map(node => node.src));
  assert.equal(images.length, 7);
  for (const src of images) {
    const response = await page.request.get(src);
    assert.equal(response.status(), 200, src);
    const body = await response.body();
    assert.equal(body.subarray(1, 4).toString(), 'PNG', src);
    assert.equal(body.readUInt32BE(16), 800, src);
    assert.equal(body.readUInt32BE(20), 1320, src);
  }
  const iframe = page.locator('iframe[title="Interactive compact market profile demo"]');
  await iframe.scrollIntoViewIfNeeded();
  const frame = await (await iframe.elementHandle()).contentFrame();
  assert.ok(frame);
  await expect(frame.locator('#theme')).toHaveValue('blue');
  await frame.locator('#compressed').click();
  await frame.waitForFunction(() => {
    const chart = window.__chart();
    const s = window.__profileResult().sessions[5];
    return window.__mp().hoverAt(chart.timeScale.indexToX(375) + 18,
      chart.panes()[0].priceScale.priceToY(s.poc))?.sessionIndex === 5;
  });
  const rightClick = async () => {
    const point = await frame.evaluate(() => {
      const chart = window.__chart();
      return { x: chart.timeScale.indexToX(375) + 18,
        y: chart.panes()[0].priceScale.priceToY(window.__profileResult().sessions[5].poc) };
    });
    await frame.locator('#chart').click({ button: 'right', position: point });
  };
  const before = await frame.evaluate(() => JSON.stringify(window.__profileResult()));
  await rightClick();
  await frame.getByRole('menuitem', { name: 'Split this day', exact: true }).click();
  for (const theme of ['ivory', 'graphite', 'emerald', 'dark', 'blue']) {
    await frame.locator('#theme').selectOption(theme);
    assert.deepEqual(await frame.evaluate(() => window.__profileResult().sessions.map((_, i) => window.__mp().isSessionSplit(i))),
      [false, false, false, false, false, true]);
  }
  assert.equal(await frame.evaluate(() => JSON.stringify(window.__profileResult())), before);
  await rightClick();
  await frame.getByRole('menuitem', { name: 'Unsplit this day', exact: true }).click();
  assert.equal(await frame.evaluate(() => window.__mp().isSessionSplit(5)), false);
  await page.screenshot({ path: 'artifacts/website-profile-demo.png' });

  await page.locator('#five-themes').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/website-profile-themes.png' });
  await page.goto(`${base}/examples/`);
  await expect(page.getByRole('heading', { name: /^Compact market profiles/ })).toBeVisible();
  await expect(page.locator('.oac-profile-gallery .oac-profile-shot')).toHaveCount(5);
  await page.goto(`${base}/docs/release-notes/`);
  await expect(page.getByRole('heading', { name: /^2\.1\.0/ })).toBeVisible();
  await page.goto(`${base}/`);
  await expect(page.getByRole('link', { name: 'Explore the profile demo' })).toHaveCount(0);
  await expect(page.locator('img[src*="screenshots/market-profile"]')).toHaveCount(0);
  await expect(page.locator('.oac-profile-demo')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/website-profile-home.png', fullPage: true });
  const api = await page.request.get(`${base}/api/classes/profile.MarketProfile.html`);
  assert.equal(api.status(), 200);
  assert.match(await api.text(), /setSessionSplit/);
  assert.match(await api.text(), /isSessionSplit/);
  for (const route of ['/docs/market-profile-examples/', '/examples/']) {
    await page.goto(`${base}${route}`);
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const shots = page.locator('.oac-profile-shot img');
      for (const shot of await shots.all()) {
        await shot.scrollIntoViewIfNeeded();
        await expect(shot).toBeVisible();
        const metrics = await shot.evaluate(node => ({ width: node.getBoundingClientRect().width, sourceWidth: node.naturalWidth }));
        assert.equal(metrics.sourceWidth, 800);
        // Captures use 16 CSS pixel letters at DPR 2. Check the actual rendered
        // font size, including responsive card and thumbnail scaling.
        assert.ok(32 * metrics.width / metrics.sourceWidth >= 12.7, `${route} at ${width}px must keep readable letters`);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} at ${width}px must not overflow horizontally`);
      if (route.includes('/docs/') && (width === 390 || width === 1440)) {
        await shots.nth(1).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `artifacts/website-profile-gallery-${width}.png` });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('Website checks passed: embedded split/unsplit, five themes, unchanged analytics, seven screenshots, examples, homepage, release notes, API reference and mobile layout.');
} finally {
  await browser.close();
}
