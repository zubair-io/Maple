/**
 * Slow-tier enrichment dead-letter triage repo.
 *
 * Per `docs/indexer-enrichment.md` §3.3 + §7.2: when a slow-tier worker
 * (geocode today; face/describe in future) exhausts its retry budget it
 * stamps `enrichment.<stage>.dead_letter_at = now` on the asset row. The
 * worker's claim filter excludes those rows, so they stay stuck until an
 * operator clears the dead-letter via the routes built on top of these
 * functions.
 *
 * This is intentionally a separate surface from the fast-pipeline
 * `indexer_dead_letter` collection (`src/indexer/indexer.repo.ts`). Slow-tier
 * dead letters live on the asset doc itself; fast-tier ones live in their
 * own collection. The two surfaces never overlap.
 */

import type { ObjectId } from "mongodb";
import { assetsCollection } from "../db/client.ts";

/**
 * Stages that participate in the slow-tier enrichment loop. Mirrors
 * `Enrichment` in `db/schema.ts` — keep these in sync. New stages added
 * to the asset schema must be added here too.
 */
export type EnrichmentStage = "geocode" | "face" | "describe";

const STAGES: readonly EnrichmentStage[] = ["geocode", "face", "describe"];

/** Type-guard for runtime input (e.g. query strings). */
export function isEnrichmentStage(s: string): s is EnrichmentStage {
  return (STAGES as readonly string[]).includes(s);
}

/** One row of `listEnrichmentDeadLetter` output. */
export interface EnrichmentDeadLetterRow {
  asset_id: string;
  abs_path: string;
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
/** Mirror of the fast-tier `groupDeadLetterByError` truncation. Keeps long
 * error messages with the same head from fragmenting the histogram. */
const ERROR_CLASS_LEN = 80;

function field(stage: EnrichmentStage, key: string): string {
  return `enrichment.${stage}.${key}`;
}

/**
 * List dead-lettered assets for a stage, newest dead-letter first.
 *
 * Returns the small slice the triage UI actually needs (asset id, path,
 * error, attempt count, dead-letter timestamp) — not the whole asset doc.
 */
export async function listEnrichmentDeadLetter(input: {
  stage: EnrichmentStage;
  limit?: number;
}): Promise<EnrichmentDeadLetterRow[]> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  const coll = await assetsCollection();
  const dlField = field(input.stage, "dead_letter_at");
  const cursor = coll
    .find(
      { [dlField]: { $ne: null } },
      {
        projection: {
          _id: 1,
          abs_path: 1,
          [`enrichment.${input.stage}`]: 1,
        },
      },
    )
    .sort({ [dlField]: -1 })
    .limit(limit);

  const docs = await cursor.toArray();
  return docs.map((d) => {
    const stageState = d.enrichment?.[input.stage];
    return {
      asset_id: d._id.toHexString(),
      abs_path: d.abs_path,
      last_error: stageState?.last_error ?? null,
      attempts: stageState?.attempts ?? 0,
      // Filter guarantees dead_letter_at is non-null; fall back to "" so
      // the type stays a string and downstream JSON encoding doesn't have
      // to think about it.
      dead_letter_at: stageState?.dead_letter_at ?? "",
    };
  });
}

/**
 * Cluster dead-letter rows by error message (truncated to 80 chars).
 *
 * Mirrors the fast-tier `groupDeadLetterByError` aggregation — same
 * truncation length, same sort order (count desc, then latestTs desc) so
 * the triage UI behaves consistently between tiers.
 */
export async function groupEnrichmentDeadLetter(input: {
  stage: EnrichmentStage;
}): Promise<EnrichmentDeadLetterGroup[]> {
  const coll = await assetsCollection();
  const dlField = field(input.stage, "dead_letter_at");
  const errField = field(input.stage, "last_error");

  const pipeline = [
    { $match: { [dlField]: { $ne: null } } },
    {
      $project: {
        // `$ifNull` so rows with `last_error: null` collapse into a single
        // bucket rather than crashing the $substrCP.
        errorClass: {
          $substrCP: [{ $ifNull: [`$${errField}`, ""] }, 0, ERROR_CLASS_LEN],
        },
        deadLetterAt: `$${dlField}`,
      },
    },
    {
      $group: {
        _id: "$errorClass",
        count: { $sum: 1 },
        latestTs: { $max: "$deadLetterAt" },
      },
    },
    {
      $project: {
        _id: 0,
        errorClass: "$_id",
        count: 1,
        latestTs: 1,
      },
    },
    { $sort: { count: -1, latestTs: -1 } },
  ];
  return coll
    .aggregate<EnrichmentDeadLetterGroup>(pipeline)
    .toArray();
}

/**
 * Clear the dead-letter (and the per-stage error/attempt counters) so the
 * next worker tick re-claims the row. Single `updateMany` so the three
 * fields flip atomically — there's no race window where the worker could
 * see `dead_letter_at: null` but `attempts >= MAX_ATTEMPTS`.
 *
 * - `assetId` provided: targets that one asset.
 * - `assetId` omitted: resets every dead-lettered row for the stage.
 *
 * Other stages on the same row are untouched.
 */
export async function resetEnrichmentDeadLetter(input: {
  stage: EnrichmentStage;
  assetId?: string;
}): Promise<{ resetCount: number }> {
  const coll = await assetsCollection();
  const dlField = field(input.stage, "dead_letter_at");

  // Always include the dead-letter filter — even when `assetId` is given,
  // we don't want to zero out an asset that isn't actually dead-lettered
  // (would clobber legitimate retry state on a row currently being processed).
  const filter: Record<string, unknown> = { [dlField]: { $ne: null } };
  if (input.assetId) {
    let oid: ObjectId;
    try {
      // Lazy import to avoid pulling ObjectId into the public surface; the
      // route layer passes us a hex string.
      const { ObjectId } = await import("mongodb");
      oid = new ObjectId(input.assetId);
    } catch {
      // Bad hex: nothing matches.
      return { resetCount: 0 };
    }
    filter._id = oid;
  }

  const update = {
    $set: {
      [dlField]: null,
      [field(input.stage, "last_error")]: null,
      [field(input.stage, "attempts")]: 0,
    },
  };

  const res = await coll.updateMany(filter, update);
  return { resetCount: res.modifiedCount ?? 0 };
}
