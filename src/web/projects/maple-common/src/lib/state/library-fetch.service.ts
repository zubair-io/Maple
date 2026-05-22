// Library fetch — folder/asset enumeration, XMP I/O, index writes.
//
// Coordinates the store (data + id-maps), selection (cursor placement), and
// cache (file handles + LRU priming) to bring assets into view from any of
// the three backends (FS Access folder, Self-Hosted FS-walk, Self-Hosted
// Mongo). Also owns the debounced sidecar write and the `.maple/index.json`
// debounced mirror.

import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, effect, inject } from '@angular/core';
import { Asset, AssetId, ColorLabel, Flag } from '../models/asset';
import { GridFolderItem, SidebarEntry } from '../models/folder';
import { AdjustmentModel, defaultAdjustmentModel } from '../models/adjustment-model';
import { ApiFolder, BunApiBackendService } from '../api/bun-api-backend.service';
import {
  FilesystemBrowseService,
  FsDirListing,
  FsImageEntry,
  FsImageExif,
} from '../api/filesystem-browse.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { SidecarStore } from '../xmp/sidecar.store';
import { XmpCulling } from '../xmp/xmp.types';
import { MapleFolderHandle } from '../folder-access/folder-access.types';
import { IndexedAsset } from '../maple-cache/maple-cache.types';
import { sha256Prefix16 } from '../maple-cache/sha';
import { mergePreservingRefs, shallowEqualByKeys } from './merge-by-id';
import { LibraryStore } from './library-store.service';
import { LibrarySelection } from './library-selection.service';
import { LibraryCache } from './library-cache.service';
import { LibraryStatusService } from './library-status.service';
import { BrowsePreferencesService } from './browse-preferences.service';

const ASSET_RENDER_KEYS: readonly (keyof Asset)[] = [
  'id',
  'folderId',
  'filename',
  'absPath',
  'rating',
  'flag',
  'colorLabel',
  'edited',
  'aspectRatio',
  'thumbnailGradient',
  'size',
  'mtime',
  'width',
  'height',
];

const assetsEqualForRender = (a: Asset, b: Asset): boolean =>
  shallowEqualByKeys(a, b, ASSET_RENDER_KEYS);

/** Supported RAW extensions for file intake. */
export const SUPPORTED_RAW_EXTENSIONS = new Set([
  'dng',
  'cr2',
  'cr3',
  'nef',
  'arw',
  'raf',
  'orf',
  'rw2',
  'pef',
  'srw',
  '3fr',
  'fff',
  'dcr',
  'mos',
  'iiq',
  'mrw',
  'raw',
]);

export function isSupportedRaw(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_RAW_EXTENSIONS.has(ext);
}

/**
 * localStorage key for the Self-Hosted last-selected source id.
 *
 * Single source of truth: `LibraryFetch._selectInitialFolder` reads it on
 * cold start and `BrowseShellComponent` writes it from a `selectedSourceId`
 * effect. Both sides import this constant so the key can't silently drift.
 */
export const LAST_SOURCE_KEY = 'cm.lastSourceId';

/**
 * Format the indexer's EXIF subdocument into the human-readable strings the
 * Asset model + Info-tab template expect (`f/2.8`, `50mm`, `Hasselblad
 * L3D-100c`, etc). Returns a partial Asset slice — fields stay undefined
 * when EXIF is missing or the corresponding sub-field is null.
 */
export function exifToAssetMetadata(exif: FsImageExif | null | undefined): Partial<Asset> {
  if (!exif) return {};
  const camera = [exif.camera_make, exif.camera_model]
    .filter((s): s is string => !!s && s.length > 0)
    .join(' ')
    .trim();
  return {
    camera: camera.length > 0 ? camera : undefined,
    lens: exif.lens ?? undefined,
    focalLength: exif.focal_length != null ? `${exif.focal_length}mm` : undefined,
    aperture: exif.aperture != null ? `f/${exif.aperture}` : undefined,
    shutter: exif.shutter ?? undefined,
    iso: exif.iso ?? undefined,
    capturedAt: exif.captured_at ?? undefined,
    gps: exif.gps ? { lat: exif.gps.lat, lon: exif.gps.lng } : undefined,
  };
}

