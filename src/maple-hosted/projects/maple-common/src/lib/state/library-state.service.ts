// Signal-based library store — shared by both Browse and Editor apps.
// Renamed from BrowseStateService; now lives in maple-common.
// No BehaviorSubjects, no zone.run.

import { Injectable, computed, signal } from '@angular/core';
import { Asset, AssetId, Flag, ColorLabel } from '../models/asset';
import { SidebarEntry } from '../models/folder';
import { AdjustmentModel, defaultAdjustmentModel, isDefaultAdjustment } from '../models/adjustment-model';

/** Supported RAW extensions for file intake. */
export const SUPPORTED_RAW_EXTENSIONS = new Set([
  'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf', 'rw2', 'pef',
  'srw', '3fr', 'fff', 'dcr', 'mos', 'iiq', 'mrw', 'raw',
]);

export function isSupportedRaw(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_RAW_EXTENSIONS.has(ext);
}

@Injectable({ providedIn: 'root' })
export class LibraryStateService {
  // ── Library data ───────────────────────────────────────────────────────────
  readonly assets       = signal<Asset[]>([]);
  readonly sidebarTree  = signal<SidebarEntry[]>([]);

  // ── Sidebar open/collapsed state ───────────────────────────────────────────
  readonly sectionOpen = signal<Record<string, boolean>>(
    this._loadOrDefault('cm.sections', { folders: true, photos: true }),
  );

  readonly folderOpen = signal<Record<string, boolean>>(
    this._loadOrDefault('cm.folderOpen', { 'f-2026': true }),
  );

  // ── Selection ──────────────────────────────────────────────────────────────
  readonly selectedSourceId   = signal<string>('f-france');
  readonly selectedAssetIds   = signal<Set<AssetId>>(new Set());
  readonly focusedAssetId     = signal<AssetId | null>(null);

  // ── Thumbnail size (grid density) ─────────────────────────────────────────
  readonly thumbSize = signal<number>(
    this._loadOrDefault('cm.thumbSize', 140) as number,
  );

  // ── Sort + filter ─────────────────────────────────────────────────────────
  readonly sort   = signal<'date' | 'name'>(
    this._loadOrDefault('cm.sort', 'date') as 'date' | 'name',
  );
  readonly filter = signal<'all' | 'picks' | '4stars'>(
    this._loadOrDefault('cm.filter', 'all') as 'all' | 'picks' | '4stars',
  );

  // ── Panel visibility (persisted) ──────────────────────────────────────────
  readonly sidebarVisible   = signal<boolean>(
    this._loadOrDefault('cm.leftHidden', false) === false,
  );
  readonly inspectorVisible = signal<boolean>(
    this._loadOrDefault('cm.detailHidden', false) === false,
  );

  // ── Active detail tab ─────────────────────────────────────────────────────
  readonly activeTab = signal<'info' | 'develop'>(
    this._loadOrDefault('cm.tab', 'info') as 'info' | 'develop',
  );

  // ── File bytes for imported assets (in-memory, keyed by AssetId) ──────────
  readonly fileBytes = signal<Map<AssetId, Uint8Array>>(new Map());

  // ── Thumbnail cache (blob URLs — revoked when assets are removed) ──────────
  readonly thumbnailUrls = signal<Map<AssetId, string>>(new Map());

  // ── Adjustment models (per-asset develop settings) ────────────────────────
  readonly adjustmentModels = signal<Map<AssetId, AdjustmentModel>>(new Map());

  adjustmentFor(id: AssetId) {
    return computed(() => this.adjustmentModels().get(id) ?? defaultAdjustmentModel());
  }

