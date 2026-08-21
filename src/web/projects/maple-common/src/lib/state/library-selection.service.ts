// Library selection — which library/folder/asset is currently picked, and the
// derived asset+folder lists for the grid (filtered + sorted from store data).
//
// Reads from `LibraryStore`; writes only its own selection signals.

import { Injectable, computed, inject, signal } from '@angular/core';
import { Asset, AssetId } from '../models/asset';
import { SidebarEntry } from '../models/folder';
import { LibraryStore } from './library-store.service';
import { BrowsePreferencesService } from './browse-preferences.service';

@Injectable({ providedIn: 'root' })
export class LibrarySelection {
  private readonly store = inject(LibraryStore);
  private readonly prefs = inject(BrowsePreferencesService);

  // ── Selection ──────────────────────────────────────────────────────────────
  readonly selectedSourceId = signal<string>('');
  readonly selectedAssetIds = signal<Set<AssetId>>(new Set());
  readonly focusedAssetId = signal<AssetId | null>(null);

  // Grid folder-tile selection (#2976) — folders and photos are selected
  // through the same gestures but tracked in separate sets because every
  // downstream consumer cares about the split: photo actions (metadata,
  // pano, rename) read `selectedAssetIds` only, while Move to… / Move to
  // Trash operate on both. `focusedFolderId` is the folder range-select
  // anchor, the folder-side mirror of `focusedAssetId`.
  readonly selectedFolderIds = signal<Set<string>>(new Set());
  readonly focusedFolderId = signal<string | null>(null);

  // ── In-grid search query (filename substring filter) ──────────────────────
  // Ephemeral — does NOT persist. Lives next to the rest of the selection
  // signals because the toolbar input narrows the visible asset/folder set
  // (i.e. it's a selection-shaping input, not library data).
  readonly searchQuery = signal<string>('');

  // ── Select mode (#2404) ────────────────────────────────────────────────────
  // Session-scoped, not persisted — mirrors Apple's `BrowseVM.isSelecting`,
  // which is view-model state rather than a stored preference. Off by
  // default: a plain grid click navigates to Preview. While on, every click
  // toggles selection membership instead. Toggled from the toolbar's Select
  // pill; Escape exits it. Leaving the mode does NOT clear the selection —
  // the batch-metadata / pano / copy-paste pills stay enabled off
  // `selectedCount()` and clearing here would defeat the point of the mode.
  readonly isSelecting = signal<boolean>(false);

  toggleSelectMode(): void {
    this.isSelecting.update((v) => !v);
  }

