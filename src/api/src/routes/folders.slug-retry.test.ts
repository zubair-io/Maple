/**
 * Tests for the slug-collision retry loop in POST /api/folders.
 *
 * Simulates the TOCTOU race: two concurrent POSTs that both read the same
 * taken-set and mint the same slug. The unique `folders_slug_unique` index
 * catches the collision and the route retries with a suffixed slug.
 *
 * We test this by:
 *   1. Creating the unique slug index in the test DB.
 *   2. Pre-inserting a folder with the slug that POST /api/folders would mint.
 *   3. Issuing the POST — it must succeed (201) with a deduplicated slug,
 *      not fail with 500 on E11000.
 */

import { afterEach, beforeEach, describe, it, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { mkdir, rm } from 'node:fs/promises';
import { closeDb } from '../db/client.ts';
import { foldersRoutes } from './folders.ts';

const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';
const TEST_DB = `maple_test_slug_retry_${process.pid}`;

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
    } catch {
      /* ignore */
    }
    return null;
  }
}

describe('POST /api/folders — slug collision retry', () => {
  let client: MongoClient | null = null;
  let db: Db | null = null;
  let tmpDir = '';

  beforeEach(async () => {
    client = await tryConnect();
    if (!client) return;
    process.env.MAPLE_MONGO_URI = MONGO_URI;
    process.env.MAPLE_MONGO_DB = TEST_DB;
    await closeDb();
    db = client.db(TEST_DB);
    await db.dropDatabase();
    // Create the unique slug index — mirrors what ensureIndexes() does on boot.
    await db
      .collection('folders')
      .createIndex({ slug: 1 }, { unique: true, sparse: true, name: 'folders_slug_unique' });
    // Create a real temporary directory so validateRoot passes.
    tmpDir = `/tmp/maple-slug-retry-test-${process.pid}`;
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (client) await client.close().catch(() => {});
    await closeDb();
    db = null;
    client = null;
    if (tmpDir) {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      tmpDir = '';
    }
  });

  it('succeeds with a deduplicated slug when the base slug is already taken', async () => {
    if (!client || !db) {
      console.log('[folders.slug-retry.test] MongoDB unreachable — skipping');
      return;
    }

    // Pre-insert a folder with the slug that POST would mint for "My Library"
    // (slugify("My Library") → "my-library"). This simulates a concurrent insert
    // claiming the slug just before our request reaches the DB.
    await db.collection('folders').insertOne({
      _id: new ObjectId(),
      path: '/other/path',
      label: 'My Library',
      slug: 'my-library',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);

    const app = new Elysia().use(foldersRoutes);
    const res = await app.handle(
      new Request('http://localhost/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: tmpDir, label: 'My Library' }),
      }),
    );

    // Must succeed — not 500 on E11000.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; path: string; label: string };
    // The retry loop must have minted a suffixed slug.
    expect(body.slug).toBe('my-library-2');
    expect(body.path).toBe(tmpDir);
    expect(body.label).toBe('My Library');
  });

  it('GET /api/folders returns slug in the payload (client addresses libraries by slug)', async () => {
    if (!client || !db) {
      console.log('[folders.slug-retry.test] MongoDB unreachable — skipping');
      return;
    }
    await db.collection('folders').insertOne({
      _id: new ObjectId(),
      path: tmpDir,
      label: 'Library',
      slug: 'library',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);

    const app = new Elysia().use(foldersRoutes);
    const res = await app.handle(new Request('http://localhost/api/folders'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; slug?: string }>;
    // Regression: without `slug` in the payload the web client falls back to
    // f.id (the raw ObjectId) and addresses an invalid /api/folder/<ObjectId>.
    const row = body.find((f) => f.slug === 'library');
    expect(row).toBeDefined();
    expect(row!.slug).toBe('library');
  });
});
