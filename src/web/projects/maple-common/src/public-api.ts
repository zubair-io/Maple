/*
 * Public API Surface of maple-common
 */

export * from './lib/tokens';
export * from './lib/motion';
export * from './lib/layout-service';
export * from './lib/models/asset';
export * from './lib/models/color-label';
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
export * from './lib/raw-pipeline/raw-pipeline.service';
export * from './lib/raw-pipeline/raw-pipeline.types';
export * from './lib/raw-pipeline/gpu-live-render.token';
export * from './lib/raw-pipeline/gpu-live-render.gate';
export * from './lib/raw-pipeline/render-config.model';
export * from './lib/raw-pipeline/render-config.service';
export * from './lib/raw-pipeline/image-utils';
export * from './lib/raw-pipeline/embedded-preview.service';
export * from './lib/raw-pipeline/embedded-preview.types';

// T10 note: `raw-wasm-init.ts` is intentionally NOT re-exported from the
// library entry point. It imports directly from `./pkg/raw_wasm` (wasm-pack
// output) which is only resolvable by Angular's application builder (via the
// worker bundle), not ng-packagr. The bootstrapper is consumed exclusively
// by `raw-pipeline.worker.ts` through a relative import.

// T4: Hosted vs Self-Hosted backend selection
export * from './lib/api/library-backend.token';
export * from './lib/workspace/workspace-capabilities';
export * from './lib/workspace/workspace-persistence';
export * from './lib/workspace/server-library-io';
export * from './lib/workspace/hosted-workspace.providers';
export * from './lib/workspace/self-hosted-workspace.providers';
export * from './lib/api/api-base-url.token';
export * from './lib/api/bun-api-backend.service';
export * from './lib/api/filesystem-browse.service';
export * from './lib/api/search.service';
export * from './lib/api/workers-api.service';
export * from './lib/api/worker-events.service';
export * from './lib/api/imports-api.service';
// #1231 — Panorama stitching
export * from './lib/api/pano.service';
export * from './lib/pano/pano-dialog.component';

// #943 — Edited-image export (render + encode + download, sidecar refreshed)
export * from './lib/export/image-export.service';
export * from './lib/export/export-dialog.component';
export * from './lib/export/export-dialog.vm';
export * from './lib/export/download-blob';

// #1757 — Cloudflare R2 thumbnail-mirror operator config
export * from './lib/api/cloudflare.service';

// #713 — Observability (SigNoz / OpenTelemetry). Config model + IndexedDB
// cache + the SDK-wiring service + the global Angular error handler.
export * from './lib/observability/observability-config.model';
export * from './lib/observability/observability-config-cache';
export * from './lib/observability/observability.service';
export * from './lib/observability/maple-error-handler';

// LAN address discovery — settings CRUD model + the public report shape +
// the "switch to local network" banner (a redirect-with-handoff-code flow;
// see auth.service.ts's issueLanHandoffCode/redeemLanHandoff — WebAuthn
// requires a secure context a plain-HTTP LAN address can't provide, so the
// LAN origin gets its own session via a one-time code instead of silently
// swapping the API base URL underneath the page).
export * from './lib/network/network-config.model';
export * from './lib/network/local-address-report.model';
export * from './lib/network/lan-switch.service';
export * from './lib/network/lan-switch-banner.component';

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
export * from './lib/xmp/sidecar-save-state.service';
export * from './lib/xmp/single-file-xmp.service';
export * from './lib/export/single-file-save-notice.component';
// People page SWR cache (list + per-person detail).
export * from './lib/api/people.store';

// P7: Unified SPA shells + all components (moved from browse + editor apps)
export * from './lib/shells/browse-shell/browse-shell.component';
export * from './lib/shells/editor-shell/editor-shell.component';
// Web Preview Surface Task 3 — fast static-image preview (no canvas/WASM).
export * from './lib/shells/preview-shell/preview-shell.component';
export * from './lib/shells/preview-shell/preview-video-access';
// S1c (#599) — phone bottom-sheet primitive (consumed by S4 Loupe / S5 Editor / S6 phone Detail).
export * from './lib/shells/bottom-sheet.component';

// Web responsive foundation (#2279) — the phone-tab shell fork is retired;
// RootShellComponent always renders the pane router-outlet (see its header
// comment).
export * from './lib/shells/root-shell.component';
export * from './lib/shells/protocol-handler.component';

// Service-worker app-update flow (background install + in-app toast + hard-nav
// on next route change). Rendered by RootShellComponent; init() wired from each
// app's bootstrap.
export * from './lib/sw/app-update.service';
export * from './lib/sw/update-toast.component';
export * from './lib/components/gpu-fallback-notice/gpu-fallback-notice.component';
export * from './lib/components/save-status/save-status.component';

