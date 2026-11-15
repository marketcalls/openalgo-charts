/**
 * A study's candle colours come off again whatever happened to the history
 * while they were on (audit C7 and N04).
 *
 * The overlay writes clones of the price bars carrying its colours, so taking
 * it off has to know each bar's own colour. That knowledge was a snapshot by
 * index, retaken only when bar 0's time changed: a page of older history
 * retook it from the clones and recorded the study's colours as the bars' own,
 * and a replacement at the same times, or a live tick on the forming bar, kept
 * the colours of bars the host had since replaced.
 */
import { describe, expect, it } from 'vitest';
import { Chart } from '../src/core/chart';
import { fakeDocument } from './helpers/fake-dom';
import { registerIndicator } from '../src/model/indicator-registry';
import type { Bar } from '../src/model/bar';

const T0 = 1_700_000_000;
const STUDY = '#123456';
registerIndicator({
  id: 'audit-273-bar-paint', name: 'Paint', placement: 'onchart', inputs: [],
  plots: [{ key: 'v', type: 'line', title: 'v' }],
  calc: (b) => ({ v: b.map((x) => x.close) }),
  barColors: ({ bars }) => bars.map(() => STUDY),
});

const bar = (i: number, color?: string): Bar =>
  ({ time: T0 + i * 60, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, ...(color === undefined ? {} : { color }) });
const bars = (from: number, to: number, color?: string): Bar[] => Array.from({ length: to - from }, (_, k) => bar(from + k, color));
const repeat = <T>(value: T, count: number): T[] => Array.from({ length: count }, () => value);

function makeChart(data: readonly Bar[]): Chart {
  const chart = new Chart(fakeDocument().createElement('div'), {
    document: fakeDocument(), pixelRatio: () => 1, shortcuts: false,
    raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} },
  });
  chart.applySize(800, 600);
  chart.addSeries('candlestick').setData(data);
  return chart;
}

const colorsOf = (chart: Chart): (string | undefined)[] => chart.primarySeries()!.getData().map(b => b.color);

describe('taking a bar-colouring study off', () => {
  it('gives paged-in history and the bars it pushed along their own colours back', () => {
    const recent = bars(20, 50, '#aa0000'), older = bars(0, 20, '#0000cc');
    const chart = makeChart(recent);
    const study = chart.addIndicator('audit-273-bar-paint');
    expect(colorsOf(chart)).toEqual(repeat(STUDY, 30));
    chart.primarySeries()!.prependData(older);
    expect(colorsOf(chart)).toEqual(repeat(STUDY, 50));
    study.remove();
    expect(colorsOf(chart)).toEqual([...repeat('#0000cc', 20), ...repeat('#aa0000', 30)]);
    // The host's own bars were never written to.
    expect([...older, ...recent].every(b => b.color !== STUDY)).toBe(true);
  });

  it('does the same for bars the host never coloured', () => {
    const chart = makeChart(bars(20, 50));
    const study = chart.addIndicator('audit-273-bar-paint');
    chart.primarySeries()!.prependData(bars(0, 20));
    study.remove();
    expect(colorsOf(chart)).toEqual(repeat(undefined, 50));
  });

  it('gives them back on hide, and takes them again on show', () => {
    const chart = makeChart(bars(20, 50, '#aa0000'));
    const study = chart.addIndicator('audit-273-bar-paint');
    chart.primarySeries()!.prependData(bars(0, 20, '#0000cc'));
    study.setVisible(false);
    expect(colorsOf(chart)).toEqual([...repeat('#0000cc', 20), ...repeat('#aa0000', 30)]);
    study.setVisible(true);
    expect(colorsOf(chart)).toEqual(repeat(STUDY, 50));
    study.remove();
    expect(colorsOf(chart)).toEqual([...repeat('#0000cc', 20), ...repeat('#aa0000', 30)]);
  });

  it('takes a replacement at the same times as the bars\' own colours', () => {
    const chart = makeChart(bars(0, 30, '#aa0000'));
    const study = chart.addIndicator('audit-273-bar-paint');
    chart.primarySeries()!.setData(bars(0, 30, '#00bb00'));
    expect(colorsOf(chart)).toEqual(repeat(STUDY, 30));
    study.remove();
    expect(colorsOf(chart)).toEqual(repeat('#00bb00', 30));
  });

  it('keeps the bar\'s own colour under a tick built on what getData returned', () => {
    const chart = makeChart(bars(0, 30, '#aa0000'));
    const study = chart.addIndicator('audit-273-bar-paint');
    const series = chart.primarySeries()!;
    // The copy carries the study's colour, which is not the host's.
    const data = series.getData();
    series.update({ ...data[data.length - 1]!, close: 140 });
    series.update({ ...series.getData()[28]!, close: 129 });
    study.remove();
    expect(colorsOf(chart)).toEqual(repeat('#aa0000', 30));
  });

  it('takes the colour a host sets on a copy of what getData returned', () => {
    const chart = makeChart(bars(0, 30, '#aa0000'));
    const study = chart.addIndicator('audit-273-bar-paint');
    const series = chart.primarySeries()!;
    series.update({ ...series.getData()[29]!, close: 140, color: '#00bb00' });
    study.remove();
    expect(colorsOf(chart)).toEqual([...repeat('#aa0000', 29), '#00bb00']);
  });

  // Audit N04, second round: matching the study's time and colour does not make
  // a bar the host built itself a copy of the study's.
  it('takes a replacement coloured like the study as the bars\' own colours', () => {
    const chart = makeChart(bars(0, 30, '#aa0000'));
    const study = chart.addIndicator('audit-273-bar-paint');
    chart.primarySeries()!.setData(bars(0, 30, STUDY));
    study.remove();
    expect(colorsOf(chart)).toEqual(repeat(STUDY, 30));
  });

  it('keeps a live tick coloured like the study as the bar\'s own colour', () => {
    const chart = makeChart(bars(0, 30, '#aa0000'));
    const study = chart.addIndicator('audit-273-bar-paint');
    chart.primarySeries()!.update({ ...bar(29, STUDY), close: 140 });
    study.remove();
    expect(colorsOf(chart)).toEqual([...repeat('#aa0000', 29), STUDY]);
  });

  it('gives a copy of what getData returned its own colour back after a page of older history', () => {
    const chart = makeChart(bars(20, 50, '#aa0000'));
    const study = chart.addIndicator('audit-273-bar-paint');
    const series = chart.primarySeries()!;
    const copies = series.getData().map(b => ({ ...b }));
    series.prependData(bars(0, 20, '#0000cc'));
    series.update({ ...copies[29]!, close: 160 });
    study.remove();
    expect(colorsOf(chart)).toEqual([...repeat('#0000cc', 20), ...repeat('#aa0000', 30)]);
  });

  it('keeps the colour of a live tick on the forming bar and of a new bar', () => {
    const chart = makeChart(bars(0, 30, '#aa0000'));
    const study = chart.addIndicator('audit-273-bar-paint');
    const series = chart.primarySeries()!;
    series.update(bar(29, '#00bb00'));
    series.update(bar(30, '#0000cc'));
    expect(colorsOf(chart)).toEqual(repeat(STUDY, 31));
    study.remove();
    expect(colorsOf(chart)).toEqual([...repeat('#aa0000', 29), '#00bb00', '#0000cc']);
  });
});
