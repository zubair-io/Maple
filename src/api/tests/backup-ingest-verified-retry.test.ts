/**
 * Byte-verified backup retries (#4905): a completed session or a stored path
 * never proves the original bytes still live there, and a retry after a crash
 * between publication and the catalog write adopts the copy it published
 * rather than writing another. Real SQLite and real files.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadSessions } from '../src/backup/upload-session.ts';
import { insertStageState } from '../src/db/repos/assets.test-helpers.ts';
import { authedHandle } from './helpers/authed-handle.ts';
import { readLocations, seedBackupAsset } from './helpers/sqlite-fixtures.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';
import { findMapleIdsPresentInLibrary, listBackupState } from '../src/db/repos/backup.repo.ts';

const suite = setupBackupIngestSuite();
const { handle } = suite;
const ingest = makeIngestRequest(handle);
const mapleId = '02e759ceff3390dab8d6cd1425d1e196';
const bytes = Buffer.from('original photo bytes for missing-copy recovery');
const deviceId = 'missing-copy-device';
const phassetLocalId = 'missing-copy-photo';
const relPath = 'previous-layout/photo.HEIC';

function upload(start = 0, end = bytes.length - 1) {
  return authedHandle(
    ingest(bytes.subarray(start, end + 1), {
      'X-Maple-Device-Id': deviceId,
      'X-Maple-Phasset-Id': phassetLocalId,
      'X-Maple-Capture-Date': '2024-07-04T12:00:00Z',
      'X-Maple-Filename': 'photo.HEIC',
      'X-Maple-Total-Bytes': String(bytes.length),
      'X-Maple-Maple-Id': mapleId,
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
    }),
  );
}

function seedMissing(markMissing: boolean) {
  const id = seedBackupAsset(handle.db, {
    mapleId,
    size: bytes.length,
    locations: [{ libraryId: handle.libId, relPath }],
    links: [{ deviceId, phassetLocalId }],
  });
  if (markMissing)
    handle.db.run(
      `UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00Z',
      missing_reason = 'watcher' WHERE asset_id = ?`,
      [id.toHexString()],
    );
  return id;
}

async function expectStored(storedPath: string) {
  expect(await fs.readFile(path.join(handle.tmpLib, storedPath))).toEqual(bytes);
  expect(await findMapleIdsPresentInLibrary([mapleId], handle.libId)).toEqual(new Set([mapleId]));
  expect(await listBackupState(handle.libId, deviceId, new Date(0))).toHaveLength(1);
}

describe('byte-verified backup retries (#4905)', () => {
  beforeEach(suite.setup);
  afterEach(suite.teardown);

  test('retry adopts a repair sibling published before its location transaction failed', async () => {
    const id = seedMissing(true);
    const oldPath = path.join(handle.tmpLib, relPath);
    const unrelated = Buffer.alloc(bytes.length, 0x6b);
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.writeFile(oldPath, unrelated);
    handle.db.run('DELETE FROM asset_phasset_links');
    handle.db.run(`CREATE TRIGGER fail_repair BEFORE INSERT ON asset_phasset_links
      WHEN NEW.asset_id = '${id.toHexString()}'
      BEGIN SELECT RAISE(ABORT, 'injected location transaction failure'); END`);
    expect((await upload()).status).toBe(500);
    const publishedPath = 'previous-layout/photo-1.HEIC';
    expect(await fs.readFile(path.join(handle.tmpLib, publishedPath))).toEqual(bytes);
    expect(readLocations(handle.db, id)[0]?.filename).toBe('photo.HEIC');
    handle.db.run('DROP TRIGGER fail_repair');
    // Production boot recovery rewinds unfinished chunk sessions.
    await uploadSessions.resetAllInProgressBytes();
    const retry = await upload();
    expect(retry.status).toBe(200);
    expect((await retry.json()).target_rel_path).toBe(publishedPath);
    await expectStored(publishedPath);
    expect(await fs.readFile(oldPath)).toEqual(unrelated);
    expect((await fs.readdir(path.dirname(oldPath))).toSorted()).toEqual([
      'photo-1.HEIC',
      'photo.HEIC',
    ]);
    expect(readLocations(handle.db, id)).toHaveLength(1);
    expect(readLocations(handle.db, id)[0]?.ordinal).toBe(0);
  });

  for (const occupied of [false, true]) {
    test(`completed retry restores a lost copy (old path occupied: ${occupied})`, async () => {
      const first = await upload();
      expect(first.status).toBe(200);
      const originalPath = (await first.json()).target_rel_path;
      const oldPath = path.join(handle.tmpLib, originalPath);
      const unrelated = Buffer.alloc(bytes.length, 0x6b);
      if (occupied) await fs.writeFile(oldPath, unrelated);
      else await fs.unlink(oldPath);
      if (!occupied)
        handle.db.run(`UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00Z'`);
      const retry = await upload();
      expect(retry.status).toBe(200);
      const repairedPath = (await retry.json()).target_rel_path;
      if (occupied) {
        expect(repairedPath).not.toBe(originalPath);
        expect(await fs.readFile(oldPath)).toEqual(unrelated);
      } else expect(repairedPath).toBe(originalPath);
      await expectStored(repairedPath);
    });
  }

  test('same-library dedup verifies unmarked occupants and rearms path caches', async () => {
    const id = seedMissing(false);
    const old = path.join(handle.tmpLib, relPath);
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.writeFile(old, Buffer.alloc(bytes.length, 0x7a));
    for (const stage of ['thumb', 'preview', 'describe', 'exif'])
      insertStageState(handle.db, id.toHexString(), stage, {
        version: 7,
        dead: stage !== 'exif',
      });
    const res = await upload();
    expect(res.status).toBe(200);
    const repairedPath = (await res.json()).target_rel_path;
    for (const stage of ['thumb', 'preview', 'describe', 'exif'])
      expect(
        handle.db
          .query('SELECT version, dead FROM stage_state WHERE asset_id = ? AND stage = ?')
          .get(id.toHexString(), stage),
      ).toEqual({
        version: stage === 'describe' || stage === 'exif' ? 7 : 0,
        dead: stage === 'describe' ? 1 : 0,
      });
    expect(repairedPath).not.toBe(relPath);
  });

  test('partial completed-session retry consumes every chunk before dedup', async () => {
    const first = await upload();
    const originalPath = (await first.json()).target_rel_path;
    const split = Math.floor(bytes.length / 2);
    const firstChunk = await upload(0, split - 1);
    expect(firstChunk.status).toBe(202);
    expect((await firstChunk.json()).next_offset).toBe(split);
    const lastChunk = await upload(split);
    expect(lastChunk.status).toBe(200);
    expect((await lastChunk.json()).target_rel_path).toBe(originalPath);
    expect(await fs.readFile(path.join(handle.tmpLib, originalPath))).toEqual(bytes);
    expect(handle.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({
      n: 1,
    });
  });
});
