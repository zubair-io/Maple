import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { insertStageState } from '../src/db/repos/assets.test-helpers.ts';
import { findAssetAtAddress } from '../src/db/repos/assets.address.ts';
import { runMissingReaperOnce } from '../src/workers/missing-reaper.ts';
import { authedHandle } from './helpers/authed-handle.ts';
import { insertLocation } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { readLocations, seedBackupAsset, seedLibrary } from './helpers/sqlite-fixtures.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';
import {
  findIngestDedupTarget,
  findMapleIdsPresentInLibrary,
  listBackupState,
} from '../src/db/repos/backup.repo.ts';

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

describe('backup missing-copy recovery', () => {
  beforeEach(suite.setup);
  afterEach(suite.teardown);

  test('missing locations are absent from dedup probes and reconciliation', async () => {
    seedMissing(true);
    expect(await findMapleIdsPresentInLibrary([mapleId], handle.libId)).toEqual(new Set());
    expect(await listBackupState(handle.libId, deviceId, new Date(0))).toEqual([]);
    const target = await findIngestDedupTarget({
      mapleId,
      libraryId: handle.libId,
      deviceId,
      phassetLocalId,
    });
    expect(target?.liveRelPathInLibrary).toBeNull();
  });

  for (const markedMissing of [true, false]) {
    test(`repair restores the original path (watcher marked missing: ${markedMissing})`, async () => {
      const id = seedMissing(markedMissing);
      const res = await upload();
      expect(res.status).toBe(200);
      expect((await res.json()).target_rel_path).toBe(relPath);
      await expectStored(relPath);
      const locations = readLocations(handle.db, id);
      expect(locations).toHaveLength(1);
      expect(locations[0]?.missing_since).toBeNull();
      expect(locations[0]?.missing_reason).toBeNull();
    });
  }

  for (const reservedSibling of [false, true]) {
    test(`sibling repair preserves canonical ordinal and catalog ownership (reserved: ${reservedSibling})`, async () => {
      const id = seedMissing(true);
      const movedStages = ['thumb', 'preview', 'cloud-backup'];
      for (const stage of movedStages)
        insertStageState(handle.db, id.toHexString(), stage, {
          version: 7,
          attempts: 2,
          dead: true,
          lastError: 'missing original',
          processedAt: '2026-01-01T00:00:00Z',
          claimToken: 'stale-lease',
          nextAttemptAt: '2026-10-20T00:00:00Z',
        });
      const otherLibrary = seedLibrary(handle.db, {
        path: path.join(handle.tmpLib, 'other-library'),
      });
      insertLocation(handle.db, {
        assetId: id.toHexString(),
        libraryId: otherLibrary.toHexString(),
        ordinal: 1,
        path: '',
        filename: 'other.HEIC',
      });
      const reservedPath = 'previous-layout/photo-1.HEIC';
      if (reservedSibling) {
        const owner = seedBackupAsset(handle.db, {
          locations: [{ libraryId: handle.libId, relPath: reservedPath }],
        });
        handle.db.run(
          `UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00Z' WHERE asset_id = ?`,
          [owner.toHexString()],
        );
      }
      const replacement = Buffer.alloc(bytes.length, 0x7a);
      const oldPath = path.join(handle.tmpLib, relPath);
      await fs.mkdir(path.dirname(oldPath), { recursive: true });
      await fs.writeFile(oldPath, replacement);
      const res = await upload();
      expect(res.status).toBe(200);
      const repairedPath = (await res.json()).target_rel_path;
      expect(repairedPath).not.toBe(relPath);
      expect(await fs.readFile(oldPath)).toEqual(replacement);
      await expectStored(repairedPath);
      expect(
        handle.db
          .query(
            `SELECT stage, version, attempts, dead, last_error,
        next_attempt_at, claim_token, processed_at FROM stage_state WHERE asset_id = ?
        AND stage IN ('thumb', 'preview', 'cloud-backup') ORDER BY stage`,
          )
          .all(id.toHexString()),
      ).toEqual(
        movedStages
          .toSorted()
          .map((stage) => ({
            stage,
            version: 0,
            attempts: 0,
            dead: 0,
            last_error: null,
            next_attempt_at: null,
            claim_token: null,
            processed_at: '2026-01-01T00:00:00Z',
          })),
      );
      if (reservedSibling)
        expect(await Bun.file(path.join(handle.tmpLib, reservedPath)).exists()).toBe(false);
      await runMissingReaperOnce({ deleteBeforeIso: '2026-10-01T00:00:00Z' });
      const locations = readLocations(handle.db, id);
      expect(locations).toHaveLength(2);
      expect(locations[0]?.ordinal).toBe(0);
      expect(locations[0]?.filename).not.toBe('photo.HEIC');
    });
  }

  test('retry adopts a repair sibling published before its location transaction failed', async () => {
    const id = seedMissing(true);
    const oldPath = path.join(handle.tmpLib, relPath);
    const unrelated = Buffer.alloc(bytes.length, 0x6b);
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.writeFile(oldPath, unrelated);
    handle.db.run(`CREATE TRIGGER fail_repair BEFORE UPDATE OF path, filename ON asset_locations
      WHEN OLD.asset_id = '${id.toHexString()}'
      BEGIN SELECT RAISE(ABORT, 'injected location transaction failure'); END`);
    expect((await upload()).status).toBe(500);
    const publishedPath = 'previous-layout/photo-1.HEIC';
    expect(await fs.readFile(path.join(handle.tmpLib, publishedPath))).toEqual(bytes);
    expect(readLocations(handle.db, id)[0]?.filename).toBe('photo.HEIC');
    handle.db.run('DROP TRIGGER fail_repair');
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

  for (const reaped of [true, false]) {
    test(`repair revives only reaped assets (reaped: ${reaped})`, async () => {
      const id = seedMissing(true);
      const deletedAt = '2026-01-02T00:00:00Z';
      insertStageState(handle.db, id.toHexString(), 'thumb');
      insertStageState(handle.db, id.toHexString(), 'embed', { version: 3 });
      if (reaped) {
        // Keep the root available so the real reaper can confirm the loss.
        await fs.writeFile(path.join(handle.tmpLib, 'sentinel.txt'), 'root available');
        await runMissingReaperOnce({ deleteBeforeIso: '2026-10-01T00:00:00Z' });
      } else {
        handle.db.run(`UPDATE assets SET deleted_at = ?, deleted_reason = NULL WHERE id = ?`, [
          deletedAt,
          id.toHexString(),
        ]);
      }
      const deletion = () =>
        handle.db
          .query('SELECT deleted_at, deleted_reason FROM assets WHERE id = ?')
          .get(id.toHexString()) as { deleted_at: string | null; deleted_reason: string | null };
      expect(deletion().deleted_at).not.toBeNull();
      expect(deletion().deleted_reason).toBe(reaped ? 'reaped' : null);
      expect(await findAssetAtAddress(handle.libId, 'previous-layout', 'photo.HEIC')).toBeNull();
      const res = await upload();
      expect(res.status).toBe(200);
      expect(await fs.readFile(path.join(handle.tmpLib, relPath))).toEqual(bytes);
      const visible = await findAssetAtAddress(handle.libId, 'previous-layout', 'photo.HEIC');
      expect(visible?._id.toHexString() ?? null).toBe(reaped ? id.toHexString() : null);
      expect(deletion()).toEqual({ deleted_at: reaped ? null : deletedAt, deleted_reason: null });
      expect(
        handle.db
          .query('SELECT asset_claimable FROM stage_state WHERE asset_id = ? AND stage = ?')
          .get(id.toHexString(), 'thumb'),
      ).toEqual({ asset_claimable: reaped ? 1 : 0 });
      expect(
        handle.db
          .query('SELECT version FROM stage_state WHERE asset_id = ? AND stage = ?')
          .get(id.toHexString(), 'embed'),
      ).toEqual({ version: reaped ? 0 : 3 });
    });
  }

  for (const reaped of [false, true]) {
    test(`verified completed retry reconciles returned bytes (reaped: ${reaped})`, async () => {
      const first = await upload();
      const storedPath = (await first.json()).target_rel_path;
      await fs.unlink(path.join(handle.tmpLib, storedPath));
      const assetId = (
        handle.db.query('SELECT id FROM assets WHERE maple_id = ?').get(mapleId) as { id: string }
      ).id;
      handle.db.run('UPDATE asset_locations SET ordinal = 1 WHERE asset_id = ?', [assetId]);
      insertLocation(handle.db, {
        assetId,
        libraryId: handle.libId.toHexString(),
        ordinal: 0,
        path: '',
        filename: 'other-missing.HEIC',
      });
      handle.db.run(`UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00Z'`);
      if (reaped) {
        await fs.writeFile(path.join(handle.tmpLib, 'sentinel.txt'), 'root available');
        await runMissingReaperOnce({ deleteBeforeIso: '2026-10-01T00:00:00Z' });
      }
      await fs.writeFile(path.join(handle.tmpLib, storedPath), bytes);
      expect((await upload()).status).toBe(200);
      await expectStored(storedPath);
      expect(
        await findAssetAtAddress(handle.libId, path.posix.dirname(storedPath), 'photo.HEIC'),
      ).not.toBeNull();
    });
  }

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
    expect(handle.db.query('SELECT COUNT(*) AS n FROM assets').get()).toEqual({ n: 1 });
  });
});