  updateAdjustment(id: AssetId, patch: Partial<AdjustmentModel>): void {
    this.adjustmentModels.update(map => {
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

  // ── Derived signals ────────────────────────────────────────────────────────

  /** Assets for the currently selected folder/collection, filtered + sorted. */
  readonly assetsInSelectedFolder = computed(() => {
    const sid = this.selectedSourceId();
    let list = this.assets().filter(a => a.folderId === sid);

    const f = this.filter();
    if (f === 'picks')  list = list.filter(a => a.flag === 'pick');
    if (f === '4stars') list = list.filter(a => a.rating >= 4);

    if (this.sort() === 'name') {
      list = [...list].sort((a, b) => a.filename.localeCompare(b.filename));
    }

    return list;
  });

  readonly focusedAsset = computed(() => {
    const fid = this.focusedAssetId();
    if (!fid) return null;
    return this.assets().find(a => a.id === fid) ?? null;
  });

  readonly selectedCount = computed(() => this.selectedAssetIds().size);

  // ── Imported asset mutations ───────────────────────────────────────────────

  /**
   * Add a RAW file as a new Asset entry. The bytes are stored in-memory keyed
   * by the generated AssetId. Returns the new AssetId.
   */
  addImportedAsset(bytes: Uint8Array, filename: string): AssetId {
    const id = crypto.randomUUID();
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const asset: Asset = {
      id,
      filename,
      folderId: 'f-imported',
      rating: 0,
      flag: 'unflagged',
      colorLabel: null,
      thumbnailGradient: '',
      aspectRatio: 3 / 2,  // default until first decode
    };
    this.assets.update(list => [...list, asset]);
    this.fileBytes.update(map => {
      const next = new Map(map);
      next.set(id, bytes);
      return next;
    });
    // Ensure the "Imported" virtual folder exists in the sidebar tree.
    this._ensureImportedFolder();
    return id;
  }

  /** Update an asset's dimensions after a successful decode. */
  updateAssetDimensions(id: AssetId, width: number, height: number): void {
    this.assets.update(list =>
      list.map(a => a.id === id ? { ...a, width, height, aspectRatio: width / height } : a)
    );
  }

  /** Store a resolved thumbnail blob URL for an asset. */
  cacheThumbnailUrl(id: AssetId, url: string): void {
    this.thumbnailUrls.update(map => {
      const next = new Map(map);
      next.set(id, url);
      return next;
    });
  }

  /** Retrieve the cached thumbnail URL if any. */
  thumbnailUrlFor(id: AssetId): string | undefined {
    return this.thumbnailUrls().get(id);
  }

  /** Retrieve the raw file bytes for an asset (undefined for mock assets). */
  bytesFor(id: AssetId): Uint8Array | undefined {
    return this.fileBytes().get(id);
  }

  /** Ensure the "f-imported" folder exists in the sidebar tree. */
  private _ensureImportedFolder(): void {
    const tree = this.sidebarTree();
    const foldersSection = tree.find(s => s.id === 'folders');
    if (!foldersSection || !foldersSection.children) return;
    const alreadyExists = foldersSection.children.some(
      c => c.id === 'f-imported'
    );
    if (!alreadyExists) {
      this.sidebarTree.update(t =>
        t.map(s => s.id === 'folders'
          ? {
              ...s,
              children: [
                ...(s.children ?? []),
                { kind: 'folder' as const, id: 'f-imported', label: 'Imported', count: null },
              ],
            }
          : s
        )
      );
    }
  }

  // ── Culling mutations ──────────────────────────────────────────────────────

  setRating(id: AssetId, rating: number): void {
    this.assets.update(list =>
      list.map(a => a.id === id ? { ...a, rating } : a),
    );
  }

  setFlag(id: AssetId, flag: Flag): void {
    this.assets.update(list =>
      list.map(a => a.id === id ? { ...a, flag } : a),
    );
  }

  setColorLabel(id: AssetId, colorLabel: ColorLabel): void {
    this.assets.update(list =>
      list.map(a => a.id === id ? { ...a, colorLabel } : a),
    );
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  selectAsset(id: AssetId, additive = false, range = false): void {
    if (additive) {
      this.selectedAssetIds.update(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    } else if (range) {
      const list = this.assetsInSelectedFolder();
      const focused = this.focusedAssetId();
      const endIdx = list.findIndex(a => a.id === id);
      const startIdx = focused ? list.findIndex(a => a.id === focused) : -1;
      if (startIdx !== -1 && endIdx !== -1) {
        const [lo, hi] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
        this.selectedAssetIds.set(new Set(list.slice(lo, hi + 1).map(a => a.id)));
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
    const idx = fid ? list.findIndex(a => a.id === fid) : -1;
    const next = list[Math.max(0, Math.min(list.length - 1, idx + dir))];
    if (next) {
      this.selectedAssetIds.set(new Set([next.id]));
      this.focusedAssetId.set(next.id);
    }
  }

  // Returns AssetId after advance without mutating state (used by editor nav).
  peekNext(currentId: AssetId): AssetId | null {
    const list = this.assetsInSelectedFolder();
    const idx = list.findIndex(a => a.id === currentId);
    const next = list[Math.min(list.length - 1, idx + 1)];
    return next?.id ?? null;
  }

  peekPrev(currentId: AssetId): AssetId | null {
    const list = this.assetsInSelectedFolder();
    const idx = list.findIndex(a => a.id === currentId);
    const prev = list[Math.max(0, idx - 1)];
    return prev?.id ?? null;
  }

  // ── Panel toggles ──────────────────────────────────────────────────────────

  toggleSidebar(): void {
    this.sidebarVisible.update(v => !v);
    try {
      localStorage.setItem('cm.leftHidden', JSON.stringify(!this.sidebarVisible()));
    } catch { /* noop */ }
  }

  toggleInspector(): void {
    this.inspectorVisible.update(v => !v);
    try {
      localStorage.setItem('cm.detailHidden', JSON.stringify(!this.inspectorVisible()));
    } catch { /* noop */ }
  }

  // ── Tree expand state ──────────────────────────────────────────────────────

  toggleSection(id: string): void {
    this.sectionOpen.update(prev => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem('cm.sections', JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  }

  setFolderOpen(id: string, open: boolean): void {
    this.folderOpen.update(prev => {
      const next = { ...prev, [id]: open };
      try { localStorage.setItem('cm.folderOpen', JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _loadOrDefault<T>(key: string, fallback: T): T {
    try {
      const s = localStorage.getItem(key);
      return s != null ? JSON.parse(s) as T : fallback;
    } catch {
      return fallback;
    }
  }
}
