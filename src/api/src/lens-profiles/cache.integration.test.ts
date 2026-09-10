import { afterAll, beforeAll, expect, test } from 'bun:test';
import { blake3 } from '@noble/hashes/blake3.js';
import { Elysia } from 'elysia';
import { getDb, closeDb } from '../db/client.ts';
import { withTestDb, tryConnectTestMongo } from '../db/test-db.test-helpers.ts';
import { loadLensProfile, saveLensProfile } from './cache.ts';
import { lensProfileDigest, type LensProfileInventory } from './types.ts';
import { nativeLibAvailable } from '../ffi/raw_ffi.ts';
import { ffiPool, _resetFfiPoolForTests } from '../ffi/ffi-pool.ts';
import { lensProfileRoutes } from '../routes/lens-profiles.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { mkdtemp, writeFile, readFile, rm } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

withTestDb(`maple_test_lcp_cache_${process.pid}`);
let mongoAvailable = false;
beforeAll(async () => {
  const client = await tryConnectTestMongo();
  mongoAvailable = client !== null;
  await client?.close();
});
afterAll(async () => {
  _resetFfiPoolForTests();
  await closeDb();
});

function inventory(bytes: Uint8Array): LensProfileInventory {
  return {
    version: 1,
    reference: `lcp1:${Buffer.from(blake3(bytes)).toString('hex')}`,
    name: 'Synthetic',
    make: 'Maple',
    camera: 'Test',
    lens: 'Prime',
    sampleCount: 1,
  };
}

test('GridFS persists exact bytes above the single-document ceiling and deduplicates imports', async () => {
  if (!mongoAvailable) return;
  const bytes = new Uint8Array(17 * 1024 * 1024).fill(65);
  const info = inventory(bytes);
  await saveLensProfile(bytes, info);
  await saveLensProfile(bytes, info);
  const digest = lensProfileDigest(info.reference);
  const actual = await loadLensProfile(digest);
  expect(actual?.length).toBe(bytes.length);
  expect(Buffer.from(blake3(actual!)).toString('hex')).toBe(digest);
  expect(
    await (await getDb()).collection('lens_profiles.files').countDocuments({ filename: digest }),
  ).toBe(1);
});

test('missing, corrupt and oversized cached profiles fail explicitly', async () => {
  if (!mongoAvailable) return;
  expect(await loadLensProfile('0'.repeat(64))).toBeNull();
  const bytes = new Uint8Array([1, 2, 3]);
  await expect(saveLensProfile(bytes, inventory(new Uint8Array([4])))).rejects.toThrow('digest');
  await expect(
    saveLensProfile(new Uint8Array(32 * 1024 * 1024 + 1), inventory(bytes)),
  ).rejects.toThrow('32 MiB');
  const info = inventory(bytes);
  await saveLensProfile(bytes, info);
  const db = await getDb();
  const file = await db
    .collection('lens_profiles.files')
    .findOne({ filename: lensProfileDigest(info.reference) });
  await db
    .collection('lens_profiles.chunks')
    .updateOne({ files_id: file!._id }, { $set: { data: Buffer.from([9, 9, 9]) } });
  await expect(loadLensProfile(lensProfileDigest(info.reference))).rejects.toThrow('digest');
});

test('reference parsing preserves explicit approximation and rejects future versions', () => {
  expect(lensProfileDigest(`lcp1-ack:${'a'.repeat(64)}`)).toBe('a'.repeat(64));
  expect(() => lensProfileDigest(`lcp2:${'a'.repeat(64)}`)).toThrow('Unsupported');
  expect(() => lensProfileDigest('lcp1:../../profile')).toThrow();
});

const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:p="http://ns.adobe.com/photoshop/1.0/" xmlns:c="http://ns.adobe.com/photoshop/1.0/camera-profile"><r:RDF><r:Description><p:CameraProfiles><r:Seq><r:li c:Make="Maple Test" c:Model="Synthetic" c:Lens="Prime" c:CameraRawProfile="True" c:FocalLength="35"><c:PerspectiveModel c:Version="2" c:RadialDistortParam1="0.1"/></r:li></r:Seq></p:CameraProfiles></r:Description></r:RDF></x:xmpmeta>`;

test.skipIf(!nativeLibAvailable())(
  'authenticated import validates in a real child, survives child reset and downloads exact bytes',
  async () => {
    if (!mongoAvailable) return;
    const app = new Elysia().use(fakeAuth()).use(lensProfileRoutes);
    const form = new FormData();
    form.set('file', new File([xml], 'synthetic.lcp'));
    const imported = await app.handle(
      new Request('http://localhost/api/lens-profiles', { method: 'POST', body: form }),
    );
    expect(imported.status).toBe(200);
    const info = (await imported.json()) as LensProfileInventory;
    expect(info.reference).toBe(inventory(Buffer.from(xml)).reference);
    ffiPool().shutdown();
    _resetFfiPoolForTests();
    const downloaded = await app.handle(
      new Request(`http://localhost/api/lens-profiles/${lensProfileDigest(info.reference)}`),
    );
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe(xml);
    const invalid = new FormData();
    invalid.set('file', new File(['<broken'], 'invalid.lcp'));
    const rejected = await app.handle(
      new Request('http://localhost/api/lens-profiles', { method: 'POST', body: invalid }),
    );
    expect(rejected.status).toBe(422);
  },
);

test.skipIf(!nativeLibAvailable())(
  'isolated develop rejects a missing required profile but renders a disabled profile unchanged',
  async () => {
    if (!mongoAvailable) return;
    const dir = await mkdtemp(join(tmpdir(), 'maple-lcp-develop-test-'));
    const raw = resolve(
      import.meta.dir,
      '../../..',
      'apple/MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng',
    );
    const sidecar = join(dir, 'adjustments.xmp');
    const ref = `lcp1:${'0'.repeat(64)}`;
    const sidecarXml = (enabled: number) =>
      `<x><rdf:Description xmlns:rdf="x" xmlns:crs="x" xmlns:papp="x" crs:LensProfileEnable="${enabled}" papp:LensProfile="${ref}"/></x>`;
    try {
      await ffiPool().renderDevelopJpegToFile(raw, null, join(dir, 'base.jpg'), 64);
      await writeFile(sidecar, sidecarXml(0));
      await ffiPool().renderDevelopJpegToFile(raw, sidecar, join(dir, 'off.jpg'), 64);
      expect(await readFile(join(dir, 'off.jpg'))).toEqual(await readFile(join(dir, 'base.jpg')));
      await writeFile(sidecar, sidecarXml(1));
      await expect(
        ffiPool().renderDevelopJpegToFile(raw, sidecar, join(dir, 'missing.jpg'), 64),
      ).rejects.toThrow('not in the local cache');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('profile endpoints reject users without file access', async () => {
  const app = new Elysia().use(fakeAuth({ file_access: false })).use(lensProfileRoutes);
  const response = await app.handle(
    new Request(`http://localhost/api/lens-profiles/${'a'.repeat(64)}`),
  );
  expect(response.status).toBe(403);
});
