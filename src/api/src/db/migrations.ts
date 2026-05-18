/**
 * Boot-time migration gate. The sentinel collection `migrations` records
 * one document per migration ID that has been applied to this database.
 * `ensureIndexes` uses this to skip expensive `updateMany` backfills on
 * every boot — once a migration is recorded, subsequent boots short-circuit.
 *
 * Why a dedicated collection (not server_state): keeps the migration log
 * inspectable on its own (`db.migrations.find()` is the operator answer to
 * "what's been applied?"), and the `_id` field carries the migration name
 * directly so the collection is self-documenting.
 *
 * Failure semantics: if `recordMigration` throws (rare — only on Mongo
 * outage between updateMany completion and the sentinel insert), the next
 * boot will re-run the backfill. That's idempotent for all three callers,
 * just wasteful — we accept the rare double-run to keep the design simple.
 */

import { getDb } from "./client.ts";

export type MigrationId =
  | "exif-captured-year-month-backfill"
  | "place-search-blob-backfill"
  | "asset-search-blob-backfill";

interface MigrationDoc {
  _id: MigrationId;
  appliedAt: Date;
  rows: number;
}

/** True when the migration has been recorded as applied. */
export async function migrationApplied(id: MigrationId): Promise<boolean> {
  const db = await getDb();
  // Cast: the TS driver insists `_id` be ObjectId for `Collection<T>` when
  // T._id isn't an ObjectId itself. The runtime query is fine — Mongo
  // happily matches on a string _id when one exists.
  const doc = await db
    .collection<MigrationDoc>("migrations")
    .findOne({ _id: id } as Parameters<
      ReturnType<typeof db.collection<MigrationDoc>>["findOne"]
    >[0]);
  return doc != null;
}

/** Records a migration as applied. Idempotent — duplicate inserts are swallowed. */
export async function recordMigration(
  id: MigrationId,
  rows: number,
): Promise<void> {
  const db = await getDb();
  try {
    await db.collection<MigrationDoc>("migrations").insertOne({
      _id: id,
      appliedAt: new Date(),
      rows,
    });
  } catch (err) {
    // E11000 duplicate key — another boot beat us to it. That's fine, the
    // sentinel is "did it ever run", not "how many times". Re-throw anything
    // else (auth failures, network errors).
    const code = (err as { code?: number } | null)?.code;
    if (code !== 11000) throw err;
  }
}
