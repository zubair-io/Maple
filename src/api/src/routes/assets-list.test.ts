import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { ObjectId, type Db } from 'mongodb';
import { assetsListRoutes } from './assets-list.ts';
import { getDb, isDbConnected } from '../db/client.ts';

let db: Db | null = null;
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
});

afterAll(async () => {
  if (db) await db.collection('assets').deleteMany({});
});

async function seed(d: Db): Promise<void> {
  const folder = new ObjectId();
  // Register the folder so safeLoadLibraries can resolve abs_path / filename
  // for the wire DTO. Use a unique path per insert to avoid collisions with
  // earlier tests in the same DB.
  const uniqueRoot = `/p-${new ObjectId().toHexString()}`;
  await d.collection('folders').insertOne({
    _id: folder,
    path: uniqueRoot,
    label: 'p',
    last_scan: null,
    file_count: 0,
    created_at: '2026-05-10T00:00:00Z',
  } as never);
  const now = new Date('2026-05-10T00:00:00Z');
  const old = new Date('2025-01-01T00:00:00Z');
  await d.collection('assets').insertMany([
    {
      fileinfo: [{ path: '', filename: 'a.dng', library_id: folder, deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 5,
      flag: 0,
      color_label: '',
      has_xmp: true,
      indexed_at: 'now',
      deleted_at: null,
      exif: { captured_at: now.toISOString() },
    },
    {
      fileinfo: [{ path: '', filename: 'b.dng', library_id: folder, deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 0,
      flag: 0,
      color_label: '',
      has_xmp: false,
      indexed_at: 'now',
      deleted_at: null,
      exif: { captured_at: old.toISOString() },
    },
    {
      fileinfo: [{ path: '', filename: 'c.dng', library_id: folder, deleted_at: null }],
      size: 1,
      mtime: 1,
      rating: 3,
      flag: 0,
      color_label: '',
      has_xmp: true,
      indexed_at: 'now',
      deleted_at: null,
      exif: { captured_at: now.toISOString() },
    },
  ] as never);
}

describe('GET /api/assets', () => {
  it('filters by has_xmp=1', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(new Request('http://localhost/api/assets?has_xmp=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assets.map((a: { filename: string }) => a.filename).sort()).toEqual([
      'a.dng',
      'c.dng',
    ]);
  });

  it('filters by rating_gte=1', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(new Request('http://localhost/api/assets?rating_gte=1'));
    const body = await res.json();
    expect(body.assets.length).toBe(2);
  });

  it('filters by captured_after=ISO', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const app = new Elysia().use(assetsListRoutes);
    const after = new Date('2026-01-01T00:00:00Z').toISOString();
    const res = await app.handle(
      new Request(`http://localhost/api/assets?captured_after=${encodeURIComponent(after)}`),
    );
    const body = await res.json();
    expect(body.assets.length).toBe(2);
  });

  it('returns 400 for invalid captured_after', async () => {
    if (!mongoReachable) return;
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(
      new Request('http://localhost/api/assets?captured_after=notadate'),
    );
    expect(res.status).toBe(400);
  });

  it('returns all assets when no filters are given', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(new Request('http://localhost/api/assets'));
    const body = await res.json();
    expect(body.assets.length).toBe(3);
  });

  it('excludes soft-deleted rows (M)', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    // Soft-delete one row.
    await db
      .collection('assets')
      .updateOne(
        { 'fileinfo.filename': 'a.dng' },
        { $set: { deleted_at: new Date().toISOString() } },
      );
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(new Request('http://localhost/api/assets'));
    const body = await res.json();
    const names = body.assets.map((a: { filename: string }) => a.filename);
    expect(names).not.toContain('a.dng');
    expect(body.assets.length).toBe(2);
  });

  it('returns 400 for non-integer rating_gte (L)', async () => {
    if (!mongoReachable || !db) return;
    await seed(db);
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(new Request('http://localhost/api/assets?rating_gte=abc'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/rating_gte/);
  });

  it('returns mtime in seconds, round-trips to a sensible Date (G)', async () => {
    if (!mongoReachable || !db) return;
    // Seed a row with a realistic ms-resolution mtime — must come back
    // as the same instant in seconds.
    const folder = new ObjectId();
    await db.collection('folders').insertOne({
      _id: folder,
      path: `/p-${folder.toHexString()}`,
      label: 'p',
      last_scan: null,
      file_count: 0,
      created_at: 'now',
    } as never);
    const mtimeMs = Date.UTC(2026, 4, 17, 12, 30, 0); // 2026-05-17 12:30 UTC
    await db.collection('assets').insertOne({
      fileinfo: [{ path: '', filename: 'g.dng', library_id: folder, deleted_at: null }],
      size: 1,
      mtime: mtimeMs,
      rating: 0,
      flag: 0,
      color_label: '',
      has_xmp: false,
      indexed_at: 'now',
      deleted_at: null,
    } as never);
    const app = new Elysia().use(assetsListRoutes);
    const res = await app.handle(new Request('http://localhost/api/assets'));
    const body = await res.json();
    const g = body.assets.find((a: { filename: string }) => a.filename === 'g.dng');
    expect(g).toBeDefined();
    // Server returns seconds. Build a Date the same way Swift would
    // (timeIntervalSince1970:) and assert it lands inside 2026.
    const reconstructed = new Date(g.mtime * 1000);
    expect(reconstructed.getUTCFullYear()).toBe(2026);
    expect(g.mtime).toBe(Math.floor(mtimeMs / 1000));
  });
});
