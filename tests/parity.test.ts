import { describe, it, expect } from 'vitest';
import { TimeScale } from '../src/scale/time-scale';

// Parity gaps to replace a third-party charting lib in OpenAlgo.
// Task 3: timeScale.setVisibleLogicalRange (preserve zoom across a data reload).

describe('Task 3: setVisibleLogicalRange', () => {
  it('restores a saved logical window after a reload changes base + zoom', () => {
    const ts = new TimeScale();
    ts.setWidth(600);
    ts.setBaseIndex(199);
    ts.fitContent(200);
    const before = ts.getVisibleLogicalRange();

    // Simulate a full-history reconcile: more bars, refit (jumps to default view).
    ts.setBaseIndex(499);
    ts.fitContent(500);
    expect(ts.visibleRange().to).not.toBeCloseTo(before.to, 1);

    // Restore the saved window.
    ts.setVisibleLogicalRange(before);
    const after = ts.getVisibleLogicalRange();
    expect(after.to).toBeCloseTo(before.to, 3);
    expect(after.from).toBeCloseTo(before.from, 3);
  });

  it('ignores a non-positive span and fires the change handler on apply', () => {
    const ts = new TimeScale();
    ts.setWidth(400);
    ts.setBaseIndex(99);
    ts.fitContent(100);
    let fired = 0;
    ts.setChangeHandler(() => { fired += 1; });
    ts.setVisibleLogicalRange({ from: 50, to: 50 }); // zero span -> no-op
    expect(fired).toBe(0);
    ts.setVisibleLogicalRange({ from: 40, to: 90 }); // valid
    expect(fired).toBe(1);
    expect(ts.visibleRange().to).toBeCloseTo(90, 3);
  });
});
