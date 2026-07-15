// LibraryStateService — thin facade over the four split modules.
//
// **Why this file still exists** (ticket #122): the public API is consumed by
// browse-shell, editor-shell, asset-grid, folder-tree, filmstrip, library-
// picker, and dozens of develop-tab sections. Splitting the responsibilities
// while keeping every consumer working unchanged means delegating to:
//
//   - `LibraryStore`     — signals + prefs + id-maps + adjustment models
//   - `LibrarySelection` — selected source/asset + grid-derived lists + navigation
//   - `LibraryCache`     — LRU of raw bytes + thumbnail blob URLs
//   - `LibraryFetch`     — folder enumeration, API calls, XMP/index writes
//
// New code in this layer should `inject()` the specific service it needs,
// not this facade. The facade keeps existing consumers working until they
// are migrated component-by-component in follow-up tickets.

import { Injectable, Signal, inject } from '@angular/core';
import { Asset, AssetId, Flag, ColorLabel } from '../models/asset';
import { AdjustmentModel } from '../models/adjustment-model';
import { ApiFolder } from '../api/bun-api-backend.service';
import { MapleFolderHandle } from '../folder-access/folder-access.types';
import { LibraryStore } from './library-store.service';
import { LibrarySelection } from './library-selection.service';
import { LibraryCache } from './library-cache.service';
import { LibraryFetch } from './library-fetch.service';
import { LibraryStatusService } from './library-status.service';
import { BrowsePreferencesService } from './browse-preferences.service';
import { EditPreviewPersistService } from './edit-preview-persist.service';

// Re-export RAW-extension helpers for callers that import from this module.
export { SUPPORTED_RAW_EXTENSIONS, isSupportedRaw } from './library-fetch.service';

@Injectable({ providedIn: 'root' })
export class LibraryStateService {
  private readonly store = inject(LibraryStore);
  private readonly selection = inject(LibrarySelection);
  private readonly cache_ = inject(LibraryCache);
  private readonly fetch_ = inject(LibraryFetch);
  private readonly status = inject(LibraryStatusService);
  private readonly prefs = inject(BrowsePreferencesService);
  private readonly previewPersist = inject(EditPreviewPersistService);

  // ── Backend identity ──────────────────────────────────────────────────────
  readonly backend = this.store.backend;

  // ── Self-Hosted bootstrap state ────────────────────────────────────────────
  // Async-lifecycle signals live in LibraryStatusService (slice 3 of #191);
  // re-exported here so existing component consumers (browse-shell banners,
  // asset-grid rescan button) keep working unchanged.
  readonly backendLoading = this.status.backendLoading;
  readonly backendError = this.status.backendError;
  readonly backendEmpty = this.status.backendEmpty;
  readonly registeredFolders = this.store.registeredFolders;
  readonly rescanStatus = this.status.rescanStatus;
  readonly rescanError = this.status.rescanError;

  readonly pickerVisible = this.store.pickerVisible;
  openLibraryPicker(): void {
    this.store.openLibraryPicker();
  }
  closeLibraryPicker(): void {
    this.store.closeLibraryPicker();
  }

  readonly adminVisible = this.store.adminVisible;
  openIndexerAdmin(): void {
    this.store.openIndexerAdmin();
  }
  closeIndexerAdmin(): void {
    this.store.closeIndexerAdmin();
  }

  // ── Library data ───────────────────────────────────────────────────────────
  readonly assets = this.store.assets;
  readonly gridFolders = this.store.gridFolders;
  readonly sidebarTree = this.store.sidebarTree;

  // ── Current folder handle ─────────────────────────────────────────────────
  readonly currentFolder = this.store.currentFolder;

  // ── Sidebar open/collapsed state ───────────────────────────────────────────
  readonly sectionOpen = this.prefs.sectionOpen;
  readonly folderOpen = this.prefs.folderOpen;

  // ── Selection ──────────────────────────────────────────────────────────────
  readonly selectedSourceId = this.selection.selectedSourceId;
  readonly selectedAssetIds = this.selection.selectedAssetIds;
  readonly focusedAssetId = this.selection.focusedAssetId;
  readonly selectedSourceLabel = this.selection.selectedSourceLabel;

  // ── Thumbnail size (grid density) ─────────────────────────────────────────
  readonly thumbSize = this.prefs.thumbSize;

  // ── Sort + filter ─────────────────────────────────────────────────────────
  readonly sort = this.prefs.sort;
  readonly filter = this.prefs.filter;

  // ── In-grid search query (filename substring filter) ──────────────────────
  readonly searchQuery = this.selection.searchQuery;

  // ── Panel visibility (persisted) ──────────────────────────────────────────
  readonly sidebarVisible = this.prefs.sidebarVisible;
  readonly inspectorVisible = this.prefs.inspectorVisible;

