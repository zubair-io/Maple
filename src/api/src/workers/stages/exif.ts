/**
 * EXIF stage — parses EXIF metadata and finalises the maple:id to the primary
 * form when capturedAt is available.
 *
 * The primary-form maple:id embeds BLAKE3( SHA1(head) || capturedAt ||
 * cameraSerial || shutterCount ) (tag 0x01). The hash stage wrote the
 * fallback form (tag 0x02, SHA1(head) only); this stage upgrades it if
 * DateTimeOriginal is present. See `src/api/src/indexer/id.ts` for the byte
 * layout.
 *
 * dependsOn: ["hash"]   — needs sha1_head on the doc (written by hash).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readExif } from '../../indexer/exif.ts';
import { deriveId } from '../../indexer/id.ts';
import { assetAbsPath } from '../../indexer/images.repo.ts';
import { loadLibraryRoots } from '../../indexer/libraries.cache.ts';
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
  dependsOn: ['hash'],
  defaults: {
    concurrency: 4,
    batchSize: 10,
    pollIntervalMs: 1000,
    maxAttempts: 5,
    pausedOnFirstBoot: false,
    paused: false,
    last_seen_target_version: 0,
  },
  handler: async (image) => {
    // Resolve via assetAbsPath when the row has fileinfo[0]; fall back to the
    // legacy abs_path field otherwise. Treat unresolvable rows like missing
    // files — fs.stat below will throw and the stage's normal retry/dead
    // bookkeeping handles it.
    let libs: ReadonlyMap<string, string>;
    try {
      libs = await loadLibraryRoots();
    } catch {
      libs = new Map();
    }
    const absPath = assetAbsPath(image as never, libs) ?? (image.abs_path as string);

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
      patch.maple_id = id.hex;
    }

    return { patch };
  },
});

export default exifStage;

export async function startExifStage(): Promise<RunStageHandle> {
  return runStage(exifStage);
}
