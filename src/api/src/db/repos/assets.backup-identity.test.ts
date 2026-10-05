import { expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { BackupRepository } from '../../cloud-backup/repository.ts';
import { mergeIntoSurvivor } from './assets.merge.ts';
import {
  markSoftDeleted,
  restoreFromTrash,
  restoreBackupDestinationOccupied,
} from './assets.trash.ts';

async function fixture() {
  const live = await createLiveTestDatabase();
  const repo = new BackupRepository(live.handle);
  const libraryId = insertFolder(live.db, { path: '/photos' });
  const destination = await repo.createDestination({
    libraryId,
    kind: 'google-drive',
    name: 'Archive',
    path: null,
  });
  live.db.query('UPDATE backup_destinations SET enabled=1 WHERE id=?').run(destination.id);
  return { live, repo, libraryId, destination };
}
async function entry(f: Awaited<ReturnType<typeof fixture>>, assetId: string, ordinal: number) {
  return f.repo.ensureEntry(f.destination.id, assetId, ordinal, `source-${ordinal}.dng`);
}

test('merge preserves remote history IDs and maps every location and backup ordinal while fencing live transfers', async () => {
  const f = await fixture();
  using _database = f.live;
  const survivor = insertAsset(f.live.db);
  const condemned = insertAsset(f.live.db);
  insertLocation(f.live.db, { assetId: survivor, libraryId: f.libraryId, ordinal: 0 });
  insertLocation(f.live.db, { assetId: condemned, libraryId: f.libraryId, ordinal: 0 });
  insertLocation(f.live.db, {
    assetId: condemned,
    libraryId: f.libraryId,
    ordinal: 4,
    filename: 'second.dng',
  });
  const existing = await entry(f, survivor, 5);
  const active = await entry(f, condemned, 0);
  const trash = await entry(f, condemned, 4);
  const purged = await entry(f, condemned, 9);
  f.live.db.query('UPDATE backup_entries SET state=? WHERE id=?').run('trash', trash.id);
  f.live.db.query('UPDATE backup_entries SET state=? WHERE id=?').run('purged', purged.id);
  f.live.db
    .query(
      `UPDATE backup_entries SET sequence=3,verified_sequence=3,snapshot_hash='old-snapshot',
    manifest='retained-history',lease_owner='old-worker',lease_until=? WHERE id=?`,
    )
    .run(Date.now() + 60_000, active.id);
  f.live.db
    .query(
      `INSERT INTO backup_objects(destination_id,key,entry_id,object,checkpoint) VALUES(?,?,?,?,?)`,
    )
    .run(
      f.destination.id,
      'old-object',
      active.id,
      '{"locator":"remote-original"}',
      '{"offset":1024}',
    );
  f.live.db
    .query(`INSERT INTO backup_purges(destination_id,entry_id,record) VALUES(?,?,?)`)
    .run(f.destination.id, purged.id, '{"history":"retained-purge"}');
  const objects = f.live.db.query('SELECT * FROM backup_objects').all();
  const purges = f.live.db.query('SELECT * FROM backup_purges').all();
  await mergeIntoSurvivor({
    survivorId: survivor,
    condemnedId: condemned,
    mapleId: 'merged-photo',
    dbOverride: f.live.handle,
  });
  const saved = await f.repo.entries(f.destination.id, survivor);
  expect(saved.find((row) => row.id === existing.id)!.ordinal).toBe(5);
  expect(saved.find((row) => row.id === active.id)).toMatchObject({
    ordinal: 6,
    sequence: 4,
    verified_sequence: 3,
    snapshot_hash: null,
    manifest: 'retained-history',
    lease_owner: null,
    lease_until: 0,
  });
  expect(saved.find((row) => row.id === trash.id)).toMatchObject({ ordinal: 10, state: 'trash' });
  expect(saved.find((row) => row.id === purged.id)).toMatchObject({ ordinal: 15, state: 'purged' });
  expect(
    f.live.db
      .query('SELECT ordinal FROM asset_locations WHERE asset_id=? ORDER BY ordinal')
      .all(survivor),
  ).toEqual([{ ordinal: 0 }, { ordinal: 6 }, { ordinal: 10 }]);
  expect(f.live.db.query('SELECT * FROM backup_objects').all()).toEqual(objects);
  expect(f.live.db.query('SELECT * FROM backup_purges').all()).toEqual(purges);
  expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(condemned)).toBeNull();
  expect(
    f.live.db
      .query('SELECT version FROM stage_state WHERE asset_id=? AND stage=?')
      .get(survivor, 'cloud-backup'),
  ).toEqual({ version: 0 });
});

