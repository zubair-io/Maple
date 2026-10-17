import { expect, test } from 'bun:test';
import { runMigrations } from '../migrate.ts';
import { ALL_MIGRATIONS } from './index.ts';
import {
  createBlankTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../test-sqlite.test-helpers.ts';
import { ALL_STAGE_NAMES } from '../../../workers/stages/stage-names.ts';

const ID = '0030-seed-missing-stage-state';

test('assets stranded without stage rows are enrolled in every stage, existing progress is kept', async () => {
  using handle = createBlankTestDatabase('file');
  const before = ALL_MIGRATIONS.filter((migration) => migration.id !== ID);
  await runMigrations(handle.migrationDb, before);

  const libraryId = insertFolder(handle.db, { slug: 'lib', path: '/lib' });
  const stranded = insertAsset(handle.db);
  insertLocation(handle.db, { assetId: stranded, libraryId, path: '', filename: 'a.heic' });
  const seeded = insertAsset(handle.db);
  insertLocation(handle.db, { assetId: seeded, libraryId, path: '', filename: 'b.heic' });
  for (const stage of ALL_STAGE_NAMES) {
    handle.db.run(`INSERT INTO stage_state (asset_id, stage, version) VALUES (?, ?, ?)`, [
      seeded,
      stage,
      4,
    ]);
  }

  const result = await runMigrations(handle.migrationDb, ALL_MIGRATIONS);
  expect(result.applied).toEqual([ID]);

  const count = (assetId: string) =>
    (
      handle.db.query(`SELECT COUNT(*) AS n FROM stage_state WHERE asset_id = ?`).get(assetId) as {
        n: number;
      }
    ).n;
  expect(count(stranded)).toBe(ALL_STAGE_NAMES.length);
  expect(count(seeded)).toBe(ALL_STAGE_NAMES.length);
  const kept = handle.db
    .query(`SELECT MIN(version) AS v FROM stage_state WHERE asset_id = ?`)
    .get(seeded) as { v: number };
  expect(kept.v).toBe(4);
  const fresh = handle.db
    .query(`SELECT MAX(version) AS v FROM stage_state WHERE asset_id = ?`)
    .get(stranded) as { v: number };
  expect(fresh.v).toBe(0);
});

test('an empty stage_state table is still backfilled with every stage', async () => {
  using handle = createBlankTestDatabase('file');
  const before = ALL_MIGRATIONS.filter((migration) => migration.id !== ID);
  await runMigrations(handle.migrationDb, before);

  const libraryId = insertFolder(handle.db, { slug: 'lib', path: '/lib' });
  const stranded = insertAsset(handle.db);
  insertLocation(handle.db, { assetId: stranded, libraryId, path: '', filename: 'a.heic' });

  await runMigrations(handle.migrationDb, ALL_MIGRATIONS);

  const stages = handle.db
    .query(`SELECT stage FROM stage_state WHERE asset_id = ? ORDER BY stage`)
    .all(stranded) as Array<{ stage: string }>;
  expect(stages.map((row) => row.stage)).toEqual([...ALL_STAGE_NAMES].sort());
});
