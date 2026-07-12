// fs-previews.test.ts
//
// Covers GET /api/fs/preview — the display-resolution tier behind the
// Apple Preview screen's thumbnail → hi-res swap.
//
// Serving is exercised via pre-staged `.maple/previews/` cache files (fresh
// mtime) so the tests never invoke sharp/libraw. The Mongo-backed
// content-addressed path follows the per-process isolated-DB +
// skip-if-Mongo-unreachable pattern from `libraries.cache.test.ts`.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtemp, rm, writeFile, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';

const TEST_DB = `maple_test_fs_previews_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

import { fsPreviewsRoutes, libraryAddressFor } from './fs-previews.ts';
import { cachePathFor } from '../fs/xmp.ts';
import { invalidateLibraryRoots } from '../indexer/libraries.cache.ts';
import { getDb } from '../db/client.ts';

describe('libraryAddressFor', () => {
  const roots = new Map([['aaaaaaaaaaaaaaaaaaaaaaaa', '/lib/photos']]);

  it('splits a nested path into (relDir, filename)', () => {
    expect(libraryAddressFor('/lib/photos/2024/trip/a.dng', roots)).toEqual({
      libraryIdHex: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      relDir: '2024/trip',
      filename: 'a.dng',
    });
  });

  it('uses an empty relDir at the library root', () => {
    expect(libraryAddressFor('/lib/photos/a.dng', roots)).toEqual({
      libraryIdHex: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      relDir: '',
      filename: 'a.dng',
    });
  });

  it('returns null for a path outside every root', () => {
    expect(libraryAddressFor('/elsewhere/a.dng', roots)).toBeNull();
  });

  it('tolerates a trailing slash on the configured root', () => {
    const slashed = new Map([['aaaaaaaaaaaaaaaaaaaaaaaa', '/lib/photos/']]);
    expect(libraryAddressFor('/lib/photos/a.dng', slashed)?.filename).toBe('a.dng');
  });
});

async function tryConnect(): Promise<MongoClient | null> {
  const c = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 1500,
    connectTimeoutMS: 1500,
  });
  try {
    await c.connect();
    await c.db(TEST_DB).command({ ping: 1 });
    return c;
  } catch {
    await c.close().catch(() => {});
    return null;
  }
}

describe('GET /api/fs/preview', () => {
  let mongo: MongoClient | null = null;
  let tmp: string | null = null;
  let rawPath: string | null = null;

  beforeAll(async () => {
    mongo = await tryConnect();
    // The route consults the DB only when the app's own client already holds
    // a live connection (`isDbConnected()` guard — in production the server
    // connects at boot). Mirror that here so the content-addressed path is
    // exercised.
    if (mongo) await getDb();
  });

  afterAll(async () => {
    if (mongo) {
      await mongo
        .db(TEST_DB)
        .dropDatabase()
        .catch(() => {});
      await mongo.close().catch(() => {});
    }
  });

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(join(tmpdir(), 'maple-fs-previews-')));
    process.env.MAPLE_ROOTS = tmp;
    rawPath = join(tmp, 'a.jpg');
    await writeFile(rawPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    invalidateLibraryRoots();
  });

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    tmp = null;
    if (mongo) {
      await mongo.db(TEST_DB).collection('folders').deleteMany({});
      await mongo.db(TEST_DB).collection('assets').deleteMany({});
    }
    invalidateLibraryRoots();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    new Elysia().use(fsPreviewsRoutes).handle(
      new Request(`http://localhost/api/fs/preview?path=${encodeURIComponent(path)}`, {
        headers,
      }),
    );

  /** Pre-stage the legacy basename-keyed cache entry with distinct bytes. */
  const stageLegacyPreview = async (bytes: Buffer) => {
    const previewPath = cachePathFor(rawPath!, 'previews', '1280');
    await mkdir(dirname(previewPath), { recursive: true });
    await writeFile(previewPath, bytes);
  };

  it('rejects a relative path', async () => {
    const res = await get('not/absolute.jpg');
    expect(res.status).toBe(400);
  });

  it('rejects a path outside MAPLE_ROOTS', async () => {
    const res = await get('/etc/hosts');
    // realpath succeeds for /etc/hosts, so this must be the jail (403);
    // an unsupported-extension 415 would mean the jail ran too late.
    expect(res.status).toBe(403);
  });

  it('415s an unsupported extension inside the jail', async () => {
    const docPath = join(tmp!, 'notes.txt');
    await writeFile(docPath, 'hello');
    const res = await get(docPath);
    expect(res.status).toBe(415);
  });

  it('serves a fresh pre-staged preview with an ETag, and 304s on If-None-Match', async () => {
    if (!mongo) return; // skip-if-unreachable: route consults Mongo per request

    const staged = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    await stageLegacyPreview(staged);

    const res = await get(rawPath!);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(Buffer.from(await res.arrayBuffer())).toEqual(staged);

    const revalidated = await get(rawPath!, { 'if-none-match': etag! });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('cache-control')).toBe('private, max-age=3600');
  });

  it('serves the indexer-written <maple_id>_1280.jpg when the asset is indexed', async () => {
    if (!mongo) return;

    const db = mongo.db(TEST_DB);
    const libraryId = new ObjectId();
    await db.collection('folders').insertOne({
      _id: libraryId,
      path: tmp!,
      slug: 'test-lib',
      label: 'Test',
    });
    const mapleId = 'mid_fs_previews_test';
    await db.collection('assets').insertOne({
      maple_id: mapleId,
      deleted_at: null,
      fileinfo: [
        {
          library_id: libraryId,
          path: '',
          filename: 'a.jpg',
          deleted_at: null,
          missing_since: null,
        },
      ],
    });
    invalidateLibraryRoots();

    const contentAddressed = Buffer.from([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
    const previewPath = join(tmp!, '.maple', 'previews', `${mapleId}_1280.jpg`);
    await mkdir(dirname(previewPath), { recursive: true });
    await writeFile(previewPath, contentAddressed);

    const res = await get(rawPath!);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(contentAddressed);
  });
});
