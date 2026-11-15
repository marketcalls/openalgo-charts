import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** `import.meta.glob`, typed; the suite carries no Vite client globals. */
type Glob = { glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, string> };
// Keys come back as '../src/...'.
const SOURCES = (import.meta as unknown as Glob).glob('../src/{profile,helpers}/*.ts', { query: '?raw', import: 'default', eager: true });

/** The part of `node:worker_threads` used here; the suite carries no Node types either. */
interface BoundedWorker {
  once(event: 'message', listener: (value: unknown) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  terminate(): Promise<number>;
}
type WorkerClass = new (url: URL, options: { resourceLimits: { maxOldGenerationSizeMb: number } }) => BoundedWorker;
const { Worker } = await import('node:worker_threads' as string) as { Worker: WorkerClass };

/**
 * A source module as a data URL a worker can import, its relative imports
 * inlined the same way. Transpiled here rather than run as TypeScript, which
 * the Node that CI runs cannot do.
 */
function moduleUrl(path: string): string {
  const js = ts.transpileModule(SOURCES[path]!, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from '(\.[^']+)'/g, (_, spec: string) =>
    `from ${JSON.stringify(moduleUrl(`..${new URL(`${spec}.ts`, `file:///${path.slice(3)}`).pathname}`))}`);
  return `data:text/javascript,${encodeURIComponent(js)}`;
}

/**
 * `call` (an expression over `priceBuckets` and `computeVolumeProfile`) run in
 * a worker with a small heap and a deadline. The case below never ended in
 * 2.7.3's first candidate and grew its array until memory ran out, so it must
 * not run on the thread that runs the suite.
 */
function bounded(call: string): Promise<unknown> {
  const source = `import { parentPort } from 'node:worker_threads';
    import { priceBuckets } from ${JSON.stringify(moduleUrl('../src/profile/profile-model.ts'))};
    import { computeVolumeProfile } from ${JSON.stringify(moduleUrl('../src/profile/volume-profile.ts'))};
    parentPort.postMessage(${call});`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error(`${call} did not end`)); }, 8000);
    worker.once('message', value => { clearTimeout(timer); void worker.terminate(); resolve(value); });
    // The message alone: the stack names each module by its whole data URL.
    worker.once('error', error => { clearTimeout(timer); reject(new Error(`${call}: ${error.message}`)); });
  });
}

describe('N07 follow-up: a step too fine to count rows in whole numbers', () => {
  // 0.1 / 1e-17 is row 10^16, past 2^53, where a row index plus one is the
  // same index: the walk pushed one row forever. 0.1 + 1e-17 is still a
  // different double, so the guard on prices let it through.
  it('gives no rows instead of walking forever', async () => {
    expect(await bounded('priceBuckets(0.1, 0.1, 1e-17)')).toEqual([]);
    expect(await bounded('priceBuckets(0.1, 0.2, 1e-17)')).toEqual([]);
    expect(await bounded('priceBuckets(-0.2, -0.1, 1e-17)')).toEqual([]);
  }, 30_000);

  it('leaves a volume profile on such a step empty, as on any step the numbers cannot walk', async () => {
    expect(await bounded('computeVolumeProfile([{ time: 0, open: 0.1, high: 0.1, low: 0.1, close: 0.1, volume: 5 }], 1e-17)'))
      .toEqual({ buckets: [], poc: 0, vah: 0, val: 0, totalVolume: 0 });
  }, 30_000);

  it('keeps the rows of a fine step on a large price while each row index is exact', async () => {
    // Row 10^15, well inside 2^53: a micro-step on a price of a billion
    // still gives three rows, each above the last.
    const rows = await bounded('priceBuckets(1e9, 1e9 + 2e-6, 1e-6)') as number[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(1e9);
    expect(rows[1]! > rows[0]! && rows[2]! > rows[1]!).toBe(true);
  }, 30_000);
});
