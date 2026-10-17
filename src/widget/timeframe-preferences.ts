import { intervalParts, registerInterval, resolveInterval, tryResolveInterval } from 'openalgo-charts';
import type { StorageLike, WidgetStorage } from './widget-storage';

/** Clock and calendar units accepted by the custom interval dialog. */
export type TimeframeUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'quarters' | 'years';
const UNITS: Readonly<Record<TimeframeUnit, string>> = { seconds: 's', minutes: 'm', hours: 'h', days: 'D', weeks: 'W', months: 'M', quarters: 'Q', years: 'Y' };

/** Create a bounded positive interval token without accepting fractional candles. */
export function customTimeframeCode(count: number, unit: TimeframeUnit): string {
  if (!Number.isInteger(count) || count < 1 || count > 100_000 || !Object.prototype.hasOwnProperty.call(UNITS, unit)) throw new Error('Enter a whole number between 1 and 100000');
  const token = UNITS[unit];
  return valid(`${count === 1 && /^[DWMQY]$/.test(token) ? '' : count}${token}`, true);
}

function valid(code: string, custom = false): string {
  const text = code.trim(), match = /^(\d*)([smhDWMQY])$/.exec(text);
  if (custom && (!match || (match[1] === '' && /[smh]/.test(match[2]!)))) throw new Error('Use a positive clock or calendar interval');
  if (match) {
    const count = match[1] === '' ? 1 : Number(match[1]);
    if (!Number.isInteger(count) || count < 1 || count > 100_000) throw new Error('Interval is out of range');
    if (!tryResolveInterval(text) && /^[MQY]$/.test(match[2]!)) {
      const unit = match[2] === 'M' ? 'month' : match[2] === 'Q' ? 'quarter' : 'year';
      registerInterval({ code: text, bucketing: { mode: 'calendar', unit, count } });
    }
  }
  const found = resolveInterval(text);
  if (found.bucketing.mode === 'interval' && (!Number.isSafeInteger(found.bucketing.seconds) || found.bucketing.seconds <= 0)) throw new Error('Unknown interval');
  return text;
}

/** Saved panes can still use a calendar choice removed from the visible menu. */
export function restoreTimeframeCode(code: unknown): void {
  if (typeof code !== 'string' || !/^(\d*)([MQY])$/.test(code)) return;
  try { valid(code, true); } catch { /* Invalid saved codes keep the existing fallback. */ }
}

export function timeframeIdentity(code: string): string {
  const parts = intervalParts(code);
  return parts && parts.unit !== 'other' ? `${parts.unit}:${parts.multiplier}` : code;
}

function choices(value: unknown, custom: boolean): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid timeframe preferences');
  const seen = new Set<string>(), out: string[] = [];
  for (const code of value) {
    if (typeof code !== 'string' || code.length > 40) throw new Error('Invalid timeframe code');
    const checked = valid(code, custom), key = timeframeIdentity(checked);
    if (!seen.has(key)) { seen.add(key); out.push(checked); }
  }
  return out;
}

export interface TimeframePreferencesOptions {
  storage: StorageLike | null;
  key: string;
  defaults: readonly string[];
}

/** Share one handle across panes. Selection belongs to each pane, never this store. */
export interface TimeframePreferences {
  favorites(): readonly string[];
  custom(): readonly string[];
  toggle(code: string): void;
  addCustom(code: string): void;
  removeCustom(code: string): void;
  subscribe(listener: () => void): () => void;
  /** Re-read persistence after an asynchronous host store loads; keep local edits. */
  reload(): void;
  destroy(): void;
}

/** Versioned best-effort persistence; blocked storage retains usable in-memory state. */
export function createTimeframePreferences(options: TimeframePreferencesOptions): TimeframePreferences {
  let favorites = choices([...options.defaults], false), custom: string[] = [], destroyed = false, edited = false;
  const listeners = new Set<() => void>();
  const read = (): void => { try {
    const value: unknown = JSON.parse(options.storage?.getItem(options.key) ?? 'null');
    if (value && typeof value === 'object' && 'version' in value && value.version === 1 && 'custom' in value && 'favorites' in value) {
      const savedCustom = choices(value.custom, true), savedFavorites = choices(value.favorites, false);
      custom = savedCustom; favorites = savedFavorites;
    }
  } catch { /* Malformed or blocked persistence must not prevent chart startup. */ } };
  read();
  const save = (): void => {
    if (destroyed) return;
    edited = true;
    try { options.storage?.setItem(options.key, JSON.stringify({ version: 1, favorites, custom })); } catch { /* Keep the current session usable. */ }
    for (const listener of listeners) listener();
  };
  return {
    favorites: () => [...favorites], custom: () => [...custom],
    toggle(code) {
      if (destroyed) return;
      const checked = valid(code), key = timeframeIdentity(checked), exists = favorites.some(item => timeframeIdentity(item) === key);
      if (!exists && favorites.length >= 128) throw new Error('Too many favorite intervals');
      favorites = exists ? favorites.filter(item => timeframeIdentity(item) !== key) : [...favorites, checked]; save();
    },
    addCustom(code) {
      if (destroyed) return;
      const checked = valid(code, true), key = timeframeIdentity(checked);
      if (custom.some(item => timeframeIdentity(item) === key)) return;
      if (custom.length >= 128) throw new Error('Too many custom intervals');
      custom.push(checked); save();
    },
    removeCustom(code) {
      if (destroyed) return;
      const key = timeframeIdentity(code);
      if (!custom.some(item => timeframeIdentity(item) === key)) return;
      custom = custom.filter(item => timeframeIdentity(item) !== key);
      favorites = favorites.filter(item => timeframeIdentity(item) !== key); save();
    },
    subscribe(listener) { if (!destroyed) listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload() { if (destroyed || edited) return; read(); for (const listener of listeners) listener(); },
    destroy() { destroyed = true; listeners.clear(); },
  };
}

/** Bridge the widget's async-loaded mirror without introducing another durable store. */
export function storedTimeframePreferences(storage: WidgetStorage, defaults: readonly string[]): TimeframePreferences {
  return createTimeframePreferences({ defaults, key: 'timeframes', storage: {
    getItem: key => { const value = storage.get(key); return value === null ? null : JSON.stringify(value); },
    setItem: (key, value) => { storage.set(key, JSON.parse(value) as unknown); },
    removeItem: key => storage.remove(key),
  } });
}
