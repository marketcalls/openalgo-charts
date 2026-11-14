/**
 * A policy is how a host keeps its own drawings and studies from the user. A
 * portable workspace document is anyone's: one opened from a file or a link
 * must not install an object the user cannot select, delete or see. The
 * repository is the host's own store, so a layout the host saved keeps what
 * its objects were, and a document imported into it arrives as the user's own.
 */
import { describe, expect, it } from 'vitest';
import '../src/indicators/index';
import { Chart, type Bar } from '../src/index';
import { DrawingController } from '../src/draw/index';
import {
  createMemoryWorkspaceStorage, parseWorkspaceCatalog, parseWorkspaceDocument, parseWorkspacePayload, WorkspaceRepository,
} from '../src/workspace/index';
import { workspaceFixture } from './helpers/workspace-fixture';
import { fakeDocument } from './helpers/fake-dom';

const DRAWING_POLICY = { selectable: false, editable: false, listed: false };
const STUDY_POLICY = { removable: false, configurable: false, movable: false, listed: false };

/** A desk whose first chart carries a protected drawing and a protected study, as a shared file could. */
function planted() {
  const doc = workspaceFixture();
  const chart = doc.panes[0].chart as Record<string, unknown>;
  chart.drawings = { version: 2, drawings: [
    { id: 'planted', tool: 'horizontal-line', points: [{ time: 1700000000, price: 120 }], style: {}, paneIndex: 0, zIndex: 0, policy: DRAWING_POLICY },
    { id: 'mine', tool: 'horizontal-line', points: [{ time: 1700000000, price: 130 }], style: {}, paneIndex: 0, zIndex: 0 },
  ] };
  chart.indicators = [{ indicatorId: 'sma', settings: {}, paneIndex: 0, instanceId: 'planted-study', policy: STUDY_POLICY }];
  return doc;
}

const drawingsOf = (chart: { drawings?: unknown }) => (chart.drawings as { drawings: Array<Record<string, unknown>> }).drawings;

describe('a portable workspace document drops each object\'s policy', () => {
  it('parseWorkspaceDocument and parseWorkspacePayload drop drawing and study policies when told the document is not the host\'s', () => {
    const strip = { keepPolicy: false } as const;
    for (const parsed of [parseWorkspaceDocument(JSON.stringify(planted()), strip), parseWorkspacePayload(planted(), strip)]) {
      const chart = parsed.panes[0]!.chart;
      expect(drawingsOf(chart).map(d => d.policy)).toEqual([undefined, undefined]);
      expect(drawingsOf(chart).map(d => d.id)).toEqual(['planted', 'mine']);
      expect(chart.indicators?.[0]?.policy).toBeUndefined();
    }
    // The default keeps them: hosts read their own saved state through these parsers.
    for (const kept of [parseWorkspaceDocument(planted()).panes[0]!.chart, parseWorkspacePayload(planted(), { keepPolicy: true }).panes[0]!.chart]) {
      expect(drawingsOf(kept)[0]!.policy).toEqual(DRAWING_POLICY);
      expect(kept.indicators?.[0]?.policy).toEqual(STUDY_POLICY);
    }
    // A 1.9.x drawing list carries its drawings bare, and is read the same way.
    const legacy = planted();
    (legacy.panes[0].chart as Record<string, unknown>).drawings = drawingsOf(legacy.panes[0].chart);
    const list = parseWorkspacePayload(legacy, strip).panes[0]!.chart.drawings as Array<Record<string, unknown>>;
    expect(list.map(d => d.policy)).toEqual([undefined, undefined]);
  });

  it('leaves the user free to remove what a shared document placed', () => {
    const chart = new Chart(fakeDocument().createElement('div'), { document: fakeDocument(), pixelRatio: () => 1, shortcuts: false,
      raf: { schedule: (cb: () => void) => { cb(); return 1; }, cancel: () => {} } });
    chart.applySize(800, 600);
    const bars: Bar[] = Array.from({ length: 40 }, (_, i) => ({ time: 1700000000 + i * 60, open: 100, high: 102, low: 99, close: 101 }));
    chart.addSeries('candlestick').setData(bars);
    const draw = new DrawingController(chart);
    expect(chart.restoreState(parseWorkspaceDocument(planted(), { keepPolicy: false }).panes[0]!.chart).applied).toBe(true);
    expect(draw.remove('planted')).toBe(true);
    expect(chart.removeIndicator('planted-study')).toBe(true);
    chart.destroy();
  });

  it('keeps the host\'s own layouts as they were saved, and imports a shared one as the user\'s', async () => {
    let n = 0;
    const repo = new WorkspaceRepository(createMemoryWorkspaceStorage(), 'acct', { id: () => `doc-${++n}`, now: () => 1000 + n });
    const own = await repo.createWorkspace('Own', planted());
    expect(drawingsOf(own.panes[0]!.chart)[0]!.policy).toEqual(DRAWING_POLICY);
    await repo.saveWorkspace(own.id, planted());
    const copy = await repo.duplicate('workspace', own.id, 'Copy');
    const imported = await repo.importDocument(planted());
    const catalog = await repo.load();
    const byId = (id: string) => catalog.workspaces.find(item => item.id === id)!.panes[0]!.chart;
    for (const id of [own.id, copy.id]) {
      expect(drawingsOf(byId(id))[0]!.policy).toEqual(DRAWING_POLICY);
      expect(byId(id).indicators?.[0]?.policy).toEqual(STUDY_POLICY);
    }
    expect(drawingsOf(byId(imported.id))[0]!.policy).toBeUndefined();
    expect(byId(imported.id).indicators?.[0]?.policy).toBeUndefined();
    // The catalog is the host's storage, read back as it was written.
    expect(drawingsOf(parseWorkspaceCatalog(catalog).workspaces[0]!.panes[0]!.chart)[0]!.policy).toEqual(DRAWING_POLICY);
  });
});
