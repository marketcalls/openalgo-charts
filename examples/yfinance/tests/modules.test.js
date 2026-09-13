// Every module evaluates outside a browser. A module that touched the DOM
// at import time, or reached a cyclic import's binding before it was
// initialised, throws here and nowhere else: in the page the failure would
// be a blank document.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

// main.js is the page itself: it builds the app and loads a symbol on
// import, so it is the one module that needs a document.
const MODULES = readdirSync(SRC).filter((f) => f.endsWith('.js') && f !== 'main.js').sort();

/** The init hook each module hands its state to, where it has one. */
const INIT = {
  'axis-chrome.js': 'initAxisChrome',
  'bracket.js': 'initBracket',
  'chart-settings.js': 'initChartSettings',
  'clipboard.js': 'initClipboard',
  'compare.js': 'initCompare',
  'drawing.js': 'initDrawing',
  'feed.js': 'initFeed',
  'hover.js': 'initHover',
  'indicators.js': 'initIndicators',
  'link.js': 'initLink',
  'menus.js': 'initMenus',
  'orders.js': 'initOrders',
  'persist.js': 'initPersist',
  'rail.js': 'initRail',
  'replay.js': 'initReplay',
  'snapshot.js': 'initSnapshot',
  'split.js': 'initSplit',
  'status.js': 'initStatus',
  'timezone.js': 'initTimezone',
  'toolbar.js': 'initToolbar',
  'volume.js': 'initVolume',
};

describe('demo modules', () => {
  it('lists the modules the README documents', () => {
    expect(MODULES).toEqual([
      'axis-chrome.js', 'bracket.js', 'chart-settings.js', 'clipboard.js', 'compare.js',
      'drawing.js', 'feed.js', 'hover.js', 'indicators.js', 'intervals.js', 'level-editor.js',
      'link.js', 'menus.js', 'orders.js', 'persist.js', 'properties.js', 'rail-flyout.js',
      'rail.js', 'replay.js', 'snapshot.js', 'split.js', 'status.js', 'text-editor.js',
      'timezone.js', 'toolbar.js', 'transforms.js', 'ui.js', 'volume.js',
    ]);
  });

  it('uses engine branding once and keeps both chart contexts current', () => {
    const main = readFileSync(SRC + 'main.js', 'utf8');
    const split = readFileSync(SRC + 'split.js', 'utf8');

    expect(main).not.toContain("from './watermark.js'");
    expect(main).not.toContain("id === 'watermark'");
    const snapshot = main.indexOf('const decorations = chartDecorationsForRebuild(app.chart);');
    expect(snapshot).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(main.indexOf('app.chart.destroy()'));
    expect(main).toContain('...decorations,');
    expect(main).toContain("app.chart.setDataContext({ symbol: app.req.symbol, interval: app.req.interval });");
    expect(main).toContain("app.chart.on('branding:changed', renderToolbar)");
    expect(split).toContain("app.chart2.setDataContext({ symbol: app.p2.symbol, interval: app.p2.interval });");
  });

  for (const file of MODULES) {
    it(`${file} imports without a DOM and exposes its init`, async () => {
      const mod = await import(SRC + file);
      const init = INIT[file];
      if (init) expect(typeof mod[init], init).toBe('function');
      else expect(Object.keys(mod).length).toBeGreaterThan(0);
    });
  }
});
