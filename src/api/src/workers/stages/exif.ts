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
import * as fs from "node:fs/promises";
import { readExif } from "../../indexer/exif.ts";
import { deriveId } from "../../indexer/id.ts";
import { defineStage } from "../runtime/define-stage.ts";

const SHA1_HEAD_BYTES = 64 * 1024;

async function readHead(absPath: string): Promise<Uint8Array> {
  const fd = await fs.open(absPath, "r");
  try {
    const buf = new Uint8Array(SHA1_HEAD_BYTES);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

export default defineStage({
  name: "exif",
  // v2: GPS hemisphere refs added to the exifr pick list — earlier indexes
  // wrote western-hemisphere longitudes as positive. Bumping forces re-extract.
  targetVersion: 2,
  dependsOn: ["hash"],
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
    const absPath = image.abs_path as string;

    // Stat the file first — throws ENOENT when it doesn't exist, satisfying
    // the "throws when the file does not exist" test contract before we even
    // attempt to open it for reading.
    await fs.stat(absPath);

    const exif = await readExif(absPath);

    const patch: Record<string, unknown> = { exif };

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
