/**
 * The video-scoped data migrations' own reads and writes — the SQLite port of
 * `workers/migration/backfill-video-exif.ts`,
 * `clear-video-screenshot-flags.ts` and the video-GPS backfill pair (#3787).
 *
 * The shared candidate machinery is in `./assets.migrations.ts`; what lives
 * here is the part each of these migrations does that no other one does.
 *
 * ## The screenshot clear is one transaction, and that removes an argument
 *
 * A video could pick up `is_screenshot` in two places — the top-level flag and
 * the stored vision payload's mirror of it — and the Mongo version had to clear
 * them with two `updateMany` calls whose *order* was load-bearing: a row
 * flagged only in the mirror, cleared by the first write, would match neither
 * arm of the candidate `$or` on a retry if the second write failed, stranding
 * it with the right flag and its describe and search stages never re-armed.
 * Both writes are one transaction here, so the gap the ordering defended
 * against does not exist and a failed batch is simply retried whole.
 *
 * ## The donor query is the one index-shaped query in this file
 *
 * {@link findGeoDonor} ranges over capture time among GPS-bearing assets, which
 * `assets_gps_captured` serves — a partial index over `gps_lat IS NOT NULL`
 * keyed on `(captured_at, gps_lat)`. The predicate is repeated verbatim in the
 * query because SQLite only uses a partial index when the query's own `WHERE`
 * provably implies the index's, and the implication test is textual enough that
 * a paraphrase silently turns this into a scan of the whole library per video.
 */

import type { ObjectId } from 'mongodb';
import type { AssetExif } from '../../schema.ts';
import {
  LIVE_GEO_VIDEO,
  LIVE_PHOTO_IN_LIBRARY,
  LIVE_VIDEO,
  stampMarker,
  type CandidateScope,
} from './assets.migrations.ts';
import { stageRearmBatchStatement } from './assets.stage-rearm.ts';
import { sqliteDb, type SqliteDb } from './db-handle.ts';
import { placeholders, toHex, toObjectId } from './values.ts';

export type { SqliteDb } from './db-handle.ts';

// ---------------------------------------------------------------------------
// backfill-video-exif
// ---------------------------------------------------------------------------

/** Backup-origin assets with a live video location. */
export const BACKUP_VIDEO_SCOPE: CandidateScope = {
  sql: `EXISTS (SELECT 1 FROM asset_phasset_links p WHERE p.asset_id = a.id) AND ${LIVE_VIDEO}`,
};

/** What the backfill writes once it has read a video's `moov` atoms. */
export interface VideoExifOutcome {
  exif: AssetExif | null;
  /** GPS recovered → geocode re-runs, resolves a place, and refile follows it. */
  rearmGeocode: boolean;
  /** Dated but placeless → make it a refile candidate for the `<year>/<MM>` path. */
  resetBackupLayout: boolean;
}

/**
 * Record a video's recovered metadata and stamp the done-marker.
 *
 * A processed asset is stamped even when its file carried no usable metadata,
 * so it drops out of the candidate set instead of head-of-line-blocking the
 * unsorted batch (#1519). That is why `exif: null` is a legitimate argument
 * here rather than a reason not to call.
 *
 * `backup_layout_version = 0` rather than NULL, matching the reset value the
 * Mongo version wrote: the refile migration's selector is "not stamped at the
 * current generation", which zero satisfies as plainly as an absent field, and
 * an explicit zero records that something deliberately re-entered the asset
 * into that backlog.
 */
export async function applyVideoExif(
  id: ObjectId,
  outcome: VideoExifOutcome,
  version: number,
  dbOverride?: SqliteDb,
): Promise<void> {
  const hex = toHex(id);
  const assignments = [
    'video_meta_version = ?',
    ...(outcome.exif === null ? [] : ['exif = json(?)']),
    ...(outcome.resetBackupLayout ? ['backup_layout_version = 0'] : []),
  ].join(', ');
  const params = [version, ...(outcome.exif === null ? [] : [JSON.stringify(outcome.exif)]), hex];
  await sqliteDb(dbOverride).transaction([
    { sql: `UPDATE assets SET ${assignments} WHERE id = ?`, params },
    ...(outcome.rearmGeocode ? [stageRearmBatchStatement([hex], 'geocode')] : []),
  ]);
}

