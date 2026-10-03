/** Private real API/SQLite/filesystem fixture for Self Hosted editor qualification (#4053). */
import { Elysia, status, t } from 'elysia';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xmpPathRoutes } from '../../src/routes/xmp';
import { metadataRoutes } from '../../src/routes/assets/metadata';
import { xmpRoutes } from '../../src/routes/assets/xmp';
import { registerRoot } from '../../src/fs/root';
import { createLiveTestDatabase } from '../../src/db/sqlite/test-sqlite.test-helpers';
import { registerLibrary, seedRouteAsset } from '../helpers/assets-route-fixtures';
import { listChangesSince } from '../../src/db/repos/changes.repo';
import { callNative, shutdownMaplePool } from 'maple';

const root = await realpath(await mkdtemp(join(tmpdir(), 'maple-editor-api-')));
// The native consumer uses an ephemeral port and this ready receipt (#4056).
const [receipt] = process.argv.slice(2);
process.env.MAPLE_ROOTS = root;
registerRoot(root);
const live = await createLiveTestDatabase();
const libraryId = registerLibrary(live.db, root, 'workflow-fixture');
const fixtures = new Map<
  string,
  { path: string; id: string; input: string | null; cursor: number }
>();
const blocked = new Map<string, { promise: Promise<void>; release: () => void; arrived: number }>();
const lostResponses = new Set<string>();
function fixture(key: string) {
  const result = fixtures.get(key);
  if (!result) throw Error('Unknown owned fixture');
  return result;
}
const races = new Map<
  string,
  {
    promise: Promise<void>;
    release: () => void;
    arrived: number;
    expected: number;
  }