test('ordinal reservation sees a new survivor location admitted immediately before the merge transaction', async () => {
  const f = await fixture();
  using _database = f.live;
  const survivor = insertAsset(f.live.db);
  const condemned = insertAsset(f.live.db);
  insertLocation(f.live.db, { assetId: survivor, libraryId: f.libraryId });
  insertLocation(f.live.db, { assetId: condemned, libraryId: f.libraryId });
  const history = await entry(f, condemned, 0);
  const transaction = f.live.handle.transaction.bind(f.live.handle);
  const racedDb = {
    ...f.live.handle,
    transaction: async (...args: Parameters<typeof transaction>) => {
      insertLocation(f.live.db, {
        assetId: survivor,
        libraryId: f.libraryId,
        ordinal: 40,
        filename: 'new-copy.dng',
      });
      return transaction(...args);
    },
  };
  await mergeIntoSurvivor({
    survivorId: survivor,
    condemnedId: condemned,
    mapleId: 'raced-photo',
    dbOverride: racedDb,
  });
  expect(
    (await f.repo.entries(f.destination.id, survivor)).find((row) => row.id === history.id)!
      .ordinal,
  ).toBe(41);
  expect(
    f.live.db
      .query('SELECT ordinal FROM asset_locations WHERE asset_id=? ORDER BY ordinal')
      .all(survivor),
  ).toEqual([{ ordinal: 0 }, { ordinal: 40 }, { ordinal: 41 }]);
});

for (const preparedAsset of ['survivor', 'condemned'] as const) {
  test(`merge blocks atomically while the ${preparedAsset} has a prepared filesystem move`, async () => {
    const f = await fixture();
    using _database = f.live;
    const survivor = insertAsset(f.live.db);
    const condemned = insertAsset(f.live.db);
    insertLocation(f.live.db, { assetId: survivor, libraryId: f.libraryId });
    insertLocation(f.live.db, { assetId: condemned, libraryId: f.libraryId });
    await entry(f, condemned, 0);
    f.live.db
      .query(
        `INSERT INTO backup_lifecycle(id,asset_id,kind,phase,created_at) VALUES(?,?,'trash','prepared',?)`,
      )
      .run(
        crypto.randomUUID(),
        preparedAsset === 'survivor' ? survivor : condemned,
        new Date().toISOString(),
      );
    const before = f.live.db.query('SELECT * FROM backup_entries').all();
    const locations = f.live.db.query('SELECT * FROM asset_locations').all();
    await expect(
      mergeIntoSurvivor({
        survivorId: survivor,
        condemnedId: condemned,
        mapleId: 'blocked',
        carryOver: { rating: 5 },
        dbOverride: f.live.handle,
      }),
    ).rejects.toThrow('no_pending_asset_operation');
    expect(f.live.db.query('SELECT * FROM backup_entries').all()).toEqual(before);
    expect(f.live.db.query('SELECT * FROM asset_locations').all()).toEqual(locations);
    expect(f.live.db.query('SELECT rating FROM assets WHERE id=?').get(survivor)).toEqual({
      rating: 0,
    });
  });
}

function restoreFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const canonical = insertAsset(f.live.db, { deletedAt: '2026-10-01T00:00:00Z' });
  const transient = insertAsset(f.live.db);
  insertLocation(f.live.db, {
    assetId: canonical,
    libraryId: f.libraryId,
    path: '.maple/trash',
    filename: 'photo.dng',
  });
  insertLocation(f.live.db, {
    assetId: transient,
    libraryId: f.libraryId,
    path: '',
    filename: 'photo.dng',
  });
  return {
    canonical,
    transient,
    args: {
      id: new ObjectId(canonical),
      libraryRoot: '/photos',
      libraryId: new ObjectId(f.libraryId),
      newAbsPath: '/photos/photo.dng',
      size: 4096,
      mtimeMs: 123,
      source: { libraryId: new ObjectId(f.libraryId), path: '.maple/trash', filename: 'photo.dng' },
      dbOverride: f.live.handle,
    },
  };
}

