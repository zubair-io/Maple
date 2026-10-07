/** Real-file conditional XMP route contract for native Linux sync (#4317). */
import { beforeEach, afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Elysia } from 'elysia';
import { xmpPathRoutes } from './xmp';
import { setLibraryRootsForTests } from '../indexer/libraries.cache';

const app = new Elysia().use(xmpPathRoutes);
const xml = (exposure: number) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="${exposure}"/></rdf:RDF></x:xmpmeta>`;
let root: string;
let original: string;
let sidecar: string;
const oldRoots = process.env.MAPLE_ROOTS;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'linux-cloud-xmp-')));
  original = path.join(root, 'photo.dng');
  sidecar = path.join(root, 'photo.xmp');
  await fs.writeFile(original, 'original bytes');
  process.env.MAPLE_ROOTS = root;
  setLibraryRootsForTests(new Map([['linux-cloud-test', root]]));
});
afterEach(async () => {
  setLibraryRootsForTests(null);
  if (oldRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = oldRoots;
  await fs.rm(root, { recursive: true, force: true });
});
const get = () =>
  app.handle(new Request(`http://localhost/api/xmp?path=${encodeURIComponent(original)}`));
const save = (body: string, headers: Record<string, string>) =>
  app.handle(
    new Request(`http://localhost/api/xmp?path=${encodeURIComponent(original)}`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/xml', ...headers },
    }),
  );

test('ETag save and create-only preserve originals and return the published version', async () => {
  const missing = await get();
  expect(missing.status).toBe(404);
  expect(missing.headers.get('X-Maple-Xmp-Preconditions')).toBe('content-etag-v1');
  const created = await save(xml(1), { 'If-None-Match': '*' });
  expect(created.status).toBe(200);
  const current = await get();
  expect(current.headers.get('ETag')).toBe(created.headers.get('ETag'));
  const changed = await save(xml(2), { 'If-Match': current.headers.get('ETag')! });
  expect(changed.status).toBe(200);
  expect(changed.headers.get('ETag')).not.toBe(created.headers.get('ETag'));
  expect(await fs.readFile(sidecar, 'utf8')).toBe(xml(2));
  expect(await fs.readFile(original, 'utf8')).toBe('original bytes');
});

test('same-second external changes and deletion reject stale clients', async () => {
  await fs.writeFile(sidecar, xml(1));
  const initial = await get();
  const etag = initial.headers.get('ETag')!;
  const mtime = (await fs.stat(sidecar)).mtime;
  await fs.writeFile(sidecar, xml(3));
  await fs.utimes(sidecar, mtime, mtime);
  expect((await save(xml(2), { 'If-Match': etag })).status).toBe(412);
  expect(await fs.readFile(sidecar, 'utf8')).toBe(xml(3));
  await fs.unlink(sidecar);
  expect((await save(xml(2), { 'If-Match': etag })).status).toBe(412);
  expect(await fs.exists(sidecar)).toBe(false);
});

test('concurrent writers with one baseline cannot both win', async () => {
  await fs.writeFile(sidecar, xml(0));
  const baseline = (await get()).headers.get('ETag')!;
  const results = await Promise.all([
    save(xml(1), { 'If-Match': baseline }),
    save(xml(2), { 'If-Match': baseline }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
  expect([xml(1), xml(2)]).toContain(await fs.readFile(sidecar, 'utf8'));
});

test('concurrent create-only writers and invalid preconditions do not overwrite', async () => {
  const results = await Promise.all([
    save(xml(1), { 'If-None-Match': '*' }),
    save(xml(2), { 'If-None-Match': '*' }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
  const before = await fs.readFile(sidecar, 'utf8');
  const invalid: Record<string, string>[] = [
    { 'If-Match': 'W/"weak"' },
    { 'If-None-Match': 'invalid' },
    { 'If-Match': '"both"', 'If-None-Match': '*' },
  ];
  for (const headers of invalid) {
    expect((await save(xml(9), headers)).status).toBe(400);
    expect(await fs.readFile(sidecar, 'utf8')).toBe(before);
  }
});
