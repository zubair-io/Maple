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
//       → extracted into LibrarySelection (`library-selection.service.ts`,
//         slice 2, PR #289). The toolbar search input is conceptually part
//         of the selection-state group (`selectedAssetIds`, `focusedAssetId`,
//         `selectedSourceId` already live there). Re-exported via the facade
//         so consumers keep working unchanged.
//   - backendLoading, backendError, backendEmpty, rescanStatus, rescanError
//       → extracted in this PR into LibraryStatusService
//         (`library-status.service.ts`, slice 3). Async-lifecycle signals
//         for Self-Hosted bootstrap + rescan flows. `LibraryFetch` (the
//         only writer) now injects the status service directly; the
//         facade re-exports each signal so component consumers are
//         unchanged.
//   - pickerVisible, adminVisible
//       → still on this store; pure UI visibility flags, planned to move
//         to shell-component signals in a follow-up PR.

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
import { parseAddress } from '../addressing/maple-address';
import type { XmpCulling } from '../xmp/xmp.types';

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
  readonly singleFileMemoryOnly = signal(false);
  /** Which backend is in use. Consumers read this to branch data-source paths. */
  readonly backend = inject(LIBRARY_BACKEND);

  // BrowsePreferencesService is consumed directly by LibraryStateService
  // (the facade) and the components that need it — there is no store-level
  // consumer of the prefs, so this class does not inject it.

  // ── Self-Hosted bootstrap state ────────────────────────────────────────────
  // Note: the five async-lifecycle signals (backendLoading, backendError,
  // backendEmpty, rescanStatus, rescanError) moved to
  // `LibraryStatusService` in slice 3 of #191. The facade still
  // re-exports them so component consumers are unchanged.
  /** Latest server-side registered libraries. */
  readonly registeredFolders = signal<ApiFolder[]>([]);
  /**
   * Reactive `hex(library_id) → absolute root path` map derived from
   * `registeredFolders`. Pass to `assetAbsPath(asset, libraries)` to
   * resolve content-addressed assets via `fileinfo[0]`.
   */
  readonly librariesById = computed(() => buildLibrariesById(this.registeredFolders()));

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

  /**
   * Per-asset camera As-Shot white balance (Kelvin + tint), captured from
   * the RAW's AsShot metadata on first decode via `seedAsShotWhiteBalance`.
   * Held durably and independently of the live `temperature`/`tint` slider
   * values so the editor's RESET can restore WB → As-Shot at any time, even
   * after the user has edited the WB sliders. Session-scoped — not persisted
   * to XMP (the camera reading is re-derived from the RAW on every decode).
   */
  private readonly asShotWb = new Map<AssetId, { temperature: number; tint: number }>();

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
    // Snap to the Temperature slider's 50 K step so the numeric field
    // doesn't render a 12-digit float in the UI.
    const snapped = Math.round(temperature / 50) * 50;
    const roundedTint = Math.round(tint);

    // Record the camera reading durably, independent of the "still default"
    // guard below, so the editor's RESET can restore WB → As-Shot at any
    // time — even after the user has already moved the WB sliders.
    this.asShotWb.set(id, { temperature: snapped, tint: roundedTint });

    this.adjustmentModels.update((map) => {
      const current = map.get(id) ?? defaultAdjustmentModel();
      const isStillDefault =
        Math.abs(current.temperature - 6500) < 0.5 && Math.abs(current.tint) < 0.5;
      if (!isStillDefault) return map;
      const next = new Map(map);
      next.set(id, { ...current, temperature: snapped, tint: roundedTint });
      return next;
    });
  }

  /**
   * Camera As-Shot white balance (Kelvin + tint) for `id`, or `undefined`
   * if the asset hasn't been decoded yet (no AsShot reading captured). Used
   * by the editor's RESET to point WB at the camera reading.
   */
  asShotWbFor(id: AssetId): { temperature: number; tint: number } | undefined {
    return this.asShotWb.get(id);
  }

  // ── Adjustment models ──────────────────────────────────────────────────────

  adjustmentFor(id: AssetId) {
    return computed(() => this.adjustmentModels().get(id) ?? defaultAdjustmentModel());
  }

  setAdjustment(id: AssetId, patch: Partial<AdjustmentModel>): Partial<AdjustmentModel> {
    // Every setAdjustment call site is user-driven (sliders, WB pad, AUTO,
    // RESET, undo, paste) — record it so a late sidecar restore (#2406)
    // can never overwrite what the user is looking at.
    this._sessionEdited.add(id);
    // A temperature/tint value in the patch WITHOUT an explicit preset is a
    // user WB edit — leave 'As Shot' for it and the serializer would drop
    // the pair on save (an As-Shot model's temperature/tint are the camera
    // display seed, not authored values — see XmpSerializerService). Callers
    // that mean a preset state (RESET, the WB pills, a parsed sidecar's full
    // model) always carry whiteBalancePreset in the patch themselves.
    const wbEdited =
      (patch.temperature !== undefined || patch.tint !== undefined) &&
      patch.whiteBalancePreset === undefined;
    const effective: Partial<AdjustmentModel> = wbEdited
      ? { ...patch, whiteBalancePreset: 'Custom' }
      : patch;
    this.adjustmentModels.update((map) => {
      const next = new Map(map);
      const current = next.get(id) ?? defaultAdjustmentModel();
      next.set(id, { ...current, ...effective });
      return next;
    });
    return effective;
  }

  isEdited(id: AssetId) {
    return computed(() => {
      const m = this.adjustmentModels().get(id);
      return !!m && !isDefaultAdjustment(m);
    });
  }

  /**
   * Asset ids the user has touched this session — via `setAdjustment` or any
   * scheduled sidecar write (culling included, see
   * `LibraryFetch.scheduleSidecarWrite`). A sidecar restore must never
   * overwrite these: the in-memory model is newer than whatever the fetch
   * returns (#2406).
   */
  private readonly _sessionEdited = new Set<AssetId>();
  private readonly _sessionCullingPatches = new Map<AssetId, Partial<XmpCulling>>();

  markSessionEdited(id: AssetId): void {
    this._sessionEdited.add(id);
  }

  setCulling(id: AssetId, patch: Partial<XmpCulling>): void {
    this._sessionEdited.add(id);
    this._sessionCullingPatches.set(id, {
      ...this._sessionCullingPatches.get(id),
      ...patch,
    });
    this.assets.update((assets) =>
      assets.map((asset) => (asset.id === id ? { ...asset, ...patch } : asset)),
    );
  }

  mergePersistedCulling(id: AssetId, persisted: XmpCulling): XmpCulling {
    const merged = { ...persisted, ...(this._sessionCullingPatches.get(id) ?? {}) };
    this.assets.update((assets) =>
      assets.map((asset) => (asset.id === id ? { ...asset, ...merged } : asset)),
    );
    return merged;
  }

  /**
   * Apply a sidecar-parsed adjustment model for `id` unless the user already
   * edited it this session. Carries a decode-time As-Shot WB seed through
   * when the sidecar doesn't author explicit WB values (an "As Shot" sidecar
   * parses with no temperature/tint, and spreading it over defaults would
   * reset the seeded camera reading to 6500 K). Returns whether it applied.
   */
  restoreAdjustment(id: AssetId, parsed: Partial<AdjustmentModel>): boolean {
    if (this._sessionEdited.has(id)) return false;
    this.adjustmentModels.update((map) => {
      const current = map.get(id);
      const wbSeed = current ? { temperature: current.temperature, tint: current.tint } : {};
      const next = new Map(map);
      next.set(id, { ...defaultAdjustmentModel(), ...wbSeed, ...parsed });
      return next;
    });
    return true;
  }

  /** Merge a delayed persisted base with fields authored during that read. */
  mergePersistedAdjustment(
    id: AssetId,
    persisted: Partial<AdjustmentModel>,
    authored: Partial<AdjustmentModel>,
  ): AdjustmentModel {
    const current = this.adjustmentModels().get(id) ?? defaultAdjustmentModel();
    const merged = { ...current, ...persisted, ...authored };
    this.adjustmentModels.update((models) => new Map(models).set(id, merged));
    return merged;
  }

  // ── Self-Hosted id-map helpers ────────────────────────────────────────────

  /**
   * Returns the on-disk path for a Self-Hosted asset, if resolvable.
   *
   * Legacy FS-walk assets are looked up in `assetAbsPaths`; post-M2
   * `slug:relPath` addresses resolve through the registered library that
   * owns the slug (`<library.path>/<relPath>`). The M2 cutover (#1325)
   * stopped populating `assetAbsPaths`, which silently disabled every
   * path-keyed write (XMP sidecar POST, developed-preview PUT) — the
   * address fallback here is what revives them (#2406).
   */
  absPathFor(assetId: AssetId): string | undefined {
    const legacy = this.assetAbsPaths.get(assetId);
    if (legacy) return legacy;
    if (!assetId.includes(':') || assetId.startsWith('fs:')) return undefined;
    try {
      const addr = parseAddress(assetId);
      const library = this.registeredFolders().find(
        (f) => f.slug === addr.slug || f.id === addr.slug,
      );
      if (!library) return undefined;
      const root = library.path.replace(/\/+$/, '');
      return addr.relPath ? `${root}/${addr.relPath}` : root;
    } catch {
      return undefined;
    }
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
  /**
   * Resolve the registered library that owns the current Self-Hosted selection.
   *
   * After M2 the `selectedSourceId` is a `slug:relPath` MapleAddress string.
   * We match by slug: `ApiFolder.slug` (from M1's server response) or fall
   * back to `ApiFolder.id` when the server is pre-M1 and no slug was returned.
   *
   * Legacy `fs:<absPath>` ids (stored in older localStorage sessions) are
   * handled with a path-prefix walk for backward compat, but no new ids are
   * created in that format.
   */
  currentRegisteredFolder(selectedSourceId: string): ApiFolder | null {
    if (this.backend !== 'self-hosted') return null;
    if (!selectedSourceId) return null;
    const folders = this.registeredFolders();

    // New format: slug:relPath
    if (selectedSourceId.includes(':') && !selectedSourceId.startsWith('fs:')) {
      try {
        const addr = parseAddress(selectedSourceId);
        return folders.find((f) => f.slug === addr.slug || f.id === addr.slug) ?? null;
      } catch {
        return null;
      }
    }

    // Legacy: fs:<absPath> — path-prefix walk for backward compat.
    if (selectedSourceId.startsWith('fs:')) {
      const absPath = selectedSourceId.slice('fs:'.length);
      if (!absPath) return null;
      let best: ApiFolder | null = null;
      for (const f of folders) {
        if (absPath === f.path || absPath.startsWith(f.path + '/')) {
          if (!best || f.path.length > best.path.length) best = f;
        }
      }
      return best;
    }

    return null;
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

  /** Look up the SidebarEntry id whose absPath equals `absPath` (legacy). */
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
   * Look up a SidebarEntry id by relative path component within any library.
   * Walks the tree looking for an entry whose `id` has relPath equal to `relPath`.
   * Used by `openSelfHostedSubfolder` to re-use an existing node's address id
   * when the caller passes only the relPath without the slug.
   */
  sourceIdForRelPath(relPath: string): string | null {
    const walk = (entries: SidebarEntry[]): string | null => {
      for (const e of entries) {
        if (e.id.includes(':')) {
          try {
            const addr = parseAddress(e.id);
            if (addr.relPath === relPath) return e.id;
          } catch {
            // Not a MapleAddress — skip.
          }
        }
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
