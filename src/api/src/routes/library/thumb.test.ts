/**
 * Integration tests for GET /api/thumb/:slug/*
 *
 * Does NOT exercise actual thumb generation (that requires real image files
 * and the native core). Tests the HTTP logic: slug resolution, 404/202 guards,
 * ETag / Cache-Control, and 304 short-circuit.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { Elysia } from 'elysia';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { thumbRoutes } from './thumb.ts';
import { resolveThumbPath } from '../../fs/xmp.ts';
import { setLibraryBySlugForTests, invalidateLibraryRoots } from '../../indexer/libraries.cache.ts';

const TEST_DB = `maple_test_thumb_route_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

let mongo: MongoClient | null = null;
let mongoReachable = false;
let db: Db | null = null;
let tmpDir = '';
let libraryId = new ObjectId();

const app = new Elysia().use(thumbRoutes);

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
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

beforeAll(async () => {
  mongo = await tryConnect();
  mongoReachable = mongo !== null;
  if (!mongoReachable) {
    console.log('[thumb.test] skipping: MongoDB unreachable');
    return;
  }
  db = mongo!.db(TEST_DB);
  await db.dropDatabase();
  tmpDir = `/tmp/maple-thumb-test-${process.pid}`;
  await mkdir(tmpDir, { recursive: true });
  libraryId = new ObjectId();
  setLibraryBySlugForTests('thumblib', { libraryId, root: tmpDir, label: 'Thumb Test Library' });
});

beforeEach(async () => {
  if (!mongoReachable || !db) return;
  await db.collection('assets').deleteMany({});
});

afterAll(async () => {
  if (mongo) {
    try {
      await mongo.db(TEST_DB).dropDatabase();
    } catch {
      /* ignore */
    }
    try {
      await mongo.close();
    } catch {
      /* ignore */
    }
  }
  if (tmpDir) {
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  invalidateLibraryRoots();
  const { closeDb } = await import('../../db/client.ts');
  await closeDb();
});

