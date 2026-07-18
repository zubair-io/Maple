// PeopleStore — stale-while-revalidate cache for the `/settings/people` UI.
//
// The People page hits two endpoints on every navigation: `GET /people`
// (the full list — ~3 MB at ~15k clusters) and `GET /people/:id` (a single
// person's detail). Before this store, list → person → back re-downloaded
// the whole list and the detail re-fetched on every route-id change. This
// store interposes an in-memory SWR cache so the second-and-later read of an
// entry renders instantly from cache while a background refresh validates
// against the server.
//
// Pattern: mirrors `../xmp/sidecar.store.ts` (the house SWR shape) and the
// `Store<T>` contract in `../state/store.ts` — `data` / `loading` /
// `refreshing` / `error` / `status` signals plus an `invalidate()` entry
// point. The load-bearing distinction is `loading` (first fetch, nothing to
// show) vs `refreshing` (re-fetch with a cached value still on screen).
//
// Why RxJS-over-`BunApiBackendService` and not `httpResource` like
// SidecarStore: the API service already maps the wire's snake_case into the
// UI's camelCase `ApiPerson` / `ApiPersonDetail` shapes. Re-implementing that
// mapping against a raw `httpResource` would duplicate it and risk drift, so
// the store fetches through the service and layers SWR on top with signals.
//
// Persistence: in-memory only (session-scoped). The reported pain is
// in-session navigation churn — surviving a tab reload is not required, and
// IDB persistence here would be over-building for no user-visible win (the
// list is cheap to re-fetch once per session; the cost is doing it on every
// click). Detail entries are keyed by person id in a Map.
//
// Mutations (rename / assign / hide-face / hide-person / unhide / cluster)
// MUST NOT serve stale names or counts. The component routes its
// post-mutation refreshes through `invalidate()` / `invalidateDetail(id)` so
// the affected entries re-fetch instead of replaying a cached value.
//
// Hidden list: a SECOND SWR cache (mirroring the main-list shape) backs the
// Hidden page. Hiding/unhiding a person invalidates BOTH lists so the person
// moves between them without a stale frame.

import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  BunApiBackendService,
  type ApiMergeResult,
  type ApiPerson,
  type ApiPersonDetail,
  type ApiPersonFace,
} from './bun-api-backend.service';
import type { Store, StoreStatus } from '../state/store';

/**
 * Page size for the detail face grid's infinite scroll. Mirrors the API's
 * `FACE_DETAIL_LIMIT` default. Exported so tests can assert the exact
 * `getPerson(id, { offset, limit })` shape without hard-coding a magic number.
 */
export const DETAIL_FACE_PAGE_SIZE = 50;

/**
 * SWR cache for the People list + per-person detail. Implements
 * `Store<ApiPerson[]>` for the list; `detail*` accessors expose the same
 * signal shape keyed by person id.
 *
 * Wire-up (see `PeopleComponent`):
 *
 *     const store = inject(PeopleStore);
 *     store.ensureList();              // first call fetches, later calls SWR
 *     store.setActiveDetailId(id);     // route-driven; cached id renders now
 *     // template: store.data(), store.loading(), store.detail(), …
 */
@Injectable({ providedIn: 'root' })
export class PeopleStore implements Store<ApiPerson[]> {
  private readonly api = inject(BunApiBackendService);

  // ── List cache ────────────────────────────────────────────────────────────

  private readonly _list = signal<ApiPerson[] | undefined>(undefined);
  private readonly _listLoading = signal<boolean>(false);
  private readonly _listError = signal<Error | null>(null);
  /** Guards against overlapping list fetches (e.g. ensureList + invalidate). */
  private _listInFlight = false;
  /** Set when `ensureList`/`invalidate` is called during an in-flight fetch.
   * The completion handler re-fetches once so a post-mutation invalidation
   * can't be swallowed by an earlier-started request (which would leave the
   * People page showing stale membership). Mirrors `_hiddenDirty`. */
  private _listDirty = false;

  readonly data: Signal<ApiPerson[] | undefined> = this._list.asReadonly();

