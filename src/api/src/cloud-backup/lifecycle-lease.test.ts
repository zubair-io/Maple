import { expect, test } from 'bun:test';
import * as fs from '../fs/mirrored.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { inOtherProcess, reconcileInChild } from './lifecycle-process.test-helpers.ts';
import {
  createTestDatabase,
  testSqliteDb,
  insertFolder,
  insertAsset,
  insertLocation,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import {
  prepareLifecycle,
  recordLifecycleTarget,
  runLifecycleMove,
  finishLocalLifecycle,
} from './lifecycle.ts';

test('another process cannot cancel a live move, renewal covers long copy and the DB commit gap', async () => {
  using live = await createTestDatabase('file');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-lifecycle-lease-'));
  const repo = new BackupRepository(testSqliteDb(live.db));
  const libraryId = insertFolder(live.db, { path: root });
  const assetId = insertAsset(live.db);
  insertLocation(live.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
  const original = path.join(root, 'photo.dng');
  const target = path.join(root, '.maple/trash/photo.dng');
  const id = await prepareLifecycle(assetId, 'trash', libraryId, 'photo.dng', repo);
  try {
    await fs.writeFile(original, 'verified original');
    await recordLifecycleTarget(id, root, original, target, repo);
    const before = live.db
      .query<
        { lease_owner: string; lease_until: number },
        [string]
      >('SELECT lease_owner,lease_until FROM backup_lifecycle WHERE id=?')
      .get(id)!;
    expect(before.lease_owner).toBeString();
    await runLifecycleMove(id, async () => {
      // The other process has no knowledge of the API's local timer handles.
      await reconcileInChild(live.path);
      expect(live.db.query('SELECT phase FROM backup_lifecycle WHERE id=?').get(id)).toEqual({
        phase: 'prepared',
      });
      await Bun.sleep(20_150);
      const renewed = live.db
        .query<
          { lease_until: number },
          [string]
        >('SELECT lease_until FROM backup_lifecycle WHERE id=?')
        .get(id)!;
      expect(renewed.lease_until).toBeGreaterThan(before.lease_until + 10_000);
      await reconcileInChild(live.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(original, target);
      // Source absence is not an expired operation: the API still owns DB commit.
      await reconcileInChild(live.path);
      expect(live.db.query('SELECT phase FROM backup_lifecycle WHERE id=?').get(id)).toEqual({
        phase: 'prepared',
      });
    });
    await finishLocalLifecycle(id, false, repo);
    await reconcileInChild(live.path);
    expect(
      live.db
        .query('SELECT phase,lease_owner,lease_until FROM backup_lifecycle WHERE id=?')
        .get(id),
    ).toEqual({ phase: 'applied', lease_owner: null, lease_until: 0 });
    expect(await fs.readFile(target, 'utf8')).toBe('verified original');
    expect(live.db.query('SELECT path FROM asset_locations WHERE asset_id=?').get(assetId)).toEqual(
      { path: '.maple/trash' },
    );
  } finally {
    await finishLocalLifecycle(id, false, repo);
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

for (const moved of [false, true]) {
  test(`a terminated API's ${moved ? 'published' : 'unperformed'} preparation recovers only after durable expiry`, async () => {
    using live = await createTestDatabase('file');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-lifecycle-crash-'));
    try {
      const libraryId = insertFolder(live.db, { path: root });
      const assetId = insertAsset(live.db);
      insertLocation(live.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
      const original = path.join(root, 'photo.dng');
      const target = path.join(root, '.maple/trash/photo.dng');
      await fs.writeFile(original, 'original survives interruption');
      const id = await inOtherProcess(
        live.path,
        `
        const [assetId,libraryId,root,original,target] = args;
        const id = await lifecycle.prepareLifecycle(assetId,'trash',libraryId,'photo.dng',repo);
        await lifecycle.recordLifecycleTarget(id,root,original,target,repo);
        ${moved ? "await fs.mkdir(root+'/.maple/trash',{recursive:true}); await fs.rename(original,target);" : ''}
        process.stdout.write(id);
        // End this process without releasing its persisted preparation lease.
      `,
        [assetId, libraryId, root, original, target],
      );
      await reconcileInChild(live.path);
      expect(live.db.query('SELECT phase FROM backup_lifecycle WHERE id=?').get(id)).toEqual({
        phase: 'prepared',
      });
      live.db.run('UPDATE backup_lifecycle SET lease_until=0 WHERE id=?', [id]);
      await reconcileInChild(live.path);
      expect(
        live.db
          .query('SELECT phase,lease_owner,lease_until FROM backup_lifecycle WHERE id=?')
          .get(id),
      ).toEqual({ phase: moved ? 'applied' : 'cancelled', lease_owner: null, lease_until: 0 });
      expect(await fs.readFile(moved ? target : original, 'utf8')).toBe(
        'original survives interruption',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
