import { expect, test, type Page } from '@playwright/test';
import type { Widget } from '../../src/widget/widget';

/**
 * The icon sets, judged as pixels.
 *
 * `tests/draw-icons.test.ts` holds the path data to its grid and rejects two
 * glyphs that are the same drawing written differently. It cannot see two
 * drawings that differ on paper and still rasterise to the same shape at the
 * size a rail shows them: lock and unlock differed by one short stroke, which
 * a round cap filled in, and overlapped by more than 99 percent at 16px.
 *
 * So every glyph is rasterised here at its tier's native size, one CSS pixel
 * per grid unit, by each engine's own SVG renderer, and each pair within a
 * tier is compared as a mask: the share of inked pixels the two have in common
 * (intersection over union). The same pass measures how much of each glyph's
 * ink is solid rather than anti-aliased, which is what crisp means at 1:1.
 *
 * Both tiers are judged twice: as the markup builders draw them, accents
 * filled, and as the bare path data, which is all a host that wraps the
 * registry itself draws. The marks that tell siblings apart have to survive
 * the second: a horizontal ray whose origin dot lived only in its accent was
 * the horizontal line at 0.86 overlap for such a host.
 */

interface Glyph { id: string; svg: string; px: number }
type Tier = 'tools' | 'chrome';
type Rendering = 'markup' | 'path';
interface Measured {
  pairs: { a: string; b: string; iou: number }[];
  crisp: number;
  n: number;
}

declare global {
  interface Window {
    __iconFixture: {
      icons: Record<Tier | 'toolsPath' | 'chromePath', Glyph[]>;
      widget: Widget;
      lineId: string;
      mountIndicatorSettings: (ctx: Widget['context'], anchor?: HTMLElement, opts?: { instanceId?: string; tab?: 'inputs' | 'style' }) => unknown;
    };
  }
}

/** Past this overlap two buttons in one rail are the same button. */
const CEILING = 0.85;

/**
 * One control in two states, drawn alike on purpose: the second state is the
 * first with a mark added. Nothing else may pass the ceiling.
 */
const STATE_PAIRS = new Set(['star~star-filled', 'eye~eye-off', 'link~unlink']);

/**
 * Siblings that sit next to each other in one flyout or menu and were
 * measured too close, held to a tighter ceiling than the rest: same family,
 * told apart by their ends, their direction or their marks. The horizontal
 * pair, the three bubbles and trash beside paste were 0.72 to 0.86.
 */
const SIBLINGS: Record<Tier, [string, string][]> = {
  tools: [
    ['long-position', 'short-position'], ['risk-reward-long', 'risk-reward-short'],
    ['long-position', 'risk-reward-long'], ['short-position', 'risk-reward-short'],
    ['path', 'polyline'], ['cursor', 'cross-line'],
    ['trend-line', 'ray'], ['trend-line', 'extended-line'], ['trend-line', 'info-line'], ['trend-line', 'arrow'],
    ['ray', 'extended-line'], ['ray', 'info-line'], ['extended-line', 'info-line'],
    ['horizontal-line', 'horizontal-ray'], ['callout', 'balloon'], ['callout', 'comment'], ['balloon', 'comment'],
  ],
  chrome: [['lock', 'unlock'], ['cursor', 'plus'], ['trash', 'paste']],
};
const SIBLING_CEILING = 0.7;

/**
 * Share of a tier's inked pixels that are solid at native size, as the
 * builders draw them. Measured at 0.59 for the tools and 0.62 for chrome in
 * all three engines; a floor far under that lets a real loss through.
 */
const CRISP_FLOOR: Record<Tier, number> = { tools: 0.59, chrome: 0.6 };

async function mount(page: Page, theme: 'dark' | 'light' = 'dark'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.goto(`/tests/e2e/icon-raster-fixture.html?theme=${theme}`);
  await page.waitForFunction(() => !!window.__iconFixture && window.__iconFixture.lineId !== '');
  return errors;
}

