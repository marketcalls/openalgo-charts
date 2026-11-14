/**
 * Drag to modify, as documented (audit T3).
 *
 * `OrderEngine.requestModify` writes to the broker whenever its interval has
 * passed, so wiring it to a drag's move callback rests a live order at every
 * price the pointer crosses on the way: an overshoot can make it marketable and
 * fill it. The skill reference and one example did exactly that while the
 * guides showed the safe form. Every documented drag wiring keeps the move
 * callback local and writes on release only.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import tradeTier from '../.github/skills/openalgo-charts/references/trade-tier.md?raw';
import tradingPage from '../website/pages/docs/trading.mdx?raw';
import guides from '../docs/guides.md?raw';
import chartTrading from '../examples/phase9-chart-trading.html?raw';
import live from '../examples/live/index.html?raw';

const SOURCES: Record<string, string> = {
  'trade-tier.md': tradeTier,
  'trading.mdx': tradingPage,
  'guides.md': guides,
  'phase9-chart-trading.html': chartTrading,
  'live/index.html': live,
};

/** The code a reader copies: fenced blocks of a page, module scripts of an example. */
function codeOf(path: string): string[] {
  const text = SOURCES[path]!.replace(/\r\n/g, '\n');
  const blocks = path.endsWith('.html')
    ? text.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)
    : text.matchAll(/```(?:ts|js|tsx|typescript)\n([\s\S]*?)```/g);
  return [...blocks].map((m) => m[1]!);
}

/** The move callback (first argument) and the release callback of every `subscribeDrag` call. */
function dragWirings(code: string): { move: string; release: string }[] {
  const source = ts.createSourceFile('snippet.ts', code, ts.ScriptTarget.Latest, true);
  const out: { move: string; release: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source).endsWith('subscribeDrag')) {
      out.push({ move: node.arguments[0]?.getText(source) ?? '', release: node.arguments[1]?.getText(source) ?? '' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const BROKER_WRITE = /requestModify|commitModify|\.modify\(/;

describe('documented drag wirings write to the broker on release only', () => {
  it.each(Object.keys(SOURCES))('%s', (path) => {
    const wirings = codeOf(path).flatMap(dragWirings);
    const writing = wirings.filter((w) => BROKER_WRITE.test(w.release));
    // Each of these pages documents a drag that modifies an order.
    expect(writing.length).toBeGreaterThan(0);
    for (const w of wirings) expect(w.move).not.toMatch(BROKER_WRITE);
  });
});
