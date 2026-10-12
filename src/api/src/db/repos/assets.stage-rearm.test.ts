import { expect, test } from 'bun:test';
import { searchBlobRearmStatements, searchRearmStatements } from './assets.stage-rearm.ts';
import { stageRow } from './stage-runtime.test-helpers.ts';
import {
  createTestDatabase,
  insertAsset,
  testSqliteDb,
} from '../sqlite/test-sqlite.test-helpers.ts';

test('re-arms the embed stage, creating a missing row, and the blob stage, lifting a dead one', async () => {
  using handle = await createTestDatabase();
  const assetId = insertAsset(handle.db);
  handle.db.run(`DELETE FROM stage_state WHERE asset_id = ?`, [assetId]);
  handle.db.run(
    `INSERT INTO stage_state (asset_id, stage, version, attempts, last_error, dead)
     VALUES (?, 'search-blob', 6, 3, 'boom', 1)`,
    [assetId],
  );

  await testSqliteDb(handle.db).transaction([
    ...searchRearmStatements(assetId),
    ...searchBlobRearmStatements(assetId),
  ]);

  for (const stage of ['search-blob', 'embed']) {
    expect(stageRow(handle.db, assetId, stage)).toMatchObject({
      version: 0,
      attempts: 0,
      dead: 0,
      last_error: null,
    });
  }
});
