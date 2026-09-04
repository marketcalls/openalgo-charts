/**
 * Widget tier (opt-in: "openalgo-charts/widget").
 *
 * The chart with its chrome: a top bar (symbol, intervals, chart type,
 * indicators, capture, settings, theme), the drawing rail, a status line, a
 * keymap and the dialogs, in one call. It is the one tier that ships DOM,
 * because a toolbar is DOM; the engine underneath still ships none.
 *
 * ```ts
 * import { createWidget } from 'openalgo-charts/widget';
 *
 * const widget = createWidget('#chart', {
 *   feed, symbol: 'RELIANCE', exchange: 'NSE', interval: '5m',
 *   theme: 'dark', persist: true,
 * });
 * widget.on('symbol', ({ symbol }) => document.title = symbol);
 * ```
 *
 * Importing this module imports the draw tier, so every built-in drawing tool
 * is registered. The dialog modules register their mount functions through
 * `registerWidgetDialogs`; a shell built without them renders the buttons that
 * would open them disabled, with their state visible.
 */
export const WIDGET_TIER = 'widget' as const;

export { createWidget, stripView, resolveTheme, loadWindow, DEFAULT_INTERVALS, DEFAULT_LOOKBACK_BARS, SAVE_DEBOUNCE_MS, STATE_KEY, WIDGET_STATE_VERSION } from './widget';
export type { Widget, WidgetOptions, WidgetState, WidgetChartState, WidgetRestoreReport, WidgetEventName } from './widget';

export {
  WidgetBus, WidgetStorage, STORAGE_PREFIX, defaultStorage,
  registerWidgetDialog, registerWidgetDialogs, unregisterWidgetDialog, widgetDialog, registeredWidgetDialogs,
  createOverlayStack, createTipController, TIP_DWELL_MS,
  esc, h, glyph, inTextField, focusable, focusables, placeBeside, placeBelow, placeTip, boxIn,
} from './context';
export type {
  WidgetContext, WidgetBusEvents, BusHandler, StorageLike,
  DialogMount, DialogHandle, WidgetDialogName,
  OverlayOptions, OverlayStack, TipSpec, TipSource, TipSide, TipController, Box, Size,
} from './context';

export { Keymap, openShortcutsPanel, parseKeyCombo, eventKeyCombo, formatKeyCombo, fromChartCombo } from './keymap';
export type { KeyScope, KeyEventLike, KeyAction, KeyBinding, KeyBindingOptions, KeyConflict, KeymapOptions, KeymapGroup, ChartShortcutSource } from './keymap';

export { mountRail, toolGlyph, toolName, sanitizeRailPrefs, RAIL_GROUPS, MAGNET_MODES, RAIL_PREFS_KEY } from './rail';
export type { RailOptions, RailHandle, RailPrefs, RailGroup, RailGroupItem } from './rail';

export {
  mountTopbar, openMenu, chartTypeChoices, chartTypeLabel, intervalLabel, downloadText, captureName,
  CHART_TYPE_LABELS, SEARCH_DEBOUNCE_MS,
} from './topbar';
export type { TopbarOptions, TopbarHandle, TopbarState, SymbolMatch, SymbolSearch, MenuRow, MenuOptions } from './topbar';

export { mountStatusline, priceDigits, MIN_PRICE_DIGITS } from './statusline';
export type { StatuslineOptions, StatuslineHandle } from './statusline';

export { mountToasts, TOAST_MS, TOAST_MAX, TOAST_LEAVE_MS } from './toast';
export type { Toaster, ToastHandle, ToastKind, ToastOptions } from './toast';

export {
  widgetTokens, applyTokens, themeMode, token, parseColor, formatColor, luminance, mix, withAlpha,
  TOKEN_PREFIX, WIDGET_FONT, WIDGET_MONO, RAIL_WIDTH, TOPBAR_HEIGHT, STATUSLINE_HEIGHT,
} from './tokens';
export type { WidgetThemeName, WidgetTokens, Rgba } from './tokens';

export { WIDGET_CSS, WIDGET_STYLE_ID, injectWidgetStyles } from './styles';

// The dialog tier. Importing it registers the seven mounts with the shell's
// registry, which is what lights up the top bar's settings and indicator
// buttons; the widget's stylesheet carries DIALOG_CSS for the same reason.
export {
  mountSettingsDialog, mountIndicatorPicker, mountIndicatorSettings, mountDrawingProperties,
  mountLevelEditor, mountTextEditor, mountContextMenu, attachContextMenu, contextMenuEntries,
  WIDGET_DIALOGS, DIALOG_CSS,
} from './dialogs/index';
export type {
  SettingsDialogOptions, IndicatorPickerOptions, IndicatorSettingsOptions, IndicatorSettingsTab,
  DrawingPropertiesOptions, LevelEditorOptions, TextEditorOptions, TextEditorHandle,
  ContextMenuHooks, ContextMenuOptions, MenuEntry, MenuItem, OrderRequest, PanelHandle,
} from './dialogs/index';
export { renderForm, controlsFromInputs, controlsFromFields } from './form';
export type { FormControl, FormKind, FormOptions, FormHandle } from './form';
