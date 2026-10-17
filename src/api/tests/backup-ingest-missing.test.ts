import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { insertStageState } from '../src/db/repos/assets.test-helpers.ts';
import { findAssetAtAddress } from '../src/db/repos/assets.address.ts';
import { runMissingReaperOnce } from '../src/workers/missing-reaper.ts';
import { authedHandle } from './helpers/authed-handle.ts';
import { readLocations, seedBackupAsset } from './helpers/sqlite-fixtures.ts';
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
      expect(await fs.readFile(path.join(handle.tmpLib, relPath))).toEqual(bytes);
      const locations = readLocations(handle.db, id);
      expect(locations).toHaveLength(1);
      expect(locations[0]?.missing_since).toBeNull();
      expect(locations[0]?.missing_reason).toBeNull();
      expect(await findMapleIdsPresentInLibrary([mapleId], handle.libId)).toEqual(
        new Set([mapleId]),
      );
      expect(await listBackupState(handle.libId, deviceId, new Date(0))).toHaveLength(1);
    });
  }

  test('repair preserves different bytes now occupying the missing path', async () => {
    const id = seedMissing(true);
    const replacement = Buffer.alloc(bytes.length, 0x7a);
    const oldPath = path.join(handle.tmpLib, relPath);
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.writeFile(oldPath, replacement);
    const res = await upload();
    expect(res.status).toBe(200);
    const repairedPath = (await res.json()).target_rel_path;
    expect(repairedPath).not.toBe(relPath);
    expect(await fs.readFile(oldPath)).toEqual(replacement);
    expect(await fs.readFile(path.join(handle.tmpLib, repairedPath))).toEqual(bytes);
    await runMissingReaperOnce({ deleteBeforeIso: '2026-10-01T00:00:00Z' });
    const locations = readLocations(handle.db, id);
    expect(locations).toHaveLength(1);
    expect(locations[0]?.filename).not.toBe('photo.HEIC');
    expect(await findMapleIdsPresentInLibrary([mapleId], handle.libId)).toEqual(new Set([mapleId]));
  });

  test('completed retry restores bytes when another file occupies its old path', async () => {
    const first = await upload();
    expect(first.status).toBe(200);
    const oldRelPath = (await first.json()).target_rel_path;
    const oldPath = path.join(handle.tmpLib, oldRelPath);
    const unrelated = Buffer.alloc(bytes.length, 0x6b);
    await fs.writeFile(oldPath, unrelated);
    handle.db.run(`UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00Z'`);
    const retry = await upload();
    expect(retry.status).toBe(200);
    const repairedPath = (await retry.json()).target_rel_path;
    expect(repairedPath).not.toBe(oldRelPath);
    expect(await fs.readFile(oldPath)).toEqual(unrelated);
    expect(await fs.readFile(path.join(handle.tmpLib, repairedPath))).toEqual(bytes);
    expect(await findMapleIdsPresentInLibrary([mapleId], handle.libId)).toEqual(new Set([mapleId]));
  });

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

  test('a completed upload session cannot conceal a subsequently lost copy', async () => {
    const first = await upload();
    expect(first.status).toBe(200);
    const originalPath = (await first.json()).target_rel_path;
    await fs.unlink(path.join(handle.tmpLib, originalPath));
    handle.db.run(`UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00Z'`);
    const retry = await upload();
    expect(retry.status).toBe(200);
    expect((await retry.json()).target_rel_path).toBe(originalPath);
    expect(await fs.readFile(path.join(handle.tmpLib, originalPath))).toEqual(bytes);
    expect(await findMapleIdsPresentInLibrary([mapleId], handle.libId)).toEqual(new Set([mapleId]));
  });
});
