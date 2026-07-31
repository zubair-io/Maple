/**
 * Content-type contract tests for POST /api/xmp — the path-keyed sidecar
 * write (#2406, second layer).
 *
 * The web client (`BunApiBackendService.putXmp`) sends the sidecar body with
 * `Content-Type: application/xml`. The route declared `type: 'text'`, but in
 * this Elysia version the `type` hook is vestigial — parser selection reads
 * only the `parse` hook, and without one the default content-type sniff maps
 * `application/xml` to the urlencoded parser (`charCodeAt(12) === 'x'`, the
 * same branch as `application/x-www-form-urlencoded`). The body arrived as a
 * garbage object, failed `t.String()` validation, and every live editor
 * write 422'd without touching disk. The pre-existing route tests only ever
 * POSTed `text/plain`, so the gap stayed latent for as long as the client
 * write path was dead (revived by the first half of #2406).
 *
 * Unit-style: a real temp directory stands in for the library root — no
 * MongoDB needed (roots seeded via `setLibraryRootsForTests` + MAPLE_ROOTS,
 * mirroring xmp.get.test.ts).
 *
 * Raw `node:fs/promises` (allowlisted in .oxlintrc.json): temp-fixture
 * reads/writes under mkdtemp only — throwaway test sidecars that must NOT
 * replicate through the src/fs/mirrored.ts backup mirror.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
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
    crs:Exposure2012="2.16">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

let tmpDir: string;
const originalMapleRoots = process.env.MAPLE_ROOTS;

beforeEach(async () => {
  // realpath: on macOS os.tmpdir() lives under the /var → /private/var
  // symlink and both the route's containment check and writeXmpAtomic's
  // safeWriteAllowed compare normalized paths.
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xmp-post-ct-test-')));
  setLibraryRootsForTests(new Map([['xmp-post-ct-test-lib', tmpDir]]));
  process.env.MAPLE_ROOTS = tmpDir;
});

afterEach(async () => {
  setLibraryRootsForTests(null);
  if (originalMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = originalMapleRoots;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const post = (assetPath: string, contentType: string, body: string): Promise<Response> =>
  app.handle(
    new Request(`http://localhost/api/xmp?path=${encodeURIComponent(assetPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    }),
  );

const del = (assetPath: string): Promise<Response> =>
  app.handle(
    new Request(`http://localhost/api/xmp?path=${encodeURIComponent(assetPath)}`, {
      method: 'DELETE',
    }),
  );

const get = (assetPath: string): Promise<Response> =>
  app.handle(new Request(`http://localhost/api/xmp?path=${encodeURIComponent(assetPath)}`));

describe('POST /api/xmp content-type contract', () => {
  test('accepts Content-Type: application/xml (the real web client header) and writes the sidecar', async () => {
    const assetPath = path.join(tmpDir, 'test_0017.dng');
    const sidecarPath = path.join(tmpDir, 'test_0017.xmp');

    const res = await post(assetPath, 'application/xml', SIDECAR_XML);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SIDECAR_XML);
    expect(await fs.readFile(sidecarPath, 'utf-8')).toBe(SIDECAR_XML);
  });

  test('accepts application/xml with a charset parameter', async () => {
    const assetPath = path.join(tmpDir, 'IMG_CT2.dng');

    const res = await post(assetPath, 'application/xml; charset=utf-8', SIDECAR_XML);

    expect(res.status).toBe(200);
    expect(await fs.readFile(path.join(tmpDir, 'IMG_CT2.xmp'), 'utf-8')).toBe(SIDECAR_XML);
  });

  test('still accepts Content-Type: text/plain (pre-existing contract)', async () => {
    const assetPath = path.join(tmpDir, 'IMG_CT3.dng');

    const res = await post(assetPath, 'text/plain', SIDECAR_XML);

    expect(res.status).toBe(200);
    expect(await fs.readFile(path.join(tmpDir, 'IMG_CT3.xmp'), 'utf-8')).toBe(SIDECAR_XML);
  });

  test('DELETE (no body / no content type, as the client sends it) removes an application/xml-written sidecar', async () => {
    const assetPath = path.join(tmpDir, 'IMG_CT4.dng');
    const sidecarPath = path.join(tmpDir, 'IMG_CT4.xmp');
    await post(assetPath, 'application/xml', SIDECAR_XML);
    await fs.access(sidecarPath); // written

    const res = await del(assetPath);

    expect(res.status).toBe(204);
    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });

  test('round-trips exact sidecar bytes without modifying the original RAW', async () => {
    const assetPath = path.join(tmpDir, 'IMG_SAFE.dng');
    const raw = crypto.getRandomValues(new Uint8Array(4096));
    await fs.writeFile(assetPath, raw);
    const hashBefore = createHash('sha256').update(raw).digest('hex');

    const write = await post(assetPath, 'application/xml', SIDECAR_XML);
    expect(write.status).toBe(200);

    const read = await get(assetPath);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe(SIDECAR_XML);
    expect(await fs.readFile(path.join(tmpDir, 'IMG_SAFE.xmp'), 'utf8')).toBe(SIDECAR_XML);
    const hashAfter = createHash('sha256').update(await fs.readFile(assetPath)).digest('hex');
    expect(hashAfter).toBe(hashBefore);
  });
});
