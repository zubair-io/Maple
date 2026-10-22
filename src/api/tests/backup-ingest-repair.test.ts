import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadSessions } from '../src/backup/upload-session.ts';
import { insertStageState } from '../src/db/repos/assets.test-helpers.ts';
import { findAssetAtAddress } from '../src/db/repos/assets.address.ts';
import { runMissingReaperOnce } from '../src/workers/missing-reaper.ts';
import { authedHandle } from './helpers/authed-handle.ts';
import { insertLocation } from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { readLocations, seedBackupAsset, seedLibrary } from './helpers/sqlite-fixtures.ts';
import { makeIngestRequest, setupBackupIngestSuite } from './backup-ingest-helpers.ts';
import {
  appendBackupLocation,
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
  for (const reservedSibling of [false, true]) {
    test(`sibling repair preserves canonical ordinal and catalog ownership (reserved: ${reservedSibling})`, async () => {
      const id = seedMissing(true);
      const movedStages = ['thumb', 'preview', 'cloud-backup'];
      for (const stage of movedStages) {
        insertStageState(handle.db, id.toHexString(), stage, {
          version: 7,
          dead: true,
        });
      }
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
      const xmp = path.join(handle.tmpLib, 'previous-layout/photo.xmp');
      await fs.mkdir(path.dirname(xmp), { recursive: true });
      await fs.writeFile(xmp, '<x:xmpmeta>unrelated edit</x:xmpmeta>');
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
      if (reservedSibling)
        expect(await Bun.file(path.join(handle.tmpLib, reservedPath)).exists()).toBe(false);
      await runMissingReaperOnce({ deleteBeforeIso: '2026-10-01T00:00:00Z' });
      const locations = readLocations(handle.db, id);
      expect(locations).toHaveLength(2);
      expect(locations[0]?.ordinal).toBe(0);
      expect(locations[0]?.filename).not.toBe('photo.HEIC');
      expect(await fs.readFile(xmp, 'utf8')).toBe('<x:xmpmeta>unrelated edit</x:xmpmeta>');
      for (const stage of ['thumb', 'preview', 'cloud-backup']) {
        expect(
          handle.db
            .query('SELECT version, dead FROM stage_state WHERE asset_id = ? AND stage = ?')
            .get(id.toHexString(), stage),
        ).toEqual({ version: 0, dead: 0 });
      }
    });
  }
  for (const existingSibling of [false, true]) {
    test(`repair reconciles siblings and dead EXIF (existing sibling: ${existingSibling})`, async () => {
      const id = seedMissing(true);
      if (existingSibling)
        insertLocation(handle.db, {
          assetId: id.toHexString(),
          libraryId: handle.libId.toHexString(),
          ordinal: 1,
          path: 'previous-layout',
          filename: 'photo-1.HEIC',
        });
      handle.db.run(
        "UPDATE asset_locations SET missing_since = '2026-01-01T00:00:00Z' WHERE asset_id = ?",
        [id.toHexString()],
      );
      insertStageState(handle.db, id.toHexString(), 'exif', {
        version: 7,
        dead: true,
      });
      insertStageState(handle.db, id.toHexString(), 'describe', {
        version: 7,
      });
      const old = path.join(handle.tmpLib, relPath);
      await fs.mkdir(path.dirname(old), { recursive: true });
      await fs.writeFile(old, Buffer.alloc(bytes.length, 0x7a));
      const res = await upload();
      expect(res.status).toBe(200);
      expect((await res.json()).target_rel_path).toBe('previous-layout/photo-1.HEIC');
      expect(readLocations(handle.db, id)).toHaveLength(1);
      expect(readLocations(handle.db, id)[0]?.ordinal).toBe(0);
      expect(
        handle.db
          .query("SELECT version, dead FROM stage_state WHERE asset_id = ? AND stage = 'exif'")
          .get(id.toHexString()),
      ).toEqual({ version: 0, dead: 0 });
      expect(
        handle.db
          .query("SELECT version, dead FROM stage_state WHERE asset_id = ? AND stage = 'describe'")
          .get(id.toHexString()),
      ).toEqual({ version: 7, dead: 0 });
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
          .get(id.toHexString()) as {
          deleted_at: string | null;
          deleted_reason: string | null;
        };
      expect(deletion().deleted_at).not.toBeNull();
      expect(deletion().deleted_reason).toBe(reaped ? 'reaped' : null);
      expect(await findAssetAtAddress(handle.libId, 'previous-layout', 'photo.HEIC')).toBeNull();
      const res = await upload();
      expect(res.status).toBe(200);
      expect(await fs.readFile(path.join(handle.tmpLib, relPath))).toEqual(bytes);
      const visible = await findAssetAtAddress(handle.libId, 'previous-layout', 'photo.HEIC');
      expect(visible?._id.toHexString() ?? null).toBe(reaped ? id.toHexString() : null);
      expect(deletion()).toEqual({
        deleted_at: reaped ? null : deletedAt,
        deleted_reason: null,
      });
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

  test('purge admission refuses reaped repair before publishing bytes', async () => {
    const id = seedMissing(true);
    await fs.writeFile(path.join(handle.tmpLib, 'sentinel.txt'), 'root available');
    await runMissingReaperOnce({ deleteBeforeIso: '2026-10-01T00:00:00Z' });
    handle.db.run(
      `INSERT INTO backup_lifecycle(id, asset_id, kind, phase, created_at)
       VALUES(?, ?, 'purge', 'applied', ?)`,
      [crypto.randomUUID(), id.toHexString(), new Date().toISOString()],
    );
    const response = await upload();
    expect(response.status).toBe(409);
    expect((await upload()).status).toBe(409);
    expect(await Bun.file(path.join(handle.tmpLib, relPath)).exists()).toBe(false);
    expect(readLocations(handle.db, id)[0]?.missing_since).not.toBeNull();
    expect(
      handle.db.query('SELECT deleted_reason FROM assets WHERE id = ?').get(id.toHexString()),
    ).toEqual({ deleted_reason: 'reaped' });
    await expect(
      appendBackupLocation(id, {
        libraryId: handle.libId,
        relPath,
        replacedRelPath: relPath,
        link: null,
      }),
    ).resolves.toBe(false);
    expect(readLocations(handle.db, id)[0]?.missing_since).not.toBeNull();
    expect(
      handle.db.query('SELECT deleted_reason FROM assets WHERE id = ?').get(id.toHexString()),
    ).toEqual({ deleted_reason: 'reaped' });
  });

  test('completed session refuses a newly admitted purge', async () => {
    expect((await upload()).status).toBe(200);
    const id = handle.db.query('SELECT id FROM assets WHERE maple_id = ?').get(mapleId) as {
      id: string;
    };
    handle.db.run(
      `INSERT INTO backup_lifecycle(id, asset_id, kind, phase, created_at)
       VALUES(?, ?, 'purge', 'prepared', ?)`,
      [crypto.randomUUID(), id.id, new Date().toISOString()],
    );
    expect((await upload()).status).toBe(409);
    expect(handle.db.query('SELECT COUNT(*) AS n FROM asset_locations').get()).toEqual({ n: 1 });
  });
});
