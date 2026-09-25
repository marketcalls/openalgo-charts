/**
 * README and ARCHITECTURE.md describe how the engine paints and how fast it
 * is, and hosts size dashboards on what they say. Several of those statements
 * had stopped being true, or had never been measured: a single canvas where
 * every pane has two, a time-scale operation queue nothing ever filled, one
 * study repainting only its own pane, and "50k+ bars stay 60 fps".
 *
 * These checks tie each such statement to the code or to a measurement
 * record. Where the engine could reasonably change (how far a recompute
 * repaints), the check is symmetric: the document must say what the chart
 * does today, so improving the engine without updating the document fails
 * here just as surely as the reverse.
 */
/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import readme from '../README.md?raw';
import architecture from '../ARCHITECTURE.md?raw';
import maskSource from '../src/core/invalidate-mask.ts?raw';
import { Chart } from '../src/core/chart';
import { Pane } from '../src/core/pane';
import type { Bar } from '../src/model/bar';
import { registerIndicator, type IndicatorAttachContext } from '../src/model/indicator-registry';
import { fakeDocument } from './helpers/fake-dom';

type Sources = Record<string, string>;
const SOURCES = (import.meta as unknown as {
  glob(pattern: string, options: { query: string; import: string; eager: true }): Sources;
}).glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

const DOCS: Readonly<Record<string, string>> = { 'README.md': readme, 'ARCHITECTURE.md': architecture };

/**
 * The units a reader takes one claim from: a table row, a list item, or a
 * paragraph. Splitting a table into rows matters: a measurement cited in one
 * row must not vouch for a figure in another.
 */
function statements(markdown: string): string[] {
  const out: string[] = [];
  for (const block of markdown.split(/\n\s*\n/)) {
    let current: string | null = null;
    for (const line of block.split('\n')) {
      if (current === null || /^\s*(?:\||[-*] |\d+\. |>)/.test(line)) {
        if (current !== null) out.push(current);
        current = line;
      } else {
        current += `\n${line}`;
      }
    }
    if (current !== null) out.push(current);
  }
  return out;
}

/** A frame rate, a bar count quoted as a workload, or a percentile. */
const PERFORMANCE_FIGURE = /\b\d+(?:\.\d+)?\s*fps\b|\bframes? per second\b|\b\d+(?:\.\d+)?k\+?[-\s]bars?\b|\bp9[59]\b/i;

/** A record someone can rerun: the harness, its documentation or a bench script. */
const MEASUREMENT = /scripts\/browser-endurance\.mjs|docs\/browser-endurance\.md|scripts\/(?:bench-indicators|soak)\.mjs|npm run (?:bench|soak|endurance:browser)\b/;

describe('performance figures', () => {
  it.each(Object.keys(DOCS))('%s quotes none without the record it was measured in', (name) => {
    const unmeasured = statements(DOCS[name]).filter(s => PERFORMANCE_FIGURE.test(s) && !MEASUREMENT.test(s));
    expect(unmeasured).toEqual([]);
  });
});

describe('the canvas layout', () => {
  const words = ['no', 'one', 'two', 'three', 'four'];

  it('the README counts the canvases each pane really creates', () => {
    const chart = new Chart(fakeDocument().createElement('div'), {
      document: fakeDocument(), pixelRatio: () => 1, shortcuts: false,
    });
    chart.addSeries('line', { paneIndex: 1 });
    expect(chart.panes()).toHaveLength(2);
    const counts = chart.panes().map(pane =>
      (pane.element as unknown as { children: { tagName?: string }[] }).children.filter(c => c.tagName === 'CANVAS').length);
    chart.destroy();
    expect(new Set(counts).size).toBe(1);
    expect(readme).not.toMatch(/single[- ]canvas/i);
    expect(readme).toContain(`${words[counts[0]]} canvases per pane`);
  });

  it('ARCHITECTURE.md draws no separate axis canvases, because the axes paint on the pane canvas', () => {
    expect(architecture).not.toMatch(/\b(?:left|right|time)-axis canvas\b/i);
    expect(architecture).not.toMatch(/axes as separate widgets/i);
  });
});

describe('the invalidation mask', () => {
  it('ARCHITECTURE.md sketches only the time-scale operations the mask declares', () => {
    const declared = new Set([...maskSource.matchAll(/type: '(\w+)'/g)].map(m => m[1]));
    const sketch = /type TimeScaleOp =[\s\S]*?\n\n/.exec(architecture)?.[0] ?? '';
    const documented = [...sketch.matchAll(/type: '(\w+)'/g)].map(m => m[1]);
    expect(documented.length).toBeGreaterThan(0);
    expect(documented.filter(op => !declared.has(op))).toEqual([]);
  });

  it('ARCHITECTURE.md says whether anything queues a time-scale operation, and the code agrees', () => {
    const callers = Object.entries(SOURCES)
      .filter(([path, text]) => !path.endsWith('/invalidate-mask.ts') && /\.addTimeScaleOp\(/.test(text));
    const saysUnused = /`addTimeScaleOp` has no caller/.test(architecture);
    expect(saysUnused).toBe(callers.length === 0);
  });
});

describe('how far a repaint reaches', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  let sequence = 0;

  /** A price series and a study in a pane of its own, painting synchronously. */
  function mount(): { chart: Chart; tick: () => void; recompute: () => void } {
    const document = fakeDocument();
    const chart = new Chart(document.createElement('div'), {
      document, pixelRatio: () => 1, shortcuts: false,
      raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
    });
    chart.applySize(800, 600);
    const bars: Bar[] = Array.from({ length: 50 }, (_, i) => ({
      time: 1_700_000_000 + i * 60, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i,
    }));
    const source = chart.addSeries('candlestick');
    source.setData(bars);
    let attachment!: IndicatorAttachContext;
    const id = `docs-claims-probe-${sequence++}`;
    registerIndicator({
      id, name: 'Probe', placement: 'pane', inputs: [],
      plots: [{ key: 'v', type: 'line', title: 'Value' }],
      calc: input => ({ v: input.map(bar => bar.close) }),
      attach: context => { attachment = context; },
    });
    chart.addIndicator(id);
    expect(chart.panes()).toHaveLength(2);
    const last = bars[bars.length - 1];
    return {
      chart,
      tick: () => source.update({ ...last, close: last.close + 0.5 }),
      recompute: () => attachment.requestRecompute(),
    };
  }

  /** Which panes repainted their base canvas while `act` ran. */
  function repainted(chart: Chart, act: () => void): boolean[] {
    const spy = vi.spyOn(Pane.prototype, 'paintBase');
    act();
    const painted = new Set(spy.mock.contexts);
    spy.mockRestore();
    return chart.panes().map(pane => painted.has(pane));
  }

  it('an indicator recompute: ARCHITECTURE.md says every pane repaints exactly when the price pane does', () => {
    const { chart, recompute } = mount();
    const [pricePane, studyPane] = repainted(chart, recompute);
    chart.destroy();
    expect(studyPane).toBe(true);
    expect(/an indicator recompute repaints every pane/i.test(architecture)).toBe(pricePane);
  });

  it('a live tick: ARCHITECTURE.md says every pane repaints exactly when the study pane does', () => {
    const { chart, tick } = mount();
    const [pricePane, studyPane] = repainted(chart, tick);
    chart.destroy();
    expect(pricePane).toBe(true);
    expect(/a live tick repaints every pane/i.test(architecture)).toBe(studyPane);
  });
});
