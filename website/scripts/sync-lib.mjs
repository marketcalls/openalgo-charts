// Copies the built OpenAlgo Charts bundles from ../dist into the docs site so the
// live, in-page chart demos run against the real library. Runs automatically
// before `next dev` / `next build` (see package.json predev/prebuild). If the
// library has not been built yet, it prints a hint instead of failing the build.
import { mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, '..', '..', 'dist');
const outDir = resolve(here, '..', 'lib', 'oac');

if (!existsSync(distDir)) {
  console.warn('[sync-lib] ../dist not found. Run `npm run build` in the repo root first.');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const wanted = readdirSync(distDir).filter((f) => f.endsWith('.mjs') || f.endsWith('.mjs.map'));
let copied = 0;
for (const file of wanted) {
  copyFileSync(join(distDir, file), join(outDir, file));
  copied += 1;
}
console.log(`[sync-lib] copied ${copied} bundle file(s) into website/lib/oac`);
