/**
 * The widget stylesheet: one `<style>` per document, every rule scoped under
 * `.oac-widget`, every colour a token from `tokens.ts`.
 *
 * Nothing here names a colour twice or reaches outside the widget root. A
 * host page keeps its own cascade, and two widgets on one page share the one
 * sheet while carrying their own token values inline, so one can be dark and
 * the other light.
 *
 * The rules follow the craft standard in CLAUDE.md: styled scrollbars on
 * every scrolling surface, no browser-default checkbox, select or colour
 * input, small square swatches, dense rows, muted uppercase section heads.
 * The dialog modules mount inside `.oac-widget`, so they inherit all of it.
 */

/** Id of the injected `<style>`; one per document. */
export const WIDGET_STYLE_ID = 'oac-widget-css';

const v = (name: string): string => `var(--oac-${name})`;

export const WIDGET_CSS = `
.oac-widget { position: relative; display: grid; grid-template-rows: auto 1fr auto; width: 100%; height: 100%;
  min-height: 0; min-width: 0; background: ${v('bg')}; color: ${v('tx')}; font: ${v('fs')}/1.35 ${v('font')};
  -webkit-font-smoothing: antialiased; overflow: hidden; }
.oac-widget, .oac-widget * { box-sizing: border-box; }
.oac-widget[data-theme="dark"] { color-scheme: dark; }
.oac-widget[data-theme="light"] { color-scheme: light; }
.oac-widget button, .oac-widget input, .oac-widget select, .oac-widget textarea { font: inherit; color: inherit; }
.oac-widget button { cursor: pointer; }
.oac-widget kbd { font: 11px/1 ${v('mono')}; font-variant-numeric: tabular-nums; }
.oac-widget [hidden] { display: none !important; }

/* Scrollbars: a thumb one step lighter than its panel, and no visible track. */
.oac-widget * { scrollbar-width: thin; scrollbar-color: ${v('sb-thumb')} transparent; }
.oac-widget ::-webkit-scrollbar { width: 10px; height: 10px; }
.oac-widget ::-webkit-scrollbar-track { background: transparent; }
.oac-widget ::-webkit-scrollbar-thumb { background: ${v('sb-thumb')}; border: 2px solid transparent;
  background-clip: padding-box; border-radius: 999px; }
.oac-widget ::-webkit-scrollbar-thumb:hover { background: ${v('sb-thumb-hover')}; background-clip: padding-box; }
.oac-widget ::-webkit-scrollbar-corner { background: transparent; }

/* Focus: one ring, keyboard only. Text fields glow on the border instead. */
.oac-widget :focus-visible { outline: 2px solid ${v('ring')}; outline-offset: 2px; }
.oac-widget :focus:not(:focus-visible) { outline: none; }
.oac-widget input:not([type=checkbox]):not([type=color]):not([type=range]):focus-visible,
.oac-widget select:focus-visible, .oac-widget textarea:focus-visible {
  outline: none; border-color: ${v('acc')}; box-shadow: 0 0 0 3px ${v('ring-soft')}; }
.oac-widget .oac-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }

/* Form controls: nothing left to the browser on a themed panel. */
.oac-widget input[type=checkbox] { appearance: none; -webkit-appearance: none; flex: none; margin: 0;
  width: 15px; height: 15px; border: 1px solid ${v('bd')}; border-radius: 4px; background: ${v('elev')};
  cursor: pointer; display: inline-grid; place-content: center; transition: background .12s, border-color .12s; }
.oac-widget input[type=checkbox]:hover { border-color: ${v('bd-hover')}; }
.oac-widget input[type=checkbox]:checked { background: ${v('acc')}; border-color: ${v('acc')}; }
.oac-widget input[type=checkbox]:checked::after { content: ''; width: 4px; height: 8px; margin-top: -2px;
  border: solid ${v('bg')}; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.oac-widget input[type=checkbox]:disabled { opacity: .4; cursor: not-allowed; }
.oac-widget select { appearance: none; -webkit-appearance: none; height: ${v('ctl-h')}; padding: 0 24px 0 8px;
  background: ${v('elev')}; border: 1px solid ${v('bd')}; border-radius: 6px; cursor: pointer; }
.oac-widget .oac-select { position: relative; display: inline-flex; }
.oac-widget .oac-select > svg { position: absolute; right: 7px; top: 50%; width: 11px; height: 11px;
  transform: translateY(-50%); pointer-events: none; color: ${v('mut')}; fill: none; stroke: currentColor; stroke-width: 1.5; }
.oac-widget select option, .oac-widget select optgroup { background: ${v('panel')}; color: ${v('tx')}; }
.oac-widget input[type=color] { width: 26px; height: 26px; padding: 0; flex: none; cursor: pointer; appearance: none;
  -webkit-appearance: none; background-color: ${v('elev')}; border: 1px solid ${v('bd')}; border-radius: 6px; }
.oac-widget input[type=color]:hover { border-color: ${v('bd-hover')}; }
.oac-widget input[type=color]::-webkit-color-swatch-wrapper { padding: 3px; }
.oac-widget input[type=color]::-webkit-color-swatch { border: 1px solid rgba(0,0,0,.35); border-radius: 4px; }
.oac-widget input[type=color]::-moz-color-swatch { border: 1px solid rgba(0,0,0,.35); border-radius: 4px; }
.oac-widget .oac-swatch { width: 20px; height: 20px; border-radius: 5px; border: 1px solid rgba(0,0,0,.35); }
.oac-widget input[type=number] { -moz-appearance: textfield; appearance: textfield; }
.oac-widget input[type=number]::-webkit-inner-spin-button, .oac-widget input[type=number]::-webkit-outer-spin-button {
  -webkit-appearance: none; margin: 0; }
.oac-widget input[type=text], .oac-widget input[type=number], .oac-widget input[type=search], .oac-widget textarea {
  height: ${v('ctl-h')}; padding: 0 8px; background: ${v('elev')}; border: 1px solid ${v('bd')}; border-radius: 6px;
  transition: border-color .15s, box-shadow .15s; }
.oac-widget textarea { height: auto; padding: 6px 8px; }
.oac-widget input::placeholder { color: ${v('faint')}; }
.oac-widget input:hover, .oac-widget select:hover { border-color: ${v('bd-hover')}; }
.oac-widget input[type=range] { appearance: none; -webkit-appearance: none; height: 22px; margin: 0;
  background: transparent; cursor: pointer; }
.oac-widget input[type=range]::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: ${v('elev-3')}; }
.oac-widget input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px;
  margin-top: -4.5px; border-radius: 50%; background: ${v('acc')}; border: 0; }
.oac-widget input[type=range]::-moz-range-track { height: 3px; border-radius: 2px; background: ${v('elev-3')}; }
.oac-widget input[type=range]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: ${v('acc')}; border: 0; }

/* Section heads and rows shared by every panel. */
.oac-widget .oac-head { padding: 8px 10px 4px; color: ${v('faint')}; font-size: 10px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .7px; }
.oac-widget .oac-row { display: flex; align-items: center; gap: 8px; min-height: 26px; padding: 2px 0; }
.oac-widget .oac-row > label { flex: 1 1 auto; min-width: 0; color: ${v('tx')}; }

/* Buttons: flat, 28px tall, a tint when pressed or armed. */
.oac-widget .oac-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: ${v('ctl-h')}; padding: 0 9px; background: transparent; border: 1px solid transparent;
  border-radius: 6px; color: ${v('tx')}; white-space: nowrap; transition: background .1s, border-color .1s, color .1s; }
.oac-widget .oac-btn:hover { background: ${v('elev')}; border-color: ${v('bd-soft')}; }
.oac-widget .oac-btn.is-on, .oac-widget .oac-btn[aria-pressed="true"], .oac-widget .oac-btn[aria-expanded="true"] {
  background: ${v('on-bg')}; border-color: ${v('on-bd')}; color: ${v('acc-2')}; }
.oac-widget .oac-btn.is-off, .oac-widget .oac-btn[aria-disabled="true"], .oac-widget .oac-btn:disabled {
  color: ${v('faint')}; cursor: default; }
.oac-widget .oac-btn.is-off:hover, .oac-widget .oac-btn[aria-disabled="true"]:hover, .oac-widget .oac-btn:disabled:hover {
  background: transparent; border-color: transparent; }
.oac-widget .oac-btn--icon { width: ${v('ctl-h')}; padding: 0; }
.oac-widget .oac-btn--primary { background: ${v('acc')}; color: ${v('bg')}; border-color: transparent; font-weight: 600; }
.oac-widget .oac-btn--primary:hover { background: ${v('acc-2')}; border-color: transparent; }
.oac-widget .oac-btn--danger:not(.is-off):hover { color: ${v('danger')}; }
.oac-widget .oac-btn > b { font-weight: 700; letter-spacing: .3px; }
.oac-widget .oac-glyph { display: inline-grid; place-items: center; line-height: 0; flex: none; }
.oac-widget .oac-glyph > svg { fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; }
.oac-widget .oac-glyph--tool > svg { width: 24px; height: 24px; stroke-width: 2; }
.oac-widget .oac-glyph--chrome > svg { width: 16px; height: 16px; stroke-width: 1.5; }
.oac-widget .oac-glyph--text { display: inline-grid; place-items: center; width: 24px; height: 24px;
  font-size: 12px; font-weight: 600; }
.oac-widget .oac-chev { display: inline-grid; place-items: center; line-height: 0; color: ${v('mut')}; }
.oac-widget .oac-chev > svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 1.5;
  stroke-linecap: round; stroke-linejoin: round; }
.oac-widget .oac-sep { width: 1px; height: 20px; background: ${v('bd-soft')}; margin: 0 2px; flex: none; }

/* Top bar */
.oac-widget .oac-topbar { display: flex; align-items: center; gap: 4px; min-height: ${v('topbar-h')};
  padding: 5px 8px; background: ${v('panel')}; border-bottom: 1px solid ${v('bd-soft')}; flex-wrap: wrap; }
.oac-widget .oac-topbar__spacer { flex: 1 1 auto; }
.oac-widget .oac-sym { position: relative; display: inline-flex; align-items: center; }
.oac-widget .oac-sym > input { width: 132px; height: ${v('ctl-h')}; padding: 0 8px 0 28px; font-weight: 600;
  letter-spacing: .3px; text-transform: uppercase; }
.oac-widget .oac-sym > .oac-glyph { position: absolute; left: 8px; color: ${v('mut')}; pointer-events: none; }
.oac-widget .oac-sym__ex { margin-left: 6px; color: ${v('faint')}; font-size: 11px; font-weight: 600; letter-spacing: .5px; }
.oac-widget .oac-pills { display: inline-flex; background: ${v('elev')}; border: 1px solid ${v('bd-soft')};
  border-radius: 7px; padding: 2px; }
.oac-widget .oac-pills > button { height: 22px; padding: 0 8px; background: transparent; border: 0; border-radius: 5px;
  color: ${v('mut')}; font-weight: 600; font-size: 11.5px; letter-spacing: .2px; }
.oac-widget .oac-pills > button:hover { color: ${v('tx')}; }
.oac-widget .oac-pills > button[aria-pressed="true"] { background: ${v('elev-2')}; color: ${v('acc-2')}; }
.oac-widget .oac-pills > button:focus-visible { outline-offset: -1px; }

/* Popup menu (chart types, screenshot, symbol results) */
.oac-widget .oac-menu { min-width: 190px; max-width: 320px; max-height: 60vh; overflow-y: auto; padding: 5px;
  background: ${v('panel')}; border: 1px solid ${v('bd')}; border-radius: 9px; box-shadow: ${v('shadow')}; outline: none; }
.oac-widget .oac-menu__find { padding: 3px 3px 6px; }
.oac-widget .oac-menu__find > input { width: 100%; }
.oac-widget .oac-menu__row { display: flex; align-items: center; gap: 9px; width: 100%; padding: 6px 8px;
  background: transparent; border: 0; border-radius: 6px; color: ${v('tx')}; text-align: left; white-space: nowrap; }
.oac-widget .oac-menu__row:hover, .oac-widget .oac-menu__row:focus-visible, .oac-widget .oac-menu__row.is-active {
  background: ${v('elev-2')}; outline: none; }
.oac-widget .oac-menu__row[aria-checked="true"] { color: ${v('acc-2')}; }
.oac-widget .oac-menu__row[aria-checked="true"]::before { content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: ${v('acc-2')}; margin: 0 2px 0 -2px; flex: none; }
.oac-widget .oac-menu__row[aria-checked="false"]::before { content: ''; width: 6px; height: 6px; margin: 0 2px 0 -2px; flex: none; }
.oac-widget .oac-menu__row[aria-disabled="true"] { color: ${v('faint')}; cursor: default; background: transparent; }
.oac-widget .oac-menu__row.is-danger:hover { color: ${v('danger')}; }
.oac-widget .oac-menu__label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.oac-widget .oac-menu__sub { color: ${v('faint')}; font-size: 11px; }
.oac-widget .oac-menu__key { margin-left: auto; color: ${v('faint')}; }
.oac-widget .oac-menu__empty { padding: 8px 10px; color: ${v('faint')}; }

/* Stage: the rail on the left, the chart filling the rest. */
.oac-widget .oac-stage { position: relative; min-height: 0; min-width: 0; display: flex; }
.oac-widget .oac-chart { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0;
  cursor: var(--oac-tool-cursor, crosshair); }
.oac-widget .oac-chart:focus-visible { outline-offset: -2px; }

/* Rail */
.oac-widget .oac-rail { flex: none; width: ${v('rail-w')}; display: flex; flex-direction: column; align-items: center;
  gap: 2px; padding: 6px 0 0; background: ${v('panel-2')}; border-right: 1px solid ${v('bd-soft')};
  overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
.oac-widget .oac-rail::-webkit-scrollbar { width: 0; height: 0; }
.oac-widget .oac-rail__btn { position: relative; width: 32px; height: 32px; padding: 0; display: grid; place-items: center;
  flex: none; background: transparent; border: 1px solid transparent; border-radius: 7px; color: ${v('mut')};
  transition: background .1s, color .1s, border-color .1s; }
.oac-widget .oac-rail__btn:hover { background: ${v('elev')}; color: ${v('tx')}; }
.oac-widget .oac-rail__btn:focus-visible { outline: 2px solid ${v('acc-2')}; outline-offset: -2px; }
.oac-widget .oac-rail__btn.is-on { background: ${v('on-bg')}; border-color: ${v('on-bd')}; color: ${v('acc-2')}; }
.oac-widget .oac-rail__btn.is-weak { color: ${v('acc-2')}; }
.oac-widget .oac-rail__btn.is-off { color: ${v('faint')}; cursor: default; }
.oac-widget .oac-rail__btn.is-off:hover { background: transparent; color: ${v('faint')}; }
.oac-widget .oac-rail__btn--danger:not(.is-off):hover { color: ${v('danger')}; }
.oac-widget .oac-rail__chev { position: absolute; right: 0; bottom: 0; width: 13px; height: 13px; display: grid;
  place-items: center; border-radius: 5px 0 6px 0; color: ${v('mut')}; opacity: 0; transition: opacity .1s, background .1s; }
.oac-widget .oac-rail__chev > svg { width: 9px; height: 9px; fill: none; stroke: currentColor; stroke-width: 2.2;
  stroke-linecap: round; stroke-linejoin: round; }
.oac-widget .oac-rail__btn:hover .oac-rail__chev, .oac-widget .oac-rail__btn:focus-visible .oac-rail__chev,
.oac-widget .oac-rail__btn[aria-expanded="true"] .oac-rail__chev { opacity: 1; }
.oac-widget .oac-rail__chev:hover { background: ${v('elev-2')}; color: ${v('tx')}; }
.oac-widget .oac-rail__btn.is-held::after, .oac-widget .oac-rail__btn[data-mode="weak"]::after,
.oac-widget .oac-rail__btn[data-mode="strong"]::after { content: ''; position: absolute; top: 3px; right: 3px;
  width: 5px; height: 5px; border-radius: 50%; }
.oac-widget .oac-rail__btn.is-held::after, .oac-widget .oac-rail__btn[data-mode="strong"]::after { background: ${v('acc-2')}; }
.oac-widget .oac-rail__btn[data-mode="weak"]::after { border: 1.5px solid ${v('acc-2')}; width: 4px; height: 4px; }
.oac-widget .oac-rail__sep { width: 22px; height: 1px; background: ${v('bd-soft')}; margin: 4px 0; flex: none; }
.oac-widget .oac-rail__favs { display: contents; }
.oac-widget .oac-rail__ctl { margin-top: auto; position: sticky; bottom: 0; display: flex; flex-direction: column;
  align-items: center; gap: 2px; width: 100%; padding: 4px 0 6px; background: ${v('panel-2')};
  border-top: 1px solid ${v('bd-soft')}; flex: none; }
.oac-widget .oac-rail__ctl .oac-rail__sep { margin: 3px 0; }

/* Rail flyout: a group's tools, with a pin star and the chord on each row. */
.oac-widget .oac-fly { min-width: 244px; max-width: 320px; max-height: calc(100% - 16px); overflow-y: auto; padding: 6px;
  background: ${v('panel')}; border: 1px solid ${v('bd')}; border-radius: 10px; box-shadow: ${v('shadow')}; outline: none; }
.oac-widget .oac-fly__row { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 8px; border-radius: 7px;
  color: ${v('tx')}; font-size: 13px; cursor: pointer; outline: none; user-select: none; }
.oac-widget .oac-fly__row:hover, .oac-widget .oac-fly__row:focus-visible { background: ${v('elev-2')}; }
.oac-widget .oac-fly__row[aria-checked="true"] { background: ${v('on-bg')}; color: ${v('acc-2')}; }
.oac-widget .oac-fly__name { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.oac-widget .oac-fly__chord { min-width: 40px; text-align: right; color: ${v('faint')}; }
.oac-widget .oac-fly__star { width: 22px; height: 22px; display: grid; place-items: center; padding: 0; border: 0;
  border-radius: 5px; background: transparent; color: ${v('faint')}; opacity: 0; transition: opacity .1s, color .1s; }
.oac-widget .oac-fly__row:hover .oac-fly__star, .oac-widget .oac-fly__row:focus-within .oac-fly__star,
.oac-widget .oac-fly__star[aria-pressed="true"] { opacity: 1; }
.oac-widget .oac-fly__star:hover { background: ${v('elev')}; color: ${v('tx')}; }
.oac-widget .oac-fly__star:focus-visible { outline: 2px solid ${v('acc-2')}; outline-offset: -1px; opacity: 1; }
.oac-widget .oac-fly__star[aria-pressed="true"] { color: ${v('amber')}; }
.oac-widget .oac-fly__star > svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 1.5;
  stroke-linecap: round; stroke-linejoin: round; }
.oac-widget .oac-fly__star[aria-pressed="false"] > svg { fill: none; }

/* Tooltip */
.oac-widget .oac-tip { position: absolute; z-index: 200; left: 0; top: 0; max-width: 260px; pointer-events: none;
  padding: 5px 9px; border-radius: 6px; background: ${v('elev-2')}; color: ${v('tx')}; border: 1px solid ${v('bd')};
  box-shadow: ${v('shadow')}; font-size: 12px; line-height: 1.4; opacity: 0; transition: opacity .09s ease; }
.oac-widget .oac-tip.is-on { opacity: 1; }
.oac-widget .oac-tip__chord { margin-left: 10px; color: ${v('mut')}; }
.oac-widget .oac-tip__sub { display: block; margin-top: 2px; color: ${v('faint')}; font-size: 11px; }

/* Status line */
.oac-widget .oac-statusline { display: flex; align-items: center; gap: 12px; height: ${v('status-h')}; padding: 0 10px;
  background: ${v('panel')}; border-top: 1px solid ${v('bd-soft')}; color: ${v('mut')}; font-size: 11.5px;
  font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
.oac-widget .oac-statusline__sym { color: ${v('tx-strong')}; font-weight: 600; letter-spacing: .3px; }
.oac-widget .oac-statusline__iv { color: ${v('faint')}; margin-left: 4px; font-weight: 600; }
.oac-widget .oac-statusline__field { display: inline-flex; align-items: center; gap: 4px; }
.oac-widget .oac-statusline__field > i { font-style: normal; color: ${v('faint')}; }
.oac-widget .oac-statusline__field > b { font-weight: 500; color: ${v('tx')}; }
.oac-widget .oac-statusline .is-up > b { color: ${v('buy')}; }
.oac-widget .oac-statusline .is-down > b { color: ${v('sell')}; }
.oac-widget .oac-statusline__msg { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: ${v('mut')}; }
.oac-widget .oac-statusline__msg.is-error { color: ${v('danger')}; }
.oac-widget .oac-statusline__tz { color: ${v('faint')}; }

/* Toasts */
.oac-widget .oac-toasts { position: absolute; right: 12px; bottom: calc(${v('status-h')} + 10px); z-index: 90; display: flex;
  flex-direction: column; gap: 8px; width: min(340px, calc(100% - 24px)); pointer-events: none; }
.oac-widget .oac-toast { display: flex; align-items: flex-start; gap: 8px; padding: 8px 6px 8px 12px; border-radius: 8px;
  background: ${v('panel')}; color: ${v('tx')}; border: 1px solid ${v('bd')}; border-left: 3px solid ${v('acc')};
  box-shadow: ${v('shadow')}; font-size: 12.5px; line-height: 1.45; pointer-events: auto; animation: oac-toast-in .16s ease-out; }
.oac-widget .oac-toast--success { border-left-color: ${v('buy')}; }
.oac-widget .oac-toast--error { border-left-color: ${v('sell')}; }
.oac-widget .oac-toast__msg { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; padding-top: 2px; }
.oac-widget .oac-toast__x { flex: none; width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent;
  color: ${v('faint')}; padding: 0; display: grid; place-items: center; }
.oac-widget .oac-toast__x:hover { background: ${v('elev-2')}; color: ${v('tx')}; }
.oac-widget .oac-toast__x > svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.5; }
.oac-widget .oac-toast.is-out { opacity: 0; transform: translateY(6px); transition: opacity .16s, transform .16s; }
@keyframes oac-toast-in { from { opacity: 0; transform: translateY(6px); } }

/* Overlay layer: popovers anchored to a control, dialogs centred over a scrim. */
.oac-widget .oac-layer { position: absolute; inset: 0; z-index: 60; pointer-events: none; }
.oac-widget .oac-layer > * { pointer-events: auto; }
.oac-widget .oac-scrim { position: absolute; inset: 0; background: ${v('scrim')}; }
.oac-widget .oac-pop { position: absolute; left: 0; top: 0; }
.oac-widget .oac-dialog { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  min-width: 300px; max-width: calc(100% - 24px); max-height: calc(100% - 24px); display: flex; flex-direction: column;
  background: ${v('panel')}; border: 1px solid ${v('bd')}; border-radius: 12px; box-shadow: ${v('shadow')}; outline: none; }
.oac-widget .oac-dialog__head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; }
.oac-widget .oac-dialog__title { flex: 1 1 auto; font-size: 14px; font-weight: 700; color: ${v('tx-strong')}; }
.oac-widget .oac-dialog__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 14px 10px; }
.oac-widget .oac-dialog__foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px 12px;
  border-top: 1px solid ${v('bd-soft')}; }
.oac-widget .oac-dialog__foot > .oac-spacer { flex: 1 1 auto; }

/* Shortcuts panel */
.oac-widget .oac-keys { columns: 2; column-gap: 24px; min-width: 520px; }
.oac-widget .oac-keys__group { break-inside: avoid; margin-bottom: 8px; }
.oac-widget .oac-keys__row { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
.oac-widget .oac-keys__row > span { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.oac-widget .oac-keys__row > kbd { flex: none; padding: 2px 6px; border-radius: 4px; background: ${v('elev')};
  border: 1px solid ${v('bd-soft')}; color: ${v('mut')}; }
.oac-widget .oac-keys__row.is-shadowed > span, .oac-widget .oac-keys__row.is-shadowed > kbd { color: ${v('faint')}; text-decoration: line-through; }
.oac-widget .oac-keys__note { color: ${v('faint')}; font-size: 11px; padding: 4px 0 0; }

@media (max-width: 720px) {
  .oac-widget .oac-keys { columns: 1; min-width: 0; }
  .oac-widget .oac-sym > input { width: 104px; }
}
@media (prefers-reduced-motion: reduce) {
  .oac-widget .oac-rail__btn, .oac-widget .oac-rail__chev, .oac-widget .oac-tip, .oac-widget .oac-fly__star,
  .oac-widget .oac-btn, .oac-widget .oac-toast.is-out { transition: none; }
  .oac-widget .oac-toast { animation: none; }
}
`;

/**
 * Put the stylesheet into `doc` once. Safe to call per widget: the second
 * call finds the first sheet by id and does nothing. `extra` is appended to
 * the shell's rules on the first call; the dialog modules hand theirs in
 * here, so the page still carries one sheet.
 */
export function injectWidgetStyles(doc: Document, extra = ''): HTMLStyleElement {
  const existing = doc.getElementById(WIDGET_STYLE_ID);
  if (existing !== null) return existing as HTMLStyleElement;
  const style = doc.createElement('style');
  style.id = WIDGET_STYLE_ID;
  style.textContent = WIDGET_CSS + extra;
  (doc.head ?? doc.body ?? doc.documentElement).appendChild(style);
  return style;
}