  readonly loading: Signal<boolean> = computed(
    () => this._listLoading() && this._list() === undefined,
  );

  readonly refreshing: Signal<boolean> = computed(
    () => this._listLoading() && this._list() !== undefined,
  );

  readonly error: Signal<Error | null> = this._listError.asReadonly();

  readonly status: Signal<StoreStatus> = computed(() => {
    if (this._listError()) return 'error';
    if (this.loading()) return 'loading';
    if (this.refreshing()) return 'refreshing';
    if (this._list() !== undefined) return 'loaded';
    return 'idle';
  });

  /**
   * SWR read of the list. First call (no cached value) fetches and flips
   * `loading`. Subsequent calls return immediately with the cached value on
   * screen and kick a background refresh (`refreshing`). Safe to call on every
   * page entry — the in-flight guard dedupes concurrent calls.
   */
  ensureList(): void {
    this._fetchList();
  }

  /**
   * Force a list re-fetch. Used after mutations that change membership or
   * counts (rename/merge, assign, hide, delete, run-clustering) so the list
   * never shows stale names or face counts. Keeps the cached value visible
   * while the refresh is in flight (`refreshing`, not `loading`).
   */
  invalidate(): void {
    this._fetchList();
  }

  private _fetchList(): void {
    if (this._listInFlight) {
      // A refresh is already running; remember the result is now stale so we
      // re-fetch once it lands instead of dropping this call. Mirrors _fetchHidden.
      this._listDirty = true;
      return;
    }
    this._listInFlight = true;
    this._listDirty = false;
    this._listLoading.set(true);
    this._listError.set(null);
    this.api.listPeople().subscribe({
      next: (rows) => {
        this._list.set(rows);
        this._listLoading.set(false);
        this._listInFlight = false;
        if (this._listDirty) this._fetchList();
      },
      error: (err: unknown) => {
        this._listError.set(err instanceof Error ? err : new Error(String(err)));
        this._listLoading.set(false);
        this._listInFlight = false;
        if (this._listDirty) this._fetchList();
      },
    });
  }

  // ── Detail cache (keyed by person id) ───────────────────────────────────────
  //
  // Detail entries accumulate face pages: the first fetch loads offset=0, and
  // subsequent `loadMoreFaces(id)` calls append the next page. Faces are
  // deduped by `assetId:faceIndex` so a race between a manual invalidation and
  // a loadMore never introduces duplicates. The "has more" flag tracks whether
  // the last page returned fewer faces than `limit`, signalling end-of-list.

  private readonly _activeDetailId = signal<string | null>(null);
  /** Accumulated detail (merged page metadata + accumulated faces) per person. */
  private readonly _details = signal<Map<string, ApiPersonDetail>>(new Map());
  /** Ids whose detail fetch is currently in flight. */
  private readonly _detailLoadingIds = signal<ReadonlySet<string>>(new Set());
  private readonly _detailError = signal<Error | null>(null);
  /** Imperative in-flight guard (mirrors `_listInFlight`) keyed by id. */
  private readonly _detailInFlight = new Set<string>();
  /** Ids whose detail was `invalidateDetail`'d while a fetch was in flight
   * (e.g. during a `loadMoreFaces` page>0 load). The in-flight fetch's
   * completion handler re-fetches page 0 once so the invalidation can't be
   * swallowed (mirrors `_listDirty` / `_hiddenDirty`). */
  private readonly _detailDirty = new Set<string>();
  /** Per-person "has more faces" flag. True until a page returns fewer faces than its limit. */
  private readonly _detailHasMore = signal<ReadonlyMap<string, boolean>>(new Map());

  /** The detail for the active id, or undefined if not loaded. */
  readonly detail: Signal<ApiPersonDetail | undefined> = computed(() => {
    const id = this._activeDetailId();
    if (!id) return undefined;
    return this._details().get(id);
  });

  /** First-fetch of the active detail in flight (nothing cached to show). */
  readonly detailLoading: Signal<boolean> = computed(() => {
    const id = this._activeDetailId();
    if (!id) return false;
    return this._detailLoadingIds().has(id) && !this._details().has(id);
  });

