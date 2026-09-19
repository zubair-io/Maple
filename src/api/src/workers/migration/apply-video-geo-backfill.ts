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

import { countCandidates, listCandidates } from '../../db/repos/assets.migrations.ts';
import {
  applyGeoBackfill,
  setGeoBackfillSkipped,
  GEO_APPLY_SCOPE,
} from '../../db/repos/assets.video-migrations.ts';
import { assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { child as childLogger } from '../../log.ts';
import type { Migration, MigrationBatchResult } from './types.ts';
import { findDonor } from './audit-video-geo-backfill.ts';

const log = childLogger('migration:geo-backfill');

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

  countRemaining(): Promise<number> {
    return countCandidates(GEO_APPLY_SCOPE);
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const docs = await listCandidates(GEO_APPLY_SCOPE, batchSize);

    let processed = 0;
    let errors = 0;

    for (const doc of docs) {
      try {
        const capturedAt = doc.exif?.captured_at;
        const primary = assetPrimaryFileInfo(doc);

        // The candidate scope should guarantee both; if either is missing (e.g.
        // an empty-string timestamp, or no live location) set the sentinel so
        // the row converges instead of head-of-line-blocking the queue (#1519).
        if (!capturedAt || !primary) {
          await setGeoBackfillSkipped(doc.id, 'skip');
          log.warn(
            { video_id: String(doc.id), maple_id: doc.maple_id },
            'apply: missing captured_at or live fileinfo — set geo_backfill_skipped sentinel',
          );
          processed++;
          continue;
        }

        const result = await findDonor(doc.id, capturedAt, primary.library_id);

        if (!result) {
          // No donor found. Set sentinel so this video can't block the queue.
          await setGeoBackfillSkipped(doc.id, 'no-donor');
          log.warn(
            { video_id: String(doc.id), maple_id: doc.maple_id },
            'apply: no-donor — set geo_backfill_skipped sentinel',
          );
          processed++;
          continue;
        }

        const { donor, deltaMs } = result;
        const donorGps = donor.gps;
        if (typeof donorGps.lat !== 'number' || typeof donorGps.lng !== 'number') {
          // Donor GPS malformed (non-numeric lat/lng). The donor query requires
          // both coordinates to be present, so this only fires on a corrupt
          // value or a race where the donor changed after selection — skip
          // safely rather than writing a bad coordinate onto an original.
          await setGeoBackfillSkipped(doc.id, 'no-donor');
          log.warn(
            { video_id: String(doc.id), donor_id: String(donor.id) },
            'apply: donor GPS missing/malformed at apply time — set no-donor sentinel',
          );
          processed++;
          continue;
        }

        // The 3-step re-trigger, in one transaction: the coordinate plus its
        // provenance, the geocode stage back to unprocessed, and the refile
        // marker cleared.
        await applyGeoBackfill(doc.id, donorGps, {
          source: 'temporal-neighbor',
          donor_id: donor.id.toHexString(),
          donor_delta_ms: deltaMs,
          at: new Date().toISOString(),
        });

        log.info(
          {
            video_id: String(doc.id),
            maple_id: doc.maple_id,
            donor_id: String(donor.id),
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
            video_id: String(doc.id),
            err: err instanceof Error ? err.message : err,
          },
          'apply: error processing candidate',
        );
      }
    }

    return { processed, errors };
  },
};
