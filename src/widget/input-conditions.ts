/**
 * The reader for a descriptor's `activeWhen` and `visibleWhen`.
 *
 * It lives in the widget tier rather than beside the types in the base: the
 * calculation never consults a condition, so a host that only draws studies
 * should not carry the reader. A host with its own form imports it from here,
 * which is what the reference host does, so both forms answer alike.
 */
import type { IndicatorInputCondition, IndicatorInputPresentation } from 'openalgo-charts';

/** Whether one input is shown and can be edited, given the current settings. */
export interface InputState {
  /** False while `visibleWhen` fails, or an input it reads is hidden. */
  visible: boolean;
  /** False while `activeWhen` fails, or an input it reads is hidden or inactive. */
  active: boolean;
  /** The keys `activeWhen` reads, in the order it names them, for a reason naming them. */
  dependsOn: readonly string[];
}

type Values = Readonly<Record<string, unknown>>;

const own = (values: Values, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined;

/**
 * Whether `condition` holds for `values`. Only own settings are read, so an
 * inherited name such as `constructor` never satisfies one. A shape it cannot
 * read holds, so a malformed descriptor never locks a user out of an input.
 */
export function inputConditionMet(condition: IndicatorInputCondition | undefined, values: Values): boolean {
  if (condition === null || typeof condition !== 'object') return true;
  const c = condition as Partial<Record<'all' | 'any' | 'is' | 'isNot', unknown>> & { key?: unknown };
  if (Array.isArray(c.all)) return c.all.every(item => inputConditionMet(item as IndicatorInputCondition, values));
  if (Array.isArray(c.any)) return c.any.some(item => inputConditionMet(item as IndicatorInputCondition, values));
  if (typeof c.key !== 'string') return true;
  const value = own(values, c.key);
  // includes() is SameValueZero, so a NaN setting can still be matched.
  const listed = (wanted: unknown): boolean => (Array.isArray(wanted) ? wanted : [wanted]).includes(value);
  if ('is' in c) return listed(c.is);
  if ('isNot' in c) return !listed(c.isNot);
  return true;
}

/** Every key a condition reads, once each, in the order it names them. */
function keysOf(condition: unknown, out: string[] = []): string[] {
  if (condition === null || typeof condition !== 'object') return out;
  const c = condition as { all?: unknown; any?: unknown; key?: unknown };
  const nested = Array.isArray(c.all) ? c.all : Array.isArray(c.any) ? c.any : null;
  if (nested !== null) for (const item of nested) keysOf(item, out);
  else if (typeof c.key === 'string' && !out.includes(c.key)) out.push(c.key);
  return out;
}

/**
 * The state of every input in `inputs`, keyed by input key.
 *
 * An input a condition reads counts for its own state as well as its value: a
 * control hidden behind a switch cannot also be what shows a third, and one
 * nobody can edit cannot be what enables another. A key outside `inputs` (a
 * setting on another tab) is decided by its value alone, and so is a key met
 * again while it is being decided, so a cycle in a descriptor ends.
 */
export function inputStates(
  inputs: readonly (IndicatorInputPresentation & { key: string })[], values: Values,
): Map<string, InputState> {
  const byKey = new Map(inputs.map(input => [input.key, input]));
  const out = new Map<string, InputState>();
  const pending = new Set<string>();
  const resolve = (key: string): InputState | undefined => {
    const input = byKey.get(key);
    if (input === undefined || pending.has(key)) return undefined;
    let state = out.get(key);
    if (state !== undefined) return state;
    pending.add(key);
    const dependsOn = keysOf(input.activeWhen);
    const visible = inputConditionMet(input.visibleWhen, values)
      && keysOf(input.visibleWhen).every(k => resolve(k)?.visible !== false);
    const active = inputConditionMet(input.activeWhen, values)
      && dependsOn.every(k => { const s = resolve(k); return s === undefined || (s.visible && s.active); });
    pending.delete(key);
    state = { visible, active, dependsOn };
    out.set(key, state);
    return state;
  };
  for (const input of inputs) resolve(input.key);
  return out;
}
