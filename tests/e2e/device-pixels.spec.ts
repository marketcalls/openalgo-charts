import { expect, test, type Page } from '@playwright/test';
import type { Chart } from '../../src/index';
import type * as Charts from '../../src/index';

/**
 * The chart at device pixel ratios other than 1, and across a change of ratio.
 *
 * What each engine allows:
 * - Chromium changes the device scale of a live page through the DevTools
 *   protocol. The change is made the way a zoom makes it, with the CSS
 *   viewport shrinking as the scale grows: a scale-only override changes
 *   `devicePixelRatio` without any resize, resolution-query change or
 *   ResizeObserver notification in Chromium's emulation, so no page code can
 *   see it at all.
 * - Firefox and WebKit take a device scale per browser context, fixed for its
 *   life, and Playwright has no protocol to change it, so both are checked
 *   at fixed scales from the first frame.
 * - Only Firefox renders a headless screenshot one to one at 1.25 and 1.5.
 *   Chromium and WebKit resample the page there (a canvas line on a whole
 *   device row lands on two rows even in the top pane), so the pixel-level
 *   separator check runs in Firefox and the geometry checks run everywhere.
 * - Firefox and Chromium report a canvas's device-pixel box; WebKit does not,
 *   and keeps `media x ratio`. Both reporting engines give the unscaled box
 *   under an emulated scale, which the chart refuses, so that path is checked
 *   at a ratio of 1 with a box half a pixel in.
 */

declare global {
  interface Window { __dpx: { chart: Chart } }
}

const CONTAINER = { left: 20, top: 20, width: 560, height: 344 };

async function paint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/**
 * A price pane over two study panes at 1 : 0.32 : 0.32, in a box whose height
 * splits into fractions of a device pixel at every ratio checked here. Grid
 * lines are off so a pixel column crosses nothing but background and rules.
 */
async function mount(page: Page, box: { left: number; width: number } = CONTAINER): Promise<void> {
  const css = `left:${box.left}px;top:${CONTAINER.top}px;width:${box.width}px;height:${CONTAINER.height}px`;
  await page.route('**/device-pixels.html', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><style>html,body{margin:0;background:#101010}#c{position:absolute;${css}}</style></head><body><div id="c"></div></body></html>`,
  }));
  await page.goto('/device-pixels.html');
  await page.evaluate(async () => {
    const { createChart, darkTheme } = await import('/dist/openalgo-charts.mjs') as typeof Charts;
    const chart = createChart(document.getElementById('c')!, {
      theme: darkTheme, branding: false, timeNavigator: false, animZoom: false, animAutoscale: false,
    });
    const bars = Array.from({ length: 120 }, (_, i) => {
      const close = 100 + Math.sin(i / 7) * 6;
      return { time: 1_700_000_000 + i * 300, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 + i };
    });
    chart.addSeries('candlestick').setData(bars);
    chart.addSeries('line', { paneIndex: 1 }).setData(bars.map(b => ({ time: b.time, value: 50 + Math.sin(b.time / 3000) * 10 })));
    chart.addSeries('line', { paneIndex: 2 }).setData(bars.map(b => ({ time: b.time, value: b.volume })));
    chart.setPaneWeight(1, 0.32);
    chart.setPaneWeight(2, 0.32);
    chart.setGridOptions({ vertLines: false, horzLines: false });
    window.__dpx = { chart };
  });
  await paint(page);
}

interface PaneGeometry {
  top: number; height: number;
  rule: { shown: boolean; height: number } | null;
  canvases: { width: number; height: number; mediaWidth: number; mediaHeight: number }[];
}

/** Pane boxes relative to the chart's container, their rule, and their canvases' stores. */
const geometry = (page: Page) => page.evaluate(() => {
  const container = document.getElementById('c')!.getBoundingClientRect();
  return {
    dpr: devicePixelRatio,
    panes: window.__dpx.chart.panes().map(pane => {
      const box = pane.element.getBoundingClientRect();
      const rule = pane.element.querySelector<HTMLElement>(':scope > div');
      return {
        top: box.top - container.top,
        height: box.height,
        rule: rule === null ? null : { shown: getComputedStyle(rule).display !== 'none', height: rule.getBoundingClientRect().height },
        canvases: [pane.base, pane.top].map(layer => ({
          width: layer.element.width, height: layer.element.height, mediaWidth: layer.mediaWidth, mediaHeight: layer.mediaHeight,
        })),
      };
    }) as PaneGeometry[],
  };
});

/** Layout positions come back in the engine's layout units, a 64th of a CSS pixel at worst. */
const onDevicePixel = (css: number, dpr: number): boolean => Math.abs(css * dpr - Math.round(css * dpr)) < 0.05;

function expectOnDevicePixels(g: { dpr: number; panes: PaneGeometry[] }): void {
  const { dpr, panes } = g;
  expect(panes).toHaveLength(3);
  panes.forEach((pane, i) => {
    expect(onDevicePixel(pane.top, dpr), `pane ${i} top ${pane.top} at ${dpr}`).toBe(true);
    expect(onDevicePixel(pane.height, dpr), `pane ${i} height ${pane.height} at ${dpr}`).toBe(true);
    for (const canvas of pane.canvases) {
      // The store covers the box one to one: whole device pixels, not a stretched estimate.
      expect(canvas.width, `pane ${i} store width`).toBe(Math.round(canvas.mediaWidth * dpr));
      expect(canvas.height, `pane ${i} store height`).toBe(Math.round(canvas.mediaHeight * dpr));
      expect(Math.abs(canvas.mediaHeight * dpr - canvas.height), `pane ${i} media height`).toBeLessThan(0.05);
    }
    expect(pane.rule, `pane ${i} rule`).not.toBeNull();
    expect(pane.rule!.shown, `pane ${i} rule shown`).toBe(i > 0);
    if (i > 0) expect(pane.rule!.height * dpr, `pane ${i} rule height`).toBeCloseTo(Math.max(1, Math.floor(dpr)), 1);
  });
}