test('merge cannot revive a permanently purged identity by folding it into a surviving asset', async () => {
  const f = await fixture();
  using _database = f.live;
  const survivor = insertAsset(f.live.db);
  const condemned = insertAsset(f.live.db);
  insertLocation(f.live.db, { assetId: survivor, libraryId: f.libraryId });
  insertLocation(f.live.db, { assetId: condemned, libraryId: f.libraryId });
  const history = await entry(f, condemned, 0);
  f.live.db.query('UPDATE backup_entries SET state=? WHERE id=?').run('purged', history.id);
  f.live.db
    .query(
      `INSERT INTO backup_lifecycle(id,asset_id,kind,phase,created_at) VALUES(?,?,'purge','applied',?)`,
    )
    .run(crypto.randomUUID(), condemned, new Date().toISOString());
  await expect(
    mergeIntoSurvivor({
      survivorId: survivor,
      condemnedId: condemned,
      mapleId: 'must-not-revive',
      dbOverride: f.live.handle,
    }),
  ).rejects.toThrow('no_pending_asset_operation');
  expect((await f.repo.entries(f.destination.id, condemned))[0]!.id).toBe(history.id);
  expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(condemned)).not.toBeNull();
});
test('restore blocks a watcher duplicate with backup history before changing either asset, even with a stale source', async () => {
  const f = await fixture();
  using _database = f.live;
  const restore = restoreFixture(f);
  await entry(f, restore.transient, 0);
  const assets = f.live.db.query('SELECT * FROM assets').all();
  const locations = f.live.db.query('SELECT * FROM asset_locations').all();
  const histories = f.live.db.query('SELECT * FROM backup_entries').all();
  await expect(
    restoreFromTrash({
      ...restore.args,
      source: { ...restore.args.source, filename: 'no-longer-there.dng' },
    }),
  ).rejects.toThrow('unfinished backup obligations');
  expect(f.live.db.query('SELECT * FROM assets').all()).toEqual(assets);
  expect(f.live.db.query('SELECT * FROM asset_locations').all()).toEqual(locations);
  expect(f.live.db.query('SELECT * FROM backup_entries').all()).toEqual(histories);
});
test('restore sees watcher backup admission immediately before its transaction and can succeed after an unbacked duplicate', async () => {
  const f = await fixture();
  using _database = f.live;
  const restore = restoreFixture(f);
  const transaction = f.live.handle.transaction.bind(f.live.handle);
  const racedDb = {
    ...f.live.handle,
    transaction: async (...args: Parameters<typeof transaction>) => {
      await entry(f, restore.transient, 0);
      return transaction(...args);
    },
  };
  await expect(restoreFromTrash({ ...restore.args, dbOverride: racedDb })).rejects.toThrow(
    'unfinished backup obligations',
  );
  expect(
    f.live.db.query('SELECT deleted_at FROM assets WHERE id=?').get(restore.canonical),
  ).toEqual({ deleted_at: '2026-10-01T00:00:00Z' });
  // A separately unbacked duplicate can be reconciled normally; no physical bytes are purged.
  const other = insertAsset(f.live.db);
  insertLocation(f.live.db, {
    assetId: other,
    libraryId: f.libraryId,
    path: '',
    filename: 'unbacked.dng',
  });
  await restoreFromTrash({ ...restore.args, newAbsPath: '/photos/unbacked.dng' });
  expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(other)).toBeNull();
  expect(f.live.db.query('SELECT id FROM assets WHERE id=?').get(restore.transient)).not.toBeNull();
  expect(await f.repo.entries(f.destination.id, restore.transient)).toHaveLength(1);
});

