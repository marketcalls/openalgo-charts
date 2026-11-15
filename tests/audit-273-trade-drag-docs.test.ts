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
import { OrderEngine, type ModifyPatch, type OrderFeed, type PlaceRequest } from '../src/trade/order-engine';
import { TradeController } from '../src/trade/trade-controller';
import { WorkingOrderLine } from '../src/trade/order-line';
import type { Order } from '../src/trade/types';
import type { IPrimitive } from '../src/primitives/primitive';
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

/*
 * The two recipes a reader runs as they stand: the reference's worked example
 * and the chart trading example. Executed here as written, against a real
 * engine, because both of their defects were in what the code did, not in how
 * it was wired: the preview put a stop-limit's trigger at the pointer while the
 * engine moved its limit there and its trigger 5 below, and the book was read
 * before the broker had answered the modify.
 */
type Recipe = { move(id: string, price: number): void; release(id: string, price: number): void };

/** Run a recipe's own functions and drag wiring, with the names it reads from its page supplied. */
function runRecipe(path: string, scope: Record<string, unknown>): Recipe {
  const code = codeOf(path).find((c) => c.includes('subscribeDrag') && c.includes('function draw'))!;
  const source = ts.createSourceFile('recipe.ts', code, ts.ScriptTarget.Latest, true);
  const kept = source.statements.filter((s) =>
    (ts.isFunctionDeclaration(s) && s.name !== undefined && !(s.name.text in scope))
    || (ts.isExpressionStatement(s) && /^chart\.(on|subscribeDrag)\(/.test(s.getText(source))));
  const recipe = {} as Recipe;
  const chart = {
    on: () => {},
    subscribeDrag: (move: Recipe['move'], release: Recipe['release']) => { recipe.move = move; recipe.release = release; },
  };
  const js = ts.transpile(kept.map((s) => s.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
  const names = Object.keys(scope);
  new Function('chart', ...names, js)(chart, ...names.map((n) => scope[n]));
  return recipe;
}

class Host {
  public live: IPrimitive[] = [];
  public addPrimitive(p: IPrimitive): void { this.live.push(p); }
  public removePrimitive(p: IPrimitive): void { this.live = this.live.filter((q) => q !== p); }
  public line(): Order { return (this.live.find((p) => p instanceof WorkingOrderLine) as WorkingOrderLine).order; }
}

async function setUp(path: string, req: Pick<PlaceRequest, 'type' | 'price' | 'triggerPrice'>, modify: OrderFeed['modify']) {
  const host = new Host();
  const controller = new TradeController(host);
  const engine = new OrderEngine({ armed: true, constraints: { tickSize: 0.05 },
    feed: { place: async () => ({ orderId: 'OA1' }), modify, cancel: async () => {} } });
  const placed = await engine.placeOrder({ symbol: 'INFY', exchange: 'NSE', side: 'BUY', qty: 10, ...req });
  const row: Order = { id: 'OA1', symbol: 'INFY', exchange: 'NSE', product: 'MIS', side: 'BUY', type: req.type, qty: 10,
    filledQty: 0, price: req.price ?? 0, status: 'working', ...(req.triggerPrice === undefined ? {} : { triggerPrice: req.triggerPrice }) };
  const book = { orders: [row], positions: [] };
  const clients = new Map([['order:OA1', placed.clientId!]]);
  const reads: number[] = [];
  const refresh = (): void => { reads.push(reads.length); };
  const recipe = path === 'trade-tier.md'
    ? runRecipe(path, { book, drafts: new Map(), controller, instrument: { symbol: 'INFY', exchange: 'NSE' },
      clientOf: clients, engine, refreshBook: refresh })
    : runRecipe(path, { book, drafts: new Map(), tc: controller, SYM: 'INFY', brokerToClient: clients, eng: engine });
  return { host, engine, recipe, reads, clientId: placed.clientId! };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe('a documented drag previews the fields the engine sends', () => {
  const cases: [string, Pick<PlaceRequest, 'type' | 'price' | 'triggerPrice'>, number, ModifyPatch][] = [
    ['a limit', { type: 'LIMIT', price: 100 }, 104, { price: 104 }],
    ['a stop-market', { type: 'SL-M', triggerPrice: 95 }, 98, { triggerPrice: 98 }],
    // The line of a stop-limit is its trigger: dropped at 110, the trigger rests
    // at 110 and the limit keeps its 5 above it.
    ['a stop-limit', { type: 'SL', price: 100, triggerPrice: 95 }, 110, { price: 115, triggerPrice: 110 }],
  ];
  for (const path of ['trade-tier.md', 'phase9-chart-trading.html']) {
    it.each(cases)(`${path}: %s`, async (_name, req, drop, expected) => {
      const sent: ModifyPatch[] = [];
      const h = await setUp(path, req, async (_id, patch) => { sent.push({ ...patch }); });
      h.recipe.move('order:OA1', drop);
      const shown = h.host.line();
      // The line follows the pointer.
      expect(shown.triggerPrice ?? shown.price).toBe(drop);
      h.recipe.release('order:OA1', drop);
      await settle();
      expect(sent).toEqual([expected]);
      // And the preview drew the same fields the engine sent.
      expect({ price: shown.price, triggerPrice: shown.triggerPrice }).toMatchObject(expected);
    });
  }
});

describe('the documented release reads the book after the broker answers', () => {
  it('trade-tier.md', async () => {
    let answer!: () => void;
    const h = await setUp('trade-tier.md', { type: 'LIMIT', price: 100 },
      () => new Promise<void>((resolve) => { answer = resolve; }));
    h.recipe.move('order:OA1', 105);
    h.recipe.release('order:OA1', 105);
    await settle();
    // Sent, not yet answered: a read now would repaint the order at 100.
    expect(h.engine.intentState(h.clientId)).toBe('MODIFY_SUBMITTING');
    expect(h.reads).toEqual([]);
    answer();
    await settle();
    expect(h.reads).toEqual([0]);
  });
});
