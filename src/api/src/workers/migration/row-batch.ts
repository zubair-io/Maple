/**
 * One batch of a migration that only ever touches database rows.
 *
 * Some migrations move no files and decode nothing: they clear a flag, re-arm a
 * stage, stamp a done-marker. Because there is no filesystem to half-succeed
 * against, the whole batch can be a single transaction — either every row in it
 * lands or none does, and a failure simply leaves the batch unstamped so the
 * next tick picks up exactly the same rows and tries again. Selecting the
 * batch, running that one transaction, counting what it changed and saying so
 * in the log is identical work whichever flag is being moved, so it lives here
 * and each migration supplies only the part that differs: the rows it wants and
 * the write it makes.
 *
 * The file-moving migrations deliberately do not use this. They have to treat
 * every asset separately, because one offline library root or one source file
 * that has gone missing must not take the rest of the batch down with it.
 */

import type { ObjectId } from '../../db/object-id.ts';
import { listCandidateIds, type CandidateScope } from '../../db/repos/assets.migrations.ts';
import type { Logger } from 'pino';
import type { MigrationBatchResult } from './types.ts';

/** What the migration writes for one batch of ids. Returns the number of rows
 * it actually modified, which is what the worker reports as progress — a row
 * that raced away between the select and the write is not counted. */
export type RowBatchWrite = (ids: readonly ObjectId[]) => Promise<number>;

/** What the batch says about itself in the log. Both lines are per-migration
 * prose, so each caller spells its own. */
export interface RowBatchMessages {
  /** Logged with the modified count after a batch lands. */
  done: string;
  /** Logged with the batch size when the transaction threw. */
  failed: string;
}

export async function runRowBatch(
  scope: CandidateScope,
  batchSize: number,
  log: Logger,
  messages: RowBatchMessages,
  write: RowBatchWrite,
): Promise<MigrationBatchResult> {
  const ids = await listCandidateIds(scope, batchSize);
  if (ids.length === 0) return { processed: 0, errors: 0 };

  try {
    const modified = await write(ids);
    log.info({ modified }, messages.done);
    return { processed: modified, errors: 0 };
  } catch (err) {
    // Left unstamped, so the next tick retries this same batch.
    log.error(
      { count: ids.length, err: err instanceof Error ? err.message : err },
      messages.failed,
    );
    return { processed: 0, errors: ids.length };
  }
}
