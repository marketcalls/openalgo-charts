/**
 * The widget keymap: the chord grammar, scope resolution, layering, the text
 * field rule, and above all conflict detection, because the draw tier's tool
 * chords and the engine's own keymap collide on two chords and the panel has
 * to say so.
 */
import { describe, it, expect, vi } from 'vitest';
import { ShortcutManager } from '../src/input/shortcuts';
import { drawingShortcuts } from '../src/draw/index';
import {
  Keymap, parseKeyCombo, eventKeyCombo, formatKeyCombo, fromChartCombo,
  type KeyEventLike, type KeyScope,
} from '../src/widget/keymap';
import { fakeWidgetDocument, fireKey } from './helpers/fake-dom-widget';

const key = (k: string, extra: Partial<KeyEventLike> = {}): KeyEventLike => ({ key: k, ...extra });

describe('parseKeyCombo', () => {
  it('canonicalises modifier order, case and aliases', () => {
    expect(parseKeyCombo('shift+alt+t')).toBe('Alt+Shift+t');
    expect(parseKeyCombo('Ctrl+Z')).toBe('Mod+z');
    expect(parseKeyCombo('Cmd+Shift+z')).toBe('Mod+Shift+z');
    expect(parseKeyCombo('Meta+ArrowLeft')).toBe('Mod+ArrowLeft');
    expect(parseKeyCombo('Esc')).toBe('Escape');
    expect(parseKeyCombo('Del')).toBe('Delete');
    expect(parseKeyCombo('Left')).toBe('ArrowLeft');
  });

  it('drops Shift from a symbol or digit, since the character already says it', () => {
    expect(parseKeyCombo('Shift+?')).toBe('?');
    expect(parseKeyCombo('?')).toBe('?');
    expect(parseKeyCombo('Shift+1')).toBe('1');
    expect(parseKeyCombo('Ctrl++')).toBe('Mod++');
  });

  it('rejects what is not a chord', () => {
    expect(parseKeyCombo('')).toBe('');
    expect(parseKeyCombo('Foo+x')).toBe('');
    expect(parseKeyCombo('Shift')).toBe('');
    expect(parseKeyCombo('Ctrl+')).toBe('');
  });
});

describe('eventKeyCombo', () => {
  it('reads the event the way a binding is written', () => {
    expect(eventKeyCombo(key('t', { altKey: true }))).toBe('Alt+t');
    expect(eventKeyCombo(key('Z', { shiftKey: true, ctrlKey: true }))).toBe('Mod+Shift+z');
    expect(eventKeyCombo(key('z', { metaKey: true }))).toBe('Mod+z');
    expect(eventKeyCombo(key('?', { shiftKey: true }))).toBe('?');
    expect(eventKeyCombo(key(' '))).toBe('Space');
    expect(eventKeyCombo(key('ArrowLeft', { shiftKey: true }))).toBe('Shift+ArrowLeft');
  });

  it('recovers the letter from the physical key when Alt turned it into a symbol', () => {
    expect(eventKeyCombo(key('†', { altKey: true, code: 'KeyT' }))).toBe('Alt+t');
  });

  it('ignores a bare modifier press', () => {
    expect(eventKeyCombo(key('Shift', { shiftKey: true }))).toBe('');
    expect(eventKeyCombo(key('Control', { ctrlKey: true }))).toBe('');
    expect(eventKeyCombo(key(''))).toBe('');
  });
});

