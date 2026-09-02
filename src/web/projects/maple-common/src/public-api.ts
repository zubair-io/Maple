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
export * from './lib/api/folder-crud.service';
export * from './lib/api/search.service';
export * from './lib/api/workers-api.service';
export * from './lib/api/worker-events.service';
export * from './lib/api/imports-api.service';
// #1231 — Panorama stitching
export * from './lib/api/pano.service';
export * from './lib/pano/pano-dialog.component';

// Map T2, #2826 — web Map view tile-source setting
export * from './lib/api/map-config.service';

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
export * from './lib/network/apns-config.model';
export * from './lib/network/local-address-report.model';
export * from './lib/network/lan-switch.service';
export * from './lib/network/lan-switch-banner.component';

export * from './lib/components/library-picker/library-picker.component';
export * from './lib/components/library-picker-modal/library-picker-modal.component';

// P5: File System Access API + .maple/ cache protocol
export * from './lib/folder-access/folder-access.types';
export * from './lib/folder-access/folder-access.error';
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
export * from './lib/export/single-file-save-notice.vm';
// People page SWR cache (list + per-person detail).
export * from './lib/api/people.store';

// P7: Unified SPA shells + all components (moved from browse + editor apps)
export * from './lib/shells/browse-shell/browse-shell.component';
export * from './lib/shells/editor-shell/editor-shell.component';
// Web Preview Surface Task 3 — fast static-image preview (no canvas/WASM).
export * from './lib/shells/preview-shell/preview-shell.component';
export * from './lib/shells/preview-shell/preview-video-access';

// Web responsive foundation (#2279) — the phone-tab shell fork is retired;
// RootShellComponent always renders the pane router-outlet (see its header
// comment).
export * from './lib/shells/root-shell.component';
export * from './lib/shells/protocol-handler.component';
export * from './lib/shells/file-handler.component';

// Service-worker app-update flow (background install + in-app toast + hard-nav
// on next route change). `toasts` bound into <mui-toast-container> by
// RootShellComponent / HostedRootShellComponent; init() wired from each
// app's bootstrap.
export * from './lib/sw/app-update.service';
// GPU live-render fallback notice (#2415). `toasts` bound into
// <mui-toast-container> the same way as AppUpdateService above.
export * from './lib/components/gpu-fallback-notice/gpu-fallback-notice.service';

// Responsive-program S2 (#623) — responsive Library grid (3 / 5 / auto-fill).
export * from './lib/library/library-grid.component';
export * from './lib/library/library-cell.component';
export * from './lib/library/filter-chips.component';

// S1b (#598): phone-tier source picker drawer.
export * from './lib/shells/source-picker-drawer/source-picker-drawer.component';

// S6 (#621) — Info content (rating + flags + histogram + camera/location + keywords).
// Lean Info renderer for the phone bottom-sheet + tablet/desktop inspector slots.
// Self Hosted adds enrichment through the optional application composition
// slot; Hosted's dependency graph contains only the shared local sections.
// Maple UI migration (#3030, MW3): rating/flags, histogram, camera/location,
// and keywords now render through mui-ui molecules — see `info-panel.vm.ts`
// — so their retired bespoke components are no longer exported here.
export * from './lib/info/info-panel.component';
export * from './lib/info/info-panel.vm';
export * from './lib/info/info-panel-extension';
export * from './lib/info/info-filename-row.component';
export * from './lib/info/info-enrichment.component';
export * from './lib/info/info-vision.component';
export * from './lib/info/info-transcript.component';
export * from './lib/info/enrichment.vm';

