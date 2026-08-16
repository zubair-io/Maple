// RecoveryListSlice — one SWR cache slice for a people recovery list.
//
// PeopleStore carries two structurally identical recovery lists — hidden
// (#2124) and excluded (#2894) — each needing the same signals
// (rows/loading/refreshing/error/status), the same in-flight guard, and the
// same dirty-refetch semantics. This class is that shape once; the store
// instantiates it twice with different fetchers (extracted in the #2897
// review round, which also took people.store.ts back under the file-size
// budget).
//
// Dirty-refetch contract: an `ensure()`/`invalidate()` call landing while a
// fetch is in flight marks the slice dirty, and the completion handler
// re-fetches once — so a post-mutation invalidation can't be swallowed by
// an earlier-started request (which would leave a recovery page showing
// stale membership).

import { computed, signal, type Signal } from '@angular/core';
import type { Observable } from 'rxjs';
import type { ApiPerson } from './bun-api-backend.service';
import type { StoreStatus } from '../state/store';

export class RecoveryListSlice {
  private readonly _rows = signal<ApiPerson[] | undefined>(undefined);
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<Error | null>(null);
  private inFlight = false;
  private dirty = false;

  constructor(private readonly fetchRows: () => Observable<ApiPerson[]>) {}

  /** The list, or undefined before the first fetch resolves. */
  readonly rows: Signal<ApiPerson[] | undefined> = this._rows.asReadonly();

  /** First fetch in flight (nothing cached to show). */
  readonly loading: Signal<boolean> = computed(() => this._loading() && this._rows() === undefined);

  /** Re-fetch in flight while a cached value is shown. */
  readonly refreshing: Signal<boolean> = computed(
    () => this._loading() && this._rows() !== undefined,
  );

  readonly error: Signal<Error | null> = this._error.asReadonly();

  readonly status: Signal<StoreStatus> = computed(() => {
    if (this._error()) return 'error';
    if (this.loading()) return 'loading';
    if (this.refreshing()) return 'refreshing';
    if (this._rows() !== undefined) return 'loaded';
    return 'idle';
  });

  /** SWR read: first call fetches; later calls serve cached + refresh.
   * Safe to call on every page entry. */
  ensure(): void {
    this.fetch();
  }

  /** Force a re-fetch (after a mutation). Keeps the cached value visible
   * while the refresh lands. */
  invalidate(): void {
    this.fetch();
  }

  private fetch(): void {
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    this.inFlight = true;
    this.dirty = false;
    this._loading.set(true);
    this._error.set(null);
    this.fetchRows().subscribe({
      next: (rows) => {
        this._rows.set(rows);
        this.settle();
      },
      error: (err: unknown) => {
        this._error.set(err instanceof Error ? err : new Error(String(err)));
        this.settle();
      },
    });
  }

  private settle(): void {
    this._loading.set(false);
    this.inFlight = false;
    if (this.dirty) this.fetch();
  }
}
