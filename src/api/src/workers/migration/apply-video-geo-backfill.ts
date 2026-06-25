/**
 * Migration: "apply-video-geo-backfill" — applies inferred GPS coordinates to
 * live mp4/mov assets that have no GPS but have a temporally-nearby photo donor.
 *
 * For each candidate the migration:
 *   1. Sets `exif.gps` to the donor's GPS coordinates.
 *   2. Sets `geo_inferred` (top-level provenance) so the write is auditable and
 *      a future exif re-parse inside `exif.gps` can't silently clobber it.
 *   3. Resets `stages.geocode` to version 0 so the geocode stage re-runs and
 *      resolves `place` for the newly-GPS-tagged video.
 *   4. Unsets `backup_layout_version` so `refile-backups` re-files the backup
 *      into `<year>/<place>` once geocode has resolved the place. The field is
 *      UNSET (not stamped to a number) because production may carry a higher
 *      version than this checkout knows about; unsetting is robust to that drift.
 *
 * Idempotency: setting `exif.gps` removes the document from the `exif.gps: null`
 * candidate filter, so a second runBatch is a no-op for already-applied rows.
 * For the rare no-donor case a sentinel `geo_backfill_skipped: 'no-donor'` is set
 * so the document is excluded from future batches and cannot block the queue.
 *
 * Operator runbook (ordering matters):
 *   1. Enable `apply-video-geo-backfill` and let it drain.
 *   2. Ensure the geocode worker is enabled and let it drain — `place` must resolve
 *      BEFORE refile-backups runs, or the video files into the placeless fallback
 *      folder and refile-backups stamps it done (frozen in the wrong path).
 *   3. Only then let `refile-backups` run.
 *   A possible future refinement is a place-gated unfreeze migration that un-stamps
 *   backup_layout_version once place resolves, removing the manual ordering dependency.
 *
 * Spec: GitHub issue #1529.
 */

import type { Filter } from 'mongodb';
import { assetsCollection } from '../../db/client.ts';
import type { AssetDoc } from '../../db/schema.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { child as childLogger } from '../../log.ts';
import type { Migration, MigrationBatchResult } from './types.ts';
import { findDonor } from './audit-video-geo-backfill.ts';

const log = childLogger('migration:geo-backfill');

/**
 * Candidate filter: live mp4/mov, no GPS, has a captured_at timestamp, and has
 * not been marked with the no-donor sentinel from a previous batch.
 *
 * The $elemMatch combines `filename` and liveness on the SAME fileinfo entry.
 */
function candidateFilter(): Filter<AssetDoc> {
  return {
    'exif.gps': null,
    // `$type: 'string'` excludes null, missing, and non-string values so only a
    // real ISO timestamp can enter the candidate set (matches the audit pass).
    'exif.captured_at': { $type: 'string' },
    geo_backfill_skipped: { $exists: false },
    fileinfo: {
      $elemMatch: {
        filename: { $regex: /\.(mp4|mov)$/i },
        deleted_at: { $in: [null] },
        missing_since: { $in: [null] },
      },
    },
  } as Filter<AssetDoc>;
}