describe('formatKeyCombo and fromChartCombo', () => {
  it('formats for the platform', () => {
    expect(formatKeyCombo('Mod+Shift+z', false)).toBe('Ctrl+Shift+Z');
    expect(formatKeyCombo('Mod+Shift+z', true)).toBe('Cmd+Shift+Z');
    expect(formatKeyCombo('Alt+t', true)).toBe('Opt+T');
    expect(formatKeyCombo('Escape', false)).toBe('Esc');
    expect(formatKeyCombo('?', false)).toBe('?');
    expect(formatKeyCombo('nonsense+', false)).toBe('');
  });

  it('translates the engine code-based combos into the key form', () => {
    expect(fromChartCombo('Alt+KeyV')).toBe('Alt+v');
    expect(fromChartCombo('Mod+Shift+KeyS')).toBe('Mod+Shift+s');
    expect(fromChartCombo('Shift+Equal')).toBe('+');
    expect(fromChartCombo('Digit0')).toBe('0');
    expect(fromChartCombo('ArrowLeft')).toBe('ArrowLeft');
    expect(fromChartCombo('Ctrl+KeyC')).toBe('Mod+c');
  });
});

describe('Keymap.handle', () => {
  const claimed = (): KeyEventLike & { prevented: boolean; stopped: boolean } => {
    const e = { key: 't', altKey: true, prevented: false, stopped: false } as KeyEventLike & { prevented: boolean; stopped: boolean };
    e.preventDefault = () => { e.prevented = true; };
    e.stopPropagation = () => { e.stopped = true; };
    return e;
  };

  it('runs the binding, prevents and stops the event, and reports the claim', () => {
    const km = new Keymap({ isMac: false });
    const action = vi.fn();
    km.register('Alt+T', action);
    const e = claimed();
    expect(km.handle(e)).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(e.prevented).toBe(true);
    expect(e.stopped).toBe(true);
    expect(km.handle(key('t'))).toBe(false);
  });

  it('a declining action leaves the key to the next layered binding, then to nobody', () => {
    const km = new Keymap();
    const order: string[] = [];
    km.register('Escape', () => { order.push('first'); return false; }, 'global', { label: 'first' });
    km.register('Escape', () => { order.push('second'); }, 'global', { label: 'second', layered: true });
    expect(km.handle(key('Escape'))).toBe(true);
    expect(order).toEqual(['first', 'second']);
    expect(km.conflicts()).toEqual([]);
    const lone = new Keymap();
    lone.register('Escape', () => false);
    expect(lone.handle(key('Escape'))).toBe(false);
  });

  it('tries scopes in the order the resolver gives them and skips inactive ones', () => {
    let scopes: KeyScope[] = ['global'];
    const km = new Keymap({ scopes: () => scopes });
    const hits: string[] = [];
    km.register('ArrowDown', () => { hits.push('rail'); }, 'rail');
    km.register('ArrowDown', () => { hits.push('widget'); }, 'widget');
    expect(km.handle(key('ArrowDown'))).toBe(false);
    scopes = ['widget', 'global'];
    km.handle(key('ArrowDown'));
    scopes = ['rail', 'widget', 'global'];
    km.handle(key('ArrowDown'));
    expect(hits).toEqual(['widget', 'rail']);
  });

  it('stays out of text fields unless a binding asks to be let in', () => {
    const km = new Keymap();
    const action = vi.fn();
    const escape = vi.fn();
    km.register('Mod+Z', action);
    km.register('Escape', escape, 'global', { inText: true });
    const input = { tagName: 'INPUT', type: 'text' };
    expect(km.handle(key('z', { ctrlKey: true, target: input }))).toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(km.handle(key('Escape', { target: input }))).toBe(true);
    expect(escape).toHaveBeenCalled();
    // A checkbox is an input that takes no typing, so chords stay live over it.
    expect(km.handle(key('z', { ctrlKey: true, target: { tagName: 'INPUT', type: 'checkbox' } }))).toBe(true);
  });

  it('honours a when gate without declining for the others', () => {
    const km = new Keymap();
    let open = false;
    const gated = vi.fn();
    const fallback = vi.fn();
    km.register('Enter', gated, 'global', { when: () => open });
    km.register('Enter', fallback, 'global', { layered: true });
    km.handle(key('Enter'));
    expect(gated).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
    open = true;
    km.handle(key('Enter'));
    expect(gated).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('throws at registration for a binding that could never fire', () => {
    const km = new Keymap();
    expect(() => km.register('Foo+x', () => {})).toThrow(/not a key binding/);
  });
});

describe('conflicts', () => {
  it('records a second binding on the same chord and scope, and forgets it when either goes', () => {
    const km = new Keymap({ isMac: false });
    const seen = vi.fn();
    km.onConflict(seen);
    km.register('Alt+H', () => {}, 'widget', { label: 'Horizontal Line' });
    const off = km.register('Alt+H', () => {}, 'widget', { label: 'Hide panel' });
    expect(km.conflicts()).toEqual([{ combo: 'Alt+h', scope: 'widget', kept: 'Horizontal Line', shadowed: 'Hide panel', source: 'widget' }]);
    expect(seen).toHaveBeenCalledTimes(1);
    // Different scopes are deliberate layering, not a collision.
    km.register('Alt+H', () => {}, 'rail', { label: 'rail thing' });
    expect(km.conflicts()).toHaveLength(1);
    off();
    expect(km.conflicts()).toEqual([]);
  });

  it('finds the two chords where the draw tier and the engine keymap disagree', () => {
    const km = new Keymap({ isMac: false, chart: new ShortcutManager() });
    for (const [id, chord] of Object.entries(drawingShortcuts())) km.register(chord, () => {}, 'widget', { label: id, group: 'Drawing tools' });
    const chartSide = km.conflicts().filter((c) => c.source === 'chart');
    const shadowed = chartSide.map((c) => `${c.combo}:${c.shadowed}:${c.kept}`).sort();
    expect(shadowed).toEqual(['Alt+h:Toggle horizontal grid:horizontal-line', 'Alt+v:Toggle vertical grid:vertical-line']);
    const chart = km.describe().find((g) => g.group === 'Chart');
    expect(chart).toBeDefined();
    const grid = chart?.rows.find((r) => r.label === 'Toggle vertical grid');
    expect(grid?.shadowedBy).toBe('vertical-line');
    expect(chart?.rows.find((r) => r.label === 'Fit content')?.shadowedBy).toBeUndefined();
  });

  it('does not count a rail or overlay binding as shadowing the chart', () => {
    const km = new Keymap({ chart: new ShortcutManager() });
    km.register('ArrowDown', () => {}, 'rail', { label: 'Next tool' });
    km.register('Escape', () => {}, 'overlay');
    expect(km.conflicts()).toEqual([]);
  });
});

describe('attach', () => {
  it('claims in the capture phase so a bubble listener on the document never sees the chord', () => {
    const doc = fakeWidgetDocument();
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    const km = new Keymap();
    const armed = vi.fn();
    km.register('Alt+T', armed);
    const detach = km.attach(doc as unknown as Document);
    const docSaw = vi.fn();
    doc.addEventListener('keydown', docSaw);
    fireKey(el, 't', { altKey: true });
    expect(armed).toHaveBeenCalledTimes(1);
    expect(docSaw).not.toHaveBeenCalled();
    fireKey(el, 'x');
    expect(docSaw).toHaveBeenCalledTimes(1);
    detach();
    fireKey(el, 't', { altKey: true });
    expect(armed).toHaveBeenCalledTimes(1);
  });

  it('describe groups the visible bindings and leaves hidden ones out', () => {
    const km = new Keymap({ isMac: false });
    km.register('Mod+Z', () => {}, 'widget', { label: 'Undo', group: 'Drawing' });
    km.register('Mod+Y', () => {}, 'widget', { label: 'Redo', group: 'Drawing', hidden: true });
    km.register('?', () => {}, 'widget', { label: 'Keyboard shortcuts' });
    expect(km.describe()).toEqual([
      { group: 'Drawing', rows: [{ label: 'Undo', combo: 'Mod+z', display: 'Ctrl+Z' }] },
      { group: 'Widget', rows: [{ label: 'Keyboard shortcuts', combo: '?', display: '?' }] },
    ]);
  });
});