describe('GET /thumb/:slug/*', () => {
  test('returns 400 when no filename is provided (empty wildcard)', async () => {
    // A request to /thumb/:slug/ with no filename segment must be rejected
    // with 400, not treated as a library-root browse returning 202.
    const res = await app.handle(new Request('http://localhost/thumb/thumblib/'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/filename/i);
  });

  test('returns 404 for unknown slug', async () => {
    const res = await app.handle(new Request('http://localhost/thumb/no-such-slug/photo.jpg'));
    expect(res.status).toBe(404);
  });

  test('returns 404 when file does not exist on disk and is not indexed', async () => {
    if (!mongoReachable) return;
    const res = await app.handle(new Request('http://localhost/thumb/thumblib/ghost.jpg'));
    expect(res.status).toBe(404);
  });

  test('serves an on-the-fly thumb (200, not 202) for an un-indexed on-disk file', async () => {
    if (!mongoReachable) return;
    const src = path.join(tmpDir, 'pending.jpg');
    await writeFile(src, 'fake-source');
    // Pre-seed the path-keyed thumb so the route serves it without invoking
    // native generation (mirrors the 304 test below). The behavioural contract
    // under test is: un-indexed + on-disk no longer 202s — it renders/serves a
    // real JPEG with a weak, revalidating validator (NOT immutable).
    const thumbPath = resolveThumbPath(src);
    await mkdir(path.dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, 'thumb-bytes');

    const res = await app.handle(new Request('http://localhost/thumb/thumblib/pending.jpg'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/avif');
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(res.headers.get('Cache-Control')).toContain('must-revalidate');
    expect(res.headers.get('Cache-Control')).not.toContain('immutable');
    expect(res.headers.get('ETag') ?? '').toMatch(/^W\//); // weak validator
  });

  test('on-the-fly thumb honours If-None-Match with a 304', async () => {
    if (!mongoReachable) return;
    const src = path.join(tmpDir, 'pending2.jpg');
    await writeFile(src, 'fake-source-2');
    const thumbPath = resolveThumbPath(src);
    await mkdir(path.dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, 'thumb-bytes-2');

    const first = await app.handle(new Request('http://localhost/thumb/thumblib/pending2.jpg'));
    const etag = first.headers.get('ETag')!;
    expect(etag).toMatch(/^W\//);

    const second = await app.handle(
      new Request('http://localhost/thumb/thumblib/pending2.jpg', {
        headers: { 'If-None-Match': etag },
      }),
    );
    expect(second.status).toBe(304);
    expect(second.headers.get('ETag')).toBe(etag);
  });

  test('returns 404 (never a 200 image) for an un-indexed video on disk', async () => {
    if (!mongoReachable) return;
    // Post-#1638 videos are selectable, so the grid will request thumbs for
    // them. A video has no still frame: the route must 404 rather than fall
    // through to generation (which would otherwise copy the raw .MOV bytes to
    // a .avif and serve 200 image/avif garbage → broken <img>).
    const src = path.join(tmpDir, 'clip.mov');
    await writeFile(src, 'fake-video-bytes');

    const res = await app.handle(new Request('http://localhost/thumb/thumblib/clip.mov'));
    expect(res.status).toBe(404);
    // Critically: NOT a 200 image with video bytes.
    expect(res.status).not.toBe(200);
    expect(res.headers.get('Content-Type')).not.toBe('image/jpeg');
    expect(res.headers.get('Content-Type')).not.toBe('image/avif');
  });

  test('returns 404 (never a 200 image) for an indexed video asset', async () => {
    if (!mongoReachable) return;
    const mapleId = new ObjectId().toHexString();
    await db!.collection('assets').insertOne({
      maple_id: mapleId,
      fileinfo: [
        {
          library_id: libraryId,
          path: '',
          filename: 'indexed-clip.mp4',
          deleted_at: null,
          missing_since: null,
        },
      ],
      deleted_at: null,
    } as never);
    const src = path.join(tmpDir, 'indexed-clip.mp4');
    await writeFile(src, 'fake-video-bytes-2');

    const res = await app.handle(new Request('http://localhost/thumb/thumblib/indexed-clip.mp4'));
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(200);
    expect(res.headers.get('Content-Type')).not.toBe('image/jpeg');
    expect(res.headers.get('Content-Type')).not.toBe('image/avif');
  });

  test.each(['scan.eip', 'session.braw', 'project.afphoto', 'logo.ai'])(
    'returns 404 (never a 200 image) for an un-indexed stub image on disk (%s, #1835)',
    async (filename) => {
      if (!mongoReachable) return;
      // Metadata-only stub images have no decoder: the route must 404 rather
      // than fall through to generation (which would otherwise copy the raw
      // source bytes to a .avif and serve 200 image/avif garbage).
      const src = path.join(tmpDir, filename);
      await writeFile(src, 'fake-stub-bytes');

      const res = await app.handle(new Request(`http://localhost/thumb/thumblib/${filename}`));
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(200);
      expect(res.headers.get('Content-Type')).not.toBe('image/jpeg');
      expect(res.headers.get('Content-Type')).not.toBe('image/avif');
    },
  );

  test.each(['track.mp3', 'voice.wav', 'memo.m4a', 'song.aac'])(
    'returns 404 (never a 200 image) for an un-indexed audio file on disk (%s, #1835)',
    async (filename) => {
      if (!mongoReachable) return;
      const src = path.join(tmpDir, filename);
      await writeFile(src, 'fake-audio-bytes');

      const res = await app.handle(new Request(`http://localhost/thumb/thumblib/${filename}`));
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(200);
      expect(res.headers.get('Content-Type')).not.toBe('image/jpeg');
      expect(res.headers.get('Content-Type')).not.toBe('image/avif');
    },
  );

  test('returns 304 when ETag matches If-None-Match', async () => {
    if (!mongoReachable) return;
    const mapleId = new ObjectId().toHexString();
    await db!.collection('assets').insertOne({
      maple_id: mapleId,
      fileinfo: [
        {
          library_id: libraryId,
          path: '',
          filename: 'cached.jpg',
          deleted_at: null,
          missing_since: null,
        },
      ],
      deleted_at: null,
    } as never);

    // Create a fake thumb so the route doesn't try to generate it
    const { mkdir: mkdirNative } = await import('node:fs/promises');
    const thumbDir = path.join(tmpDir, '.maple', 'thumbs');
    await mkdirNative(thumbDir, { recursive: true });
    // resolveThumbPathForAsset uses maple_id's first 2 chars as bucket dir
    const bucket = mapleId.slice(0, 2);
    const bucketDir = path.join(tmpDir, '.maple', 'thumbs', bucket);
    await mkdirNative(bucketDir, { recursive: true });
    await writeFile(path.join(bucketDir, `${mapleId}.avif`), 'fake-thumb-bytes');

    const etag = `"${mapleId}"`;
    const res = await app.handle(
      new Request('http://localhost/thumb/thumblib/cached.jpg', {
        headers: { 'If-None-Match': etag },
      }),
    );
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
  });
});