>();
async function waitForRace(path: string) {
  const race = races.get(path);
  if (!race) return;
  race.arrived++;
  if (race.arrived === race.expected) race.release();
  await race.promise;
}
async function waitForRequest(request: Request) {
  const url = new URL(request.url);
  const path = url.searchParams.get('path') ?? '';
  const gates: Record<string, () => Promise<void | undefined>> = {
    'GET /api/xmp': () => waitForBlockedRead(path),
    'GET /api/xmp/variant': () => waitForBlockedRead(path),
    'POST /api/xmp/variant/commit': () => waitForRace(path),
  };
  await gates[`${request.method} ${url.pathname}`]?.();
}
async function waitForBlockedRead(path: string) {
  const gate = blocked.get(path);
  if (!gate) return;
  gate.arrived++;
  await gate.promise;
}
function fixtureSchema(xml: string, future: boolean | undefined): string {
  return future ? xml.replace('<papp:SchemaVersion>1', '<papp:SchemaVersion>2') : xml;
}
function dropAcceptedResponse(request: Request) {
  const url = new URL(request.url);
  if (
    request.method !== 'POST' ||
    !['/api/xmp/variant/commit', '/api/xmp/variant/snapshot', '/api/xmp/variant/restore'].includes(
      url.pathname,
    )
  )
    return;
  if (!lostResponses.delete(String(url.searchParams.get('path')))) return;
  // Runs after the real route publishes its file/SQLite change. The client
  // receives a gateway failure instead of the acknowledgement, once (#4056).
  return status(502, {
    error: 'Owned fixture lost the accepted commit acknowledgement',
  });
}
async function fixtureXml(body: {
  xml: string | null;
  workflow?: unknown;
  futureSchema?: boolean;
}): Promise<string | null> {
  if (body.workflow === undefined || body.xml === null) return body.xml;
  const embedded = await callNative('workflowEmbedXmp', [JSON.stringify(body.workflow), body.xml]);
  if (!embedded.ok) throw Error(embedded.error);
  return fixtureSchema(embedded.value, body.futureSchema);
}
const app = new Elysia()
  .onBeforeHandle({ as: 'global' }, ({ request }) => {
    if (!receipt) return;
    if (!new URL(request.url).pathname.startsWith('/api/')) return;
    if (request.headers.get('authorization') !== 'Bearer workflow-token')
      return status(401, {
        error: 'Unauthorized owned native fixture request',
      });
  })
  .onBeforeHandle(({ request }) => waitForRequest(request))
  .onAfterHandle(({ request }) => dropAcceptedResponse(request))
  .get('/workflow-fixture/health', () => ({ ready: true }))
  .use(xmpPathRoutes)
  .group('/api/assets', (api) => api.use(metadataRoutes).use(xmpRoutes))
  .post(
    '/workflow-fixture',
    async ({ body }) => {
      const key = crypto.randomUUID();
      const directory = join(root, key);
      await mkdir(directory);
      const path = join(directory, 'photo.dng');
      const original = body.synthetic
        ? await readFile(
            join(
              import.meta.dir,
              '../../../apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng',
            ),
          )
        : new Uint8Array([1, 0, 255, 42]);
      await writeFile(path, original);
      const input = await fixtureXml(body);
      if (input !== null) await writeFile(join(directory, 'photo.xmp'), input);
      const id = seedRouteAsset(live.db, {
        libraryId,
        path: key,
        filename: 'photo.dng',
        size: original.length,
      });
      const cursor = live.db
        .query('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM asset_changes')
        .get() as { cursor: number };
      fixtures.set(key, { path, id, input, cursor: cursor.cursor });
      return {
        key,
        input,
        path,
        id,
        library: {
          id: libraryId,
          slug: 'workflow-fixture',
          path: root,
          label: 'Workflow fixtures',
          created_at: new Date().toISOString(),
          file_count: 1,
          last_scan: null,
        },
      };
    },
    {
      body: t.Object({
        xml: t.Union([t.String(), t.Null()]),
        workflow: t.Optional(t.Unknown()),
        futureSchema: t.Optional(t.Boolean()),
        synthetic: t.Optional(t.Boolean()),
      }),
    },
  )
  .post('/workflow-fixture/:key/obstruct', async ({ params }) => {
    const sidecar = fixture(params.key).path.replace(/\.dng$/, '.xmp');
    await rm(sidecar, { force: true });
    await mkdir(sidecar);
    return { blocked: true };
  })
  .post('/workflow-fixture/:key/repair', async ({ params }) => {
    const source = fixture(params.key);
    const sidecar = source.path.replace(/\.dng$/, '.xmp');
    await rm(sidecar, { force: true, recursive: true });
    if (source.input !== null) await writeFile(sidecar, source.input);
    return { repaired: true };
  })
  .post('/workflow-fixture/:key/block', ({ params }) => {
    const source = fixture(params.key);
    const latch = Promise.withResolvers<void>();
    blocked.set(source.path, {
      promise: latch.promise,
      release: () => latch.resolve(),
      arrived: 0,
    });
    return { blocked: true };
  })
  .post('/workflow-fixture/:key/release', ({ params }) => {
    const source = fixture(params.key);
    blocked.get(source.path)?.release();
    blocked.delete(source.path);
    return { released: true };
  })
  .post('/workflow-fixture/:key/race', ({ params }) => {
    const source = fixture(params.key);
    const latch = Promise.withResolvers<void>();
    races.set(source.path, {
      promise: latch.promise,
      release: () => latch.resolve(),
      arrived: 0,
      expected: 8,
    });
    return { ready: true };
  })
  .post('/workflow-fixture/:key/lose-response', ({ params }) => {
    lostResponses.add(fixture(params.key).path);
    return { armed: true };
  })
  .post('/workflow-fixture/:key/end-race', ({ params }) => {
    const source = fixture(params.key);
    races.get(source.path)?.release();
    races.delete(source.path);
    return { released: true };
  })
  .get('/workflow-fixture/:key', async ({ params }) => {
    const source = fixture(params.key);
    const sidecar = source.path.replace(/\.dng$/, '.xmp');
    const xml = await readFile(sidecar, 'utf8').catch(() => null);
    const workflow = xml === null ? null : await callNative('workflowReadXmp', [xml]);
    return {
      xml,
      blockedReads: blocked.get(source.path)?.arrived ?? 0,
      workflow: workflow?.ok ? JSON.parse(workflow.value) : null,
      original: [...(await readFile(source.path))],
      state: live.db.query('SELECT has_xmp, sidecar_ver FROM assets WHERE id = ?').get(source.id),
      changes: (
        await listChangesSince(live.handle, {
          since: source.cursor,
          limit: 100,
        })
      ).filter((row) => row.asset_id?.toHexString() === source.id),
    };
  })
  .listen({ port: receipt ? 0 : 4519, hostname: '127.0.0.1' });
if (receipt)
  await writeFile(receipt, JSON.stringify({ url: `http://127.0.0.1:${app.server!.port}` }));
async function close() {
  for (const latch of [...blocked.values(), ...races.values()]) latch.release();
  await app.stop(true);
  shutdownMaplePool();
  live.close();
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
