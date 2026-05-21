// Library store — data and adjustment models. Persisted UI prefs live in
// `BrowsePreferencesService`; ephemeral UI flags are moving out screen-by-
// screen (ticket #191).
//
// Holds the signal-readable state for the browse + editor shells:
//   - asset list, grid folders, sidebar tree
//   - current folder handle, registered libraries (Self-Hosted)
//   - per-asset adjustment models + id ↔ remote-id maps
//   - transient Self-Hosted bootstrap flags (scheduled for later extraction)
//
// **Design call (ticket #122):** stayed on plain Angular signals rather than
// migrating to NgRx SignalStore. This is a brownfield split — the goal is to
// shrink the 1,621-LOC monolith with zero behaviour change. SignalStore would
// drag in @ngrx/signals and rewrite the consumer surface (we'd have to switch
// every component from `inject(LibraryStateService)` to selectors). Park that
// migration for a follow-up greenfield ticket.
//
// **#191 inventory of former store fields and their new homes:**
//   - thumbSize, sort, filter, sidebarVisible, inspectorVisible, activeTab,
//     viewMode, sectionOpen, folderOpen
//       → extracted into BrowsePreferencesService (slice 1, PR #216)
//         (`browse-preferences.service.ts`). Callers read them via the
//         LibraryStateService facade, which re-exports each signal.
//   - searchQuery
//       → extracted in this PR into LibrarySelection
//         (`library-selection.service.ts`). The toolbar search input is
//         conceptually part of the selection-state group (`selectedAssetIds`,
//         `focusedAssetId`, `selectedSourceId` already live there). Re-exported
//         via the facade so consumers keep working unchanged.
//   - pickerVisible, adminVisible, backendLoading, backendError, backendEmpty,
//     rescanStatus, rescanError
//       → still on this store; planned to collapse into component / fetcher
//         signals in follow-up PRs per the issue brief.

import { Injectable, computed, inject, signal } from '@angular/core';
import { Asset, AssetId, Flag, ColorLabel } from '../models/asset';
import { SidebarEntry, GridFolderItem } from '../models/folder';
import {
  AdjustmentModel,
  defaultAdjustmentModel,
  isDefaultAdjustment,
} from '../models/adjustment-model';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { ApiFolder } from '../api/bun-api-backend.service';
import { MapleFolderHandle } from '../folder-access/folder-access.types';
import { MapleIndex } from '../maple-cache/maple-cache.types';

// ─── Location helpers (content-addressing migration) ───────────────────────
//
// Mirror of `assetAbsPath` from `src/api/src/indexer/images.repo.ts`. Prefers
// the new `fileinfo[]` array (PR 1 of the migration) and falls back to the
// legacy `absPath` field while the server is mid-migration. After the server
// drops `abs_path` from the wire DTO, the fallback becomes a hard `null`
// signal that the asset is unresolvable on this client.
//
// `libraries` is keyed by hex ObjectId of the registered library →
// absolute library root path. Callers derive it from
// `LibraryStore.registeredFolders`; see `librariesById` below.

/**
 * Resolve the absolute filesystem path for an asset's primary on-disk
 * location, composed from the library root plus the relative directory and
 * filename in `fileinfo[0]`.
 *
 * Returns `null` when neither source resolves — usually means the registered
 * library that owns the file is not loaded (e.g. server hasn't sent
 * `/api/folders` yet) or the asset has neither `fileinfo` nor `absPath`.
 */
export function assetAbsPath(
  asset: Pick<Asset, 'fileinfo' | 'absPath'>,
  libraries: ReadonlyMap<string, string>,
): string | null {
  const primary = (asset.fileinfo ?? []).find((entry) => !entry.deleted_at);
  if (primary) {
    const root = libraries.get(primary.library_id);
    if (root) {
      // FileInfo.path is POSIX-separated by contract. Web is always POSIX
      // so we can join with `/` without re-splitting.
      //
      // Normalise the slash boundaries so a trailing `/` on `root` (e.g.
      // `"/Volumes/Photos/"`) or a stray leading/trailing `/` on
      // `primary.path` doesn't produce `//` in the joined result.
      // Preserve `root === "/"` (root of the filesystem) as-is.
      const trimmedRoot = root === '/' ? '/' : root.replace(/\/+$/, '');
      const dir = primary.path.replace(/^\/+|\/+$/g, '');
      const rootPrefix = trimmedRoot === '/' ? '' : trimmedRoot;
      return dir === ''
        ? `${rootPrefix}/${primary.filename}`
        : `${rootPrefix}/${dir}/${primary.filename}`;
    }
  }
  // Fall back to the client-synthesised fs-walk path (NOT a wire field —
  // see the docstring on `Asset.absPath`).
  if (asset.absPath) return asset.absPath;
  return null;
}