// S5 (#625) — Editor shell was retired once the canvas-first editor reached
// feature parity (epic #1807); the shared drag bar / tool model / sub-param
// machinery below lives on, now consumed only by the canvas-first editor
// (`EditorShellComponent`, `shells/editor-shell/`).
export * from './lib/editor/tool-model';
export * from './lib/editor/tool-sub-param';
export * from './lib/editor/tool-glyph';
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
export * from './lib/components/folder-tree/folder-tree-node.component';
export * from './lib/components/folder-tree/folder-tree-legacy-section.component';
export * from './lib/components/folder-tree/folder-tree-smart-row.component';
export * from './lib/components/folder-tree/folder-tree-library-root.component';
export * from './lib/components/folder-tree/folder-tree-footer.component';
export * from './lib/components/folder-tree/folder-tree-extension';
export * from './lib/components/folder-tree/folder-tree-crud-capability';
export * from './lib/components/folder-tree/folder-tree-crud.component';
export * from './lib/components/folder-tree/folder-context-menu.component';
export * from './lib/components/folder-tree/folder-new-folder-dialog.component';
export * from './lib/components/folder-tree/folder-rename-dialog.component';
export * from './lib/components/folder-tree/folder-trash-confirm-dialog.component';
export * from './lib/components/folder-tree/folder-name-validation';
export * from './lib/components/asset-grid/asset-grid.component';
export * from './lib/components/asset-thumb/asset-thumb.component';
export * from './lib/components/inline-rename-field/inline-rename-field.component';
export * from './lib/components/drop-zone/drop-zone.component';
export * from './lib/components/image-canvas/image-canvas.service';
export * from './lib/components/image-canvas/image-canvas.component';
export * from './lib/components/filmstrip/filmstrip.component';

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

// Map view (web — Self-Hosted only). Map T3, #2827. `MapLibreInstanceFactory`
// is intentionally NOT re-exported — it is the sole file that imports
// `maplibre-gl` at runtime, and stays internal to `MapLibreService`.
export * from './lib/map/maplibre-map.service';
export * from './lib/components/map-view/map-view.component';

// S7 (#622) — Search experience (phone tab content + tablet/desktop overlay).
export * from './lib/search/search-types';
export * from './lib/search/search-filters';
export * from './lib/search/search-bar.component';
export * from './lib/search/search-facet-section.component';
export * from './lib/search/search-filter-panel.component';
export * from './lib/search/search-tag-picker.component';
export * from './lib/search/photo-results-section.component';
export * from './lib/search/recent-queries.component';
export * from './lib/search/search.component';

// Shared utilities.
export * from './lib/util/errors';
export * from './lib/util/idb';
export * from './lib/util/typed-storage';
export * from './lib/util/filename-ext';

// #1606 — Batch Metadata web UI (M2)
export * from './lib/batch-metadata/batch-metadata.types';
export * from './lib/batch-metadata/batch-metadata.service';
export * from './lib/batch-metadata/batch-metadata-panel.component';
export * from './lib/batch-metadata/batch-metadata-confirm-dialog.component';

// #2637 — Inline single-asset rename (grid cell / info panel double-click, F2).
export * from './lib/rename/asset-rename-capability';
export * from './lib/rename/asset-rename.service';

// #2644 — Drag assets onto the folder tree to move or copy. Shared
// components (`asset-grid`, `folder-tree`) depend on `DragMoveCapability` /
// `DRAG_MOVE_CAPABILITY`, not `DragMoveService`, directly — same rationale
// as `ASSET_RENAME_CAPABILITY` above. `provideSelfHostedWorkspace()`
// (`self-hosted-workspace.providers.ts`) is the only place that overrides
// the token with `useExisting: DragMoveService`.
export * from './lib/drag-move/drag-move.types';
export * from './lib/drag-move/drag-move-capability';
export * from './lib/drag-move/drag-move.service';
export * from './lib/drag-move/drag-move-platform';
export * from './lib/drag-move/asset-drag-data';
export * from './lib/drag-move/drag-move-collision-dialog.component';
export * from './lib/drag-move/drag-move-summary-banner.component';
export * from './lib/drag-move/move-to-dialog.component';
export * from './lib/drag-move/move-to-tree-picker.component';

