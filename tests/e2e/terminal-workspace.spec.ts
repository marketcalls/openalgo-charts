import { test, expect, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, totalmem } from 'node:os';

/** Every widget on the page has a chart canvas with painted candles (not merely one of them). */
async function candlesPainted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const widgets = [...document.querySelectorAll<HTMLElement>('.oac-widget')];
    return widgets.length > 0 && widgets.every(widget =>
      [...widget.querySelectorAll<HTMLCanvasElement>('.oac-chart canvas')].some(canvas => {
        const context = canvas.getContext('2d');
        if (!context || !canvas.width || !canvas.height) return false;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] > 128 && Math.max(pixels[index], pixels[index + 1], pixels[index + 2])
            - Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) > 60) count++;
        }
        return count > 100;
      }));
  });
}

test('native demo keeps panels on clicks, applies presets and restores added panels', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/examples/terminal/index.html');
  await expect(page.locator('.oac-widget')).toHaveCount(1);
  await expect.poll(() => candlesPainted(page)).toBe(true);
  await page.locator('.oac-dock-panel-header').first().click();
  await expect(page.locator('.oac-dock-panel')).toHaveCount(2);
  const source = await page.locator('.oac-dock-panel-header').first().boundingBox();
  const target = await page.locator('.oac-dock-panel-header').nth(1).boundingBox();
  if (!source || !target) throw new Error('terminal headers have no measured bounds');
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.oac-dock-tab')).toHaveCount(2);
  await page.locator('#preset-selector').selectOption('two-charts-dom');
  await expect(page.locator('.oac-widget')).toHaveCount(2);
  await expect(page.locator('.oac-dock-panel')).toHaveCount(3);
  await page.locator('#btn-depth').click();
  await expect(page.locator('#btn-depth')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.oac-dom-row').count()).toBeGreaterThan(10);
  await expect.poll(() => page.locator('.oac-dom-row').count()).toBeLessThan(80);
  await page.screenshot({ path: info.outputPath('terminal-depth.png') });
  await page.locator('#btn-depth').click();
  await page.locator('#btn-add-chart').click();
  await expect(page.locator('.oac-widget')).toHaveCount(3);
  await page.reload();
  await expect(page.locator('.oac-widget')).toHaveCount(3);
  await expect(page.locator('.oac-dock-panel')).toHaveCount(4);
  await expect(page.getByText(/Panel not found/)).toHaveCount(0);
  await page.locator('#preset-selector').selectOption('scalper');
  await expect(page.locator('.oac-dock-panel')).toHaveCount(3);
  await page.locator('#preset-selector').selectOption('order-flow');
  await expect(page.locator('.oac-dock-tab')).toHaveCount(3);
  await page.locator('#preset-selector').selectOption('analysis');
  await expect(page.locator('.oac-widget')).toHaveCount(4);
  await expect.poll(() => candlesPainted(page)).toBe(true);
  await page.screenshot({ path: info.outputPath('terminal.png') });
  expect(errors).toEqual([]);
});

test('a plain widget fetches terminal tools only after its loader is called', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/examples/dockview/index.html');
  await expect(page.locator('.oac-widget')).toHaveCount(3);
  expect(requests.filter(url => /widget\.terminal-.*\.mjs/.test(url))).toEqual([]);
  await page.evaluate(async () => {
    const file = '../../dist/openalgo-charts.widget.mjs';
    const widget = await import(file) as { loadTerminal(): Promise<unknown> };
    await widget.loadTerminal();
  });
  expect(requests.filter(url => /widget\.terminal-.*\.mjs/.test(url))).toHaveLength(1);
  expect(requests.filter(url => /widget\.trading-panels-.*\.mjs/.test(url))).toHaveLength(0);
  await page.evaluate(async () => {
    const file = '../../dist/openalgo-charts.widget.mjs';
    const widget = await import(file) as { loadTerminal(): Promise<{ loadTradingPanels(): Promise<unknown> }> };
    await (await widget.loadTerminal()).loadTradingPanels();
  });
  expect(requests.filter(url => /widget\.trading-panels-.*\.mjs/.test(url))).toHaveLength(1);
  expect(requests.filter(url => /openalgo-charts\.trade\.mjs/.test(url))).toHaveLength(0);
});

