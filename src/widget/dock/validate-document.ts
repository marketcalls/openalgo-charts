import { isKnownInterval } from 'openalgo-charts';
import { isPlainObject, hasOnlyDataProperties } from '../../helpers/validate';
import { clampSplitRatio } from './model';
import type { DockNode, TerminalDocument, SerializedPanelInfo } from './types';

const TYPES = ['chart', 'dom', 'watchlist', 'orders', 'positions', 'news', 'data', 'objects', 'custom'];
const GROUPS = ['red', 'blue', 'green', 'yellow', 'purple'];
const MAX_PANELS = 128, MAX_BYTES = 2 * 1024 * 1024;
const PRIVATE = /^(?:apikey|secret|clientsecret|apisecret|password|token|accesstoken|refreshtoken|authorization|credentials|armed|oneclick|feed|broker|account|accountid|orders|positions|balances)$/;
const validString = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const fail = (): never => { throw new Error('Invalid terminal workspace document'); };

/** A bounded copy before reading fields: getters, cycles and runtime objects never execute. */
function jsonCopy(input: unknown): unknown {
  let count = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number, panelIds = false): unknown => {
    if (++count > 50000 || depth > 32) return fail();
    if (typeof value === 'string' && value.length > MAX_BYTES) return fail();
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || ancestors.has(value) || !hasOnlyDataProperties(value)) return fail();
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      if (value.length > 20000) return fail();
      const items: unknown[] = [];
      for (let i = 0; i < value.length; i++) items.push(copy(value[i], depth + 1));
      result = items;
    } else {
      if (!isPlainObject(value)) return fail();
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) || (!panelIds && PRIVATE.test(key.toLowerCase().replace(/[^a-z0-9]/g, '')))) continue;
        if (item !== undefined) out[key] = copy(item, depth + 1, key === 'panels' && depth === 0);
      }
      result = out;
    }
    ancestors.delete(value); return result;
  };
  if (typeof input === 'string') {
    if (input.length > MAX_BYTES) return fail();
    input = JSON.parse(input) as unknown;
  }
  const result = copy(input, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES) return fail();
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return fail();
  return value;
}

function panelState(info: SerializedPanelInfo): void {
  if (info.state === undefined || info.state === null || info.type === 'custom') return;
  const state = record(info.state);
  for (const key of ['symbol', 'exchange', 'sourceChart']) if (state[key] !== undefined
    && (typeof state[key] !== 'string' || (state[key] as string).length > 256)) fail();
  if (state.interval !== undefined && (typeof state.interval !== 'string' || !isKnownInterval(state.interval))) fail();
  if (state.groupBy !== undefined && (!Number.isInteger(state.groupBy) || Number(state.groupBy) < 1 || Number(state.groupBy) > 1000)) fail();
  if (state.linkGroup !== undefined && state.linkGroup !== null && !GROUPS.includes(String(state.linkGroup))) fail();
  if (state.chartState !== undefined) {
    const chart = record(state.chartState);
    if (chart.version !== undefined && chart.version !== 1) fail();
    if (chart.symbol !== undefined && typeof chart.symbol !== 'string') fail();
    if (chart.interval !== undefined && (typeof chart.interval !== 'string' || !isKnownInterval(chart.interval))) fail();
    if (chart.chart !== undefined) record(chart.chart);
  }
  if (info.type === 'orders') {
    if (state.kind !== undefined && state.kind !== 'ticket' && state.kind !== 'book') fail();
    // Execution preferences and order drafts are never restored from workspace chrome.
    for (const key of ['qty', 'price', 'stopLoss', 'takeProfit', 'draft', 'clientToken', 'mode']) delete state[key];
  }
}

/** Validate the whole document before a factory mounts or any existing panel changes. */
export function parseTerminalDocument(raw: unknown): TerminalDocument | null {
  try {
    const doc = record(jsonCopy(raw));
    if (doc.version !== 1 || !Array.isArray(doc.floating)) return null;
    const panels: TerminalDocument['panels'] = Object.create(null) as TerminalDocument['panels'];
    const entries = Object.entries(record(doc.panels));
    if (entries.length > MAX_PANELS) return null;
    for (const [id, value] of entries) {
      const panel = record(value);
      if (!validString(id) || !TYPES.includes(String(panel.type)) || !validString(panel.title, 512)
        || (panel.linkGroup !== undefined && panel.linkGroup !== null && !GROUPS.includes(String(panel.linkGroup)))) return null;
      const info = panel as unknown as SerializedPanelInfo; panelState(info); panels[id] = info;
    }
    const ids = new Set<string>(), usedPanels = new Set<string>();
    const use = (id: unknown): string => {
      if (!validString(id) || !panels[id] || usedPanels.has(id)) return fail();
      usedPanels.add(id); return id;
    };
    const node = (value: unknown): DockNode => {
      const item = record(value);
      if (!validString(item.id) || ids.has(item.id)) return fail();
      ids.add(item.id);
      if (item.type === 'panel') return { type: 'panel', id: item.id, panelId: use(item.panelId) };
      if (item.type === 'tabs') {
        if (!Array.isArray(item.panels) || !item.panels.length || item.panels.length > MAX_PANELS) return fail();
        const members = item.panels.map(use);
        if (typeof item.active !== 'string' || !members.includes(item.active)) return fail();
        return { type: 'tabs', id: item.id, panels: members, active: item.active };
      }
      if (item.type !== 'split' || !Array.isArray(item.children) || item.children.length !== 2
        || !['horizontal', 'vertical'].includes(String(item.direction)) || typeof item.ratio !== 'number'
        || item.ratio <= 0 || item.ratio >= 1) return fail();
      // Clamped to the divider's bounds, so a restored split never reports a value outside them.
      return { type: 'split', id: item.id, direction: item.direction as 'horizontal' | 'vertical', ratio: clampSplitRatio(item.ratio), children: item.children.map(node) };
    };
    const layout = doc.layout === null ? null : node(doc.layout);
    if (doc.floating.length > MAX_PANELS) return null;
    const floating = doc.floating.map(value => {
      const f = record(value);
      if (!validString(f.id) || ids.has(f.id)) return fail(); ids.add(f.id);
      const panelId = use(f.panelId);
      for (const key of ['x', 'y', 'width', 'height', 'zIndex']) if (typeof f[key] !== 'number' || !Number.isFinite(f[key])) fail();
      if (Number(f.width) <= 0 || Number(f.height) <= 0 || Number(f.width) > 16384 || Number(f.height) > 16384
        || Math.abs(Number(f.x)) > 100000 || Math.abs(Number(f.y)) > 100000 || !Number.isInteger(f.zIndex) || Number(f.zIndex) < 0) fail();
      return { id: f.id, panelId, x: Number(f.x), y: Number(f.y), width: Number(f.width), height: Number(f.height), zIndex: Number(f.zIndex) };
    });

    for (const info of Object.values(panels)) {
      const source = (info.state as { sourceChart?: unknown } | null)?.sourceChart;
      if (source !== undefined && (typeof source !== 'string' || panels[source]?.type !== 'chart')) return null;
    }
    return { version: 1, layout, floating, panels };
  } catch { return null; }
}
