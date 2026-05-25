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
  type ApiPerson,
  type ApiPersonDetail,
} from './bun-api-backend.service';
import type { Store, StoreStatus } from '../state/store';

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
    if (this._listInFlight) return;
    this._listInFlight = true;
    this._listLoading.set(true);
    this._listError.set(null);
    this.api.listPeople().subscribe({
      next: (rows) => {
        this._list.set(rows);
        this._listLoading.set(false);
        this._listInFlight = false;
      },
      error: (err: unknown) => {
        this._listError.set(err instanceof Error ? err : new Error(String(err)));
        this._listLoading.set(false);
        this._listInFlight = false;
      },
    });
  }

  // ── Detail cache (keyed by person id) ───────────────────────────────────────

  private readonly _activeDetailId = signal<string | null>(null);
  private readonly _details = signal<Map<string, ApiPersonDetail>>(new Map());
  /** Ids whose detail fetch is currently in flight. */
  private readonly _detailLoadingIds = signal<ReadonlySet<string>>(new Set());
  private readonly _detailError = signal<Error | null>(null);
  /** Imperative in-flight guard (mirrors `_listInFlight`) keyed by id. */
  private readonly _detailInFlight = new Set<string>();

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

  /**
   * Point the detail accessors at a person id (URL-driven). `null` clears the
   * active detail (back to the list). A cached id surfaces via `detail()`
   * synchronously while a background refresh validates; an uncached id fetches
   * (`detailLoading`). Idempotent for the same id — repeat calls dedupe.
   */
  setActiveDetailId(id: string | null): void {
    this._activeDetailId.set(id);
    this._detailError.set(null);
    if (id) this._fetchDetail(id);
  }

  /**
   * Force a re-fetch of a specific person's detail. Used after a mutation
   * touches that person (rename, bulk assign/hide on its faces) so the open
   * panel reflects server state. Keeps the cached value visible while the
   * refresh lands.
   */
  invalidateDetail(id: string): void {
    this._fetchDetail(id);
  }

  /** Drop a person's cached detail entirely — used after a delete so a later
   * visit to a recycled id can't serve a tombstone. */
  evictDetail(id: string): void {
    this._details.update((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }

  private _fetchDetail(id: string): void {
    if (this._detailInFlight.has(id)) return;
    this._detailInFlight.add(id);
    // Reset the error on every fetch start so a stale failure can't linger over
    // fresh data — matches `_fetchList`, which clears `_listError` up front, and
    // the `Store<T>` contract of resetting error on a successful re-fetch.
    this._detailError.set(null);
    this._detailLoadingIds.update((s) => new Set(s).add(id));
    this.api.getPerson(id).subscribe({
      next: (detail) => {
        this._details.update((m) => new Map(m).set(id, detail));
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
    if (this._hiddenInFlight) return;
    this._hiddenInFlight = true;
    this._hiddenLoading.set(true);
    this._hiddenError.set(null);
    this.api.listHiddenPeople().subscribe({
      next: (rows) => {
        this._hidden.set(rows);
        this._hiddenLoading.set(false);
        this._hiddenInFlight = false;
      },
      error: (err: unknown) => {
        this._hiddenError.set(err instanceof Error ? err : new Error(String(err)));
        this._hiddenLoading.set(false);
        this._hiddenInFlight = false;
      },
    });
  }

  // ── Mutation pass-throughs ──────────────────────────────────────────────────
  //
  // The store does not own most mutation endpoints (they live on
  // BunApiBackendService and the component drives the toast/UX flow), but it
  // exposes `await`-able hide/unhide helpers so the cache bookkeeping
  // (eviction + list invalidation) happens atomically with the mutation.

  /** Soft-hide a person server-side, then evict its cached detail and
   * invalidate BOTH lists so the person leaves the main list and appears on
   * the Hidden page immediately. Throws on failure so the caller can surface
   * an error toast. */
  async hidePerson(id: string): Promise<void> {
    await firstValueFrom(this.api.hidePerson(id));
    this.evictDetail(id);
    this.invalidate();
    this.invalidateHidden();
  }

  /** Restore a hidden person, then invalidate BOTH lists so it returns to the
   * main list and drops off the Hidden page. Throws on failure. */
  async unhidePerson(id: string): Promise<void> {
    await firstValueFrom(this.api.unhidePerson(id));
    this.evictDetail(id);
    this.invalidate();
    this.invalidateHidden();
  }
}