test('chart-local tools open independent depth, bracket tickets, order books and watchlists', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.goto('/examples/terminal/index.html');
  await page.locator('#btn-add-chart').click();
  const tools = page.getByRole('toolbar', { name: 'Chart tools' }).nth(1);
  await tools.getByRole('button', { name: 'Depth', exact: true }).click();
  await expect(page.getByText('DOM BANKNIFTY', { exact: true })).toHaveCount(1);
  await tools.getByRole('button', { name: 'Trade', exact: true }).click();
  const ticket = page.locator('.oac-order-ticket');
  await expect(ticket.locator('strong')).toHaveText('BANKNIFTY');
  await ticket.getByRole('checkbox', { name: 'Bracket order' }).check();
  await ticket.getByRole('spinbutton', { name: 'Stop loss' }).fill('48000');
  await ticket.getByRole('spinbutton', { name: 'Take profit' }).fill('49000');
  await ticket.getByRole('button', { name: 'Buy', exact: true }).click();
  await expect(ticket.locator('[data-terminal-status]')).toHaveText('Submitted; awaiting broker status.');
  await expect(page.getByText(/BANKNIFTY SELL 1 @ 49000 \/ working/)).toHaveCount(1);
  await tools.getByRole('button', { name: 'Watchlist', exact: true }).click();
  await page.locator('.oac-watchlist__open').filter({ hasText: 'TCS' }).click();
  await expect(ticket.locator('strong')).toHaveText('TCS');
  await expect(page.getByText('DOM TCS', { exact: true })).toHaveCount(1);
  await expect(page.getByText('NIFTY (5m)', { exact: true })).toHaveCount(1);
  await expect.poll(() => page.locator('.oac-dom-ladder-container').evaluateAll(containers => containers.every(container => {
    const viewport = container.getBoundingClientRect();
    return [...container.querySelectorAll('.oac-dom-row')].some(row => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    });
  }))).toBe(true);
  await page.screenshot({ path: info.outputPath('terminal-trading.png') });
  await page.reload();
  await expect(page.locator('.oac-order-ticket strong')).toHaveText('TCS');
  await expect(page.locator('.oac-watchlist__open')).toHaveCount(5);
  expect(errors).toEqual([]);
});

test('a deep ladder reuses visible nodes during rapid depth updates', async ({ page }, info) => {
  await page.goto('/examples/terminal/index.html');
  await expect(page.locator('.oac-widget')).toHaveCount(1);
  const result = await page.evaluate(async () => {
    const file = '../../dist/openalgo-charts.widget.mjs';
    const { loadTerminal } = await import(file);
    const { StandaloneDomLadder } = await loadTerminal();
    const depth = { ltp: 1000,
      bids: Array.from({ length: 1000 }, (_, index) => ({ price: 999 - index, qty: 100 })),
      asks: Array.from({ length: 1000 }, (_, index) => ({ price: 1001 + index, qty: 200 })),
    };
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:50px auto auto 10px;width:400px;height:600px;z-index:1000';
    document.body.appendChild(host);
    const ladder = new StandaloneDomLadder({ symbol: 'DEPTH', tickSize: 1, depth });
    host.appendChild(ladder.element);
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    await frame();
    await frame();
    const rows = [...host.querySelectorAll('.oac-dom-row')];
    const times: number[] = [];
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => original.call(window, time => {
      const start = performance.now();
      callback(time);
      times.push(performance.now() - start);
    });
    try {
      for (let batch = 0; batch < 10; batch++) {
        for (let index = 0; index < 200; index++) ladder.setDepth(depth);
        await frame();
      }
    } finally { window.requestAnimationFrame = original; }
    const current = [...host.querySelectorAll('.oac-dom-row')];
    const reused = rows.length === current.length && rows.every((row, index) => row === current[index]);
    ladder.destroy();
    host.remove();
    return { levels: 2000, snapshots: 2000, visibleRows: rows.length, reused,
      callbackMs: times.filter(time => time > 0.05).sort((a, b) => a - b) };
  });
  expect(result.visibleRows).toBeLessThan(50);
  expect(result.reused).toBe(true);
  await info.attach('terminal-performance', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('Dockview demo loads offline and restores instruments and added charts', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/examples/dockview/index.html');
  await expect(page.locator('.oac-widget')).toHaveCount(3);
  await expect.poll(() => candlesPainted(page)).toBe(true);
  await page.locator('.oac-sym__input').first().fill('TCS');
  await page.locator('.oac-symbol-picker__row').filter({ hasText: 'NSE:TCS' }).first().click();
  await expect(page.getByText('TCS (5m)', { exact: true })).toHaveCount(1);
  await page.locator('#btn-add').click();
  await expect(page.getByRole('tab')).toHaveCount(4);
  await page.reload();
  await expect(page.getByRole('tab')).toHaveCount(4);
  await expect.poll(() => candlesPainted(page)).toBe(true);
  await expect(page.getByText('TCS (5m)', { exact: true })).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('dockview.png') });
  expect(errors).toEqual([]);
});

