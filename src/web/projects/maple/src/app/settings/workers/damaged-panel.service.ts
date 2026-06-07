// DamagedPanelService — owns the "Damaged files" drawer state + actions for
// the Workers page. Extracted from WorkersComponent so that file stays under
// the 600-LOC budget; the drawer markup + styles remain in the component
// template (and its scoped scss), this just holds the signal and the API
// round-trips.
//
// Provided at the component level (not root) — the state is ephemeral UI for
// one page, so it lives and dies with the component instance.

import { Injectable, inject, signal } from '@angular/core';
import { type DamagedDoc, WorkersApiService, errorMessage } from '@maple-common';

/** Open-drawer state. `null` when the drawer is closed. `clearing` gates the
 * per-row + "clear all" buttons against double-submit. */
export interface DamagedDrawerState {
  items: DamagedDoc[];
  loading: boolean;
  error: string | null;
  clearing: boolean;
}

@Injectable()
export class DamagedPanelService {
  private readonly api = inject(WorkersApiService);

  /** Null when closed; the drawer state when open. */
  readonly drawer = signal<DamagedDrawerState | null>(null);

  /** Open the drawer and load the damaged-files list. */
  open(): void {
    this.drawer.set({ items: [], loading: true, error: null, clearing: false });
    this.api.listDamaged().subscribe({
      next: (res) =>
        this.drawer.update((cur) => (cur ? { ...cur, items: res.items, loading: false } : cur)),
      error: (err) =>
        this.drawer.update((cur) =>
          cur ? { ...cur, loading: false, error: errorMessage(err) } : cur,
        ),
    });
  }

  close(): void {
    this.drawer.set(null);
  }

  /** Clear the damaged tag for one asset (id given) or all (id omitted) and
   * re-queue. Re-lists on success so cleared rows drop out. */
  clear(id?: string): void {
    const cur = this.drawer();
    if (!cur || cur.clearing) return;
    this.drawer.set({ ...cur, clearing: true });
    this.api.clearDamaged(id).subscribe({
      next: () => this.open(),
      error: (err) =>
        this.drawer.update((c) => (c ? { ...c, clearing: false, error: errorMessage(err) } : c)),
    });
  }
}
