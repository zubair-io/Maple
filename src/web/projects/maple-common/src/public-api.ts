/*
 * Public API Surface of maple-common
 */

export * from './lib/tokens';
export * from './lib/motion';
export * from './lib/layout-service';
export * from './lib/models/asset';
export * from './lib/models/folder';
export * from './lib/models/adjustment-model';
export * from './lib/data/mock-library';
export * from './lib/icons/maple-icon.component';
export * from './lib/icons/material-icon.component';
export * from './lib/button/maple-button.component';
export * from './lib/collapsible/maple-collapsible.component';
export * from './lib/state/library-state.service';
export * from './lib/state/library-status.service';
export * from './lib/state/browse-preferences.service';
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
export * from './lib/api/workers-api.service';
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

// #193 slice 1: canonical Store<T> shape + SidecarStore proof.
export * from './lib/state/store';
export * from './lib/xmp/sidecar-idb-cache';
export * from './lib/xmp/sidecar.store';
// People page SWR cache (list + per-person detail).
export * from './lib/api/people.store';

// #193 slice 2: first reactive consumer of SidecarStore.
export * from './lib/components/editor-sidecar-status-badge/editor-sidecar-status-badge.component';

// P7: Unified SPA shells + all components (moved from browse + editor apps)
export * from './lib/shells/browse-shell/browse-shell.component';
export * from './lib/shells/editor-shell/editor-shell.component';
// S1c (#599) — phone bottom-sheet primitive (consumed by S4 Loupe / S5 Editor / S6 phone Detail).
export * from './lib/shells/bottom-sheet.component';
// S7 follow-up (#645) — tablet/desktop anchored-overlay primitive (consumed
// by the search-pill flow, with `<app-search>` content landing via #629).
export * from './lib/shells/anchored-overlay.component';

// Responsive-program S1a (#597) — phone-tier tab shell + the root shell
// switcher that dispatches phone vs pane based on LayoutService.layout().
export * from './lib/shells/tab-bar-visibility.service';
export * from './lib/shells/phone-tab-shell.component';
export * from './lib/shells/root-shell.component';
export * from './lib/shells/phone-library-stub.component';
export * from './lib/shells/phone-search-stub.component';
export * from './lib/shells/phone-settings-stub.component';

// Responsive-program S2 (#623) — responsive Library grid (3 / 5 / auto-fill).
export * from './lib/library/library-grid.component';
export * from './lib/library/library-cell.component';
export * from './lib/library/filter-chips.component';

// S1b (#598): phone-tier source picker drawer.
export * from './lib/shells/source-picker-drawer/source-picker-drawer.component';

// S6 (#621) — Info content (rating + flags + histogram + camera/location + keywords).
// Lean Info renderer for the phone bottom-sheet + tablet/desktop inspector slots.
// Lives alongside `<maple-info-tab>` (heavy Self-Hosted enrichment surface);
// consolidation is a follow-up.
export * from './lib/info/info-panel.component';
export * from './lib/info/rating-flags-row.component';
export * from './lib/info/histogram.component';
export * from './lib/info/camera-location-grid.component';
export * from './lib/info/keyword-chips-row.component';
export * from './lib/components/folder-tree/folder-tree.component';
export * from './lib/components/asset-grid/asset-grid.component';
export * from './lib/components/asset-thumb/asset-thumb.component';
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
export * from './lib/auth/auth-bootstrap';

// Deep links (responsive-program #624) — maple:// scheme + HTTPS
// shim resolved to Angular Router navigations.
export * from './lib/deep-link/deep-link.service';

// Timeline view (web — Self-Hosted only).
export * from './lib/state/timeline-state.service';
export * from './lib/components/timeline-view/timeline-view.component';
export * from './lib/components/timeline-view/timeline-filter-row.component';
export * from './lib/components/timeline-view/timeline-scrubber.component';
