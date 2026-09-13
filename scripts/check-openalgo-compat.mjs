/**
 * Exercise the actual OpenAlgo /trading app with its installed Charts package.
 * Run only against an isolated OpenAlgo worktree with its own node_modules:
 * node scripts/check-openalgo-compat.mjs --frontend /tmp/openalgo/frontend
 * Add --objects true only when the host includes the shared Objects integration.
 * Add --navigation true to validate the wheel routing introduced in 2.1.8.
 * Add --branding true to validate corner branding and optional watermark settings.
 *
 * No backend is started. Vite proxies are removed and every API/WS is mocked.
 * The app source is unchanged; an entry wrapper records terminal instances so
 * assertions can inspect the real series, drawings, feed and replay state.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[i + 1]]);
  return pairs;
}, []));
assert(args.frontend, '--frontend must name an isolated OpenAlgo frontend');
const frontend = resolve(args.frontend);
assert((await lstat(join(frontend, '..', '.git'))).isFile(), 'Use a linked OpenAlgo git worktree');
assert(!(await lstat(join(frontend, 'node_modules'))).isSymbolicLink(), 'Use copied dependencies in an isolated checkout');
const requireApp = createRequire(join(frontend, 'package.json'));
const { createServer, loadConfigFromFile } = await import(pathToFileURL(requireApp.resolve('vite')).href);
const chartsManifest = JSON.parse(await readFile(join(frontend, 'node_modules/openalgo-charts/package.json'), 'utf8'));
const cache = await mkdtemp(join(tmpdir(), 'openalgo-compat-'));
const report = { label: args.label ?? chartsManifest.version, chartsVersion: chartsManifest.version, checks: [], requests: [], websocket: [], pageErrors: [], consoleErrors: [], blocked: [] };
report.distHashes = Object.fromEntries(await Promise.all(['openalgo-charts.mjs', 'openalgo-charts.profile.mjs', 'openalgo-charts.indicators.mjs', 'openalgo-charts.draw.mjs', 'openalgo-charts.transform.mjs'].map(async (file) => [file, createHash('sha256').update(await readFile(join(frontend, 'node_modules/openalgo-charts/dist', file))).digest('hex')])));
report.wireIdentity = args['legacy-topic'] ? 'top-level with legacy topic workaround' : 'canonical top-level only';
const fixedNow = Date.parse('2026-09-10T06:32:00Z');
const symbols = [
  { symbol: 'BHEL', exchange: 'NSE', name: 'Bharat Heavy Electricals', lotsize: 1, tick_size: 0.05, freeze_qty: 100000 },
  { symbol: 'NIFTY29SEP26FUT', exchange: 'NFO', name: 'Nifty Futures', lotsize: 65, tick_size: 0.05, freeze_qty: 1800 },
  { symbol: 'NIFTY', exchange: 'NSE_INDEX', name: 'Nifty 50', lotsize: 1, tick_size: 0.0005 },
];
function history(body) {
  const interval = body.interval;
  const seconds = /^\d+[mh]$/.test(interval)
    ? Number(interval.slice(0, -1)) * (interval.endsWith('h') ? 3600 : 60)
    : 86400;
  const rows = [];
  for (let day = 8; day <= 10; day++) {
    const start = Date.parse(`2026-09-${day.toString().padStart(2, '0')}T03:45:00Z`) / 1000;
    const end = seconds === 86400 ? start : Math.min(start + 375 * 60 - seconds, Math.floor(fixedNow / 1000 / seconds) * seconds);
    for (let timestamp = start; timestamp <= end; timestamp += seconds) {
      const base = 100 + Math.sin(rows.length / 7) * 5;
      rows.push({ timestamp, open: base, high: base + 2, low: base - 1, close: base + 0.5, volume: 1000 + rows.length * 10 });
      if (seconds === 86400) break;
    }
  }
  return rows;
}
let orderCounter = 0;
let mockOrders = [];
let mockPositions = [];
let analyzer = false;
let historyVolumeBoost = 0;
const config = (await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(frontend, 'vite.config.ts'))).config;
const server = await createServer({
  ...config, configFile: false, root: frontend, cacheDir: cache, logLevel: 'error',
  server: { host: '127.0.0.1', port: 19000 + Math.floor(Math.random() * 10000), strictPort: false, hmr: false, proxy: {} },
  plugins: [...config.plugins, {
    name: 'openalgo-compat-observer',
    transformIndexHtml(html) { return html.replace('src="/src/main.tsx"', 'src="/openalgo-compat-entry.ts"'); },
    resolveId(id) { if (id === '/openalgo-compat-entry.ts') return '\0openalgo-compat-entry'; },
    load(id) {
      if (id !== '\0openalgo-compat-entry') return;
      return `import { TradingTerminal } from '/src/lib/trading/terminal.ts';
        window.__compatTerminals = [];
        const init = TradingTerminal.prototype.init;
        TradingTerminal.prototype.init = function(...args) {
          window.__compatTerminals.push(this);
          return init.apply(this, args);
        };
        import('/src/main.tsx');`;
    },
  }],
});
let browser;
let page;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  page = await context.newPage();
  await page.clock.setFixedTime(new Date(fixedNow));
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      report.blocked.push(request.url());
      return route.abort();
    }
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/custom-indicators/index.json') return route.fulfill({ json: [{ file: 'compat.js', mtime: 1 }] });
    if (path === '/custom-indicators/compat.js') return route.fulfill({ contentType: 'text/javascript', body: `export default function({registerIndicator}) {
      registerIndicator({id:'compat-close',name:'Compatibility Close',category:'Custom',placement:'onchart',inputs:[],plots:[{key:'close',type:'line'}],calc(bars) {
        window.__compatCustomCalls = (window.__compatCustomCalls || 0) + 1;
        return {close:bars.map(bar=>bar.close)};
      }});
    }` });
    if (!path.startsWith('/api/') && !path.startsWith('/auth/') && !path.startsWith('/socket.io')) return route.continue();
    let body = {};
    try { body = request.postDataJSON() ?? {}; } catch { /* transport body */ }
    report.requests.push({ path, method: request.method(), body });
    let json = { status: 'success', data: [] };
    if (path === '/auth/session-status') json = { status: 'success', logged_in: true, authenticated: true, broker: 'fixture', user: 'compat', api_key: 'synthetic-only', active_sessions: 1 };
    else if (path === '/auth/analyzer-mode') json = { status: 'success', data: { analyze_mode: analyzer } };
    else if (path === '/auth/csrf-token') json = { csrf_token: 'synthetic-csrf' };
    else if (path === '/api/broker/capabilities') json = { status: 'success', data: { broker_name: 'Fixture', broker_type: 'IN_stock', supported_exchanges: ['NSE', 'NFO', 'NSE_INDEX'], leverage_config: false } };
    else if (path === '/api/websocket/apikey') json = { status: 'success', api_key: 'synthetic-only' };
    else if (path === '/api/websocket/config') json = { status: 'success', websocket_url: 'ws://fixture.invalid/feed' };
    else if (path === '/api/v1/intervals') json.data = { minutes: ['1m', '5m', '15m', '30m'], hours: ['1h'], days: ['D'], weeks: ['W'], months: ['M'] };
    else if (path === '/api/v1/search') json.data = symbols.filter((symbol) => symbol.symbol.includes(body.query ?? '') && (!body.exchange || symbol.exchange === body.exchange));
    else if (path === '/api/v1/symbol') json.data = symbols.find((symbol) => symbol.symbol === body.symbol && symbol.exchange === body.exchange);
    else if (path === '/api/v1/history') json.data = history(body).map((bar) => ({ ...bar, volume: bar.volume + historyVolumeBoost }));
    else if (path === '/api/v1/quotes') json.data = { ltp: 111, bid: 110.95, ask: 111.05, volume: 15000, prev_close: 99 };
    else if (path === '/api/v1/depth') json.data = { ltp: 111, bids: [{ price: 110.95, quantity: 10 }], asks: [{ price: 111.05, quantity: 20 }], volume: 15000, prev_close: 99 };
    else if (path === '/api/v1/analyzer') json.data = { analyze_mode: analyzer };
    else if (path === '/api/v1/orderbook') json.data = { orders: mockOrders };
    else if (path === '/api/v1/positionbook') json.data = mockPositions;
    else if (path === '/api/v1/placeorder') json = { status: 'success', orderid: `fixture-${++orderCounter}`, mode: analyzer ? 'analyze' : 'live' };
    else if (path === '/api/v1/modifyorder') {
      mockOrders = mockOrders.map((order) => order.orderid === body.orderid ? { ...order, ...body } : order);
      json = { status: 'success', orderid: body.orderid };
    } else if (path === '/api/v1/cancelorder') {
      mockOrders = mockOrders.filter((order) => order.orderid !== body.orderid);
      json = { status: 'success', orderid: body.orderid };
    }
    else if (path.startsWith('/socket.io')) return route.fulfill({ status: 503, body: 'Socket.IO disabled in fixture' });
    return route.fulfill({ status: 200, json });
  });
  const sockets = [];
  await context.routeWebSocket('**/*', (socket) => {
    sockets.push(socket);
    socket.onMessage((wire) => {
      let message;
      try { message = JSON.parse(wire.toString()); } catch { return; }
      report.websocket.push(message);
      if (message.action === 'authenticate') socket.send(JSON.stringify({ type: 'auth', status: 'success' }));
      else if (message.action === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      else socket.send(JSON.stringify({ type: message.action, status: 'success' }));
    });
  });
  const check = async (name, fn) => { await fn(); report.checks.push(name); console.log(`PASS ${name}`); };
  const terminal = async (fn, arg) => page.evaluate(({ source, arg }) => {
    const t = window.__compatTerminals?.findLast((item) => !item.destroyed && item.chart);
    if (!t) throw new Error('No active terminal');
    return (0, eval)(`(${source})`)(t, arg);
  }, { source: fn.toString(), arg });
  // Toolbar setters keep the old chart visible while the next history load runs.
  // Wait for that chart's context before driving Replay or another interaction.
  const waitReady = () => page.waitForFunction(() => window.__compatTerminals?.some(t => {
    const context = t.chart?.getDataContext();
    return !t.destroyed && t.price?.getData().length > 0 && context?.symbol === t.sym?.symbol
      && context?.exchange === t.sym?.exchange && context?.interval === t.interval;
  }));
  const waitDialogClosed = () => page.waitForFunction(() => !document.querySelector('[role="dialog"]')
    && getComputedStyle(document.body).pointerEvents !== 'none');
  const sendDepth = async (symbol, exchange, ltp) => {
    for (const socket of sockets) {
      try { socket.send(JSON.stringify({ type: 'market_data', symbol, exchange, ...(args['legacy-topic'] ? { topic: `${symbol}.${exchange}` } : {}), mode: 3, data: {
        ltp, timestamp: fixedNow, depth: { buy: [{ price: ltp - 0.05, quantity: 10, orders: 2 }], sell: [{ price: ltp + 0.05, quantity: 20, orders: 3 }] },
      } })); } catch { /* a StrictMode terminal was destroyed */ }
    }
    await page.waitForFunction((price) => window.__compatTerminals?.some((t) => !t.destroyed && t.lastLtp === price), ltp);
  };
  await page.goto(`${origin}/trading`);
  await check('unchanged /trading mounts real chart', async () => {
    await waitReady();
    assert(await page.locator('canvas').count() > 0);
    assert.equal(await terminal((t) => t.sym.symbol), 'BHEL');
    assert(report.requests.some((r) => r.path === '/api/v1/history' && r.body.interval === '5m'));
  });
  if (args.branding === 'true') {
    await check('host branding links follow disabled and custom chart branding', async () => {
      const mark = await terminal(t => t.chart.brandingOptions());
      assert(mark && mark.href === 'https://openalgo.in');
      const link = page.getByRole('link', { name: mark.label, exact: true });
      await link.waitFor({ state: 'visible' });
      await terminal(t => t.chart.setBranding(false));
      await link.waitFor({ state: 'detached' });
      await terminal(t => t.chart.setBranding({ label: 'Research charts', href: 'https://example.com/research' }));
      const custom = page.getByRole('link', { name: 'Research charts', exact: true });
      await custom.waitFor({ state: 'visible' });
      assert.equal(await custom.getAttribute('href'), 'https://example.com/research');
      await terminal(t => t.chart.setBranding(true));
      await link.waitFor({ state: 'visible' });
      assert.equal(orderCounter, 0);
    });
    await check('optional watermark uses actual settings, persistence and current symbol context', async () => {
      assert.equal(await terminal(t => t.chart.watermarkOptions().visible), false);
      const openSettings = () => terminal(async t => t.cb.onChartSettings(await t.chartSettings()));
      await openSettings();
      await page.getByRole('button', { name: 'Appearance', exact: true }).click();
      const show = page.getByRole('checkbox', { name: 'Show watermark', exact: true });
      assert.equal(await show.isChecked(), false);
      await show.check();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await waitDialogClosed();
      assert.equal(await terminal(t => t.chart.watermarkOptions().visible), false);
      await openSettings();
      await page.getByRole('button', { name: 'Appearance', exact: true }).click();
      await show.check();
      await page.getByRole('button', { name: 'Ok', exact: true }).click();
      await waitDialogClosed();
      await page.waitForFunction(() => window.__compatTerminals.some(t => !t.destroyed && t.chart?.watermarkOptions().visible));
      assert.match(await terminal(t => t.chart.exportSVG()), /BHEL/);
      await page.reload();
      await waitReady();
      assert.equal(await terminal(t => t.chart.watermarkOptions().visible), true);
      await terminal(async (t, symbol) => t.loadSymbol(symbol), symbols[1]);
      await waitReady();
      assert.match(await terminal(t => t.chart.exportSVG()), /NIFTY29SEP26FUT/);
      await terminal(t => t.applyChartSettings({ 'watermark.text': 'Research' }));
      await terminal(t => t.setInterval('15m'));
      await waitReady();
      assert.match(await terminal(t => t.chart.exportSVG()), /Research/);
      await terminal(t => { t.startReplay(); t.commitReplayPick(); });
      await page.waitForFunction(() => window.__compatTerminals.some(t => !t.destroyed && t.replayState() !== null));
      await terminal(t => t.applyChartSettings({ 'watermark.visible': false }));
      assert.match(await terminal(t => t.chart.exportSVG()), /Replay/);
      await terminal(t => t.stopReplay());
      await terminal(t => t.applyChartSettings({ 'watermark.text': '', 'watermark.visible': false }));
      await terminal(async (t, symbol) => { await t.loadSymbol(symbol); t.setInterval('5m'); }, symbols[0]);
      await waitReady();
      assert.equal(await terminal(t => t.chart.watermarkOptions().visible), false);
      assert.equal(orderCounter, 0);
    });
  }
  if (args.navigation === 'true') {
    await check('trackpad, horizontal wheel and price-axis scaling retain host order authority', async () => {
      const before = await terminal(t => ({ range: t.chart.getVisibleLogicalRange(), spacing: t.chart.timeScale.barSpacing }));
      const orderCount = orderCounter;
      const wheel = (t, input) => {
        const r = t.container.getBoundingClientRect();
        t.container.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true,
          clientX: r.left + (input.axis ? r.width - 5 : r.width / 2), clientY: r.top + r.height * 0.4,
          deltaX: input.x, deltaY: input.y,
        }));
      };
      await terminal(wheel, { x: 0, y: -1 });
      await page.waitForTimeout(450);
      const tiny = await terminal(t => t.chart.timeScale.barSpacing);
      assert(Math.abs(tiny / before.spacing - 1.0009535561) < 1e-7);
      const from = await terminal(t => t.chart.getVisibleLogicalRange().from);
      await terminal(wheel, { x: 60, y: 0 });
      await page.waitForTimeout(450);
      assert.equal(await terminal(t => t.chart.timeScale.barSpacing), tiny);
      assert((await terminal(t => t.chart.getVisibleLogicalRange().from)) > from);
      const scale = await terminal(t => t.price.priceScale().priceRange());
      await terminal(wheel, { x: 0, y: -100, axis: true });
      await page.waitForTimeout(100);
      const scaled = await terminal(t => t.price.priceScale().priceRange());
      assert.equal(await terminal(t => t.chart.timeScale.barSpacing), tiny);
      assert(scaled.max - scaled.min < scale.max - scale.min);
      assert.equal(orderCounter, orderCount);
      await terminal((t, range) => { t.chart.setAutoScale(true); t.chart.setVisibleLogicalRange(range); }, before.range);
    });
  }
  await check('depth-only subscription updates seeded candle and bid/ask', async () => {
    const before = await terminal((t) => ({ n: t.rawBars.length, bar: t.rawBars.at(-1) }));
    await sendDepth('BHEL', 'NSE', 111.25);
    const after = await terminal((t) => ({ n: t.rawBars.length, bar: t.price.getData().at(-1), depth: t.depthActive }));
    assert.equal(after.n, before.n);
    assert.equal(after.bar.time, before.bar.time);
    assert.equal(after.bar.open, before.bar.open);
    assert.equal(after.bar.close, 111.25);
    assert.equal(after.bar.volume, before.bar.volume);
    assert.equal(after.depth, true);
    assert(report.websocket.some((m) => m.action === 'subscribe' && [3, 'Depth'].includes(m.mode)));
    assert(!report.websocket.some((m) => m.action === 'subscribe' && [1, 'LTP'].includes(m.mode) && (m.symbol === 'BHEL' || m.symbols?.some((s) => s.symbol === 'BHEL'))));
  });
  await check('history reconciliation repairs volume without replacing the live price', async () => {
    const before = await terminal((t) => ({ first: t.rawBars[0], last: t.rawBars.at(-1) }));
    historyVolumeBoost = 7000;
    await terminal((t) => t.runReconcile());
    const after = await terminal((t) => ({ first: t.rawBars[0], last: t.rawBars.at(-1) }));
    assert.equal(after.first.volume, before.first.volume + 7000);
    assert.equal(after.last.volume, before.last.volume + 7000);
    assert.equal(after.last.close, before.last.close);
    await sendDepth('BHEL', 'NSE', 112);
    assert.equal(await terminal((t) => t.rawBars.at(-1).volume), after.last.volume);
  });
  await check('disarmed chart click opens ticket without order; armed path sends derivative units', async () => {
    await terminal(async (t, symbol) => { await t.loadSymbol(symbol); t.setQty(2); t.setArmed(false); t.placeCtx('BUY', 'MARKET'); }, symbols[1]);
    await page.getByRole('dialog').waitFor();
    assert.equal(orderCounter, 0);
    await page.keyboard.press('Escape');
    await page.locator('[data-slot="dialog-overlay"]').waitFor({ state: 'detached' });
    await waitDialogClosed();
    await waitReady();
    await terminal((t) => { t.setArmed(true); t.placeCtx('BUY', 'MARKET'); });
    await page.waitForFunction(() => document.body.innerText.includes('fixture-1'));
    const order = report.requests.findLast((r) => r.path === '/api/v1/placeorder').body;
    assert.equal(order.quantity, 130);
    assert.equal(order.symbol, 'NIFTY29SEP26FUT');
    assert.equal(order.exchange, 'NFO');
    assert.equal(order.product, 'MIS');
    assert.equal(order.action, 'BUY');
    assert.equal(order.pricetype, 'MARKET');
    assert.equal(order.mode, undefined);
  });
  await check('mode mismatch refuses the ticket before submitting an order', async () => {
    analyzer = true;
    await page.clock.setFixedTime(new Date(fixedNow + 1));
    const count = orderCounter;
    const refusal = await terminal(async (t) => {
      await t.trade.getServerMode(0);
      try {
        await t.placeTicket({ symbol: t.sym.symbol, exchange: t.sym.exchange, action: 'BUY', pricetype: 'MARKET', product: 'MIS', quantity: 65 });
        return null;
      } catch (error) { return error.message; }
    });
    assert.match(refusal, /mode/);
    assert.equal(orderCounter, count);
    analyzer = false;
    await page.clock.setFixedTime(new Date(fixedNow + 6000));
    await terminal((t) => t.trade.getServerMode(0));
  });
  await check('WS order update and canvas drag/cancel preserve stop-limit context', async () => {
    mockOrders = [{ orderid: 'fixture-open', symbol: symbols[1].symbol, exchange: 'NFO', action: 'BUY', pricetype: 'SL', product: 'NRML', quantity: '130', price: '102.5', trigger_price: '102', order_status: 'trigger pending', filled_quantity: '0' }];
    mockPositions = [{ symbol: symbols[1].symbol, exchange: 'NFO', product: 'NRML', quantity: '-65', average_price: '99' }];
    for (const socket of sockets) {
      try { socket.send(JSON.stringify({ ...mockOrders[0], type: 'order_update', mode: 'live' })); } catch { /* closed StrictMode socket */ }
    }
    await page.waitForFunction(() => window.__compatTerminals.some((t) => !t.destroyed && t.orderLines.get('fixture-open')?.order.qty === 130));
    await terminal((t) => t.pollBook());
    await page.waitForFunction(() => window.__compatTerminals.some((t) => !t.destroyed && t.orderLines.get('fixture-open')?.line._group));
    const points = await terminal((t) => {
      const box = t.container.getBoundingClientRect();
      const group = t.orderLines.get('fixture-open').line._group;
      return { x: box.x + (group.x0 + group.closeX0) / 2, y: box.y + t.chart.priceToCoordinate(102, 0), toY: box.y + t.chart.priceToCoordinate(103, 0) };
    });
    report.dragPoints = points;
    report.dragTarget = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 500), points);
    await page.mouse.move(points.x, points.y);
    await page.mouse.down();
    await page.mouse.move(points.x, points.toY, { steps: 5 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__compatTerminals.some((t) => !t.destroyed && t.orderLines.get('fixture-open')?.order.triggerPrice !== 102), null, { timeout: 3000 });
    const modify = report.requests.findLast((r) => r.path === '/api/v1/modifyorder').body;
    assert(Math.abs(modify.trigger_price - 103) <= 0.1);
    assert(Math.abs(modify.trigger_price * 20 - Math.round(modify.trigger_price * 20)) < 1e-8);
    assert.equal(modify.price, 102.5);
    assert.equal(modify.quantity, 130);
    assert.equal(modify.product, 'NRML');
    assert.equal(modify.exchange, 'NFO');
    const close = await terminal((t) => {
      const box = t.container.getBoundingClientRect();
      const group = t.orderLines.get('fixture-open').line._group;
      return { x: box.x + (group.closeX0 + group.x1) / 2, y: box.y + t.chart.priceToCoordinate(t.orderLines.get('fixture-open').line.price, 0) };
    });
    await page.mouse.click(close.x, close.y);
    await page.waitForFunction(() => window.__compatTerminals.some((t) => !t.destroyed && !t.orderLines.has('fixture-open')));
    assert.equal(report.requests.findLast((r) => r.path === '/api/v1/cancelorder').body.orderid, 'fixture-open');
    const before = orderCounter;
    await terminal((t) => t.exitPosition());
    assert.equal(orderCounter, before + 1);
    const exit = report.requests.findLast((r) => r.path === '/api/v1/placeorder').body;
    assert.equal(exit.action, 'BUY');
    assert.equal(exit.quantity, 65);
    assert.equal(exit.product, 'NRML');
    mockPositions = [];
  });
  await check('replay selection and playback block orders while live data remains isolated', async () => {
    const count = orderCounter;
    await terminal((t) => t.startReplay());
    assert.equal(await terminal((t) => t.replayPickingBar()), true);
    await terminal((t) => { t.placeCtx('SELL', 'MARKET'); t.exitPosition(); });
    const refusal = await terminal(async (t) => { try { await t.placeTicket({}); return null; } catch (error) { return error.message; } });
    assert.match(refusal, /Replay/);
    await terminal((t) => t.commitReplayPick());
    await page.waitForFunction(() => window.__compatTerminals.some((t) => !t.destroyed && t.replayActive()));
    const before = await terminal((t) => ({ n: t.price.getData().length, total: t.rawBars.length, last: t.price.getData().at(-1) }));
    assert(before.n < before.total);
    await sendDepth('NIFTY29SEP26FUT', 'NFO', 115.5);
    const after = await terminal((t) => ({ n: t.price.getData().length, last: t.price.getData().at(-1), live: t.rawBars.at(-1).close }));
    assert.equal(after.n, before.n);
    assert.deepEqual(after.last, before.last);
    assert.equal(after.live, 115.5);
    await terminal((t) => { t.placeCtx('SELL', 'MARKET'); t.replayStep(); t.stopReplay(); });
    assert.equal(orderCounter, count);
    assert.equal(await terminal((t) => t.price.getData().at(-1).close), 115.5);
  });
  if (args['probe-host']) {
    await terminal((t) => t.startReplay(10));
    await page.waitForFunction(() => window.__compatTerminals.some((t) => !t.destroyed && t.replayActive()));
    const before = await terminal((t) => t.price.getData().length);
    await terminal((t) => t.runReconcile());
    const after = await terminal((t) => ({ visibleBars: t.price.getData().length, sourceBars: t.rawBars.length, replayActive: t.replayActive() }));
    report.hostReconcileProbe = { before, ...after, overwroteReplay: after.visibleBars > before };
    console.log(`OBSERVATION host history reconciliation during replay: ${JSON.stringify(report.hostReconcileProbe)}`);
    await terminal((t) => t.stopReplay());
  }
  await check('persisted drawings, indicator, grid and interval survive reload', async () => {
    await terminal(async (t) => {
      await t.applyChartCommands([{ op: 'draw', group: 'compat', shapes: [{ kind: 'level', price: 103, label: 'Compatibility' }] }]);
      await t.addIndicatorById('ema');
      t.setGrid(false, false);
      t.setInterval('15m');
    });
    await page.waitForFunction(() => window.__compatTerminals.some((t) => !t.destroyed && t.interval === '15m' && t.draw?.toJSON().drawings.length));
    await page.reload();
    await waitReady();
    await page.waitForFunction(() => window.__compatTerminals.some((t) => !t.destroyed && t.draw?.toJSON().drawings.length));
    const state = await terminal((t) => ({ interval: t.interval, symbol: t.sym.symbol, drawings: t.draw.toJSON().drawings, indicators: t.activeIndicators, gridV: t.gridV, gridH: t.gridH }));
    assert.equal(state.interval, '15m');
    assert.equal(state.symbol, 'NIFTY29SEP26FUT');
    assert.equal(state.drawings[0].id, 'ai:compat:0');
    assert(state.indicators.some((i) => i.indicatorId === 'ema'));
    assert.equal(state.gridV, false);
    assert.equal(state.gridH, false);
  });
  await check('runtime custom indicator receives the shared chart API and survives reload', async () => {
    await terminal((t) => t.addIndicatorById('compat-close'));
    await page.waitForFunction(() => window.__compatCustomCalls > 0);
    await page.reload();
    await waitReady();
    await page.waitForFunction(() => window.__compatCustomCalls > 0);
    assert(await terminal((t) => t.listIndicators().some((indicator) => indicator.indicatorId === 'compat-close')));
  });
  await check('saved TPO and session volume profiles attach and survive live updates', async () => {
    for (const kind of ['tpo', 'session-volume-profile']) {
      await terminal(async (t, kind) => { t.setChartType(kind); await t.profileLayer?.ready; }, kind);
      await page.reload();
      await waitReady();
      await terminal(async (t) => t.profileLayer?.ready);
      assert.equal(await terminal((t) => t.ctype), kind);
      assert.equal(await terminal((t) => !!t.profileLayer?.primitive), true);
      await sendDepth('NIFTY29SEP26FUT', 'NFO', kind === 'tpo' ? 116 : 117);
      await terminal((t) => t.profileLayer.refresh(true));
      assert.equal(await terminal((t) => t.profileLayer.primitive.warning()), null);
    }
  });
  await check('daily broker interval and quote-only symbol retain correct contracts', async () => {
    await terminal(async (t, symbol) => { t.setChartType('candlestick'); await t.loadSymbol(symbol); t.setInterval('D'); }, symbols[2]);
    await page.waitForFunction(() => window.__compatTerminals.some((t) => !t.destroyed && t.interval === 'D' && t.price?.getData().length === 3));
    assert(report.requests.some((r) => r.path === '/api/v1/history' && r.body.interval === 'D'));
    assert.equal(await terminal((t) => t.tradeBtns), null);
    assert.equal(await terminal((t) => t.sym.tick), 0.05);
    assert.equal(await terminal((t) => t.builder), null);
    assert(report.websocket.some((m) => m.action === 'subscribe' && [1, 'LTP'].includes(m.mode)));
  });
  await check('two-pane layout restores independent pane state after reload', async () => {
    await page.getByRole('button', { name: 'Chart layout: Single' }).click();
    await page.getByTitle('2 columns', { exact: true }).click();
    const waitTwo = () => page.waitForFunction(() => window.__compatTerminals.filter((t) => !t.destroyed && t.price?.getData().length > 0).length === 2);
    await waitTwo();
    await page.reload();
    await waitTwo();
    assert.equal(await page.evaluate(() => localStorage.getItem('oa-trading-layout')), 'cols2');
    const panes = await page.evaluate(() => window.__compatTerminals.filter((t) => !t.destroyed && t.chart).map((t) => ({ key: t.sk, interval: t.interval, symbol: t.sym.symbol })));
    assert.equal(panes.find((p) => p.key === 'oa-trading-p0').symbol, 'NIFTY');
    assert.equal(panes.find((p) => p.key === 'oa-trading-p0').interval, 'D');
    assert.equal(panes.find((p) => p.key === 'oa-trading-p1').symbol, 'BHEL');
    assert.equal(panes.find((p) => p.key === 'oa-trading-p1').interval, '5m');
  });
  if (args.objects === 'true') {
    await check('Objects follows the pane last used anywhere inside its card', async () => {
      await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p0');
        pane.container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      });
      await page.getByRole('button', { name: 'Objects' }).click();
      await page.getByRole('complementary', { name: 'Objects' }).getByText(/Pane 1/).waitFor();
      await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        pane.container.closest('section').querySelector('button').dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true })
        );
      });
      await page.getByRole('complementary', { name: 'Objects' }).getByText(/Pane 2/).waitFor();
    });
    await check('indicator visibility and actionable identity survive rebuild and reload', async () => {
      const details = await page.evaluate(async () => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        await pane.addIndicatorById('ema');
        const row = pane.objects.list().find((object) => object.kind === 'indicator');
        return { id: row.id, name: row.name };
      });
      const panel = page.getByRole('complementary', { name: 'Objects' });
      await panel.getByRole('button', { name: `Hide ${details.name}` }).click();
      assert.equal(await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        return pane.objects.list().find((object) => object.kind === 'indicator').visible;
      }), false);
      await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        pane.setInterval('15m');
      });
      await page.waitForFunction((oldId) => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        const row = pane?.objects?.list().find((object) => object.kind === 'indicator');
        return row && row.id !== oldId && row.visible === false;
      }, details.id);
      await panel.getByRole('button', { name: `Settings for ${details.name}` }).click();
      await page.getByRole('heading', { name: details.name }).waitFor();
      await page.keyboard.press('Escape');
      await page.reload();
      await page.waitForFunction(() => window.__compatTerminals.filter((t) => !t.destroyed && t.price?.getData().length > 0).length === 2);
      await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        pane.container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      });
      await page.waitForFunction(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        return pane?.objects?.list().some((object) => object.kind === 'indicator');
      });
      const hidden = await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        const row = pane.objects.list().find((object) => object.kind === 'indicator');
        return { model: row.visible, saved: pane.activeIndicators.find((item) => item.indicatorId === 'ema')?.visible };
      });
      assert.deepEqual(hidden, { model: false, saved: false });
      await panel.getByRole('button', { name: `Show ${details.name}` }).click();
      assert.equal(await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        return pane.objects.list().find((object) => object.kind === 'indicator').visible;
      }), true);
    });
    await check('drawing object actions reuse selection, editor, history and persistence', async () => {
      await page.evaluate(async () => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        await pane.setDrawTool(null);
        pane.draw.add({ id: 'ai:objects-text:0', tool: 'text', paneIndex: 0,
          points: [{ time: pane.rawBars.at(-2).time, price: 100 }], style: { color: '#4f8cff' },
          text: { value: 'Object note' } });
      });
      const panel = page.getByRole('complementary', { name: 'Objects' });
      await panel.getByRole('button', { name: 'Select Text' }).click();
      await page.getByRole('button', { name: 'Colour' }).waitFor();
      await panel.getByRole('button', { name: 'Settings for Text' }).click();
      await page.getByRole('heading', { name: 'Text' }).waitFor();
      await page.keyboard.press('Escape');
      await panel.getByRole('button', { name: 'Lock Text' }).click();
      await panel.getByRole('button', { name: 'Hide Text' }).click();
      await panel.getByRole('button', { name: 'Focus Text' }).click();
      const changed = await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        const drawing = pane.draw.get('ai:objects-text:0');
        return { locked: drawing.locked, visible: drawing.visible, saved: pane.drawJson.drawings.some((d) => d.id === drawing.id && d.locked && d.visible === false) };
      });
      assert.deepEqual(changed, { locked: true, visible: false, saved: true });
      await panel.getByRole('button', { name: 'Remove Text' }).click();
      assert.equal(await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        return pane.draw.get('ai:objects-text:0');
      }), undefined);
      await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        pane.undoDraw();
      });
      assert.equal(await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        return pane.draw.get('ai:objects-text:0')?.id;
      }), 'ai:objects-text:0');
      await panel.getByRole('button', { name: 'Show Text' }).click();
      await panel.getByRole('button', { name: 'Unlock Text' }).click();
      assert.deepEqual(await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        const drawing = pane.draw.get('ai:objects-text:0');
        return { visible: drawing.visible, locked: drawing.locked };
      }), { visible: true, locked: false });
    });
    await check('profile object is settings-only and Objects sends no orders during replay', async () => {
      const ordersBefore = report.requests.filter((request) => ['/api/v1/placeorder', '/api/v1/modifyorder', '/api/v1/cancelorder'].includes(request.path)).length;
      await page.evaluate(async () => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        pane.setChartType('tpo');
        await pane.profileLayer?.ready;
      });
      const panel = page.getByRole('complementary', { name: 'Objects' });
      await panel.getByText('Time Price Opportunity').waitFor();
      assert.equal(await panel.getByRole('button', { name: 'Hide Time Price Opportunity' }).count(), 0);
      assert.equal(await panel.getByRole('button', { name: 'Remove Time Price Opportunity' }).count(), 0);
      assert.equal(await panel.getByRole('button', { name: 'Lock Time Price Opportunity' }).count(), 0);
      assert.equal(await panel.getByRole('button', { name: 'Focus Time Price Opportunity' }).count(), 0);
      await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        pane.startReplay(); pane.commitReplayPick();
      });
      await panel.getByRole('button', { name: 'Settings for Time Price Opportunity' }).click();
      const chartSettings = page.getByRole('heading', { name: 'Chart settings' });
      await chartSettings.waitFor();
      await page.keyboard.press('Escape');
      await chartSettings.waitFor({ state: 'detached' });
      await panel.getByRole('button', { name: /Settings for/ }).first().click();
      await chartSettings.waitFor();
      await page.keyboard.press('Escape');
      await chartSettings.waitFor({ state: 'detached' });
      const ordersAfter = report.requests.filter((request) => ['/api/v1/placeorder', '/api/v1/modifyorder', '/api/v1/cancelorder'].includes(request.path)).length;
      assert.equal(ordersAfter, ordersBefore);
      await page.evaluate(() => {
        const pane = window.__compatTerminals.find((t) => !t.destroyed && t.sk === 'oa-trading-p1');
        pane.stopReplay();
      });
    });
  }
  await check('no browser runtime errors or external HTTP', async () => {
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors.filter((message) => !message.startsWith('Failed to load resource:') && !message.includes('refusing to place, caller expects live mode but the OpenAlgo server is in analyzer mode')), []);
    assert.deepEqual(report.blocked, []);
  });
  if (args.screenshot) await page.screenshot({ path: resolve(args.screenshot), fullPage: true });
  await context.close();
} catch (error) {
  report.failure = error.stack ?? String(error);
  if (page) report.failurePage = { url: page.url(), text: await page.locator('body').innerText().catch(() => '') };
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await rm(cache, { recursive: true, force: true });
  if (args.output) await writeFile(resolve(args.output), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.label}: ${report.checks.length} browser compatibility checks passed`);
}
