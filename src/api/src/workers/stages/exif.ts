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
import * as path from 'node:path';
import type { ObjectId } from 'mongodb';
import { readExif } from '../../indexer/exif.ts';
import { deriveId } from '../../indexer/id.ts';
import { assetAbsPath, assetPrimaryFileInfo } from '../../indexer/images.repo.ts';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import type { AssetExif, FileInfo } from '../../db/schema.ts';
import { recordAndPublishAssetChange } from '../../db/changes.repo.ts';
import type { ImageDoc, StageResult } from '../run-stage.ts';
import { defineStage, runStage, type RunStageHandle } from '../run-stage.ts';

const SHA1_HEAD_BYTES = 64 * 1024;

/** Filename patterns that almost always indicate a screenshot.
 *
 *   iOS:     "Screenshot 2026-05-19 at 10.04.32.png"
 *   macOS:   "Screen Shot 2024-12-01 at 1.23.45 PM.png"
 *   Android: "Screenshot_20240601_102030.png" / "Screenshot_2024-06-01.png"
 *
 * Anchored to start-of-name so a file someone explicitly named
 * "my-screenshot-of-X.png" doesn't get auto-categorised.
 */
const SCREENSHOT_FILENAME_RE = /^(Screenshot[\s_-]|Screen[\s]Shot[\s])/i;

/** Heuristic screenshot detection from filename + EXIF. Conservative
 * — only fires when the camera_make is empty AND the filename matches
 * a known screenshot pattern. False positives are worse than false
 * negatives because the describe stage will correct false negatives on
 * its next pass but a false positive sticks in the "Photos" view until
 * the operator manually clears it.
 *
 * The describe stage overwrites this with the qwen2.5-vl verdict once
 * it runs, which handles cropped screenshots and photos-of-screens. */
export function isLikelyScreenshot(
  filename: string,
  cameraMake: string | null | undefined,
): boolean {
  if (cameraMake && cameraMake.trim().length > 0) return false;
  const base = path.basename(filename);
  return SCREENSHOT_FILENAME_RE.test(base);
}

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
  defaults: {
    concurrency: 4,
    batchSize: 10,
    pollIntervalMs: 1000,
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
    // Reserve `skip` for the genuine case: libraries loaded fine, but the
    // asset has no fileinfo[0] or its library is unregistered.
    const libs = await loadLibraryRoots();
    const absPath = assetAbsPath(image, libs);
    if (!absPath) {
      return { skip: 'no-resolvable-location' };
    }

    // Stat the file first — throws ENOENT when it doesn't exist, satisfying
    // the "throws when the file does not exist" test contract before we even
    // attempt to open it for reading.
    await fs.stat(absPath);

    const exif = await readExif(absPath);

    const patch: Record<string, unknown> = {
      exif,
      // Heuristic screenshot seed — describe stage refines this later.
      is_screenshot: isLikelyScreenshot(absPath, exif?.camera_make ?? null),
    };

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
          is_screenshot: patch.is_screenshot as boolean,
        });
        if (merged) {
          return { skip: `merged-into-${merged.toHexString()}` };
        }
        patch.maple_id = id.hex;
      }
    }

    return { patch };
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
 * Other-row owns `newMapleId`. Merge it with the loser passed in and delete
 * whichever loses the survivor pick. Returns the survivor's `_id` on a
 * merge, `null` when no other row exists and the caller should proceed with
 * the normal upgrade.
 *
 * Behaviour mirrors `mergeDuplicateAssets` in `db/migrations.ts`:
 *   - Survivor is the row with the earliest `indexed_at` (ties: _id ascending).
 *   - `fileinfo[]` unions both rows, deduped by `(library_id, path, filename)`,
 *     with live entries preferred over tombstones.
 *   - User-mutable fields (rating, flag, color_label) are carried from
 *     non-survivor into survivor when the survivor still holds defaults,
 *     so a rating set on the loser between discover and exif isn't lost.
 *   - The freshly-computed exif/is_screenshot from this stage run are
 *     written onto the survivor when it lacks them — otherwise the parse
 *     work is discarded along with the deleted row.
 *
 * The merge is non-atomic (updateOne then deleteOne). Crash between the
 * two writes leaves both rows alive with overlapping fileinfo; the next
 * retry re-enters this function, finds the same survivor, and the dedup
 * keys make the re-merge idempotent. The boot-time migration is also
 * idempotent for the same reason.
 *
 * Change feed: publishes a `delete` event for the deleted row and an
 * `update` event for the survivor so File Provider / SSE consumers see
 * the merge instead of going stale.
 */