/** Stamp the done-marker alone, for a candidate there is nothing to read from. */
export function stampVideoMetaVersion(
  id: ObjectId,
  version: number,
  dbOverride?: SqliteDb,
): Promise<number> {
  return stampMarker('video_meta_version', version, [id], dbOverride);
}

// ---------------------------------------------------------------------------
// clear-video-screenshot-flags
// ---------------------------------------------------------------------------

/**
 * Videos still carrying the screenshot flag, on the top-level column or in the
 * stored vision payload's mirror of it.
 *
 * `is_screenshot` is a stills-only concept (#2325); a flagged video drops out
 * of the Photos bucket of the Photos/Screenshots filter, and the describe
 * prompt's screenshot short-circuit also nulled its whole scene description.
 */
export const SCREENSHOT_VIDEO_SCOPE: CandidateScope = {
  sql: `${LIVE_VIDEO} AND (
    a.is_screenshot = 1
    OR EXISTS (SELECT 1 FROM asset_detail d
                WHERE d.asset_id = a.id AND json_extract(d.vision, '$.is_screenshot') = 1))`,
};

/**
 * Clear the flag on both of its homes, stamp the done-marker, and re-queue the
 * two stages whose stored output the flag corrupted.
 *
 * `describe` because the screenshot short-circuit nulled the whole scene
 * description on every flagged row, and a re-run is the only way those fields
 * come back; `meili` because the search index and its facet counts hold the
 * stale `true`. Deliberately not `thumb` / `preview` / `cf-thumb-sync`: the
 * derivatives are correct, and re-arming the mirror would re-upload every one
 * of these thumbnails to R2 for no benefit.
 *
 * The vision statement only touches rows that already carry the mirror. Writing
 * it unconditionally would fabricate `vision: { is_screenshot: false }` on every
 * row the filename heuristic flagged without describe ever running — a
 * malformed payload with no caption, which would then satisfy the "vision
 * exists" branch in `sidecar-metadata-index` and permanently shadow the
 * heuristic for that asset.
 */
export async function clearVideoScreenshotFlags(
  ids: readonly ObjectId[],
  version: number,
  dbOverride?: SqliteDb,
): Promise<number> {
  if (ids.length === 0) return 0;
  const hexes = ids.map(toHex);
  const list = placeholders(hexes.length);
  const results = await sqliteDb(dbOverride).transaction([
    {
      sql: `UPDATE asset_detail SET vision = json_set(vision, '$.is_screenshot', json('false'))
             WHERE asset_id IN (${list}) AND json_extract(vision, '$.is_screenshot') = 1`,
      params: hexes,
    },
    {
      sql: `UPDATE assets SET is_screenshot = 0, video_screenshot_clear_version = ?
             WHERE id IN (${list})`,
      params: [version, ...hexes],
    },
    stageRearmBatchStatement(hexes, 'describe'),
    stageRearmBatchStatement(hexes, 'meili'),
  ]);
  return results[1]?.changes ?? 0;
}

// ---------------------------------------------------------------------------
// audit / apply video geo backfill
// ---------------------------------------------------------------------------

/**
 * Live `.mp4`/`.mov` assets with no GPS and a usable capture timestamp.
 *
 * `captured_at IS NOT NULL` is the generated column's version of Mongo's
 * `$type: 'string'`, which was stricter than `$ne: null` on purpose: only a
 * real ISO timestamp may enter the candidate set, because the donor search
 * compares those timestamps as strings.
 */
const GEO_CANDIDATE_SCOPE: CandidateScope = {
  sql: `a.gps_lat IS NULL AND a.captured_at IS NOT NULL AND ${LIVE_GEO_VIDEO}`,
};

/** The apply pass additionally skips anything a previous batch gave up on. */
export const GEO_APPLY_SCOPE: CandidateScope = {
  sql: `${GEO_CANDIDATE_SCOPE.sql} AND a.geo_backfill_skipped IS NULL`,
};

/** The audit pass skips anything it has already recorded a verdict for. */
export const GEO_AUDIT_SCOPE: CandidateScope = {
  sql: `${GEO_CANDIDATE_SCOPE.sql} AND NOT EXISTS (
    SELECT 1 FROM video_geo_backfill_audit v WHERE v.asset_id = a.id)`,
};

/**
 * Videos excluded from the candidate set for want of a capture timestamp —
 * logged once per batch for visibility, never processed.
 */
export const GEO_NO_TIMESTAMP_SCOPE: CandidateScope = {
  sql: `a.gps_lat IS NULL AND a.captured_at IS NULL AND ${LIVE_GEO_VIDEO}`,
};

