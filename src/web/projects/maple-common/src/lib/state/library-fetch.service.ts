// Library fetch — folder/asset enumeration, XMP I/O, index writes.
//
// Coordinates the store (data + id-maps), selection (cursor placement), and
// cache (file handles + LRU priming) to bring assets into view from any of
// the three backends (FS Access folder, Self-Hosted FS-walk, Self-Hosted
// Mongo). Also owns the debounced sidecar write and the `.maple/index.json`
// debounced mirror.

import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, effect, inject } from '@angular/core';
import { FOLDER_LISTING_CACHE } from '../api/folder-listing-cache';
import { Asset, AssetId, ColorLabel, Flag } from '../models/asset';
import { GridFolderItem, SidebarEntry } from '../models/folder';
import { AdjustmentModel, defaultAdjustmentModel } from '../models/adjustment-model';
import { ApiFolder, BunApiBackendService } from '../api/bun-api-backend.service';
import { FolderAccessService } from '../folder-access/folder-access.service';
import {
  LIBRARY_SOURCE,
  type LibrarySource,
  type FolderListing,
} from '../addressing/library-source';
import { parseAddress, formatAddress, type MapleAddress } from '../addressing/maple-address';
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
import { isSupportedRaw } from './raw-extensions';
import { TypedStorage } from '../util/typed-storage';

