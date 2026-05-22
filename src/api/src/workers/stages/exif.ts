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
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { assetsCollection } from '../../db/client.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
import type { FileInfo } from '../../db/schema.ts';
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
        // When a winner exists we merge our fileinfo[] into it and self-
        // delete, mirroring the boot-time mergeDuplicateAssets migration
        // (db/migrations.ts). Returning `skip` lets the orchestrator's
        // writeback no-op on the now-deleted _id without surfacing as an
        // error.
        const merged = await tryMergeWithExistingPrimary(image, id.hex);
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
 * If another row already owns `newMapleId`, union our `fileinfo[]` into it
 * (deduped by `(library_id, path, filename)`, live entries preferred over
 * tombstones) and delete the loser. Returns the winner's `_id` on a merge,
 * `null` when no winner exists and the caller should proceed with the
 * normal upgrade.
 *
 * The dedup-and-prefer-live logic mirrors `mergeDuplicateAssets` in
 * `db/migrations.ts:295-313` — keep them in sync.
 */
async function tryMergeWithExistingPrimary(
  loser: ImageDoc,
  newMapleId: string,
): Promise<ObjectId | null> {
  const assets = await assetsCollection();
  const winner = await assets.findOne(
    { maple_id: newMapleId, _id: { $ne: loser._id } },
    { projection: { _id: 1, fileinfo: 1 } },
  );
  if (!winner) return null;

  const seen = new Map<string, FileInfo>();
  const lists: FileInfo[][] = [
    (winner.fileinfo ?? []) as FileInfo[],
    (loser.fileinfo ?? []) as FileInfo[],
  ];
  for (const list of lists) {
    for (const entry of list) {
      const key = JSON.stringify([entry.library_id.toHexString(), entry.path, entry.filename]);
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, entry);
        continue;
      }
      const existingDead = existing.deleted_at != null;
      const candidateDead = entry.deleted_at != null;
      if (existingDead && !candidateDead) seen.set(key, entry);
    }
  }
  await assets.updateOne(
    { _id: winner._id },
    { $set: { fileinfo: Array.from(seen.values()) } },
  );
  await assets.deleteOne({ _id: loser._id });
  return winner._id;
}

export default exifStage;

export async function startExifStage(): Promise<RunStageHandle> {
  return runStage(exifStage);
}

// Test-only surface: exported so the merge-on-collision path can be
// exercised against a real Mongo without driving a full handler pass
// (which requires a fixture with EXIF DateTimeOriginal).
export const __exifTestInternals = { tryMergeWithExistingPrimary };
