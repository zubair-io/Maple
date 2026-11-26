/** Production folder + thumb routes over one existing library directory, for the Apple
 * folder-thumbnail throughput harness (`FolderThumbnailThroughputTests`). The library is
 * served as-is: thumbs already under `<folder>/.maple/thumbs/` are hits, the rest render. */
import { Elysia } from 'elysia';
import { writeFile } from 'node:fs/promises';
import { folderRoutes } from '../../src/routes/library/folder.ts';
import { thumbRoutes } from '../../src/routes/library/thumb.ts';
import { invalidateLibraryRoots } from '../../src/indexer/libraries.cache.ts';
import {
  createLiveTestDatabase,
  insertFolder,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { fakeAuth } from '../helpers/test-auth.ts';

const [library, receipt] = process.argv.slice(2);
if (!library || !receipt) throw new Error('Expected library directory and ready receipt');
const live = await createLiveTestDatabase();
const libraryId = insertFolder(live.db, { path: library, slug: 'perf' });
invalidateLibraryRoots();
const app = new Elysia()
  .onBeforeHandle({ as: 'global' }, ({ request, set }) => {
    if (request.headers.get('authorization') !== 'Bearer throughput-token') {
      set.status = 401;
      return { error: 'Unauthorized fixture request' };
    }
  })
  .use(fakeAuth())
  .group('/api', (api) =>
    api
      .get('/folders', () => [
        {
          id: libraryId,
          slug: 'perf',
          path: library,
          label: 'Perf',
          last_scan: null,
          file_count: 0,
          created_at: '2026-01-01T00:00:00Z',
        },
      ])
      .use(folderRoutes)
      .use(thumbRoutes),
  )
  .listen({ hostname: '127.0.0.1', port: 0 });
await writeFile(
  receipt,
  JSON.stringify({ url: `http://127.0.0.1:${app.server!.port}/`, libraryId }),
);
process.on('SIGTERM', () => {
  app.stop();
  invalidateLibraryRoots();
  live.close();
  process.exit(0);
});
