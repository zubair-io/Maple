// Browse preferences — the 9 user-facing UI prefs surfaced as signals.
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
// Each pref is seeded from `localStorage` (legacy `cm.*` keys, preserved
// across the refactor so existing users keep their preferences). The
// signals are the authoritative in-memory copy; write-back to localStorage
// lives in three places depending on the field:
//
//   * sidebar/inspector/section/folder/viewMode → explicit `setX` /
//     `toggleX` methods on this service write localStorage on each call.
//   * thumbSize/sort/filter → write-back lives in the components that own
//     those controls (`asset-grid.component.ts`) — they call
//     `TypedStorage.set(STORAGE_KEYS.<key>, …)` alongside `signal.set(…)`.
//   * activeTab → callers do `state.activeTab.set('develop')` directly, so
//     this service mirrors updates to `cm.tab` via an Angular `effect()`
//     (see constructor) without requiring a setter wrapper.
//
// Ephemeral UI state (search query, modal-open flags, fetch-lifecycle
// banners) does NOT belong here — those move to component signals or the
// fetcher in follow-up tickets.

import { Injectable, effect, signal } from '@angular/core';
import { STORAGE_KEYS, TypedStorage } from '../util/typed-storage';

export type SortKey = 'date' | 'name';
// `'edited'` added in responsive-program S2 (#623) to back the new
// Library-grid "Edited" filter chip. Older clients reading the new
// value fall through to `'all'` via the existing default.
export type CullFilter = 'all' | 'picks' | '4stars' | 'edited';
export type DetailTab = 'info' | 'develop';
export type BrowseViewMode = 'folder' | 'timeline' | 'map';

@Injectable({ providedIn: 'root' })
export class BrowsePreferencesService {
  // ── Sidebar open/collapsed state ───────────────────────────────────────────
  readonly sectionOpen = signal<Record<string, boolean>>(
    this._loadOrDefault(STORAGE_KEYS.SECTIONS, { folders: true, photos: true }),
  );

  readonly folderOpen = signal<Record<string, boolean>>(
    this._loadOrDefault(STORAGE_KEYS.FOLDER_OPEN, { 'f-2026': true }),
  );

  // ── Thumbnail size (grid density) ─────────────────────────────────────────
  readonly thumbSize = signal<number>(this._loadOrDefault(STORAGE_KEYS.THUMB_SIZE, 140) as number);

  // ── Sort + filter ─────────────────────────────────────────────────────────
  readonly sort = signal<SortKey>(this._loadOrDefault(STORAGE_KEYS.SORT, 'date') as SortKey);
  readonly filter = signal<CullFilter>(
    this._loadOrDefault(STORAGE_KEYS.FILTER, 'all') as CullFilter,
  );

  // ── Panel visibility (persisted) ──────────────────────────────────────────
  readonly sidebarVisible = signal<boolean>(
    this._loadOrDefault(STORAGE_KEYS.LEFT_HIDDEN, false) === false,
  );
  readonly inspectorVisible = signal<boolean>(
    this._loadOrDefault(STORAGE_KEYS.DETAIL_HIDDEN, false) === false,
  );

  // ── Active detail tab ─────────────────────────────────────────────────────
  readonly activeTab = signal<DetailTab>(
    this._loadOrDefault(STORAGE_KEYS.TAB, 'info') as DetailTab,
  );

  constructor() {
    // Persist activeTab on every change. Other prefs in this service write
    // localStorage from explicit setter methods (toggleSidebar, setViewMode,
    // …); activeTab is updated by callers via `state.activeTab.set(…)`
    // directly, so an `effect()` is the natural sync point. Field readers
    // get the seeded value from the signal init above; this effect fires
    // once on creation (writing back the seeded value, a no-op in the
    // common case) and on every subsequent `.set()`.
    effect(() => {
      TypedStorage.set(STORAGE_KEYS.TAB, this.activeTab());
    });
  }

  // ── Browse-shell view mode (Folder vs Timeline vs Map) ────────────────────
  readonly viewMode = signal<BrowseViewMode>(
    // Guard against corrupted/manipulated storage — anything other than the
    // three valid modes falls back to 'folder'.
    (() => {
      const v = this._loadOrDefault<unknown>(STORAGE_KEYS.VIEW_MODE, 'folder');
      return v === 'timeline' || v === 'map' ? v : 'folder';
    })(),
  );

  setViewMode(mode: BrowseViewMode): void {
    this.viewMode.set(mode);
    TypedStorage.set(STORAGE_KEYS.VIEW_MODE, mode);
  }

  // ── Panel toggles ──────────────────────────────────────────────────────────

  toggleSidebar(): void {
    this.sidebarVisible.update((v) => !v);
    TypedStorage.set(STORAGE_KEYS.LEFT_HIDDEN, !this.sidebarVisible());
  }

  toggleInspector(): void {
    this.inspectorVisible.update((v) => !v);
    TypedStorage.set(STORAGE_KEYS.DETAIL_HIDDEN, !this.inspectorVisible());
  }

  // ── Tree expand state ──────────────────────────────────────────────────────

  toggleSection(id: string): void {
    this.sectionOpen.update((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      TypedStorage.set(STORAGE_KEYS.SECTIONS, next);
      return next;
    });
  }

  setFolderOpen(id: string, open: boolean): void {
    this.folderOpen.update((prev) => {
      const next = { ...prev, [id]: open };
      TypedStorage.set(STORAGE_KEYS.FOLDER_OPEN, next);
      return next;
    });
  }

  // ── Persistence helpers ───────────────────────────────────────────────────

  private _loadOrDefault<T>(key: string, fallback: T): T {
    const loaded = TypedStorage.get<T>(key);
    return loaded != null ? loaded : fallback;
  }
}