@Injectable({ providedIn: 'root' })
export class LibraryFetch {
  private readonly store = inject(LibraryStore);
  private readonly status = inject(LibraryStatusService);
  private readonly selection = inject(LibrarySelection);
  private readonly cache_ = inject(LibraryCache);
  private readonly fs = inject(FolderAccessService);
  private readonly mapleCache = inject(MapleCacheService);
  private readonly xmpParser = inject(XmpParserService);
  private readonly xmpStore = inject(XmpStoreService);
  private readonly xmpSerializer = inject(XmpSerializerService);
  private readonly sidecarStore = inject(SidecarStore);
  private readonly api = inject(BunApiBackendService);
  private readonly fsBrowse = inject(FilesystemBrowseService);
  private readonly prefs = inject(BrowsePreferencesService);

  // ── Index write debounce ──────────────────────────────────────────────────
  private _indexWriteTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Self-Hosted XMP write debounce ────────────────────────────────────────
  private readonly API_XMP_DEBOUNCE_MS = 750;
  private readonly _apiXmpTimers = new Map<AssetId, ReturnType<typeof setTimeout>>();
  private readonly _apiXmpPending = new Map<
    AssetId,
    { model: AdjustmentModel; culling: XmpCulling }
  >();

  constructor() {
    // Debounced index write: re-fires 500ms after the last culling change.
    effect(() => {
      const assets = this.store.assets();
      const folder = this.store.currentFolder();
      // Access assets to ensure signal dependency is tracked.
      void assets;
      if (!folder?.write) return;
      this._scheduleIndexWrite();
    });
  }

  // ── Folder open ────────────────────────────────────────────────────────────

  /**
   * Open a folder, load its assets, and integrate the .maple/ cache.
   *
   * Flow:
   * 1. Try .maple/index.json — if warm, populate culling from cache.
   * 2. Enumerate RAW files; build Asset records.
   * 3. For each RAW, try to read a .xmp sidecar (culling overrides cache).
   * 4. Populate assets signal + sidebarTree.
   * 5. Store FolderEntry handles for lazy byte reads.
   */
  async openFolder(folder: MapleFolderHandle): Promise<void> {
    this.store.currentFolder.set(folder);
    this.cache_.clearAll();

    // 1. Load .maple/index.json for cached culling state.
    const index = await this.mapleCache.readIndex(folder);
    this.store.folderIndex = index ?? this.mapleCache.emptyIndex();

    // 2. Enumerate folder entries.
    const entries = await this.fs.listEntries(folder);
    const rawEntries = entries.filter((e) => e.kind === 'file' && isSupportedRaw(e.name));

    // Build a lookup of culling from the index (cache, non-authoritative).
    const indexMap = new Map<string, IndexedAsset>(
      (index?.assets ?? []).map((a) => [a.filename, a]),
    );

    const newAssets: Asset[] = [];
    const folderId = `f-${folder.name}`;
    const newAdjustments = new Map<AssetId, AdjustmentModel>();

    for (const entry of rawEntries) {
      const id = crypto.randomUUID();
      const filename = entry.name;

      // Register file handle for lazy reads.
      this.cache_.registerHandle(id, entry);

      // Start with culling from cache (non-authoritative).
      const cached = indexMap.get(filename);
      let rating: number = cached?.culling?.rating ?? 0;
      let flag: Flag = (cached?.culling?.flag ?? 'unflagged') as Flag;
      let colorLabel: ColorLabel = (cached?.culling?.colorLabel ?? null) as ColorLabel;

      // XMP sidecar is authoritative — parse both culling + full AdjustmentModel.
      const xmpName = filename.replace(/\.[^.]+$/, '.xmp');
      try {
        const xmpBytes = await this.fs.readFile(folder, xmpName);
        const xmpText = new TextDecoder().decode(xmpBytes);

        // Culling fields (P5).
        const culling = this.xmpParser.parseCulling(xmpText);
        rating = culling.rating;
        flag = culling.flag;
        colorLabel = culling.colorLabel;

        // Full AdjustmentModel (P6).
        const { model, passthrough } = this.xmpParser.parseAdjustmentModel(xmpText);
        const fullModel: AdjustmentModel = { ...defaultAdjustmentModel(), ...model };
        newAdjustments.set(id, fullModel);

        // Cache the passthrough bucket for future writes.
        this.xmpStore.rememberPassthrough(id, passthrough);
      } catch {
        // No sidecar or unreadable — keep cache values, no adjustment override.
      }

      const asset: Asset = {
        id,
        filename,
        folderId,
        rating,
        flag,
        colorLabel,
        thumbnailGradient: '',
        aspectRatio: 3 / 2, // corrected after first decode
      };
      newAssets.push(asset);
    }

    this.store.assets.update((list) => {
      // Remove previous assets for the same folder; keep other folders.
      const others = list.filter((a) => a.folderId !== folderId);
      const previous = list.filter((a) => a.folderId === folderId);
      const merged = mergePreservingRefs(previous, newAssets, assetsEqualForRender);
      return [...others, ...merged];
    });

    // Merge loaded adjustments into the signal (only overwrite for this folder).
    if (newAdjustments.size > 0) {
      this.store.adjustmentModels.update((map) => {
        const next = new Map(map);
        for (const [id, adj] of newAdjustments) {
          next.set(id, adj);
        }
        return next;
      });
    }

    // 3. Ensure the folder appears in the sidebar tree.
    this.store.ensureFolder(folderId, folder.name);
    this.selection.selectedSourceId.set(folderId);
  }