test('restore can select a free alternate path while retaining a DB-only watcher claim and its backup histories', async () => {
  const f = await fixture();
  using _database = f.live;
  const restore = restoreFixture(f);
  const history = await entry(f, restore.transient, 0);
  const watcher = f.live.db.query('SELECT * FROM assets WHERE id=?').get(restore.transient);
  expect(
    await restoreBackupDestinationOccupied(restore.args.id, restore.args.libraryId, 'photo.dng'),
  ).toBe(true);
  expect(
    await restoreBackupDestinationOccupied(
      new ObjectId(restore.transient),
      restore.args.libraryId,
      'photo.dng',
    ),
  ).toBe(false);
  expect(
    await restoreBackupDestinationOccupied(restore.args.id, restore.args.libraryId, 'photo_1.dng'),
  ).toBe(false);
  expect(
    await restoreBackupDestinationOccupied(
      restore.args.id,
      restore.args.libraryId,
      'subfolder/photo.dng',
    ),
  ).toBe(false);
  await restoreFromTrash({ ...restore.args, newAbsPath: '/photos/photo_1.dng' });
  expect(
    f.live.db
      .query('SELECT path,filename FROM asset_locations WHERE asset_id=?')
      .get(restore.canonical),
  ).toEqual({ path: '', filename: 'photo_1.dng' });
  expect(f.live.db.query('SELECT * FROM assets WHERE id=?').get(restore.transient)).toEqual(
    watcher,
  );
  expect(await f.repo.entries(f.destination.id, restore.transient)).toEqual([history]);
});

test('restore commits only the current lifecycle owner and retains its lease through subsequent filesystem unlink', async () => {
  const f = await fixture();
  using _database = f.live;
  const restore = restoreFixture(f);
  const id = crypto.randomUUID();
  const until = Date.now() + 60_000;
  f.live.db
    .query(
      `INSERT INTO backup_lifecycle(id,asset_id,library_id,source_path,target_path,kind,
    phase,created_at,lease_owner,lease_until) VALUES(?,?,?,?,?,'restore','prepared',?,'current-owner',?)`,
    )
    .run(
      id,
      restore.canonical,
      f.libraryId,
      '.maple/trash/photo.dng',
      'photo.dng',
      new Date().toISOString(),
      until,
    );
  const result = await restoreFromTrash({
    ...restore.args,
    lifecycle: { id, owner: 'current-owner' },
  });
  expect(result.matchedCount).toBe(1);
  expect(
    f.live.db
      .query('SELECT phase,lease_owner,lease_until FROM backup_lifecycle WHERE id=?')
      .get(id),
  ).toEqual({ phase: 'applied', lease_owner: 'current-owner', lease_until: until });
});

test('a takeover or deleted journal fences both trash and restore commits before asset or location mutation', async () => {
  const f = await fixture();
  using _database = f.live;
  const restore = restoreFixture(f);
  const id = crypto.randomUUID();
  f.live.db
    .query(
      `INSERT INTO backup_lifecycle(id,asset_id,kind,phase,created_at,lease_owner,lease_until)
    VALUES(?,?,'restore','prepared',?,'new-owner',?)`,
    )
    .run(id, restore.canonical, new Date().toISOString(), Date.now() + 60_000);
  const assets = f.live.db.query('SELECT * FROM assets').all();
  const locations = f.live.db.query('SELECT * FROM asset_locations').all();
  await expect(
    restoreFromTrash({ ...restore.args, lifecycle: { id, owner: 'stale-owner' } }),
  ).rejects.toThrow('CHECK constraint');
  await expect(
    markSoftDeleted({
      id: restore.args.id,
      libraryId: restore.args.libraryId,
      libraryRoot: '/photos',
      newAbsPath: '/photos/.maple/trash/again.dng',
      originalAbsPath: '/photos/photo.dng',
      lifecycle: { id: crypto.randomUUID(), owner: 'missing-owner' },
      dbOverride: f.live.handle,
    }),
  ).rejects.toThrow('CHECK constraint');
  expect(f.live.db.query('SELECT * FROM assets').all()).toEqual(assets);
  expect(f.live.db.query('SELECT * FROM asset_locations').all()).toEqual(locations);
});
