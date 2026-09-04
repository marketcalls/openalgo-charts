import { test, expect, type Page } from '@playwright/test';

// The yfinance demo, the reference host, in a real browser.
//
// CLAUDE.md holds the demo to "usable, not just present", and the unit suite
// under examples/yfinance/tests runs against a document double: it cannot see
// a candle that never painted, a cursor the stylesheet did not pick up, or a
// click the chart swallowed. This spec drives the page the way a person does
// (the rail, the mouse over the plot, the transport's buttons) and reads the
// result back through `window.__oac = { chart, draw, app }`, which the page
// exposes only when opened as index.html?test=1.
//
// The page runs against its own server, examples/yfinance/server.py, in
// --fixture mode: deterministic synthetic bars for any symbol, no network and
// no yfinance, with FAIL, EMPTY and BUSY reserved for the 502, 404 and 429
// paths. playwright.config.ts starts that server when a Python 3 is on PATH.
// When none is, the probe in beforeEach finds nothing and every test here
// skips, rather than failing a run that never asked for Python.

const PAGE = '/examples/yfinance/index.html?test=1';
/** Only the demo server answers this; the static server has no /api. */
const PROBE = '/api/history?symbol=AAPL&interval=1d&period=1mo';
/** Distinct colours a real chart paints; a blank one is far below this. */
const MIN_DISTINCT_COLORS = 10;
/** Pixels that are not the background on a chart that has drawn its bars. */
const MIN_INK = 2000;

let serverUp: boolean | null = null;

test.beforeEach(async ({ request }) => {
  if (serverUp === null) serverUp = await request.get(PROBE).then((r) => r.ok(), () => false);
  test.skip(!serverUp, 'the yfinance demo server is not up (playwright.config.ts starts it when a Python 3 is on PATH)');
});

/** Console errors and uncaught exceptions from here on, in order. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Open the page and wait for the first load to land: the handle, a chart, a controller and bars. */
async function openDemo(page: Page): Promise<void> {
  await page.goto(PAGE);
  await page.waitForFunction(() => {
    const o = (window as any).__oac;
    return Boolean(o && o.chart && o.draw && o.app.currentBars.length > 0);
  });
}

/**
 * Distinct colours across the chart's canvases, and how many pixels are not
 * the most common one. "Did it paint?" cannot be alpha != 0: the background
 * is opaque, so it has to be measured against the background itself, which
 * is the most common colour.
 */
