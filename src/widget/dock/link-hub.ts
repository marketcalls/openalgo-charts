/**
 * Panel Link Group Synchronization Hub.
 *
 * Coordinates color-coded link channels (red, blue, green, yellow, purple)
 * across charts, DOM ladders, watchlists, and order panels.
 */

import type { LinkColor, LinkContext } from './types';
import type { LinkChart, LinkGroup } from 'openalgo-charts';
import { instrument } from '../workspace-links';
import { selectionGroup, selectionMember } from './link-member';

export const LINK_COLORS: Record<LinkColor, { label: string; hex: string }> = {
  red: { label: 'Red Group', hex: '#ef5350' },
  blue: { label: 'Blue Group', hex: '#2962ff' },
  green: { label: 'Green Group', hex: '#26a69a' },
  yellow: { label: 'Yellow Group', hex: '#ffd600' },
  purple: { label: 'Purple Group', hex: '#ab47bc' },
};

export type LinkListener = (ctx: LinkContext) => void;

export class LinkHub {
  private readonly _panelGroups = new Map<string, LinkColor>();
  private readonly _listeners = new Map<string, LinkListener>();
  private readonly _groups = new Map<LinkColor, { engine: LinkGroup; leader: LinkChart; exchangeDeclared: boolean }>();
  private readonly _members = new Map<string, LinkChart>();
  private readonly _pending = new Set<string>();
  private _broadcasting = false;
  private _dismissPicker: (() => void) | null = null;

  public setPanelGroup(panelId: string, group: LinkColor | null): void {
    const previous = this._panelGroups.get(panelId), member = this._members.get(panelId);
    if (previous === group) return;
    if (previous && member) this._groups.get(previous)?.engine.remove(member);
    this._panelGroups.delete(panelId);
    if (previous && ![...this._panelGroups.values()].includes(previous)) {
      this._groups.get(previous)?.engine.destroy(); this._groups.delete(previous);
    }
    if (group === null) {
      return;
    } else {
      this._panelGroups.set(panelId, group);
      this.attach(panelId, group);
    }
  }

  public getPanelGroup(panelId: string): LinkColor | null {
    return this._panelGroups.get(panelId) ?? null;
  }

  public registerListener(panelId: string, listener: LinkListener): void {
    const group = this._panelGroups.get(panelId), old = this._members.get(panelId);
    if (group && old) this._groups.get(group)?.engine.remove(old);
    this._listeners.set(panelId, listener);
    this._members.set(panelId, selectionMember());
    if (group) this.attach(panelId, group);
  }

  public unregisterListener(panelId: string): void {
    this.setPanelGroup(panelId, null);
    this._listeners.delete(panelId);
    this._members.delete(panelId); this._pending.delete(panelId);
  }

  public broadcast(
    group: LinkColor,
    symbol: string,
    interval?: string | undefined,
    senderPanelId?: string,
    exchange?: string | undefined
  ): void {
    if (this._broadcasting || ![...this._panelGroups.values()].includes(group)) return;
    const owned = this.group(group);
    const sender = senderPanelId && this._panelGroups.get(senderPanelId) === group ? this._members.get(senderPanelId) : undefined;
    owned.exchangeDeclared = exchange !== undefined;
    this._broadcasting = true;
    try {
      owned.engine.setSymbol(sender ?? owned.leader, instrument(symbol, exchange ?? ''));
      if (interval !== undefined) owned.engine.setInterval(sender ?? owned.leader, interval);
      for (const id of this._pending) this.notify(id, group);
    } finally { this._pending.clear(); this._broadcasting = false; }
  }

  private group(color: LinkColor) {
    let group = this._groups.get(color);
    if (!group) {
      group = { engine: selectionGroup(), leader: selectionMember(), exchangeDeclared: false };
      group.engine.add(group.leader); this._groups.set(color, group);
    }
    return group;
  }

  private notify(id: string, color: LinkColor): void {
    const engine = this._groups.get(color)?.engine, key = engine?.symbol();
    if (!key) return;
    const [symbol, exchange] = JSON.parse(key) as [string, string];
    const ctx: LinkContext = { group: color, symbol };
    if (this._groups.get(color)?.exchangeDeclared) ctx.exchange = exchange;
    const interval = engine?.interval(); if (interval) ctx.interval = interval;
    try { this._listeners.get(id)?.(ctx); } catch { /* One host must not strand other linked panels. */ }
  }

