// Study policies in the reference host: the protected VWAP the host places,
// and the chips, the settings dialog and the menus drawing a protected study
// as protected rather than offering controls the chart would refuse.
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('/dist/openalgo-charts.mjs', () => import('../../../src/index.ts'));
vi.mock('openalgo-charts', () => import('../../../src/index.ts'));
vi.mock('../src/persist.js', () => ({ autosave: vi.fn() }));
import '../../../src/indicators/index.ts';
import { Chart, ChartObjects } from '../../../src/index.ts';
import { fakeDocument } from '../../../tests/helpers/fake-dom';
import { HOST_STUDY_POLICY, addHostStudy, hostStudy, removeHostStudy, studyAllows } from '../src/host-study.js';

const charts = [];
afterEach(() => charts.splice(0).forEach((chart) => chart.destroy()));
function mount() {
  const document = fakeDocument();
  const chart = new Chart(document.createElement('div'), {
    document, pixelRatio: () => 1, shortcuts: false, raf: { schedule: () => 0 },
  });
  chart.applySize(800, 600);
  chart.addSeries('candlestick').setData(Array.from({ length: 40 }, (_, i) => ({
    time: 1700000000 + i * 60, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 100,
  })));
  charts.push(chart);
  return chart;
}

describe('the protected VWAP', () => {
  it('is added once, withholds the user actions and goes only with the host row', () => {
    const chart = mount();
    const study = addHostStudy(chart);
    expect(addHostStudy(chart)).toBe(study);
    expect(study.policy()).toEqual(HOST_STUDY_POLICY);
    expect(HOST_STUDY_POLICY).toEqual({ removable: false, configurable: false, movable: false });
    for (const flag of ['removable', 'configurable', 'movable']) expect(studyAllows(study, flag)).toBe(false);
    expect(studyAllows(study, 'listed')).toBe(true);
    const objects = new ChartObjects(chart);
    const row = objects.get('indicator:' + study.id);
    expect(row.capabilities).toMatchObject({ remove: false, settings: false, move: false, reorder: false, place: false, visibility: true });
    expect(chart.removeIndicator(study.id)).toBe(false);
    expect(study.setSettings({ anchor: 'week' })).toBe(false);
    // Saved with the layout, so a reload brings it back protected.
    const saved = JSON.parse(JSON.stringify(chart.getState()));
    const next = mount();
    expect(next.restoreState(saved).applied).toBe(true);
    expect(hostStudy(next)?.policy()).toEqual(HOST_STUDY_POLICY);
    expect(removeHostStudy(chart)).toBe(true);
    expect(hostStudy(chart)).toBeUndefined();
    expect(removeHostStudy(chart)).toBe(false);
    objects.destroy();
  });

  it('treats an engine without policies as allowing everything', () => {
    expect(studyAllows({}, 'removable')).toBe(true);
    expect(studyAllows(undefined, 'configurable')).toBe(true);
  });
});
