/**
 * Integration tests for the path-keyed XMP API (slice 3 of #193).
 *
 *   GET    /api/xmp?path=…
 *   POST   /api/xmp?path=…
 *   DELETE /api/xmp?path=…
 *
 * The handler does NO asset-collection lookup: it validates that the
 * caller-supplied absolute path lives inside a registered library
 * root, resolves the `.xmp` sibling, and reads / writes / deletes
 * directly. Tests round-trip against real temp directories — no
 * mocks. We also pin down the deprecation signal on the legacy
 * id-keyed route.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { pendingEnrichment } from '../src/db/schema.ts';

const TEST_DB = `maple_test_xmp_path_${process.pid}`;
const PRIOR_MONGO_DB = process.env.MAPLE_MONGO_DB;
const PRIOR_MAPLE_ROOTS = process.env.MAPLE_ROOTS;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpRoot: string;
let realTmpRoot: string;
let outsideRoot: string;
let realOutsideRoot: string;
let libraryId: ObjectId;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db('admin').command({ ping: 1 });
    return c;
  } catch {
    try {
      await c.close();
    } catch {}
    return null;
  }
}

function url(absPath: string): string {
  return `http://test/api/xmp?path=${encodeURIComponent(absPath)}`;
}

describe('path-keyed /api/xmp', () => {
  beforeAll(async () => {
    const { closeDb } = await import('../src/db/client.ts');
    await closeDb();
    process.env.MAPLE_MONGO_DB = TEST_DB;
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) return;

    db = mongo!.db(TEST_DB);
    await db.dropDatabase();

    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-xmp-path-'));
    realTmpRoot = await fs.realpath(tmpRoot);
    // A second tmpdir that is NOT registered as a library root — used
    // to assert the auth boundary rejects out-of-tree paths.
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maple-xmp-path-outside-'));
    realOutsideRoot = await fs.realpath(outsideRoot);

    // Constrain the FS jail to ONLY the library root — the outside dir
    // must therefore fail the auth check.
    process.env.MAPLE_ROOTS = realTmpRoot;

    libraryId = new ObjectId();
    const now = new Date().toISOString();
    await db.collection('folders').insertOne({
      _id: libraryId,
      path: realTmpRoot,
      label: 'test',
      created_at: now,
      file_count: 0,
    } as never);
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    const { closeDb } = await import('../src/db/client.ts');
    await closeDb();
    if (mongo) {
      try {
        await db?.dropDatabase();
      } catch {}
      await mongo.close();
    }
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {}
    try {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    } catch {}
    if (PRIOR_MONGO_DB === undefined) delete process.env.MAPLE_MONGO_DB;
    else process.env.MAPLE_MONGO_DB = PRIOR_MONGO_DB;
    if (PRIOR_MAPLE_ROOTS === undefined) delete process.env.MAPLE_ROOTS;
    else process.env.MAPLE_ROOTS = PRIOR_MAPLE_ROOTS;
  });

  beforeEach(async () => {
    if (!mongoReachable) return;
    // Clean the library root between tests so paths from a previous
    // test don't leak in.
    const ents = await fs.readdir(realTmpRoot);
    for (const e of ents) {
      await fs.rm(path.join(realTmpRoot, e), { recursive: true, force: true });
    }
  });

  it('GET returns 200 + body when the sidecar exists', async () => {
    if (!mongoReachable) return;
    const rawPath = path.join(realTmpRoot, 'IMG_GET.ARW');
    const xmpPath = path.join(realTmpRoot, 'IMG_GET.xmp');
    await fs.writeFile(rawPath, 'raw');
    const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>';
    await fs.writeFile(xmpPath, xml);
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    const res = await xmpPathRoutes.handle(new Request(url(rawPath), { method: 'GET' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(await res.text()).toBe(xml);
  });

  it('GET returns 404 when no sidecar exists', async () => {
    if (!mongoReachable) return;
    const rawPath = path.join(realTmpRoot, 'IMG_404.ARW');
    await fs.writeFile(rawPath, 'raw');
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    const res = await xmpPathRoutes.handle(new Request(url(rawPath), { method: 'GET' }));
    expect(res.status).toBe(404);
  });

  it('POST writes the sidecar and GET reads it back (roundtrip)', async () => {
    if (!mongoReachable) return;
    const rawPath = path.join(realTmpRoot, 'IMG_RT.ARW');
    const xmpPath = path.join(realTmpRoot, 'IMG_RT.xmp');
    await fs.writeFile(rawPath, 'raw');
    const xml =
      '<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>';
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    const post = await xmpPathRoutes.handle(
      new Request(url(rawPath), {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: xml,
      }),
    );
    expect(post.status).toBe(200);
    // Round-trip via the filesystem.
    expect(await fs.readFile(xmpPath, 'utf-8')).toBe(xml);
    // Round-trip via the GET handler.
    const get = await xmpPathRoutes.handle(new Request(url(rawPath), { method: 'GET' }));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe(xml);
  });

  it('DELETE removes the sidecar (204), follow-up DELETE is 404', async () => {
    if (!mongoReachable) return;
    const rawPath = path.join(realTmpRoot, 'IMG_DEL.ARW');
    const xmpPath = path.join(realTmpRoot, 'IMG_DEL.xmp');
    await fs.writeFile(rawPath, 'raw');
    await fs.writeFile(xmpPath, '<x:xmpmeta/>');
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');

    const first = await xmpPathRoutes.handle(new Request(url(rawPath), { method: 'DELETE' }));
    expect(first.status).toBe(204);
    await expect(fs.access(xmpPath)).rejects.toThrow();
    // RAW is untouched.
    await fs.access(rawPath);

    const second = await xmpPathRoutes.handle(new Request(url(rawPath), { method: 'DELETE' }));
    expect(second.status).toBe(404);
  });

  it('rejects paths outside any indexed library root with 403', async () => {
    if (!mongoReachable) return;
    const outsidePath = path.join(realOutsideRoot, 'IMG_OUT.ARW');
    await fs.writeFile(outsidePath, 'raw');
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    const res = await xmpPathRoutes.handle(new Request(url(outsidePath), { method: 'GET' }));
    expect(res.status).toBe(403);
  });

  it('rejects classic traversal attempts (?path=/etc/passwd)', async () => {
    if (!mongoReachable) return;
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    // /etc lives outside MAPLE_ROOTS (which is realTmpRoot here), so
    // the root check rejects with 403 well before any filesystem
    // touch.
    const res = await xmpPathRoutes.handle(
      new Request(url('/etc/passwd'), { method: 'GET' }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects `..` traversal that escapes the library root', async () => {
    if (!mongoReachable) return;
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    // path.resolve flattens `..` lexically — anything outside
    // realTmpRoot lands outside any root and 403s.
    const sneaky = `${realTmpRoot}/../../../etc/passwd`;
    const res = await xmpPathRoutes.handle(new Request(url(sneaky), { method: 'GET' }));
    expect(res.status).toBe(403);
  });

  it('rejects missing or relative path query', async () => {
    if (!mongoReachable) return;
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    const missing = await xmpPathRoutes.handle(
      new Request('http://test/api/xmp', { method: 'GET' }),
    );
    expect(missing.status).toBe(422);

    const rel = await xmpPathRoutes.handle(
      new Request('http://test/api/xmp?path=relative/IMG.ARW', { method: 'GET' }),
    );
    expect(rel.status).toBe(400);
  });

  it('two distinct paths get independent sidecars even with the same maple_id', async () => {
    if (!mongoReachable) return;
    // The handler doesn't touch the asset collection — but the design
    // contract is "two paths → two sidecars". Round-trip independently
    // and confirm they don't bleed.
    const a = path.join(realTmpRoot, 'sub_a', 'IMG.ARW');
    const b = path.join(realTmpRoot, 'sub_b', 'IMG.ARW');
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.mkdir(path.dirname(b), { recursive: true });
    // Identical bytes — same content hash / maple_id.
    await fs.writeFile(a, 'identical-bytes');
    await fs.writeFile(b, 'identical-bytes');

    const xmlA = '<x:xmpmeta data="A"/>';
    const xmlB = '<x:xmpmeta data="B"/>';

    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    await xmpPathRoutes.handle(
      new Request(url(a), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: xmlA }),
    );
    await xmpPathRoutes.handle(
      new Request(url(b), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: xmlB }),
    );

    const gotA = await xmpPathRoutes.handle(new Request(url(a), { method: 'GET' }));
    const gotB = await xmpPathRoutes.handle(new Request(url(b), { method: 'GET' }));
    expect(await gotA.text()).toBe(xmlA);
    expect(await gotB.text()).toBe(xmlB);
  });

  it('symlinks: RAW-level symlink → independent sidecars (sibling of each stem)', async () => {
    if (!mongoReachable) return;
    // Two paths whose RAWs alias via a symlink, but whose `.xmp`
    // siblings live next to the user-facing stem. The handler
    // operates on the supplied path *lexically* (no realpath), so
    // each path keeps its own sidecar — matches the design spec
    // intent that XMP is keyed on user-facing path, not on the
    // underlying content.
    const dir = path.join(realTmpRoot, 'symtest-raw');
    await fs.mkdir(dir, { recursive: true });
    const realRaw = path.join(dir, 'real.ARW');
    await fs.writeFile(realRaw, 'raw');
    const link = path.join(dir, 'link.ARW');
    await fs.symlink(realRaw, link);

    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    await xmpPathRoutes.handle(
      new Request(url(link), {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '<x:xmpmeta data="via-link"/>',
      }),
    );
    // `real.xmp` was never written → 404. `link.xmp` was → 200.
    const viaReal = await xmpPathRoutes.handle(new Request(url(realRaw), { method: 'GET' }));
    expect(viaReal.status).toBe(404);
    const viaLink = await xmpPathRoutes.handle(new Request(url(link), { method: 'GET' }));
    expect(viaLink.status).toBe(200);
    expect(await viaLink.text()).toBe('<x:xmpmeta data="via-link"/>');
  });

  it('symlinks: sidecar-level symlink → two paths share the underlying bytes', async () => {
    if (!mongoReachable) return;
    // The design comment on #193 calls out this case explicitly:
    // "if two paths resolve to the same `.xmp` via a symlink, they
    // share (matches user intent — one underlying file, one
    // sidecar). Don't normalize-away in the API."
    //
    // We don't *invent* sharing — but if the user (or a future
    // shadow-copy UI) has already symlinked the `.xmp` siblings, the
    // handler must surface that natural sharing via plain file I/O.
    const dir = path.join(realTmpRoot, 'symtest-sidecar');
    await fs.mkdir(dir, { recursive: true });
    const shared = path.join(dir, 'shared.xmp');
    await fs.writeFile(shared, '<x:xmpmeta shared="1"/>');
    const aliasRaw = path.join(dir, 'alias.ARW');
    const aliasXmp = path.join(dir, 'alias.xmp');
    await fs.writeFile(aliasRaw, 'raw');
    await fs.symlink(shared, aliasXmp);

    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    const aliased = await xmpPathRoutes.handle(new Request(url(aliasRaw), { method: 'GET' }));
    expect(aliased.status).toBe(200);
    expect(await aliased.text()).toBe('<x:xmpmeta shared="1"/>');
  });

  it('legacy id-keyed route emits a Deprecation header pointing at the successor', async () => {
    if (!mongoReachable) return;
    // Seed an asset row so the id-keyed handler resolves a real path.
    const filename = 'IMG_DEPR.ARW';
    const rawPath = path.join(realTmpRoot, filename);
    await fs.writeFile(rawPath, 'raw');
    const assetId = new ObjectId();
    await db!.collection('assets').insertOne({
      _id: assetId,
      fileinfo: [{ library_id: libraryId, path: '', filename, deleted_at: null }],
      size: 3,
      mtime: new Date().toISOString(),
      indexed_at: new Date().toISOString(),
      enrichment: pendingEnrichment(),
    } as never);
    const { assetsRoutes } = await import('../src/routes/assets.ts');
    const res = await assetsRoutes.handle(
      new Request(`http://test/api/assets/${assetId.toHexString()}/xmp`, { method: 'GET' }),
    );
    expect(res.headers.get('deprecation')).toBe('true');
    expect(res.headers.get('link') ?? '').toContain('rel="successor-version"');
    expect(res.headers.get('link') ?? '').toContain('/api/xmp?path=');
  });
});
