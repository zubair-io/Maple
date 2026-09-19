/**
 * Smoke test: in-process stage runners + exif + thumb + discover.
 *
 * Drops a JPEG into a registered temp library, drives discover's producer
 * directly, and waits up to 30 s for both pipeline stages to reach their target
 * version. The legacy `hash` stage was retired in the drop-abs-path-2026-05-21
 * migration once discover began writing maple_id + sha1_head inline at insert.
 *
 * Runs against a real SQLite database installed as the process-wide handle, so
 * discover's insert, the two poll loops and this file's assertions are all
 * looking at the same rows. The stage bookkeeping this asserts on is
 * `stage_state`, one row per (asset, stage), rather than a `stages` subdocument
 * on the asset.
 */
import { describe, expect, it, afterAll, beforeAll } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from '../db/object-id.ts';
import { solidJpeg } from '../test-support/synth-image.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';

const TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

describe('workers smoke test', () => {
  let live: LiveTestDatabase;
  let dir: string;
  let libraryId: ObjectId;
  let stageHandles: Array<{ stop: () => Promise<void> }> = [];
  let discoverHandle: { stop: () => Promise<void> } | null = null;

  beforeAll(async () => {
    live = await createLiveTestDatabase();
    dir = await mkdtemp(path.join(os.tmpdir(), 'smoke-test-'));
    libraryId = new ObjectId(insertFolder(live.db, { path: dir }));
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    if (discoverHandle) await discoverHandle.stop();
    await Promise.all(stageHandles.map((h) => h.stop().catch(() => {})));
    invalidateLibraryRoots();
    live.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** Every stage's recorded version for one asset. */
  function stageVersions(assetId: string): Record<string, number> {
    const rows = live.db
      .query(`SELECT stage, version FROM stage_state WHERE asset_id = ?`)
      .all(assetId) as { stage: string; version: number }[];
    return Object.fromEntries(rows.map((row) => [row.stage, row.version]));
  }

  /** The asset discover inserted for `filename`, or null before it lands. */
  function assetIdFor(filename: string): string | null {
    const row = live.db
      .query(`SELECT asset_id FROM asset_locations WHERE filename = ?`)
      .get(filename) as { asset_id: string } | null;
    return row?.asset_id ?? null;
  }

  it(
    'exif + thumb both reach their target version after a file is dropped',
    async () => {
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
      await writeFile(file, await solidJpeg(64, 64, [80, 120, 180]));

      // Chokidar uses polling with a 60s/300s interval — too slow for a 30s
      // smoke test. Drive discover's handleEvent directly to insert the row
      // immediately, then let the stage children pick it up on their next poll.
      const { handleEvent } = await import('./discover/index.ts');
      await handleEvent({ kind: 'created', absPath: file }, libraryId, dir);

      // Poll until both stages reach their target version or the deadline fires.
      const deadline = Date.now() + TIMEOUT_MS;
      let assetId: string | null = null;
      let versions: Record<string, number> = {};

      while (Date.now() < deadline) {
        assetId = assetIdFor('smoke.jpg');
        if (assetId !== null) {
          versions = stageVersions(assetId);
          if (versions['exif'] === exifTarget && versions['thumb'] === thumbTarget) break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      expect(assetId).not.toBeNull();
      expect(versions['exif']).toBe(exifTarget);
      expect(versions['thumb']).toBe(thumbTarget);

      // The Plan 3 stages should still be at version 0 (seeded, untouched).
      expect(versions['face-detect']).toBe(0);
      expect(versions['face-embed']).toBe(0);
    },
    TIMEOUT_MS + 5000,
  );
});