  exitSelectMode(): void {
    this.isSelecting.set(false);
  }

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
    return walk(this.store.sidebarTree());
  });

  // ── Derived signals ────────────────────────────────────────────────────────

  readonly assetsInSelectedFolder = computed(() => {
    const sid = this.selectedSourceId();
    let list = this.store.assets().filter((a) => a.folderId === sid);

    const f = this.prefs.filter();
    if (f === 'picks') list = list.filter((a) => a.flag === 'pick');
    if (f === '4stars') list = list.filter((a) => a.rating >= 4);
    // Responsive-program S2 (#623): "Edited" chip keys off the
    // optional `Asset.edited` boolean already populated by the
    // server / sidecar pass.
    if (f === 'edited') list = list.filter((a) => a.edited === true);

    // Filename substring filter from the toolbar search input.
    // Pragmatic scope: filename only — structured search lives on /search.
    const q = this.searchQuery().trim().toLowerCase();
    if (q.length > 0) {
      list = list.filter((a) => a.filename.toLowerCase().includes(q));
    }

    if (this.prefs.sort() === 'name') {
      list = [...list].sort((a, b) => a.filename.localeCompare(b.filename));
    }

    return list;
  });

  readonly foldersInSelectedFolder = computed(() => {
    const sid = this.selectedSourceId();
    let list = this.store.gridFolders().filter((f) => f.parentSourceId === sid);

    // Folder navigation ignores rating/flag filters (those are image-only
    // concepts) but honours the toolbar search filter on folder name so the
    // search input filters both kinds consistently.
    const q = this.searchQuery().trim().toLowerCase();
    if (q.length > 0) {
      list = list.filter((f) => f.name.toLowerCase().includes(q));
    }

    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly focusedAsset = computed<Asset | null>(() => {
    const fid = this.focusedAssetId();
    if (!fid) return null;
    return this.store.assets().find((a) => a.id === fid) ?? null;
  });

  readonly selectedCount = computed(() => this.selectedAssetIds().size);
  readonly selectedFolderCount = computed(() => this.selectedFolderIds().size);
  /** Photos + folders — what the toolbar's "N selected" and the Move to… /
   * Move to Trash buttons count; photo-only actions keep reading
   * `selectedCount`. */
  readonly selectedTotalCount = computed(() => this.selectedCount() + this.selectedFolderCount());

  // ── Selection mutations ───────────────────────────────────────────────────

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
      // Plain click replaces the ENTIRE selection, folders included —
      // additive/range gestures extend one kind while leaving the other
      // alone, so a mixed photos+folders selection stays possible.
      this.selectedAssetIds.set(new Set([id]));
      this.selectedFolderIds.set(new Set());
    }
    this.focusedAssetId.set(id);
  }

  /** Folder-tile counterpart of `selectAsset` (#2976): same
   * plain/additive/range contract, ranged over `foldersInSelectedFolder()`
   * (folders render as one contiguous Finder-style block at the top of the
   * grid, so a folder range never needs to span photos). */
  selectFolder(id: string, additive = false, range = false): void {
    if (additive) {
      this.selectedFolderIds.update((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    } else if (range) {
      const list = this.foldersInSelectedFolder();
      const focused = this.focusedFolderId();
      const endIdx = list.findIndex((f) => f.id === id);
      const startIdx = focused ? list.findIndex((f) => f.id === focused) : -1;
      if (startIdx !== -1 && endIdx !== -1) {
        const [lo, hi] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
        this.selectedFolderIds.set(new Set(list.slice(lo, hi + 1).map((f) => f.id)));
      } else {
        this.selectedFolderIds.set(new Set([id]));
      }
    } else {
      this.selectedFolderIds.set(new Set([id]));
      this.selectedAssetIds.set(new Set());
    }
    this.focusedFolderId.set(id);
  }

  clearSelection(): void {
    this.selectedAssetIds.set(new Set());
    this.selectedFolderIds.set(new Set());
  }

  /** Navigating to a different folder invalidates everything the selection
   * pointed at — the sets AND the range anchors (a stale anchor from the
   * previous folder would make the next shift-click fall back to
   * single-select, which is correct but only by accident; clear it so the
   * behavior is deliberate). */
  resetForSourceChange(): void {
    this.clearSelection();
    this.focusedAssetId.set(null);
    this.focusedFolderId.set(null);
  }

  /** Select several assets at once (#2650 — "Browse with selection" after a
   * multi-file drop resolves to a mount). Focus lands on the first id so
   * shift-click range-select continues from there. */
  selectMany(ids: AssetId[]): void {
    this.selectedAssetIds.set(new Set(ids));
    this.focusedAssetId.set(ids[0] ?? null);
  }

  /**
   * Follow a rename (#2637): swap `oldId` for `newId` wherever the
   * selection references it, so `focusedAsset` (which looks the id up in
   * `LibraryStore.assets()` — already rekeyed by `LibraryStore.renameAssetId`
   * by the time this runs) doesn't go stale and drop to `null` the instant
   * the rename lands.
   */
  renameAssetId(oldId: AssetId, newId: AssetId): void {
    if (oldId === newId) return;
    if (this.selectedAssetIds().has(oldId)) {
      this.selectedAssetIds.update((prev) => {
        const next = new Set(prev);
        next.delete(oldId);
        next.add(newId);
        return next;
      });
    }
    if (this.focusedAssetId() === oldId) {
      this.focusedAssetId.set(newId);
    }
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
}
