/**
 * The contract every named migration implements. A migration is a one-shot,
 * library-wide transform owned by the `migration` worker (see
 * `workers/migration.ts`). Flipping its toggle on (per-migration `enabled`
 * state in `migration-config.repo.ts`) runs it batch-by-batch until
 * `countRemaining()` reaches 0, then it idles.
 *
 * Done-detection is count-based: the worker stops when nothing remains, never
 * off a stored counter — so a re-run after new data appears just resumes.
 */
export interface MigrationBatchResult {
  /** Items successfully transformed (moved / deduped) this batch. */
  processed: number;
  /** Items that errored this batch (logged, left in place for re-try). */
  errors: number;
  /** Optional authoritative completion signal for cursor-backed migrations. */
  complete?: boolean;
}

export class MigrationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationBlockedError';
  }
}

export interface Migration {
  /** Stable registry key — also the toggle key in `app_settings.migration`. */
  readonly id: string;
  /** Short UI label. */
  readonly title: string;
  /** UI blurb describing what the migration does. */
  readonly description: string;
  /** Optional fixed batch size for work whose throughput profile differs
   * materially from the generic file-I/O migrations. */
  readonly preferredBatchSize?: number;
  /** Cursor-backed migrations can self-report completion and avoid two full
   * count queries around every batch. */
  readonly selfReportsCompletion?: boolean;
  /** How many items still need transforming. Drives both the Workers-UI
   * "pending" count and done-detection (0 ⇒ done). Must be cheap (a count
   * query), not a full scan. */
  countRemaining(): Promise<number>;
  /** Optional live count of items parked in a migration-specific dead-letter
   * queue, distinct from the cumulative per-run `errors` counter (which never
   * decreases even after a row is redriven). Surfaced as `failedPermanently`
   * in the Workers panel row when a migration implements this. */
  countFailedPermanently?(): Promise<number>;
  /** Transform at most `batchSize` items. Returns per-batch progress. Must be
   * idempotent: a re-run over already-migrated items is a no-op. */
  runBatch(batchSize: number): Promise<MigrationBatchResult>;
}