  // ── Self-Hosted bootstrap (Bun API) ────────────────────────────────────────

  /**
   * Self-Hosted entry point: list folders from the API, populate the sidebar.
   *
   * Hosted variant should not call this — it uses `openFolder(handle)` via the
   * File System Access picker on the landing page.
   */
  loadFolderTree(): void {
    if (this.store.backend !== 'self-hosted') return;

    this.status.backendLoading.set(true);
    this.status.backendError.set(null);
    this.status.backendEmpty.set(false);

    this.api.listFolders().subscribe({
      next: (folders) => {
        this.store.registeredFolders.set(folders);
        this._applyFolderTree(folders);
        if (folders.length === 0) {
          this.status.backendEmpty.set(true);
        } else {
          // Land the user on a folder so the grid isn't an empty "pick a
          // folder" state. Skipped when something already set the selection
          // (e.g. BrowseShell read `?folder=<absPath>` from the URL on cold
          // start, or the user clicked a folder mid-flight).
          this._selectInitialFolder(folders);
        }
        this.status.backendLoading.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.status.backendLoading.set(false);
        this.status.backendError.set(
          err.status >= 500
            ? `Server error (${err.status}). The Maple API may be down.`
            : `Failed to load folders: ${err.message}`,
        );
      },
    });
  }

  /**
   * Pick a folder to land on after a `loadFolderTree` returns:
   *   1. Respect any pre-set `selectedSourceId` (URL `?folder=…` was applied
   *      synchronously in BrowseShell before this call). Still synthesize
   *      ancestor tree nodes for sub-folder paths so the breadcrumb +
   *      sidebar highlight resolve.
   *   2. Otherwise, try the last source the user picked (localStorage).
   *      Either the registered library itself, or a sub-folder inside one.
   *   3. Otherwise, open the first registered library.
   */
  private _selectInitialFolder(folders: ApiFolder[]): void {
    const findOwningLib = (absPath: string): ApiFolder | undefined =>
      folders.find((f) => absPath === f.path || absPath.startsWith(f.path + '/'));

    const existing = this.selection.selectedSourceId();
    if (existing) {
      // URL deep-link applied selection before libraries were known.
      // Synthesize the ancestor chain now so the sidebar can resolve a
      // label and (eventually, when the user expands) show the chain.
      if (existing.startsWith('fs:')) {
        const absPath = existing.slice(3);
        const owning = findOwningLib(absPath);
        if (owning && absPath !== owning.path) {
          this._ensureFsPathInTree(absPath, owning.path);
        }
      }
      return;
    }

    const lastId = (() => {
      try {
        return localStorage.getItem(LAST_SOURCE_KEY);
      } catch {
        return null;
      }
    })();

    if (lastId && lastId.startsWith('fs:')) {
      const absPath = lastId.slice(3);
      const exactRoot = folders.find((f) => f.path === absPath);
      if (exactRoot) {
        this.openSelfHostedFolder(exactRoot);
        return;
      }
      // Sub-folder of a registered library — descendants are not in the
      // top-level `folders` listing, but `openSelfHostedSubfolder` fetches
      // via `/api/fs/dir` so it works as long as some library owns the
      // path. Synthesize the ancestor chain first so the sidebar has
      // somewhere to highlight the restored selection.
      const owningLib = findOwningLib(absPath);
      if (owningLib) {
        this._ensureFsPathInTree(absPath, owningLib.path);
        this.openSelfHostedSubfolder(absPath, lastId);
        return;
      }
    }

    const first = folders[0];
    if (first) this.openSelfHostedFolder(first);
  }

