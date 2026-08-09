// TrashService — the concrete `TrashCapability` (#2652). Owns:
//   - per-library trash counts for the sidebar badge (`countByLibrary`)
//   - the Trash panel's open/closed state (`panelOpen` / `panelLibraryId` /
//     `panelLibraryLabel` — read directly, not through the capability
//     interface, by the Self-Hosted-only host that mounts
//     `TrashPanelComponent`; see `trash-capability.ts`'s module doc)
//   - the grid multi-select "send to Trash" queue (`trashAssets`)
//
// NOT injected directly by `asset-grid`/`folder-tree` — see
// `trash-capability.ts`'s module doc for why they depend on
// `TrashCapability`/`TRASH_CAPABILITY` instead, and why importing this
// class only from `provideSelfHostedWorkspace()` (and the Self Hosted app)
// is what keeps `TrashApiService`'s asset/folder routes out of Hosted's
// static bundle.

import { Injectable, inject, signal } from '@angular/core';
import { TrashApiService } from '../api/trash-api.service';
import { LibraryStateService } from '../state/library-state.service';
import type { AssetId } from '../models/asset';
import { errorMessage } from '../util/errors';
import type { TrashCapability } from './trash-capability';
import type {
  TrashAssetsSummary,
  TrashCount,
  TrashDeleteOutcome,
  TrashItemFailure,
} from './trash.types';

/** Page size for the sidebar-badge count fetch — large enough that most
 * libraries' trash fits in one page (an exact count), small enough to stay
 * a cheap request. Reuses the same `listTrash` the panel's first page
 * calls; not a dedicated count endpoint (none exists server-side). */
const COUNT_PAGE_SIZE = 100;

@Injectable({ providedIn: 'root' })
export class TrashService implements TrashCapability {
  private readonly api = inject(TrashApiService);
  private readonly state = inject(LibraryStateService);

  readonly available = signal(true);

  // ── Sidebar badge counts ────────────────────────────────────────────────

  private readonly counts = signal<Record<string, TrashCount>>({});
  readonly countByLibrary = this.counts.asReadonly();
  private readonly countsLoading = new Set<string>();

  ensureCountLoaded(libraryId: string): void {
    if (this.counts()[libraryId] !== undefined || this.countsLoading.has(libraryId)) return;
    this.countsLoading.add(libraryId);
    this.api.listTrash(libraryId, null, COUNT_PAGE_SIZE).subscribe({
      next: (page) => {
        this.countsLoading.delete(libraryId);
        this.counts.update((prev) => ({
          ...prev,
          [libraryId]: { count: page.items.length, capped: page.nextCursor !== null },
        }));
      },
      error: () => {
        this.countsLoading.delete(libraryId);
        // Leave uncounted — the badge just stays absent for this library
        // until something (a panel open, a mutation) retries.
      },
    });
  }

  /** Re-fetch a library's count after a mutation (restore/delete) changed
   * it — clears the cached value first so `ensureCountLoaded` doesn't treat
   * the stale entry as already-loaded. */
  private invalidateCount(libraryId: string): void {
    this.counts.update((prev) => {
      const { [libraryId]: _removed, ...rest } = prev;
      return rest;
    });
    this.ensureCountLoaded(libraryId);
  }

  // ── Panel state ──────────────────────────────────────────────────────────
  // Read directly by `self-hosted-browse-content.component.ts` — see the
  // file header.

  readonly panelOpen = signal(false);
  readonly panelLibraryId = signal<string | null>(null);
  readonly panelLibraryLabel = signal('');

  open(libraryId: string, libraryLabel: string): void {
    this.panelLibraryId.set(libraryId);
    this.panelLibraryLabel.set(libraryLabel);
    this.panelOpen.set(true);
  }

  closePanel(): void {
    this.panelOpen.set(false);
    this.panelLibraryId.set(null);
    this.panelLibraryLabel.set('');
  }

  /** Called by `TrashPanelComponent` after any mutation (restore, folder
   * restore, permanent delete) so the sidebar badge stays in sync with what
   * the panel just showed happening. */
  notifyLibraryMutated(libraryId: string): void {
    this.invalidateCount(libraryId);
  }

  // ── Grid multi-select "send to Trash" ───────────────────────────────────

  private readonly _busy = signal(false);
  readonly busy = this._busy.asReadonly();
  private readonly _resultSummary = signal<TrashAssetsSummary | null>(null);
  readonly resultSummary = this._resultSummary.asReadonly();

  trashAssets(assetIds: AssetId[], sourceFolderId: string): void {
    if (this._busy() || assetIds.length === 0) return;
    this._busy.set(true);
    this._resultSummary.set(null);
    const assetsById = new Map(
      this.state.assetsInSelectedFolder().map((asset) => [asset.id, asset]),
    );
    void this.runTrashQueue(assetIds, assetsById, sourceFolderId);
  }

  private async runTrashQueue(
    assetIds: AssetId[],
    assetsById: Map<AssetId, { id: AssetId; filename: string }>,
    sourceFolderId: string,
  ): Promise<void> {
    const failed: TrashItemFailure[] = [];
    let trashed = 0;
    for (const assetId of assetIds) {
      const filename = assetsById.get(assetId)?.filename ?? assetId;
      try {
        // `intent: 'trash'` (#2749) — this queue only ever means "send a
        // live asset to Trash." A 409 here means the asset was ALREADY
        // trashed by something else since the grid's listing was fetched;
        // that's the goal already achieved, not a failure, so it's
        // recorded as `alreadyTrashed` rather than lumped in with a real
        // network/server error.
        const outcome = await new Promise<TrashDeleteOutcome>((resolve, reject) => {
          this.api.deleteAsset(assetId, 'trash').subscribe({ next: resolve, error: reject });
        });
        if (outcome.kind === 'ok') {
          trashed += 1;
        } else {
          failed.push({
            assetId,
            filename,
            reason: 'Already in Trash — trashed by something else in the meantime.',
            alreadyTrashed: true,
          });
        }
      } catch (err) {
        failed.push({ assetId, filename, reason: errorMessage(err) });
      }
    }
    this._busy.set(false);
    this._resultSummary.set({ total: assetIds.length, trashed, failed });
    // Re-pull the source folder's listing regardless of outcome — covers
    // both the assets that trashed successfully AND the `alreadyTrashed`
    // conflicts, whose local view was already stale by definition.
    this.state.refreshFolderListing(sourceFolderId);
    // `currentRegisteredFolder()` reads off `selectedSourceId`, not the
    // `sourceFolderId` this batch trashed — correct in practice since a
    // grid multi-select trash always operates on whatever folder is
    // currently open, but if a future caller diverges this simply skips
    // the badge refresh rather than mis-attributing a count to the wrong
    // library.
    const library = this.state.currentRegisteredFolder();
    if (library) this.invalidateCount(library.id);
  }

  dismissSummary(): void {
    this._resultSummary.set(null);
  }
}
