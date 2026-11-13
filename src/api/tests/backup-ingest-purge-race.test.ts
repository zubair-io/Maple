/**
 * A durable purge admitted after the ingest route's lookup (#4913): the upload
 * must neither link the device to the purged asset nor leave a newly published
 * copy in the library, and withdrawing that copy must never remove a file
 * another writer put at the same name. Real SQLite and real files.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authedHandle } from './helpers/authed-handle.ts';
import { readLocations, seedBackupAsset } from './helpers/sqlite-fixtures.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';
import * as backupRepo from '../src/db/repos/backup.repo.ts';
import * as mirroredFs from '../src/fs/mirrored.ts';
import type { ObjectId } from '../src/db/object-id.ts';

const suite = setupBackupIngestSuite();
const { handle } = suite;
const ingest = makeIngestRequest(handle);
const mapleId = '5d1e0c7f3a9b42e6b8c4d2f1e0a9b8c7';
const bytes = Buffer.from('photo bytes uploaded while a purge is admitted');
const deviceId = 'purge-race-device';
const phassetLocalId = 'purge-race-photo';
const relPath = 'kept/photo.HEIC';

function upload() {
  return authedHandle(
    ingest(bytes, {
      'X-Maple-Device-Id': deviceId,
      'X-Maple-Phasset-Id': phassetLocalId,
      'X-Maple-Capture-Date': '2024-07-04T12:00:00Z',
      'X-Maple-Filename': 'photo.HEIC',
      'X-Maple-Total-Bytes': String(bytes.length),
      'X-Maple-Maple-Id': mapleId,
      'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
    }),
  );
}

function admitPurge(assetId: ObjectId) {
  handle.db.run(
    `INSERT INTO backup_lifecycle(id, asset_id, kind, phase, created_at)
     VALUES ('purge-race', ?, 'purge', 'prepared', '2026-10-21T00:00:00Z')`,
    [assetId.toHexString()],
  );
}

/** The purge lands just after the route read the asset as purge-free. */
function purgeAfterLookup(assetId: ObjectId) {
  const realLookup = backupRepo.findIngestDedupTarget;
  return spyOn(backupRepo, 'findIngestDedupTarget').mockImplementation(async (...args) => {
    const target = await realLookup(...args);
    if (target) admitPurge(assetId);
    return target;
  });
}

const linkCount = () =>
  handle.db
    .query<
      { n: number },
      [string]
    >('SELECT COUNT(*) AS n FROM asset_phasset_links WHERE device_id = ?')
    .get(deviceId)?.n;

describe('backup ingest and a purge admitted mid-request (#4913)', () => {
  beforeEach(suite.setup);
  afterEach(suite.teardown);

  test('a same-library dedup never links the device to a purged asset', async () => {
    const id = seedBackupAsset(handle.db, {
      mapleId,
      size: bytes.length,
      locations: [{ libraryId: handle.libId, relPath }],
    });
    await fs.mkdir(path.join(handle.tmpLib, 'kept'), { recursive: true });
    await fs.writeFile(path.join(handle.tmpLib, relPath), bytes);
    const lookup = purgeAfterLookup(id);
    try {
      expect((await upload()).status).toBe(409);
    } finally {
      lookup.mockRestore();
    }
    expect(linkCount()).toBe(0);
  });

  /** A backup tmp dir on another volume than the library: no hard links. */
  const crossDevice = (refused: boolean) =>
    refused
      ? spyOn(mirroredFs, 'link').mockRejectedValue(
          Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
        )
      : null;

  test.each([false, true])(
    'a repair that the purge refuses withdraws the copy it published (cross-device: %p)',
    async (refused) => {
      const link = crossDevice(refused);
      const id = seedBackupAsset(handle.db, {
        mapleId,
        size: bytes.length,
        locations: [{ libraryId: handle.libId, relPath }],
      });
      handle.db.run(`UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00Z'`);
      const lookup = purgeAfterLookup(id);
      try {
        expect((await upload()).status).toBe(409);
        if (link) expect(link).toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
        link?.mockRestore();
      }
      expect(await Bun.file(path.join(handle.tmpLib, relPath)).exists()).toBe(false);
      expect(readLocations(handle.db, id).map((l) => l.filename)).toEqual(['photo.HEIC']);
      expect(linkCount()).toBe(0);
    },
  );

  test.each([false, true])(
    "withdrawing the refused copy never removes another writer's file at that name (cross-device: %p)",
    async (refused) => {
      const link = crossDevice(refused);
      const id = seedBackupAsset(handle.db, {
        mapleId,
        size: bytes.length,
        locations: [{ libraryId: handle.libId, relPath }],
      });
      handle.db.run(`UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00Z'`);
      const competitor = Buffer.from('another writer saved this file meanwhile');
      const realAppend = backupRepo.appendBackupLocation;
      const append = spyOn(backupRepo, 'appendBackupLocation').mockImplementation(
        async (...args) => {
          const published = path.join(handle.tmpLib, relPath);
          const staged = `${published}.competitor`;
          await fs.writeFile(staged, competitor);
          await fs.rename(staged, published);
          admitPurge(id);
          return realAppend(...args);
        },
      );
      try {
        expect((await upload()).status).toBe(409);
      } finally {
        append.mockRestore();
        link?.mockRestore();
      }
      expect(await fs.readFile(path.join(handle.tmpLib, relPath))).toEqual(competitor);
    },
  );
});