const ink = (page: Page) => page.evaluate(() => {
  const planes = Array.from(document.querySelectorAll('#chart canvas')) as HTMLCanvasElement[];
  const counts = new Map<number, number>();
  for (const cv of planes) {
    const ctx = cv.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // fully transparent overlay plane
      const key = (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let total = 0;
  let most = 0;
  for (const n of counts.values()) {
    total += n;
    if (n > most) most = n;
  }
  return { planes: planes.length, distinct: counts.size, nonBackground: total - most };
});

const drawingCount = (page: Page) => page.evaluate(() => (window as any).__oac.draw.drawings().length as number);
const activeTool = (page: Page) => page.evaluate(() => (window as any).__oac.draw.activeTool() as string | null);
const selectedId = (page: Page) => page.evaluate(() => (window as any).__oac.draw.selected() as string | null);
const cursorOf = (page: Page) => page.locator('#chart').evaluate((n) => getComputedStyle(n).cursor);
const chartBox = async (page: Page) => {
  const box = await page.locator('#chart').boundingBox();
  if (!box) throw new Error('#chart has no box: the stage did not lay out');
  return box;
};

test('loads a symbol and paints candles with no console or page errors', async ({ page }) => {
  const errors = watchErrors(page);
  await openDemo(page);

  await expect(page.locator('#status')).toHaveText(/AAPL .*\d+ bars/);
  const bars = await page.evaluate(() => (window as any).__oac.app.currentBars.length as number);
  expect(bars, 'a year of daily bars').toBeGreaterThan(200);

  // The first frame lands after the load resolves; wait for the pixels.
  await expect.poll(async () => (await ink(page)).nonBackground, { message: 'the chart never painted' }).toBeGreaterThan(MIN_INK);
  const shot = await ink(page);
  expect(shot.planes).toBeGreaterThan(0);
  expect(shot.distinct, `painted only ${shot.distinct} colours: the chart is blank`).toBeGreaterThan(MIN_DISTINCT_COLORS);
  expect(errors).toEqual([]);
});

test('arming a tool from the rail puts its glyph on the pointer', async ({ page }) => {
  const errors = watchErrors(page);
  await openDemo(page);
  expect(await cursorOf(page)).toBe('crosshair');

  // A group button arms the tool it stands for; the Lines group opens on the trend line.
  const lines = page.locator('#rail .rail__group[data-group="lines"]');
  await lines.click();
  expect(await activeTool(page)).toBe('trend-line');
  await expect(lines).toHaveAttribute('aria-pressed', 'true');
  // The rail sets --tool-cursor and the stylesheet reads it: a glyph, not a keyword.
  expect(await cursorOf(page)).toMatch(/^url\("data:image\/svg\+xml/);

  // The cursor button disarms it and the crosshair comes back.
  await page.locator('#rail .rail__tool[data-tools=""]').click();
  expect(await activeTool(page)).toBeNull();
  expect(await cursorOf(page)).toBe('crosshair');
  expect(errors).toEqual([]);
});

test('two clicks place a trend line, selecting it raises the properties bar, Escape closes it', async ({ page }) => {
  const errors = watchErrors(page);
  await openDemo(page);
  await page.locator('#rail .rail__group[data-group="lines"]').click();
  const box = await chartBox(page);
  // Both anchors in the price pane, clear of the legend rows at the top
  // left, the price axis on the right and the indicator pane below.
  const a = { x: box.x + box.width * 0.30, y: box.y + box.height * 0.40 };
  const b = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.25 };
  await page.mouse.click(a.x, a.y);
  expect(await drawingCount(page), 'one anchor is not yet a drawing').toBe(0);
  await page.mouse.click(b.x, b.y);
  expect(await drawingCount(page)).toBe(1);
  const id = await page.evaluate(() => (window as any).__oac.draw.drawings()[0].id as string);

  // One drawing per pick: the tool is gone, and the new line is the selection.
  expect(await activeTool(page)).toBeNull();
  expect(await selectedId(page)).toBe(id);
  const bar = page.locator('#propbar');
  await expect(bar).toBeVisible();

  // A click on empty plot clears the selection, and the bar goes with it.
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.55);
  expect(await selectedId(page)).toBeNull();
  await expect(bar).toBeHidden();

  // A click on the line itself, at its midpoint as the chart maps it now
  // (the anchors sit on bar times, not exactly where the mouse went).
  const mid = await page.evaluate((id) => {
    const { chart, draw } = (window as any).__oac;
    const d = draw.get(id);
    const [p, q] = d.points;
    return {
      x: (chart.timeToCoordinate(p.time) + chart.timeToCoordinate(q.time)) / 2,
      y: (chart.priceToCoordinate(p.price, d.paneIndex) + chart.priceToCoordinate(q.price, d.paneIndex)) / 2,
    };
  }, id);
  await page.mouse.click(box.x + mid.x, box.y + mid.y);
  expect(await selectedId(page)).toBe(id);
  await expect(bar).toBeVisible();
  await expect(bar.locator('.pb-name')).toHaveText(/trend/i);

  // Escape closes the bar the way it closes every floating control, by
  // clearing the selection it belongs to; the line itself stays.
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  expect(await selectedId(page)).toBeNull();
  expect(await drawingCount(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('the rail is one tab stop and the arrow keys walk it', async ({ page }) => {
  await openDemo(page);
  const stops = page.locator('#rail .rail__btn[tabindex="0"]');
  await expect(stops, 'a roving tabindex: one stop for the whole rail').toHaveCount(1);
  await stops.focus();
  const focused = () => page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a) return null;
    return {
      id: a.id,
      cls: a.className,
      tools: a.dataset.tools ?? null,
      group: a.dataset.group ?? null,
      inRail: Boolean(a.closest('#rail')),
      inFlyout: Boolean(a.closest('.fly')),
    };
  });

  // The cursor button leads; ArrowDown reaches the first group.
  expect((await focused())?.tools).toBe('');
  await page.keyboard.press('ArrowDown');
  const next = await focused();
  expect(next?.inRail).toBe(true);
  expect(next?.group).toBe('lines');
  // The tab stop moves with the focus, so Tab later leaves from here.
  await expect(stops).toHaveCount(1);
  expect(await stops.evaluate((n) => (n as HTMLElement).dataset.group)).toBe('lines');

  // End and Home reach the redo button and the cursor button.
  await page.keyboard.press('End');
  expect((await focused())?.cls).toContain('rail__btn--chrome');
  await page.keyboard.press('Home');
  expect((await focused())?.tools).toBe('');

  // ArrowRight on a group opens its flyout with focus inside; Escape closes
  // it and returns to the button; Escape again hands focus to the plot.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  const fly = page.locator('.fly[role="menu"]');
  await expect(fly).toBeVisible();
  expect((await focused())?.inFlyout).toBe(true);
  await page.keyboard.press('Escape');
  await expect(fly).toHaveCount(0);
  expect((await focused())?.group).toBe('lines');
  await page.keyboard.press('Escape');
  expect((await focused())?.id).toBe('chart');
});

test('the theme switch flips the shell and keeps the choice, without throwing', async ({ page }) => {
  const errors = watchErrors(page);
  await openDemo(page);
  const shellBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const dark = await shellBg();

  // The switch lives in the shell module; the page's own instance of it is
  // what any button on the toolbar calls, so it is driven there.
  const flip = (url: string) => page.evaluate(async (u) => {
    const ui = await import(u);
    ui.toggleTheme();
    const root = document.documentElement;
    return { name: ui.currentTheme(), attr: root.dataset.theme, scheme: root.style.colorScheme, stored: localStorage.getItem(ui.THEME_KEY) };
  }, url);
  const UI = '/examples/yfinance/src/ui.js';

  expect(await flip(UI)).toEqual({ name: 'light', attr: 'light', scheme: 'light', stored: 'light' });
  const light = await shellBg();
  expect(light, 'the light palette repaints the shell').not.toBe(dark);

  expect(await flip(UI)).toEqual({ name: 'dark', attr: 'dark', scheme: 'dark', stored: 'dark' });
  expect(await shellBg()).toBe(dark);
  expect(errors).toEqual([]);
});

test('replay opens on a picked bar and steps forward one bar', async ({ page }) => {
  const errors = watchErrors(page);
  await openDemo(page);
  await page.locator('#shellbar button', { hasText: 'Replay' }).click();

  // Replay asks for the bar to start from before it starts.
  await expect(page.locator('#replaypick')).toBeVisible();
  await expect(page.locator('#chart')).toHaveClass(/is-picking/);
  const box = await chartBox(page);
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.35);
  await expect(page.locator('#replaybar')).toBeVisible();
  await expect(page.locator('#replaypick')).toBeHidden();

  const state = () => page.evaluate(() => {
    const r = (window as any).__oac.app.replay;
    return r ? (r.state() as { index: number; total: number; subIndex: number; subSteps: number }) : null;
  });
  const s0 = await state();
  expect(s0).not.toBeNull();
  expect(s0!.total).toBeGreaterThan(s0!.index + 1);
  await expect(page.locator('#rp-count')).toHaveText(`${s0!.index + 1} / ${s0!.total}`);

  // The playhead opens on a complete bar, so one step forward is the next bar.
  await page.locator('#rp-fwd').click();
  const s1 = await state();
  expect(s1!.index).toBe(s0!.index + 1);
  await expect(page.locator('#rp-count')).toHaveText(`${s1!.index + 1} / ${s1!.total}`);
  // The series shows the session so far and nothing past the playhead.
  expect(await page.evaluate(() => (window as any).__oac.app.price.getData().length as number)).toBe(s1!.index + 1);
  expect(errors).toEqual([]);
});

test('a symbol the source cannot serve leaves the shell up and says so', async ({ page }) => {
  // Only uncaught exceptions count here: Chromium reports the 502 itself as
  // a console error, and that line is the request failing, not the page.
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await openDemo(page);
  const barsBefore = await page.evaluate(() => (window as any).__oac.app.currentBars.length as number);

  // The symbol box is raised by the toolbar's symbol button; Enter loads.
  await page.locator('#shellbar button', { hasText: 'AAPL' }).click();
  const sym = page.locator('#symbol');
  await expect(sym).toBeFocused();
  await sym.fill('FAIL');
  await sym.press('Enter');

  // The feed gives a gateway failure one retry before it reports, so the
  // readout arrives after a pause. Either the status line or the chart-state
  // card may carry it, depending on which the page wires.
  const readout = () => page.evaluate(() => {
    const card = document.getElementById('chartstate');
    if (card && !card.hidden && card.dataset.state === 'error') {
      return [document.getElementById('cs-title'), document.getElementById('cs-text')].map((n) => n?.textContent ?? '').join(' ').trim();
    }
    const status = document.getElementById('status')?.textContent ?? '';
    return /^error/i.test(status) ? status : '';
  });
  await expect.poll(readout, { timeout: 10_000, message: 'no error readout for FAIL' }).toMatch(/502|upstream|could not load/i);

  // The shell and the last good chart are still there to try again from.
  expect(await page.locator('#shellbar button').count()).toBeGreaterThan(5);
  expect(await page.evaluate(() => Boolean((window as any).__oac.chart))).toBe(true);
  expect(await page.evaluate(() => (window as any).__oac.app.currentBars.length as number)).toBe(barsBefore);
  expect(pageErrors).toEqual([]);
});
