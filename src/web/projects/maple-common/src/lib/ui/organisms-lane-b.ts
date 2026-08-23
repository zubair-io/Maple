// Barrel for Maple UI organisms lane B (modals + editing/map/comms/config,
// W6c+W6d). Filled by the lane's build wave; kept separate from
// public-api.ts so parallel lanes never write the same file.

// 4.4 Modals
export * from './add-server-modal/mui-add-server-modal.component';
export * from './batch-metadata-modal/mui-batch-metadata-modal.component';
export * from './batch-rename-modal/mui-batch-rename-modal.component';
export * from './card-detail-modal/mui-card-detail-modal.component';
export * from './export-modal/mui-export-modal.component';
export * from './library-picker-modal/mui-library-picker-modal.component';
export * from './move-to-modal/mui-move-to-modal.component';
export * from './pair-device-modal/mui-pair-device-modal.component';
export * from './panorama-merge-modal/mui-panorama-merge-modal.component';
export * from './result-report-modal/mui-result-report-modal.component';
export * from './selective-paste-modal/mui-selective-paste-modal.component';
export * from './share-modal/mui-share-modal.component';
export * from './template-gallery-modal/mui-template-gallery-modal.component';

// 4.5 Editing surfaces
export * from './control-surface/mui-control-surface.component';
export * from './crop-overlay/mui-crop-overlay.component';
export * from './crop-toolbar/mui-crop-toolbar.component';
export * from './image-canvas/mui-image-canvas.component';
export * from './mobile-control-bar/mui-mobile-control-bar.component';
export * from './preview-surface/mui-preview-surface.component';
export * from './rich-text-editor/mui-rich-text-editor.component';
export * from './structured-data-editor/mui-structured-data-editor.component';
export * from './whiteboard-canvas/mui-whiteboard-canvas.component';

// 4.6 Map
export * from './map-surface/mui-map-surface.component';

// 4.7 Communication
export * from './chat/mui-chat.component';
export * from './notification-feed/mui-notification-feed.component';

// 4.8 Configuration
export * from './backup-monitor/mui-backup-monitor.component';
export * from './device-list/mui-device-list.component';
export * from './diagnostics/mui-diagnostics.component';
export * from './pipeline-monitor/mui-pipeline-monitor.component';
export * from './settings-section/mui-settings-section.component';
export * from './setup-wizard/mui-setup-wizard.component';
export * from './setup-wizard/mui-wizard-step.directive';
export * from './user-management/mui-user-management.component';
