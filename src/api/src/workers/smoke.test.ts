/**
 * Smoke test: supervisor + hash + exif + thumb + discover.
 *
 * Drops a JPEG into a temp dir, waits up to 30 s for all three pipeline
 * stages to complete, then asserts stage versions on the image doc.
 *
 * Requires a running MongoDB (skips if unreachable) and the Plan 1
 * supervisor + runtime to be implemented.
 */
import { describe, expect, it, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

describe("workers smoke test", () => {
  let dir: string;
  let supervisorHandle: { stop: () => Promise<void> } | null = null;

  afterAll(async () => {
    if (supervisorHandle) await supervisorHandle.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(
    "hash + exif + thumb all reach their target version after a file is dropped",
    async () => {
      // Connect to Mongo — skip if unavailable.
      let db: import("mongodb").Db;
      try {
        const { getDb } = await import("../db/client.ts");
        db = await getDb();
      } catch {
        console.log("MongoDB unreachable — skipping smoke test");
        return;
      }

      dir = await mkdtemp(path.join(os.tmpdir(), "smoke-test-"));

      // Use a fresh ObjectId as folderId — the stage pipeline keys on
      // abs_path, not the folder row, so we don't need a real folder doc.
      const { ObjectId } = await import("mongodb");
      const { assetsCollection } = await import("../db/client.ts");
      const folderId = new ObjectId().toHexString();

      // Import the Plan 1 supervisor and start it.
      const { startSupervisor } = await import("./supervisor.ts");
      supervisorHandle = await startSupervisor({
        stages: ["hash", "exif", "thumb"],
        discover: { folderId, roots: [dir] },
      });

      // Read each stage's current target version rather than hardcoding —
      // the smoke test should track bumps (e.g. exif v1 → v2 for the GPS
      // hemisphere-ref fix) without a parallel edit here.
      const hashTarget = (await import("./stages/hash.ts")).default.targetVersion;
      const exifTarget = (await import("./stages/exif.ts")).default.targetVersion;
      const thumbTarget = (await import("./stages/thumb.ts")).default.targetVersion;

      // Drop a JPEG.
      const file = path.join(dir, "smoke.jpg");
      const buf = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 80, g: 120, b: 180 } },
      })
        .jpeg()
        .toBuffer();
      await writeFile(file, buf);

      // Chokidar uses polling with a 60s/300s interval — too slow for a 30s
      // smoke test. Drive discover's handleEvent directly to insert the doc
      // immediately, then let the stage children pick it up on their next poll.
      const { handleEvent } = await import("./discover/index.ts");
      await handleEvent({ kind: "created", absPath: file }, new ObjectId(folderId));

      // Poll until all three stages reach their target version or the deadline fires.
      const assetsColl = await assetsCollection();
      const deadline = Date.now() + TIMEOUT_MS;
      let doc: Record<string, unknown> | null = null;

      while (Date.now() < deadline) {
        doc = await assetsColl.findOne({ abs_path: file }) as Record<string, unknown> | null;
        if (doc?.stages) {
          const stages = doc.stages as Record<string, { version: number }>;
          if (
            stages.hash?.version === hashTarget &&
            stages.exif?.version === exifTarget &&
            stages.thumb?.version === thumbTarget
          ) {
            break;
          }
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      // Assertions.
      expect(doc).not.toBeNull();
      const stages = (doc!.stages as Record<string, { version: number }>);
      expect(stages.hash?.version).toBe(hashTarget);
      expect(stages.exif?.version).toBe(exifTarget);
      expect(stages.thumb?.version).toBe(thumbTarget);

      // The Plan 3 stages should still be at version 0 (untouched).
      expect(stages.face?.version).toBe(0);
      expect(stages.ocr?.version).toBe(0);

      // Clean up.
      await assetsColl.deleteOne({ abs_path: file });
    },
    TIMEOUT_MS + 5000,
  );
});
