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

import { jsonPath, readAppSettings } from '../../db/repos/app-settings.repo.ts';
import { changesAt, matchedOne, sqliteDb } from '../../db/repos/db-handle.ts';
import { guardedInsertStatements } from '../../db/repos/generated-searches.repo.ts';
import type { GeneratedSearchInput } from './repo.ts';

const DOC_ID = 'generated_search_runs';

export type RunOutcome = 'running' | 'saved' | 'empty' | 'failed' | 'dry-run';
export type RunTrigger = 'schedule' | 'run-now';

export interface LibraryRunRecord {
  library_id: string;
  /** Identifies the pass holding this record; every later write is fenced on it. */
  claim_id: string;
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

/** A pass makes minutes of LLM calls; one claimed for longer than this died
 * with its process, and its claim may be taken over. */
export const STALE_RUNNING_MS = 2 * 60 * 60_000;

/**
 * Who may take a library's claim:
 * - `force` (Run now) wins unless another pass holds a live claim;
 * - `expectedStartedAt` (the schedule) also requires the record to be the one
 *   it read when it decided the pass was owed — `null` meaning it saw none —
 *   so a pass that started and finished in between cannot be repeated.
 */
export type ClaimMode = { force: true } | { force: false; expectedStartedAt: string | null };

/**
 * Atomically write `claim` (a `running` record) as the library's marker, or do
 * nothing. One upsert decides it inside SQLite's single writer, so of two
 * callers racing — Run now in the API process and the schedule in the worker
 * process — exactly one sees `true`; the in-process guards cannot do that
 * across processes.
 */
export async function claimLibraryRun(
  claim: LibraryRunRecord,
  mode: ClaimMode,
  now: Date,
): Promise<boolean> {
  const path = jsonPath(`libraries.${claim.library_id}`);
  const value = JSON.stringify(claim);
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_MS).toISOString();
  const casClause = mode.force ? '' : `AND json_extract(doc, ? || '.started_at') IS ?`;
  const casParams = mode.force ? [] : [path, mode.expectedStartedAt];
  const result = await sqliteDb().write(
    `INSERT INTO app_settings (id, doc) VALUES (?, json_set('{}', ?, json(?)))
     ON CONFLICT (id) DO UPDATE SET doc = json_set(doc, ?, json(?))
      WHERE NOT (json_extract(doc, ? || '.outcome') IS 'running'
                 AND json_extract(doc, ? || '.started_at') > ?)
        ${casClause}`,
    [DOC_ID, path, value, path, value, path, path, staleBefore, ...casParams],
  );
  return matchedOne(result.changes) === 1;
}

/**
 * Publish a claimed pass's result: its collections and its terminal record, in
 * one transaction where every write requires the stored marker to still carry
 * this pass's `claim_id`. A pass that ran past {@link STALE_RUNNING_MS} and was
 * taken over therefore writes nothing — no collections, no outcome, no
 * overwrite of the newer claim — and only the pass holding the claim counts.
 * Returns whether the claim was still held.
 */
export async function settleClaimedRun(
  terminal: LibraryRunRecord,
  collections: readonly GeneratedSearchInput[],
): Promise<boolean> {
  const path = jsonPath(`libraries.${terminal.library_id}`);
  const heldSql = `json_extract(doc, ? || '.claim_id') = ?`;
  const guard = {
    sql: `EXISTS (SELECT 1 FROM app_settings WHERE id = ? AND ${heldSql})`,
    params: [DOC_ID, path, terminal.claim_id],
  };
  const results = await sqliteDb().transaction([
    ...guardedInsertStatements(collections, guard),
    {
      sql: `UPDATE app_settings SET doc = json_set(doc, ?, json(?)) WHERE id = ? AND ${heldSql}`,
      params: [path, JSON.stringify(terminal), DOC_ID, path, terminal.claim_id],
    },
  ]);
  return matchedOne(changesAt(results, collections.length)) === 1;
}
