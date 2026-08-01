// Selection + batch-metadata dialog state for `/search`.
//
// Split out of `search.component.ts` so that file stays inside the
// file-size budget (CONTRIBUTING.md § "File-size budget"). This is a plain
// controller object, not an Angular service: the state is per-instance page
// state with the same lifetime as the component, and injecting it would
// leak a stale selection across route visits.
//
// The component owns the result list and the error banner, so those two
// touchpoints come back through `SearchBatchMetaHost` rather than being
// duplicated here.

import { Signal, computed, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { AssetMetadataSnapshot, BatchMetadataService } from '@maple-common';

/** The slice of a search result this controller needs. */
export interface SelectableResult {
  id: string;
  /** `slug:relPath` address, or `null` when the asset's library has no
   * registered slug (see `SearchResult.address`). */
  address: string | null;
}

/** Callbacks back into the hosting search component. */
export interface SearchBatchMetaHost {
  /** Results currently loaded into the grid — the selection indexes into it. */
  loadedResults(): readonly SelectableResult[];
  /** Show a message in the page's error banner, or clear it with `null`. */
  setError(message: string | null): void;
  /** Re-run the search + facets after an edit lands. */
  refreshAfterEdit(): void;
}

export class SearchBatchMetaController {
  readonly selectedIds = signal<ReadonlySet<string>>(new Set<string>());
  readonly dialogVisible = signal(false);
  readonly assetSnapshots = signal<AssetMetadataSnapshot[]>([]);
  readonly selectedCount: Signal<number> = computed(() => this.selectedIds().size);

  /** In-flight `fetchSnapshots` subscription. Torn down on re-invocation and
   * on dismiss (mirrors `browse-shell.component.ts`) so a rapid double-click
   * can't race two fetches into `assetSnapshots`. */
  private fetchSub: Subscription | null = null;

  constructor(
    private readonly service: BatchMetadataService,
    private readonly host: SearchBatchMetaHost,
  ) {}

  toggleSelect(id: string): void {
    this.selectedIds.update((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  selectAllLoaded(): void {
    this.selectedIds.set(new Set(this.host.loadedResults().map((r) => r.id)));
  }

  clearSelection(): void {
    this.selectedIds.set(new Set<string>());
  }

  openDialog(): void {
    const ids = this.selectedIds();
    const selected = this.host.loadedResults().filter((r) => ids.has(r.id));
    const addresses = selected.map((r) => r.address).filter((a): a is string => a !== null);
    if (addresses.length === 0) return;

    // Assets whose library has no registered slug can't be resolved to a
    // batch-editable address (see the `address` field's doc comment on
    // SearchResult) — surface that they were silently excluded rather than
    // letting the user believe every selected result was edited.
    const skipped = selected.length - addresses.length;
    this.host.setError(
      skipped > 0
        ? `${skipped} selected result${skipped === 1 ? '' : 's'} could not be edited (unregistered library) and ${skipped === 1 ? 'was' : 'were'} skipped.`
        : null,
    );

    this.fetchSub?.unsubscribe();
    this.fetchSub = this.service.fetchSnapshots(addresses).subscribe({
      next: (snapshots) => {
        this.assetSnapshots.set(snapshots);
        this.dialogVisible.set(true);
      },
      error: () => {
        this.host.setError('Could not load metadata for the selected results.');
      },
    });
  }

  dismissDialog(): void {
    this.teardown();
    this.dialogVisible.set(false);
    this.assetSnapshots.set([]);
    this.clearSelection();
    this.host.refreshAfterEdit();
  }

  /** Cancel any in-flight fetch. Called from the component's `ngOnDestroy`. */
  teardown(): void {
    this.fetchSub?.unsubscribe();
    this.fetchSub = null;
  }
}
