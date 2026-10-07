// Disposable protocol fixture: actual API XMP routes and actual RAW/XMP files.
// Authentication is fixture-only; this is never a production server entrypoint.
import { Elysia, t } from '../../api/node_modules/elysia';
import { xmpPathRoutes } from '../../api/src/routes/xmp';
import { setLibraryRootsForTests } from '../../api/src/indexer/libraries.cache';
import * as path from 'node:path';
const root = process.argv[2]!;
process.env.MAPLE_ROOTS = root;
setLibraryRootsForTests(new Map([['linux-cloud-fixture', root]]));
const app = new Elysia()
  .get('/api/health', () => ({ ok: true, product: 'maple', db_connected: true }))
  .post(
    '/api/auth/native-code/claim',
    ({ body }) => ({
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      state: body.state,
    }),
    { body: t.Object({ state: t.String(), code_verifier: t.String() }) },
  )
  .get('/api/image/library/photo.dng', () => Bun.file(path.join(root, 'photo.dng')))
  .use(xmpPathRoutes)
  .listen({ hostname: '127.0.0.1', port: 0 });
console.log(`MAPLE_FIXTURE_URL ${app.server!.url}`);
