/**
 * The daily schedule for the generated-search pass, keyed to the calendar day
 * rather than to process uptime (#4602).
 *
 * It used to be a 24-hour `setInterval` whose first pass landed one interval
 * after boot. Production restarts on every deploy, several times a day, so the
 * timer reset each time and the pass never came due — no set was produced for
 * ten days and nothing showed it.
 *
 * Now a short tick, plus one check shortly after boot, asks the database
 * whether each library still owes today's pass:
 *
 *   1. Today's set already exists in `generated_searches` → done. A restart on
 *      such a day does nothing, which keeps the old intent that a restart must
 *      not set off a fresh round of LLM calls.
 *   2. No attempt recorded for today → run it.
 *   3. An attempt today that failed or came up empty → retry after a backoff
 *      that doubles each time, and give up for the day after
 *      {@link MAX_ATTEMPTS_PER_DAY}.
 *   4. An attempt still marked running → leave it, unless the claim is old
 *      enough that its process must have died mid-pass.
 *
 * All of that reads persisted state (`run-state.repo.ts`), never memory, so a
 * restart picks up exactly where the last process left off.
 */

import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { librariesWithSetFor } from '../../db/repos/generated-searches.repo.ts';
import { child as childLogger } from '../../log.ts';
import { loadGeneratedSearchConfig, type GeneratedSearchConfig } from './config.repo.ts';
import { dayKey, runGeneratedSearchOnce, type RunOptions } from './run.ts';
import { loadRunRecords, type LibraryRunRecord } from './run-state.repo.ts';

const log = childLogger('generated-search');

const MINUTE_MS = 60_000;
export const TICK_MS = 15 * MINUTE_MS;
export const BOOT_DELAY_MS = 2 * MINUTE_MS;
export const RETRY_BASE_MS = 60 * MINUTE_MS;
export const MAX_ATTEMPTS_PER_DAY = 3;
/** A pass makes minutes of LLM calls; one claimed for longer than this died
 * with its process. */
export const STALE_RUNNING_MS = 2 * 60 * MINUTE_MS;

/** Delay before the next attempt after `attempts` unsuccessful ones today:
 * one hour, then two. */
export function retryDelayMs(attempts: number): number {
  return RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

function elapsedSince(iso: string, now: Date): number {
  return now.getTime() - Date.parse(iso);
}

/** Whether a library with a recorded attempt today still owes another one. */
function attemptIsOwed(
  record: LibraryRunRecord,
  config: GeneratedSearchConfig,
  now: Date,
): boolean {
  if (record.attempts >= MAX_ATTEMPTS_PER_DAY) return false;
  switch (record.outcome) {
    case 'saved':
      return false;
    case 'dry-run':
      // A dry run writes no set; once the operator turns dry run off, the
      // real pass for today is still owed.
      return !config.dry_run;
    case 'running':
      return elapsedSince(record.started_at, now) >= STALE_RUNNING_MS;
    case 'failed':
    case 'empty':
      return elapsedSince(record.started_at, now) >= retryDelayMs(record.attempts);
  }
}

/** The libraries whose pass for `dayKey(now)` is still owed. */
export async function librariesOwedToday(
  libraries: readonly string[],
  config: GeneratedSearchConfig,
  now: Date,
): Promise<string[]> {
  if (config.paused) return [];
  const day = dayKey(now);
  const [withSet, records] = await Promise.all([librariesWithSetFor(day), loadRunRecords()]);
  return libraries.filter((libraryId) => {
    if (withSet.has(libraryId)) return false;
    const record = records.get(libraryId);
    return record?.day !== day || attemptIsOwed(record, config, now);
  });
}

export interface ScheduleDeps {
  now: () => Date;
  listLibraries: () => Promise<readonly string[]>;
  runLibrary?: RunOptions['runLibrary'];
}

const defaultDeps: ScheduleDeps = {
  now: () => new Date(),
  listLibraries: async () => [...(await loadLibraryRoots()).keys()],
};

/**
 * One schedule check. Paused still goes through `runGeneratedSearchOnce`,
 * which prunes and returns without calling the model, so retention keeps
 * running while the job is off.
 */
export async function generatedSearchTick(deps: ScheduleDeps = defaultDeps): Promise<string[]> {
  const now = deps.now();
  const config = await loadGeneratedSearchConfig();
  if (config.paused) {
    await runGeneratedSearchOnce(now);
    return [];
  }
  const owed = await librariesOwedToday(await deps.listLibraries(), config, now);
  if (owed.length === 0) return [];
  const summary = await runGeneratedSearchOnce(now, {
    libraries: owed,
    trigger: 'schedule',
    clock: deps.now,
    runLibrary: deps.runLibrary,
  });
  log.info({ ...summary, day: dayKey(now) }, 'scheduled pass finished');
  return owed;
}

export interface GeneratedSearchHandle {
  stop(): void;
}

export interface ScheduleTiming {
  tickMs?: number;
  bootDelayMs?: number;
  tick?: () => Promise<unknown>;
}

/** Start the schedule. `maintenance.ts` owns the single instance. A tick that
 * lands while the previous one is still running is skipped, so a pass longer
 * than the tick never overlaps itself. */
export function startGeneratedSearch(timing: ScheduleTiming = {}): GeneratedSearchHandle {
  const tick = timing.tick ?? (() => generatedSearchTick());
  let inFlight = false;
  const check = (): void => {
    if (inFlight) return;
    inFlight = true;
    void tick()
      .catch((err: unknown) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'schedule check failed',
        );
      })
      .finally(() => {
        inFlight = false;
      });
  };
  const boot = setTimeout(check, timing.bootDelayMs ?? BOOT_DELAY_MS);
  const interval = setInterval(check, timing.tickMs ?? TICK_MS);
  // Neither timer should hold the process open on its own.
  boot.unref?.();
  interval.unref?.();
  return {
    stop(): void {
      clearTimeout(boot);
      clearInterval(interval);
    },
  };
}
