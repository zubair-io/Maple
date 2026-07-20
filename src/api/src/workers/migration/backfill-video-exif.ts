/**
 * Migration: "Backfill video EXIF".
 *
 * Re-reads existing backup videos through the QuickTime/MP4 `moov` reader
 * (wired into `readExif`, #1525) and writes the recovered capture date + GPS onto
 * `exif`. Videos were excluded from the EXIF stage (`.mov` ∈ `NO_EXIF_EXTS`), so
 * they currently sit with `exif: null` — undated and unplaced. This backfills
 * them, then nudges the pipeline so each one lands in the right folder:
 *
 *   - GPS recovered → reset `stages.geocode.version` so geocode re-runs, resolves
 *     a `place`, and (via the geocode stage's place-write hook) resets
 *     `backup_layout_version` → refile-backups files it under the location.
 *   - No GPS but a capture month → reset `backup_layout_version` directly so
 *     refile-backups files it under `<year>/<MM>`.
 *
 * Done-marker is `video_meta_version`: a processed asset (even one whose file
 * carried no usable metadata) is stamped so it drops out of the candidate set and
 * can't head-of-line-block the unsorted batch. Bump `VIDEO_META_VERSION` to
 * re-run after the reader learns to extract more.
 */

import type { Filter } from 'mongodb';
import type { AssetDoc, FileInfo } from '../../db/schema.ts';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import { assetAbsPath, isLiveFileInfo } from '../../indexer/images.repo.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import { readExif } from '../../indexer/exif.ts';
import { child as childLogger } from '../../log.ts';
import { liveVideoFileinfoMatch } from './video-selectors.ts';

import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:video-exif');

const MIGRATION_ID = 'backfill-video-exif';

/** Bump to re-sweep all videos (e.g. after the moov reader learns a new tag). */
export const VIDEO_META_VERSION = 1;

/** Reset value for `backup_layout_version` that re-enters the refile candidate
 * set (the migration's `$ne` selector). */
const REFILE_RESET_VERSION = 0;

/** Backup-origin assets with a live VIDEO entry not yet backfilled. */
function candidateFilter(): Filter<AssetDoc> {
  return {
    'phasset_links.0': { $exists: true },
    fileinfo: { $elemMatch: liveVideoFileinfoMatch() },
    video_meta_version: { $ne: VIDEO_META_VERSION },
  } as Filter<AssetDoc>;
}

export const backfillVideoExif: Migration = {
  id: MIGRATION_ID,
  title: 'Backfill video metadata (date + GPS)',
  description:
    'Reads capture date + GPS from existing backup videos (QuickTime/MP4 moov atoms) ' +
    'that the EXIF stage skipped, then re-files them: GPS → geocode → location folder; ' +
    'no GPS → year/month. One-time; idempotent per video.',

  async countRemaining(): Promise<number> {
    const coll = await assetsCollection();
    return coll.countDocuments(candidateFilter());
  },

  async runBatch(batchSize: number): Promise<MigrationBatchResult> {
    const coll = await assetsCollection();
    let libs: ReadonlyMap<string, string>;
    try {
      libs = await loadLibraryRoots();
    } catch {
      libs = new Map();
    }

    const docs = await coll
      .find(candidateFilter(), {
        projection: { _id: 1, fileinfo: 1, maple_id: 1 },
      })
      .limit(batchSize)
      .toArray();

    let processed = 0;
    let errors = 0;
    let skippedNoRoot = 0;

    for (const doc of docs) {
      // Read the live VIDEO entry specifically, not `assetPrimaryFileInfo` (the
      // first live entry) — an asset could carry a still + video pair, and the
      // selector matched on *a* live video entry, so that's the one to read.
      const video = ((doc.fileinfo ?? []) as FileInfo[]).find(
        (fi) => isLiveFileInfo(fi) && isVideoFilename(fi.filename),
      );
      if (!video) {
        // Selector matched a live video entry but none survives now (stale shape)
        // — stamp so it drops out (never clogs).
        await coll.updateOne(
          { _id: doc._id },
          { $set: { video_meta_version: VIDEO_META_VERSION } },
        );
        processed++;
        continue;
      }

      // Single-entry view so `assetAbsPath` resolves THIS video, not the primary.
      const absPath = assetAbsPath({ fileinfo: [video] }, libs);
      if (!absPath) {
        // Library unregistered / offline — retry next tick once the mount returns.
        skippedNoRoot++;
        continue;
      }

      let exif;
      try {
        exif = await readExif(absPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT') {
          // Source gone — nothing to read; stamp so it doesn't clog.
          await coll.updateOne(
            { _id: doc._id },
            { $set: { video_meta_version: VIDEO_META_VERSION } },
          );
          processed++;
          continue;
        }
        // Transient IO (EBUSY, half-copied file) — leave unstamped for a retry.
        errors++;
        log.error(
          {
            _id: String(doc._id),
            maple_id: doc.maple_id,
            err: err instanceof Error ? err.message : err,
          },
          'video-exif: read failed — left for retry',
        );
        continue;
      }

      const set: Record<string, unknown> = {
        video_meta_version: VIDEO_META_VERSION,
      };
      if (exif) {
        set.exif = exif;
        if (exif.gps) {
          // Re-geocode → place → (geocode hook) reset blv → refile under location.
          set['stages.geocode.version'] = 0;
        } else if (exif.captured_year != null) {
          // Dated but no GPS → make it a refile candidate for the <year>/Misc path.
          set.backup_layout_version = REFILE_RESET_VERSION;
        }
      }
      await coll.updateOne({ _id: doc._id }, { $set: set });
      if (exif && (exif.captured_at || exif.gps)) {
        log.info(
          {
            _id: String(doc._id),
            maple_id: doc.maple_id,
            dated: !!exif.captured_at,
            gps: !!exif.gps,
          },
          'video-exif: backfilled',
        );
      }
      processed++;
    }

    if (skippedNoRoot > 0) {
      log.warn(
        { skippedNoRoot, batchSize: docs.length, processed },
        'video-exif: assets skipped — library root unresolved (offline mount?)',
      );
    }
    return { processed, errors };
  },
};
