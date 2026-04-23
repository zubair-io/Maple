// Signal-based library store — shared by both Browse and Editor apps.
// P5: Lazy on-demand byte reads via FolderAccessService.
//     Replaced fileBytes Map with LruCache + FolderEntry handles.
//     .maple/ index writes debounced 500ms after culling changes.

import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Asset, AssetId, Flag, ColorLabel } from '../models/asset';
import { SidebarEntry } from '../models/folder';
import {
  AdjustmentModel,
  defaultAdjustmentModel,
  isDefaultAdjustment,
} from '../models/adjustment-model';
import { FolderAccessService } from '../folder-access/folder-access.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { XmpParserService } from '../xmp/xmp-parser.service';
import { XmpStoreService } from '../xmp/xmp-store.service';
import { XmpCulling } from '../xmp/xmp.types';
import { MapleFolderHandle, FolderEntry } from '../folder-access/folder-access.types';
import { MapleIndex, IndexedAsset } from '../maple-cache/maple-cache.types';
import { sha256Prefix16 } from '../maple-cache/sha';

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
  private xmpParser = inject(XmpParserService);
  private xmpStore = inject(XmpStoreService);

  // ── Library data ───────────────────────────────────────────────────────────
  readonly assets = signal<Asset[]>([]);
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
  readonly selectedSourceId = signal<string>('f-france');
  readonly selectedAssetIds = signal<Set<AssetId>>(new Set());
  readonly focusedAssetId = signal<AssetId | null>(null);

  // ── Thumbnail size (grid density) ─────────────────────────────────────────
  readonly thumbSize = signal<number>(this._loadOrDefault('cm.thumbSize', 140) as number);

  // ── Sort + filter ─────────────────────────────────────────────────────────
  readonly sort = signal<'date' | 'name'>(
    this._loadOrDefault('cm.sort', 'date') as 'date' | 'name',
  );
  readonly filter = signal<'all' | 'picks' | '4stars'>(
    this._loadOrDefault('cm.filter', 'all') as 'all' | 'picks' | '4stars',
  );

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
      return [...others, ...newAssets];
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

  // ── addImportedAsset (legacy path — drag-drop without FS Access folder) ────

  /**
   * Add a RAW file as a new Asset entry from raw bytes (in-memory import).
   * Bytes are kept in the LRU cache; older entries are evicted when over budget.
   */
  addImportedAsset(bytes: Uint8Array, filename: string): AssetId {
    const id = crypto.randomUUID();
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

    if (this.sort() === 'name') {
      list = [...list].sort((a, b) => a.filename.localeCompare(b.filename));
    }

    return list;
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
    const folder = this.currentFolder();
    if (!folder?.write) return;

    const asset = this.assets().find((a) => a.id === id);
    if (!asset) return;

    const fullModel = this.adjustmentModels().get(id) ?? defaultAdjustmentModel();
    const culling: XmpCulling = {
      rating: asset.rating,
      flag: asset.flag,
      colorLabel: asset.colorLabel,
    };
    this.xmpStore.scheduleWrite(id, folder, asset.filename, fullModel, culling);
  }

  /**
   * Flush all pending sidecar writes immediately (call from beforeunload).
   */
  flushPendingXmpWrites(): Promise<void> {
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
