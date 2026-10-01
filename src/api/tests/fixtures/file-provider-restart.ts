/** Real SQLite + production change-feed routes for the native restart gate (#3770). */
import { Database } from 'bun:sqlite';
import { Elysia } from 'elysia';
import { writeFile } from '../../src/fs/mirrored.ts';
import { ObjectId } from '../../src/db/object-id.ts';
import { createTestDatabase, testSqliteDb } from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { setSqliteHandleForTests } from '../../src/db/sqlite/index.ts';
import { recordAssetChange } from '../../src/db/repos/changes.repo.ts';
import { changesRoutes } from '../../src/routes/changes.ts';
import { ChangeFeedTailer } from '../../src/runtime/sqlite/change-feed-tailer.ts';
import { fakeAuth } from '../helpers/test-auth.ts';

const [databasePath, receiptPath, retention] = process.argv.slice(2);
if (!databasePath || !receiptPath || !['retained', 'pruned'].includes(retention))
  throw new Error('Expected database path, readiness receipt path and retention mode');

if (!(await Bun.file(databasePath).exists())) {
  using seed = await createTestDatabase();
  for (let n = 0; n < 3; n++) {
    await recordAssetChange(testSqliteDb(seed.db), {
      kind: 'update',
      asset_id: new ObjectId(),
      folder_id: new ObjectId(),
      abs_path: `/photos/${n}.dng`,
      relative_path: `${n}.dng`,
    });
  }
  if (retention === 'pruned') seed.db.run('DELETE FROM asset_changes');
  // The snapshot includes the independent allocator even after every journal
  // row is pruned. The native test owns this file across actual process restarts.
  await writeFile(databasePath, seed.db.serialize());
}

const database = new Database(databasePath);
const handle = testSqliteDb(database);
setSqliteHandleForTests(handle);
const tailer = new ChangeFeedTailer({ db: handle, intervalMs: 50 });
await tailer.start();
const requests: number[] = [];
const app = new Elysia()
  .onRequest(({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === '/api/changes/subscribe')
      requests.push(Number(url.searchParams.get('since')));
  })
  .use(fakeAuth())
  .use(changesRoutes)
  .post('/test/append', async () => {
    const assetId = new ObjectId();
    const cursor = await recordAssetChange(handle, {
      kind: 'update',
      asset_id: assetId,
      folder_id: new ObjectId(),
      abs_path: '/photos/new.dng',
      relative_path: 'new.dng',
    });
    return { cursor, asset_id: assetId.toHexString() };
  })
  .get('/test/requests', () => requests)
  .listen({ hostname: '127.0.0.1', port: 0 });
await writeFile(receiptPath, JSON.stringify({ url: app.server!.url.toString() }));

process.on('SIGTERM', () => {
  app.stop(true);
  tailer.stop();
  database.close();
  process.exit(0);
});
