/**
 * Operator-triggered "Run now" for the generated-search job — the settings
 * page's answer to "I just enabled this, why is nothing happening?" (the
 * schedule checks every 15 minutes and backs off after a failed attempt, so
 * the next scheduled pass can be an hour or more away).
 *
 * The route asks for a forced run of the `generated-search` maintenance task
 * and returns; the worker tier runs {@link runGeneratedSearchNow}.
 * `runGeneratedSearchOnce` checks `paused` itself, which would defeat the two
 * things the button exists for: a first run right after enabling and a dry run
 * WHILE paused to evaluate the prompt before enabling. So the run bypasses the
 * paused gate via `force`.
 *
 * One run at a time: a run makes minutes of LLM calls, and a double-clicked
 * button must be refused. {@link generatedSearchRunBusy} reads the request and
 * the per-library run records, so it sees a run whichever process started it;
 * the per-library claim (`claimLibraryRun`) is what finally keeps two passes
 * off one library.
 */

import { child as childLogger } from '../../log.ts';
import { maintenanceRunRequested } from '../maintenance/run-now.repo.ts';
import { runGeneratedSearchOnce } from './run.ts';
import { loadRunRecords, STALE_RUNNING_MS } from './run-state.repo.ts';

const log = childLogger('generated-search');

export const GENERATED_SEARCH_TASK = 'generated-search';

export async function runGeneratedSearchNow(signal?: AbortSignal): Promise<void> {
  const summary = await runGeneratedSearchOnce(new Date(), { force: true, signal });
  log.info({ ...summary }, 'run-now pass finished');
}

/** A requested run counts from the moment it is asked for; then while any library's pass holds a live claim. */
export async function generatedSearchRunBusy(now: Date = new Date()): Promise<boolean> {
  if (await maintenanceRunRequested(GENERATED_SEARCH_TASK)) return true;
  const records = [...(await loadRunRecords()).values()];
  return records.some(
    (record) =>
      record.outcome === 'running' &&
      now.getTime() - Date.parse(record.started_at) < STALE_RUNNING_MS,
  );
}
