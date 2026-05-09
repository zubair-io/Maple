/**
 * Indexer-side Mongo accessors: dead-letter queue, etc.
 *
 * Callers go through this module so routes never talk to collections
 * directly (repository pattern).
 */

import type { Collection } from "mongodb";
import { getDb } from "../db/client.ts";
import type { Stage } from "./channel.ts";

export interface DeadLetterDoc {
  /** maple:id hex if available; otherwise abs_path. */
  key: string;
  stage: Stage;
  absPath: string;
  error: string;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
}

export async function deadLetterCollection(): Promise<Collection<DeadLetterDoc>> {
  const db = await getDb();
  return db.collection<DeadLetterDoc>("indexer_dead_letter");
}

export async function ensureIndexerIndexes(): Promise<void> {
  const coll = await deadLetterCollection();
  await coll.createIndex({ key: 1, stage: 1 }, { unique: true });
  await coll.createIndex({ lastFailedAt: -1 });
}

export async function recordDeadLetter(input: {
  key: string;
  stage: Stage;
  absPath: string;
  error: string;
  attempts: number;
}): Promise<void> {
  const coll = await deadLetterCollection();
  const now = new Date().toISOString();
  await coll.updateOne(
    { key: input.key, stage: input.stage },
    {
      $set: {
        absPath: input.absPath,
        error: input.error,
        attempts: input.attempts,
        lastFailedAt: now,
      },
      $setOnInsert: { firstFailedAt: now, stage: input.stage, key: input.key },
    },
    { upsert: true }
  );
}

export async function listDeadLetter(limit = 200): Promise<DeadLetterDoc[]> {
  const coll = await deadLetterCollection();
  return coll.find({}).sort({ lastFailedAt: -1 }).limit(limit).toArray();
}

/**
 * Paginated dead-letter list with optional `stage` and `errorPrefix` filters.
 * Sorted by `lastFailedAt` desc (most recent failure first). `errorPrefix`
 * is a literal prefix match (escaped before being fed to a regex).
 */
export async function filterDeadLetter(input: {
  stage?: Stage;
  errorPrefix?: string;
  limit?: number;
}): Promise<DeadLetterDoc[]> {
  const coll = await deadLetterCollection();
  const limit = Math.min(1000, Math.max(1, input.limit ?? 200));

  const filter: Record<string, unknown> = {};
  if (input.stage) filter.stage = input.stage;
  if (input.errorPrefix && input.errorPrefix.length > 0) {
    // Escape regex metacharacters so callers can pass plain strings like
    // "ENOENT:" or "/Users/riabuz/..." without surprises.
    const escaped = input.errorPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.error = { $regex: `^${escaped}` };
  }

  return coll.find(filter).sort({ lastFailedAt: -1 }).limit(limit).toArray();
}

/** One row of `groupDeadLetterByError` output. */
export interface DeadLetterGroup {
  stage: Stage;
  errorClass: string;
  count: number;
  latestTs: string;
}

/**
 * `$group` aggregation that clusters dead-letter rows by `stage` plus the
 * first 80 chars of `error`. Many failures with the same error message
 * collapse into one row, sorted by count desc. Used by the triage UI to
 * spot patterns in a sea of identical errors.
 */
export async function groupDeadLetterByError(): Promise<DeadLetterGroup[]> {
  const coll = await deadLetterCollection();
  const pipeline = [
    {
      $project: {
        stage: 1,
        errorClass: { $substrCP: ["$error", 0, 80] },
        lastFailedAt: 1,
      },
    },
    {
      $group: {
        _id: { stage: "$stage", errorClass: "$errorClass" },
        count: { $sum: 1 },
        latestTs: { $max: "$lastFailedAt" },
      },
    },
    {
      $project: {
        _id: 0,
        stage: "$_id.stage",
        errorClass: "$_id.errorClass",
        count: 1,
        latestTs: 1,
      },
    },
    { $sort: { count: -1, latestTs: -1 } },
  ];
  return coll.aggregate<DeadLetterGroup>(pipeline).toArray();
}

/**
 * Delete matching dead-letter rows so the watcher's next pass can re-attempt
 * them. Either filter is sufficient; both narrow further. Returns
 * `{ deletedCount }`. Refusing to call without filters is intentional —
 * an accidental "reset everything" is too easy to fire by mistake.
 */
export async function resetDeadLetter(input: {
  key?: string;
  stage?: Stage;
}): Promise<{ deletedCount: number }> {
  if (!input.key && !input.stage) {
    throw new Error("resetDeadLetter: must provide at least one of {key, stage}");
  }

  const coll = await deadLetterCollection();
  const filter: Record<string, unknown> = {};
  if (input.key) filter.key = input.key;
  if (input.stage) filter.stage = input.stage;

  const res = await coll.deleteMany(filter);
  return { deletedCount: res.deletedCount ?? 0 };
}
