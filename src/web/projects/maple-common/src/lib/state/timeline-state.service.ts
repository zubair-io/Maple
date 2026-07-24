// TimelineStateService — Timeline-mode-only filter signals + derived params.
//
// LibraryStateService already exposes selection, sidebar, and toolbar `searchQuery`
// (the search signal lives on LibrarySelection and is re-exported via the facade).
// This service holds the cull-axis filters that only apply when the user has
// flipped to Timeline view (rating, flag, color, date range), and derives a
// `params` object suitable for `SearchService.search` and `.buckets`.
//
// Rationale: keeps `LibraryStateService` from growing further with state that
// has no meaning in Folder mode, and lets the Timeline view bind directly to
// signals without round-tripping through the URL.
//
// `pathPrefix` is computed from `state.sidebarTree()` + `state.selectedSourceId()`
// so a click in the folder tree narrows the timeline scope without any extra
// wiring in the shell.
//
// All filter setters are no-deps imperative wrappers — bind them to the
// child filter row component's UI events.

import { Injectable, computed, inject, signal } from '@angular/core';
import { LibraryStateService } from './library-state.service';
import { SidebarEntry } from '../models/folder';
import { ApiFolder, BunApiBackendService } from '../api/bun-api-backend.service';
import { SearchParams } from '../api/search.service';
import { parseAddress } from '../addressing/maple-address';
import type { ColorLabelValue } from '../models/color-label';

export type TimelineFlag = '' | 'pick' | 'reject';
export type TimelineColor = '' | ColorLabelValue;

@Injectable({ providedIn: 'root' })
export class TimelineStateService {
  private readonly state = inject(LibraryStateService);
  private readonly api = inject(BunApiBackendService);

  constructor() {
    this.api.getDisplayConfig().subscribe({
      next: (config) => {
        if (config.show_hidden_images) {
          this.hiddenFilter.set('all');
        } else {
          this.hiddenFilter.set('none');
        }
      },
      error: () => {},
    });
  }

  // ── Filter signals (Timeline-only) ────────────────────────────────────────
  readonly minRating = signal<number>(0);
  readonly flag = signal<TimelineFlag>('');
  readonly color = signal<TimelineColor>('');
  readonly hiddenFilter = signal<'none' | 'all' | 'only'>('none');
  readonly from = signal<string>('');
  readonly to = signal<string>('');

  // ── Derived: address of the selected sidebar entry, if it's a folder ─────
  /**
   * Walks the sidebar tree to find the entry whose id === selectedSourceId
   * and, when it's a filesystem folder node, parses its id as a `slug:relPath`
   * MapleAddress (the canonical post-M2 addressing scheme — see
   * `../addressing/maple-address`). Node ids for non-folder kinds (smart
   * collections, albums, section headers) aren't guaranteed colon-free, so
   * the `kind === 'folder'` check guards against misparsing one as an address.
   *
   * Returns null when nothing is selected or the selected node isn't a
   * filesystem-backed folder — the Timeline view shows an empty state.
   */
  private readonly selectedFolderAddress = computed(() => {
    const id = this.state.selectedSourceId();
    if (!id) return null;
    const found = this._findEntry(this.state.sidebarTree(), id);
    if (!found || found.kind !== 'folder' || !id.includes(':')) return null;
    try {
      return parseAddress(id);
    } catch {
      return null;
    }
  });

  // ── Derived: registered library that owns the current selection ──────────
  /**
   * Matches the selected address's `slug` against the registered libraries
   * (falling back to `id` for pre-M1 servers with no `slug` field — the same
   * pattern used in `library-fetch.service.ts`). Returns null when nothing
   * filesystem-backed is selected or the library list hasn't loaded yet.
   */
  private readonly owningLibrary = computed<ApiFolder | null>(() => {
    const addr = this.selectedFolderAddress();
    if (!addr) return null;
    return (
      this.state.registeredFolders().find((f) => f.slug === addr.slug || f.id === addr.slug) ?? null
    );
  });

