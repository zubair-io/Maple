/**
 * The location row backup-ingest writes for a fresh upload.
 *
 * Split out of `backup-ingest.test.ts` because that file is already at the
 * 600-LOC hard budget. The route logic itself is exercised by the parent test
 * file; this one isolates the content-addressing assertions — what used to be
 * `fileinfo[0]` is now the asset's single `asset_locations` row (#3787), and
 * the two tests read the same one, so the suite shares one database across the
 * block.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { authedHandle } from './helpers/authed-handle.ts';
import { findAssetIdByMapleId, readLocations } from './helpers/sqlite-fixtures.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';

const deviceId = 'test-device-fileinfo';
const phid = 'FI/L0/001';
const mapleId = '0296473a13ba7b62635db695bbc3e728';

const suite = setupBackupIngestSuite();
beforeAll(suite.setup);
afterAll(suite.teardown);

const ingest = makeIngestRequest(suite.handle);

describe('backup-ingest writes the asset location', () => {
  test('insert: the location mirrors target_rel_path split into (path, filename, library_id)', async () => {
    const bytes = Buffer.alloc(128, 7);
    const res = await authedHandle(
      ingest(bytes, {
        'X-Maple-Device-Id': deviceId,
        'X-Maple-Phasset-Id': phid,
        'X-Maple-Capture-Date': '2024-03-15T10:30:00Z',
        'X-Maple-Filename': 'IMG_FI.HEIC',
        'X-Maple-Total-Bytes': '128',
        'X-Maple-Maple-Id': mapleId,
        // No GPS → path-formatter falls back to date-only buckets.
        'Content-Range': 'bytes 0-127/128',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    const assetId = findAssetIdByMapleId(suite.handle.db, mapleId);
    expect(assetId).not.toBeNull();
    const locations = readLocations(suite.handle.db, assetId!);
    expect(locations).toHaveLength(1);
    // path = directory part of body.target_rel_path; filename = basename.
    const expectedDir = path.dirname(body.target_rel_path);
    expect(locations[0].path).toBe(expectedDir === '.' ? '' : expectedDir);
    expect(locations[0].filename).toBe('IMG_FI.HEIC');
    expect(locations[0].library_id).toBe(suite.handle.libId.toHexString());
  });

  test('the stored path stays POSIX (forward-slashed) even on hosts where path.sep is \\', async () => {
    // This is a contract pin — the insert path normalizes path.sep → '/'.
    // On Linux/macOS (the test environment) path.sep is already '/', so we
    // just confirm no backslashes leak into storage.
    const assetId = findAssetIdByMapleId(suite.handle.db, mapleId);
    expect(assetId).not.toBeNull();
    expect(readLocations(suite.handle.db, assetId!)[0].path).not.toContain('\\');
  });
});
