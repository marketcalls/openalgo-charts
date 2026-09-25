/** Optional, DOM-free named workspace and indicator-template contracts. */
export {
  WORKSPACE_VERSION, WorkspaceDocumentError, parseWorkspaceDocument, parseWorkspacePayload,
  parseIndicatorTemplate, parseIndicatorTemplatePayload, parseIndicatorStates, migrateWidgetWorkspace,
} from './documents';
export { WorkspaceRepository, WorkspaceConflictError, parseWorkspaceCatalog } from './repository';
export type { WorkspaceCatalog, WorkspaceStorage, WorkspaceRepositoryOptions, WorkspaceOperationOptions, WorkspaceOpenOptions } from './repository';
export { createIndexedDbWorkspaceStorage } from './indexed-db';
export type { IndexedDbWorkspaceStorage, IndexedDbCatalogStorage } from './indexed-db';
export {
  WatchlistRepository, WatchlistConflictError, parseWatchlistCatalog, watchlistKey,
  createMemoryWatchlistStorage, createIndexedDbWatchlistStorage,
} from './watchlists';
export type {
  Watchlist, WatchlistEntry, WatchlistCatalog, WatchlistStorage, WatchlistStore, WatchlistOperationOptions,
  WatchlistRepositoryOptions, IndexedDbWatchlistStorage,
} from './watchlists';
export { planIndicatorTemplate } from './templates';
export type { IndicatorTemplateMode } from './templates';
export { captureIndicatorTemplate, planIndicatorTemplateState } from './template-layout';
export type { IndicatorTemplateApplyOptions, IndicatorTemplatePlan } from './template-layout';
export type {
  WorkspaceKind, WorkspaceSettings, WorkspaceChartState, WorkspaceComparison, WorkspaceSlot, WorkspacePane,
  WorkspacePayload, WorkspaceDocument, IndicatorTemplateDocument, IndicatorTemplateInput,
  IndicatorTemplatePayload, IndicatorTemplateLayout, IndicatorTemplatePlotBinding,
} from './documents';
