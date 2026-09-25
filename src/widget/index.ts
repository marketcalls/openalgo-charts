/**
 * Widget tier (opt-in: "openalgo-charts/widget").
 *
 * The chart with its chrome: a top bar (symbol, intervals, chart type,
 * indicators, capture, settings, theme), the drawing rail, a status line, a
 * keymap and the dialogs, in one call. It is the one tier that ships DOM,
 * because a toolbar is DOM; the engine underneath still ships none.
 * `createChartGrid` lays several widgets out as one linked workspace.
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

export { widgetText } from './localization';
export type { WidgetBuiltinMessage, WidgetMessageKey, WidgetMessageValues, WidgetMessageParameters, WidgetTranslator, WidgetTranslationOptions } from './localization';

export { createWidget, stripView, resolveTheme, loadWindow, DEFAULT_INTERVALS, DEFAULT_LOOKBACK_BARS, SAVE_DEBOUNCE_MS, STATE_KEY, WIDGET_STATE_VERSION } from './widget';
export type { Widget, WidgetOptions, WidgetState, WidgetChartState, WidgetRestoreReport, WidgetEventName } from './widget';
export { createChartGrid, CHART_GRID_PRESETS } from './grid';
export type { ChartGrid, ChartGridOptions, ChartGridCell, ChartGridLayout, ChartGridPreset, ChartGridApplyReport, ChartGridEvents, ChartGridEventName } from './grid';
export { CHART_GRID_CSS } from './grid-styles';
export { mountObjectsPanel, createObjectsPanelContent, OBJECTS_PANEL_CSS } from './objects-panel';
export type { ObjectsPanelOptions, ObjectsPanelContent } from './objects-panel';
export { readDataWindow, mountDataWindow, DATA_WINDOW_CSS } from './data-window';
export type { DataWindowRow, DataWindowSection, DataWindowSnapshot, DataWindowOptions, DataWindowHandle } from './data-window';
export { mountPanelDock, sanitizePanelDockState, PANEL_DOCK_CSS } from './panel-dock';
export type { PanelDockId, PanelDockState, PanelDockContent, PanelDockOptions, PanelDockHandle } from './panel-dock';
export { mountSymbolPicker, safeSymbolIconUrl, SYMBOL_PICKER_CSS } from './symbol-picker';
export type { SymbolPickerOptions, SymbolPickerHandle } from './symbol-picker';
export { mountQuickEntry, QUICK_ENTRY_CSS } from './quick-entry';
export type { QuickEntryOptions, QuickEntryHandle } from './quick-entry';
export { createColorPicker, COLOR_PICKER_CSS } from './color-picker';
export type { ColorPickerOptions, ColorPickerHandle } from './color-picker';
export { DateNavigator } from './date-navigator';
export type { DateNavigatorOptions, DateNavigationTarget, DateNavigationResult, DateNavigationStatus, HistoryReach } from './date-navigator';
export { openDateNavigation, DATE_NAVIGATION_CSS } from './date-navigation-dialog';
export type { DateNavigationDialogOptions } from './date-navigation-dialog';

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
export { mountAccountSummary, ACCOUNT_SUMMARY_CSS } from './account-summary';
export type { AccountSummaryOptions, AccountSummaryHandle } from './account-summary';

export { mountToasts, TOAST_MS, TOAST_MAX, TOAST_LEAVE_MS } from './toast';
export type { Toaster, ToastHandle, ToastKind, ToastOptions } from './toast';

export {
  widgetTokens, applyTokens, themeMode, token, parseColor, formatColor, luminance, mix, withAlpha,
  TOKEN_PREFIX, WIDGET_FONT, WIDGET_MONO, RAIL_WIDTH, TOPBAR_HEIGHT, STATUSLINE_HEIGHT,
} from './tokens';
export type { WidgetThemeName, WidgetTokens, Rgba } from './tokens';

export { WIDGET_CSS, WIDGET_STYLE_ID, injectWidgetStyles } from './styles';
export { WIDGET_COMPONENT_CSS } from './component-styles';
export { mountMobile } from './mobile';
export type { MobileMode, MobileOptions, MobileHandle } from './mobile';

// The dialog tier. Importing it registers the mounts with the shell's
// registry, which is what lights up the top bar's settings and indicator
// buttons; the widget's stylesheet carries DIALOG_CSS for the same reason.
export {
  mountSettingsDialog, mountIndicatorPicker, mountIndicatorSettings, mountDrawingProperties,
  mountLevelEditor, mountTextEditor, mountContextMenu, attachContextMenu, contextMenuEntries,
  WIDGET_DIALOGS, DIALOG_CSS,
  mountAlertEditor, mountAlertsPanel,
} from './dialogs/index';
export type {
  SettingsDialogOptions, IndicatorPickerOptions, IndicatorSettingsOptions, IndicatorSettingsTab,
  DrawingPropertiesOptions, LevelEditorOptions, TextEditorOptions, TextEditorHandle,
  ContextMenuHooks, ContextMenuOptions, MenuEntry, MenuItem, OrderRequest, PanelHandle,
  AlertEditorOptions, AlertsPanelOptions,
} from './dialogs/index';
export { renderForm, controlsFromInputs, controlsFromFields } from './form';
export type { FormControl, FormKind, FormOptions, FormHandle, FormTranslationOptions } from './form';
export { mountIndicatorInputControls } from './indicator-input-controls';
export type { IndicatorInputControlsOptions, IndicatorInputControlsHandle } from './indicator-input-controls';
export { createAlertUi } from './alert-ui';
export type { AlertUi, AlertUiOptions } from './alert-ui';
export { EventDetailsPopup, EVENT_DETAILS_CSS } from './event-details';
export type { EventDetailsPopupOptions, EventDetailsLoader, EventDetailsLabels } from './event-details';