  // ── Active detail tab ─────────────────────────────────────────────────────
  readonly activeTab = this.prefs.activeTab;

  // ── Browse-shell view mode (Folder vs Timeline) ──────────────────────────
  readonly viewMode = this.prefs.viewMode;
  setViewMode(mode: 'folder' | 'timeline'): void {
    this.prefs.setViewMode(mode);
  }

  // ── Thumbnail URL cache ────────────────────────────────────────────────────
  readonly thumbnailUrls = this.cache_.thumbnailUrls;

  // ── Adjustment models (per-asset develop settings) ────────────────────────
  readonly adjustmentModels = this.store.adjustmentModels;

  // ── Open download progress ─────────────────────────────────────────────────
  /** Determinate download progress for the asset currently streaming from the
   * Self-Hosted API, or `null` when nothing is downloading. Drives the editor
   * canvas's open progress bar. See `LibraryCache.openDownloadProgress`. */
  readonly openDownloadProgress = this.cache_.openDownloadProgress;

  // ── Lazy byte access ───────────────────────────────────────────────────────
  bytesForAsset(id: AssetId): Promise<Uint8Array> {
    return this.cache_.bytesForAsset(id);
  }

  bytesFor(id: AssetId): Uint8Array | undefined {
    return this.cache_.bytesFor(id);
  }

  // ── Folder open ────────────────────────────────────────────────────────────
  openFolder(folder: MapleFolderHandle): Promise<void> {
    return this.fetch_.openFolder(folder);
  }

  // ── Self-Hosted bootstrap (Bun API) ────────────────────────────────────────
  loadFolderTree(): void {
    this.fetch_.loadFolderTree();
  }

  addLibraryFolder(absPath: string): void {
    this.fetch_.addLibraryFolder(absPath);
  }

  currentRegisteredFolder(): ApiFolder | null {
    return this.store.currentRegisteredFolder(this.selection.selectedSourceId());
  }

  rescanCurrentFolder(): void {
    this.fetch_.rescanCurrentFolder();
  }

  openSelfHostedFolder(folder: ApiFolder): void {
    this.fetch_.openSelfHostedFolder(folder);
  }

  openSelfHostedSubfolder(relPath: string, sourceId?: string, selectAssetId?: AssetId): void {
    this.fetch_.openSelfHostedSubfolder(relPath, sourceId, selectAssetId);
  }

  expandFsFolder(node: {
    id: string;
    absPath?: string;
    childrenStatus?: 'loading' | 'loaded' | 'error';
  }): void {
    this.fetch_.expandFsFolder(node);
  }

  absPathFor(assetId: AssetId): string | undefined {
    return this.store.absPathFor(assetId);
  }

  hydrateSelfHostedFsAsset(id: AssetId, patch?: Partial<Asset>): Asset | null {
    return this.fetch_.hydrateSelfHostedFsAsset(id, patch);
  }

  apiIdFor(assetId: AssetId): string | undefined {
    return this.store.apiIdFor(assetId);
  }

  // ── addImportedAsset (legacy path) ─────────────────────────────────────────
  addImportedAsset(bytes: Uint8Array, filename: string, explicitId?: AssetId): AssetId {
    return this.fetch_.addImportedAsset(bytes, filename, explicitId);
  }

  // ── Asset mutations ────────────────────────────────────────────────────────
  updateAssetDimensions(id: AssetId, width: number, height: number): void {
    this.store.updateAssetDimensions(id, width, height);
  }

  seedAsShotWhiteBalance(id: AssetId, temperature: number, tint: number): void {
    this.store.seedAsShotWhiteBalance(id, temperature, tint);
  }

  /** Camera As-Shot white balance for `id` (Kelvin + tint), or undefined. */
  asShotWbFor(id: AssetId): { temperature: number; tint: number } | undefined {
    return this.store.asShotWbFor(id);
  }

  cacheThumbnailUrl(id: AssetId, url: string): void {
    this.cache_.cacheThumbnailUrl(id, url);
  }

  thumbnailUrlFor(id: AssetId): string | undefined {
    return this.cache_.thumbnailUrlFor(id);
  }

  /** Subscribe a tile to thumbnail-URL changes for `id`; see LibraryCache. */
  subscribeThumbUrl(id: AssetId, cb: (url: string | undefined) => void): () => void {
    return this.cache_.subscribeThumbUrl(id, cb);
  }

  /** Subscribe to preview (best display-still) URL changes for `id`; see LibraryCache. */
  subscribePreviewUrl(id: AssetId, cb: (url: string | undefined) => void): () => void {
    return this.cache_.subscribePreviewUrl(id, cb);
  }