export const applyVideoGeoBackfill: Migration = {
  id: 'apply-video-geo-backfill',
  title: 'Apply: video GPS backfill from temporal neighbours',
  description:
    'Applies inferred GPS to live mp4/mov assets with no GPS by borrowing the location ' +
    'of the closest-in-time photo (within ±15 min, same library). Each match triggers ' +
    'the 3-step re-trigger: set exif.gps + geo_inferred provenance, reset stages.geocode ' +
    'so geocode re-runs, and unset backup_layout_version so refile-backups re-files the ' +
    'backup into <year>/<place> once geocode resolves. Enable ONLY after reviewing the ' +
    '`audit-video-geo-backfill` audit collection. Operator runbook: (1) enable this ' +
    'migration and let it drain; (2) ensure geocode worker is enabled and let it drain ' +
    'so `place` resolves; (3) only then let refile-backups run. Out-of-order execution ' +
    'freezes videos in the placeless fallback folder.',

  async countRemaining(): Promise<number> {
    const assets = await assetsCollection();
    return assets.countDocuments(candidateFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const assets = await assetsCollection();

    const docs = await assets
      .find(candidateFilter(), {
        projection: {
          _id: 1,
          maple_id: 1,
          fileinfo: 1,
          'exif.captured_at': 1,
        },
      })
      .limit(batchSize)
      .toArray();

    let processed = 0;
    let errors = 0;

    for (const doc of docs) {
      try {
        const capturedAt = doc.exif?.captured_at;
        const primary = assetPrimaryFileInfo(doc);

        // The candidate filter should guarantee both; if either is missing (e.g.
        // an empty-string timestamp, or no live fileinfo entry) set the sentinel
        // so the doc converges instead of head-of-line-blocking the queue (#1519).
        if (!capturedAt || !primary) {
          await assets.updateOne({ _id: doc._id }, { $set: { geo_backfill_skipped: 'skip' } });
          log.warn(
            { video_id: String(doc._id), maple_id: doc.maple_id },
            'apply: missing captured_at or live fileinfo — set geo_backfill_skipped sentinel',
          );
          processed++;
          continue;
        }

        const libraryId = primary.library_id;
        const result = await findDonor(assets, doc._id, capturedAt, libraryId);

        if (!result) {
          // No donor found. Set sentinel so this video can't block the queue.
          await assets.updateOne({ _id: doc._id }, { $set: { geo_backfill_skipped: 'no-donor' } });
          log.warn(
            { video_id: String(doc._id), maple_id: doc.maple_id },
            'apply: no-donor — set geo_backfill_skipped sentinel',
          );
          processed++;
          continue;
        }

        const { donor, deltaMs } = result;
        const donorGps = donor.exif?.gps;
        if (!donorGps || typeof donorGps.lat !== 'number' || typeof donorGps.lng !== 'number') {
          // Donor GPS missing or malformed (non-numeric lat/lng). The donor query
          // requires both coordinates to exist, so this only fires on a corrupt
          // value or a race where the donor changed after selection — skip safely
          // rather than writing a bad coordinate onto an original.
          await assets.updateOne({ _id: doc._id }, { $set: { geo_backfill_skipped: 'no-donor' } });
          log.warn(
            { video_id: String(doc._id), donor_id: String(donor._id) },
            'apply: donor GPS missing/malformed at apply time — set no-donor sentinel',
          );
          processed++;
          continue;
        }

        const now = new Date().toISOString();

        // Atomic 3-step re-trigger:
        //   1. Set exif.gps + provenance marker.
        //   2. Reset stages.geocode so geocode re-runs on next tick.
        //   3. Unset backup_layout_version so refile-backups re-files after geocode.
        await assets.updateOne(
          { _id: doc._id },
          {
            $set: {
              'exif.gps': donorGps,
              geo_inferred: {
                source: 'temporal-neighbor',
                donor_id: donor._id,
                donor_delta_ms: deltaMs,
                at: now,
              },
              'stages.geocode': {
                version: 0,
                attempts: 0,
                last_error: null,
                dead: false,
                processed_at: null,
              },
            },
            $unset: { backup_layout_version: '' },
          },
        );

        log.info(
          {
            video_id: String(doc._id),
            maple_id: doc.maple_id,
            donor_id: String(donor._id),
            delta_ms: deltaMs,
            gps: donorGps,
          },
          'apply: GPS set, geocode reset, backup_layout_version unset',
        );

        processed++;
      } catch (err) {
        errors++;
        log.error(
          {
            video_id: String(doc._id),
            err: err instanceof Error ? err.message : err,
          },
          'apply: error processing candidate',
        );
      }
    }

    return { processed, errors };
  },
};
