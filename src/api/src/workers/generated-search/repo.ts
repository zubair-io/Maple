/**
 * Persistence for `generated_searches` — the daily themed collections the
 * worker invents.
 *
 * This collection is the contract between the worker and its three consumers
 * (Settings → Workers, the Maple TV shelf, the Apple widget), which is why
 * the stored `query` is a plain param bag rather than a Mongo filter: it is
 * re-run through the same `buildFilter` as `/api/search` at read time, so the
 * server-forced constraints (`libraryId`, `excludeHiddenPeople`,
 * `isScreenshot`) are applied on every execution and can never be stale in
 * stored data.
 *
 * Timestamps are ISO strings, matching `exif.captured_at` and `deleted_at`
 * elsewhere in the schema — lexicographic comparison is safe for ISO 8601
 * with constant-width fields, and pruning uses the same `$lt` cutoff shape as
 * `trash-gc`.
 */

import type { ObjectId } from 'mongodb';
import { getDb } from '../../db/client.ts';
import type { GeneratedQuery } from './validate.ts';

const COLL = 'generated_searches';
const DAY_MS = 86_400_000;

/** A collection as written by the worker. */
export interface GeneratedSearchInput {
  library_id: string;
  /** Local day this run targeted, `YYYY-MM-DD`. */
  generated_for: string;
  /** ISO 8601 write time. */
  generated_at: string;
  /** Provenance — which model proposed it. */
  model: string;
  /** How many proposal rounds it took to clear the result floor. */
  attempts: number;
  theme: string;
  title: string;
  subtitle: string | null;
  query: GeneratedQuery;
  result_count: number;
  cover_asset_id: string | null;
}

export interface GeneratedSearchDoc extends GeneratedSearchInput {
  _id: ObjectId;
}

async function collection() {
  return (await getDb()).collection<GeneratedSearchInput>(COLL);
}

/** Persist one run's surviving collections. No-op on an empty list — a run
 * where every proposal missed the floor is a legitimate outcome. */
export async function saveGeneratedSearches(docs: readonly GeneratedSearchInput[]): Promise<void> {
  if (docs.length === 0) return;
  const coll = await collection();
  await coll.insertMany(docs as GeneratedSearchInput[]);
}

/**
 * One day's collections for a library. Omit `generatedFor` to get the most
 * recent day that produced anything — what every consumer wants by default,
 * and what keeps a widget showing yesterday's set rather than nothing when a
 * run is late or a day came up empty.
 */
export async function listGeneratedSearches(
  libraryId: string,
  generatedFor?: string,
): Promise<GeneratedSearchDoc[]> {
  const coll = await collection();
  const day =
    generatedFor ??
    (
      await coll.findOne(
        { library_id: libraryId },
        { sort: { generated_for: -1 }, projection: { generated_for: 1 } },
      )
    )?.generated_for;
  if (day === undefined) return [];

  return (await coll
    .find({ library_id: libraryId, generated_for: day })
    .toArray()) as GeneratedSearchDoc[];
}

/**
 * Drop collections older than the retention window. `now` is injected so the
 * test can pin it rather than sleep.
 */
export async function pruneGeneratedSearches(
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoffIso = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
  const coll = await collection();
  const result = await coll.deleteMany({ generated_at: { $lt: cutoffIso } });
  return result.deletedCount;
}