  ensureThumbnailUrl(asset: Asset): void {
    this.cache_.ensureThumbnailUrl(asset, (id, sha) => this.fetch_.updateIndexThumb(id, sha));
  }

  // ── Adjustment models ──────────────────────────────────────────────────────
  adjustmentFor(id: AssetId): Signal<AdjustmentModel> {
    return this.store.adjustmentFor(id);
  }

  updateAdjustment(id: AssetId, patch: Partial<AdjustmentModel>): void {
    this.store.setAdjustment(id, patch);
    // Schedule debounced sidecar write.
    this.fetch_.scheduleSidecarWrite(id);
    // Schedule the idle-debounced developed-preview persist (#2018) — ONLY
    // here, not on the culling mutators below (setRating/setFlag/etc.),
    // since those don't touch pixels. See EditPreviewPersistService's module
    // doc for the write-policy contract (idle debounce, not per-tick).
    this.previewPersist.schedule(id);
  }

  isEdited(id: AssetId): Signal<boolean> {
    return this.store.isEdited(id);
  }

  // ── Derived signals ────────────────────────────────────────────────────────
  readonly assetsInSelectedFolder = this.selection.assetsInSelectedFolder;
  readonly foldersInSelectedFolder = this.selection.foldersInSelectedFolder;
  readonly focusedAsset = this.selection.focusedAsset;
  readonly selectedCount = this.selection.selectedCount;

  // ── Culling mutations (+ trigger debounced index write) ────────────────────
  setRating(id: AssetId, rating: number): void {
    this.store.assets.update((list) => list.map((a) => (a.id === id ? { ...a, rating } : a)));
    this.fetch_.scheduleSidecarWrite(id);
  }

  setFlag(id: AssetId, flag: Flag): void {
    this.store.assets.update((list) => list.map((a) => (a.id === id ? { ...a, flag } : a)));
    this.fetch_.scheduleSidecarWrite(id);
  }

  setColorLabel(id: AssetId, colorLabel: ColorLabel): void {
    this.store.assets.update((list) => list.map((a) => (a.id === id ? { ...a, colorLabel } : a)));
    this.fetch_.scheduleSidecarWrite(id);
  }

  /**
   * Replace the IPTC keyword list on the asset (#632). Routes through the
   * same debounced sidecar-write the rating/flag/colorLabel mutators use —
   * keywords have zero pixel impact, so the develop render path is
   * intentionally not kicked. Duplicates are stripped preserving
   * first-occurrence order; whitespace-only entries are dropped (the
   * parser drops them on the read path too, so writing them would just
   * round-trip into a desync).
   */
  setKeywords(id: AssetId, keywords: readonly string[]): void {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const raw of keywords) {
      const trimmed = raw.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      deduped.push(trimmed);
    }
    this.store.assets.update((list) =>
      list.map((a) => (a.id === id ? { ...a, keywords: deduped } : a)),
    );
    this.fetch_.scheduleSidecarWrite(id);
  }

  // ── XMP write flush ───────────────────────────────────────────────────────
  flushPendingXmpWrites(): Promise<void> {
    return this.fetch_.flushPendingXmpWrites();
  }

  // ── Developed-preview persist flush (#2018) ─────────────────────────────────
  /** Immediately fire every pending developed-preview persist. Call on
   * navigate-away / close / editor-teardown — see
   * `EditPreviewPersistService.flushAll`'s doc. */
  flushPendingPreviewWrites(): void {
    this.previewPersist.flushAll();
  }

  // ── Index write helper (called by AssetGridComponent post-write) ──────────
  updateIndexThumb(assetId: AssetId, sha: string): Promise<void> {
    return this.fetch_.updateIndexThumb(assetId, sha);
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  selectAsset(id: AssetId, additive = false, range = false): void {
    this.selection.selectAsset(id, additive, range);
  }

  clearSelection(): void {
    this.selection.clearSelection();
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  focusNext(): void {
    this.selection.focusNext();
  }

  focusPrev(): void {
    this.selection.focusPrev();
  }

  peekNext(currentId: AssetId): AssetId | null {
    return this.selection.peekNext(currentId);
  }

  peekPrev(currentId: AssetId): AssetId | null {
    return this.selection.peekPrev(currentId);
  }

  // ── Panel toggles ──────────────────────────────────────────────────────────
  toggleSidebar(): void {
    this.prefs.toggleSidebar();
  }

  toggleInspector(): void {
    this.prefs.toggleInspector();
  }

  // ── Tree expand state ──────────────────────────────────────────────────────
  toggleSection(id: string): void {
    this.prefs.toggleSection(id);
  }

  setFolderOpen(id: string, open: boolean): void {
    this.prefs.setFolderOpen(id, open);
  }
}
