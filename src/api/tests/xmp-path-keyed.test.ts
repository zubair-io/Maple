/**
 * Integration tests for the path-keyed XMP API (slice 3 of #193).
 *
 *   GET    /api/xmp?path=…
 *   POST   /api/xmp?path=…
 *   DELETE /api/xmp?path=…
 *
 * The handler does NO asset lookup: it validates that the caller-supplied
 * absolute path lives inside a registered library root, resolves the `.xmp`
 * sibling, and reads / writes / deletes directly. Tests round-trip against real
 * temp directories — no mocks. We also pin down the deprecation signal on the
 * legacy id-keyed route.
 *
 * Real SQLite installed as the process-wide handle for the file (#3787): the
 * library root the jail authorises against is a `folders` row, and the
 * deprecation case resolves a real asset.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedIndexedAsset } from './helpers/fs-route-fixtures.ts';
import {
  createLiveTestDatabase,
  insertFolder,
  type LiveTestDatabase,
} from '../src/db/sqlite/test-sqlite.test-helpers.ts';
import { withTestEnv } from '../src/test-support/env.test-helpers.ts';

const ROOT = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-xmp-path-')));
// A second tmpdir that is NOT registered as a library root — used to assert the
// auth boundary rejects out-of-tree paths. Constraining the FS jail to ONLY the
// library root is what makes that check meaningful.
const OUTSIDE = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'maple-xmp-path-outside-')));
withTestEnv('MAPLE_ROOTS', ROOT);

let live: LiveTestDatabase;
let libraryId: string;

function url(absPath: string): string {
  return `http://test/api/xmp?path=${encodeURIComponent(absPath)}`;
}

describe('path-keyed /api/xmp', () => {
  beforeAll(async () => {
    live = await createLiveTestDatabase();
    libraryId = insertFolder(live.db, { path: ROOT, slug: 'xmp-path-test' });
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
  });

  afterAll(async () => {
    live.close();
    const { invalidateLibraryRoots } = await import('../src/indexer/libraries.cache.ts');
    invalidateLibraryRoots();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.rm(OUTSIDE, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    // Clean the library root between tests so paths from a previous test don't
    // leak in.
    for (const entry of await fs.readdir(ROOT)) {
      await fs.rm(path.join(ROOT, entry), { recursive: true, force: true });
    }
  });

  it('GET returns 200 + body when the sidecar exists', async () => {
    const rawPath = path.join(ROOT, 'IMG_GET.ARW');
    const xmpPath = path.join(ROOT, 'IMG_GET.xmp');
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
    const rawPath = path.join(ROOT, 'IMG_404.ARW');
    await fs.writeFile(rawPath, 'raw');
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    const res = await xmpPathRoutes.handle(new Request(url(rawPath), { method: 'GET' }));
    expect(res.status).toBe(404);
  });

  it('POST writes the sidecar and GET reads it back (roundtrip)', async () => {
    const rawPath = path.join(ROOT, 'IMG_RT.ARW');
    const xmpPath = path.join(ROOT, 'IMG_RT.xmp');
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
    const rawPath = path.join(ROOT, 'IMG_DEL.ARW');
    const xmpPath = path.join(ROOT, 'IMG_DEL.xmp');
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
    const outsidePath = path.join(OUTSIDE, 'IMG_OUT.ARW');
    await fs.writeFile(outsidePath, 'raw');
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    const res = await xmpPathRoutes.handle(new Request(url(outsidePath), { method: 'GET' }));
    expect(res.status).toBe(403);
  });

  it('rejects classic traversal attempts (?path=/etc/passwd)', async () => {
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    // /etc lives outside MAPLE_ROOTS (which is ROOT here), so the root check
    // rejects with 403 well before any filesystem touch.
    const res = await xmpPathRoutes.handle(new Request(url('/etc/passwd'), { method: 'GET' }));
    expect(res.status).toBe(403);
  });

  it('rejects `..` traversal that escapes the library root', async () => {
    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    // path.resolve flattens `..` lexically — anything outside ROOT lands
    // outside any root and 403s.
    const sneaky = `${ROOT}/../../../etc/passwd`;
    const res = await xmpPathRoutes.handle(new Request(url(sneaky), { method: 'GET' }));
    expect(res.status).toBe(403);
  });

  it('rejects missing or relative path query', async () => {
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
    // The handler doesn't touch the asset catalogue — but the design contract
    // is "two paths → two sidecars". Round-trip independently and confirm they
    // don't bleed.
    const a = path.join(ROOT, 'sub_a', 'IMG.ARW');
    const b = path.join(ROOT, 'sub_b', 'IMG.ARW');
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.mkdir(path.dirname(b), { recursive: true });
    // Identical bytes — same content hash / maple_id.
    await fs.writeFile(a, 'identical-bytes');
    await fs.writeFile(b, 'identical-bytes');

    const xmlA = '<x:xmpmeta data="A"/>';
    const xmlB = '<x:xmpmeta data="B"/>';

    const { xmpPathRoutes } = await import('../src/routes/xmp.ts');
    await xmpPathRoutes.handle(
      new Request(url(a), {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: xmlA,
      }),
    );
    await xmpPathRoutes.handle(
      new Request(url(b), {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: xmlB,
      }),
    );

    const gotA = await xmpPathRoutes.handle(new Request(url(a), { method: 'GET' }));
    const gotB = await xmpPathRoutes.handle(new Request(url(b), { method: 'GET' }));
    expect(await gotA.text()).toBe(xmlA);
    expect(await gotB.text()).toBe(xmlB);
  });

  it('symlinks: RAW-level symlink → independent sidecars (sibling of each stem)', async () => {
    // Two paths whose RAWs alias via a symlink, but whose `.xmp` siblings live
    // next to the user-facing stem. The handler operates on the supplied path
    // *lexically* (no realpath), so each path keeps its own sidecar — matching
    // the design spec's intent that XMP is keyed on user-facing path, not on
    // the underlying content.
    const dir = path.join(ROOT, 'symtest-raw');
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
    // The design comment on #193 calls out this case explicitly: "if two paths
    // resolve to the same `.xmp` via a symlink, they share (matches user intent
    // — one underlying file, one sidecar). Don't normalize-away in the API."
    //
    // We don't *invent* sharing — but if the user (or a future shadow-copy UI)
    // has already symlinked the `.xmp` siblings, the handler must surface that
    // natural sharing via plain file I/O.
    const dir = path.join(ROOT, 'symtest-sidecar');
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
    // Seed an asset row so the id-keyed handler resolves a real path.
    const filename = 'IMG_DEPR.ARW';
    await fs.writeFile(path.join(ROOT, filename), 'raw');
    const assetId = seedIndexedAsset(live.db, { libraryId, filename });
    const { assetsRoutes } = await import('../src/routes/assets.ts');
    const res = await assetsRoutes.handle(
      new Request(`http://test/api/assets/${assetId}/xmp`, { method: 'GET' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toBe('true');
    expect(res.headers.get('link') ?? '').toContain('rel="successor-version"');
    expect(res.headers.get('link') ?? '').toContain('/api/xmp?path=');
  });
});
