// Signal-based store for the Browse app.
// No BehaviorSubjects, no manual change detection, no Zone hacks.

import { Injectable, computed, signal, effect } from '@angular/core';
import { Asset, AssetId, Flag, ColorLabel } from '@maple-common';
import { SidebarEntry } from '@maple-common';

@Injectable({ providedIn: 'root' })
export class BrowseStateService {
  // ── Library data ───────────────────────────────────────────────────────────
  readonly assets       = signal<Asset[]>([]);
  readonly sidebarTree  = signal<SidebarEntry[]>([]);

  // ── Sidebar open/collapsed state ───────────────────────────────────────────
  // Maps section ids to whether they're expanded. Persisted to localStorage.
  readonly sectionOpen = signal<Record<string, boolean>>(
    this._loadOrDefault('cm.sections', { folders: true, photos: true }),
  );

  // Maps folder node ids to whether they're expanded.
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

  // ── Derived signals ────────────────────────────────────────────────────────

  /** Assets for the currently selected folder/collection, filtered + sorted. */
  readonly assetsInSelectedFolder = computed(() => {
    const sid = this.selectedSourceId();
    let list = this.assets().filter(a => a.folderId === sid);

    // Filter
    const f = this.filter();
    if (f === 'picks')  list = list.filter(a => a.flag === 'pick');
    if (f === '4stars') list = list.filter(a => a.rating >= 4);

    // Sort
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