const hexRgb = (hex: string): [number, number, number] =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

for (const scale of [1.25, 1.5]) {
  test.describe(`at a device scale of ${scale}`, () => {
    // Viewport times scale is whole, so a device-scale screenshot is the page one to one.
    test.use({ viewport: { width: 720, height: 480 }, deviceScaleFactor: scale });

    test('puts every pane boundary and separator on whole device pixels, and sizes each canvas to its box', async ({ page }, testInfo) => {
      await mount(page);
      const g = await geometry(page);
      expect(g.dpr).toBe(scale);
      expectOnDevicePixels(g);
      await page.screenshot({ scale: 'device', path: testInfo.outputPath(`chart-${scale}.png`) });
    });

    test('draws each separator as whole rows of its colour between plain pane backgrounds', async ({ page, browserName }, testInfo) => {
      test.skip(browserName !== 'firefox', 'Headless Chromium and WebKit resample the page at a fractional scale, so only Firefox shows it pixel for pixel');
      await mount(page);
      const g = await geometry(page);
      const shot = await page.screenshot({ scale: 'device', path: testInfo.outputPath(`separators-${scale}.png`) });
      await testInfo.attach(`separators-${scale}`, { path: testInfo.outputPath(`separators-${scale}.png`), contentType: 'image/png' });
      const theme = await page.evaluate(() => ({ background: window.__dpx.chart.theme().background, rule: window.__dpx.chart.theme().paneSeparator }));
      const columns = await page.evaluate(async ([encoded, rows]) => {
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], { type: 'image/png' }));
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const g2 = canvas.getContext('2d')!;
        g2.drawImage(bitmap, 0, 0);
        // Three columns across the plot, clear of the legend text and the price axis.
        return [200, 300, 400].map(xCss => {
          const x = Math.round(xCss * devicePixelRatio);
          return rows.map(y => Array.from(g2.getImageData(x, y, 1, 1).data.slice(0, 3)));
        });
      }, [shot.toString('base64'), g.panes.slice(1).flatMap(pane => {
        const y = Math.round((CONTAINER.top + pane.top) * scale);
        return [y - 1, y, y + 1];
      })] as const);
      const [bg, rule] = [hexRgb(theme.background), hexRgb(theme.rule)];
      const near = (px: number[], rgb: number[]) => px.every((v, k) => Math.abs(v - rgb[k]) <= 2);
      for (const column of columns) {
        for (let s = 0; s < 2; s++) {
          const [above, on, below] = column.slice(s * 3, s * 3 + 3);
          expect(near(above, bg), `row above separator ${s + 1}: ${above}`).toBe(true);
          expect(near(on, rule), `separator ${s + 1}: ${on}`).toBe(true);
          expect(near(below, bg), `row below separator ${s + 1}: ${below}`).toBe(true);
        }
      }
    });
  });
}

test.describe('a device scale changed while the chart is showing', () => {
  test.use({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });

  test('re-sizes every canvas and keeps the separators on device pixels, each time', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Only Chromium lets Playwright change the device scale of a live page; Firefox and WebKit are checked at fixed scales above');
    await mount(page);
    expectOnDevicePixels(await geometry(page));
    const cdp = await page.context().newCDPSession(page);
    for (const scale of [1.5, 2, 1.25, 1]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(900 / scale), height: Math.round(600 / scale), deviceScaleFactor: scale, mobile: false,
      });
      await page.waitForFunction(ratio => devicePixelRatio === ratio, scale);
      await expect.poll(() => page.evaluate(() => window.__dpx.chart.panes()[0].base.pixelRatio), { message: `canvases at ${scale}` }).toBe(scale);
      await paint(page);
      const g = await geometry(page);
      expect(g.dpr).toBe(scale);
      expectOnDevicePixels(g);
      expect(g.panes[0].canvases[0].width).toBe(Math.round(CONTAINER.width * scale));
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  });
});

test.describe('the device-pixel box the browser reports', () => {
  test.use({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });

  test('sizes a canvas that starts half a pixel in to the pixels its box covers', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit reports no device-pixel content box, so the chart keeps media times ratio there');
    await mount(page, { left: 20.5, width: 560.5 });
    const reported = await page.evaluate(() => new Promise<{ device: number; media: number }>(resolve => {
      const canvas = window.__dpx.chart.panes()[0].base.element;
      new ResizeObserver(entries => resolve({
        device: entries[0].devicePixelContentBoxSize[0].inlineSize,
        media: window.__dpx.chart.panes()[0].base.mediaWidth,
      })).observe(canvas, { box: 'device-pixel-content-box' });
    }));
    // The case is real: the box snaps to a pixel fewer than media times ratio rounds to.
    expect(reported.media).toBe(560.5);
    expect(reported.device).not.toBe(Math.round(reported.media));
    await expect.poll(() => page.evaluate(() => window.__dpx.chart.panes().map(p => [p.base.element.width, p.top.element.width])))
      .toEqual([[reported.device, reported.device], [reported.device, reported.device], [reported.device, reported.device]]);
    // Painted at that size, not left cleared by the change.
    const painted = await page.evaluate(() => {
      const canvas = window.__dpx.chart.panes()[0].base.element;
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] === 255) opaque++;
      return opaque / (canvas.width * canvas.height);
    });
    expect(painted).toBeGreaterThan(0.9);
  });
});
