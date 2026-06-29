/** Minimal fake DOM so Pane/Chart can be constructed in node tests. */
import { makeCtx } from './fake-ctx';

export function fakeDocument(): Document {
  const make = (tag: string): unknown => {
    const el: Record<string, unknown> = {
      tagName: tag.toUpperCase(),
      style: {} as Record<string, string>,
      children: [] as unknown[],
      appendChild(c: unknown) { (this.children as unknown[]).push(c); return c; },
      remove() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      getAttribute: () => null,
      hasAttribute: () => false,
    };
    if (tag === 'canvas') {
      el.width = 0;
      el.height = 0;
      el.getContext = () => makeCtx().ctx;
    }
    return el;
  };
  return { createElement: (t: string) => make(t) } as unknown as Document;
}