  /**
   * Insert minimal sibling-less sidebar nodes for each ancestor of
   * `absPath` under the registered `libraryRoot`, and auto-expand the
   * library root + every ancestor so the deep selection is visible in
   * the sidebar from the moment the page loads.
   *
   * Children are loaded lazily — the synthesized nodes have no
   * `childrenStatus`, so clicking the chevron triggers a real
   * `expandFsFolder` fetch. The chain just needs to exist so
   * `selectedSourceLabel` resolves and the highlight has somewhere
   * to land.
   *
   * No-ops if `absPath` isn't a strict descendant of `libraryRoot`.
   */
  private _ensureFsPathInTree(absPath: string, libraryRoot: string): void {
    if (absPath === libraryRoot) return;
    if (!absPath.startsWith(libraryRoot + '/')) return;
    const rel = absPath.slice(libraryRoot.length + 1);
    const segments = rel.split('/').filter(Boolean);
    if (segments.length === 0) return;

    // Make the library row itself open so its children (the first
    // ancestor we're about to synthesize) are visible.
    this.prefs.setFolderOpen(`fs:${libraryRoot}`, true);

    let parentId = `fs:${libraryRoot}`;
    let parentPath = libraryRoot;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      parentPath = `${parentPath}/${seg}`;
      const childId = `fs:${parentPath}`;
      const childLabel = seg;
      const childPath = parentPath;
      this.store.sidebarTree.update((tree) =>
        this.store.patchTree(tree, parentId, (n) => {
          if ((n.children ?? []).some((c) => c.id === childId)) return n;
          return {
            ...n,
            children: [
              ...(n.children ?? []),
              {
                kind: 'folder' as const,
                id: childId,
                label: childLabel,
                count: null,
                absPath: childPath,
              },
            ],
          };
        }),
      );
      // Auto-expand every ancestor on the chain (not the leaf itself —
      // it has no children yet to reveal, and its own grid is the
      // active view).
      if (i < segments.length - 1) {
        this.prefs.setFolderOpen(childId, true);
      }
      parentId = childId;
    }
  }

  /**
   * Self-Hosted: register a new library folder, then refresh the tree.
   * Called by LibraryPickerComponent on the empty-state of BrowseShell.
   */
  addLibraryFolder(absPath: string): void {
    if (this.store.backend !== 'self-hosted') return;

    this.status.backendLoading.set(true);
    this.status.backendError.set(null);

    this.api.registerFolder(absPath).subscribe({
      next: () => {
        this.store.closeLibraryPicker();
        this.loadFolderTree();
      },
      error: (err: HttpErrorResponse) => {
        this.status.backendLoading.set(false);
        const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
        this.status.backendError.set(`Failed to register folder: ${detail}`);
      },
    });
  }

  /**
   * Force a re-walk of the registered library that owns the current
   * selection. The server pushes every supported file under the library
   * root back into the indexer's discover channel; the upsert is
   * idempotent so unchanged files no-op and new files get indexed.
   */
  rescanCurrentFolder(): void {
    if (this.status.rescanStatus() === 'running') return;
    const folder = this.store.currentRegisteredFolder(this.selection.selectedSourceId());
    if (!folder) {
      this.status.rescanError.set('Pick a library folder first.');
      this.status.rescanStatus.set('error');
      return;
    }
    this.status.rescanError.set(null);
    this.status.rescanStatus.set('running');
    this.api.rescanFolder(folder.id).subscribe({
      next: (res) => {
        if (res.ok) {
          this.status.rescanStatus.set('done');
          // Brief success indicator, then return to idle.
          setTimeout(() => {
            if (this.status.rescanStatus() === 'done') this.status.rescanStatus.set('idle');
          }, 2_500);
        } else {
          this.status.rescanError.set(res.error ?? 'Rescan failed');
          this.status.rescanStatus.set('error');
        }
      },
      error: (err: HttpErrorResponse) => {
        const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
        this.status.rescanError.set(`Rescan failed: ${detail}`);
        this.status.rescanStatus.set('error');
      },
    });
  }

  /**
   * Self-Hosted: open a registered library by walking its filesystem.
   *
   * Replaces the old DB-asset path (`/api/folders/{id}/assets`) with one that
   * calls `/api/fs/dir?path=<abs>` against the library's root absolute path.
   */
  openSelfHostedFolder(folder: ApiFolder): void {
    if (this.store.backend !== 'self-hosted') return;

    const sourceId = `fs:${folder.path}`;
    this.openSelfHostedSubfolder(folder.path, sourceId);
  }

  /**
   * Self-Hosted: open an arbitrary directory inside a registered library by
   * walking the filesystem. `absPath` is the resolved on-disk path. Used by
   * the folder-tree sidebar when the user clicks into a sub-folder of a
   * library that's already been listed via `openSelfHostedFolder`.
   *
   * `sourceId` is the SidebarEntry id of the node this directory's contents
   * should attach to. When it's a registered-library root we use
   * `fs:<absPath>` (matching `ensureFsFolder`); for a sub-folder we use the
   * id assigned by `_attachFsChildren`.
   */
  openSelfHostedSubfolder(absPath: string, sourceId?: string, selectAssetId?: AssetId): void {
    if (this.store.backend !== 'self-hosted') return;

    const id = sourceId ?? this.store.sourceIdForFsPath(absPath) ?? `fs:${absPath}`;
    // Set the selection synchronously so the file-list breadcrumb + grid
    // empty-state reflect the click immediately, before the HTTP response.
    this.selection.selectedSourceId.set(id);
    this.status.backendLoading.set(true);
    this.status.backendError.set(null);
    this.status.backendEmpty.set(false);

    this.fsBrowse.listDir(absPath).subscribe({
      next: (listing) => {
        this._applyFsListing(id, absPath, listing);
        // If a caller passed `selectAssetId` (e.g. EditorShell cold-loading
        // a deep-linked asset), honour it. Otherwise select the first image
        // so the detail panel has something to render.
        if (selectAssetId) {
          const target = this.store.assets().find((a) => a.id === selectAssetId);
          if (target) this.selection.selectAsset(target.id);
        } else {
          const firstAsset = this.store.assets().find((a) => a.folderId === id);
          if (firstAsset) this.selection.selectAsset(firstAsset.id);
        }
        this.status.backendLoading.set(false);
        if (listing.dirs.length === 0 && listing.images.length === 0) {
          // Empty folder — clear any leftover error banner; the grid will
          // show its own "Folder is empty" state.
          this.status.backendEmpty.set(false);
        }
      },
      error: (err: HttpErrorResponse) => {
        this.status.backendLoading.set(false);
        const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
        this.status.backendError.set(
          err.status >= 500
            ? `Server error (${err.status}) loading folder.`
            : `Failed to load folder: ${detail}`,
        );
      },
    });
  }

  /**
   * Apply a `/api/fs/dir` listing to state:
   *  - Drop the current `assetAbsPaths` entries for the source.
   *  - Build new `Asset` records from `listing.images` and key them on path.
   *  - Replace the source's assets in the grid.
   *  - Build new `GridFolderItem` records from `listing.dirs` and replace the
   *    source's folder tiles in the grid.
   *  - Push `listing.dirs` into the sidebar tree as children of the matching
   *    node so the lazy-expand chevron has something to reveal.
   */
  private _applyFsListing(sourceId: string, absPath: string, listing: FsDirListing): void {
    // Forget previous assets for this source (path-based ids may collide
    // across re-opens after a rename — purge by folderId). Both the absPath
    // and apiId maps are cleared so a stale Mongo id can't outlive its file
    // (e.g. the file was deleted then re-created at the same path before
    // the indexer caught up — without this cleanup `apiIdFor` would return
    // the dead doc's id and the detail panel would render foreign data).
    const stale = this.store
      .assets()
      .filter((a) => a.folderId === sourceId)
      .map((a) => a.id);
    for (const id of stale) {
      this.store.assetAbsPaths.delete(id);
      this.store.apiAssetIds.delete(id);
    }

    const newAssets: Asset[] = listing.images.map((img: FsImageEntry) => {
      const id: AssetId = `fs:${img.path}`;
      this.store.assetAbsPaths.set(id, img.path);
      // Register the Mongo asset id so `apiIdFor(id)` resolves, which is what
      // the detail-panel's `getAssetDetails` call needs to fetch place /
      // faces / description / ocr. Absent on un-indexed files — the detail
      // fetch then no-ops and the enrichment sections stay hidden.
      if (img.id) this.store.apiAssetIds.set(id, img.id);
      const meta = exifToAssetMetadata(img.exif);
      return {
        id,
        filename: img.name,
        folderId: sourceId,
        rating: 0,
        flag: 'unflagged',
        colorLabel: null,
        thumbnailGradient: '',
        aspectRatio: 3 / 2,
        absPath: img.path,
        size: img.size,
        mtime: img.mtime,
        ...meta,
      };
    });

    this.store.assets.update((list) => {
      const others = list.filter((a) => a.folderId !== sourceId);
      const previous = list.filter((a) => a.folderId === sourceId);
      const merged = mergePreservingRefs(previous, newAssets, assetsEqualForRender);
      return [...others, ...merged];
    });

    const newFolders: GridFolderItem[] = listing.dirs.map((d) => ({
      id: `fs:${d.path}`,
      name: d.name,
      absPath: d.path,
      parentSourceId: sourceId,
      aspectRatio: 3 / 2,
    }));

    this.store.gridFolders.update((list) => {
      const others = list.filter((f) => f.parentSourceId !== sourceId);
      return [...others, ...newFolders];
    });

    this._attachFsChildren(sourceId, absPath, listing.dirs);
  }

  /**
   * Replace the children of the sidebar node identified by `sourceId` (a
   * registered library root or a previously-loaded subfolder) with folder
   * entries derived from `dirs`. Marks the node as `loaded` so the chevron
   * doesn't trigger another fetch.
   *
   * For children whose id already exists under this node, we preserve the
   * existing entry (carrying over `childrenStatus`, `children`, etc.) so
   * a refetch of a parent doesn't wipe a deeper expanded subtree — the
   * listing describes which directories exist, not their per-child
   * expanded state.
   */
  private _attachFsChildren(
    sourceId: string,
    _absPath: string,
    dirs: { name: string; path: string; mtime: string }[],
  ): void {
    this.store.sidebarTree.update((tree) =>
      this.store.patchTree(tree, sourceId, (n) => {
        const existingById = new Map<string, SidebarEntry>(
          (n.children ?? []).map((c) => [c.id, c]),
        );
        return {
          ...n,
          childrenStatus: 'loaded' as const,
          childrenError: undefined,
          children: dirs.map((d) => {
            const id = `fs:${d.path}`;
            const prior = existingById.get(id);
            if (prior) return { ...prior, label: d.name, absPath: d.path };
            return {
              kind: 'folder' as const,
              id,
              label: d.name,
              count: null,
              absPath: d.path,
              // childrenStatus left undefined — fetched on first chevron expand.
            };
          }),
        };
      }),
    );
  }

  /**
   * Lazy-expand: load the children of a sub-folder node by absolute path.
   * Used by the folder-tree chevron click. No-ops if the node is already
   * loaded or in flight; flips status to `error` on failure with retry.
   */
  expandFsFolder(node: {
    id: string;
    absPath?: string;
    childrenStatus?: 'loading' | 'loaded' | 'error';
  }): void {
    if (!node.absPath) return;
    if (node.childrenStatus === 'loading' || node.childrenStatus === 'loaded') return;

    // Mark in-flight so the chevron shows a spinner instead of refetching.
    this.store.sidebarTree.update((tree) =>
      this.store.patchTree(tree, node.id, (n) => ({ ...n, childrenStatus: 'loading' })),
    );

    this.fsBrowse.listDir(node.absPath).subscribe({
      next: (listing) => this._attachFsChildren(node.id, node.absPath!, listing.dirs),
      error: (err: HttpErrorResponse) => {
        const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
        this.store.sidebarTree.update((tree) =>
          this.store.patchTree(tree, node.id, (n) => ({
            ...n,
            childrenStatus: 'error' as const,
            childrenError: detail,
          })),
        );
      },
    });
  }

  /**
   * Cold-load hydration for `/edit/fs:<absPath>` deep-links on Self-Hosted.
   *
   * Synthesizes a single placeholder Asset entry from the id so the editor
   * can mount immediately and start fetching bytes via `/api/fs/raw`.
   * Caller should follow up with `openSelfHostedSubfolder(parentDir,
   * sourceId, id)` to populate the filmstrip with siblings.
   */
  hydrateSelfHostedFsAsset(id: AssetId, patch?: Partial<Asset>): Asset | null {
    if (this.store.backend !== 'self-hosted') return null;
    if (!id.startsWith('fs:')) return null;
    const absPath = id.slice(3);
    if (!absPath) return null;
    const lastSlash = absPath.lastIndexOf('/');
    if (lastSlash < 0) return null;
    const filename = absPath.slice(lastSlash + 1) || absPath;
    const parentDir = absPath.slice(0, lastSlash) || '/';
    const folderId = `fs:${parentDir}`;

    this.store.assetAbsPaths.set(id, absPath);

    // Strip identity-bearing fields from `patch` so a caller can't spoof
    // them via the merge below.
    const {
      id: _ignoreId,
      absPath: _ignoreAbsPath,
      folderId: _ignoreFolderId,
      ...safePatch
    } = patch ?? {};
    void _ignoreId;
    void _ignoreAbsPath;
    void _ignoreFolderId;

    const baseAsset: Asset = {
      id,
      filename,
      folderId,
      rating: 0,
      flag: 'unflagged',
      colorLabel: null,
      thumbnailGradient: '',
      aspectRatio: 3 / 2,
      absPath,
      ...safePatch,
    };

    this.store.assets.update((list) => {
      const idx = list.findIndex((a) => a.id === id);
      if (idx === -1) return [...list, baseAsset];
      // Already present (e.g. listed via _applyFsListing) — merge in any
      // richer metadata from the patch without clobbering existing fields.
      const existing = list[idx]!;
      const merged: Asset = { ...existing, ...safePatch };
      const next = list.slice();
      next[idx] = merged;
      return next;
    });

    return baseAsset;
  }

  // ── Self-Hosted helpers ────────────────────────────────────────────────────

  private _applyFolderTree(folders: ApiFolder[]): void {
    // Each registered library is a top-level entry in the sidebar tree —
    // no wrapping `Folders` section. The page header ("Library" + ＋) is
    // rendered by the folder-tree component and serves as the only label
    // above the libraries themselves. The chevron on each library drives
    // `expandFsFolder()` to reveal subfolders; row click opens the grid.
    for (const f of folders) {
      const label = f.label || f.path.split('/').filter(Boolean).pop() || f.path;
      this.store.ensureFsFolder(`fs:${f.path}`, label, f.path);
    }
  }

  // ── addImportedAsset (legacy path — drag-drop without FS Access folder) ────

  /**
   * Add a RAW file as a new Asset entry from raw bytes (in-memory import).
   * Bytes are kept in the LRU cache; older entries are evicted when over budget.
   *
   * Pass `explicitId` to reuse an id already persisted on disk; callers that
   * don't care get a fresh UUID.
   */
  addImportedAsset(bytes: Uint8Array, filename: string, explicitId?: AssetId): AssetId {
    const id = explicitId ?? crypto.randomUUID();
    // If an asset with this id already exists (hydration after reload), just
    // refresh the bytes — don't duplicate the sidebar entry or asset record.
    const existing = this.store.findAsset(id);
    if (!existing) {
      const asset: Asset = {
        id,
        filename,
        folderId: 'f-imported',
        rating: 0,
        flag: 'unflagged',
        colorLabel: null,
        thumbnailGradient: '',
        aspectRatio: 3 / 2,
      };
      this.store.assets.update((list) => [...list, asset]);
    }
    // Populate both paths so bytesFor() and bytesForAsset() both work.
    this.cache_.primeBytes(id, bytes);
    this.store.ensureImportedFolder();
    return id;
  }

  // ── Sidecar write helpers ──────────────────────────────────────────────────

  /**
   * Schedule a debounced XMP sidecar write for `id`.
   * Does nothing if there is no writable folder or asset.
   */
  scheduleSidecarWrite(id: AssetId): void {
    const asset = this.store.findAsset(id);
    if (!asset) return;

    const fullModel = this.store.adjustmentModels().get(id) ?? defaultAdjustmentModel();
    const culling: XmpCulling = {
      rating: asset.rating,
      flag: asset.flag,
      colorLabel: asset.colorLabel,
    };

    if (this.store.backend === 'self-hosted') {
      this._scheduleApiXmpWrite(id, fullModel, culling);
      return;
    }

    const folder = this.store.currentFolder();
    if (!folder?.write) return;
    this.xmpStore.scheduleWrite(id, folder, asset.filename, fullModel, culling);
  }

  private _scheduleApiXmpWrite(id: AssetId, model: AdjustmentModel, culling: XmpCulling): void {
    // Gate on a known source path — no path, no XMP target. This replaces the
    // previous `apiAssetIds` gate as part of slice 4 of #193 (path-keyed XMP).
    const absPath = this.store.assetAbsPaths.get(id);
    if (!absPath) return;

    this._apiXmpPending.set(id, { model, culling });

    const existing = this._apiXmpTimers.get(id);
    if (existing) clearTimeout(existing);

    const timeout = setTimeout(() => {
      this._apiXmpTimers.delete(id);
      this._flushApiXmpWrite(id);
    }, this.API_XMP_DEBOUNCE_MS);
    this._apiXmpTimers.set(id, timeout);
  }

  private _flushApiXmpWrite(id: AssetId): void {
    const pending = this._apiXmpPending.get(id);
    const absPath = this.store.assetAbsPaths.get(id);
    if (!pending || !absPath) return;
    this._apiXmpPending.delete(id);

    // Re-use the canonical serializer so Self-Hosted XMP matches Hosted
    // byte-for-byte. Pull the passthrough bucket cached on load so unknown-
    // namespace attributes (Lightroom-specific tags, vendor extensions,
    // custom workflow metadata, etc.) survive a Maple edit cycle — matching
    // the Hosted path's round-trip guarantees.
    const passthrough = this.xmpStore.passthroughFor(id);
    const xml = this.xmpSerializer.serialize(pending.model, passthrough, pending.culling);
    // Route through SidecarStore so the in-memory + IDB caches reflect the
    // optimistic write and roll back coherently on a failed POST. The store's
    // `write()` returns a Promise that rejects on network failure; we log
    // here and let consumers (e.g. an upcoming toast surface) decide what to
    // do with the error.
    void this.sidecarStore.write(absPath, xml).catch((err) => {
      console.error(`putXmp failed for asset ${id} (path=${absPath}):`, err);
    });
  }

  /**
   * Flush all pending sidecar writes immediately (call from beforeunload).
   * Covers both Hosted (FS Access) and Self-Hosted (Bun API) paths.
   */
  async flushPendingXmpWrites(): Promise<void> {
    if (this.store.backend === 'self-hosted') {
      for (const [id, timeout] of this._apiXmpTimers.entries()) {
        clearTimeout(timeout);
        this._flushApiXmpWrite(id);
      }
      this._apiXmpTimers.clear();
      return;
    }
    return this.xmpStore.flushAll();
  }

  // ── Index write debounce ───────────────────────────────────────────────────

  private _scheduleIndexWrite(): void {
    if (this._indexWriteTimer) clearTimeout(this._indexWriteTimer);
    this._indexWriteTimer = setTimeout(() => {
      void this._writeIndex();
    }, 500);
  }

  private async _writeIndex(): Promise<void> {
    const folder = this.store.currentFolder();
    if (!folder?.write || !this.store.folderIndex) return;

    // Rebuild the index from current signal state.
    let index = this.mapleCache.emptyIndex();
    const assets = this.store.assets().filter((a) => a.folderId === `f-${folder.name}`);

    for (const asset of assets) {
      const sha = await sha256Prefix16(asset.filename);
      const existing = this.store.folderIndex.assets.find((a) => a.filename === asset.filename);
      const record: IndexedAsset = {
        filename: asset.filename,
        size: existing?.size ?? 0,
        mtime: existing?.mtime ?? 0,
        sha256Prefix: sha,
        thumbPath: existing?.thumbPath,
        previewPath: existing?.previewPath,
        culling: {
          rating: asset.rating || undefined,
          flag: (asset.flag !== 'unflagged' ? asset.flag : undefined) as
            | 'pick'
            | 'reject'
            | undefined,
          colorLabel: asset.colorLabel ?? undefined,
        },
      };
      index = this.mapleCache.patchAssetInIndex(index, record);
    }

    this.store.folderIndex = index;
    await this.mapleCache.writeIndex(folder, index);
  }

  /**
   * Update the in-memory index entry with the sha + thumb path for an asset.
   * Called after writing a thumbnail.
   */
  async updateIndexThumb(assetId: AssetId, sha: string): Promise<void> {
    if (!this.store.folderIndex) return;
    const asset = this.store.findAsset(assetId);
    if (!asset) return;
    const patch: IndexedAsset = {
      filename: asset.filename,
      size: 0,
      mtime: 0,
      sha256Prefix: sha,
      thumbPath: `./thumbs/${sha}.jpg`,
    };
    this.store.folderIndex = this.mapleCache.patchAssetInIndex(this.store.folderIndex, patch);
  }
}