// Responsive-program S2 (#623) — responsive Library grid (3 / 5 / auto-fill).
export * from './lib/library/library-grid.component';
export * from './lib/library/library-cell.component';
export * from './lib/library/filter-chips.component';

// S1b (#598): phone-tier source picker drawer.
export * from './lib/shells/source-picker-drawer/source-picker-drawer.component';

// S6 (#621) — Info content (rating + flags + histogram + camera/location + keywords).
// Lean Info renderer for the phone bottom-sheet + tablet/desktop inspector slots.
// #634 follow-up folded the former `<maple-info-tab>` enrichment surface into
// `<app-info-panel>` via the `<app-info-enrichment>` orchestrator (gated on
// `LIBRARY_BACKEND === 'self-hosted'`).
export * from './lib/info/info-panel.component';
export * from './lib/info/rating-flags-row.component';
export * from './lib/info/histogram.component';
export * from './lib/info/camera-location-grid.component';
export * from './lib/info/keyword-chips-row.component';
export * from './lib/info/info-enrichment.component';
export * from './lib/info/info-place.component';
export * from './lib/info/info-description.component';
export * from './lib/info/info-vision.component';
export * from './lib/info/info-faces.component';
export * from './lib/info/enrichment-status-badge.component';

// S5 (#625) — Editor shell was retired once the canvas-first editor reached
// feature parity (epic #1807); the shared drag bar / tool model / sub-param
// machinery below lives on, now consumed only by the canvas-first editor
// (`EditorShellComponent`, `shells/editor-shell/`).
export * from './lib/editor/tool-model';
export * from './lib/editor/tool-sub-param';
export * from './lib/editor/tool-glyph';
export * from './lib/editor/drag-bar-math';
export * from './lib/editor/editor-state.service';
export * from './lib/editor/drag-bar.component';
export * from './lib/editor/value-chip.component';
export * from './lib/editor/sub-param-row.component';

// Presets (#1115, spec §10.7) — sparse-model storage + apply/save UI.
export * from './lib/editor/presets/preset-model';
export * from './lib/editor/presets/builtin-presets';
export * from './lib/editor/presets/user-preset-store';
export * from './lib/editor/presets/presets.service';
export * from './lib/editor/presets/presets-panel.component';

// Copy / paste / sync develop settings across multiple images (#944).
export * from './lib/editor/copy-paste/adjustment-groups';
export * from './lib/editor/copy-paste/adjustment-clipboard.service';
export * from './lib/editor/copy-paste/paste-settings-dialog.component';
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

// S7 (#622) — Search experience (phone tab content + tablet/desktop overlay).
export * from './lib/search/search-types';
export * from './lib/search/search-bar.component';
export * from './lib/search/search-scope-chips.component';
export * from './lib/search/top-hits-section.component';
export * from './lib/search/photo-results-section.component';
export * from './lib/search/recent-queries.component';
export * from './lib/search/search.component';

// Shared utilities.
export * from './lib/util/errors';
export * from './lib/util/idb';
export * from './lib/util/typed-storage';

// #1606 — Batch Metadata web UI (M2)
export * from './lib/batch-metadata/batch-metadata.types';
export * from './lib/batch-metadata/batch-metadata.service';
export * from './lib/batch-metadata/batch-metadata-panel.component';
export * from './lib/batch-metadata/batch-metadata-confirm-dialog.component';

// M2 — Unified library addressing (MapleAddress + LibrarySource strategy).
export * from './lib/addressing/maple-address';
export * from './lib/addressing/library-source';
export * from './lib/addressing/library-source-selector';
export * from './lib/addressing/http-library-source';
export * from './lib/addressing/fs-access-library-source';
export * from './lib/addressing/library-slug-registry';
export * from './lib/addressing/route-address';

// #1995 — Hosted-mode `maple_id` derivation (byte-for-byte port of the
// server's src/api/src/indexer/id.ts) + its IndexedDB id cache. NOT exported:
// `maple-id-fallback.worker.ts` (only reachable via a runtime
// `new Worker(new URL(...))` call — see its own module doc, and
// `raw-wasm-init.ts`'s module doc, for why a file that imports
// `pkg/raw_wasm` can't be part of this ng-packagr-built barrel).
export * from './lib/addressing/maple-id';
export * from './lib/addressing/captured-at';
export * from './lib/addressing/maple-id-fallback.types';
export * from './lib/addressing/maple-id-fallback-hasher.service';
export * from './lib/addressing/maple-id-cache';
export * from './lib/addressing/exif-reader.service';
export * from './lib/addressing/hosted-maple-id.service';