/**
 * Build a `hex(library_id) → root path` map from a list of registered
 * libraries. Pass `store.registeredFolders()` at the call site so the
 * result is reactive when used inside a `computed`.
 */
export function buildLibrariesById(folders: readonly ApiFolder[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const f of folders) map.set(f.id, f.path);
  return map;
}

@Injectable({ providedIn: 'root' })
export class LibraryStore {
  /** Which backend is in use. Consumers read this to branch data-source paths. */
  readonly backend = inject(LIBRARY_BACKEND);

  // BrowsePreferencesService is consumed directly by LibraryStateService
  // (the facade) and the components that need it — there is no store-level
  // consumer of the prefs, so this class does not inject it.

  // ── Self-Hosted bootstrap state ────────────────────────────────────────────
  /** True while listFolders / listAssets is in flight (Self-Hosted only). */
  readonly backendLoading = signal<boolean>(false);
  /** Last backend error message, cleared on successful load. */
  readonly backendError = signal<string | null>(null);
  /** True when the API returned zero folders (index not configured yet). */
  readonly backendEmpty = signal<boolean>(false);
  /** Latest server-side registered libraries. */
  readonly registeredFolders = signal<ApiFolder[]>([]);
  /**
   * Reactive `hex(library_id) → absolute root path` map derived from
   * `registeredFolders`. Pass to `assetAbsPath(asset, libraries)` to
   * resolve content-addressed assets via `fileinfo[0]`.
   */
  readonly librariesById = computed(() => buildLibrariesById(this.registeredFolders()));
  /** Transient state for the "Rescan" button on the toolbar. */
  readonly rescanStatus = signal<'idle' | 'running' | 'done' | 'error'>('idle');
  readonly rescanError = signal<string | null>(null);

  /** True while the library-picker modal is open. */
  readonly pickerVisible = signal(false);

  openLibraryPicker(): void {
    this.pickerVisible.set(true);
  }

  closeLibraryPicker(): void {
    this.pickerVisible.set(false);
  }

  /** True while the indexer admin panel is open. */
  readonly adminVisible = signal(false);

  openIndexerAdmin(): void {
    this.adminVisible.set(true);
  }

  closeIndexerAdmin(): void {
    this.adminVisible.set(false);
  }

  /**
   * Map from AssetId to the remote API asset id (Self-Hosted only).
   */
  readonly apiAssetIds = new Map<AssetId, string>();

  /**
   * Map from AssetId to the absolute filesystem path (Self-Hosted FS-walk).
   */
  readonly assetAbsPaths = new Map<AssetId, string>();

  // ── Library data ───────────────────────────────────────────────────────────
  readonly assets = signal<Asset[]>([]);
  readonly gridFolders = signal<GridFolderItem[]>([]);
  readonly sidebarTree = signal<SidebarEntry[]>([]);

  // ── Current folder handle ─────────────────────────────────────────────────
  /** The folder the user most recently opened via openFolder(). */
  readonly currentFolder = signal<MapleFolderHandle | null>(null);

  // ── Adjustment models (per-asset develop settings) ────────────────────────
  readonly adjustmentModels = signal<Map<AssetId, AdjustmentModel>>(new Map());

  /** The in-memory .maple/index.json mirror for the current folder. */
  folderIndex: MapleIndex | null = null;

  // ── Asset mutations ────────────────────────────────────────────────────────

  updateAssetDimensions(id: AssetId, width: number, height: number): void {
    this.assets.update((list) =>
      list.map((a) => (a.id === id ? { ...a, width, height, aspectRatio: width / height } : a)),
    );
  }

  /**
   * Seed Temperature + Tint from the RAW's AsShot metadata so the editor's
   * WB sliders reflect the camera's own white-balance reading on first open.
   * No-op if the user has already edited those fields.
   */
  seedAsShotWhiteBalance(id: AssetId, temperature: number, tint: number): void {
    this.adjustmentModels.update((map) => {
      const current = map.get(id) ?? defaultAdjustmentModel();
      const isStillDefault =
        Math.abs(current.temperature - 6500) < 0.5 && Math.abs(current.tint) < 0.5;
      if (!isStillDefault) return map;
      // Snap to the Temperature slider's 50 K step so the numeric field
      // doesn't render a 12-digit float in the UI.
      const snapped = Math.round(temperature / 50) * 50;
      const next = new Map(map);
      next.set(id, { ...current, temperature: snapped, tint: Math.round(tint) });
      return next;
    });
  }

