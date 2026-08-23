// Barrel for Maple UI organisms lane A (collections/navigation +
// inspectors/panels, W6a+W6b). 23 organisms — unified-component-catalog.md
// §4.1 "Collections", §4.2 "Navigation", §4.3 "Inspectors & panels". Kept
// separate from public-api.ts so parallel lanes never write the same file.

// 4.1 Collections
export * from './collection-grid/mui-collection-grid.component';
export * from './list-view/mui-list-view.component';
export * from './timeline/mui-timeline.component';
export * from './kanban-board/mui-kanban-board.component';
export * from './filmstrip/mui-filmstrip.component';
export * from './search-results/mui-search-results.component';

// 4.2 Navigation
export * from './sidebar/mui-sidebar.component';
export * from './tool-dock/mui-tool-dock.component';
export * from './search/mui-search.component';
export * from './filter-panel/mui-filter-panel.component';

// 4.3 Inspectors & panels
export * from './inspector-panel/mui-inspector-panel.component';
export * from './info-panel/mui-info-panel.component';
export * from './enrichment-panel/mui-enrichment-panel.component';
export * from './adjustments-panel/mui-adjustments-panel.component';
export * from './color-grading-panel/mui-color-grading-panel.component';
export * from './hsl-panel/mui-hsl-panel.component';
export * from './tone-curve-panel/mui-tone-curve-panel.component';
export * from './film-panel/mui-film-panel.component';
export * from './presets-panel/mui-presets-panel.component';
export * from './scopes-panel/mui-scopes-panel.component';
export * from './backlinks-panel/mui-backlinks-panel.component';
export * from './version-history-panel/mui-version-history-panel.component';
export * from './thread-panel/mui-thread-panel.component';
