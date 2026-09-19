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

import type { AssetExif } from '../../db/schema.ts';
import {
  countCandidates,
  unstamped,
  type CandidateScope,
  type MigrationCandidate,
} from '../../db/sqlite/repos/assets.migrations.ts';
import {
  applyVideoExif,
  stampVideoMetaVersion,
  BACKUP_VIDEO_SCOPE,
} from '../../db/sqlite/repos/assets.video-migrations.ts';
import { assetAbsPath, isLiveFileInfo } from '../../indexer/images.repo.ts';
import { isVideoFilename } from '../../indexer/media-types.ts';
import { readExif } from '../../indexer/exif.ts';
import { child as childLogger } from '../../log.ts';

import { runCandidateBatch, type CandidateOutcome, type LibraryRoots } from './candidate-batch.ts';
import type { Migration, MigrationBatchResult } from './types.ts';

const log = childLogger('migration:video-exif');

const MIGRATION_ID = 'backfill-video-exif';

/** Bump to re-sweep all videos (e.g. after the moov reader learns a new tag). */
export const VIDEO_META_VERSION = 1;

/** Backup-origin assets with a live VIDEO entry not yet backfilled. */
function candidateScope(): CandidateScope {
  return unstamped(BACKUP_VIDEO_SCOPE, 'video_meta_version', VIDEO_META_VERSION);
}

export const backfillVideoExif: Migration = {
  id: MIGRATION_ID,
  title: 'Backfill video metadata (date + GPS)',
  description:
    'Reads capture date + GPS from existing backup videos (QuickTime/MP4 moov atoms) ' +
    'that the EXIF stage skipped, then re-files them: GPS → geocode → location folder; ' +
    'no GPS → year/month. One-time; idempotent per video.',

  countRemaining(): Promise<number> {
    return countCandidates(candidateScope());
  },

  runBatch(batchSize: number): Promise<MigrationBatchResult> {
    return runCandidateBatch({
      scope: candidateScope(),
      batchSize,
      log,
      skippedWarning: 'video-exif: assets skipped — library root unresolved (offline mount?)',
      process: backfillOneVideo,
    });
  },
};

/** Stamp the done-marker without reading anything — for a candidate there is
 * nothing left to read on. It drops out of the candidate set instead of being
 * re-fetched every tick. */
async function stampDone(id: MigrationCandidate['id']): Promise<CandidateOutcome> {
  await stampVideoMetaVersion(id, VIDEO_META_VERSION);
  return 'processed';
}

/** Read one video's metadata and apply it, or decide why it cannot be read. */
async function backfillOneVideo(
  libs: LibraryRoots,
  doc: MigrationCandidate,
): Promise<CandidateOutcome> {
  // Read the live VIDEO entry specifically, not `assetPrimaryFileInfo` (the
  // first live entry) — an asset could carry a still + video pair, and the
  // selector matched on *a* live video entry, so that's the one to read.
  const video = doc.fileinfo.find((fi) => isLiveFileInfo(fi) && isVideoFilename(fi.filename));
  // Selector matched a live video entry but none survives now (stale shape)
  // — stamp so it drops out (never clogs).
  if (!video) return stampDone(doc.id);

  // Single-entry view so `assetAbsPath` resolves THIS video, not the primary.
  const absPath = assetAbsPath({ fileinfo: [video] }, libs);
  // Library unregistered / offline — retry next tick once the mount returns.
  if (!absPath) return 'skipped-no-root';

  const read = await readVideoExif(doc, absPath);
  // Only the read is guarded: a write that fails is a bug, not a bad file, and
  // it should surface rather than be counted as one more unreadable video.
  if ('failed' in read) return read.failed;

  return applyRecoveredExif(doc, read.exif);
}

/**
 * Write what the file said onto the row and nudge whatever now has work to do.
 *
 * A video that turned out to carry nothing usable still goes through here: it
 * is stamped like any other, because "we looked and there was nothing" is a
 * finished asset, not one to come back to.
 */
async function applyRecoveredExif(
  doc: MigrationCandidate,
  exif: AssetExif | null,
): Promise<CandidateOutcome> {
  const gps = !!exif?.gps;
  const dated = !!exif?.captured_at;
  await applyVideoExif(
    doc.id,
    {
      exif,
      // GPS recovered → geocode re-runs, resolves a place, and (via the
      // geocode stage's place-write hook) clears the refile marker.
      rearmGeocode: gps,
      // Dated but placeless → a refile candidate for the <year>/Misc path.
      resetBackupLayout: !gps && exif?.captured_year != null,
    },
    VIDEO_META_VERSION,
  );
  if (dated || gps) {
    log.info({ _id: String(doc.id), maple_id: doc.maple_id, dated, gps }, 'video-exif: backfilled');
  }
  return 'processed';
}

/** What the file said, or — when it could not be read at all — what that means
 * for the asset. A video with no usable metadata is a successful read of
 * nothing (`exif: null`), not a failure. */
type ExifRead = { exif: AssetExif | null } | { failed: CandidateOutcome };

async function readVideoExif(doc: MigrationCandidate, absPath: string): Promise<ExifRead> {
  try {
    return { exif: await readExif(absPath) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // Source gone — nothing to read; stamp so it doesn't clog.
    if (code === 'ENOENT') return { failed: await stampDone(doc.id) };

    // Transient IO (EBUSY, half-copied file) — leave unstamped for a retry.
    log.error(
      {
        _id: String(doc.id),
        maple_id: doc.maple_id,
        err: err instanceof Error ? err.message : err,
      },
      'video-exif: read failed — left for retry',
    );
    return { failed: 'error' };
  }
}
