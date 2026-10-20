/**
 * The canonical-sidecar check is stamped only for the locations it scanned:
 * a merge that adds locations meanwhile keeps the asset due (#5021).
 */
import { expect, test } from 'bun:test';
import { ObjectId } from '../object-id.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
} from '../sqlite/test-sqlite.test-helpers.ts';
import { markCanonicalSidecarsChecked } from './backup-sidecar-name-checks.repo.ts';

const checks = (db: { query: (sql: string) => { all: () => unknown[] } }) =>
  db.query('SELECT asset_id, checked FROM backup_sidecar_name_checks').all();

test('stamps the check when the scanned locations are still the live ones', async () => {
  using live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { path: '/photos' });
  const asset = insertAsset(live.db);
  insertLocation(live.db, { assetId: asset, libraryId });

  await markCanonicalSidecarsChecked(new ObjectId(asset), 1, live.handle);

  expect(checks(live.db)).toEqual([{ asset_id: asset, checked: 1 }]);
});

test('leaves the asset due when locations arrived after the scan', async () => {
  using live = await createLiveTestDatabase();
  const libraryId = insertFolder(live.db, { path: '/photos' });
  const asset = insertAsset(live.db);
  insertLocation(live.db, { assetId: asset, libraryId });
  insertLocation(live.db, { assetId: asset, libraryId, ordinal: 1, filename: 'merged.heic' });
  live.db
    .query('INSERT INTO backup_sidecar_name_checks (asset_id, checked) VALUES (?, 0)')
    .run(asset);

  await markCanonicalSidecarsChecked(new ObjectId(asset), 1, live.handle);

  expect(checks(live.db)).toEqual([{ asset_id: asset, checked: 0 }]);
});
