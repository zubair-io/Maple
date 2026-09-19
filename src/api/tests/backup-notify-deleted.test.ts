/**
 * POST /api/libraries/:id/backup/notify-deleted — the device reporting photos
 * it no longer sees in Apple Photos.
 *
 * Runs against a private SQLite database installed as the process-wide handle
 * (#3787). The suite shares one database across the block on purpose: the
 * second test asserts that the first test's update left an asset linked to a
 * different device alone, which only means something if the update already ran.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { ObjectId } from '../src/db/object-id.ts';
import { authedHandle } from './helpers/authed-handle.ts';
import {
  createLiveTestDatabase,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { readAsset, seedBackupAsset, seedLibrary } from './helpers/sqlite-fixtures.ts';
import { invalidateLibraryRoots } from '../src/indexer/libraries.cache.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const deviceId = 'test-device-notify-deleted';
const phid1 = 'DEL/L0/001';
const phid2 = 'DEL/L0/002';
const phid3 = 'DEL/L0/003';

let live: LiveTestDatabase;
let libId: ObjectId;
let tmpLib: string;
let assetId1: ObjectId;
let assetId2: ObjectId;
let assetId3: ObjectId;

beforeAll(async () => {
  tmpLib = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-notify-del-test-'));
  live = await createLiveTestDatabase();
  libId = seedLibrary(live.db, { path: tmpLib, label: 'notify-deleted-test' });
  invalidateLibraryRoots();

  // The route scopes by a location in this library plus a device link, so each
  // asset carries both — the shape backup-ingest leaves behind.
  assetId1 = seedBackupAsset(live.db, {
    mapleId: 'del-maple-1',
    size: 64,
    locations: [{ libraryId: libId, relPath: 'IMG_DEL_1.HEIC' }],
    links: [{ deviceId, phassetLocalId: phid1 }],
  });
  assetId2 = seedBackupAsset(live.db, {
    mapleId: 'del-maple-2',
    size: 64,
    locations: [{ libraryId: libId, relPath: 'IMG_DEL_2.HEIC' }],
    links: [{ deviceId, phassetLocalId: phid2 }],
  });
  assetId3 = seedBackupAsset(live.db, {
    mapleId: 'del-maple-3',
    size: 64,
    locations: [{ libraryId: libId, relPath: 'IMG_DEL_3.HEIC' }],
    // Linked to a DIFFERENT device only — should NOT be updated.
    links: [{ deviceId: 'other-device', phassetLocalId: phid3 }],
  });
});

afterAll(async () => {
  live.close();
  invalidateLibraryRoots();
  await fs.rm(tmpLib, { recursive: true, force: true });
});

function notifyDeleted(
  body: object,
  headers: Record<string, string>,
  libOverride?: string,
): Request {
  const id = libOverride ?? libId.toHexString();
  return new Request(`http://localhost/api/libraries/${id}/backup/notify-deleted`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/libraries/:id/backup/notify-deleted', () => {
  test('happy path — marks matching assets deleted', async () => {
    const res = await authedHandle(
      notifyDeleted({ phasset_local_ids: [phid1, phid2] }, { 'X-Maple-Device-Id': deviceId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);

    expect(readAsset(live.db, assetId1)?.deleted_from_photos).toBe(1);
    expect(readAsset(live.db, assetId2)?.deleted_from_photos).toBe(1);
  });

  test('does not affect assets linked only to a different device', async () => {
    // assetId3 is linked to "other-device", not to deviceId.
    expect(readAsset(live.db, assetId3)?.deleted_from_photos).toBe(0);
  });

  test('empty phasset_local_ids → 200 with updated:0', async () => {
    const res = await authedHandle(
      notifyDeleted({ phasset_local_ids: [] }, { 'X-Maple-Device-Id': deviceId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(0);
  });

  test('unknown phid → 200 with updated:0 (no match, not an error)', async () => {
    const res = await authedHandle(
      notifyDeleted({ phasset_local_ids: ['UNKNOWN/L0/999'] }, { 'X-Maple-Device-Id': deviceId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(0);
  });

  test('missing X-Maple-Device-Id header → 400', async () => {
    const res = await authedHandle(notifyDeleted({ phasset_local_ids: [phid1] }, {}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('X-Maple-Device-Id');
  });

  test('missing phasset_local_ids field → 400', async () => {
    const res = await authedHandle(
      notifyDeleted({ ids: [phid1] }, { 'X-Maple-Device-Id': deviceId }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('phasset_local_ids');
  });

  test('phasset_local_ids is not an array → 400', async () => {
    const res = await authedHandle(
      notifyDeleted({ phasset_local_ids: 'not-an-array' }, { 'X-Maple-Device-Id': deviceId }),
    );
    expect(res.status).toBe(400);
  });

  test('library not found → 404', async () => {
    const res = await authedHandle(
      notifyDeleted(
        { phasset_local_ids: [phid1] },
        { 'X-Maple-Device-Id': deviceId },
        new ObjectId().toHexString(),
      ),
    );
    expect(res.status).toBe(404);
  });
});
