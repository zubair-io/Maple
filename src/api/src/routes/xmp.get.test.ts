/**
 * Route tests for GET /api/xmp — the path-keyed sidecar read.
 *
 * This endpoint is the server half of the web editor's adjustment-restore
 * path (#2406): on reload / deep-link the client fetches the sidecar back
 * before first paint, so the read semantics (200 with the exact bytes,
 * clean 404 when no sidecar exists) are load-bearing for edit persistence.
 *
 * Unit-style: a real temp directory stands in for the library root — no
 * MongoDB needed (the library-roots cache is seeded via
 * `setLibraryRootsForTests`, mirroring xmp-batch.test.ts).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Elysia } from 'elysia';
import { xmpPathRoutes } from './xmp.ts';
import { setLibraryRootsForTests } from '../indexer/libraries.cache.ts';

const app = new Elysia().use(xmpPathRoutes);

const SIDECAR_XML = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Version="11.0"
    crs:Exposure2012="1.05">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

let tmpDir: string;
const originalMapleRoots = process.env.MAPLE_ROOTS;

beforeEach(async () => {
  // realpath: on macOS os.tmpdir() lives under the /var → /private/var
  // symlink and the route's containment check compares normalized paths.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xmp-get-test-')));
  // Seed the roots cache so loadLibraryRoots() never touches Mongo, and set
  // MAPLE_ROOTS too so a concurrent test file's narrower env value can't
  // un-authorize our temp dir (bun test files share process env).
  setLibraryRootsForTests(new Map([['xmp-get-test-lib', tmpDir]]));
  process.env.MAPLE_ROOTS = tmpDir;
});

afterEach(async () => {
  setLibraryRootsForTests(null);
  if (originalMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = originalMapleRoots;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const get = (assetPath: string): Promise<Response> =>
  app.handle(new Request(`http://localhost/api/xmp?path=${encodeURIComponent(assetPath)}`));

describe('GET /api/xmp', () => {
  test('returns the sidecar XML byte-for-byte with an XML content type', async () => {
    const assetPath = path.join(tmpDir, 'IMG_0001.dng');
    await fs.writeFile(path.join(tmpDir, 'IMG_0001.xmp'), SIDECAR_XML, 'utf-8');

    const res = await get(assetPath);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(await res.text()).toBe(SIDECAR_XML);
  });

  test('404s cleanly when no sidecar exists next to the path', async () => {
    const res = await get(path.join(tmpDir, 'IMG_0002.dng'));

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No XMP sidecar');
  });

  test('403s for a path outside every registered library root', async () => {
    const res = await get('/etc/passwd');

    expect(res.status).toBe(403);
  });

  test('400s for a non-absolute path', async () => {
    const res = await get('relative/IMG_0003.dng');

    expect(res.status).toBe(400);
  });
});