  /** Re-fetch of the active detail in flight while a cached value is shown. */
  readonly detailRefreshing: Signal<boolean> = computed(() => {
    const id = this._activeDetailId();
    if (!id) return false;
    return this._detailLoadingIds().has(id) && this._details().has(id);
  });

  readonly detailError: Signal<Error | null> = this._detailError.asReadonly();

  /** True when there are more face pages to load for the active person. */
  readonly detailHasMore: Signal<boolean> = computed(() => {
    const id = this._activeDetailId();
    if (!id) return false;
    return this._detailHasMore().get(id) ?? false;
  });

  /**
   * Point the detail accessors at a person id (URL-driven). `null` clears the
   * active detail (back to the list). A cached id surfaces via `detail()`
   * synchronously while a background refresh validates; an uncached id fetches
   * (`detailLoading`). Idempotent for the same id — repeat calls dedupe.
   */
  setActiveDetailId(id: string | null): void {
    this._activeDetailId.set(id);
    this._detailError.set(null);
    if (id) this._fetchDetail(id, 0);
  }

  /**
   * Force a re-fetch of a specific person's detail (resets to page 0).
   * Used after a mutation touches that person (rename, bulk assign/hide on its
   * faces) so the open panel reflects server state.
   *
   * SWR semantics: the cached value stays visible (`detailRefreshing`) while
   * the page-0 fetch is in flight; when it lands it REPLACES the entry whole
   * (the `offset === 0` branch in `_fetchDetail`), so accumulated face pages
   * reset cleanly without a flash of an empty grid. We deliberately do NOT
   * `evictDetail` here — that would blank the panel mid-refresh.
   *
   * Race guard: if a fetch is already in flight for this id (e.g. a
   * `loadMoreFaces` page>0 load), `_fetchDetail` would early-return and drop
   * this call, leaving stale detail. Mark the id dirty so the in-flight
   * fetch's completion re-fetches page 0 once (mirrors `_listDirty`).
   */
  invalidateDetail(id: string): void {
    if (this._detailInFlight.has(id)) {
      this._detailDirty.add(id);
      return;
    }
    this._fetchDetail(id, 0);
  }

  /**
   * Load the next page of faces for a person. No-op if a fetch is already in
   * flight or there are no more pages. Should be called when the face grid
   * scrolls near the bottom.
   */
  loadMoreFaces(id: string): void {
    if (this._detailInFlight.has(id)) return;
    const hasMore = this._detailHasMore().get(id) ?? false;
    if (!hasMore) return;
    const existing = this._details().get(id);
    const nextOffset = existing ? existing.faces.length : 0;
    this._fetchDetail(id, nextOffset);
  }

