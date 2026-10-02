/** Real SQLite/filesystem folder route for Apple's cross-language consumers (#4006). */
import { Elysia } from 'elysia';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { previewRoutes } from '../../src/routes/library/preview.ts';
import { cachePathFor } from '../../src/fs/xmp.ts';
import { folderRoutes } from '../../src/routes/library/folder.ts';
import { invalidateLibraryRoots } from '../../src/indexer/libraries.cache.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  insertAsset,
  insertLocation,
} from '../../src/db/sqlite/test-sqlite.test-helpers.ts';
import { fakeAuth } from '../helpers/test-auth.ts';

const [root, receipt] = process.argv.slice(2);
if (!root || !receipt) throw new Error('Expected fixture directory and ready receipt');
const live = await createLiveTestDatabase();
const library = path.join(root, 'Library');
const album = path.join(library, 'My Album #?');
await mkdir(path.join(album, 'Child'), { recursive: true });
const libraryId = insertFolder(live.db, { path: library, slug: 'photos' });
const assetId = insertAsset(live.db, {
  exif: JSON.stringify({
    camera_make: 'Hasselblad',
    captured_at: '2026-01-02T03:04:05.123Z',
  }),
});
insertLocation(live.db, {
  assetId,
  libraryId,
  path: 'My Album #?',
  filename: 'photo.dng',
});
await writeFile(path.join(album, 'photo.dng'), 'original bytes');
await writeFile(path.join(album, 'photo.xmp'), '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
const previewPath = cachePathFor(path.join(album, 'photo.dng'), 'previews', 'avif');
await mkdir(path.dirname(previewPath), { recursive: true });
await writeFile(previewPath, 'published-preview');
await writeFile(path.join(album, 'notes.txt'), 'notes');
await writeFile(path.join(album, 'README'), 'readme');
invalidateLibraryRoots();
const requests: {
  path: string;
  authorization: string | null;
  etag: string | null;
}[] = [];
const app = new Elysia()
  .onBeforeHandle({ as: 'global' }, ({ request, set }) => {
    if (!new URL(request.url).pathname.startsWith('/maple/api/')) return;
    requests.push({
      path: new URL(request.url).pathname + new URL(request.url).search,
      authorization: request.headers.get('authorization'),
      etag: request.headers.get('if-none-match'),
    });
    if (request.headers.get('authorization') !== 'Bearer folder-token') {
      set.status = 401;
      return { error: 'Unauthorized fixture request' };
    }
  })
  .use(fakeAuth())
  .group('/maple/api', (api) =>
    api
      .get('/folders', () => [
        {
          id: libraryId,
          slug: 'photos',
          path: library,
          label: 'Library',
          last_scan: null,
          file_count: 1,
          created_at: '2026-01-01T00:00:00Z',
        },
      ])
      .use(folderRoutes)
      .use(previewRoutes),
  )
  .get('/test/requests', () => requests)
  .listen({ hostname: '127.0.0.1', port: 0 });
await writeFile(
  receipt,
  JSON.stringify({
    url: `http://127.0.0.1:${app.server!.port}/maple/`,
    library,
    album,
    assetId,
  }),
);
process.on('SIGTERM', () => {
  app.stop();
  invalidateLibraryRoots();
  live.close();
  process.exit(0);
});
