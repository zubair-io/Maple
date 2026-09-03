// BatchSyncService — the Angular face of the batch transfer runner (#2436).
//
// Owns the one thing the pure runner deliberately does not: the live state a
// UI binds to. One run at a time (starting a second while one is in flight is
// refused rather than interleaved, so the progress row can never describe two
// runs at once), a cancel flag the runner polls, and the last summary — which
// is what "Retry failed" re-runs from.

import { Injectable, computed, inject, signal } from '@angular/core';
import { LibraryStateService } from '../../state/library-state.service';
import type { AssetId } from '../../models/asset';
import type { AdjustmentModel } from '../../models/adjustment-model';
import {
  type BatchProgress,
  type BatchSummary,
  batchSummaryText,
  retryableIds,
  runBatchTransfer,
} from './batch-sync';

@Injectable({ providedIn: 'root' })
export class BatchSyncService {
  private readonly library = inject(LibraryStateService);

  /** Live progress while a run is in flight; `null` when idle. */
  readonly progress = signal<BatchProgress<AssetId> | null>(null);

  /** The most recent finished run, kept so its failures can be retried. */
  readonly lastSummary = signal<BatchSummary<AssetId> | null>(null);

  private cancelRequested = false;
  private inFlight = false;

  /** True while a run is in flight. */
  readonly running = computed(() => this.progress() !== null);

  /** Percent complete, or `null` when idle. */
  readonly percent = computed<number | null>(() => {
    const p = this.progress();
    if (!p || p.total === 0) return null;
    return Math.round((p.processed / p.total) * 100);
  });

  /** One line describing the last finished run, or `null` before the first. */
  readonly summaryText = computed<string | null>(() => {
    const s = this.lastSummary();
    return s ? batchSummaryText(s) : null;
  });

  /** Assets the last run could not write — what `retryFailed` re-runs. */
  readonly failedIds = computed<readonly AssetId[]>(() => {
    const s = this.lastSummary();
    return s ? retryableIds(s) : [];
  });

  /**
   * Write `patch` onto every id in `ids`.
   *
   * Resolves with the summary, or `null` when a run is already in flight
   * (the caller's request is refused, not queued). A failure on one asset is
   * recorded and the run continues; cancelling stops it where it stands and
   * leaves everything written so far written.
   */
  async apply(
    ids: readonly AssetId[],
    patch: Partial<AdjustmentModel>,
  ): Promise<BatchSummary<AssetId> | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    this.cancelRequested = false;
    this.progress.set(null);
    try {
      const summary = await runBatchTransfer<AssetId>(
        ids,
        (id) => this.library.updateAdjustment(id, patch),
        {
          onProgress: (p) => this.progress.set(p),
          isCancelled: () => this.cancelRequested,
        },
      );
      this.lastSummary.set(summary);
      return summary;
    } finally {
      this.progress.set(null);
      this.inFlight = false;
    }
  }

  /** Re-run the last summary's failures with `patch`. */
  retryFailed(patch: Partial<AdjustmentModel>): Promise<BatchSummary<AssetId> | null> {
    const ids = this.failedIds();
    return ids.length === 0 ? Promise.resolve(null) : this.apply(ids, patch);
  }

  /** Ask the in-flight run to stop after the asset it is on. */
  cancel(): void {
    this.cancelRequested = true;
  }

  /** Clear the last summary — dismisses the result row. */
  dismissSummary(): void {
    this.lastSummary.set(null);
  }
}
