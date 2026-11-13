import { describe, it, expect } from 'vitest';
import { Chart } from '../src/core/chart';
import { fakeDocument } from './helpers/fake-dom';

describe('Chart time-scale configuration', () => {
  it('lets wide footprint columns fit the viewport and preserves default spacing limits', () => {
    const doc = fakeDocument();
    const create = (wide: boolean) => new Chart(doc.createElement('div'), {
      document: doc, pixelRatio: () => 1, raf: { schedule: () => 0, cancel: () => {} },
      ...(wide ? { timeScale: { maxBarSpacing: 260, barSpacing: 120, rightOffset: 0 } } : {}),
    });
    const wide = create(true);
    expect(wide.timeScale.barSpacing).toBe(120);
    wide.timeScale.setWidth(1200);
    wide.timeScale.fitContent(7);
    expect(wide.timeScale.barSpacing).toBeGreaterThan(80);
    wide.timeScale.setBarSpacing(300);
    expect(wide.timeScale.barSpacing).toBe(260);
    const standard = create(false);
    standard.timeScale.setBarSpacing(300);
    expect(standard.timeScale.barSpacing).toBe(80);
    wide.destroy();
    standard.destroy();
  });

  it('fits content with the configured right offset, not the default', () => {
    const doc = fakeDocument();
    const create = (timeScale?: { rightOffset: number }) => new Chart(doc.createElement('div'), {
      document: doc, pixelRatio: () => 1, raf: { schedule: () => 0, cancel: () => {} },
      ...(timeScale ? { timeScale } : {}),
    });
    const wide = create({ rightOffset: 27 });
    wide.timeScale.setWidth(1200);
    wide.timeScale.setRightOffset(2);
    wide.timeScale.fitContent(100);
    expect(wide.timeScale.rightOffset).toBe(27);
    expect(wide.timeScale.barSpacing).toBeCloseTo(1200 / 127);
    const flush = create({ rightOffset: 0 });
    flush.timeScale.setWidth(1200);
    flush.timeScale.fitContent(100);
    expect(flush.timeScale.rightOffset).toBe(0);
    const standard = create();
    standard.timeScale.setWidth(1200);
    standard.timeScale.fitContent(100);
    expect(standard.timeScale.rightOffset).toBe(4);
    wide.destroy();
    flush.destroy();
    standard.destroy();
  });
});