// #2640 — Batch rename dialog (multi-select → template-token rename).
// Mounted directly (no `@defer`) by Self Hosted's `SelfHostedBrowseContent
// Component`, the same way `BatchMetadataPanelComponent` (#1606) is —
// that file lives entirely under `projects/maple`, never reachable from
// Hosted's own build graph, so plain tree-shaking already keeps this out
// of Hosted's shipped bundle (verified: `app-batch-rename-dialog` and
// `/assets/by-address` are absent from every `dist/maple-syrup` chunk,
// same as `app-batch-metadata-panel`). `@defer`-wrapping this instead
// (mirroring #2643's `FolderTreeCrudComponent`) was tried and reverted:
// Angular's application builder emits a SEPARATE chunk for every `@defer`
// block discovered anywhere in `maple-common`'s compiled program —
// including ones with zero real referrers in Hosted's own build — so the
// deferred chunk still shipped as an unreferenced file in Hosted's dist,
// which is exactly what the boundary check (rightly) rejects. `@defer`
// only pays for itself when the trigger site is a component BOTH apps
// load eagerly (folder tree, asset grid); here the trigger is
// Self-Hosted-app-only, so plain non-deferred usage — like batch metadata
// — is the correct, verified-safe shape.
export * from './lib/batch-rename/batch-rename-capability';
export * from './lib/batch-rename/batch-rename.types';
export * from './lib/batch-rename/batch-rename.service';
export * from './lib/batch-rename/batch-rename-dialog.component';

// #2652 — Trash pseudo-node (list/restore/delete-permanently). Same
// non-`@defer`red, physical-separation shape as the batch-rename dialog
// right above: `TrashPanelComponent` is mounted directly (no `@defer`) by
// Self Hosted's `SelfHostedBrowseContentComponent`, which lives entirely
// under `projects/maple` and is never reachable from Hosted's build graph —
// plain tree-shaking keeps it (and `TrashApiService`'s asset/folder-trash
// routes) out of Hosted's shipped bundle. The trigger site (the folder-tree
// Trash row) is shared, so IT depends on `TrashCapability`/
// `TRASH_CAPABILITY` only — never `TrashService` or `TrashPanelComponent`
// directly.
export * from './lib/trash/trash.types';
export * from './lib/trash/trash-capability';
export * from './lib/trash/trash.service';
export * from './lib/trash/trash-panel.component';
export * from './lib/trash/trash-list.component';
export * from './lib/trash/trash-status-banner.component';
export * from './lib/trash/trash-item-row.component';
export * from './lib/trash/trash-toolbar.component';
export * from './lib/trash/trash-node-row.component';
export * from './lib/trash/trash-delete-confirm-dialog.component';

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

// Maple UI design system (#3000), wave 1 — Actions + Content atoms.
export * from './lib/ui/icon/mui-icon.component';
export * from './lib/ui/button/mui-button.component';
export * from './lib/ui/action-button/mui-action-button.component';
export * from './lib/ui/link/mui-link.component';
export * from './lib/ui/text/mui-text.component';
export * from './lib/ui/timestamp/mui-timestamp.component';
export * from './lib/ui/badge/mui-badge.component';
export * from './lib/ui/stat/mui-stat.component';
export * from './lib/ui/divider/mui-divider.component';
export * from './lib/ui/list/mui-list.component';

// Maple UI design system (#3000), wave 2 — Form/Media/Feedback atoms.
export * from './lib/ui/input/mui-input.component';
export * from './lib/ui/checkbox/mui-checkbox.component';
export * from './lib/ui/segmented-toggle/mui-segmented-toggle.component';
export * from './lib/ui/image/mui-image.component';
export * from './lib/ui/remote-image/mui-remote-image.component';
export * from './lib/ui/avatar/mui-avatar.component';
export * from './lib/ui/qr-code/mui-qr-code.component';
export * from './lib/ui/canvas-surface/mui-canvas-surface.component';
export * from './lib/ui/progress/mui-progress.component';
export * from './lib/ui/spinner/mui-spinner.component';
export * from './lib/ui/status-text/mui-status-text.component';
export * from './lib/ui/toast/mui-toast.component';
export * from './lib/ui/molecules1-lane-a';
export * from './lib/ui/molecules1-lane-b';