  // ── Derived: pathPrefix from selected sidebar entry ──────────────────────
  /**
   * Absolute filesystem path of the current selection, normalised with a
   * trailing slash so an anchored match against `PhotoVm.abs_path` doesn't
   * accidentally include sibling folders whose names share a prefix (e.g.
   * `/Lib/2026` matching `/Lib/2026-archive`). Reconstructed from the owning
   * library's absolute root path + the address's relative path, since
   * lazy-loaded subfolder nodes don't carry their own `absPath` (only
   * library roots do — `absPath` is a legacy field kept for other consumers).
   */
  readonly pathPrefix = computed<string | null>(() => {
    const addr = this.selectedFolderAddress();
    if (!addr) return null;
    const owning = this.owningLibrary();
    if (!owning) return null;
    const root = owning.path.replace(/\/+$/, '');
    const rel = addr.relPath.replace(/^\/+/, '').replace(/\/+$/, '');
    return rel.length > 0 ? `${root}/${rel}/` : `${root}/`;
  });

  // ── Derived: params bag for SearchService.search / .buckets ──────────────
  /**
   * Returns the params shape expected by `SearchService.buckets` (no
   * page/limit/sort) and the augmenting fields needed for `.search`. null
   * when there's no path scope to operate on, or the owning library isn't
   * known yet (the `registeredFolders` signal is a dependency, so this
   * recomputes — and the Timeline refreshes — the moment it loads).
   *
   * `pathPrefix` is sent RELATIVE to the owning library root because the
   * server anchors it against `fileinfo.path` (the per-asset directory
   * relative to the library root). Sending the absolute path here is the
   * bug that left every Timeline scope matching zero photos. `libraryId`
   * scopes the query to the owning library so a relative prefix like
   * `2026` can't accidentally match a same-named folder in another library.
   */
  readonly params = computed<Omit<SearchParams, 'page' | 'limit' | 'sort'> | null>(() => {
    const addr = this.selectedFolderAddress();
    if (!addr) return null;
    const owning = this.owningLibrary();
    if (!owning) return null;

    const rel = addr.relPath.replace(/^\/+/, '').replace(/\/+$/, '');

    const q = this.state.searchQuery().trim();
    const minR = this.minRating();
    const flag = this.flag();
    const color = this.color();
    const from = this.from();
    const to = this.to();
    const hidden = this.hiddenFilter();
    return {
      libraryId: owning.id,
      pathPrefix: rel.length > 0 ? rel : undefined,
      hasCapturedAt: true,
      q: q.length > 0 ? q : undefined,
      rating: minR > 0 ? minR : undefined,
      flag: flag === '' ? undefined : flag,
      color: color === '' ? undefined : color,
      from: from || undefined,
      to: to || undefined,
      hidden: hidden === 'none' ? undefined : hidden,
    };
  });

  // ── Filter mutations ──────────────────────────────────────────────────────
  setMinRating(n: number): void {
    this.minRating.set(n);
  }

  setFlag(v: TimelineFlag): void {
    this.flag.set(v);
  }

  setColor(v: TimelineColor): void {
    this.color.set(v);
  }

  setFrom(v: string): void {
    this.from.set(v);
  }

  setTo(v: string): void {
    this.to.set(v);
  }

  setHiddenFilter(v: 'none' | 'all' | 'only'): void {
    this.hiddenFilter.set(v);
  }

  clearAll(): void {
    this.minRating.set(0);
    this.flag.set('');
    this.color.set('');
    this.from.set('');
    this.to.set('');
    this.hiddenFilter.set('none');
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  private _findEntry(entries: SidebarEntry[], targetId: string): SidebarEntry | null {
    for (const e of entries) {
      if (e.id === targetId) return e;
      if (e.children) {
        const hit = this._findEntry(e.children, targetId);
        if (hit) return hit;
      }
    }
    return null;
  }
}