/** Rasterise one tier, drawn one way, in the page and compare every pair. */
function measure(page: Page, tier: Tier, rendering: Rendering = 'markup'): Promise<Measured> {
  return page.evaluate(async (which) => {
    const list = window.__iconFixture.icons[which];
    const rows: { id: string; mask: Uint8Array; crisp: number }[] = [];
    for (const g of list) {
      // Black on transparent, so alpha alone is the ink.
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(g.svg.replace(/currentColor/g, '#000'));
      await img.decode();
      const c = document.createElement('canvas');
      c.width = g.px;
      c.height = g.px;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, g.px, g.px);
      const data = ctx.getImageData(0, 0, g.px, g.px).data;
      const mask = new Uint8Array(g.px * g.px);
      let lit = 0;
      let solid = 0;
      for (let i = 0; i < mask.length; i++) {
        const a = data[i * 4 + 3] / 255;
        mask[i] = a > 0.3 ? 1 : 0;
        if (a > 0.05) { lit++; if (a >= 0.9) solid++; }
      }
      rows.push({ id: g.id, mask, crisp: lit === 0 ? 0 : solid / lit });
    }
    const pairs: { a: string; b: string; iou: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        let inter = 0;
        let union = 0;
        const A = rows[i].mask;
        const B = rows[j].mask;
        for (let k = 0; k < A.length; k++) { inter += A[k] & B[k]; union += A[k] | B[k]; }
        pairs.push({ a: rows[i].id, b: rows[j].id, iou: union === 0 ? 0 : inter / union });
      }
    }
    return { pairs, crisp: rows.reduce((s, r) => s + r.crisp, 0) / rows.length, n: rows.length };
  }, rendering === 'markup' ? tier : (`${tier}Path` as const));
}

const key = (a: string, b: string): string => `${a}~${b}`;