/** A photo whose coordinates a nearby video may borrow. */
export interface GeoDonor {
  id: ObjectId;
  maple_id: string | undefined;
  captured_at: string | null;
  gps: { lat: number; lng: number };
}

/**
 * Every ground-truth photo with GPS in the same library within `[lo, hi]`.
 *
 * "Ground truth" is two exclusions, both deliberate: an asset that already
 * carries inferred provenance is skipped so inferred GPS can never daisy-chain
 * video to video, and a video is skipped because a donor video's GPS is rare
 * and is not what the operator means by borrowing a location.
 *
 * Returns the whole window rather than picking a winner, because the caller
 * chooses by smallest absolute time delta and has to skip a candidate whose
 * timestamp will not parse — a decision that does not belong in SQL.
 */
export async function findGeoDonors(
  videoId: ObjectId,
  libraryId: ObjectId,
  lo: string,
  hi: string,
  dbOverride?: SqliteDb,
): Promise<GeoDonor[]> {
  const rows = await sqliteDb(dbOverride).read<{
    id: string;
    maple_id: string | null;
    captured_at: string | null;
    lat: number;
    lng: number;
  }>(
    `SELECT a.id, a.maple_id, a.captured_at, a.gps_lat AS lat, a.gps_lng AS lng
       FROM assets a
      WHERE a.gps_lat IS NOT NULL AND a.gps_lng IS NOT NULL
        AND a.captured_at >= ? AND a.captured_at <= ?
        AND a.id <> ?
        AND NOT EXISTS (SELECT 1 FROM asset_detail d
                         WHERE d.asset_id = a.id AND d.geo_inferred IS NOT NULL)
        AND ${LIVE_PHOTO_IN_LIBRARY}`,
    [lo, hi, toHex(videoId), toHex(libraryId)],
  );
  return rows.map((row) => ({
    id: toObjectId(row.id),
    maple_id: row.maple_id ?? undefined,
    captured_at: row.captured_at,
    gps: { lat: row.lat, lng: row.lng },
  }));
}

/** Why a video was taken out of the candidate set without a coordinate. */
export type GeoSkipReason = 'no-donor' | 'skip';

/** Park a video so it converges instead of head-of-line-blocking the queue. */
export async function setGeoBackfillSkipped(
  id: ObjectId,
  reason: GeoSkipReason,
  dbOverride?: SqliteDb,
): Promise<void> {
  await sqliteDb(dbOverride).write(`UPDATE assets SET geo_backfill_skipped = ? WHERE id = ?`, [
    reason,
    toHex(id),
  ]);
}

/** The provenance stamp a borrowed coordinate carries. */
export interface GeoProvenance {
  source: 'temporal-neighbor';
  donor_id: string;
  donor_delta_ms: number;
  at: string;
}

/**
 * Write a borrowed coordinate and everything that has to follow it.
 *
 * Three steps in one transaction, which is what the Mongo version's single
 * `updateOne` gave for free:
 *
 *  1. the coordinate itself, plus provenance so the write is auditable and a
 *     future EXIF re-parse cannot silently clobber it;
 *  2. `geocode` back to unprocessed, so the stage resolves a `place` for the
 *     newly-tagged video;
 *  3. `backup_layout_version` cleared, so `refile-backups` re-files the backup
 *     into `<year>/<place>` once that place exists. Cleared rather than stamped
 *     at a number, because production may carry a higher generation than this
 *     checkout knows about and an unset column is robust to that drift.
 */
export async function applyGeoBackfill(
  id: ObjectId,
  gps: { lat: number; lng: number },
  provenance: GeoProvenance,
  dbOverride?: SqliteDb,
): Promise<void> {
  const hex = toHex(id);
  await sqliteDb(dbOverride).transaction([
    {
      sql: `UPDATE assets
               SET exif = json_set(COALESCE(exif, '{}'), '$.gps', json(?)),
                   backup_layout_version = NULL
             WHERE id = ?`,
      params: [JSON.stringify(gps), hex],
    },
    {
      sql: `INSERT INTO asset_detail (asset_id, geo_inferred) VALUES (?, json(?))
            ON CONFLICT (asset_id) DO UPDATE SET geo_inferred = excluded.geo_inferred`,
      params: [hex, JSON.stringify(provenance)],
    },
    stageRearmBatchStatement([hex], 'geocode'),
  ]);
}
