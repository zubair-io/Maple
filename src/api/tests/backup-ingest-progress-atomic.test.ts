/**
 * The per-device progress counter commits with the catalog write (#5174): when
 * the counter update fails the upload fails whole, so the retry counts it once
 * instead of finding the photo already catalogued and adding nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadSessions } from '../src/backup/upload-session.ts';
import { authedHandle } from './helpers/authed-handle.ts';
import { seedBackupAsset, seedLibrary } from './helpers/sqlite-fixtures.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';

const suite = setupBackupIngestSuite();
const { handle } = suite;
const ingest = makeIngestRequest(handle);
const mapleId = '02e759ceff3390dab8d6cd1425d1e196';
const bytes = Buffer.from('original photo bytes for the progress counter');
const deviceId = 'progress-device';
const relPath = 'album/photo.HEIC';

function upload() {
  return authedHandle(
    ingest(bytes, {
      'X-Maple-Device-Id': deviceId,
      'X-Maple-Phasset-Id': 'progress-photo',
      'X-Maple-Capture-Date': '2024-07-04T12:00:00Z',
      'X-Maple-Filename': 'photo.HEIC',
      'X-Maple-Total-Bytes': String(bytes.length),
      'X-Maple-Maple-Id': mapleId,
      'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
    }),
  );
}

function uploadedCount(): number {
  const row = handle.db.query(`SELECT uploaded_count FROM backup_sessions`).get() as {
    uploaded_count: number;
  } | null;
  return row?.uploaded_count ?? 0;
}

async function failProgressThenRetry() {
  handle.db.run(`CREATE TRIGGER fail_progress BEFORE INSERT ON backup_sessions
    BEGIN SELECT RAISE(ABORT, 'injected progress failure'); END`);
  expect((await upload()).status).toBe(500);
  handle.db.run('DROP TRIGGER fail_progress');
  await uploadSessions.resetAllInProgressBytes();
  expect((await upload()).status).toBe(200);
}

describe('backup progress commits with the catalog write (#5174)', () => {
  beforeEach(suite.setup);
  afterEach(suite.teardown);

  test('a first upload is counted once after the counter update failed', async () => {
    await failProgressThenRetry();
    expect(uploadedCount()).toBe(1);
  });

  test('linking a new device to a photo the library holds is counted once', async () => {
    seedBackupAsset(handle.db, {
      mapleId,
      size: bytes.length,
      locations: [{ libraryId: handle.libId, relPath }],
    });
    await fs.mkdir(path.join(handle.tmpLib, 'album'), { recursive: true });
    await fs.writeFile(path.join(handle.tmpLib, relPath), bytes);
    await failProgressThenRetry();
    expect(uploadedCount()).toBe(1);
    expect(handle.db.query(`SELECT COUNT(*) AS n FROM asset_phasset_links`).get()).toEqual({
      n: 1,
    });
  });

  test('copying a linked photo into this library is counted once', async () => {
    const otherLibrary = seedLibrary(handle.db, { path: `${handle.tmpLib}-other`, label: 'other' });
    seedBackupAsset(handle.db, {
      mapleId,
      size: bytes.length,
      locations: [{ libraryId: otherLibrary, relPath }],
      links: [{ deviceId, phassetLocalId: 'progress-photo' }],
    });
    await failProgressThenRetry();
    expect(uploadedCount()).toBe(1);
  });
});
