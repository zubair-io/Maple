/**
 * One batch of a migration that has to work through its candidates one asset at
 * a time.
 *
 * These migrations cannot run a batch as a single transaction the way the
 * bookkeeping-only ones can (see `row-batch.ts`), because each asset involves
 * the filesystem and the things that go wrong go wrong per asset. Each of those
 * means something different, and getting them confused is how a migration
 * deletes or strands data:
 *
 *   - A library that is offline right now is not an error. The asset is left
 *     exactly as it is, unstamped, for a later tick once the mount is back — an
 *     unreachable mount looks identical to a deleted file, and acting on that
 *     reading would be acting on a guess.
 *   - A source file that has genuinely gone is not an error either, but it does
 *     get stamped, so a run of them cannot sit at the head of an unsorted batch
 *     and block everything behind it.
 *   - Only a transient failure counts as an error.
 *
 * What is shared, then, is the loop around those decisions: resolve the library
 * roots, fetch a batch of candidates, ask the migration what happened to each
 * one, and tally the answers. The offline-mount case gets one warning per batch
 * rather than one per asset, so that a fleet-wide stall in root resolution is
 * visible instead of masquerading as a clean "batch complete".
 */

import { listCandidates, type CandidateScope } from '../../db/repos/assets.migrations.ts';
import type { MigrationCandidate } from '../../db/repos/assets.migrations.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import type { Logger } from 'pino';
import type { MigrationBatchResult } from './types.ts';

/** What became of one candidate. */
export type CandidateOutcome =
  | 'processed' // handled and stamped — it will not come back
  | 'skipped-no-root' // its library is unresolved; nothing was touched
  | 'retry-later' // a concurrent change reverted the attempt; left unstamped
  | 'error'; // transient failure, left unstamped for the next tick

/** Library root by library id, as the migrations resolve an absolute path. */
export type LibraryRoots = ReadonlyMap<string, string>;

export interface CandidateBatch {
  scope: CandidateScope;
  batchSize: number;
  log: Logger;
  /** The once-per-batch warning when assets were left for an offline mount. */
  skippedWarning: string;
  /** What this migration does to a single candidate. */
  process: (libs: LibraryRoots, doc: MigrationCandidate) => Promise<CandidateOutcome>;
}

/** How many candidates ended in each outcome. */
type OutcomeTally = Record<CandidateOutcome, number>;

export async function runCandidateBatch(batch: CandidateBatch): Promise<MigrationBatchResult> {
  const libs = await loadLibraryRootsOrEmpty();
  const docs = await listCandidates(batch.scope, batch.batchSize);

  const tally: OutcomeTally = { processed: 0, 'skipped-no-root': 0, 'retry-later': 0, error: 0 };
  for (const doc of docs) {
    tally[await batch.process(libs, doc)]++;
  }

  if (tally['skipped-no-root'] > 0) {
    batch.log.warn(
      {
        skippedNoRoot: tally['skipped-no-root'],
        batchSize: docs.length,
        processed: tally.processed,
      },
      batch.skippedWarning,
    );
  }
  // Only 'processed' counts down `countRemaining`; the other three leave the
  // asset in the candidate set on purpose.
  return { processed: tally.processed, errors: tally.error };
}

/** `loadLibraryRoots()`, but never throws — a registry that cannot be read
 * degrades to "no roots known", so the batch skips and retries per asset
 * instead of failing whole. */
async function loadLibraryRootsOrEmpty(): Promise<LibraryRoots> {
  try {
    return await loadLibraryRoots();
  } catch {
    return new Map();
  }
}
