import { describe, expect, it, vi } from 'vitest';
import { createTerminalWorkspace } from '../src/widget/dock/controller';
import { TERMINAL_CSS } from '../src/widget/dock/styles';
import { fakeWidgetDocument } from './helpers/fake-dom-widget';
import type { TerminalPanel } from '../src/widget/dock/types';

/** Trading semantics (buy / sell / heat), deliberately the same under every host theme. */
const TRADING_COLOURS = new Set(['#ef5350', '#26a69a', '#2bbbad', '#f44336', '#2dd4bf', '#fb7185', '#fff']);

const panel = (id: string): TerminalPanel => ({
  id, type: 'custom', title: id,
  mount: () => ({ destroy: vi.fn(), resize: vi.fn() }),
});

describe('terminal colour tokens', () => {
  it('reads every chrome colour from a --oac-term-* token with the original dark fallback', () => {
    // Strip var(--oac-term-x, <fallback>) and see what literal colours remain.
    const bare = TERMINAL_CSS
      .replace(/var\(--oac-term-[a-z-]+, (?:#[0-9a-fA-F]{3,6}|rgba\([^)]*\))\)/g, 'TOKEN')
      .match(/#[0-9a-fA-F]{3,6}\b|rgba\([^)]*\)/g) ?? [];
    const untokened = bare.filter(c => !TRADING_COLOURS.has(c.toLowerCase()) && !c.startsWith('rgba(239, 83, 80')
      && !c.startsWith('rgba(38, 166, 154') && !c.startsWith('rgba(45, 212, 191') && !c.startsWith('rgba(251, 113, 133'));
    expect(untokened).toEqual([]);
    expect(TERMINAL_CSS).toContain('var(--oac-term-bg, #0b1017)');
    expect(TERMINAL_CSS).toContain('var(--oac-term-accent, #38bdf8)');
  });

  it('ships no built-in theme: a host supplies its own tokens', () => {
    expect(TERMINAL_CSS).not.toMatch(/data-oac-theme/);
    expect(TERMINAL_CSS).not.toMatch(/--oac-term-[a-z-]+\s*:/); // declares no token values itself
  });
});

describe('onLayoutChange without persistence', () => {
  it('reports adds, docks and removals to a host that keeps its own layout state', async () => {
    const doc = fakeWidgetDocument();
    const container = doc.createElement('div');
    const onLayoutChange = vi.fn();
    const ws = createTerminalWorkspace(container as unknown as HTMLElement, { onLayoutChange });

    ws.addPanel(panel('a'));
    await ws.flush();
    expect(onLayoutChange).toHaveBeenCalledTimes(1);
    expect(Object.keys(onLayoutChange.mock.calls[0][0].panels)).toEqual(['a']);

    ws.addPanel(panel('b'), 'a', 'right');
    await ws.flush();
    expect(Object.keys(onLayoutChange.mock.lastCall![0].panels).sort()).toEqual(['a', 'b']);

    ws.removePanel('a');
    await ws.flush();
    expect(Object.keys(onLayoutChange.mock.lastCall![0].panels)).toEqual(['b']);
    ws.destroy();
  });

  it('stays silent with neither persistence nor a listener', async () => {
    const doc = fakeWidgetDocument();
    const ws = createTerminalWorkspace(doc.createElement('div') as unknown as HTMLElement);
    ws.addPanel(panel('a'));
    await expect(ws.flush()).resolves.toBeUndefined();
    ws.destroy();
  });
});
