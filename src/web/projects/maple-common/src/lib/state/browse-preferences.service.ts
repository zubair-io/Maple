// Browse preferences — the 9 user-facing UI prefs backed by localStorage.
//
// Lifted out of `library-store.service.ts` (ticket #191) so the data store
// only holds network/persistence-backed library data. These signals own:
//
//   - thumbSize           (grid density)
//   - sort + filter       (grid sort key + cull filter)
//   - sidebarVisible      (left-panel collapse)
//   - inspectorVisible    (right-panel collapse)
//   - activeTab           (info ↔ develop tab)
//   - viewMode            (folder ↔ timeline browse mode)
//   - sectionOpen         (sidebar section expand map)
//   - folderOpen          (sidebar folder expand map)
//
// All nine are persisted to `localStorage` under the legacy `cm.*` keys so
// existing users keep their preferences across the refactor. The store is
// the source of truth; signals are a sync layer.
//
// Ephemeral UI state (search query, modal-open flags, fetch-lifecycle
// banners) does NOT belong here — those move to component signals or the
// fetcher in follow-up tickets.

import { Injectable, signal } from '@angular/core';

export type SortKey = 'date' | 'name';
export type CullFilter = 'all' | 'picks' | '4stars';
export type DetailTab = 'info' | 'develop';
export type BrowseViewMode = 'folder' | 'timeline';

@Injectable({ providedIn: 'root' })
export class BrowsePreferencesService {
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
  readonly sort = signal<SortKey>(this._loadOrDefault('cm.sort', 'date') as SortKey);
  readonly filter = signal<CullFilter>(this._loadOrDefault('cm.filter', 'all') as CullFilter);

  // ── Panel visibility (persisted) ──────────────────────────────────────────
  readonly sidebarVisible = signal<boolean>(this._loadOrDefault('cm.leftHidden', false) === false);
  readonly inspectorVisible = signal<boolean>(
    this._loadOrDefault('cm.detailHidden', false) === false,
  );

  // ── Active detail tab ─────────────────────────────────────────────────────
  readonly activeTab = signal<DetailTab>(this._loadOrDefault('cm.tab', 'info') as DetailTab);

  // ── Browse-shell view mode (Folder vs Timeline) ──────────────────────────
  readonly viewMode = signal<BrowseViewMode>(
    // Guard against corrupted/manipulated storage — anything other than the
    // two valid modes falls back to 'folder'.
    (() => {
      const v = this._loadOrDefault<unknown>('cm.viewMode', 'folder');
      return v === 'timeline' ? 'timeline' : 'folder';
    })(),
  );

  setViewMode(mode: BrowseViewMode): void {
    this.viewMode.set(mode);
    try {
      localStorage.setItem('cm.viewMode', JSON.stringify(mode));
    } catch {
      /* noop */
    }
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
