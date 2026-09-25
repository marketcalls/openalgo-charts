/**
 * The deprecation policy in COMPATIBILITY.md, checked where it can drift.
 *
 * The policy keeps a deprecated API until the next major and asks its
 * declaration to say so. Written only in prose it held for years with no tag
 * anywhere in src, so a host had no warning in its editor and no date to plan
 * a migration against. Two things are checked here:
 *
 * - the lint rule itself, over probe snippets through the real linter, because
 *   a rule that is only configured is not known to fire;
 * - the shims found in the code carry a tag, and COMPATIBILITY.md lists every
 *   tagged declaration with the same removal release, so the table a host
 *   reads and the strike-through its editor shows cannot disagree.
 */
/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import pkg from '../package.json';
import compatibility from '../COMPATIBILITY.md?raw';

// Same root derivation as widget-packaging.test.ts: the suite carries no Node
// typings, and ESLint wants absolute paths.
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const at = (rel: string): string => ROOT + rel;
const RULE = 'oac/deprecation-version';

type Sources = Record<string, string>;
const SOURCES = (import.meta as unknown as {
  glob(pattern: string, options: { query: string; import: string; eager: true }): Sources;
}).glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

const [MAJOR] = pkg.version.split('.').map(Number);

describe('the deprecation lint rule', () => {
  const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: at('eslint.config.js') });

  /** Lint `code` as if it lived at `file`; return what the deprecation rule says. */
  async function problems(code: string, file = 'src/core/probe.ts'): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: at(file) });
    return result.messages.filter(m => m.ruleId === RULE).map(m => m.message);
  }

  it('rejects a tag that names no removal release', async () => {
    const [message] = await problems('/** @deprecated Use `y`. */\nexport const x = 1;\n');
    expect(message).toContain('removed in');
  });

  it('accepts a tag that names a later major and a replacement', async () => {
    const code = `/** @deprecated Since 1.0.0; removed in ${MAJOR + 1}.0.0. Use \`y\`. */\nexport const x = 1;\n`;
    expect(await problems(code)).toEqual([]);
  });

  it('reads a tag that wraps onto the next line of the block', async () => {
    const code = [
      '/**',
      ' * An old name.',
      ' *',
      ' * @deprecated Since 1.0.0;',
      ` *   removed in ${MAJOR + 1}.0.0. Use \`y\`.`,
      ' * @param z unused',
      ' */',
      'export function x(z: number): number { return z; }',
      '',
    ].join('\n');
    expect(await problems(code)).toEqual([]);
  });

  it('does not let the version of the next tag stand in for this one', async () => {
    const code = [
      '/**',
      ' * @deprecated Use `y`.',
      ` * @see removed in ${MAJOR + 1}.0.0`,
      ' */',
      'export const x = 1;',
      '',
    ].join('\n');
    expect(await problems(code)).toHaveLength(1);
  });

  it('rejects a removal inside the current major', async () => {
    const code = `/** @deprecated Since 1.0.0; removed in ${MAJOR}.99.0. Use \`y\`. */\nexport const x = 1;\n`;
    const [message] = await problems(code);
    expect(message).toContain(`${MAJOR + 1}.0.0`);
  });

  it('rejects a removal release that has already shipped', async () => {
    const code = `/** @deprecated Since 0.1.0; removed in ${MAJOR}.0.0. Use \`y\`. */\nexport const x = 1;\n`;
    const [message] = await problems(code);
    expect(message).toContain('has been reached');
  });

  it('rejects a tag outside a doc block, where neither the editor nor the reference reads it', async () => {
    expect(await problems(`// @deprecated removed in ${MAJOR + 1}.0.0\nexport const x = 1;\n`)).toHaveLength(1);
    expect(await problems(`/* @deprecated removed in ${MAJOR + 1}.0.0 */\nexport const x = 1;\n`)).toHaveLength(1);
  });

  it('leaves the word alone in the middle of a sentence, where the compiler reads no tag', async () => {
    expect(await problems('/** Explains why an `@deprecated` tag names its release. */\nexport const x = 1;\n')).toEqual([]);
  });

  it('applies to every tier, the widget included', async () => {
    for (const dir of ['core', 'draw', 'indicators', 'trade', 'widget', 'workspace']) {
      expect(await problems('/** @deprecated gone soon */\nexport const x = 1;\n', `src/${dir}/probe.ts`), dir).toHaveLength(1);
    }
  });
});

/** One `@deprecated` tag in src: where it is, what it names, and the release it gives. */
interface Tagged { file: string; name: string; removal: string | null }

/** Every doc block carrying `@deprecated`, with the identifier its declaration names. */
function taggedDeclarations(): Tagged[] {
  const out: Tagged[] = [];
  for (const [key, text] of Object.entries(SOURCES)) {
    const file = key.replace(/^\.\.\//, '');
    for (const match of text.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*?@deprecated(?:(?!\*\/)[\s\S])*)\*\/\s*\n([^\n]*)/g)) {
      const declared = /^\s*(?:(?:export|declare|public|protected|readonly|static|async|abstract|get|set|function|const|let|class|interface|type)\s+)*([A-Za-z_$][\w$]*)/.exec(match[2]);
      const removal = /removed in (\d+\.\d+\.\d+)/i.exec(match[1]);
      out.push({ file, name: declared?.[1] ?? '', removal: removal?.[1] ?? null });
    }
  }
  return out;
}

/** The rows of the deprecation table in COMPATIBILITY.md, as cell arrays. */
function deprecationRows(): string[][] {
  const section = /## Deprecated APIs\n([\s\S]*?)(?:\n## |$)/.exec(compatibility)?.[1] ?? '';
  return section.split('\n')
    .filter(line => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1)
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
}

describe('the compatibility shims', () => {
  const tagged = taggedDeclarations();

  it('carry a deprecation tag where the code keeps an old form for compatibility', () => {
    // Each of these exists only so code written against an earlier release
    // keeps compiling: a newer declaration does the same job and more.
    const shims = [
      ['src/feed/openalgo-trade.ts', 'mapOrder'],
      ['src/model/indicator-instance.ts', 'dashed'],
    ];
    const found = tagged.map(t => `${t.file}#${t.name}`);
    expect(found).toEqual(expect.arrayContaining(shims.map(([file, name]) => `${file}#${name}`)));
  });

  it('are each listed in COMPATIBILITY.md with the release the tag gives', () => {
    const rows = deprecationRows();
    expect(rows.length).toBeGreaterThan(0);
    const unlisted = tagged.filter(t => !rows.some(row =>
      row[1]?.includes(t.file) && new RegExp(`\\b${t.name}\\b`).test(row[0] ?? '') && row[3]?.includes(t.removal ?? '?')));
    expect(unlisted).toEqual([]);
  });
});
