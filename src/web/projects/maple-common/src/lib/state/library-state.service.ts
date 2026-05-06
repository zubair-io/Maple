// Signal-based library store — shared by both Browse and Editor apps.
// P5: Lazy on-demand byte reads via FolderAccessService.
//     Replaced fileBytes Map with LruCache + FolderEntry handles.
//     .maple/ index writes debounced 500ms after culling changes.

import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Asset, AssetId, Flag, ColorLabel } from '../models/asset';
import { SidebarEntry, GridFolderItem } from '../models/folder';
import {
  AdjustmentModel,
  defaultAdjustmentModel,
  isDefaultAdjustment,
} from '../models/adjustment-model';
import { LIBRARY_BACKEND } from '../api/library-backend.token';
import { BunApiBackendService, ApiAsset, ApiFolder } from '../api/bun-api-backend.service';
import {
  FilesystemBrowseService,
  FsDirListing,
  FsImageEntry,
  FsImageExif,
} from '../api/filesystem-browse.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { imageDataToBitmap, resizeBitmapToCanvas, canvasToBlob } from '../raw-pipeline/image-utils';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpSerializerService } from '../xmp/xmp-serializer.service';
import { XmpCulling } from '../xmp/xmp.types';
import { MapleFolderHandle, FolderEntry } from '../folder-access/folder-access.types';
import { MapleIndex, IndexedAsset } from '../maple-cache/maple-cache.types';
import { sha256Prefix16 } from '../maple-cache/sha';
import { mergePreservingRefs, shallowEqualByKeys } from './merge-by-id';

