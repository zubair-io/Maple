/**
 * Route-integration tests: DELETE /api/assets/:id `intent` parameter (#2749).
 *
 * The endpoint is dual-mode — a live asset is soft-deleted, an already-
 * trashed one is PERMANENTLY purged — decided by server-side state the
 * caller may hold a stale copy of. `intent=trash|purge` pins the caller's
 * meaning: a state mismatch becomes a 409 instead of a silent flip into
 * the other (possibly irreversible) branch. Omitting `intent` preserves
 * the legacy dual-mode contract the deployed File Provider extension
 * depends on.
 *
 * Requires a running MongoDB (skips gracefully if unreachable), real temp
 * dirs, no fs mocks — same harness shape as `folders-trash.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { closeDb } from '../../db/client.ts';
import { invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';
import { trashRoutes } from './trash.ts';
import { fakeAuth } from '../../../tests/helpers/test-auth.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_trash_intent_route_test_${process.pid}`;

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1_500,
    connectTimeoutMS: 1_500,
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

describe('DELETE /api/assets/:id intent parameter', () => {
  let mongo: MongoClient | null = null;
  let db: Db | null = null;
  let folderId: ObjectId | null = null;
  let folderPath: string | null = null;

  beforeEach(async () => {
    mongo = await tryConnect();
    if (!mongo) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    db = mongo.db(TEST_DB);
    folderId = new ObjectId();
    folderPath = await mkdtemp(nodePath.join(tmpdir(), 'trash-intent-route-'));
    await db.collection('folders').insertOne({
      _id: folderId,
      path: folderPath,
      slug: 'trash-intent-route-test',
      label: 'trash-intent-route-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    invalidateLibraryRoots();
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (mongo) await mongo.close().catch(() => {});
    if (folderPath) await rm(folderPath, { recursive: true, force: true }).catch(() => {});
    await closeDb();
    db = null;
    mongo = null;
    folderId = null;
    folderPath = null;
  });

  /** Seed one asset; `trashed` controls whether it starts life in the trash
   * (both the DB flag and the physical `.maple/trash` location, so either
   * DELETE branch acts on a real file). Returns the asset id and the
   * current absolute path of its primary file. */
  async function seedAsset(trashed: boolean): Promise<{ id: ObjectId; absPath: string }> {
    const id = new ObjectId();
    const filename = 'IMG_1.dng';
    const relDir = trashed ? nodePath.join('.maple', 'trash', 'sub') : 'sub';
    const absDir = nodePath.join(folderPath!, relDir);
    await mkdir(absDir, { recursive: true });
    const absPath = nodePath.join(absDir, filename);
    await writeFile(absPath, 'pixels');
    await db!.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        {
          path: relDir.split(nodePath.sep).join('/'),
          filename,
          library_id: folderId,
          // A REAL trashed asset keeps its fileinfo entry live (deleted_at
          // null) with the path repointed into .maple/trash — only the
          // doc's TOP-LEVEL deleted_at is stamped. See asset-trash.ts's
          // markSoftDeleted doc comment; seeding the entry as deleted made
          // assetAbsPath resolve nothing and 404 the purge branch.
          deleted_at: null,
        },
      ],
      folder_id: folderId,
      size: 6,
      mtime: 1_700_000_000_000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-01-01T00:00:00Z',
      has_xmp: false,
      deleted_at: trashed ? new Date().toISOString() : null,
      original_path: trashed ? `sub/${filename}` : undefined,
      stages: {},
    } as never);
    return { id, absPath };
  }

  function call(id: ObjectId, intent?: string): Promise<Response> {
    const app = new Elysia().use(fakeAuth()).group('/api/assets', (g) => g.use(trashRoutes));
    const q = intent === undefined ? '' : `?intent=${intent}`;
    return app.handle(
      new Request(`http://localhost/api/assets/${id.toHexString()}${q}`, { method: 'DELETE' }),
    );
  }

  function skip(): boolean {
    if (!mongo || !db || !folderId || !folderPath) {
      console.log('[trash.intent.test] MongoDB unreachable — skipping');
      return true;
    }
    return false;
  }

  it('intent=trash on a live asset soft-deletes it (204)', async () => {
    if (skip()) return;
    const { id, absPath } = await seedAsset(false);
    const res = await call(id, 'trash');
    expect(res.status).toBe(204);
    // Original location vacated; DB row soft-deleted, not purged.
    await expect(stat(absPath)).rejects.toThrow();
    const row = await db!.collection('assets').findOne({ _id: id });
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
  });

  it('intent=trash on an ALREADY-TRASHED asset is a 409, never a purge', async () => {
    if (skip()) return;
    const { id, absPath } = await seedAsset(true);
    const res = await call(id, 'trash');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { state?: string };
    expect(body.state).toBe('trashed');
    // The load-bearing half: the trashed file and its DB row both survive —
    // the legacy behavior here would have PERMANENTLY purged them.
    const s = await stat(absPath);
    expect(s.size).toBe(6);
    expect(await db!.collection('assets').findOne({ _id: id })).not.toBeNull();
  });

  it('intent=purge on a REAPED asset deletes the row without unlinking its stored path (#2977)', async () => {
    if (skip()) return;
    // A reaped row's fileinfo points at the ORIGINAL library location (no
    // .maple/trash copy exists) — and the photo quietly returned there.
    // An explicit purge must delete the DB row only, never the file.
    const id = new ObjectId();
    const absDir = nodePath.join(folderPath!, 'sub');
    await mkdir(absDir, { recursive: true });
    const absPath = nodePath.join(absDir, 'BACK.dng');
    await writeFile(absPath, 'returned-pixels');
    await writeFile(nodePath.join(absDir, 'BACK.xmp'), '<xmp/>');
    await db!.collection('assets').insertOne({
      _id: id,
      fileinfo: [
        {
          path: 'sub',
          filename: 'BACK.dng',
          library_id: folderId,
          deleted_at: null,
          missing_since: '2026-08-01T00:00:00.000Z',
        },
      ],
      folder_id: folderId,
      size: 6,
      mtime: 1_700_000_000_000,
      rating: 0,
      flag: 0,
      color_label: '',
      indexed_at: '2026-01-01T00:00:00Z',
      deleted_at: '2026-08-10T00:00:00.000Z',
      deleted_reason: 'reaped',
      stages: {},
    } as never);

    const res = await call(id, 'purge');
    expect(res.status).toBe(204);
    expect(await db!.collection('assets').countDocuments({ _id: id })).toBe(0);
    // The returned photo + sidecar are untouched.
    expect(await readFile(absPath, 'utf8')).toBe('returned-pixels');
    expect(await readFile(nodePath.join(absDir, 'BACK.xmp'), 'utf8')).toBe('<xmp/>');
  });

  it('intent=purge on a trashed asset purges it (204)', async () => {
    if (skip()) return;
    const { id, absPath } = await seedAsset(true);
    const res = await call(id, 'purge');
    expect(res.status).toBe(204);
    await expect(stat(absPath)).rejects.toThrow();
    expect(await db!.collection('assets').findOne({ _id: id })).toBeNull();
  });

  it('intent=purge on a LIVE asset is a 409, never a trash', async () => {
    if (skip()) return;
    const { id, absPath } = await seedAsset(false);
    const res = await call(id, 'purge');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { state?: string };
    expect(body.state).toBe('live');
    // Untouched: still at its original path, still live in the DB.
    const s = await stat(absPath);
    expect(s.size).toBe(6);
    const row = await db!.collection('assets').findOne({ _id: id });
    expect(row!.deleted_at).toBeNull();
  });

  it('rejects an unknown intent with 400', async () => {
    if (skip()) return;
    const { id } = await seedAsset(false);
    const res = await call(id, 'obliterate');
    expect(res.status).toBe(400);
  });

  it('legacy no-intent call keeps the dual-mode contract: live → trash', async () => {
    if (skip()) return;
    const { id, absPath } = await seedAsset(false);
    const res = await call(id);
    expect(res.status).toBe(204);
    await expect(stat(absPath)).rejects.toThrow();
    const row = await db!.collection('assets').findOne({ _id: id });
    expect(row!.deleted_at).not.toBeNull();
  });

  it('legacy no-intent call keeps the dual-mode contract: trashed → purge', async () => {
    if (skip()) return;
    const { id, absPath } = await seedAsset(true);
    const res = await call(id);
    expect(res.status).toBe(204);
    await expect(stat(absPath)).rejects.toThrow();
    expect(await db!.collection('assets').findOne({ _id: id })).toBeNull();
  });
});
