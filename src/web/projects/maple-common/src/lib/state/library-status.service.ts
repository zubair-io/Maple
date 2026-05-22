// Library status — async-status / data-loading signals for the Self-Hosted
// bootstrap and rescan flows.
//
// Lifted out of `library-store.service.ts` (ticket #191, slice 3) so the data
// store only holds library data + adjustment models, while transient
// async-lifecycle banners (loading / error / empty / rescan progress) live
// alongside each other in a single status surface.
//
// Owned signals:
//
//   - backendLoading      (true while listFolders / listAssets is in flight)
//   - backendError        (last backend error message, cleared on success)
//   - backendEmpty        (true when API returned zero folders)
//   - rescanStatus        (idle | running | done | error)
//   - rescanError         (last rescan error message)
//
// Writers: `LibraryFetch` flips these during `loadFolderTree`,
// `addLibraryFolder`, `rescanCurrentFolder`, and `openSelfHostedFolder`.
// Readers: browse-shell banners, asset-grid rescan button, library-state
// facade.
//
// The `status` computed collapses the three backend* flags into a single
// state token for consumers that just want the banner enum without
// re-deriving the precedence rules.
//
// Pure presentational state — no async work, no dependencies on the store
// or the fetcher. Moving these signals out of `LibraryStore` does NOT
// create a circular dependency: `LibraryFetch` already injects both the
// store and (now) this service.

import { Injectable, Signal, computed, signal } from '@angular/core';

export type RescanStatus = 'idle' | 'running' | 'done' | 'error';
export type BackendStatus = 'loading' | 'ready' | 'empty' | 'error';

@Injectable({ providedIn: 'root' })
export class LibraryStatusService {
  /** True while listFolders / listAssets is in flight (Self-Hosted only). */
  readonly backendLoading = signal<boolean>(false);
  /** Last backend error message, cleared on successful load. */
  readonly backendError = signal<string | null>(null);
  /** True when the API returned zero folders (index not configured yet). */
  readonly backendEmpty = signal<boolean>(false);

  /** Transient state for the "Rescan" button on the toolbar. */
  readonly rescanStatus = signal<RescanStatus>('idle');
  readonly rescanError = signal<string | null>(null);

  /**
   * Collapsed banner enum. Mirrors the precedence the browse-shell uses to
   * pick which banner to render:
   *   error  ── any backendError wins
   *   loading ─ while backendLoading is true
   *   empty  ── when the API returned no folders
   *   ready  ── default
   */
  readonly status: Signal<BackendStatus> = computed(() => {
    if (this.backendError()) return 'error';
    if (this.backendLoading()) return 'loading';
    if (this.backendEmpty()) return 'empty';
    return 'ready';
  });
}
