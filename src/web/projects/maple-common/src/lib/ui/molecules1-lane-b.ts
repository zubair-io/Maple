// Barrel for Maple UI Molecules L1 lane B (overlays/structure + plots/media
// batches, W3c+W3d). Filled by the lane's build wave; kept separate from
// public-api.ts so parallel lanes never write the same file.

// §2.4 Overlays & menus
export * from './popover/mui-popover.component';
export * from './context-menu/mui-context-menu.component';
export * from './suggestion-menu/mui-suggestion-menu.component';
export * from './command-menu/mui-command-menu.component';

// §2.5 Structure
export * from './collapsible/mui-collapsible.component';
export * from './page-header/mui-page-header.component';
export * from './toolbar/mui-toolbar.component';
export * from './bubble-menu/mui-bubble-menu.component';
export * from './label-value-grid/mui-label-value-grid.component';
export * from './avatar-group/mui-avatar-group.component';

// §2.6 Data plots
export * from './histogram/mui-histogram.component';
export * from './waveform/mui-waveform.component';
export * from './parade/mui-parade.component';
export * from './vectorscope/mui-vectorscope.component';
export * from './curve-plot/mui-curve-plot.component';
export * from './connection-graph/mui-connection-graph.component';
export * from './heatmap-layer/mui-heatmap-layer.component';

// §2.7 Media
export * from './map-annotation/mui-map-annotation.component';
export * from './preview-image/mui-preview-image.component';
export * from './video-player/mui-video-player.component';
export * from './audio-player/mui-audio-player.component';
export * from './drag-preview/mui-drag-preview.component';
export * from './code-block/mui-code-block.component';