  // ── Adjustment models ──────────────────────────────────────────────────────

  adjustmentFor(id: AssetId) {
    return computed(() => this.adjustmentModels().get(id) ?? defaultAdjustmentModel());
  }

  setAdjustment(id: AssetId, patch: Partial<AdjustmentModel>): void {
    this.adjustmentModels.update((map) => {
      const next = new Map(map);
      const current = next.get(id) ?? defaultAdjustmentModel();
      next.set(id, { ...current, ...patch });
      return next;
    });
  }

  isEdited(id: AssetId) {
    return computed(() => {
      const m = this.adjustmentModels().get(id);
      return !!m && !isDefaultAdjustment(m);
    });
  }

  // ── Self-Hosted id-map helpers ────────────────────────────────────────────

  /** Returns the on-disk path for a Self-Hosted FS-walk asset, if any. */
  absPathFor(assetId: AssetId): string | undefined {
    return this.assetAbsPaths.get(assetId);
  }

  /** Returns the API id for a local asset id (Self-Hosted only). */
  apiIdFor(assetId: AssetId): string | undefined {
    return this.apiAssetIds.get(assetId);
  }

  /**
   * Resolve the registered library that owns the current Self-Hosted
   * selection (picked by `selectedSourceId`). Walks `registeredFolders` for
   * the longest path-prefix match. Returns null when nothing is selected,
   * the user is on Hosted, or the path doesn't fall under any library.
   */
  currentRegisteredFolder(selectedSourceId: string): ApiFolder | null {
    if (this.backend !== 'self-hosted') return null;
    if (!selectedSourceId.startsWith('fs:')) return null;
    const absPath = selectedSourceId.slice('fs:'.length);
    if (!absPath) return null;
    const folders = this.registeredFolders();
    let best: ApiFolder | null = null;
    for (const f of folders) {
      if (absPath === f.path || absPath.startsWith(f.path + '/')) {
        if (!best || f.path.length > best.path.length) best = f;
      }
    }
    return best;
  }

  // ── Sidebar helpers ────────────────────────────────────────────────────────

  ensureFolder(folderId: string, label: string): void {
    this.sidebarTree.update((tree) => {
      const foldersSection = tree.find((s) => s.id === 'folders');
      if (!foldersSection || !foldersSection.children) return tree;
      if (foldersSection.children.some((c) => c.id === folderId)) return tree;
      return tree.map((s) =>
        s.id === 'folders'
          ? {
              ...s,
              children: [
                ...(s.children ?? []),
                { kind: 'folder' as const, id: folderId, label, count: null },
              ],
            }
          : s,
      );
    });
  }

  ensureImportedFolder(): void {
    this.ensureFolder('f-imported', 'Imported');
  }

  ensureFsFolder(id: string, label: string, absPath: string): void {
    this.sidebarTree.update((tree) => {
      // Prune any stale "folders" section from older sessions / cache. New
      // top-level entries replace it; the section becomes inert otherwise.
      const pruned = tree.filter((node) => !(node.kind === 'section' && node.id === 'folders'));
      if (pruned.some((c) => c.id === id)) return pruned;
      return [
        ...pruned,
        {
          kind: 'folder' as const,
          id,
          label,
          count: null,
          absPath,
        },
      ];
    });
  }

  /** Look up the SidebarEntry id whose absPath equals `absPath`. */
  sourceIdForFsPath(absPath: string): string | null {
    const walk = (entries: SidebarEntry[]): string | null => {
      for (const e of entries) {
        if (e.absPath === absPath) return e.id;
        if (e.children) {
          const hit = walk(e.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(this.sidebarTree());
  }

  /**
   * Walk the sidebar tree, applying `patcher` to the entry whose id matches
   * `targetId`. Returns a new tree (immutable update so the signal fires).
   */
  patchTree(
    tree: SidebarEntry[],
    targetId: string,
    patcher: (entry: SidebarEntry) => SidebarEntry,
  ): SidebarEntry[] {
    return tree.map((entry) => {
      if (entry.id === targetId) return patcher(entry);
      if (entry.children) {
        const patched = this.patchTree(entry.children, targetId, patcher);
        if (patched !== entry.children) {
          return { ...entry, children: patched };
        }
      }
      return entry;
    });
  }

  /** Look up an asset record by id from the current signal value. */
  findAsset(id: AssetId): Asset | undefined {
    return this.assets().find((a) => a.id === id);
  }
}