for (const [tier, rendering] of [['tools', 'markup'], ['chrome', 'markup'], ['tools', 'path'], ['chrome', 'path']] as const) {
  test(`no two ${tier} glyphs rasterise to the same shape, drawn as ${rendering === 'path' ? 'bare path data' : 'markup'}`, async ({ page }, info) => {
    const errors = await mount(page);
    const m = await measure(page, tier, rendering);
    expect(m.n).toBeGreaterThan(20);
    const close = m.pairs
      .filter((p) => p.iou >= CEILING && !STATE_PAIRS.has(key(p.a, p.b)) && !STATE_PAIRS.has(key(p.b, p.a)))
      .map((p) => `${key(p.a, p.b)} ${p.iou.toFixed(2)}`);
    await info.attach(`${tier}-${rendering}-closest.txt`, {
      body: [...m.pairs].sort((p, q) => q.iou - p.iou).slice(0, 20).map((p) => `${key(p.a, p.b)} ${p.iou.toFixed(3)}`).join('\n'),
      contentType: 'text/plain',
    });
    expect(close, `pairs at IoU ${CEILING} or more`).toEqual([]);

    const byKey = new Map(m.pairs.map((p) => [key(p.a, p.b), p.iou] as const));
    const siblings = SIBLINGS[tier].map(([a, b]) => {
      const iou = byKey.get(key(a, b)) ?? byKey.get(key(b, a));
      expect(iou, `${key(a, b)} was not measured`).toBeDefined();
      return { pair: key(a, b), iou: iou! };
    });
    const tooClose = siblings.filter((s) => s.iou >= SIBLING_CEILING).map((s) => `${s.pair} ${s.iou.toFixed(2)}`);
    expect(tooClose, `siblings at IoU ${SIBLING_CEILING} or more`).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const tier of ['tools', 'chrome'] as const) {
  test(`${tier} glyphs are crisp at their native size`, async ({ page }, info) => {
    await mount(page);
    const m = await measure(page, tier);
    await info.attach(`${tier}-crisp.txt`, { body: m.crisp.toFixed(3), contentType: 'text/plain' });
    expect(m.crisp).toBeGreaterThan(CRISP_FLOOR[tier]);
  });
}

test('the widget shows the glyphs as the tier ships them, in the rail, a flyout and menus', async ({ page }, info) => {
  for (const theme of ['dark', 'light'] as const) {
    const errors = await mount(page, theme);
    // The rail draws tools from the sprite; an accent must travel with its
    // symbol, filled, or the rail shows a ray without its origin.
    const accents = await page.evaluate(() => ({
      ray: document.querySelectorAll('#oac-rail-sprite symbol#oac-icon-ray path[fill="currentColor"]').length,
      trend: document.querySelectorAll('#oac-rail-sprite symbol#oac-icon-trend-line path[fill="currentColor"]').length,
    }));
    expect(accents).toEqual({ ray: 1, trend: 1 });
    // The widget's own stylesheet sets the chrome width; it has to match the
    // tier, or the crisp stroke is overridden back to a fractional one.
    const widths = await page.evaluate(() => [...document.querySelectorAll('.oac-widget .oac-glyph--chrome > svg')]
      .map((svg) => getComputedStyle(svg).strokeWidth));
    expect(widths.length).toBeGreaterThan(3);
    expect(new Set(widths)).toEqual(new Set(['2px']));

    const rail = page.locator('.oac-rail');
    await rail.screenshot({ path: info.outputPath(`rail-${theme}.png`) });
    await page.locator('.oac-topbar').screenshot({ path: info.outputPath(`topbar-${theme}.png`) });

    // The three flyouts that hold the redrawn siblings: the line family,
    // path and polyline, and the two positions.
    for (const group of ['lines', 'shapes', 'forecast']) {
      const button = page.locator(`.oac-rail [data-group="${group}"]`);
      await expect(button).toHaveCount(1);
      await button.click({ button: 'right' });
      const fly = page.locator('.oac-fly');
      await expect(fly).toBeVisible();
      const box = (await fly.boundingBox())!;
      const railBox = (await rail.boundingBox())!;
      await page.screenshot({ path: info.outputPath(`flyout-${group}-${theme}.png`),
        clip: { x: 0, y: Math.max(0, box.y - 8), width: box.x + box.width + 8, height: box.height + 16 } });
      expect(box.x).toBeGreaterThanOrEqual(railBox.x + railBox.width - 1);
      await page.keyboard.press('Escape');
      await expect(fly).toHaveCount(0);
    }

    // The drawing menu carries most of the chrome tier: copy, duplicate,
    // lock, eye, front, back and trash.
    const at = await page.evaluate(() => {
      const { widget, lineId } = window.__iconFixture;
      const [a, b] = widget.draw.screenPoints(lineId);
      const rect = widget.root.querySelector('.oac-chart')!.getBoundingClientRect();
      return { x: rect.left + (a.x + b.x) / 2, y: rect.top + (a.y + b.y) / 2 };
    });
    await page.mouse.click(at.x, at.y, { button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /Duplicate/ })).toBeVisible();
    await menu.screenshot({ path: info.outputPath(`drawing-menu-${theme}.png`) });
    await page.keyboard.press('Escape');

    // The widget's own glyphs sit in the settings tab rails beside registry
    // ones, at the same width; the price tab and the style brush were drawn
    // for the old line and have to read at this one.
    const tabGlyphs = async (name: string): Promise<void> => {
      const tabs = page.locator('.oac-tabs').last();
      await expect(tabs).toBeVisible();
      const strokes = await tabs.locator('.oac-glyph--chrome > svg').evaluateAll((svgs) => svgs.map((s) => getComputedStyle(s).strokeWidth));
      expect(strokes.length).toBeGreaterThan(1);
      expect(new Set(strokes)).toEqual(new Set(['2px']));
      await tabs.screenshot({ path: info.outputPath(`${name}-tabs-${theme}.png`) });
      await page.keyboard.press('Escape');
      await expect(tabs).toHaveCount(0);
    };
    expect(await page.evaluate(() => window.__iconFixture.widget.openSettings())).toBe(true);
    await tabGlyphs('settings');
    await page.evaluate(() => {
      const { widget, mountIndicatorSettings } = window.__iconFixture;
      const inst = widget.chart.addIndicator('sma', { length: 5 });
      mountIndicatorSettings(widget.context, undefined, { instanceId: inst.id, tab: 'style' });
    });
    await tabGlyphs('indicator');
    expect(errors).toEqual([]);
  }
});