// Molecules L2 (unified-component-catalog.md §3) — Wave 4 (#3000).
export * from './lib/ui/media-cell/mui-media-cell.component';
export * from './lib/ui/card/mui-card.component';
export * from './lib/ui/dialog/mui-dialog.component';
export * from './lib/ui/settings-row/mui-settings-row.component';
export * from './lib/ui/embed-shell/mui-embed-shell.component';
export * from './lib/ui/description-field/mui-description-field.component';
export * from './lib/ui/transcript-block/mui-transcript-block.component';
export * from './lib/ui/faces-row/mui-faces-row.component';
export * from './lib/ui/place-row/mui-place-row.component';
export * from './lib/ui/vision-row/mui-vision-row.component';
export * from './lib/ui/keyword-row/mui-keyword-row.component';
export * from './lib/ui/preview-list/mui-preview-list.component';
export * from './lib/ui/progress-step/mui-progress-step.component';
export * from './lib/ui/suggestion-preview/mui-suggestion-preview.component';
export * from './lib/ui/bot-output/mui-bot-output.component';
export * from './lib/ui/endpoint-form/mui-endpoint-form.component';
export * from './lib/ui/response-viewer/mui-response-viewer.component';
export * from './lib/ui/filmstrip-row/mui-filmstrip-row.component';
export * from './lib/ui/filmstrip-rail/mui-filmstrip-rail.component';
export * from './lib/ui/qr-scanner/mui-qr-scanner.component';
export * from './lib/ui/chat-message/mui-chat-message.component';
export * from './lib/ui/typing-indicator/mui-typing-indicator.component';
export * from './lib/ui/todo-popover/mui-todo-popover.component';
export * from './lib/ui/event-popover/mui-event-popover.component';

// Templates (unified-component-catalog.md §5) — Wave 5 (#3000). Region-only
// layout shells with no content of their own.
export * from './lib/ui/app-shell/mui-app-shell.component';
export * from './lib/ui/split-layout/mui-split-layout.component';
export * from './lib/ui/tab-shell/mui-tab-shell.component';
export * from './lib/ui/settings-shell/mui-settings-shell.component';
export * from './lib/ui/overlay-shell/mui-overlay-shell.component';
export * from './lib/ui/sheet-shell/mui-sheet-shell.component';
export * from './lib/ui/drawer-shell/mui-drawer-shell.component';
export * from './lib/ui/organisms-lane-a';
export * from './lib/ui/organisms-lane-b';

// Pages (unified-component-catalog.md §6) — Wave W7 (#3000). Composition
// components: a Template hosting several Organisms with coherent mock data
// flowing between them.
export * from './lib/ui/pages/browse/mui-page-browse.component';
export * from './lib/ui/pages/editor/mui-page-editor.component';
export * from './lib/ui/pages/document/mui-page-document.component';
export * from './lib/ui/pages/preview/mui-page-preview.component';
export * from './lib/ui/pages/search/mui-page-search.component';
export * from './lib/ui/pages/board/mui-page-board.component';
export * from './lib/ui/pages/chat/mui-page-chat.component';
export * from './lib/ui/pages/notifications/mui-page-notifications.component';
export * from './lib/ui/pages/settings/mui-page-settings.component';
export * from './lib/ui/pages/admin/mui-page-admin.component';
export * from './lib/ui/pages/sign-in/mui-page-sign-in.component';
export * from './lib/ui/pages/pairing/mui-page-pairing.component';
export * from './lib/ui/pages/tv-timeline/mui-page-tv-timeline.component';
export * from './lib/ui/pages/tv-viewer/mui-page-tv-viewer.component';
export * from './lib/ui/pages/tv-map/mui-page-tv-map.component';
