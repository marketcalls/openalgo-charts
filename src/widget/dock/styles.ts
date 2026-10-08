/**
 * Terminal docking and standalone DOM stylesheet.
 */

export const TERMINAL_CSS = `
.oac-terminal {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: var(--oac-term-bg, #0b1017);
  color: var(--oac-term-text, #e1e3e6);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

/* Only the draggable chrome refuses text selection; panel content stays selectable. */
.oac-dock-panel-header,
.oac-dock-tabs-header,
.oac-dock-floating-header,
.oac-dock-splitter,
.oac-dock-resize-handle {
  user-select: none;
  -webkit-user-select: none;
}

.oac-dock-tree {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  overflow: hidden;
}

/* Split Panes */
.oac-dock-split {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.oac-dock-split--horizontal {
  flex-direction: row;
}

.oac-dock-split--vertical {
  flex-direction: column;
}

.oac-dock-split-pane {
  position: relative;
  overflow: hidden;
  min-width: 0;
  min-height: 0;
}

/* Splitter Divider */
.oac-dock-splitter {
  position: relative;
  background-color: var(--oac-term-splitter, #1c2026);
  flex-shrink: 0;
  z-index: 10;
  transition: background-color 150ms ease;
  outline: none;
  touch-action: none;
}

.oac-dock-splitter:focus-visible {
  outline: 2px solid var(--oac-term-accent, #38bdf8);
  outline-offset: -1px;
}

.oac-dock-splitter:hover,
.oac-dock-splitter:focus-visible,
.oac-dock-splitter.is-dragging {
  background-color: var(--oac-term-accent, #38bdf8);
}

.oac-dock-splitter--horizontal {
  width: 5px;
  cursor: col-resize;
}

.oac-dock-splitter--vertical {
  height: 5px;
  cursor: row-resize;
}

.oac-dock-splitter-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background-color: var(--oac-term-overlay, rgba(255, 255, 255, 0.2));
  border-radius: 2px;
}

.oac-dock-splitter--horizontal .oac-dock-splitter-handle {
  width: 3px;
  height: 24px;
}

.oac-dock-splitter--vertical .oac-dock-splitter-handle {
  width: 24px;
  height: 3px;
}

/* Panel Containers */
.oac-dock-panel {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background-color: var(--oac-term-panel, #101721);
  border: 1px solid var(--oac-term-border, #20242c);
  box-sizing: border-box;
}

.oac-dock-panel-header {
  height: 32px;
  min-height: 32px;
  background-color: var(--oac-term-header, #141e2b);
  border-bottom: 1px solid var(--oac-term-border-strong, #242832);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--oac-term-text-secondary, #c4c7d0);
  cursor: grab;
}

.oac-dock-panel-header:active {
  cursor: grabbing;
}

.oac-dock-panel-title-area {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.oac-dock-panel-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.oac-dock-panel-body {
  flex: 1;
  position: relative;
  width: 100%;
  height: calc(100% - 32px);
  overflow: hidden;
  min-width: 0;
  min-height: 0;
}

/* Tabs */
.oac-dock-tabs-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: var(--oac-term-panel, #101721);
  border: 1px solid var(--oac-term-border, #20242c);
  box-sizing: border-box;
}

.oac-dock-tabs-header {
  height: 32px;
  min-height: 32px;
  background-color: var(--oac-term-header, #141e2b);
  border-bottom: 1px solid var(--oac-term-border-strong, #242832);
  display: flex;
  align-items: center;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.oac-dock-tabs-header::-webkit-scrollbar {
  display: none;
}

.oac-dock-tab {
  height: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--oac-term-muted, #8b90a0);
  border-right: 1px solid var(--oac-term-border, #20242c);
  cursor: pointer;
  white-space: nowrap;
  transition: color 120ms ease, background-color 120ms ease;
  background: transparent;
  border-top: 2px solid transparent;
}

.oac-dock-tab:hover {
  background-color: var(--oac-term-hover, #1e222a);
  color: var(--oac-term-text, #e1e3e6);
}

.oac-dock-tab.is-active {
  background-color: var(--oac-term-panel, #101721);
  color: var(--oac-term-text-strong, #fff);
  border-top: 2px solid var(--oac-term-accent, #38bdf8);
}

.oac-dock-tab-close {
  background: transparent;
  border: none;
  color: var(--oac-term-muted, #6c7182);
  font-size: 14px;
  cursor: pointer;
  padding: 0 2px;
  border-radius: 2px;
}

.oac-dock-tab-close:hover {
  color: #ef5350;
  background-color: rgba(239, 83, 80, 0.15);
}

.oac-dock-tabs-body {
  flex: 1;
  position: relative;
  width: 100%;
  height: calc(100% - 32px);
  overflow: hidden;
}

/* Link Groups */
.oac-dock-link-badge {
  background: transparent;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border-radius: 3px;
}

.oac-dock-link-badge:hover {
  background-color: var(--oac-term-overlay, rgba(255, 255, 255, 0.1));
}

.oac-dock-link-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

.oac-dock-link-picker {
  background-color: var(--oac-term-popover, #1e222b);
  border: 1px solid var(--oac-term-border-strong, #313644);
  border-radius: 6px;
  box-shadow: 0 8px 24px var(--oac-term-shadow, rgba(0, 0, 0, 0.5));
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.oac-dock-link-picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: transparent;
  border: none;
  color: var(--oac-term-text, #d1d4dc);
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  text-align: left;
}

.oac-dock-link-picker-item:hover {
  background-color: var(--oac-term-hover, #2b313e);
}

.oac-dock-link-picker-item.is-active {
  background-color: var(--oac-term-accent, #38bdf8);
  color: #fff;
}

/* Common Buttons */
.oac-dock-btn {
  background: transparent;
  border: none;
  color: var(--oac-term-muted, #7b8092);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.oac-dock-btn:hover {
  background-color: var(--oac-term-hover, #2b313e);
  color: var(--oac-term-text, #e1e3e6);
}

.oac-dock-btn--close:hover {
  color: #ef5350;
  background-color: rgba(239, 83, 80, 0.15);
}

/* Snap Preview Overlay */
.oac-dock-preview {
  background-color: var(--oac-term-accent-fill, rgba(41, 98, 255, 0.25));
  border: 2px solid var(--oac-term-accent, #38bdf8);
  border-radius: 4px;
}

/* Drag Ghost */
.oac-dock-drag-ghost {
  background-color: var(--oac-term-popover, #1e222b);
  color: var(--oac-term-text-strong, #fff);
  font-size: 12px;
  font-weight: 500;
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid var(--oac-term-border-strong, #383f50);
  box-shadow: 0 8px 20px var(--oac-term-shadow, rgba(0, 0, 0, 0.6));
  opacity: 0.9;
}

/* Floating Window */
.oac-dock-floating {
  position: absolute;
  background-color: var(--oac-term-panel, #101721);
  border: 1px solid var(--oac-term-border-strong, #333948);
  border-radius: 6px;
  box-shadow: 0 12px 36px var(--oac-term-shadow, rgba(0, 0, 0, 0.6));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.oac-dock-floating-header {
  height: 32px;
  min-height: 32px;
  background-color: var(--oac-term-subheader, #1c2027);
  border-bottom: 1px solid var(--oac-term-border-strong, #282d38);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--oac-term-text, #d1d4dc);
  cursor: grab;
  /* Pointer drags, not touch scrolls: without it a touch drag ends in pointercancel. */
  touch-action: none;
}

.oac-dock-floating-header:active {
  cursor: grabbing;
}

.oac-dock-floating-title-area {
  display: flex;
  align-items: center;
  gap: 6px;
}

.oac-dock-floating-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.oac-dock-floating-body {
  flex: 1;
  position: relative;
  width: 100%;
  height: calc(100% - 32px);
  overflow: hidden;
}

/* Resize Handles */
.oac-dock-resize-handle {
  position: absolute;
  z-index: 20;
  touch-action: none;
}

.oac-dock-resize-handle--n { top: 0; left: 0; right: 0; height: 6px; cursor: n-resize; }
.oac-dock-resize-handle--s { bottom: 0; left: 0; right: 0; height: 6px; cursor: s-resize; }
.oac-dock-resize-handle--e { top: 0; right: 0; bottom: 0; width: 6px; cursor: e-resize; }
.oac-dock-resize-handle--w { top: 0; left: 0; bottom: 0; width: 6px; cursor: w-resize; }
.oac-dock-resize-handle--ne { top: 0; right: 0; width: 10px; height: 10px; cursor: ne-resize; }
.oac-dock-resize-handle--nw { top: 0; left: 0; width: 10px; height: 10px; cursor: nw-resize; }
.oac-dock-resize-handle--se { bottom: 0; right: 0; width: 10px; height: 10px; cursor: se-resize; }
.oac-dock-resize-handle--sw { bottom: 0; left: 0; width: 10px; height: 10px; cursor: sw-resize; }

/* Standalone DOM Ladder */
.oac-dom-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background-color: var(--oac-term-bg, #0b1017);
  color: var(--oac-term-text, #d1d4dc);
  font-family: monospace, system-ui;
  overflow: hidden;
}

.oac-dom-toolbar {
  height: 32px;
  min-height: 32px;
  background-color: var(--oac-term-header, #141e2b);
  border-bottom: 1px solid var(--oac-term-border-strong, #242832);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  font-size: 11px;
}

.oac-dom-toolbar-left,
.oac-dom-toolbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.oac-dom-symbol {
  font-weight: 600;
  color: var(--oac-term-text-strong, #fff);
}

.oac-dom-tier-badge {
  font-size: 9px;
  background-color: var(--oac-term-control, #283042);
  color: var(--oac-term-accent, #79a1f5);
  padding: 2px 5px;
  border-radius: 3px;
  font-weight: bold;
}

.oac-dom-select {
  background-color: var(--oac-term-control, #222630);
  color: var(--oac-term-text, #d1d4dc);
  border: 1px solid var(--oac-term-control-border, #333a4a);
  border-radius: 3px;
  padding: 2px 4px;
  font-size: 10px;
}

.oac-dom-actionbar {
  height: 34px;
  min-height: 34px;
  background-color: var(--oac-term-subheader, #161920);
  border-bottom: 1px solid var(--oac-term-border, #20242c);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
}

.oac-dom-btn--buy {
  background-color: #26a69a;
  color: #fff;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 3px;
  border: none;
  cursor: pointer;
  font-size: 11px;
}

.oac-dom-btn--buy:hover { background-color: #2bbbad; }

.oac-dom-btn--sell {
  background-color: #ef5350;
  color: #fff;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 3px;
  border: none;
  cursor: pointer;
  font-size: 11px;
}

.oac-dom-btn--sell:hover { background-color: #f44336; }

.oac-dom-btn--secondary,
.oac-dom-btn--cancel,
.oac-dom-btn--flatten {
  background-color: var(--oac-term-control, #2b303c);
  color: var(--oac-term-text-secondary, #c4c7d0);
  padding: 4px 8px;
  border-radius: 3px;
  border: 1px solid var(--oac-term-control-border, #3a4252);
  cursor: pointer;
  font-size: 10px;
}

.oac-dom-btn--secondary:hover,
.oac-dom-btn--cancel:hover,
.oac-dom-btn--flatten:hover {
  background-color: var(--oac-term-hover, #363d4c);
  color: var(--oac-term-text-strong, #fff);
}

.oac-dom-ladder-container {
  flex: 1;
  min-height: 0;
  overflow-anchor: none;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  scrollbar-width: thin;
  scrollbar-color: var(--oac-term-control-border, #333a4a) var(--oac-term-panel, #101721);
}

.oac-dom-ladder-container::-webkit-scrollbar {
  width: 6px;
}

.oac-dom-ladder-container::-webkit-scrollbar-thumb {
  background: var(--oac-term-control-border, #333a4a);
  border-radius: 3px;
}

.oac-dom-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.oac-dom-table thead th {
  position: sticky;
  top: 0;
  background-color: var(--oac-term-subheader, #191c24);
  color: var(--oac-term-muted, #8b90a0);
  font-weight: 500;
  height: 26px;
  padding: 0 4px;
  text-align: center;
  border-bottom: 1px solid var(--oac-term-border-strong, #282e3c);
  z-index: 5;
}

.oac-dom-row {
  height: 22px;
  border-bottom: 1px solid var(--oac-term-border, #1a1e26);
}

.oac-dom-row:hover {
  background-color: var(--oac-term-hover, #1c212b);
}

.oac-dom-row.is-ltp {
  background-color: var(--oac-term-ltp-fill, rgba(255, 214, 0, 0.12));
}

.oac-dom-row.is-ltp .col-price {
  color: var(--oac-term-ltp, #ffd600);
  font-weight: bold;
}

.oac-dom-panel td.col-bid-qty,
.oac-dom-panel td.col-ask-qty {
  position: relative;
  width: 25%;
  padding: 0 4px;
  text-align: right;
}

.oac-dom-panel td.col-bid-qty { text-align: left; }

.oac-dom-panel .col-price {
  width: 26%;
  text-align: center;
  font-weight: 500;
  color: var(--oac-term-text, #e1e3e6);
  letter-spacing: 0.5px;
}

.oac-dom-panel .col-bid-action,
.oac-dom-panel .col-ask-action {
  width: 12%;
  text-align: center;
  padding: 0 2px;
}

.oac-dom-heat-bar {
  position: absolute;
  top: 1px;
  bottom: 1px;
  opacity: 0.65;
  pointer-events: none;
}

.oac-dom-heat-bar--bid {
  left: 0;
  background: linear-gradient(90deg, rgba(45, 212, 191, 0.08), #2dd4bf);
}

.oac-dom-heat-bar--ask {
  right: 0;
  background: linear-gradient(270deg, rgba(251, 113, 133, 0.08), #fb7185);
}

.oac-dom-qty-text {
  position: relative;
  z-index: 2;
  font-size: 10px;
}

.oac-dom-cell-btn {
  background: transparent;
  border: 1px solid transparent;
  padding: 1px 4px;
  font-size: 9px;
  border-radius: 2px;
  cursor: pointer;
  color: var(--oac-term-muted, #7b8092);
}

.oac-dom-cell-btn--buy:hover {
  background-color: rgba(38, 166, 154, 0.2);
  border-color: #26a69a;
  color: #26a69a;
}

.oac-dom-cell-btn--sell:hover {
  background-color: rgba(239, 83, 80, 0.2);
  border-color: #ef5350;
  color: #ef5350;
}

.oac-dom-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--oac-term-muted, #646b7d);
  font-size: 12px;
}
.oac-dom-toolbar .oac-dom-btn { color: var(--oac-term-text-secondary, #a8bbd0); background: var(--oac-term-control, #1b293a); border: 1px solid var(--oac-term-control-border, #34465d); border-radius: 3px; padding: 3px 8px; font-size: 10px; font-family: inherit; cursor: pointer; }
.oac-dom-toolbar .oac-dom-btn:hover { color: var(--oac-term-text, #e2f3ff); background: var(--oac-term-hover, #263b53); }
.oac-dom-spacer td { padding: 0; border: 0; line-height: 0; }
.oac-dom-row td { height: 22px; padding-top: 0; padding-bottom: 0; white-space: nowrap; overflow: hidden; }
.oac-dom-summary { flex: none; padding: 8px; border-top: 1px solid var(--oac-term-border-strong, #253245); color: var(--oac-term-muted, #8fa5bb); font-size: 10px; font-variant-numeric: tabular-nums; }
.oac-dom-select { appearance: none; padding-right: 18px; background-image: linear-gradient(45deg, transparent 50%, var(--oac-term-muted, #8fa5bb) 50%), linear-gradient(135deg, var(--oac-term-muted, #8fa5bb) 50%, transparent 50%); background-position: calc(100% - 10px) 50%, calc(100% - 6px) 50%; background-size: 4px 4px; background-repeat: no-repeat; }
.oac-dom-panel button:focus-visible, .oac-dom-select:focus-visible, .oac-dock-tab-label:focus-visible, .oac-dock-link-badge:focus-visible { outline: 2px solid var(--oac-term-accent, #38bdf8); outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) { .oac-terminal *, .oac-dom-panel * { transition: none; } }
.oac-chart-tools { position: absolute; right: 12px; bottom: 42px; z-index: 5; display: flex; gap: 4px; }
.oac-chart-tools button { background: var(--oac-term-control, #192b3d); color: var(--oac-term-text-secondary, #c6d9eb); border: 1px solid var(--oac-term-control-border, #34465d); border-radius: 4px; padding: 5px 8px; cursor: pointer; font-size: 11px; font-family: inherit; }
.oac-chart-tools button:focus-visible { outline: 2px solid var(--oac-term-accent, #38bdf8); }

/*
 * Colour tokens. Every colour in this sheet reads a --oac-term-* custom property and falls back
 * to the dark value it always had, so a host that sets nothing gets the original look. A host
 * themes the terminal by setting the tokens itself -- on :root to also reach the drag ghost and
 * link picker, which are appended to <body>. Buy / sell / heat colours are trading semantics and
 * are not tokens.
 *
 * Tokens: --oac-term-accent, --oac-term-accent-fill, --oac-term-bg, --oac-term-border, --oac-term-border-strong, --oac-term-control, --oac-term-control-border, --oac-term-header, --oac-term-hover, --oac-term-ltp, --oac-term-ltp-fill, --oac-term-muted, --oac-term-overlay, --oac-term-panel, --oac-term-popover, --oac-term-shadow, --oac-term-splitter, --oac-term-subheader, --oac-term-text, --oac-term-text-secondary, --oac-term-text-strong
 */
`;

const STYLE_ID = 'oac-terminal-styles';

export function injectTerminalStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = TERMINAL_CSS;
  doc.head.appendChild(style);
}