  private attach(id: string, color: LinkColor): void {
    const member = this._members.get(id); if (!member) return;
    const follow = () => { if (this._broadcasting) this._pending.add(id); else this.notify(id, color); };
    const alreadyBroadcasting = this._broadcasting;
    this._broadcasting = true;
    try { this.group(color).engine.add(member, { onSymbol: follow, onInterval: follow }); }
    finally { this._broadcasting = alreadyBroadcasting; }
    if (!alreadyBroadcasting && this._pending.delete(id)) this.notify(id, color);
  }

  public renderLinkBadge(
    panelId: string,
    currentGroup: LinkColor | null,
    onSelect: (group: LinkColor | null) => void,
    doc?: Document
  ): HTMLElement {
    const d = doc ?? (typeof document !== 'undefined' ? document : (globalThis as unknown as { document: Document }).document);
    const badge = d.createElement('button');
    badge.type = 'button';
    badge.className = 'oac-dock-link-badge';
    badge.dataset.panelId = panelId;
    badge.dataset.group = currentGroup ?? '';
    badge.title = currentGroup
      ? `${LINK_COLORS[currentGroup].label} (Click to change)`
      : 'Link Group (Unlinked)';

    const dot = d.createElement('span');
    dot.className = 'oac-dock-link-dot';
    dot.style.backgroundColor = currentGroup ? LINK_COLORS[currentGroup].hex : 'transparent';
    dot.style.border = currentGroup ? 'none' : '1px solid rgba(255, 255, 255, 0.4)';
    badge.appendChild(dot);

    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.showGroupPicker(badge, (badge.dataset.group || null) as LinkColor | null, group => {
        this.updateLinkBadge(badge, group);
        onSelect(group);
      }, d);
    });

    return badge;
  }

  public updateLinkBadge(badge: HTMLElement, group: LinkColor | null): void {
    badge.dataset.group = group ?? '';
    badge.title = group ? `${LINK_COLORS[group].label} (Click to change)` : 'Link Group (Unlinked)';
    const dot = badge.firstElementChild as HTMLElement | null;
    if (dot) {
      dot.style.backgroundColor = group ? LINK_COLORS[group].hex : 'transparent';
      dot.style.border = group ? 'none' : '1px solid rgba(255, 255, 255, 0.4)';
    }
  }

  private showGroupPicker(
    anchor: HTMLElement,
    current: LinkColor | null,
    onSelect: (group: LinkColor | null) => void,
    doc?: Document
  ): void {
    const d = doc ?? anchor.ownerDocument ?? (typeof document !== 'undefined' ? document : (globalThis as unknown as { document: Document }).document);
    // Remove existing picker if any
    this._dismissPicker?.();
    const existing = d.querySelector('.oac-dock-link-picker');
    if (existing) existing.remove();

    const picker = d.createElement('div');
    picker.className = 'oac-dock-link-picker';

    const colors: (LinkColor | null)[] = [null, 'red', 'blue', 'green', 'yellow', 'purple'];

    for (const color of colors) {
      const item = d.createElement('button');
      item.type = 'button';
      item.className = 'oac-dock-link-picker-item';
      if (color === current) item.classList.add('is-active');

      const dot = d.createElement('span');
      dot.className = 'oac-dock-link-dot';
      dot.style.backgroundColor = color ? LINK_COLORS[color].hex : 'transparent';
      dot.style.border = color ? 'none' : '1px solid rgba(255, 255, 255, 0.4)';

      const label = d.createElement('span');
      label.textContent = color ? LINK_COLORS[color].label : 'No Link';

      item.append(dot, label);

      item.addEventListener('click', () => {
        close();
        anchor.focus();
        onSelect(color);
      });

      picker.appendChild(item);
    }

    const rect = anchor.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.left = `${Math.round(rect.left)}px`;
    picker.style.top = `${Math.round(rect.bottom + 4)}px`;
    picker.style.zIndex = '10000';

    const dismiss = (e: MouseEvent): void => {
      if (!picker.contains(e.target as Node) && e.target !== anchor) {
        close();
      }
    };
    const keydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { close(); anchor.focus(); }
    };
    const close = (): void => {
      picker.remove();
      d.removeEventListener('pointerdown', dismiss);
      d.removeEventListener('keydown', keydown);
      this._dismissPicker = null;
    };
    this._dismissPicker = close;
    d.addEventListener('pointerdown', dismiss);
    d.addEventListener('keydown', keydown);

    d.body.appendChild(picker);
  }

  public destroy(): void {
    this._dismissPicker?.();
    this._panelGroups.clear();
    this._listeners.clear();
    for (const group of this._groups.values()) group.engine.destroy();
    this._groups.clear(); this._members.clear(); this._pending.clear();
  }
}
