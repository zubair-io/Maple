/**
 * A tick's worth of stage results, committed together (#3748).
 *
 * Handlers complete at different moments inside a dispatch pool, so the
 * statements each one produced (see `stage-writeback.ts`) accumulate here and
 * go to the writer as one `BEGIN IMMEDIATE`. That is where the single-writer
 * design pays off: the Mongo runner issues one `updateOne` per asset per event,
 * so a batch of 20 is 20 round trips and 20 independent commits.
 *
 * ## One asset's statements are a unit, and the buffer knows it
 *
 * Batching 20 assets into one transaction borrows a failure mode from Mongo's
 * independence: there, a rejected `updateOne` cost exactly one asset; here, an
 * unqualified all-or-nothing commit would cost all 20. And the ones it costs
 * are the assets whose handlers *succeeded* — their `attempts` stays at the
 * claim-time value, the lease expires, they are re-claimed and re-run, and
 * after `maxAttempts` laps they dead-letter as "worker aborted mid-handler"
 * having in fact completed every time.
 *
 * So the buffer keeps each result's statements as their own group. The happy
 * path is unchanged — one transaction for the whole tick. When that transaction
 * rejects, the groups are re-committed one at a time, which isolates the
 * offending result (a foreign-key violation from one bad `extra` statement, say)
 * and lets the other nineteen record what they did. Retrying is safe precisely
 * because the failed transaction was atomic: nothing from it landed.
 *
 * A group that fails on its own is dropped rather than re-queued, with its
 * error logged and returned. Its asset's lease will expire and the stage will
 * pick the asset up again, which is the same recovery Mongo has when an
 * `updateOne` fails — the alternative, a buffer that keeps a permanently
 * failing group forever, poisons every later flush in the process.
 */

import { child as childLogger } from '../../../log.ts';
import type { SqlStatement } from '../protocol.ts';
import { assetsDb, type SqliteDb } from './db-handle.ts';

const log = childLogger('sqlite:stage-writeback');

/** One result's statements, with the label its failure would be reported under. */
interface WritebackGroup {
  label: string;
  statements: readonly SqlStatement[];
}

/** A group the flush could not commit, even on its own. */
export interface FailedWriteback {
  /** What {@link StageWritebackBatch.record} was told this result was. */
  label: string;
  error: unknown;
}

/**
 * The results of one tick, flushed as one transaction.
 *
 * {@link StageWritebackBatch.flush} is safe to call more than once and on an
 * empty batch, so the runner can flush at a size threshold during a long tick
 * and again at the end without special-casing either.
 *
 * `maxStatements` is a threshold, not a hard cap: it decides when a further
 * result should go into the next transaction rather than this one. A single
 * result larger than it still commits whole and alone, deliberately — splitting
 * one asset's statements would break the property the batching exists for, that
 * a patch and the `invalidates` it implies land together or not at all.
 */
export class StageWritebackBatch {
  private pending: WritebackGroup[] = [];
  private statementCount = 0;

  constructor(
    private readonly db: SqliteDb = assetsDb(),
    private readonly maxStatements = 256,
  ) {}

  /**
   * Queue one result's statements, flushing first if they would not fit.
   *
   * `label` identifies the result in a failure report — the asset id at every
   * real call site.
   */
  async record(statements: readonly SqlStatement[], label = 'writeback'): Promise<void> {
    if (statements.length === 0) return;
    if (this.statementCount + statements.length > this.maxStatements) await this.flush();
    this.pending.push({ label, statements });
    this.statementCount += statements.length;
  }

  /** How many statements are waiting. Exposed for the runner's own logging. */
  get size(): number {
    return this.statementCount;
  }

  /**
   * Commit everything queued, and report the results that could not be
   * committed at all.
   *
   * The buffer is taken before the write and not put back: the whole-batch
   * transaction is atomic, so a rejection means nothing landed and the groups
   * can be retried individually right here. Whatever still fails after that is
   * returned rather than thrown, because the caller has nineteen successful
   * writebacks it must not lose to one asset's exception.
   */
  async flush(): Promise<FailedWriteback[]> {
    const groups = this.pending;
    this.pending = [];
    this.statementCount = 0;
    if (groups.length === 0) return [];

    const batched = await this.commit(groups.flatMap((group) => group.statements));
    if (batched === null) return [];
    log.warn(
      { results: groups.length, err: batched },
      'stage writeback batch rejected — retrying each result on its own',
    );
    return await this.commitIndividually(groups);
  }

  /** Commit one list, returning `null` on success or the error it rejected with. */
  private async commit(statements: readonly SqlStatement[]): Promise<unknown> {
    try {
      await this.db.transaction(statements);
      return null;
    } catch (err) {
      return err ?? new Error('stage writeback rejected without an error');
    }
  }

  /** Re-commit each group alone, so one bad result cannot cost the others. */
  private async commitIndividually(groups: readonly WritebackGroup[]): Promise<FailedWriteback[]> {
    const failed: FailedWriteback[] = [];
    for (const group of groups) {
      const err = await this.commit(group.statements);
      if (err === null) continue;
      failed.push({ label: group.label, error: err });
      log.error(
        { label: group.label, err },
        'stage writeback dropped — the asset will be re-claimed when its lease expires',
      );
    }
    return failed;
  }
}
