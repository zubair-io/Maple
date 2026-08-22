/**
 * Operator-triggered "Run now" for the generated-search job — the settings
 * page's answer to "I just enabled this, why is nothing happening?" (the
 * interval timer deliberately fires one full interval after boot, so the
 * first scheduled pass can be a day away).
 *
 * `runGeneratedSearchOnce` checks `paused` itself, which would defeat the
 * two things the button exists for: a first run right after enabling (config
 * may still be settling) and a dry run WHILE paused to evaluate the prompt
 * before enabling. So the trigger runs the per-library pass machinery with
 * the paused gate bypassed via `force`.
 *
 * One run at a time: an in-flight run makes minutes of LLM calls, and a
 * double-clicked button must be refused — two concurrent runs would write
 * duplicate collections for the same day. Same shape as
 * `derivative-audit/scan.ts`'s `startAuditPass`.
 */

import { child as childLogger } from '../../log.ts';
import { runGeneratedSearchOnce, type GeneratedSearchSummary } from './run.ts';

const log = childLogger('generated-search');

let inFlight = false;
let current: Promise<void> | null = null;
/** Test seam: the route calls `startRunNow()` with no args, so route tests
 * install a stub here rather than letting a real pass hit DB + Ollama. */
let runnerOverride: (() => Promise<GeneratedSearchSummary>) | null = null;

export interface RunNowResult {
  started: boolean;
  reason?: string;
}

/** Kick one pass in the background. Returns immediately; the settings page
 * sees the outcome as new collections (or their absence) on its next load. */
export function startRunNow(
  run: () => Promise<GeneratedSearchSummary> = runnerOverride ??
    (() => runGeneratedSearchOnce(new Date(), { force: true })),
): RunNowResult {
  if (inFlight) return { started: false, reason: 'already-running' };
  inFlight = true;
  current = run()
    .then((summary) => log.info({ ...summary }, 'run-now pass finished'))
    .catch((err: unknown) =>
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'run-now pass failed'),
    )
    .finally(() => {
      inFlight = false;
    });
  return { started: true };
}

export function _resetRunNowForTests(
  runner: (() => Promise<GeneratedSearchSummary>) | null = null,
): void {
  inFlight = false;
  current = null;
  runnerOverride = runner;
}

/** Test-only: settle the in-flight pass so a suite's teardown (which drops
 * the database) doesn't race a background run into a closed client. */
export async function _awaitRunNowForTests(): Promise<void> {
  await current;
}
