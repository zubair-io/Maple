/**
 * One import attempt's dealings with the engine: what a redelivery for a
 * finished import reports, how a running import keeps its heartbeat alive, and
 * when it has to stop.
 */

import type { ObjectId } from '../db/object-id.ts';
import { AttemptSuperseded, finishedRun, type RowAttempt } from '../temporal/activity-attempt.ts';
import type { RowRun } from '../temporal/row-workflow.ts';
import { getImport, isImportCancelRequested, type ClaimedImport } from './repo.ts';

export interface HeldImport {
  claim: ClaimedImport;
  attempt: RowAttempt;
  progress: { current: number; total: number };
}

export async function finishedImportRun(id: ObjectId): Promise<RowRun> {
  return finishedRun(`Import ${id.toHexString()}`, await getImport(id));
}

export function heartbeat(held: HeldImport): void {
  held.attempt.heartbeat({ ...held.progress });
}

/**
 * A single large movie copy reports nothing for minutes, so the engine's
 * heartbeat is sent on a timer rather than on file progress. Returns the
 * function that stops the timer.
 */
export function keepImportAlive(held: HeldImport, everyMs: number): () => void {
  const timer = setInterval(() => heartbeat(held), everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Asked between primaries. A paused or reset attempt stops for a later one and
 * leaves the row alone; a cancel made in Temporal or through the API ends the
 * import.
 */
export async function importStopRequested(held: HeldImport): Promise<boolean> {
  if (held.attempt.stopReason() === 'superseded') throw new AttemptSuperseded();
  // A cancel made in Temporal only arrives on a heartbeat reply.
  heartbeat(held);
  return held.attempt.stopReason() === 'cancel' || isImportCancelRequested(held.claim._id);
}
