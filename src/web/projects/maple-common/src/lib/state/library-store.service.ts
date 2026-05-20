// Library store — data and prefs only. No fetching, no caching, no selection.
//
// Holds the signal-readable state for the browse + editor shells:
//   - asset list, grid folders, sidebar tree
//   - current folder handle, registered libraries (Self-Hosted)
//   - per-asset adjustment models + id ↔ remote-id maps
//   - persisted prefs (sort/filter/search/view mode, panel visibility, etc.)
//
// **Design call (ticket #122):** stayed on plain Angular signals rather than
// migrating to NgRx SignalStore. This is a brownfield split — the goal is to
// shrink the 1,621-LOC monolith with zero behaviour change. SignalStore would
// drag in @ngrx/signals and rewrite the consumer surface (we'd have to switch
// every component from `inject(LibraryStateService)` to selectors). Park that
// migration for a follow-up greenfield ticket.

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

@Injectable({ providedIn: 'root' })
export class LibraryStore {
  /** Which backend is in use. Consumers read this to branch data-source paths. */
  readonly backend = inject(LIBRARY_BACKEND);

  // ── Self-Hosted bootstrap state ────────────────────────────────────────────
  /** True while listFolders / listAssets is in flight (Self-Hosted only). */
  readonly backendLoading = signal<boolean>(false);
  /** Last backend error message, cleared on successful load. */
  readonly backendError = signal<string | null>(null);
  /** True when the API returned zero folders (index not configured yet). */
  readonly backendEmpty = signal<boolean>(false);
  /** Latest server-side registered libraries. */
  readonly registeredFolders = signal<ApiFolder[]>([]);
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

  // ── Sidebar open/collapsed state ───────────────────────────────────────────
  readonly sectionOpen = signal<Record<string, boolean>>(
    this._loadOrDefault('cm.sections', { folders: true, photos: true }),
  );

  readonly folderOpen = signal<Record<string, boolean>>(
    this._loadOrDefault('cm.folderOpen', { 'f-2026': true }),
  );

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

  // ── Browse-shell view mode (Folder vs Timeline) ──────────────────────────
  readonly viewMode = signal<'folder' | 'timeline'>(
    // Guard against corrupted/manipulated storage — anything other than the
    // two valid modes falls back to 'folder'.
    (() => {
      const v = this._loadOrDefault<unknown>('cm.viewMode', 'folder');
      return v === 'timeline' ? 'timeline' : 'folder';
    })(),
  );

  setViewMode(mode: 'folder' | 'timeline'): void {
    this.viewMode.set(mode);
    try {
      localStorage.setItem('cm.viewMode', JSON.stringify(mode));
    } catch {
      /* noop */
    }
  }

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

  // ── Persistence helpers ───────────────────────────────────────────────────

  private _loadOrDefault<T>(key: string, fallback: T): T {
    try {
      const s = localStorage.getItem(key);
      return s != null ? (JSON.parse(s) as T) : fallback;
    } catch {
      return fallback;
    }
  }
}
