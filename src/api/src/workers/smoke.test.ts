/**
 * Smoke test: in-process stage runners + exif + thumb + discover.
 *
 * Drops a JPEG into a temp dir, waits up to 30 s for both pipeline stages to
 * complete, then asserts stage versions on the image doc. The legacy `hash`
 * stage was retired in the drop-abs-path-2026-05-21 migration once discover
 * began writing maple_id + sha1_head inline at insert.
 *
 * Requires a running MongoDB (skips if unreachable).
 */
import { describe, expect, it, afterAll } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';

const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

describe('workers smoke test', () => {
  let dir: string;
  let stageHandles: Array<{ stop: () => Promise<void> }> = [];
  let discoverHandle: { stop: () => Promise<void> } | null = null;

  afterAll(async () => {
    if (discoverHandle) await discoverHandle.stop();
    await Promise.all(stageHandles.map((h) => h.stop().catch(() => {})));
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(
    'exif + thumb both reach their target version after a file is dropped',
    async () => {
      // Connect to Mongo — skip if unavailable.
      let db: import('mongodb').Db;
      try {
        const { getDb } = await import('../db/client.ts');
        db = await getDb();
      } catch {
        console.log('MongoDB unreachable — skipping smoke test');
        return;
      }

      dir = await mkdtemp(path.join(os.tmpdir(), 'smoke-test-'));

      // Use a fresh ObjectId as folderId — the stage pipeline keys on
      // abs_path, not the folder row, so we don't need a real folder doc.
      const { ObjectId } = await import('mongodb');
      const { assetsCollection } = await import('../db/client.ts');
      const folderId = new ObjectId().toHexString();

      // Start only the two stages this smoke test needs, and the discover
      // watcher pointed at the temp dir.
      const { startExifStage } = await import('./stages/exif.ts');
      const { startThumbStage } = await import('./stages/thumb.ts');
      const { startDiscover } = await import('./discover/index.ts');
      stageHandles = await Promise.all([startExifStage(), startThumbStage()]);
      discoverHandle = await startDiscover({ roots: [dir] });

      // Read each stage's current target version rather than hardcoding —
      // the smoke test should track bumps (e.g. exif v1 → v2 for the GPS
      // hemisphere-ref fix) without a parallel edit here.
      const exifTarget = (await import('./stages/exif.ts')).default.targetVersion;
      const thumbTarget = (await import('./stages/thumb.ts')).default.targetVersion;

      // Drop a JPEG.
      const file = path.join(dir, 'smoke.jpg');
      const buf = await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 80, g: 120, b: 180 } },
      })
        .jpeg()
        .toBuffer();
      await writeFile(file, buf);

      // Chokidar uses polling with a 60s/300s interval — too slow for a 30s
      // smoke test. Drive discover's handleEvent directly to insert the doc
      // immediately, then let the stage children pick it up on their next poll.
      const { handleEvent } = await import('./discover/index.ts');
      await handleEvent({ kind: 'created', absPath: file }, new ObjectId(folderId), dir);

      // Poll until both stages reach their target version or the deadline fires.
      const assetsColl = await assetsCollection();
      const deadline = Date.now() + TIMEOUT_MS;
      let doc: Record<string, unknown> | null = null;

      while (Date.now() < deadline) {
        doc = (await assetsColl.findOne({
          'fileinfo.filename': 'smoke.jpg',
        })) as Record<string, unknown> | null;
        if (doc?.stages) {
          const stages = doc.stages as Record<string, { version: number }>;
          if (stages.exif?.version === exifTarget && stages.thumb?.version === thumbTarget) {
            break;
          }
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      // Assertions.
      expect(doc).not.toBeNull();
      const stages = doc!.stages as Record<string, { version: number }>;
      expect(stages.exif?.version).toBe(exifTarget);
      expect(stages.thumb?.version).toBe(thumbTarget);

      // The Plan 3 stages should still be at version 0 (untouched).
      expect(stages['face-detect']?.version).toBe(0);
      expect(stages['face-embed']?.version).toBe(0);

      // Clean up.
      await assetsColl.deleteOne({ _id: doc!._id as never });
    },
    TIMEOUT_MS + 5000,
  );
});
