import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import {
  createBlankTestDatabase,
  insertAsset,
  insertFolder,
  run,
} from '../test-sqlite.test-helpers.ts';

test('Google mirror migration requeues old entries and disconnects duplicate roots safely', async () => {
  using handle = createBlankTestDatabase('file');
  await runMigrations(
    handle.migrationDb,
    ALL_MIGRATIONS.filter((migration) => migration.id <= '0017-cloud-backup-object-entry-index'),
  );

  const firstLibrary = insertFolder(handle.db);
  const secondLibrary = insertFolder(handle.db);
  const asset = insertAsset(handle.db);
  const destinations = [
    { id: 'drive-first', library: firstLibrary, created: '2026-01-01', kind: 'google-drive' },
    {
      id: 'drive-same-library',
      library: firstLibrary,
      created: '2026-01-02',
      kind: 'google-drive',
    },
    {
      id: 'drive-other-library',
      library: secondLibrary,
      created: '2026-01-03',
      kind: 'google-drive',
    },
    { id: 'folder', library: firstLibrary, created: '2026-01-04', kind: 'folder' },
  ];
  for (const destination of destinations) {
    run(
      handle.db,
      `INSERT INTO backup_destinations
        (id,library_id,kind,name,enabled,generation,path,root_id,account_id,created_at)
        VALUES(?,?,?, ?,1,1,?,?,?,?)`,
      destination.id,
      destination.library,
      destination.kind,
      destination.id,
      destination.kind === 'folder' ? '/backup' : null,
      destination.kind === 'folder' ? null : 'shared-root',
      destination.kind === 'folder' ? null : 'google-account',
      destination.created,
    );
    run(
      handle.db,
      `INSERT INTO backup_entries
        (id,destination_id,asset_id,ordinal,sequence,state,source_path,manifest,snapshot_hash,
         verified_sequence,attempts,retry_at,last_error,lease_owner,lease_until)
        VALUES(?,?,?,0,5,'active','photo.dng','legacy manifest','old-hash',5,4,99,
          'old failure','old worker',9999999999999)`,
      `entry-${destination.id}`,
      destination.id,
      asset,
    );
  }
  run(
    handle.db,
    `INSERT INTO stage_state
      (asset_id,stage,version,attempts,dead,last_error,failed_at,next_attempt_at)
      VALUES(?,'cloud-backup',7,4,1,'old failure','2026-01-01','2099-01-01T00:00:00Z')`,
    asset,
  );

  expect((await runMigrations(handle.migrationDb, ALL_MIGRATIONS)).applied).toEqual([
    '0018-cloud-backup-google-mirror-layout',
  ]);

  expect(
    handle.db
      .query('SELECT id,enabled,generation,root_id,account_id FROM backup_destinations ORDER BY id')
      .all(),
  ).toEqual([
    {
      id: 'drive-first',
      enabled: 1,
      generation: 1,
      root_id: 'shared-root',
      account_id: 'google-account',
    },
    { id: 'drive-other-library', enabled: 0, generation: 2, root_id: null, account_id: null },
    { id: 'drive-same-library', enabled: 0, generation: 2, root_id: null, account_id: null },
    { id: 'folder', enabled: 1, generation: 1, root_id: null, account_id: null },
  ]);
  const entries = handle.db
    .query<{
      destination_id: string;
      sequence: number;
      verified_sequence: number;
      snapshot_hash: string | null;
      attempts: number;
      retry_at: number;
      last_error: string | null;
      lease_owner: string | null;
      lease_until: number;
      manifest: string | null;
    }>(
      `SELECT destination_id,sequence,verified_sequence,snapshot_hash,attempts,retry_at,last_error,
        lease_owner,lease_until,manifest FROM backup_entries ORDER BY destination_id`,
    )
    .all();
  for (const row of entries.filter((value) => value.destination_id.startsWith('drive-'))) {
    expect(row).toMatchObject({
      sequence: 6,
      verified_sequence: 5,
      snapshot_hash: null,
      attempts: 0,
      retry_at: 0,
      last_error: null,
      lease_owner: null,
      lease_until: 0,
      manifest: 'legacy manifest',
    });
  }
  expect(entries.find((value) => value.destination_id === 'folder')).toMatchObject({
    sequence: 5,
    verified_sequence: 5,
    manifest: 'legacy manifest',
  });
  expect(
    handle.db
      .query(
        `SELECT version,attempts,dead,last_error,failed_at,next_attempt_at FROM stage_state
          WHERE asset_id=? AND stage='cloud-backup'`,
      )
      .get(asset),
  ).toEqual({
    version: 0,
    attempts: 0,
    dead: 0,
    last_error: null,
    failed_at: null,
    next_attempt_at: null,
  });
  expect(() =>
    handle.db
      .query(`UPDATE backup_destinations SET root_id='shared-root' WHERE id='drive-same-library'`)
      .run(),
  ).toThrow();
});