test('extended terminal session keeps resources bounded under sustained depth', async ({ page, browserName }, info) => {
  test.skip(!process.env.TERMINAL_SOAK_MS || browserName !== 'chromium', 'Opt-in measured workload');
  const duration = Math.max(10000, Math.min(3600000, Number(process.env.TERMINAL_SOAK_MS) || 180000));
  test.setTimeout(duration + 90000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/e2e/fixtures/terminal-soak.html');
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
  await session.send('HeapProfiler.collectGarbage'); const empty = await metrics();
  const setup = await page.evaluate(async () => {
    const entry = '/dist/openalgo-charts.widget.mjs', sample = '/examples/sample-feed.js';
    const { loadTerminal } = await import(entry);
    const { createTerminalWorkspace, createChartPanel, createStandaloneDomPanel } = await loadTerminal();
    const { SampleMarketDataFeed, SAMPLE_NOW } = await import(sample);
    const feed = new SampleMarketDataFeed('/examples/dockview/data/');
    const workspace = createTerminalWorkspace(document.getElementById('workspace')!, { persist: false });
    await workspace.ready;
    const charts = Array.from({ length: 8 }, (_, i) => createChartPanel({ id: `chart${i}`, symbol: 'NIFTY', interval: '5m', feed,
      widgetOptions: { now: () => SAMPLE_NOW } }));
    const depth = (qty: number) => ({ ltp: 1000,
      bids: Array.from({ length: 1000 }, (_, i) => ({ price: 999 - i, qty })),
      asks: Array.from({ length: 1000 }, (_, i) => ({ price: 1001 + i, qty: qty * 2 })) });
    const ladders = Array.from({ length: 8 }, (_, i) => createStandaloneDomPanel({ id: `depth${i}`, symbol: 'NIFTY', tickSize: 1, depth: depth(1) }));
    for (let i = 0; i < 8; i++) { workspace.addPanel(charts[i]); workspace.addPanel(ladders[i]); }
    const leaf = (panelId: string) => ({ type: 'panel', id: `node-${panelId}`, panelId });
    const split = (a: unknown, b: unknown, id: string, direction = 'horizontal') => ({ type: 'split', id, direction, ratio: 0.5, children: [a, b] });
    const pairs = charts.map((chart, i) => split(leaf(chart.id), leaf(ladders[i].id), `pair${i}`));
    const rows = Array.from({ length: 4 }, (_, i) => split(pairs[i * 2], pairs[i * 2 + 1], `row${i}`));
    workspace.setLayout(split(split(rows[0], rows[1], 'top', 'vertical'), split(rows[2], rows[3], 'bottom', 'vertical'), 'all', 'vertical'));
    let snapshots = 0, previous = performance.now(), raf = 0;
    const intervals: number[] = [], responses: number[] = [];
    const probe = document.createElement('button'); probe.textContent = 'Response probe'; probe.style.cssText = 'position:fixed;top:0;left:0;z-index:10000';
    document.body.appendChild(probe); let clickedAt = 0;
    probe.onclick = () => requestAnimationFrame(() => responses.push(performance.now() - clickedAt));
    const frames = (time: number) => { intervals.push(time - previous); previous = time; raf = requestAnimationFrame(frames); };
    raf = requestAnimationFrame(frames);
    const timer = setInterval(() => {
      snapshots++; const snapshot = depth(1 + snapshots % 1000);
      for (const ladder of ladders) ladder.setDepth(snapshot);
      // Repaint one candle per chart to include the chart render path.
      for (const chart of charts) {
        const widget = chart.widget(), series = widget?.chart.primarySeries();
        const bars = widget?.chart.primaryBars();
        if (series && bars?.length) {
          const bar = bars[bars.length - 1];
          if (bar) series.update({ ...bar, close: bar.close + (snapshots % 2 ? 0.05 : -0.05) });
        }
      }
    }, 50);
    const responseTimer = setInterval(() => { clickedAt = performance.now(); probe.click(); }, 1000);
    const state = { workspace, charts, ladders, intervals, responses, snapshots: () => snapshots,
      stop() { clearInterval(timer); clearInterval(responseTimer); cancelAnimationFrame(raf); workspace.destroy(); probe.remove(); } };
    (window as unknown as { terminalSoak: typeof state }).terminalSoak = state;
    return { charts: 8, ladders: 8, depthLevelsPerLadder: 2000, updatesPerSecond: 20 };
  });
  await expect(page.locator('.oac-chart')).toHaveCount(8);
  await expect.poll(() => candlesPainted(page)).toBe(true);
  await page.waitForTimeout(5000); await session.send('HeapProfiler.collectGarbage'); const baseline = await metrics();
  const samples: Record<string, number>[] = [];
  let remaining = duration;
  while (remaining > 0) {
    const wait = Math.min(60000, remaining); await page.waitForTimeout(wait); remaining -= wait;
    await session.send('HeapProfiler.collectGarbage'); samples.push(await metrics());
  }
  const workload = await page.evaluate(() => {
    const state = (window as unknown as { terminalSoak: { charts: { widget(): { chart: { primaryBars(): readonly unknown[] } } }[]; intervals: number[]; responses: number[]; snapshots(): number; stop(): void } }).terminalSoak;
    const percentile = (values: number[], quantile: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * quantile)];
    const rows = document.querySelectorAll('.oac-dom-row').length;
    const result = { barsPerChart: state.charts.map(chart => chart.widget().chart.primaryBars().length), snapshotsPerLadder: state.snapshots(), visibleRows: rows, frameP95Ms: percentile(state.intervals.slice(300), 0.95),
      responseP95Ms: percentile(state.responses.slice(5), 0.95), responseMaxMs: Math.max(...state.responses) };
    state.stop(); delete (window as unknown as { terminalSoak?: unknown }).terminalSoak;
    return result;
  });
  await page.waitForTimeout(1000); await session.send('HeapProfiler.collectGarbage'); const teardown = await metrics();
  const last = samples[samples.length - 1];
  const report = { date: new Date().toISOString(), platform: platform(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), browser: page.context().browser()!.version(), durationMs: duration, viewport: '1920x1080',
    ...setup, ...workload, rendererTaskSeconds: last.TaskDuration - baseline.TaskDuration,
    rendererTaskPercent: 100 * (last.TaskDuration - baseline.TaskDuration) / (last.Timestamp - baseline.Timestamp),
    baselineHeapBytes: baseline.JSHeapUsedSize, sampleHeapBytes: samples.map(sample => sample.JSHeapUsedSize),
    heapGrowthBytes: last.JSHeapUsedSize - baseline.JSHeapUsedSize, teardownHeapBytes: teardown.JSHeapUsedSize,
    emptyHeapBytes: empty.JSHeapUsedSize, baselineNodes: baseline.Nodes, sampleNodes: samples.map(sample => sample.Nodes), teardownNodes: teardown.Nodes,
    errors, notes: 'Counters include the warm-up. Synthetic DOM clicks; renderer main-thread task time, not whole-machine CPU. Forced GC before each memory sample can affect latency. No comparison baseline.' };
  await writeFile(info.outputPath('terminal-soak.json'), JSON.stringify(report, null, 2));
  await info.attach('terminal-soak', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(errors).toEqual([]); expect(workload.barsPerChart.every(count => count > 0)).toBe(true); expect(workload.visibleRows).toBeLessThan(400);
  await expect(page.locator('.oac-widget')).toHaveCount(0);
  expect(Math.max(...samples.map(sample => sample.Nodes)) - baseline.Nodes).toBeLessThan(1000);
  expect(last.JSHeapUsedSize - baseline.JSHeapUsedSize).toBeLessThan(16 * 1024 * 1024);
});
