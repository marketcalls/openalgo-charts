import type { StorageLike } from '../context';
import { parseTerminalDocument } from './validate-document';
import type { FloatingPanelState, TerminalDocument, TerminalPanel } from './types';

export const TERMINAL_STORAGE_KEY = 'openalgo_terminal_v1';

/** Compatibility helpers for a host's older synchronous, unnamespaced layouts. */
export function saveTerminalDocument(storage: StorageLike, key: string, doc: TerminalDocument): void {
  const valid = parseTerminalDocument(doc);
  if (!valid) return;
  try { storage.setItem(key, JSON.stringify(valid)); } catch { /* The host owns storage reporting. */ }
}

export function loadTerminalDocument(storage: StorageLike, key: string): TerminalDocument | null {
  try { const raw = storage.getItem(key); return raw === null ? null : parseTerminalDocument(raw); } catch { return null; }
}

export function buildDocumentFromWorkspace(
  layout: TerminalDocument['layout'],
  floatingWindows: FloatingPanelState[],
  panelMap: Map<string, TerminalPanel>
): TerminalDocument {
  const panels: TerminalDocument['panels'] = {};

  for (const [id, panel] of panelMap.entries()) {
    panels[id] = {
      type: panel.type,
      title: panel.title,
      linkGroup: panel.linkGroup ?? null,
      state: panel.state?.(),
    };
  }

  return {
    version: 1,
    layout,
    floating: [...floatingWindows],
    panels,
  };
}
