// @ts-check
/**
 * The deprecation policy as a lint rule, loaded by eslint.config.js for src/.
 *
 * COMPATIBILITY.md keeps a deprecated API until the next major and asks the
 * declaration to say so. A bare `@deprecated` tells a host that an API is
 * going but not when, so the host cannot plan a migration, and nothing ever
 * falls due: a tag like that outlives the release that should have removed
 * the API. Every tag therefore names the release that removes it, as
 * "removed in X.Y.Z", and that release must be a later major than the one
 * being built. Once the package reaches it the tag fails, so the removal is a
 * gate rather than a good intention.
 *
 * The tag must sit in a doc block. A line comment or a plain block comment
 * reaches neither the editor's strike-through nor the API reference, which
 * are the two places a host would see it.
 */
import { readFileSync } from 'node:fs';

/** The removal clause every tag carries. */
const REMOVAL = /\bremoved in (\d+)\.(\d+)\.(\d+)\b/i;

/** Where the tag's own text ends: the next block tag at the start of a doc line. */
const NEXT_TAG = /\n\s*\*?\s*@[A-Za-z]/;

/** @param {string} version */
function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (m === null) throw new Error(`deprecation-version: "${version}" is not a release version`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** @param {number[]} a @param {number[]} b */
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The version in package.json, which is the release the tree is building toward. */
function packageVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

/**
 * What is wrong with one tag's text, or null when it meets the policy.
 * `tagText` runs from just after `@deprecated` to the next block tag.
 *
 * @param {string} tagText
 * @param {string} current the version being built
 * @returns {{ messageId: string, data: Record<string, string> } | null}
 */
export function deprecationProblem(tagText, current) {
  const m = REMOVAL.exec(tagText);
  if (m === null) return { messageId: 'missing', data: {} };
  const removal = [Number(m[1]), Number(m[2]), Number(m[3])];
  const now = parseVersion(current);
  const data = { removal: removal.join('.'), current, next: `${now[0] + 1}.0.0` };
  if (compare(removal, now) <= 0) return { messageId: 'reached', data };
  if (removal[0] <= now[0]) return { messageId: 'sameMajor', data };
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export const deprecationVersionRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Every @deprecated tag names the later major release that removes the API.' },
    schema: [{
      type: 'object',
      properties: { version: { type: 'string' } },
      additionalProperties: false,
    }],
    messages: {
      missing: '@deprecated must name the release that removes the API, as "removed in X.Y.Z" (see COMPATIBILITY.md).',
      sameMajor: '@deprecated names removal in {{removal}}, but a deprecated API stays until the next major after {{current}}: name {{next}} or later.',
      reached: '@deprecated names removal in {{removal}}, and that release has been reached ({{current}}): remove the API rather than the tag.',
      notDoc: '@deprecated belongs in a /** doc block */, the only comment the editor and the API reference read.',
    },
  },
  create(context) {
    const options = /** @type {{ version?: string } | undefined} */ (context.options[0]);
    const current = options?.version ?? packageVersion();
    const source = context.sourceCode;
    return {
      Program() {
        for (const comment of source.getAllComments()) {
          const text = comment.value;
          const isDoc = comment.type === 'Block' && text.startsWith('*');
          // The comment's text starts after its opening `//` or `/*`.
          const start = /** @type {[number, number]} */ (comment.range)[0] + 2;
          for (let at = text.indexOf('@deprecated'); at !== -1; at = text.indexOf('@deprecated', at + 1)) {
            // A block tag opens its line, as the compiler reads one. The word
            // in the middle of a sentence is prose about the policy, not a tag.
            if (!/^\s*\*?\s*$/.test(text.slice(text.lastIndexOf('\n', at) + 1, at))) continue;
            const loc = { start: source.getLocFromIndex(start + at), end: source.getLocFromIndex(start + at + 11) };
            if (!isDoc) {
              context.report({ loc, messageId: 'notDoc' });
              continue;
            }
            const rest = text.slice(at + 11);
            const end = rest.search(NEXT_TAG);
            const problem = deprecationProblem(end === -1 ? rest : rest.slice(0, end), current);
            if (problem !== null) context.report({ loc, messageId: problem.messageId, data: problem.data });
          }
        }
      },
    };
  },
};