const ASSET_RENDER_KEYS: readonly (keyof Asset)[] = [
  'id',
  'folderId',
  'filename',
  'absPath',
  'rating',
  'flag',
  'colorLabel',
  // IPTC `keywords` is intentionally listed even though the field is an
  // array and `shallowEqualByKeys` does a `===` reference compare —
  // `setKeywords` rebuilds the list, so a new reference always means a
  // real change and reuse-prevention is correct. Without this entry the
  // folder-reload path would silently drop XMP-loaded keywords when an
  // unchanged asset is merged with its previous instance (#632).
  'keywords',
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

// RAW-extension detection moved to the dependency-free `raw-extensions`
// module (so the raw-pipeline service can import it without an import cycle).
// Re-exported here to preserve the existing public surface.
export { SUPPORTED_RAW_EXTENSIONS } from './raw-extensions';
export { isSupportedRaw };

/**
 * localStorage key for the Self-Hosted last-selected source id.
 *
 * Single source of truth: `LibraryFetch._selectInitialFolder` reads it on
 * cold start and `BrowseShellComponent` writes it from a `selectedSourceId`
 * effect. Both sides import this constant so the key can't silently drift.
 */
export const LAST_SOURCE_KEY = 'cm.lastSourceId';

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
  private readonly librarySource: LibrarySource = inject(LIBRARY_SOURCE);
  private readonly prefs = inject(BrowsePreferencesService);
  private readonly folderCache = inject(FOLDER_LISTING_CACHE);

  // ── Index write debounce ──────────────────────────────────────────────────
  private _indexWriteTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Auto-scan-on-open fire-once guard (#804) ───────────────────────────────
  // Registered-library ids we've already triggered a content-aware `/scan`
  // for this session. `scanFolderAndDiscover` walks the WHOLE library, so one
  // scan per library covers every sub-folder — keying on the library id (not
  // the per-sub-folder source id) avoids re-scanning on every sidebar click.
  // The server's `last_scan` gate is the cross-session backstop; this guard
  // just stops same-session request spam on rapid navigation.
  private readonly _autoScannedLibraryIds = new Set<string>();

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
      // True iff we successfully read an XMP sidecar — the v0.1 signal
      // behind the S2 "Edited" filter chip (#628). Mirrors the Apple
      // side's `AssetRef.hasEdits` sidecar-existence predicate.
      let edited = false;
      let keywords: string[] = [];

      // XMP sidecar is authoritative — parse both culling + full AdjustmentModel.
      const xmpName = filename.replace(/\.[^.]+$/, '.xmp');
      try {
        const xmpBytes = await this.fs.readFile(folder, xmpName);
        const xmpText = new TextDecoder().decode(xmpBytes);

        // Culling fields (P5) + IPTC keywords (#632).
        const culling = this.xmpParser.parseCulling(xmpText);
        rating = culling.rating;
        flag = culling.flag;
        colorLabel = culling.colorLabel;
        keywords = [...(culling.keywords ?? [])];

        // Full AdjustmentModel (P6).
        const { model, passthrough } = this.xmpParser.parseAdjustmentModel(xmpText);
        const fullModel: AdjustmentModel = { ...defaultAdjustmentModel(), ...model };
        newAdjustments.set(id, fullModel);

        // Cache the passthrough bucket for future writes.
        this.xmpStore.rememberPassthrough(id, passthrough);

        edited = true;
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
        keywords,
        thumbnailGradient: '',
        aspectRatio: 3 / 2, // corrected after first decode
        edited,
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
    const existing = this.selection.selectedSourceId();
    if (existing && existing.includes(':')) {
      // URL deep-link applied selection before libraries were known — nothing
      // more to do; the address is already in slug:relPath form and the grid
      // will fetch via LibrarySource when openSelfHostedSubfolder runs.
      return;
    }

    const lastId = TypedStorage.getRaw(LAST_SOURCE_KEY);

    // New format: slug:relPath — restore directly.
    if (lastId && lastId.includes(':') && !lastId.startsWith('fs:')) {
      try {
        const addr = parseAddress(lastId);
        const owning = folders.find((f) => f.slug === addr.slug || f.id === addr.slug);
        if (owning) {
          this.openSelfHostedSubfolder(addr.relPath, lastId);
          return;
        }
      } catch {
        // Unparseable — fall through to first library.
      }
    }

    // Legacy `fs:<absPath>` in localStorage — hard-cutover: the fs: scheme is
    // gone; fall back to the first registered library as if nothing was stored.
    // (The user's folder history is discarded on first run after upgrade.)

    const first = folders[0];
    if (first) this.openSelfHostedFolder(first);
  }

  /**
   * Bring a deep-linked sub-folder into the sidebar: synthesize the ancestor
   * chain so the selection has a node to highlight immediately, auto-expand
   * the library root + every ancestor, and — crucially — load each ancestor's
   * real children so its SIBLINGS appear, not just the single node on the
   * chain.
   *
   * Without the sibling load, restoring a `?folder=…` deep-link painted only
   * a thin spine (each ancestor showed exactly one child — the next link in
   * the chain) and the rest of the tree stayed invisible until the user
   * clicked into each level. We walk back up the chain and fetch every
   * ancestor (the library root through the selected folder's direct parent)
   * via the SWR cache, so the full tree fills in on load. The selected leaf
   * itself is loaded by the `openSelfHostedSubfolder` call that drives the
   * grid, so we stop at its parent.
   *
   * No-ops if `absPath` isn't a strict descendant of `libraryRoot`.
   */
  /**
   * Synthesize the ancestor chain for a deep-linked sub-folder address so the
   * sidebar has nodes to highlight immediately. Works in `slug:relPath` space.
   *
   * For each ancestor on the relPath chain (from library root to the parent of
   * the selected folder) we ensure a tree node exists, auto-expand it, and
   * trigger a `expandFsFolder` so its real siblings populate.
   *
   * No-ops if `addr.relPath` is empty (the address IS the root).
   */
  private _ensureAddressInTree(addr: MapleAddress): void {
    if (!addr.relPath) return;
    const segments = addr.relPath.split('/').filter(Boolean);
    if (segments.length === 0) return;

    const rootId = formatAddress({ slug: addr.slug, relPath: '' });

    // Make the library root open so its children (the first ancestor) are visible.
    this.prefs.setFolderOpen(rootId, true);

    // Build the ancestor chain: library root through the direct parent of the
    // selected folder. Each gets a fetch so its siblings populate.
    const ancestors: { id: string }[] = [];

    let parentId = rootId;
    let parentRelPath = '';
    for (let i = 0; i < segments.length; i++) {
      ancestors.push({ id: parentId });
      const seg = segments[i]!;
      const childRelPath = parentRelPath === '' ? seg : `${parentRelPath}/${seg}`;
      const childId = formatAddress({ slug: addr.slug, relPath: childRelPath });
      const childLabel = seg;
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
              },
            ],
          };
        }),
      );
      // Auto-expand every ancestor on the chain except the leaf.
      if (i < segments.length - 1) {
        this.prefs.setFolderOpen(childId, true);
      }
      parentId = childId;
      parentRelPath = childRelPath;
    }

    // Load real children for each ancestor so siblings fill in.
    for (const a of ancestors) {
      this.expandFsFolder({ id: a.id, childrenStatus: undefined });
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
   * Builds a MapleAddress from the folder's slug (M1 field) and calls
   * `LibrarySource.listFolder` via `openSelfHostedSubfolder`. Falls back to
   * the `id`-derived root address when `slug` is absent (pre-M1 API response).
   */
  openSelfHostedFolder(folder: ApiFolder): void {
    if (this.store.backend !== 'self-hosted') return;

    const slug = folder.slug ?? folder.id;
    const rootAddr: MapleAddress = { slug, relPath: '' };
    const sourceId = formatAddress(rootAddr);
    this.openSelfHostedSubfolder('', sourceId);
  }

  /**
   * Self-Hosted: open an arbitrary directory inside a registered library.
   *
   * `relPath` is the POSIX-relative path within the library root (empty string
   * for the library root itself). `sourceId` is the full `slug:relPath`
   * MapleAddress string for this node — when omitted the store is checked for
   * a node whose address matches the relPath, otherwise the `slug:relPath`
   * form of any registered library slug + relPath is synthesised.
   */
  openSelfHostedSubfolder(relPath: string, sourceId?: string, selectAssetId?: AssetId): void {
    if (this.store.backend !== 'self-hosted') return;

    const id = sourceId ?? this.store.sourceIdForRelPath(relPath) ?? `unknown:${relPath}`;
    // Set the selection synchronously so the file-list breadcrumb + grid
    // empty-state reflect the click immediately, before the HTTP response.
    this.selection.selectedSourceId.set(id);
    this.status.backendLoading.set(true);
    this.status.backendError.set(null);
    this.status.backendEmpty.set(false);

    // Select an asset only on the first paint that actually has a target —
    // a cached paint should land the cursor instantly, and the later network
    // revalidation must not clobber a selection the user made in between.
    let selected = false;
    const trySelect = (): void => {
      if (selected) return;
      if (selectAssetId) {
        const target = this.store.assets().find((a) => a.id === selectAssetId);
        if (target) {
          this.selection.selectAsset(target.id);
          selected = true;
        }
      } else {
        const firstAsset = this.store.assets().find((a) => a.folderId === id);
        if (firstAsset) {
          this.selection.selectAsset(firstAsset.id);
          selected = true;
        }
      }
    };

    const addr = parseAddress(id);
    this._swrListFolder(
      addr,
      (listing, fresh) => {
        this._applyFolderListing(id, listing);
        trySelect();
        this.status.backendLoading.set(false);
        if (fresh && listing.folders.length === 0 && listing.images.length === 0) {
          // Empty folder — clear any leftover error banner; the grid will
          // show its own "Folder is empty" state. Only act on the fresh
          // listing so a stale-empty cache entry can't flash the empty state.
          this.status.backendEmpty.set(false);
        }
      },
      (err: HttpErrorResponse) => {
        this.status.backendLoading.set(false);
        const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
        this.status.backendError.set(
          err.status >= 500
            ? `Server error (${err.status}) loading folder.`
            : `Failed to load folder: ${detail}`,
        );
      },
    );

    // Auto-scan-on-open (#804): kick a content-aware re-discover of the owning
    // registered library so a moved/new file is relinked (stages resume). This
    // is non-blocking — the grid paints from the `_swrListFolder` listing above;
    // the scan resolves later and we re-pull the listing only if it actually
    // re-walked (new/relinked rows may now have apiId + enrichment).
    this._autoScanLibraryForSourceId(id);
  }

  /**
   * Fire the content-aware `/scan` for the registered library that owns
   * `absPath`, then refresh the open folder's listing when it completes.
   *
   * Non-blocking by contract — the caller has already painted the grid from
   * the filesystem listing. The self-hosted grid is a `/api/fs/dir` walk, so
   * a moved/new file is *already* visible; what the scan fixes is Mongo-side
   * (relink → stages resume → thumbnails/previews/apiId enrich). We therefore
   * re-pull the fs listing for the still-selected path on completion so the
   * freshly-relinked rows pick up their server-side ids/state.
   *
   * Fire-once per library per session (`_autoScannedLibraryIds`) so navigating
   * across a library's sub-folders doesn't re-request; the server's `last_scan`
   * gate is the cross-session backstop and returns `skipped: 'recent'` cheaply.
   */
  private _autoScanLibraryForSourceId(sourceId: string): void {
    if (this.store.backend !== 'self-hosted') return;
    const library = this.store.currentRegisteredFolder(sourceId);
    if (!library) return;
    if (this._autoScannedLibraryIds.has(library.id)) return;
    this._autoScannedLibraryIds.add(library.id);

    this.api.scanFolder(library.id).subscribe({
      next: (res) => {
        // A skipped (recent) scan did no re-walk — nothing new to surface, so
        // don't churn the listing. Only refresh when the walk actually ran.
        if (!res.ok || res.skipped === 'recent') return;
        // Re-pull the still-selected address listing so relinked/new rows
        // appear with their server-side ids. Guard against the user having
        // navigated away while the scan was in flight.
        if (this.selection.selectedSourceId() !== sourceId) return;
        const addr = parseAddress(sourceId);
        this._swrListFolder(
          addr,
          (listing) => this._applyFolderListing(sourceId, listing),
          () => {
            // Refresh failure is non-fatal — the grid already shows the
            // filesystem listing; the next manual navigation will re-pull.
          },
        );
      },
      error: () => {
        // Auto-scan is best-effort — drop the guard so a later open can retry.
        this._autoScannedLibraryIds.delete(library.id);
      },
    });
  }

  /**
   * Stale-while-revalidate directory read. Paints the cached listing (from
   * the synchronous in-memory tier, else the async IndexedDB tier) so the
   * sidebar tree + grid appear instantly on re-navigation and full app
   * reloads, then always revalidates over the network and re-applies the
   * fresh listing on top.
   *
   * `apply` runs at most twice: once with the cached listing (`fresh=false`)
   * and once with the network listing (`fresh=true`). The network result is
   * authoritative and always wins — a late-arriving cache read is dropped
   * once the fresh listing has landed.
   */
  /**
   * Stale-while-revalidate directory read via LibrarySource.
   * Paints the cached FolderListing (in-memory, then IndexedDB) immediately,
   * then always revalidates over the network and re-applies on top.
   *
   * `apply` runs at most twice: once with `fresh=false` (cached) and once with
   * `fresh=true` (network). Network is authoritative; a late-arriving cached
   * read is dropped once the fresh listing has landed.
   */
  private _swrListFolder(
    addr: MapleAddress,
    apply: (listing: FolderListing, fresh: boolean) => void,
    onError: (err: HttpErrorResponse) => void,
  ): void {
    let freshArrived = false;
    const cacheKey = formatAddress(addr);

    const cached = this.folderCache.peek(cacheKey);
    if (cached) {
      apply(cached, false);
    } else {
      // No synchronous hit — try the persistent tier. Drop if network wins.
      void this.folderCache.get(cacheKey).then((listing) => {
        if (listing && !freshArrived) apply(listing, false);
      });
    }

    void this.librarySource.listFolder(addr).then(
      (listing) => {
        freshArrived = true;
        this.folderCache.put(cacheKey, listing);
        apply(listing, true);
      },
      (err: unknown) => {
        onError(err as HttpErrorResponse);
      },
    );
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
  /**
   * Apply a `LibrarySource.listFolder` result to state:
   *  - Drop the current asset/folder entries for the source.
   *  - Build new `Asset` records from `listing.images`, keyed by their address.
   *  - Build new `GridFolderItem` records from `listing.folders` and update the
   *    source's folder tiles.
   *  - Push `listing.folders` into the sidebar tree as children of the node so
   *    the lazy-expand chevron has something to reveal.
   */
  private _applyFolderListing(sourceId: string, listing: FolderListing): void {
    // Purge stale assets for this source so stale address-keyed ids don't
    // linger after a rename or deletion.
    const stale = this.store
      .assets()
      .filter((a) => a.folderId === sourceId)
      .map((a) => a.id);
    for (const id of stale) {
      this.store.assetAbsPaths.delete(id);
      this.store.apiAssetIds.delete(id);
    }

    const newAssets: Asset[] = listing.images.map((img) => {
      const id: AssetId = img.address;
      return {
        id,
        filename: img.name,
        folderId: sourceId,
        rating: 0,
        flag: 'unflagged' as const,
        colorLabel: null,
        thumbnailGradient: '',
        aspectRatio: 3 / 2,
        // width/height from the listing when the server provides them.
        ...(img.width != null ? { width: img.width } : {}),
        ...(img.height != null ? { height: img.height, aspectRatio: img.width! / img.height } : {}),
        ...(img.isVideo ? { isVideo: true as const } : {}),
      };
    });

    this.store.assets.update((list) => {
      const others = list.filter((a) => a.folderId !== sourceId);
      const previous = list.filter((a) => a.folderId === sourceId);
      const merged = mergePreservingRefs(previous, newAssets, assetsEqualForRender);
      return [...others, ...merged];
    });

    const newFolders: GridFolderItem[] = listing.folders.map((d) => ({
      id: d.address,
      name: d.name,
      parentSourceId: sourceId,
      aspectRatio: 3 / 2,
    }));

    this.store.gridFolders.update((list) => {
      const others = list.filter((f) => f.parentSourceId !== sourceId);
      return [...others, ...newFolders];
    });

    this._attachFolderChildren(sourceId, listing.folders);
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
  /**
   * Replace the children of the sidebar node identified by `sourceId` with
   * folder entries derived from a `FolderListing`. Marks the node as `loaded`.
   *
   * Preserves existing child entries (carrying over `childrenStatus`, `children`,
   * etc.) so a refetch of a parent doesn't wipe a deeper expanded subtree.
   */
  private _attachFolderChildren(
    sourceId: string,
    folders: { name: string; address: string }[],
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
          children: folders.map((d) => {
            const prior = existingById.get(d.address);
            if (prior) return { ...prior, label: d.name };
            return {
              kind: 'folder' as const,
              id: d.address,
              label: d.name,
              count: null,
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
  /**
   * Lazy-expand: load the children of a sub-folder node via its address (the
   * node's `id` is a `slug:relPath` MapleAddress string). No-ops if the node
   * is already loaded or in flight; flips status to `error` on failure.
   *
   * `absPath` on legacy sidebar nodes is ignored — the address is the canonical
   * identifier after M2. Pass the node's `id` as the address.
   */
  expandFsFolder(node: {
    id: string;
    absPath?: string;
    childrenStatus?: 'loading' | 'loaded' | 'error';
  }): void {
    if (node.childrenStatus === 'loading' || node.childrenStatus === 'loaded') return;
    // node.id is the slug:relPath address after M2; skip if not parseable.
    if (!node.id.includes(':')) return;

    // Mark in-flight so the chevron shows a spinner instead of refetching.
    this.store.sidebarTree.update((tree) =>
      this.store.patchTree(tree, node.id, (n) => ({ ...n, childrenStatus: 'loading' })),
    );

    try {
      const addr = parseAddress(node.id);
      this._swrListFolder(
        addr,
        (listing) => this._attachFolderChildren(node.id, listing.folders),
        (err: HttpErrorResponse) => {
          const detail = err?.error?.error ?? err?.message ?? 'Unknown error';
          this.store.sidebarTree.update((tree) =>
            this.store.patchTree(tree, node.id, (n) => ({
              ...n,
              childrenStatus: 'error' as const,
              childrenError: detail,
            })),
          );
        },
      );
    } catch {
      // Unparseable id — revert to undefined so the chevron can retry.
      this.store.sidebarTree.update((tree) =>
        this.store.patchTree(tree, node.id, (n) => ({ ...n, childrenStatus: undefined })),
      );
    }
  }

  /**
   * Cold-load hydration for `/edit/fs:<absPath>` deep-links on Self-Hosted.
   *
   * Synthesizes a single placeholder Asset entry from the id so the editor
   * can mount immediately and start fetching bytes via `/api/fs/raw`.
   * Caller should follow up with `openSelfHostedSubfolder(parentDir,
   * sourceId, id)` to populate the filmstrip with siblings.
   */
  /**
   * Cold-load hydration for `/edit/<slug>/<relPath>` deep-links on Self-Hosted.
   *
   * Synthesizes a single placeholder Asset entry from the address so the editor
   * can mount immediately. Accepts `slug:relPath` addresses only (the legacy
   * `fs:<absPath>` scheme is retired post-M2 cutover).
   *
   * Caller should follow up with `openSelfHostedSubfolder(parentRelPath,
   * folderId, id)` to populate the filmstrip with siblings.
   */
  hydrateSelfHostedFsAsset(id: AssetId, patch?: Partial<Asset>): Asset | null {
    if (this.store.backend !== 'self-hosted') return null;

    // Only slug:relPath addresses are accepted post-M2 cutover.
    // The legacy fs:<absPath> scheme is retired; callers that previously
    // passed fs: ids should use the new slug:relPath form.
    if (!id.includes(':')) return null;

    const addr = parseAddress(id);
    const relPath = addr.relPath;
    const slug = addr.slug;

    if (!relPath) return null;
    const lastSlash = relPath.lastIndexOf('/');
    const filename = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
    const parentRelPath = lastSlash >= 0 ? relPath.slice(0, lastSlash) : '';
    const folderId: AssetId = formatAddress({ slug, relPath: parentRelPath });

    // Strip identity-bearing fields from `patch`.
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
      ...safePatch,
    };

    this.store.assets.update((list) => {
      const idx = list.findIndex((a) => a.id === id);
      if (idx === -1) return [...list, baseAsset];
      // Already present (e.g. listed via _applyFolderListing) — merge in any
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
    //
    // Node ids are now `slug:` (the library root address, relPath='') rather
    // than `fs:<absPath>`. The slug comes from M1's `ApiFolder.slug`; falls
    // back to `folder.id` (hex ObjectId) when the server is pre-M1.
    for (const f of folders) {
      const slug = f.slug ?? f.id;
      const rootId = formatAddress({ slug, relPath: '' });
      const label = f.label || f.path.split('/').filter(Boolean).pop() || f.path;
      this.store.ensureFsFolder(rootId, label, f.path);
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
      // IPTC keywords (#632) — round-tripped through dc:subject. Empty
      // / undefined writes the same default-no-element sidecar.
      keywords: asset.keywords ?? [],
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
      thumbPath: `./thumbs/${sha}.avif`,
    };
    this.store.folderIndex = this.mapleCache.patchAssetInIndex(this.store.folderIndex, patch);
  }
}