async function tryMergeWithExistingPrimary(
  loser: ImageDoc,
  newMapleId: string,
  loserContribution: LoserExifContribution,
): Promise<ObjectId | null> {
  const assets = await assetsCollection();
  const other = await assets.findOne(
    { maple_id: newMapleId, _id: { $ne: loser._id } },
    {
      projection: {
        _id: 1,
        fileinfo: 1,
        indexed_at: 1,
        rating: 1,
        flag: 1,
        color_label: 1,
        exif: 1,
        is_screenshot: 1,
      },
    },
  );
  if (!other) return null;

  const otherIndexedAt = (other.indexed_at as string | undefined) ?? '';
  const loserIndexedAt = (loser.indexed_at as string | undefined) ?? '';
  const otherIsOlder =
    otherIndexedAt < loserIndexedAt ||
    (otherIndexedAt === loserIndexedAt && other._id.toString() < loser._id.toString());
  const survivor = otherIsOlder ? other : loser;
  const condemned = otherIsOlder ? loser : other;

  const mergedFileinfo = unionFileinfo(
    (other.fileinfo ?? []) as FileInfo[],
    (loser.fileinfo ?? []) as FileInfo[],
  );

  // Build the patch for the survivor. fileinfo always changes; the rest
  // only when the survivor holds a default and the condemned has a
  // non-default value. For the freshly-extracted exif/is_screenshot from
  // this stage run, prefer them when the survivor's exif is missing.
  const survivorPatch: Record<string, unknown> = { fileinfo: mergedFileinfo };
  const condemnedRating = (condemned as { rating?: number }).rating ?? 0;
  const condemnedFlag = (condemned as { flag?: number }).flag ?? 0;
  const condemnedColor = (condemned as { color_label?: string }).color_label ?? '';
  const survivorRating = (survivor as { rating?: number }).rating ?? 0;
  const survivorFlag = (survivor as { flag?: number }).flag ?? 0;
  const survivorColor = (survivor as { color_label?: string }).color_label ?? '';
  if (survivorRating === 0 && condemnedRating !== 0) survivorPatch.rating = condemnedRating;
  if (survivorFlag === 0 && condemnedFlag !== 0) survivorPatch.flag = condemnedFlag;
  if (survivorColor === '' && condemnedColor !== '') survivorPatch.color_label = condemnedColor;
  const survivorExif = (survivor as { exif?: AssetExif | null }).exif;
  if (!survivorExif && loserContribution.exif) {
    survivorPatch.exif = loserContribution.exif;
    survivorPatch.is_screenshot = loserContribution.is_screenshot;
  }
  // If the survivor is the LOSER (we're keeping this stage's row), it also
  // needs the upgraded maple_id since the orchestrator's writeback path on
  // `skip` won't apply our patch.
  if (!otherIsOlder) {
    survivorPatch.maple_id = newMapleId;
  }

  await assets.updateOne({ _id: survivor._id }, { $set: survivorPatch });
  await assets.deleteOne({ _id: condemned._id });

  // Publish change events so File Provider / SSE clients don't go stale.
  // Best-effort — recordAndPublishAssetChange swallows its own errors so a
  // publish failure won't undo the merge writes above.
  const condemnedPrimary = assetPrimaryFileInfo(condemned as never);
  const survivorPrimary = assetPrimaryFileInfo({ fileinfo: mergedFileinfo } as never);
  await recordAndPublishAssetChange({
    kind: 'delete',
    asset_id: condemned._id,
    folder_id: condemnedPrimary?.library_id ?? null,
    abs_path: null,
  });
  await recordAndPublishAssetChange({
    kind: 'update',
    asset_id: survivor._id,
    folder_id: survivorPrimary?.library_id ?? null,
    abs_path: null,
  });

  return survivor._id;
}

function unionFileinfo(a: FileInfo[], b: FileInfo[]): FileInfo[] {
  const seen = new Map<string, FileInfo>();
  for (const list of [a, b]) {
    for (const entry of list) {
      const key = JSON.stringify([entry.library_id.toHexString(), entry.path, entry.filename]);
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, entry);
        continue;
      }
      // Prefer live over tombstoned for the same location key.
      if (existing.deleted_at != null && entry.deleted_at == null) {
        seen.set(key, entry);
      }
    }
  }
  return Array.from(seen.values());
}

export default exifStage;

export async function startExifStage(): Promise<RunStageHandle> {
  return runStage(exifStage);
}

// Test-only surface: exported so the merge-on-collision path can be
// exercised against a real Mongo without driving a full handler pass
// (which requires a fixture with EXIF DateTimeOriginal).
export const __exifTestInternals = { tryMergeWithExistingPrimary };
