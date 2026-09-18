/**
 * Lens-profile storage, end to end.
 *
 * File-backed rather than in-memory, and `MAPLE_SQLITE_PATH` points at it: the
 * develop cases below drive the real FFI decode child, which opens its own pool
 * on the path it inherits. That is the one place in the system where a child
 * process reaches this table, so it is worth exercising rather than stubbing.
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { blake3 } from '@noble/hashes/blake3.js';
import { Elysia } from 'elysia';
import {
  createLiveTestDatabase,
  run,
  type LiveTestDatabase,
} from '../db/sqlite/test-sqlite.test-helpers.ts';
import { __resetLensProfileCacheForTests, loadLensProfile, saveLensProfile } from './cache.ts';
import { lensProfileDigest, type LensProfileInventory } from './types.ts';
import { nativeLibAvailable } from '../ffi/raw_ffi.ts';
import { ffiPool, _resetFfiPoolForTests } from '../ffi/ffi-pool.ts';
import { lensProfileRoutes } from '../routes/lens-profiles.ts';
import { fakeAuth } from '../../tests/helpers/test-auth.ts';
import { mkdtemp, writeFile, readFile, rm } from '../fs/mirrored.ts';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let live: LiveTestDatabase;
let priorPath: string | undefined;

beforeAll(async () => {
  live = await createLiveTestDatabase('file');
  priorPath = process.env.MAPLE_SQLITE_PATH;
  process.env.MAPLE_SQLITE_PATH = live.path;
});

afterEach(() => {
  // The loader keeps the last profile it read, and these cases deliberately
  // rewrite a stored blob underneath it.
  __resetLensProfileCacheForTests();
});

afterAll(() => {
  _resetFfiPoolForTests();
  if (priorPath === undefined) delete process.env.MAPLE_SQLITE_PATH;
  else process.env.MAPLE_SQLITE_PATH = priorPath;
  live.close();
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

function storedCount(digest: string): number {
  const row = live.db
    .query(`SELECT COUNT(*) AS n FROM lens_profiles WHERE digest = ?`)
    .get(digest) as { n: number };
  return row.n;
}

test('persists exact bytes above the old document ceiling and deduplicates imports', async () => {
  // 17 MiB is over MongoDB's 16 MiB limit, which is why this was a GridFS
  // bucket; the blob column has no such ceiling and the bytes must still
  // round-trip identically.
  const bytes = new Uint8Array(17 * 1024 * 1024).fill(65);
  const info = inventory(bytes);
  await saveLensProfile(bytes, info);
  await saveLensProfile(bytes, info);
  const digest = lensProfileDigest(info.reference);
  const actual = await loadLensProfile(digest);
  expect(actual?.length).toBe(bytes.length);
  expect(Buffer.from(blake3(actual!)).toString('hex')).toBe(digest);
  expect(storedCount(digest)).toBe(1);
});

test('answers a repeat read from memory instead of the database', async () => {
  const bytes = new Uint8Array([7, 7, 7, 7]);
  const info = inventory(bytes);
  const digest = lensProfileDigest(info.reference);
  await saveLensProfile(bytes, info);
  expect(await loadLensProfile(digest)).not.toBeNull();

  // Delete the row underneath the cache. A second read that still answers can
  // only have come from memory — which is what keeps a slider tick off the
  // database. See the module comment on the 16 ms budget.
  run(live.db, `DELETE FROM lens_profiles WHERE digest = ?`, digest);
  expect(await loadLensProfile(digest)).not.toBeNull();

  __resetLensProfileCacheForTests();
  expect(await loadLensProfile(digest)).toBeNull();
});

test('missing, corrupt and oversized cached profiles fail explicitly', async () => {
  expect(await loadLensProfile('0'.repeat(64))).toBeNull();
  const bytes = new Uint8Array([1, 2, 3]);
  await expect(saveLensProfile(bytes, inventory(new Uint8Array([4])))).rejects.toThrow('digest');
  await expect(
    saveLensProfile(new Uint8Array(32 * 1024 * 1024 + 1), inventory(bytes)),
  ).rejects.toThrow('32 MiB');

  const info = inventory(bytes);
  await saveLensProfile(bytes, info);
  const digest = lensProfileDigest(info.reference);
  // A blob that no longer hashes to its own key is the failure that would
  // otherwise change every rendered pixel of a photo using this profile.
  run(
    live.db,
    `UPDATE lens_profiles SET bytes = ? WHERE digest = ?`,
    new Uint8Array([9, 9, 9]),
    digest,
  );
  __resetLensProfileCacheForTests();
  await expect(loadLensProfile(digest)).rejects.toThrow('digest');
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
    __resetLensProfileCacheForTests();
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
      // The child opens its own pool on MAPLE_SQLITE_PATH, finds no such
      // profile, and reports the miss rather than failing to reach a database.
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
