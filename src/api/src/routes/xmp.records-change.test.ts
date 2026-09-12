/**
 * #3563 — the path-keyed sidecar routes (the ones the web editor writes
 * through) must leave the same trail the id-keyed `PUT/DELETE
 * /api/assets/:id/xmp` do: `has_xmp` / `sidecar_ver` on the asset and an
 * `update` row on the change feed, so the File Provider extensions learn
 * that a mounted folder's `.xmp` changed on the server.
 *
 * Needs a reachable Mongo (see `withTestDb`); skip-passes without one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { xmpPathRoutes } from './xmp.ts';
import { listChangesSince } from '../db/changes.repo.ts';
import { closeDb, getDb, isDbConnected } from '../db/client.ts';
import { withTestDb } from '../db/test-db.test-helpers.ts';

withTestDb(`maple_test_xmp_path_changes_${process.pid}`);

let db: Db | null = null;
let tmp: string | null = null;
let mongoReachable = false;
let originalMapleRoots: string | undefined;

beforeAll(async () => {
  // Captured inside the hook, not at module scope: bun runs every module
  // body before any hook, so a module-scope read would see whatever an
  // earlier test file left in the environment.
  originalMapleRoots = process.env.MAPLE_ROOTS;
  await closeDb();
});

beforeEach(async () => {
  try {
    db = await getDb();
    mongoReachable = isDbConnected();
  } catch {
    mongoReachable = false;
    return;
  }
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
  await db.collection('asset_changes').deleteMany({});
  await db.collection('server_state').deleteMany({});
  await db.collection('folders').deleteMany({});
  tmp = await mkdtemp(join(tmpdir(), 'maple-xmp-path-changes-'));
  process.env.MAPLE_ROOTS = tmp;
});

afterAll(async () => {
  if (db) await db.dropDatabase();
  await closeDb();
  if (tmp) await rm(tmp, { recursive: true, force: true });
  if (originalMapleRoots === undefined) delete process.env.MAPLE_ROOTS;
  else process.env.MAPLE_ROOTS = originalMapleRoots;
});

async function seedIndexedAsset(filename: string, hasXmp: boolean): Promise<ObjectId> {
  const folderId = new ObjectId();
  await db!.collection('folders').insertOne({
    _id: folderId,
    path: tmp!,
    label: 'test',
    last_scan: null,
    file_count: 0,
    created_at: new Date().toISOString(),
  } as never);
  const { invalidateLibraryRoots } = await import('../indexer/libraries.cache.ts');
  invalidateLibraryRoots();
  const assetId = new ObjectId();
  await db!.collection('assets').insertOne({
    _id: assetId,
    fileinfo: [{ path: '', filename, library_id: folderId, deleted_at: null }],
    size: 8,
    mtime: Date.now(),
    rating: 0,
    flag: 0,
    color_label: '',
    has_xmp: hasXmp,
    indexed_at: new Date().toISOString(),
  } as never);
  return assetId;
}

describe('path-keyed XMP routes — change emission (#3563)', () => {
  it('POST /api/xmp?path= records the edit and emits an update row', async () => {
    if (!mongoReachable || !db || !tmp) return;
    const rawPath = join(tmp, 'a.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    const assetId = await seedIndexedAsset('a.dng', false);

    const app = new Elysia().use(xmpPathRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/xmp?path=${encodeURIComponent(rawPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: '<x:xmpmeta />',
      }),
    );
    expect(res.status).toBe(200);
    expect(await readFile(join(tmp, 'a.xmp'), 'utf8')).toBe('<x:xmpmeta />');

    const changes = await listChangesSince(db, { since: 0, limit: 10 });
    expect(changes.length).toBe(1);
    expect(changes[0]?.asset_id?.toHexString()).toBe(assetId.toHexString());
    expect(changes[0]?.kind).toBe('update');

    const updated = (await db.collection('assets').findOne({ _id: assetId })) as {
      has_xmp?: boolean;
      sidecar_ver?: number;
    } | null;
    expect(updated?.has_xmp).toBe(true);
    expect(updated?.sidecar_ver).toBe(1);
  });

  it('DELETE /api/xmp?path= clears has_xmp and emits an update row', async () => {
    if (!mongoReachable || !db || !tmp) return;
    const rawPath = join(tmp, 'b.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    await writeFile(join(tmp, 'b.xmp'), '<x:xmpmeta />');
    const assetId = await seedIndexedAsset('b.dng', true);

    const app = new Elysia().use(xmpPathRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/xmp?path=${encodeURIComponent(rawPath)}`, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(204);

    const changes = await listChangesSince(db, { since: 0, limit: 10 });
    expect(changes.length).toBe(1);
    expect(changes[0]?.asset_id?.toHexString()).toBe(assetId.toHexString());

    const updated = (await db.collection('assets').findOne({ _id: assetId })) as {
      has_xmp?: boolean;
    } | null;
    expect(updated?.has_xmp).toBe(false);
  });

  it('POST for an unindexed path still writes and emits nothing', async () => {
    if (!mongoReachable || !db || !tmp) return;
    const rawPath = join(tmp, 'unindexed.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    await seedIndexedAsset('other.dng', false);

    const app = new Elysia().use(xmpPathRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/xmp?path=${encodeURIComponent(rawPath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: '<x:xmpmeta />',
      }),
    );
    expect(res.status).toBe(200);
    expect(await listChangesSince(db, { since: 0, limit: 10 })).toHaveLength(0);
  });
});
