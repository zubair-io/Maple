import { expect, test } from 'bun:test';
import {
  createTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  testSqliteDb,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from './repository.ts';
import { prepareLifecycle, finishLocalLifecycle, preparePurge } from './lifecycle.ts';
import { inOtherProcess, reconcileInChild } from './lifecycle-process.test-helpers.ts';

function existingIntent(
  db: Parameters<typeof insertAsset>[0],
  assetId: string,
  kind: string,
  phase: string,
  expiry = 0,
) {
  db.run(
    `INSERT INTO backup_lifecycle(id,asset_id,kind,phase,created_at,lease_owner,lease_until)
    VALUES(?,?,?,?,'2026-10-04','other-process',?)`,
    [crypto.randomUUID(), assetId, kind, phase, expiry],
  );
}

for (const prior of ['permanent purge', 'prepared move', 'live applied move'] as const) {
  test(`SQLite refuses a new move after ${prior} without invalidating verified entries`, async () => {
    using live = await createTestDatabase();
    const repo = new BackupRepository(testSqliteDb(live.db));
    const assetId = insertAsset(live.db);
    const libraryId = insertFolder(live.db);
    const destination = await repo.createDestination({
      libraryId,
      kind: 'google-drive',
      name: 'Drive',
      path: null,
    });
    const entry = await repo.ensureEntry(destination.id, assetId, 0, 'photo.dng');
    existingIntent(
      live.db,
      assetId,
      prior === 'permanent purge' ? 'purge' : 'trash',
      prior === 'prepared move' ? 'prepared' : 'applied',
      prior === 'live applied move' ? Date.now() + 120000 : 0,
    );
    await expect(
      prepareLifecycle(assetId, 'restore', libraryId, 'photo.dng', repo),
    ).rejects.toThrow('pending backup lifecycle');
    expect(live.db.query('SELECT sequence FROM backup_entries WHERE id=?').get(entry.id)).toEqual({
      sequence: 1,
    });
    expect(live.db.query('SELECT id FROM backup_lifecycle').all()).toHaveLength(1);
  });
}

for (const phase of ['prepared', 'applied']) {
  test(`a ${phase} owned move prevents permanent purge admission`, async () => {
    using live = await createTestDatabase();
    const repo = new BackupRepository(testSqliteDb(live.db));
    const assetId = insertAsset(live.db);
    existingIntent(live.db, assetId, 'restore', phase, Date.now() + 120000);
    await expect(preparePurge(assetId, repo)).rejects.toThrow('pending backup lifecycle');
    expect(() => existingIntent(live.db, assetId, 'purge', 'applied')).toThrow(
      'pending backup lifecycle',
    );
    expect(live.db.query('SELECT id FROM backup_lifecycle WHERE kind=?').all('purge')).toEqual([]);
    expect(live.db.query('SELECT * FROM backup_purges').all()).toEqual([]);
  });
}

test('a released applied move permits the next explicit preparation', async () => {
  using live = await createTestDatabase();
  const repo = new BackupRepository(testSqliteDb(live.db));
  const assetId = insertAsset(live.db);
  const libraryId = insertFolder(live.db);
  existingIntent(live.db, assetId, 'trash', 'applied');
  const id = await prepareLifecycle(assetId, 'restore', libraryId, 'photo.dng', repo);
  await finishLocalLifecycle(id, true, repo);
  expect(live.db.query('SELECT phase FROM backup_lifecycle WHERE id=?').get(id)).toEqual({
    phase: 'cancelled',
  });
});

test('two independent API processes cannot prepare concurrent moves of the same asset', async () => {
  using live = await createTestDatabase('file');
  const assetId = insertAsset(live.db);
  const libraryId = insertFolder(live.db);
  insertLocation(live.db, { assetId, libraryId, path: '', filename: 'photo.dng' });
  const script = `const [assetId,libraryId] = args;
    process.stdout.write(await lifecycle.prepareLifecycle(assetId,'trash',libraryId,'photo.dng',repo));`;
  const results = await Promise.allSettled([
    inOtherProcess(live.path, script, [assetId, libraryId]),
    inOtherProcess(live.path, script, [assetId, libraryId]),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  expect(live.db.query('SELECT id FROM backup_lifecycle').all()).toHaveLength(1);
  // The abandoned preparation is still protected until expiry/recovery.
  await reconcileInChild(live.path);
  expect(live.db.query('SELECT phase FROM backup_lifecycle').get()).toEqual({ phase: 'prepared' });
});