  /** Drop a person's cached detail entirely — used after a delete so a later
   * visit to a recycled id can't serve a tombstone. Also clears any pending
   * dirty flag so an in-flight fetch's completion won't resurrect the row. */
  evictDetail(id: string): void {
    this._detailDirty.delete(id);
    this._details.update((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.delete(id);
      return next;
    });
    this._detailHasMore.update((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }

  private _fetchDetail(id: string, offset: number): void {
    if (this._detailInFlight.has(id)) return;
    this._detailInFlight.add(id);
    // Reset the error on every fetch start so a stale failure can't linger over
    // fresh data — matches `_fetchList`, which clears `_listError` up front, and
    // the `Store<T>` contract of resetting error on a successful re-fetch.
    this._detailError.set(null);
    this._detailLoadingIds.update((s) => new Set(s).add(id));
    const pageSize = DETAIL_FACE_PAGE_SIZE;
    this.api.getPerson(id, { offset, limit: pageSize }).subscribe({
      next: (page) => {
        // A full page (>= the requested size) means there may be more; a short
        // page signals end-of-list. `page.limit` echoes the server's size but
        // falls back to the requested `pageSize` when absent.
        const hasMore = page.faces.length >= (page.limit ?? pageSize);
        this._detailHasMore.update((m) => new Map(m).set(id, hasMore));
        this._details.update((m) => {
          const existing = m.get(id);
          if (offset === 0 || !existing) {
            // First page (or invalidation reset): replace entirely.
            return new Map(m).set(id, page);
          }
          // Subsequent page: accumulate, deduping by assetId:faceIndex.
          const seen = new Set(existing.faces.map((f) => `${f.assetId}:${f.faceIndex}`));
          const newFaces: ApiPersonFace[] = page.faces.filter(
            (f) => !seen.has(`${f.assetId}:${f.faceIndex}`),
          );
          const merged: ApiPersonDetail = { ...existing, faces: [...existing.faces, ...newFaces] };
          return new Map(m).set(id, merged);
        });
        this._clearDetailLoading(id);
      },
      error: (err: unknown) => {
        this._detailError.set(err instanceof Error ? err : new Error(String(err)));
        this._clearDetailLoading(id);
      },
    });
  }

  private _clearDetailLoading(id: string): void {
    this._detailInFlight.delete(id);
    this._detailLoadingIds.update((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    // If an `invalidateDetail` arrived while this fetch was in flight, honour it
    // now with a fresh page-0 re-fetch (in-flight guard is already cleared
    // above). One re-fetch only — `_fetchDetail` clears nothing here, so a
    // single pending invalidation can't loop.
    if (this._detailDirty.has(id)) {
      this._detailDirty.delete(id);
      this._fetchDetail(id, 0);
    }
  }

  // ── Hidden-list cache (the Hidden page) ─────────────────────────────────────
  //
  // Same SWR shape as the main list — `hidden` / `hiddenLoading` /
  // `hiddenRefreshing` / `hiddenError` signals plus `ensureHidden()` /
  // `invalidateHidden()`. A separate in-flight guard so it never collides with
  // the main list. Hiding / unhiding a person invalidates both lists.

  private readonly _hidden = signal<ApiPerson[] | undefined>(undefined);
  private readonly _hiddenLoading = signal<boolean>(false);
  private readonly _hiddenError = signal<Error | null>(null);
  private _hiddenInFlight = false;
  /** Set when `ensureHidden`/`invalidateHidden` is called during an in-flight
   * fetch. The completion handler re-fetches once so a post-mutation
   * invalidation can't be swallowed by an earlier-started request (which
   * would leave the Hidden page showing stale membership). */
  private _hiddenDirty = false;

  /** The hidden-people list, or undefined before the first fetch resolves. */
  readonly hidden: Signal<ApiPerson[] | undefined> = this._hidden.asReadonly();

  /** First hidden-list fetch in flight (nothing cached to show). */
  readonly hiddenLoading: Signal<boolean> = computed(
    () => this._hiddenLoading() && this._hidden() === undefined,
  );

  /** Hidden-list re-fetch in flight while a cached value is shown. */
  readonly hiddenRefreshing: Signal<boolean> = computed(
    () => this._hiddenLoading() && this._hidden() !== undefined,
  );

  readonly hiddenError: Signal<Error | null> = this._hiddenError.asReadonly();

  readonly hiddenStatus: Signal<StoreStatus> = computed(() => {
    if (this._hiddenError()) return 'error';
    if (this.hiddenLoading()) return 'loading';
    if (this.hiddenRefreshing()) return 'refreshing';
    if (this._hidden() !== undefined) return 'loaded';
    return 'idle';
  });

  /** SWR read of the hidden list. First call fetches; later calls serve the
   * cached value and refresh in the background. Safe to call on every Hidden
   * page entry. */
  ensureHidden(): void {
    this._fetchHidden();
  }

  /** Force a hidden-list re-fetch (after hide / unhide). Keeps the cached
   * value visible while the refresh lands. */
  invalidateHidden(): void {
    this._fetchHidden();
  }

  private _fetchHidden(): void {
    if (this._hiddenInFlight) {
      // A refresh is already running; remember that the result is now stale
      // so we re-fetch once it lands instead of dropping this call.
      this._hiddenDirty = true;
      return;
    }
    this._hiddenInFlight = true;
    this._hiddenDirty = false;
    this._hiddenLoading.set(true);
    this._hiddenError.set(null);
    this.api.listHiddenPeople().subscribe({
      next: (rows) => {
        this._hidden.set(rows);
        this._hiddenLoading.set(false);
        this._hiddenInFlight = false;
        if (this._hiddenDirty) this._fetchHidden();
      },
      error: (err: unknown) => {
        this._hiddenError.set(err instanceof Error ? err : new Error(String(err)));
        this._hiddenLoading.set(false);
        this._hiddenInFlight = false;
        if (this._hiddenDirty) this._fetchHidden();
      },
    });
  }

  // ── Mutation pass-throughs ──────────────────────────────────────────────────
  //
  // The store does not own most mutation endpoints (they live on
  // BunApiBackendService and the component drives the toast/UX flow), but it
  // exposes `await`-able hide/unhide helpers so the cache bookkeeping
  // (eviction + list invalidation) happens atomically with the mutation.

  /** Evict the given details, then refresh BOTH the main and hidden lists
   * once. Shared by every people mutation that can move rows between the two
   * lists (hide / unhide / merge) so the cache bookkeeping lives in one place. */
  private _evictAndRefreshLists(ids: string[]): void {
    ids.forEach((id) => this.evictDetail(id));
    this.invalidate();
    this.invalidateHidden();
  }

  /** Soft-hide a person server-side, then evict + refresh both lists. Throws
   * on failure so the caller can surface an error toast. */
  async hidePerson(id: string): Promise<void> {
    await firstValueFrom(this.api.hidePerson(id));
    this._evictAndRefreshLists([id]);
  }

  /** Restore a hidden person, then evict + refresh both lists. Throws on failure. */
  async unhidePerson(id: string): Promise<void> {
    await firstValueFrom(this.api.unhidePerson(id));
    this._evictAndRefreshLists([id]);
  }

  /** Merge source people into a target (target survives). Evicts the now-
   * tombstoned sources, refreshes both lists, and refreshes the survivor's
   * detail. Throws on failure. Returns the survivor + counts for the toast. */
  async mergePeople(targetId: string, sourceIds: string[]): Promise<ApiMergeResult> {
    const result = await firstValueFrom(this.api.mergePeople(targetId, sourceIds));
    this._evictAndRefreshLists(sourceIds);
    this.invalidateDetail(targetId);
    return result;
  }

  /** Permanently dismiss a merge suggestion ("not the same person"). Evicts
   * the other person's cached detail (no refetch — it'll fetch fresh next
   * time it's opened) and refreshes this person's detail + the list, so the
   * banner/badge disappear immediately. Throws on failure so the caller can
   * surface an error toast. */
  async dismissMergeSuggestion(personId: string, otherId: string): Promise<void> {
    try {
      await firstValueFrom(this.api.dismissMergeSuggestion(personId, otherId));
    } catch (err) {
      // 404 means the suggestion is already stale server-side (changed or
      // cleared by a newer clustering run) — refetch the detail so the
      // stale banner converges instead of lingering behind the error toast.
      this.invalidateDetail(personId);
      throw err;
    }
    this.evictDetail(otherId);
    this.invalidateDetail(personId);
    this.invalidate();
  }

  /** Bulk soft-hide. Fans out the per-person hide in parallel (allSettled so a
   * single failure doesn't abort the batch), then evicts + refreshes both
   * lists once. Returns ok/failed counts for the toast. */
  async hidePeople(ids: string[]): Promise<{ ok: number; failed: number }> {
    const results = await Promise.allSettled(
      ids.map((id) => firstValueFrom(this.api.hidePerson(id))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    this._evictAndRefreshLists(ids);
    return { ok, failed: ids.length - ok };
  }

  /**
   * Set a face as the person's cover. Invalidates both the detail (to reflect
   * the new cover_asset_id / cover_bbox) and the list (so the card poster
   * updates). Throws on failure so the caller can surface an error toast.
   */
  async setPersonCover(personId: string, assetId: string, faceIndex: number): Promise<void> {
    await firstValueFrom(this.api.setPersonCover(personId, assetId, faceIndex));
    // Invalidate detail so cover_bbox + cover_asset_id refresh.
    this.invalidateDetail(personId);
    // Invalidate list so the people-card poster updates.
    this.invalidate();
  }
}
