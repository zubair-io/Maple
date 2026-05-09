/*
 * Public API Surface of maple-common
 */

export * from './lib/tokens';
export * from './lib/models/asset';
export * from './lib/models/folder';
export * from './lib/models/adjustment-model';
export * from './lib/data/mock-library';
export * from './lib/icons/maple-icon.component';
export * from './lib/icons/material-icon.component';
export * from './lib/button/maple-button.component';
export * from './lib/collapsible/maple-collapsible.component';
export * from './lib/state/library-state.service';
export * from './lib/detail-panel/info-tab.component';
export * from './lib/raw-pipeline/raw-pipeline.service';
export * from './lib/raw-pipeline/raw-pipeline.types';
export * from './lib/raw-pipeline/image-utils';

// Plan 3 M2.1 — WebGL2 dev-chain pipeline (hand-rolled).
export { Pipeline, WebglFp16Unsupported } from './lib/webgl/pipeline';
// T10 note: `raw-wasm-init.ts` is intentionally NOT re-exported from the
// library entry point. It imports directly from `./pkg/raw_wasm` (wasm-pack
// output) which is only resolvable by Angular's application builder (via the
// worker bundle), not ng-packagr. The bootstrapper is consumed exclusively
// by `raw-pipeline.worker.ts` through a relative import.

// T4: Hosted vs Self-Hosted backend selection
export * from './lib/api/library-backend.token';
export * from './lib/api/api-base-url.token';
export * from './lib/api/bun-api-backend.service';
export * from './lib/api/filesystem-browse.service';
export * from './lib/api/search.service';
export * from './lib/components/loading-banner/loading-banner.component';
export * from './lib/components/error-banner/error-banner.component';
export * from './lib/components/library-picker/library-picker.component';
export * from './lib/components/library-picker-modal/library-picker-modal.component';

// P5: File System Access API + .maple/ cache protocol
export * from './lib/folder-access/folder-access.types';
export * from './lib/folder-access/folder-access.service';
export * from './lib/folder-access/file-cache';
export * from './lib/maple-cache/maple-cache.types';
export * from './lib/maple-cache/maple-cache.service';
export * from './lib/maple-cache/sha';
export * from './lib/xmp/xmp.types';
export * from './lib/xmp/xmp-parser.service';

// P6: Full AdjustmentModel XMP read/write + debounced sidecar writes
export * from './lib/xmp/xmp-fields';
export * from './lib/xmp/xmp-serializer.service';
export * from './lib/xmp/xmp-store.service';

// P7: Unified SPA shells + all components (moved from browse + editor apps)
export * from './lib/shells/browse-shell/browse-shell.component';
export * from './lib/shells/editor-shell/editor-shell.component';
export * from './lib/components/folder-tree/folder-tree.component';
export * from './lib/components/asset-grid/asset-grid.component';
export * from './lib/components/asset-thumb/asset-thumb.component';
export * from './lib/components/browse-detail-panel/browse-detail-panel.component';
export * from './lib/components/drop-zone/drop-zone.component';
export * from './lib/components/image-canvas/image-canvas.service';
export * from './lib/components/image-canvas/image-canvas.component';
export * from './lib/components/filmstrip/filmstrip.component';
export * from './lib/components/editor-detail-panel/editor-detail-panel.component';
export * from './lib/components/editor-detail-panel/develop-tab.component';
export * from './lib/components/develop/slider.component';
export * from './lib/components/develop/wb-preset-pills.component';
export * from './lib/components/develop/tone-section.component';
export * from './lib/components/develop/white-balance-section.component';
export * from './lib/components/develop/presence-section.component';
export * from './lib/components/develop/sharpening-section.component';
export * from './lib/components/develop/noise-section.component';
export * from './lib/components/scopes/scopes-container.component';
export * from './lib/components/scopes/histogram.component';
export * from './lib/components/scopes/waveform.component';
export * from './lib/components/scopes/parade.component';
export * from './lib/components/scopes/vectorscope.component';

export * from './lib/auth/auth.service';
export * from './lib/auth/auth.guard';
export * from './lib/auth/auth.interceptor';

export * from './lib/services/indexer-events.service';

// Timeline view (web — Self-Hosted only).
export * from './lib/state/timeline-state.service';
export * from './lib/components/timeline-view/timeline-view.component';
export * from './lib/components/timeline-view/timeline-filter-row.component';
export * from './lib/components/timeline-view/timeline-scrubber.component';
