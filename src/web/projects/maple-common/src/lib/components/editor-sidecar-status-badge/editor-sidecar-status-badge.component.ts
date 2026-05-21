// EditorSidecarStatusBadge — slice 2 of N (Refs #193).
//
// First reactive consumer of `SidecarStore`. Demonstrates the canonical
// signal-based template + `setActiveId` lifecycle pattern established by
// slice 1 (PR #220) without disturbing the entangled bulk-hydration reader
// in `library-fetch.service._loadApiXmp` — which still needs unification of
// the local-AssetId vs API-id spaces before it can swap to the store. See
// the brief on issue #193.
//
// The badge slots into the editor detail panel and renders a tiny status
// chip for the focused asset's sidecar:
//
//   idle        → nothing
//   loading     → small spinner + "Loading sidecar…"
//   refreshing  → small spinner + "Refreshing sidecar…"
//   not-found   → "No sidecar"
//   loaded      → "Sidecar · ★N"  (rating from the store's parsed culling)
//   error       → "Error: <message>"
//
// On Hosted (FS Access) backends the store is a no-op by design — the badge
// renders nothing in that mode. Hosted writes continue to flow through
// `XmpStoreService` (the FS Access debounced writer); slice 1's brief left
// that out of scope.

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
} from '@angular/core';

import { LibraryStateService } from '../../state/library-state.service';
import { LibraryStore } from '../../state/library-store.service';
import { SidecarStore } from '../../xmp/sidecar.store';

@Component({
  selector: 'editor-sidecar-status-badge',
  standalone: true,
  templateUrl: './editor-sidecar-status-badge.component.html',
  styleUrl: './editor-sidecar-status-badge.component.scss',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EditorSidecarStatusBadgeComponent {
  private readonly state = inject(LibraryStateService);
  private readonly library = inject(LibraryStore);
  protected readonly store = inject(SidecarStore);

  /**
   * Resolved API id for the focused local AssetId.
   *
   * `library.apiAssetIds` is a plain `Map` (not a signal), so we re-evaluate
   * the lookup whenever `focusedAssetId` (a signal) changes — which is
   * exactly when a re-fetch is meaningful. The Map is populated during
   * folder hydration; by the time the editor has a focused asset, the entry
   * is in place. If it isn't (e.g. an FS-walk asset not yet round-tripped
   * through the API), we return `undefined` and the store stays idle.
   */
  protected readonly resolvedApiId = computed<string | undefined>(() => {
    const localId = this.state.focusedAssetId();
    if (!localId) return undefined;
    if (this.state.backend !== 'self-hosted') return undefined;
    return this.library.apiAssetIds.get(localId);
  });

  /** Hosted backends short-circuit; the store would no-op anyway, but
   *  filtering here lets the template render a clean "n/a" path. The
   *  injected token is a static value, not a signal — read it once. */
  protected readonly isSelfHosted = this.state.backend === 'self-hosted';

  constructor() {
    // Drive the store off the resolved API id. The store's own `setActiveId`
    // accepts a `Signal<AssetId | undefined>`, so we hand it the `computed`
    // directly — the store sets up its own effect to mirror it, and the
    // resource re-fetches when the id changes.
    this.store.setActiveId(this.resolvedApiId);

    // Defensive log on store-level errors. The template surfaces them too,
    // but keeping the console signal helps when the panel is collapsed.
    effect(() => {
      const err = this.store.error();
      if (err) console.warn('SidecarStore error', err);
    });
  }

  /** Rating from the parsed culling block, exposed for the template. */
  protected readonly rating = computed(() => this.store.data()?.culling.rating ?? null);

  /** Trimmed error message for the inline chip. */
  protected readonly errorMessage = computed(() => {
    const err = this.store.error();
    return err ? err.message || 'Unknown error' : '';
  });
}
