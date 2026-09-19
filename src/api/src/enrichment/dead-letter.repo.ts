/**
 * Slow-tier enrichment dead-letter triage repo.
 *
 * Per `docs/indexer-enrichment.md` §3.3 + §7.2: when a slow-tier worker
 * (geocode today; face/describe in future) exhausts its retry budget it
 * stamps a dead-letter timestamp on the asset's row for that stage. The
 * worker's claim filter excludes those rows, so they stay stuck until an
 * operator clears the dead-letter via the routes built on top of these
 * functions.
 *
 * Storage lives in `db/repos/enrichment-state.repo.ts`. This module is
 * the domain surface the routes call: it owns the stage vocabulary, the limit
 * clamp and the error-class truncation length, and nothing else.
 */

import {
  clearDeadLetter,
  groupDeadLettered,
  listDeadLettered,
} from '../db/repos/enrichment-state.repo.ts';

/**
 * Stages that participate in the slow-tier enrichment loop. Mirrors
 * `Enrichment` in `db/schema.ts` and the `enrichment_state.stage` CHECK
 * constraint — keep these in sync. New stages added to the asset schema must
 * be added here too.
 */
export type EnrichmentStage = 'geocode' | 'face' | 'describe';

const STAGES: readonly EnrichmentStage[] = ['geocode', 'face', 'describe'];

/** Type-guard for runtime input (e.g. query strings). */
export function isEnrichmentStage(s: string): s is EnrichmentStage {
  return (STAGES as readonly string[]).includes(s);
}

/** One row of `listEnrichmentDeadLetter` output.
 *
 * `abs_path` is nullable because a row with no live location — or one whose
 * library is no longer registered — resolves to `null`. Those rows still
 * appear in the triage UI so an operator can clear them. */
export interface EnrichmentDeadLetterRow {
  asset_id: string;
  abs_path: string | null;
  last_error: string | null;
  attempts: number;
  dead_letter_at: string;
}

/** One row of `groupEnrichmentDeadLetter` output. */
export interface EnrichmentDeadLetterGroup {
  errorClass: string;
  count: number;
  latestTs: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
/** Keeps long
 * error messages with the same head from fragmenting the histogram. */
const ERROR_CLASS_LEN = 80;

/**
 * List dead-lettered assets for a stage, newest dead-letter first.
 *
 * Returns the small slice the triage UI actually needs (asset id, path,
 * error, attempt count, dead-letter timestamp) — not the whole asset row.
 */
export async function listEnrichmentDeadLetter(input: {
  stage: EnrichmentStage;
  limit?: number;
}): Promise<EnrichmentDeadLetterRow[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  return listDeadLettered(input.stage, limit);
}

/**
 * Cluster dead-letter rows by error message (truncated to 80 chars).
 *
 * Uses the historical dead-letter grouping shape — same
 * truncation length, same sort order (count desc, then latestTs desc) so
 * the triage UI behaves consistently between tiers.
 */
export async function groupEnrichmentDeadLetter(input: {
  stage: EnrichmentStage;
}): Promise<EnrichmentDeadLetterGroup[]> {
  return groupDeadLettered(input.stage, ERROR_CLASS_LEN);
}

/**
 * Clear the dead-letter (and the per-stage error/attempt counters) so the
 * next worker tick re-claims the row. A single statement so the three
 * fields flip atomically — there's no race window where the worker could
 * see no dead-letter but `attempts >= MAX_ATTEMPTS`.
 *
 * - `assetId` provided: targets that one asset.
 * - `assetId` omitted: resets every dead-lettered row for the stage.
 *
 * Other stages on the same asset are untouched.
 */
export async function resetEnrichmentDeadLetter(input: {
  stage: EnrichmentStage;
  assetId?: string;
}): Promise<{ resetCount: number }> {
  return { resetCount: await clearDeadLetter(input.stage, input.assetId) };
}
