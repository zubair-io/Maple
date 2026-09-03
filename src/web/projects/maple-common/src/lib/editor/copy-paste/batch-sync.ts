// Batch adjustment transfer: the orchestration contract (#2436).
//
// Paste-to-selection and Sync-settings used to be a bare `for` loop over the
// selection calling `updateAdjustment`. That is fine for five assets and
// wrong for two thousand: it blocks the frame for the whole run, shows no
// progress, cannot be cancelled, and — because nothing catches — a single
// asset that throws abandons every asset after it with no record of which
// ones were written and which were not.
//
// This module is the platform-neutral half of the fix: a pure async runner
// over a list of asset ids. No Angular, no signals, no DOM — the Angular
// service wraps it, and the same contract is what Apple's and the Self
// Hosted runner are expected to implement (m2-global-workflow.md § 4,
// decision 4: one shared contract, platform-native implementations).
//
// Three guarantees the loop it replaces did not make:
//
//   1. A failure is RECORDED, not swallowed and not fatal. The run continues
//      and the summary names every asset that failed and why.
//   2. Cancellation leaves exactly the assets processed so far modified —
//      nothing is rolled back, and nothing after the cancel point is touched.
//   3. The event loop is yielded to between chunks, so progress actually
//      paints and the tab stays interactive at 2,000 assets.

/** What one asset's transfer did. */
export type BatchOutcome = 'applied' | 'failed';

/** An asset the run could not write, with the reason it reports. */
export interface BatchFailure<Id> {
  id: Id;
  reason: string;
}

/** Live progress, emitted after each asset. */
export interface BatchProgress<Id> {
  /** Assets in the run. */
  total: number;
  /** Assets attempted so far — applied plus failed. */
  processed: number;
  /** Assets written successfully so far. */
  applied: number;
  /** Assets that failed so far. */
  failed: number;
  /** The asset just attempted. */
  current: Id;
  outcome: BatchOutcome;
}

/** The result of a finished (or cancelled) run. */
export interface BatchSummary<Id> {
  applied: readonly Id[];
  failed: readonly BatchFailure<Id>[];
  /** True when the run stopped early because cancellation was requested. */
  cancelled: boolean;
}

export interface BatchOptions<Id> {
  /** Called after every asset. */
  onProgress?: (progress: BatchProgress<Id>) => void;
  /** Polled before every asset; `true` stops the run where it stands. */
  isCancelled?: () => boolean;
  /**
   * Assets written between yields to the event loop. Larger is faster and
   * less responsive; 32 keeps a 2,000-asset run's longest uninterrupted
   * stretch well inside a frame on the reference hardware while costing
   * ~62 yields over the whole run.
   */
  chunkSize?: number;
  /** Yield primitive — injectable so tests run without real timers. */
  yieldToEventLoop?: () => Promise<void>;
}

export const DEFAULT_BATCH_CHUNK = 32;

/** Resolve on the next macrotask, so a paint can happen in between. */
function defaultYield(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Apply `write` to every id in `ids`, in order, reporting progress and
 * surviving per-asset failures.
 *
 * `write` may be sync or async; a throw (or rejection) marks that ONE asset
 * failed and the run continues. The returned summary is the authoritative
 * record of what happened — `retryFailed` below is what turns it back into a
 * second run over just the failures.
 */
export async function runBatchTransfer<Id>(
  ids: readonly Id[],
  write: (id: Id) => void | Promise<void>,
  options: BatchOptions<Id> = {},
): Promise<BatchSummary<Id>> {
  const {
    onProgress,
    isCancelled,
    chunkSize = DEFAULT_BATCH_CHUNK,
    yieldToEventLoop = defaultYield,
  } = options;
  const applied: Id[] = [];
  const failed: BatchFailure<Id>[] = [];
  const total = ids.length;

  for (const [index, id] of ids.entries()) {
    if (isCancelled?.()) {
      return { applied, failed, cancelled: true };
    }
    const outcome = await attempt(id, write, failed);
    if (outcome === 'applied') applied.push(id);
    onProgress?.({
      total,
      processed: index + 1,
      applied: applied.length,
      failed: failed.length,
      current: id,
      outcome,
    });
    // Yield on chunk boundaries only — one macrotask per asset would make a
    // 2,000-asset run 2,000 timer round trips slower for no added liveness.
    if ((index + 1) % chunkSize === 0 && index + 1 < total) {
      await yieldToEventLoop();
    }
  }
  return { applied, failed, cancelled: false };
}

/** Run `write` for one asset, recording rather than propagating a failure. */
async function attempt<Id>(
  id: Id,
  write: (id: Id) => void | Promise<void>,
  failed: BatchFailure<Id>[],
): Promise<BatchOutcome> {
  try {
    await write(id);
    return 'applied';
  } catch (err) {
    failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }
}

/** The ids a summary says to retry — the failures, in their original order. */
export function retryableIds<Id>(summary: BatchSummary<Id>): readonly Id[] {
  return summary.failed.map((f) => f.id);
}

/** One line of plain English for a finished run. */
export function batchSummaryText<Id>(summary: BatchSummary<Id>): string {
  const { applied, failed, cancelled } = summary;
  const head = cancelled
    ? `Cancelled — ${applied.length} of ${applied.length + failed.length} written`
    : `${applied.length} ${applied.length === 1 ? 'image' : 'images'} updated`;
  return failed.length === 0 ? head : `${head} · ${failed.length} failed`;
}
