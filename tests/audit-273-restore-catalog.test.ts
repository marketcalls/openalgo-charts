/**
 * The size limits of a workspace document belong to each document. A catalog
 * holds many documents, so the catalog as a whole gets its own, larger
 * ceiling: a user keeps more layouts than one document's limit would hold in
 * total, while a single document past its own limit is still refused, inside
 * a catalog or on its own.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryWorkspaceStorage, parseWorkspaceCatalog, parseWorkspaceDocument, WorkspaceRepository,
} from '../src/workspace/index';
import { workspaceFixture } from './helpers/workspace-fixture';

/** A one-chart layout whose drawings make it about `nodes` JSON values. */
function layout(nodes: number) {
  const doc = workspaceFixture();
  // A brush sample is three values (the record, its time and its price).
  const points = Array.from({ length: Math.floor(nodes / 3) }, (_, i) => ({ time: 1700000000 + i * 60, price: 100 + (i % 7) }));
  (doc.panes[0].chart as Record<string, unknown>).drawings = { version: 2, drawings: [{ id: 'stroke', tool: 'brush', points, style: {}, paneIndex: 0, zIndex: 0 }] };
  return { ...doc, panes: [doc.panes[0]], activePaneId: 'p0', layout: { rows: 1, columns: 1, slots: [{ paneId: 'p0', row: 0, column: 0, rowSpan: 1, columnSpan: 1 }] } };
}

function catalogOf(documents: unknown[]) {
  return { version: 1, revision: 1, workspaces: documents, templates: [], recentWorkspaceIds: [], activeWorkspaceId: null, autosave: false };
}

describe('workspace catalog capacity', () => {
  it('saves more layouts than one document\'s node limit holds in total', async () => {
    let n = 0;
    const repo = new WorkspaceRepository(createMemoryWorkspaceStorage(), 'acct', { id: () => `layout-${++n}`, now: () => 1000 + n });
    const payload = layout(24000);
    // Five layouts of 24,000 values pass a 100,000 value document limit together.
    for (let i = 0; i < 5; i++) await repo.createWorkspace(`Layout ${i}`, payload);
    const catalog = await repo.load();
    expect(catalog.workspaces).toHaveLength(5);
    await repo.rename('workspace', catalog.workspaces[0]!.id, 'Renamed');
    expect((await repo.load()).workspaces[0]!.name).toBe('Renamed');
  });

  it('still refuses one document past its own limit, inside a catalog or alone', () => {
    const big = { ...layout(100500), id: 'big' };
    expect(() => parseWorkspaceDocument(big)).toThrow(/node limit/);
    expect(() => parseWorkspaceCatalog(catalogOf([big]))).toThrow(/node limit/);
  });

  it('refuses a catalog past its own ceiling', () => {
    const docs = Array.from({ length: 12 }, (_, i) => ({ ...layout(90000), id: `d${i}` }));
    expect(() => parseWorkspaceCatalog(catalogOf(docs))).toThrow(/limit/);
  });
});
