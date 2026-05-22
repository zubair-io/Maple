import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetsRoutes } from './assets.ts';
import { listChangesSince } from '../db/changes.repo.ts';
import { getDb, isDbConnected } from '../db/client.ts';

let db: Db | null = null;
let tmp: string | null = null;
let mongoReachable = false;

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
  tmp = await mkdtemp(join(tmpdir(), 'maple-changes-'));
  process.env.MAPLE_ROOTS = tmp;
});

afterAll(async () => {
  if (db) {
    await db.collection('assets').deleteMany({});
    await db.collection('asset_changes').deleteMany({});
    await db.collection('server_state').deleteMany({});
  }
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('assets routes — change emission', () => {
  it('PUT /api/assets/:id/xmp emits a change row', async () => {
    if (!mongoReachable || !db || !tmp) return;
    const folderId = new ObjectId();
    const rawPath = join(tmp, 'a.dng');
    await writeFile(rawPath, Buffer.alloc(8));

    await db.collection('folders').insertOne({
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
    await db.collection('assets').insertOne({
      _id: assetId,
      fileinfo: [{ path: '', filename: 'a.dng', library_id: folderId, deleted_at: null }],
      size: 8,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: new Date().toISOString(),
    } as never);

    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/assets/${assetId.toHexString()}/xmp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: '<x:xmpmeta />',
      }),
    );
    expect(res.status).toBe(204);

    const changes = await listChangesSince(db, { since: 0, limit: 10 });
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes.at(-1)?.asset_id?.toHexString()).toBe(assetId.toHexString());
    expect(changes.at(-1)?.kind).toBe('update');

    // Verify has_xmp flag was set on the asset doc.
    const updated = await db.collection('assets').findOne({ _id: assetId });
    expect((updated as { has_xmp?: boolean } | null)?.has_xmp).toBe(true);
  });

  it('DELETE /api/assets/:id/xmp emits a change row and clears has_xmp', async () => {
    if (!mongoReachable || !db || !tmp) return;
    const folderId = new ObjectId();
    const rawPath = join(tmp, 'b.dng');
    await writeFile(rawPath, Buffer.alloc(8));
    const xmpPath = `${rawPath}.xmp`;
    await writeFile(xmpPath, '<x:xmpmeta />');

    await db.collection('folders').insertOne({
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
    await db.collection('assets').insertOne({
      _id: assetId,
      fileinfo: [{ path: '', filename: 'b.dng', library_id: folderId, deleted_at: null }],
      size: 8,
      mtime: Date.now(),
      rating: 0,
      flag: 0,
      color_label: '',
      has_xmp: true,
      indexed_at: new Date().toISOString(),
    } as never);

    const app = new Elysia().use(assetsRoutes);
    const res = await app.handle(
      new Request(`http://localhost/api/assets/${assetId.toHexString()}/xmp`, { method: 'DELETE' }),
    );
    expect(res.status).toBe(204);

    const changes = await listChangesSince(db, { since: 0, limit: 10 });
    expect(changes.length).toBeGreaterThanOrEqual(1);

    const updated = await db.collection('assets').findOne({ _id: assetId });
    expect((updated as { has_xmp?: boolean } | null)?.has_xmp).toBe(false);
  });
});
