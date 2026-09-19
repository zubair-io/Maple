/**
 * Screenshot routing for the backup-ingest route.
 *
 * A screenshot detected at ingest (by the device-reported filename) lands in
 * `<year>/Screenshot` and seeds `is_screenshot` on the row, so the asset
 * matches its on-disk home before the EXIF stage runs. Split into its own file
 * to keep the 600-LOC budget on `backup-ingest.test.ts` clear.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * for each test (#3787), with the library rooted at a per-test tmp directory.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authedHandle } from './helpers/authed-handle.ts';
import { findAssetIdByMapleId, readAsset, readLocations } from './helpers/sqlite-fixtures.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';

const deviceId = 'test-device-screenshot';

const suite = setupBackupIngestSuite();
beforeEach(suite.setup);
afterEach(suite.teardown);

const ingest = makeIngestRequest(suite.handle);

/** The asset's single location row and its `is_screenshot` flag, by content id. */
function ingested(mapleId: string): { path: unknown; isScreenshot: unknown } {
  const assetId = findAssetIdByMapleId(suite.handle.db, mapleId);
  if (assetId === null) throw new Error(`no asset for maple_id ${mapleId}`);
  return {
    path: readLocations(suite.handle.db, assetId)[0]?.path,
    isScreenshot: readAsset(suite.handle.db, assetId)?.is_screenshot,
  };
}

describe('backup-ingest screenshot routing', () => {
  test('a Screenshot-named upload lands in <year>/Screenshot and flags is_screenshot', async () => {
    const bytes = Buffer.alloc(64, 9);
    const res = await authedHandle(
      ingest(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'SS/L0/001',
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'Screenshot 2024-03-15 at 10.04.32.png',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': '0282e60066a2de261b6653bcdda90d1c',
        // Note: a GPS fix is supplied to prove the screenshot folder wins over
        // the location layout.
        'X-Maple-Lat': '37.7749',
        'X-Maple-Lon': '-122.4194',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe('2024/Screenshot/Screenshot 2024-03-15 at 10.04.32.png');

    const row = ingested('0282e60066a2de261b6653bcdda90d1c');
    expect(row.path).toBe('2024/Screenshot');
    expect(row.isScreenshot).toBe(1);

    // And the bytes really landed there on disk.
    expect(
      await fs.readFile(
        path.join(suite.handle.tmpLib, '2024/Screenshot/Screenshot 2024-03-15 at 10.04.32.png'),
      ),
    ).toHaveLength(64);
  });

  test('a normal photo is unaffected (date fallback, is_screenshot false)', async () => {
    const bytes = Buffer.alloc(64, 3);
    const res = await authedHandle(
      ingest(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'SS/L0/002',
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'IMG_2024.HEIC',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': '0269a8aa01fe5537076d023dd5e9cc42',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe('2024/Misc/IMG_2024.HEIC');

    const row = ingested('0269a8aa01fe5537076d023dd5e9cc42');
    expect(row.path).toBe('2024/Misc');
    expect(row.isScreenshot).toBe(0);
  });

  test('a Screenshot-named VIDEO is not routed to <year>/Screenshot (#2325)', async () => {
    const bytes = Buffer.alloc(64, 7);
    const res = await authedHandle(
      ingest(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': 'SS/L0/003',
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        // A screen recording carries a screenshot-shaped name on some
        // devices. It is still a video, so it belongs in the normal date
        // layout, not the Screenshot folder.
        'X-Maple-Filename': 'Screenshot_20240315_103000.mp4',
        'X-Maple-Total-Bytes': '64',
        'X-Maple-Maple-Id': '0259712afe2eaf516245979e4a802972',
        'Content-Range': 'bytes 0-63/64',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.target_rel_path).toBe('2024/Misc/Screenshot_20240315_103000.mp4');

    const row = ingested('0259712afe2eaf516245979e4a802972');
    expect(row.path).toBe('2024/Misc');
    expect(row.isScreenshot).toBe(0);

    // And the bytes really landed outside the Screenshot folder.
    expect(
      await fs.readFile(path.join(suite.handle.tmpLib, '2024/Misc/Screenshot_20240315_103000.mp4')),
    ).toHaveLength(64);
  });
});