const ASSET_RENDER_KEYS: readonly (keyof Asset)[] = [
  'id', 'folderId', 'filename', 'absPath',
  'rating', 'flag', 'colorLabel', 'edited',
  'aspectRatio', 'thumbnailGradient',
  'size', 'mtime',
  'width', 'height',
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

// ── LRU cache ─────────────────────────────────────────────────────────────────

/**
 * Simple LRU cache keyed by AssetId, evicting by total byte count.
 * Uses Map insertion order as a recency queue (delete-and-reinsert on access).
 */
class LruCache {
  private entries = new Map<AssetId, Uint8Array>();
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(id: AssetId): Uint8Array | undefined {
    const v = this.entries.get(id);
    if (v) {
      // Refresh recency by reinserting at the end.
      this.entries.delete(id);
      this.entries.set(id, v);
    }
    return v;
  }

  set(id: AssetId, bytes: Uint8Array): void {
    if (this.entries.has(id)) {
      this.totalBytes -= this.entries.get(id)!.byteLength;
      this.entries.delete(id);
    }
    this.entries.set(id, bytes);
    this.totalBytes += bytes.byteLength;
    this._evict();
  }

  delete(id: AssetId): void {
    const v = this.entries.get(id);
    if (v) {
      this.totalBytes -= v.byteLength;
      this.entries.delete(id);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private _evict(): void {
    while (this.totalBytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as AssetId;
      const removed = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.totalBytes -= removed.byteLength;
    }
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class LibraryStateService {
  private fs = inject(FolderAccessService);
  private cache = inject(MapleCacheService);
  private pipeline = inject(RawPipelineService);
  private xmpParser = inject(XmpParserService);
  private xmpStore = inject(XmpStoreService);
  private xmpSerializer = inject(XmpSerializerService);
  private api = inject(BunApiBackendService);
  private fsBrowse = inject(FilesystemBrowseService);

  /** Which backend is in use. Consumers read this to branch data-source paths. */
  readonly backend = inject(LIBRARY_BACKEND);

  // ── Self-Hosted bootstrap state ────────────────────────────────────────────
  /** True while listFolders / listAssets is in flight (Self-Hosted only). */
  readonly backendLoading = signal<boolean>(false);
  /** Last backend error message, cleared on successful load. */
  readonly backendError = signal<string | null>(null);
  /** True when the API returned zero folders (index not configured yet). */
  readonly backendEmpty = signal<boolean>(false);

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
   * Needed because the grid works on local UUIDs but the API talks in its own ids.
   */
  private _apiAssetIds = new Map<AssetId, string>();

  /**
   * Map from AssetId to the absolute filesystem path (Self-Hosted FS-walk
   * path). Lets callers translate a grid-side id back to the on-disk path
   * for thumb loads, byte reads, etc.
   */
  private _assetAbsPaths = new Map<AssetId, string>();

  // ── Library data ───────────────────────────────────────────────────────────
  readonly assets = signal<Asset[]>([]);
  readonly gridFolders = signal<GridFolderItem[]>([]);
  readonly sidebarTree = signal<SidebarEntry[]>([]);

  // ── Current folder handle ─────────────────────────────────────────────────
  /** The folder the user most recently opened via openFolder(). */
  readonly currentFolder = signal<MapleFolderHandle | null>(null);

  // ── Sidebar open/collapsed state ───────────────────────────────────────────
  readonly sectionOpen = signal<Record<string, boolean>>(
    this._loadOrDefault('cm.sections', { folders: true, photos: true }),
  );

  readonly folderOpen = signal<Record<string, boolean>>(
    this._loadOrDefault('cm.folderOpen', { 'f-2026': true }),
  );

  // ── Selection ──────────────────────────────────────────────────────────────
  readonly selectedSourceId = signal<string>('');
  readonly selectedAssetIds = signal<Set<AssetId>>(new Set());
  readonly focusedAssetId = signal<AssetId | null>(null);

  /**
   * Label of the currently selected sidebar entry (recursive lookup), or empty
   * when nothing is selected. Used by the BrowseShell title bar.
   */
  readonly selectedSourceLabel = computed<string>(() => {
    const id = this.selectedSourceId();
    if (!id) return '';
    const walk = (entries: SidebarEntry[]): string => {
      for (const e of entries) {
        if (e.id === id) return e.label;
        if (e.children) {
          const hit = walk(e.children);
          if (hit) return hit;
        }
      }
      return '';
    };
    return walk(this.sidebarTree());
  });

  // ── Thumbnail size (grid density) ─────────────────────────────────────────
  readonly thumbSize = signal<number>(this._loadOrDefault('cm.thumbSize', 140) as number);

  // ── Sort + filter ─────────────────────────────────────────────────────────
  readonly sort = signal<'date' | 'name'>(
    this._loadOrDefault('cm.sort', 'date') as 'date' | 'name',
  );
  readonly filter = signal<'all' | 'picks' | '4stars'>(
    this._loadOrDefault('cm.filter', 'all') as 'all' | 'picks' | '4stars',
  );

  // ── In-grid search query (filename substring filter) ──────────────────────
  // Driven by the toolbar search input in `BrowseShell`. Empty string = no
  // filter; the asset grid binds to `assetsInSelectedFolder()` which already
  // applies this when set. Structured search lives on the `/search` route.
  readonly searchQuery = signal<string>('');

  // ── Panel visibility (persisted) ──────────────────────────────────────────
  readonly sidebarVisible = signal<boolean>(this._loadOrDefault('cm.leftHidden', false) === false);
  readonly inspectorVisible = signal<boolean>(
    this._loadOrDefault('cm.detailHidden', false) === false,
  );

  // ── Active detail tab ─────────────────────────────────────────────────────
  readonly activeTab = signal<'info' | 'develop'>(
    this._loadOrDefault('cm.tab', 'info') as 'info' | 'develop',
  );

  // ── Thumbnail URL cache (blob URLs — revoked when assets are removed) ──────
  readonly thumbnailUrls = signal<Map<AssetId, string>>(new Map());

  // ── Adjustment models (per-asset develop settings) ────────────────────────
  readonly adjustmentModels = signal<Map<AssetId, AdjustmentModel>>(new Map());

  // ── Lazy byte reads ───────────────────────────────────────────────────────

  /**
   * LRU cache: at most 1 GB of RAW bytes resident in memory.
   * This is configurable but 1 GB is a safe default for the browse view.
   */
  private _byteCache = new LruCache(1024 * 1024 * 1024);

  /**
   * Map from AssetId to the FolderEntry (file handle) for on-demand reads.
   * Populated by openFolder(); also populated for imported files via addImportedAsset().
   */
  private _fileHandles = new Map<AssetId, FolderEntry>();

  /**
   * For legacy in-memory imports (drag-drop, <input> picker without FS Access),
   * bytes are stored here and don't go through the file handle path.
   * These are still bounded by LRU; we just pre-populate the cache entry.
   */
  private _legacyBytes = new Map<AssetId, Uint8Array>();

  // ── In-flight byte reads (deduplication) ──────────────────────────────────
  private _byteReads = new Map<AssetId, Promise<Uint8Array>>();

  // ── Index write debounce ──────────────────────────────────────────────────
  private _indexWriteTimer: ReturnType<typeof setTimeout> | null = null;
  /** The in-memory index we build/maintain for the current folder. */
  private _folderIndex: MapleIndex | null = null;

  constructor() {
    // Debounced index write: re-fires 500ms after the last culling change.
    effect(() => {
      const assets = this.assets();
      const folder = this.currentFolder();
      // Access assets to ensure signal dependency is tracked.
      void assets;
      if (!folder?.write) return;
      this._scheduleIndexWrite();
    });
  }

  // ── Lazy byte access ───────────────────────────────────────────────────────

  /**
   * Lazily read the raw bytes for an asset.
   * On first call: reads from the file handle (or legacy in-memory store).
   * Subsequent calls: returns the LRU-cached bytes instantly.
   * Concurrent calls for the same id share a single in-flight read.
   */
  async bytesForAsset(id: AssetId): Promise<Uint8Array> {
    // 1. LRU cache hit.
    const cached = this._byteCache.get(id);
    if (cached) return cached;

    // 2. Deduplicate concurrent requests for the same id.
    const inflight = this._byteReads.get(id);
    if (inflight) return inflight;

    const read = this._doReadBytes(id);
    this._byteReads.set(id, read);
    try {
      const bytes = await read;
      this._byteCache.set(id, bytes);
      return bytes;
    } finally {
      this._byteReads.delete(id);
    }
  }

  private async _doReadBytes(id: AssetId): Promise<Uint8Array> {
    // Legacy in-memory path (drag-drop imports without FS Access).
    const legacy = this._legacyBytes.get(id);
    if (legacy) return legacy;

    // Self-Hosted FS-walk path: asset id is `fs:<absPath>` and the bytes
    // come from `/api/fs/raw?path=<abs>`. Checked BEFORE the Mongo-asset
    // path because FS-walk assets aren't in `_apiAssetIds`.
    const fsAbsPath = this._assetAbsPaths.get(id);
    if (fsAbsPath) {
      const buf = await this.fsBrowse.getRawBytes(fsAbsPath);
      return new Uint8Array(buf);
    }

    // Self-Hosted: fetch bytes from the Bun API by Mongo asset id.
    if (this.backend === 'self-hosted') {
      const apiId = this._apiAssetIds.get(id);
      if (!apiId) throw new Error(`bytesForAsset: no api id for asset ${id}`);
      // firstValueFrom: imperative-boundary escape hatch. The LRU cache contract
      // is `Promise<Uint8Array>`; callers `await bytesForAsset(...)`. Keeping the
      // observable flow here would force every caller to resubscribe.
      const buf = await firstValueFrom(this.api.getRawBytes(apiId));
      return new Uint8Array(buf);
    }

    // FS Access / fallback handle path.
    const entry = this._fileHandles.get(id);
    if (!entry) throw new Error(`bytesForAsset: no handle for asset ${id}`);
    const file = await entry.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  /**
   * Compatibility shim — returns bytes synchronously from in-memory store only.
   * Used by legacy code paths that haven't been converted to the async API yet.
   * Returns undefined for assets that require a disk read.
   */
  bytesFor(id: AssetId): Uint8Array | undefined {
    return this._byteCache.get(id) ?? this._legacyBytes.get(id);
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
    this.currentFolder.set(folder);
    this._byteCache.clear();
    this._fileHandles.clear();
    this._legacyBytes.clear();
    this.thumbnailUrls.set(new Map()); // clear stale thumb URLs

    // 1. Load .maple/index.json for cached culling state.
    const index = await this.cache.readIndex(folder);
    this._folderIndex = index ?? this.cache.emptyIndex();

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
      this._fileHandles.set(id, entry);

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

    this.assets.update((list) => {
      // Remove previous assets for the same folder; keep other folders.
      const others = list.filter((a) => a.folderId !== folderId);
      const previous = list.filter((a) => a.folderId === folderId);
      const merged = mergePreservingRefs(previous, newAssets, assetsEqualForRender);
      return [...others, ...merged];
    });

    // Merge loaded adjustments into the signal (only overwrite for this folder).
    if (newAdjustments.size > 0) {
      this.adjustmentModels.update((map) => {
        const next = new Map(map);
        for (const [id, adj] of newAdjustments) {
          next.set(id, adj);
        }
        return next;
      });
    }

    // 3. Ensure the folder appears in the sidebar tree.
    this._ensureFolder(folderId, folder.name);
    this.selectedSourceId.set(folderId);
  }

  // ── Self-Hosted bootstrap (Bun API) ────────────────────────────────────────

  /**
   * Self-Hosted entry point: list folders from the API, populate the sidebar,
   * and auto-open the first folder.
   *
   * Hosted variant should not call this — it uses `openFolder(handle)` via the
   * File System Access picker on the landing page.
   */
  loadFolderTree(): void {
    if (this.backend !== 'self-hosted') return;

    this.backendLoading.set(true);
    this.backendError.set(null);
    this.backendEmpty.set(false);

    this.api.listFolders().subscribe({
      next: (folders) => {
        this._applyFolderTree(folders);
        if (folders.length === 0) {
          this.backendEmpty.set(true);
        }
        this.backendLoading.set(false);
        // Don't auto-open the first folder — that fires /api/folders/{id}/assets
        // before the user has expressed intent and before the indexer may have
        // scanned anything. The user picks a folder from the tree.
      },
      error: (err: HttpErrorResponse) => {
        this.backendLoading.set(false);
        this.backendError.set(
          err.status >= 500
            ? `Server error (${err.status}). The Maple API may be down.`
            : `Failed to load folders: ${err.message}`,
        );
      },
    });
  }

  /**
   * Self-Hosted: register a new library folder, then refresh the tree.
   * Called by LibraryPickerComponent on the empty-state of BrowseShell.
   */
  addLibraryFolder(absPath: string): void {
    if (this.backend !== 'self-hosted') return;

    this.backendLoading.set(true);
    this.backendError.set(null);

    this.api.registerFolder(absPath).subscribe({
      next: () => {
        this.closeLibraryPicker();
        this.loadFolderTree();
      },
      error: (err: HttpErrorResponse) => {
        this.backendLoading.set(false);
        const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
        this.backendError.set(`Failed to register folder: ${detail}`);
      },
    });
  }

  /**
   * Self-Hosted: open a registered library by walking its filesystem.
   *
   * Replaces the old DB-asset path (`/api/folders/{id}/assets`) with one that
   * calls `/api/fs/dir?path=<abs>` against the library's root absolute path.
   * Sub-dirs land in the sidebar tree as lazy-expandable children; RAW images
   * land in the grid as Asset records keyed on their on-disk path.
   */
  openSelfHostedFolder(folder: ApiFolder): void {
    if (this.backend !== 'self-hosted') return;

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
   * `fs:<absPath>` (matching `_ensureFsFolder`); for a sub-folder we use the
   * id assigned by `_attachFsChildren`.
   */
  openSelfHostedSubfolder(
    absPath: string,
    sourceId?: string,
    selectAssetId?: AssetId,
  ): void {
    if (this.backend !== 'self-hosted') return;

    const id = sourceId ?? this._sourceIdForFsPath(absPath) ?? `fs:${absPath}`;
    // Set the selection synchronously so the file-list breadcrumb + grid
    // empty-state reflect the click immediately, before the HTTP response.
    this.selectedSourceId.set(id);
    this.backendLoading.set(true);
    this.backendError.set(null);
    this.backendEmpty.set(false);

    this.fsBrowse.listDir(absPath).subscribe({
      next: (listing) => {
        this._applyFsListing(id, absPath, listing);
        // If a caller passed `selectAssetId` (e.g. EditorShell cold-loading
        // a deep-linked asset), honour it. Otherwise select the first image
        // so the detail panel has something to render.
        if (selectAssetId) {
          const target = this.assets().find((a) => a.id === selectAssetId);
          if (target) this.selectAsset(target.id);
        } else {
          const firstAsset = this.assets().find((a) => a.folderId === id);
          if (firstAsset) this.selectAsset(firstAsset.id);
        }
        this.backendLoading.set(false);
        if (listing.dirs.length === 0 && listing.images.length === 0) {
          // Empty folder — clear any leftover error banner; the grid will
          // show its own "Folder is empty" state.
          this.backendEmpty.set(false);
        }
      },
      error: (err: HttpErrorResponse) => {
        this.backendLoading.set(false);
        const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
        this.backendError.set(
          err.status >= 500
            ? `Server error (${err.status}) loading folder.`
            : `Failed to load folder: ${detail}`,
        );
      },
    });
  }

  /** Look up the SidebarEntry id whose absPath equals `absPath`. */
  private _sourceIdForFsPath(absPath: string): string | null {
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
   * Apply a `/api/fs/dir` listing to state:
   *  - Drop the current `_assetAbsPaths` entries for the source.
   *  - Build new `Asset` records from `listing.images` and key them on path.
   *  - Replace the source's assets in the grid.
   *  - Build new `GridFolderItem` records from `listing.dirs` and replace the
   *    source's folder tiles in the grid.
   *  - Push `listing.dirs` into the sidebar tree as children of the matching
   *    node so the lazy-expand chevron has something to reveal.
   */
  private _applyFsListing(sourceId: string, absPath: string, listing: FsDirListing): void {
    // Forget previous assets for this source (path-based ids may collide
    // across re-opens after a rename — purge by folderId).
    const stale = this.assets()
      .filter((a) => a.folderId === sourceId)
      .map((a) => a.id);
    for (const id of stale) this._assetAbsPaths.delete(id);

    const newAssets: Asset[] = listing.images.map((img: FsImageEntry) => {
      const id: AssetId = `fs:${img.path}`;
      this._assetAbsPaths.set(id, img.path);
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

    this.assets.update((list) => {
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

    this.gridFolders.update((list) => {
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
   */
  private _attachFsChildren(
    sourceId: string,
    _absPath: string,
    dirs: { name: string; path: string; mtime: string }[],
  ): void {
    this.sidebarTree.update((tree) => this._patchTree(tree, sourceId, (n) => ({
      ...n,
      childrenStatus: 'loaded' as const,
      childrenError: undefined,
      children: dirs.map((d) => ({
        kind: 'folder' as const,
        id: `fs:${d.path}`,
        label: d.name,
        count: null,
        absPath: d.path,
        // childrenStatus left undefined — fetched on first chevron expand.
      })),
    })));
  }

  /**
   * Walk the sidebar tree, applying `patcher` to the entry whose id matches
   * `targetId`. Returns a new tree (immutable update so the signal fires).
   */
  private _patchTree(
    tree: SidebarEntry[],
    targetId: string,
    patcher: (entry: SidebarEntry) => SidebarEntry,
  ): SidebarEntry[] {
    return tree.map((entry) => {
      if (entry.id === targetId) return patcher(entry);
      if (entry.children) {
        const patched = this._patchTree(entry.children, targetId, patcher);
        if (patched !== entry.children) {
          return { ...entry, children: patched };
        }
      }
      return entry;
    });
  }

  /**
   * Lazy-expand: load the children of a sub-folder node by absolute path.
   * Used by the folder-tree chevron click. No-ops if the node is already
   * loaded or in flight; flips status to `error` on failure with retry.
   */
  expandFsFolder(node: SidebarEntry): void {
    if (!node.absPath) return;
    if (node.childrenStatus === 'loading' || node.childrenStatus === 'loaded') return;

    // Mark in-flight so the chevron shows a spinner instead of refetching.
    this.sidebarTree.update((tree) =>
      this._patchTree(tree, node.id, (n) => ({ ...n, childrenStatus: 'loading' })),
    );

    this.fsBrowse.listDir(node.absPath).subscribe({
      next: (listing) => this._attachFsChildren(node.id, node.absPath!, listing.dirs),
      error: (err: HttpErrorResponse) => {
        const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
        this.sidebarTree.update((tree) =>
          this._patchTree(tree, node.id, (n) => ({
            ...n,
            childrenStatus: 'error' as const,
            childrenError: detail,
          })),
        );
      },
    });
  }

  /** Returns the on-disk path for a Self-Hosted FS-walk asset, if any. */
  absPathFor(assetId: AssetId): string | undefined {
    return this._assetAbsPaths.get(assetId);
  }

  /**
   * Cold-load hydration for `/edit/fs:<absPath>` deep-links on Self-Hosted.
   *
   * Synthesizes a single placeholder Asset entry from the id so the editor
   * can mount immediately and start fetching bytes via `/api/fs/raw`
   * (resolved through `_assetAbsPaths`). The caller should follow up with
   * `openSelfHostedSubfolder(parentDir, sourceId, id)` to populate the
   * filmstrip with siblings and switch the source selection — the
   * `selectAssetId` parameter on that method preserves our deep-linked
   * choice instead of auto-selecting the first asset in the listing.
   *
   * Returns the synthesized asset, or null if `id` doesn't parse or the
   * backend isn't self-hosted (cold-load on Hosted falls back to
   * `getPersistedFile` via the FS Access API cache).
   */
  hydrateSelfHostedFsAsset(id: AssetId): Asset | null {
    if (this.backend !== 'self-hosted') return null;
    if (!id.startsWith('fs:')) return null;
    const absPath = id.slice(3);
    if (!absPath) return null;
    const lastSlash = absPath.lastIndexOf('/');
    if (lastSlash < 0) return null;
    const filename = absPath.slice(lastSlash + 1) || absPath;
    const parentDir = absPath.slice(0, lastSlash) || '/';
    const folderId = `fs:${parentDir}`;

    this._assetAbsPaths.set(id, absPath);

    const asset: Asset = {
      id,
      filename,
      folderId,
      rating: 0,
      flag: 'unflagged',
      colorLabel: null,
      thumbnailGradient: '',
      aspectRatio: 3 / 2,
      absPath,
    };

    this.assets.update((list) => {
      if (list.some((a) => a.id === id)) return list;
      return [...list, asset];
    });

    return asset;
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
      this._ensureFsFolder(`fs:${f.path}`, label, f.path);
    }
  }

  private _ensureFsFolder(id: string, label: string, absPath: string): void {
    this.sidebarTree.update((tree) => {
      // Prune any stale "folders" section from older sessions / cache. New
      // top-level entries replace it; the section becomes inert otherwise.
      const pruned = tree.filter(
        (node) => !(node.kind === 'section' && node.id === 'folders'),
      );
      if (pruned.some((c) => c.id === id)) return pruned;
      return [
        ...pruned,
        {
          kind: 'folder' as const,
          id,
          label,
          count: null,
          absPath,
          // Children fetched lazily on chevron expand.
        },
      ];
    });
  }

  private _applyApiAssets(folderId: string, apiAssets: ApiAsset[]): void {
    const newAssets: Asset[] = [];
    // Keep existing id mappings for other folders; just overwrite this folder's.
    for (const localId of Array.from(this._apiAssetIds.keys())) {
      const existingAsset = this.assets().find((a) => a.id === localId);
      if (existingAsset?.folderId === folderId) this._apiAssetIds.delete(localId);
    }

    for (const a of apiAssets) {
      const localId = crypto.randomUUID();
      this._apiAssetIds.set(localId, a.id);
      newAssets.push({
        id: localId,
        filename: a.filename,
        folderId,
        rating: a.rating ?? 0,
        flag: (a.flag ?? 'unflagged') as Flag,
        colorLabel: (a.colorLabel ?? null) as ColorLabel,
        thumbnailGradient: '',
        aspectRatio: a.width && a.height ? a.width / a.height : 3 / 2,
        width: a.width,
        height: a.height,
      });

      // Best-effort XMP load — populates AdjustmentModel if a sidecar exists.
      this._loadApiXmp(localId, a.id);
    }

    this.assets.update((list) => {
      const others = list.filter((x) => x.folderId !== folderId);
      const previous = list.filter((x) => x.folderId === folderId);
      const merged = mergePreservingRefs(previous, newAssets, assetsEqualForRender);
      return [...others, ...merged];
    });
  }

  private _loadApiXmp(localId: AssetId, apiId: string): void {
    this.api.getXmp(apiId).subscribe({
      next: (xml) => {
        if (!xml) return;
        try {
          const { model, passthrough } = this.xmpParser.parseAdjustmentModel(xml);
          const fullModel: AdjustmentModel = { ...defaultAdjustmentModel(), ...model };
          this.adjustmentModels.update((map) => {
            const next = new Map(map);
            next.set(localId, fullModel);
            return next;
          });
          // Mirror the Hosted path: stash the passthrough bucket so the next
          // putXmp() preserves unknown-namespace attributes / nested nodes
          // verbatim. Re-uses XmpStoreService's per-asset map rather than
          // inventing a parallel structure.
          this.xmpStore.rememberPassthrough(localId, passthrough);
        } catch {
          /* ignore malformed sidecars — server has already stored them */
        }
      },
      error: () => {
        // 404 is expected when no sidecar exists; anything else is best-effort.
      },
    });
  }

  private _localIdForApiAsset(apiId: string): AssetId | null {
    for (const [local, api] of this._apiAssetIds.entries()) {
      if (api === apiId) return local;
    }
    return null;
  }

  /** Returns the API id for a local asset id (Self-Hosted only). */
  apiIdFor(assetId: AssetId): string | undefined {
    return this._apiAssetIds.get(assetId);
  }

  // ── addImportedAsset (legacy path — drag-drop without FS Access folder) ────

  /**
   * Add a RAW file as a new Asset entry from raw bytes (in-memory import).
   * Bytes are kept in the LRU cache; older entries are evicted when over budget.
   *
   * Pass `explicitId` to reuse an id already persisted on disk (e.g. the id
   * embedded in an `/edit/:id` URL); callers that don't care get a fresh UUID.
   */
  addImportedAsset(bytes: Uint8Array, filename: string, explicitId?: AssetId): AssetId {
    const id = explicitId ?? crypto.randomUUID();
    // If an asset with this id already exists (hydration after reload), just
    // refresh the bytes — don't duplicate the sidebar entry or asset record.
    const existing = this.assets().find((a) => a.id === id);
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
      this.assets.update((list) => [...list, asset]);
    }
    // Populate both paths so bytesFor() and bytesForAsset() both work.
    this._legacyBytes.set(id, bytes);
    this._byteCache.set(id, bytes);
    this._ensureImportedFolder();
    return id;
  }

  // ── Asset mutations ────────────────────────────────────────────────────────

  updateAssetDimensions(id: AssetId, width: number, height: number): void {
    this.assets.update((list) =>
      list.map((a) => (a.id === id ? { ...a, width, height, aspectRatio: width / height } : a)),
    );
  }

  /**
   * Seed Temperature + Tint from the RAW's AsShot metadata so the editor's
   * WB sliders reflect the camera's own white-balance reading on first open.
   * No-op if the user has already edited those fields (i.e. temperature is
   * no longer the struct's 6500K default or tint is non-zero) — we don't
   * want to clobber deliberate adjustments when a re-decode triggers this.
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

  cacheThumbnailUrl(id: AssetId, url: string): void {
    this.thumbnailUrls.update((map) => {
      const next = new Map(map);
      next.set(id, url);
      return next;
    });
  }

  thumbnailUrlFor(id: AssetId): string | undefined {
    return this.thumbnailUrls().get(id);
  }

  /** In-flight thumbnail loads (id → Promise) so concurrent callers from
   * the grid + filmstrip share a single network request per asset. */
  private _thumbLoadingIds = new Set<AssetId>();

  /** Idempotently load the blob-URL thumbnail for one asset. Both
   * `<asset-grid>` and `<editor-filmstrip>` call this on every visible row;
   * it short-circuits when the URL is already cached or in flight, so
   * callers can fire it on every change-detection pass without paying for
   * extra network round-trips.
   *
   * Single source of truth for all thumbnail acquisition paths:
   *   - **Self-Hosted FS-walk** (`asset.absPath`) → `/api/fs/thumb` via
   *     `FilesystemBrowseService.getThumbBlobUrl`. Server-rendered, fast.
   *   - **Self-Hosted Mongo asset** (`_apiAssetIds` map populated for legacy
   *     callers that came in via `/api/folders/{id}/assets`) → `api.getThumb`.
   *   - **Hosted with FS Access folder** → read `.maple/thumbs/<sha>.jpg`
   *     from disk. Falls back to client-side WASM decode + write-through.
   *
   * Errors are swallowed and logged — the gradient placeholder stays
   * visible. The entry stays out of `thumbnailUrls`, so a future trigger
   * can retry. */
  ensureThumbnailUrl(asset: Asset): void {
    if (!asset) return;
    if (this.thumbnailUrls().has(asset.id)) return;
    if (this._thumbLoadingIds.has(asset.id)) return;
    this._thumbLoadingIds.add(asset.id);
    void this._loadThumbInternal(asset).finally(() =>
      this._thumbLoadingIds.delete(asset.id),
    );
  }

  private async _loadThumbInternal(asset: Asset): Promise<void> {
    try {
      // 1. Self-Hosted FS-walk: server renders + caches the JPEG.
      if (this.backend === 'self-hosted' && asset.absPath) {
        const url = await this.fsBrowse.getThumbBlobUrl(asset.absPath, 512);
        this.cacheThumbnailUrl(asset.id, url);
        return;
      }

      // 2. Self-Hosted Mongo asset (older grid mounts that resolved an apiId).
      if (this.backend === 'self-hosted') {
        const apiId = this._apiAssetIds.get(asset.id);
        if (!apiId) return;
        const blob = await firstValueFrom(this.api.getThumb(apiId));
        this.cacheThumbnailUrl(asset.id, URL.createObjectURL(blob));
        return;
      }

      // 3. Hosted: try the .maple/thumbs/ on-disk cache first.
      const folder = this.currentFolder();
      if (folder) {
        const sha = await sha256Prefix16(asset.filename);
        const cached = await this.cache.readThumb(folder, sha);
        if (cached) {
          this.cacheThumbnailUrl(asset.id, URL.createObjectURL(cached));
          return;
        }
      }

      // 4. Hosted decode fallback: pull bytes, run them through the WASM
      //    pipeline, encode to JPEG, store, and write through to the
      //    .maple/ cache so future sessions hit branch 3 instead.
      let bytes: Uint8Array;
      try {
        bytes = await this.bytesForAsset(asset.id);
      } catch {
        return; // mock asset / no source — gradient stays.
      }
      const ext = asset.filename.split('.').pop()?.toLowerCase() ?? '';
      const decoded = await this.pipeline.decode(bytes, ext);
      this.updateAssetDimensions(asset.id, decoded.width, decoded.height);
      const bitmap = await imageDataToBitmap(decoded);
      const canvas = await resizeBitmapToCanvas(bitmap, 512);
      bitmap.close();
      const blob = await canvasToBlob(canvas);
      this.cacheThumbnailUrl(asset.id, URL.createObjectURL(blob));
      if (folder?.write) {
        const sha = await sha256Prefix16(asset.filename);
        void this.cache
          .writeThumb(folder, sha, blob)
          .then(() => this.updateIndexThumb(asset.id, sha));
      }
    } catch (err) {
      console.warn('[state] thumb load failed for', asset.filename, err);
    }
  }

  // ── Adjustment models ──────────────────────────────────────────────────────

  adjustmentFor(id: AssetId) {
    return computed(() => this.adjustmentModels().get(id) ?? defaultAdjustmentModel());
  }

  updateAdjustment(id: AssetId, patch: Partial<AdjustmentModel>): void {
    this.adjustmentModels.update((map) => {
      const next = new Map(map);
      const current = next.get(id) ?? defaultAdjustmentModel();
      next.set(id, { ...current, ...patch });
      return next;
    });

    // Schedule debounced sidecar write.
    this._scheduleSidecarWrite(id);
  }

  isEdited(id: AssetId) {
    return computed(() => {
      const m = this.adjustmentModels().get(id);
      return !!m && !isDefaultAdjustment(m);
    });
  }

  // ── Derived signals ────────────────────────────────────────────────────────

  readonly assetsInSelectedFolder = computed(() => {
    const sid = this.selectedSourceId();
    let list = this.assets().filter((a) => a.folderId === sid);

    const f = this.filter();
    if (f === 'picks') list = list.filter((a) => a.flag === 'pick');
    if (f === '4stars') list = list.filter((a) => a.rating >= 4);

    // Filename substring filter from the toolbar search input.
    // Pragmatic scope: filename only — structured search lives on /search.
    const q = this.searchQuery().trim().toLowerCase();
    if (q.length > 0) {
      list = list.filter((a) => a.filename.toLowerCase().includes(q));
    }

    if (this.sort() === 'name') {
      list = [...list].sort((a, b) => a.filename.localeCompare(b.filename));
    }

    return list;
  });

  readonly foldersInSelectedFolder = computed(() => {
    const sid = this.selectedSourceId();
    let list = this.gridFolders().filter((f) => f.parentSourceId === sid);

    // Folder navigation ignores rating/flag filters (those are image-only
    // concepts) but honours the toolbar search filter on folder name so the
    // search input filters both kinds consistently.
    const q = this.searchQuery().trim().toLowerCase();
    if (q.length > 0) {
      list = list.filter((f) => f.name.toLowerCase().includes(q));
    }

    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly focusedAsset = computed(() => {
    const fid = this.focusedAssetId();
    if (!fid) return null;
    return this.assets().find((a) => a.id === fid) ?? null;
  });

  readonly selectedCount = computed(() => this.selectedAssetIds().size);

  // ── Culling mutations (+ trigger debounced index write) ────────────────────

  setRating(id: AssetId, rating: number): void {
    this.assets.update((list) => list.map((a) => (a.id === id ? { ...a, rating } : a)));
    this._scheduleSidecarWrite(id);
  }

  setFlag(id: AssetId, flag: Flag): void {
    this.assets.update((list) => list.map((a) => (a.id === id ? { ...a, flag } : a)));
    this._scheduleSidecarWrite(id);
  }

  setColorLabel(id: AssetId, colorLabel: ColorLabel): void {
    this.assets.update((list) => list.map((a) => (a.id === id ? { ...a, colorLabel } : a)));
    this._scheduleSidecarWrite(id);
  }

  // ── Sidecar write helpers ──────────────────────────────────────────────────

  /**
   * Schedule a debounced XMP sidecar write for `id`.
   * Does nothing if there is no writable folder or asset.
   */
  private _scheduleSidecarWrite(id: AssetId): void {
    const asset = this.assets().find((a) => a.id === id);
    if (!asset) return;

    const fullModel = this.adjustmentModels().get(id) ?? defaultAdjustmentModel();
    const culling: XmpCulling = {
      rating: asset.rating,
      flag: asset.flag,
      colorLabel: asset.colorLabel,
    };

    if (this.backend === 'self-hosted') {
      this._scheduleApiXmpWrite(id, fullModel, culling);
      return;
    }

    const folder = this.currentFolder();
    if (!folder?.write) return;
    this.xmpStore.scheduleWrite(id, folder, asset.filename, fullModel, culling);
  }

  // ── Self-Hosted XMP write debounce ────────────────────────────────────────

  private readonly API_XMP_DEBOUNCE_MS = 750;
  private _apiXmpTimers = new Map<AssetId, ReturnType<typeof setTimeout>>();
  private _apiXmpPending = new Map<AssetId, { model: AdjustmentModel; culling: XmpCulling }>();

  private _scheduleApiXmpWrite(id: AssetId, model: AdjustmentModel, culling: XmpCulling): void {
    const apiId = this._apiAssetIds.get(id);
    if (!apiId) return;

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
    const apiId = this._apiAssetIds.get(id);
    if (!pending || !apiId) return;
    this._apiXmpPending.delete(id);

    // Re-use the canonical serializer so Self-Hosted XMP matches Hosted byte-for-byte.
    // Pull the passthrough bucket cached on load (`_loadApiXmp`) so unknown-
    // namespace attributes (Lightroom-specific tags, vendor extensions, custom
    // workflow metadata, etc.) survive a Maple edit cycle — matching the
    // Hosted path's round-trip guarantees.
    const passthrough = this.xmpStore.passthroughFor(id);
    const xml = this.xmpSerializer.serialize(pending.model, passthrough, pending.culling);
    this.api.putXmp(apiId, xml).subscribe({
      error: (err) => console.error(`putXmp failed for asset ${id}:`, err),
    });
  }

  /**
   * Flush all pending sidecar writes immediately (call from beforeunload).
   * Covers both Hosted (FS Access) and Self-Hosted (Bun API) paths.
   */
  async flushPendingXmpWrites(): Promise<void> {
    if (this.backend === 'self-hosted') {
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
    const folder = this.currentFolder();
    if (!folder?.write || !this._folderIndex) return;

    // Rebuild the index from current signal state.
    let index = this.cache.emptyIndex();
    const assets = this.assets().filter((a) => a.folderId === `f-${folder.name}`);

    for (const asset of assets) {
      const sha = await sha256Prefix16(asset.filename);
      const existing = this._folderIndex.assets.find((a) => a.filename === asset.filename);
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
      index = this.cache.patchAssetInIndex(index, record);
    }

    this._folderIndex = index;
    await this.cache.writeIndex(folder, index);
  }

  /**
   * Update the in-memory index entry with the sha + thumb path for an asset.
   * Called by AssetGridComponent after writing a thumbnail.
   */
  async updateIndexThumb(assetId: AssetId, sha: string): Promise<void> {
    if (!this._folderIndex) return;
    const asset = this.assets().find((a) => a.id === assetId);
    if (!asset) return;
    const patch: IndexedAsset = {
      filename: asset.filename,
      size: 0,
      mtime: 0,
      sha256Prefix: sha,
      thumbPath: `./thumbs/${sha}.jpg`,
    };
    this._folderIndex = this.cache.patchAssetInIndex(this._folderIndex, patch);
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  selectAsset(id: AssetId, additive = false, range = false): void {
    if (additive) {
      this.selectedAssetIds.update((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    } else if (range) {
      const list = this.assetsInSelectedFolder();
      const focused = this.focusedAssetId();
      const endIdx = list.findIndex((a) => a.id === id);
      const startIdx = focused ? list.findIndex((a) => a.id === focused) : -1;
      if (startIdx !== -1 && endIdx !== -1) {
        const [lo, hi] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
        this.selectedAssetIds.set(new Set(list.slice(lo, hi + 1).map((a) => a.id)));
      } else {
        this.selectedAssetIds.set(new Set([id]));
      }
    } else {
      this.selectedAssetIds.set(new Set([id]));
    }
    this.focusedAssetId.set(id);
  }

  clearSelection(): void {
    this.selectedAssetIds.set(new Set());
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  focusNext(): void {
    this._advance(1);
  }
  focusPrev(): void {
    this._advance(-1);
  }

  private _advance(dir: 1 | -1): void {
    const list = this.assetsInSelectedFolder();
    if (!list.length) return;
    const fid = this.focusedAssetId();
    const idx = fid ? list.findIndex((a) => a.id === fid) : -1;
    const next = list[Math.max(0, Math.min(list.length - 1, idx + dir))];
    if (next) {
      this.selectedAssetIds.set(new Set([next.id]));
      this.focusedAssetId.set(next.id);
    }
  }

  peekNext(currentId: AssetId): AssetId | null {
    const list = this.assetsInSelectedFolder();
    const idx = list.findIndex((a) => a.id === currentId);
    return list[Math.min(list.length - 1, idx + 1)]?.id ?? null;
  }

  peekPrev(currentId: AssetId): AssetId | null {
    const list = this.assetsInSelectedFolder();
    const idx = list.findIndex((a) => a.id === currentId);
    return list[Math.max(0, idx - 1)]?.id ?? null;
  }

  // ── Panel toggles ──────────────────────────────────────────────────────────

  toggleSidebar(): void {
    this.sidebarVisible.update((v) => !v);
    try {
      localStorage.setItem('cm.leftHidden', JSON.stringify(!this.sidebarVisible()));
    } catch {
      /* noop */
    }
  }

  toggleInspector(): void {
    this.inspectorVisible.update((v) => !v);
    try {
      localStorage.setItem('cm.detailHidden', JSON.stringify(!this.inspectorVisible()));
    } catch {
      /* noop */
    }
  }

  // ── Tree expand state ──────────────────────────────────────────────────────

  toggleSection(id: string): void {
    this.sectionOpen.update((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem('cm.sections', JSON.stringify(next));
      } catch {
        /* noop */
      }
      return next;
    });
  }

  setFolderOpen(id: string, open: boolean): void {
    this.folderOpen.update((prev) => {
      const next = { ...prev, [id]: open };
      try {
        localStorage.setItem('cm.folderOpen', JSON.stringify(next));
      } catch {
        /* noop */
      }
      return next;
    });
  }

  // ── Sidebar helpers ────────────────────────────────────────────────────────

  private _ensureFolder(folderId: string, label: string): void {
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

  private _ensureImportedFolder(): void {
    this._ensureFolder('f-imported', 'Imported');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _loadOrDefault<T>(key: string, fallback: T): T {
    try {
      const s = localStorage.getItem(key);
      return s != null ? (JSON.parse(s) as T) : fallback;
    } catch {
      return fallback;
    }
  }
}
