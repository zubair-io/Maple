/**
 * EXIF stage — parses EXIF metadata and finalises the maple:id to the primary
 * form when capturedAt is available.
 *
 * The primary-form maple:id embeds BLAKE3( SHA1(head) || capturedAt ||
 * cameraSerial || shutterCount ) (tag 0x01). The discover watcher writes
 * the fallback form (tag 0x02, SHA1(head) only) inline at insert; this
 * stage upgrades it if DateTimeOriginal is present. See
 * `src/api/src/indexer/id.ts` for the byte layout.
 *
 * dependsOn: []   — discover writes sha1_head + maple_id inline at insert,
 * so this stage no longer needs a predecessor. The legacy `hash` stage was
 * retired in the drop-abs-path-2026-05-21 migration once every row carried
 * `maple_id` at insert time.
 */
import * as fs from 'node:fs/promises';
import { ObjectId } from '../../db/object-id.ts';
import { readExif } from '../../indexer/exif.ts';
import { isLikelyScreenshot } from '../../indexer/screenshot.ts';
import { deriveId } from '../../indexer/id.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { findMapleIdHolder, mergeIntoSurvivor } from '../../db/repos/assets.merge.ts';
import { exifPatchStatements } from '../../db/repos/assets.stage-patches.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import type { AssetExif } from '../../db/schema.ts';
import { recordAndPublishAssetChange } from '../../db/repos/changes.repo.ts';
import type { ImageDoc, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';

const SHA1_HEAD_BYTES = 64 * 1024;

// `isLikelyScreenshot` (the filename + camera-make heuristic that seeds
// `is_screenshot`) lives in `indexer/screenshot.ts` so the backup-ingest route
// can share it without importing this exifr-heavy module. Re-exported here so
// existing importers (and this stage's tests) keep their `./exif.ts` import.
export { isLikelyScreenshot } from '../../indexer/screenshot.ts';

async function readHead(absPath: string): Promise<Uint8Array> {
  const fd = await fs.open(absPath, 'r');
  try {
    const buf = new Uint8Array(SHA1_HEAD_BYTES);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

const exifStage = defineStage({
  name: 'exif',
  // v2: GPS hemisphere refs added to the exifr pick list — earlier indexes
  // wrote western-hemisphere longitudes as positive. Bumping forces re-extract.
  targetVersion: 2,
  dependsOn: [],
  // Reads the original file — an ENOENT means it vanished from disk, so the
  // runner tags `missing_since` for the missing-reaper.
  tagsMissingOnEnoent: true,
  // A non-ENOENT failure that survives all retries means the bytes are
  // unreadable (corrupt original / undecodable format) — tag `damaged` so the
  // rest of the pipeline parks the file and it surfaces in the Workers UI.
  tagsDamagedOnDeadLetter: true,
  defaults: {
    concurrency: 4,
    maxAttempts: 5,
    pausedOnFirstBoot: false,
    paused: false,
    last_seen_target_version: 0,
  },
  handler: async (image: ImageDoc): Promise<StageResult> => {
    // Resolve via assetAbsPath. Let `loadLibraryRoots()` errors propagate —
    // a transient DB hiccup would otherwise yield an empty libs map, which
    // would make `assetAbsPath` return null and trip the no-resolvable-
    // location skip below. That skip writes `version = targetVersion`
    // (see run-stage.ts), permanently marking the stage done. By throwing,
    // the runner's retry/backoff path handles the transient case.
    // Reserve `skip` for the genuine non-reapable cases: libraries loaded
    // fine, but the asset has no fileinfo entries at all (never-located
    // skeleton) or a live entry whose library is unregistered. The third
    // null case — all fileinfo entries soft-deleted (every on-disk location
    // gone) — is the genuinely-orphaned one: the runner stamps
    // `missing_since` on that skip instead of marking the stage done, so the
    // missing-reaper sees it. See run-stage.ts.
    const libs = await loadLibraryRoots();
    const absPath = assetAbsPath(image, libs);
    if (!absPath) {
      return { skip: 'no-resolvable-location' };
    }

    // Stat the file first — throws ENOENT when it doesn't exist, satisfying
    // the "throws when the file does not exist" test contract before we even
    // attempt to open it for reading. The runner tags `missing_since` on that
    // ENOENT (this stage sets `tagsMissingOnEnoent`); the missing-reaper later
    // verifies + deletes.
    const stat = await fs.stat(absPath);

    // A 0-byte file is deterministically unreadable: an interrupted copy that
    // never completed, or a cloud-sync placeholder whose bytes never landed.
    // The watcher only emits a file after `awaitWriteFinish` (size stable for
    // 2s), so a file that reaches here empty isn't mid-copy — retrying can't
    // help. Tag it `damaged` now rather than throwing through the stage's whole
    // retry budget to reach the same place. (Handed an empty file, exifr would
    // otherwise crash with the opaque "undefined is not an object (evaluating
    // 'this.dataView.getUint16')".)
    if (stat.size === 0) {
      return {
        damaged: 'file is empty (0 bytes) — incomplete copy or unmaterialized sync placeholder',
      };
    }

    const exif = await readExif(absPath);
    // Heuristic screenshot seed — describe stage refines this later.
    const isScreenshot = isLikelyScreenshot(absPath, exif?.camera_make ?? null);

    // Upgrade maple_id to primary form if capturedAt is available.
    if (exif?.captured_at) {
      const head = await readHead(absPath);
      const id = deriveId(
        head,
        exif.captured_at,
        null, // camera_serial not in AssetExif schema yet
        null, // shutter_count not in AssetExif schema yet
      );
      if (id.hex !== image.maple_id) {
        // The upgrade only runs when the id is actually changing — same
        // value would be a no-op, but a different value risks colliding
        // with another row that already holds the primary id.
        //
        // Collision happens when a duplicate file slips past the discover
        // dedup (e.g. third copy of the same content discovered after the
        // canonical row's maple_id was already upgraded — the fallback-id
        // findOne misses; the sha1_head fallback in handle-event.ts plugs
        // most of that, but races and legacy dead-letter rows still need
        // a runtime safety net).
        //
        // When a collision is detected we merge the two rows the same way
        // the boot-time mergeDuplicateAssets migration does (db/migrations.ts):
        // pick the row with the earliest indexed_at as survivor, union
        // fileinfo[], promote loser's user-edited and freshly-extracted
        // fields where the survivor has defaults, then delete the other
        // row.
        const merged = await tryMergeWithExistingPrimary(image, id.hex, {
          exif,
          is_screenshot: isScreenshot,
        });
        if (merged) {
          return { skip: `merged-into-${merged.toHexString()}` };
        }
        return {
          patch: exifPatchStatements(image._id.toHexString(), {
            exif,
            isScreenshot,
            mapleId: id.hex,
          }),
        };
      }
    }

    return { patch: exifPatchStatements(image._id.toHexString(), { exif, isScreenshot }) };
  },
});

/**
 * Fresh-from-handler signal the loser computed during this run. The exif
 * stage extracted these from the loser's bytes; if the survivor row has
 * defaults for them we forward the new values onto the survivor before
 * deleting the loser so the parse work isn't thrown away.
 */
interface LoserExifContribution {
  exif: AssetExif | null;
  is_screenshot: boolean;
}

/**
 * Another row already owns `newMapleId`. Merge it with the row this run is
 * processing and delete whichever loses the survivor pick. Returns the
 * survivor's id on a merge, `null` when the id is free and the caller should
 * proceed with the normal upgrade.
 *
 * The rules are the ones `mergeDuplicateAssets` established:
 *   - Survivor is the row with the earliest `indexed_at` (ties: id ascending).
 *   - The loser's locations move onto the survivor.
 *   - User-mutable fields (rating, flag, color_label) are carried from the
 *     condemned row into the survivor when the survivor still holds defaults,
 *     so a rating set between discover and exif isn't lost.
 *   - The freshly-computed exif / is_screenshot from this run are written onto
 *     the survivor when it lacks them — otherwise the parse work is discarded
 *     along with the deleted row.
 *
 * ## What the rows fixed
 *
 * On Mongo this was four unrelated writes and was explicitly non-atomic,
 * healing only because a retry re-entered it and the dedup keys made it
 * idempotent. `mergeIntoSurvivor` commits all of it in one transaction, which
 * removes three hazards at once: the id claim no longer has to be ordered
 * strictly after the delete to dodge a unique-index collision (a crash in that
 * window left the survivor stranded on its fallback id), the "entry already
 * present on the survivor" case cannot arise because a location's
 * `(library, path, filename)` is UNIQUE table-wide, and `live_location_count`
 * is maintained by a trigger rather than recomputed by hand. See
 * `db/repos/assets.merge.ts`.
 *
 * Change feed: publishes a `delete` event for the removed row and an `update`
 * for the survivor, so File Provider and SSE consumers see the merge instead of
 * going stale. Deliberately after the transaction and best-effort — a publish
 * failure must not undo a merge that has already committed.
 */
async function tryMergeWithExistingPrimary(
  loser: ImageDoc,
  newMapleId: string,
  loserContribution: LoserExifContribution,
): Promise<ObjectId | null> {
  const loserId = loser._id.toHexString();
  const other = await findMapleIdHolder(newMapleId, loserId);
  if (!other) return null;

  const otherIndexedAt = other.indexed_at;
  const loserIndexedAt = (loser.indexed_at as string | undefined) ?? '';
  const otherIsOlder =
    otherIndexedAt < loserIndexedAt || (otherIndexedAt === loserIndexedAt && other.id < loserId);

  const loserSide = {
    id: loserId,
    rating: (loser as { rating?: number }).rating ?? 0,
    flag: (loser as { flag?: number }).flag ?? 0,
    colorLabel: (loser as { color_label?: string }).color_label ?? '',
    hasExif: Boolean((loser as { exif?: AssetExif | null }).exif),
    fileinfo: loser.fileinfo ?? [],
  };
  const otherSide = {
    id: other.id,
    rating: other.rating,
    flag: other.flag,
    colorLabel: other.color_label,
    hasExif: other.hasExif,
    fileinfo: other.fileinfo,
  };
  const survivor = otherIsOlder ? otherSide : loserSide;
  const condemned = otherIsOlder ? loserSide : otherSide;

  await mergeIntoSurvivor({
    survivorId: survivor.id,
    condemnedId: condemned.id,
    mapleId: newMapleId,
    carryOver: {
      ...(survivor.rating === 0 && condemned.rating !== 0 ? { rating: condemned.rating } : {}),
      ...(survivor.flag === 0 && condemned.flag !== 0 ? { flag: condemned.flag } : {}),
      ...(survivor.colorLabel === '' && condemned.colorLabel !== ''
        ? { colorLabel: condemned.colorLabel }
        : {}),
      ...(!survivor.hasExif && loserContribution.exif
        ? { exif: loserContribution.exif, isScreenshot: loserContribution.is_screenshot }
        : {}),
    },
  });

  const condemnedPrimary = assetPrimaryFileInfo({ fileinfo: condemned.fileinfo });
  const folderId = condemnedPrimary?.library_id ?? null;
  await recordAndPublishAssetChange({
    kind: 'delete',
    asset_id: new ObjectId(condemned.id),
    folder_id: folderId,
    abs_path: null,
  });
  await recordAndPublishAssetChange({
    kind: 'update',
    asset_id: new ObjectId(survivor.id),
    folder_id: folderId,
    abs_path: null,
  });

  return new ObjectId(survivor.id);
}

export default exifStage;

export async function startExifStage(): Promise<RunStageHandle> {
  return runStage(exifStage);
}

// Test-only surface: exported so the merge-on-collision path can be exercised
// against a real database without driving a full handler pass (which requires
// a fixture with EXIF DateTimeOriginal).
export const __exifTestInternals = { tryMergeWithExistingPrimary };
