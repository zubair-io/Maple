/**
 * Persisted record of each library's most recent generated-search attempt — the
 * marker the daily schedule reads to decide whether today's pass is still owed
 * (#4602).
 *
 * One `app_settings` document keyed `generated_search_runs`, with one entry per
 * library under `libraries.<id>`. It lives apart from the `generated_search`
 * config document so an operator's settings save and a worker's run record
 * never touch the same row, and each library's entry is written by its own
 * dotted path so two libraries finishing together cannot drop each other.
 *
 * It must be persisted rather than held in memory: production restarts on
 * every deploy, and a restart has to know both that today's set already exists
 * (do nothing) and that today's last attempt failed an hour ago (wait out the
 * backoff instead of calling the model again at boot).
 */

import { patchAppSettings, readAppSettings } from '../../db/repos/app-settings.repo.ts';

const DOC_ID = 'generated_search_runs';

export type RunOutcome = 'running' | 'saved' | 'empty' | 'failed' | 'dry-run';
export type RunTrigger = 'schedule' | 'run-now';

export interface LibraryRunRecord {
  library_id: string;
  /** `YYYY-MM-DD` (UTC) the attempt targeted. */
  day: string;
  /** How many attempts have started for `day`, this one included. */
  attempts: number;
  started_at: string;
  finished_at: string | null;
  outcome: RunOutcome;
  saved: number;
  error: string | null;
  trigger: RunTrigger;
}

interface RunsDoc {
  libraries?: Record<string, LibraryRunRecord>;
}

export async function loadRunRecords(): Promise<ReadonlyMap<string, LibraryRunRecord>> {
  const doc = await readAppSettings<RunsDoc>(DOC_ID);
  return new Map(Object.entries(doc?.libraries ?? {}));
}

/** The most recently started attempt across every library, for Settings → Workers. */
export async function loadLatestRunRecord(): Promise<LibraryRunRecord | null> {
  const records = [...(await loadRunRecords()).values()];
  return records.reduce<LibraryRunRecord | null>(
    (latest, record) =>
      latest === null || record.started_at > latest.started_at ? record : latest,
    null,
  );
}

export async function saveRunRecord(record: LibraryRunRecord): Promise<void> {
  await patchAppSettings(DOC_ID, { [`libraries.${record.library_id}`]: record });
}
