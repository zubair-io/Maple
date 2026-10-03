/** Actual HTTP/SQLite/native retry fixture; only disposable committed synthetic RAW copies (#4111). */
import { Elysia } from 'elysia';
import { randomUUID, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from '../../src/fs/mirrored';
import { registerRoot } from '../../src/fs/root';
import { createLiveTestDatabase, insertFolder } from '../../src/db/sqlite/test-sqlite.test-helpers';
import { invalidateLibraryRoots } from '../../src/indexer/libraries.cache';
import { createJobsRoutes } from '../../src/routes/jobs';
import { JobRunner } from '../../src/job-runner/runner';
import { DEFAULT_EXPORT_RECIPE } from '../../src/generated/export-recipe.generated';
import { _resetFfiPoolForTests, ffiPool } from '../../src/ffi/ffi-pool';

if (!ffiPool().available()) throw Error('Actual native export library is required');
const root = await realpath(await mkdtemp(join(tmpdir(), 'maple-retry-browser-')));
registerRoot(root);
const live = await createLiveTestDatabase('file');
insertFolder(live.db, { path: root, slug: 'retry-browser' });
invalidateLibraryRoots();
const raw = await readFile(
  resolve(import.meta.dir, '../../../../test-fixtures/batch-transfer/source.dng'),
);
const xml =
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="1.2"/></rdf:RDF>';
const jobs = new JobRunner();
jobs.start();
const fixtures = new Map<string, string[]>();
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const app = new Elysia()
  .use(createJobsRoutes())
  .get('/workflow-fixture/health', () => ({ ready: true }))
  .post('/workflow-fixture', async () => {
    const key = randomUUID();
    const directory = join(root, key);
    const output = join(directory, 'exports');
    await mkdir(output, { recursive: true });
    const paths = [join(directory, 'a.dng'), join(output, 'a_1.png')];
    for (const path of paths) {
      await writeFile(path, raw);
      await writeFile(path + '.xmp', xml);
    }
    fixtures.set(key, paths);
    return {
      key,
      originalHash: hash(raw),
      xml,
      targets: paths.map((path, index) => ({
        id: `retry-browser:${key}:${index}`,
        path,
        xmp: xml,
        index,
        capturedAt: null,
        filename: path.split('/').at(-1),
        filmLook: '',
      })),
      recipe: {
        ...DEFAULT_EXPORT_RECIPE,
        format: 'png',
        quality: null,
        destination: 'directory',
        directory: output,
        overwritePolicy: 'replace',
        namingTemplate: '{original}_{n}.{ext}',
      },
    };
  })
  .get('/workflow-fixture/:key', async ({ params }) => {
    const paths = fixtures.get(params.key);
    if (!paths) throw Error('Unknown owned fixture');
    return {
      hashes: await Promise.all(paths.map(async (path) => hash(await readFile(path)))),
      xml: await Promise.all(paths.map((path) => readFile(path + '.xmp', 'utf8'))),
    };
  })
  .listen({ hostname: '127.0.0.1', port: 4519 });
async function close() {
  try {
    await jobs.stop();
    await app.stop(true);
  } finally {
    _resetFfiPoolForTests();
    live.close();
    await rm(root, { recursive: true, force: true });
  }
  process.exit(0);
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
