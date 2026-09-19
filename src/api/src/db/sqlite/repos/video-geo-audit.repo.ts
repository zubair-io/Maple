/**
 * `video_geo_backfill_audit` — the SQLite port of the audit-table half of
 * `workers/migration/audit-video-geo-backfill.ts` (#3751).
 *
 * That migration is a report-only pass: for every live mp4/mov with no GPS and
 * a usable capture timestamp it finds the closest-in-time photo with GPS in the
 * same library and records the verdict, writing nothing to the asset itself.
 * Only the verdict table is ported here — the donor search runs against
 * `assets` and belongs to that table's repository.
 *
 * ## Keyed by the video, which is what makes the pass idempotent
 *
 * `asset_id` is the primary key, so re-running the migration overwrites a row
 * rather than appending a second verdict for the same video. That is the
 * property the Mongo version got from `replaceOne({ _id }, …, { upsert: true })`
 * and it survives as `INSERT … ON CONFLICT (asset_id) DO UPDATE`.
 *
 * {@link recordAuditDecision} therefore takes the id and the verdict as two
 * arguments, exactly as `replaceOne` took a filter and a replacement — both
 * call sites in the migration (the full verdict and the `skip` short-circuit)
 * build a body without an id and let the filter supply it.
 *
 * ## The donor's coordinates are two columns
 *
 * `AuditDoc` carries them as a `{ lat, lng }` pair because the asset document
 * does. They are stored as `donor_lat` / `donor_lng` so the operator review
 * query can range over them without parsing JSON, and the pair is reassembled
 * on the way out — present only when both columns are, since a half-recorded
 * coordinate is not a coordinate.
 */

import type { ObjectId } from '../../object-id.ts';
import type { AuditDoc } from '../../../workers/migration/audit-video-geo-backfill.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';
export type { AuditDoc };

/** One verdict, without the video id the caller supplies separately. */
export type AuditDecision = Omit<AuditDoc, '_id'>;

const UPSERT_SQL = `
  INSERT INTO video_geo_backfill_audit
    (asset_id, maple_id, captured_at, decision,
     donor_id, donor_maple_id, donor_lat, donor_lng, delta_ms, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (asset_id) DO UPDATE SET
    maple_id = excluded.maple_id,
    captured_at = excluded.captured_at,
    decision = excluded.decision,
    donor_id = excluded.donor_id,
    donor_maple_id = excluded.donor_maple_id,
    donor_lat = excluded.donor_lat,
    donor_lng = excluded.donor_lng,
    delta_ms = excluded.delta_ms,
    at = excluded.at`;

/**
 * Every video that already has a verdict.
 *
 * The migration subtracts these from its candidate set on each batch, so a
 * re-run resumes rather than starting over. `distinct('_id')` on Mongo; the
 * primary key column here, which is the same set by construction.
 */
export async function listAuditedAssetIds(dbOverride?: SqliteDb): Promise<ObjectId[]> {
  const rows = await sqliteDb(dbOverride).read<{ asset_id: string }>(
    `SELECT asset_id FROM video_geo_backfill_audit`,
  );
  return rows.map((row) => toObjectId(row.asset_id));
}

/**
 * How many verdicts have been recorded.
 *
 * The migration's `countRemaining` reports the work left, and on Mongo it
 * computes that by re-running the candidate filter over the audited ids —
 * `countDocuments(candidateFilter ∧ _id ∈ audited)` — because a `$in` of every
 * audited id was the only way to intersect the two sets. Here the audit table
 * is keyed by the video, so its row count is that intersection minus the videos
 * that have stopped being candidates, and "candidates minus rows" is the
 * subtraction the schema design record describes.
 */
export async function countAuditRows(dbOverride?: SqliteDb): Promise<number> {
  const rows = await sqliteDb(dbOverride).read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM video_geo_backfill_audit`,
  );
  return rows[0]?.n ?? 0;
}

/**
 * Record (or overwrite) one video's verdict. Idempotent on the video's id.
 */
export async function recordAuditDecision(
  assetId: ObjectId,
  decision: AuditDecision,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(UPSERT_SQL, [
    assetId.toHexString(),
    decision.maple_id ?? null,
    decision.captured_at,
    decision.decision,
    decision.donor_id?.toHexString() ?? null,
    decision.donor_maple_id ?? null,
    decision.donor_gps?.lat ?? null,
    decision.donor_gps?.lng ?? null,
    decision.delta_ms ?? null,
    decision.at,
  ]);
}
