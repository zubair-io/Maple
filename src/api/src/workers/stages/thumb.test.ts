import { describe, expect, it, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import thumbStage from './thumb.ts';
import { resolveThumbPathForAsset } from '../../fs/xmp.ts';

// --- shared test-DB harness for the maple_id-keyed path block below ---
const TEST_DB = `maple_test_thumb_stage_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

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
    } catch {}
    return null;
  }
}

function makeDoc(
  absPath: string,
  libraryId: ObjectId,
  libraryRoot: string,
  exif: Record<string, unknown> | null = null,
  mapleIdOverride?: string,
) {
  // Compute fileinfo[0] from the absPath relative to the library root.
  const relDir = path.relative(libraryRoot, path.dirname(absPath));
  const filename = path.basename(absPath);
  return {
    _id: '000000000000000000000003' as unknown as ObjectId,
    fileinfo: [
      {
        path: relDir === '.' || relDir === '' ? '' : relDir.split(path.sep).join('/'),
        filename,
        library_id: libraryId,
        deleted_at: null,
      },
    ],
    sha1_head: 'c'.repeat(40),
    maple_id: mapleIdOverride ?? 'd'.repeat(32),
    exif,
    stages: {
      exif: {
        version: 1,
        attempts: 0,
        last_error: null,
        processed_at: new Date().toISOString(),
        dead: false,
      },
      thumb: {
        version: 0,
        attempts: 0,
        last_error: null,
        processed_at: null,
        dead: false,
      },
      face: {
        version: 0,
        attempts: 0,
        last_error: null,
        processed_at: null,
        dead: false,
      },
      describe: {
        version: 0,
        attempts: 0,
        last_error: null,
        processed_at: null,
        dead: false,
      },
      geocode: {
        version: 0,
        attempts: 0,
        last_error: null,
        processed_at: null,
        dead: false,
      },
      meili: {
        version: 0,
        attempts: 0,
        last_error: null,
        processed_at: null,
        dead: false,
      },
    },
  };
}

describe('thumb handler — bitmap path', () => {
  let dir: string;
  let libraryId: ObjectId;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'thumb-stage-'));
    libraryId = new ObjectId();
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(null);
  });

  it('generates a thumb for a JPEG and marks the stage as wrote', async () => {
    const file = path.join(dir, 'photo.jpg');
    const buf = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file, libraryId, dir);
    const result = await thumbStage.handler(doc as never, {} as never);

    // The stage no longer persists `thumb_path` — it returns { wrote: true }
    // and the thumb lives at the content-addressed location, recomputed on read.
    expect(result).toEqual({ wrote: true });
    const thumbPath = resolveThumbPathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
    );
    expect(thumbPath).not.toBeNull();
    const s = await stat(thumbPath as string);
    expect(s.size).toBeGreaterThan(0);
  });

  it("returns { skip: 'video-file' } for a .MOV and writes no thumb", async () => {
    // A video container can land in a mixed-media library and (post-#1638) is
    // a selectable asset. The handler must skip it rather than fall through to
    // `copyImageAsThumb`, which would copy the raw .MOV bytes to `<id>.jpg` —
    // the thumb route would then serve 200 image/jpeg with video bytes (broken
    // <img> in the grid). Mirrors the preview stage's video guard.
    const file = path.join(dir, 'IMG_3087.MOV');
    await writeFile(file, Buffer.from('not really a video, just bytes'));

    // Unique maple_id — the thumb cache path is keyed on it.
    const doc = makeDoc(file, libraryId, dir, null, '9'.repeat(32));
    const result = await thumbStage.handler(doc as never, {} as never);
    expect((result as { skip: string }).skip).toBe('video-file');

    // No thumb artefact was produced — assert the stat rejects with ENOENT
    // specifically, so an unexpected error fails the test loudly instead of
    // masquerading as "file absent".
    const thumbPath = resolveThumbPathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
    );
    expect(thumbPath).not.toBeNull();
    const err = await stat(thumbPath as string).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(err?.code).toBe('ENOENT');
  });

  it('produces an upright thumb regardless of EXIF orientation tag', async () => {
    const file = path.join(dir, 'rotated.jpg');
    // Create a 16x8 JPEG tagged as orientation 6 (90° CW). After the orientation
    // fix (Plan 0), the on-disk thumb must be 8 wide × 16 tall.
    const buf = await sharp({
      create: {
        width: 16,
        height: 8,
        channels: 3,
        background: { r: 200, g: 50, b: 50 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file, libraryId, dir, null, 'e'.repeat(32));
    const result = await thumbStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });
    const thumbPath = resolveThumbPathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
    );
    expect(thumbPath).not.toBeNull();
    const meta = await sharp(thumbPath as string).metadata();
    // After orientation bake-in, the stored thumb is upright.
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it('marks the stage as wrote for a RAW when the FFI is unavailable (soft pass)', async () => {
    // Without libraw_ffi built, generateThumb silently skips the RAW and
    // returns without writing a file. The handler must still return
    // { wrote: true } so the runtime can mark the stage done and the image
    // advances to face.
    //
    // This test verifies the handler does not throw when the FFI is absent.
    const dng = path.resolve(process.cwd(), '../../test-fixtures/raws/test_0017.dng');
    let dngExists = false;
    try {
      await stat(dng);
      dngExists = true;
    } catch {
      // no fixture — test still runs but skips the file-existence assertion
    }

    if (!dngExists) return; // soft pass: no fixture

    // RAW lives outside the test library — stage a second library that
    // claims its directory.
    const rawLibraryId = new ObjectId();
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(
      new Map([
        [libraryId.toHexString(), dir],
        [rawLibraryId.toHexString(), path.dirname(dng)],
      ]),
    );
    const doc = makeDoc(dng, rawLibraryId, path.dirname(dng), null, 'f'.repeat(32));
    // Must not throw.
    const result = await thumbStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });
    // Restore the single-library cache for subsequent tests.
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
  });
});

describe('thumb handler — content-addressed cache path', () => {
  let mongo: MongoClient | null = null;
  let mongoReachable = false;
  let db: Db | null = null;
  let dir: string;

  beforeAll(async () => {
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log('[thumb.test] skipping content-addressed block: MongoDB unreachable');
      return;
    }
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    const { closeDb } = await import('../../db/client.ts');
    await closeDb();
    dir = await mkdtemp(path.join(os.tmpdir(), 'thumb-stage-ca-'));
  });

  afterAll(async () => {
    if (mongoReachable) {
      const { closeDb } = await import('../../db/client.ts');
      await closeDb();
      try {
        await mongo!.db(TEST_DB).dropDatabase();
      } catch {}
      try {
        await mongo!.close();
      } catch {}
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses <lib>/<fileinfo[0].path>/.maple/thumbs/<maple_id>.jpg when the doc has maple_id + fileinfo', async () => {
    if (!mongoReachable) return; // soft pass

    // Set up a library at our tmp dir, with a sub-folder containing the JPEG.
    const { foldersCollection } = await import('../../db/client.ts');
    const { invalidateLibraryRoots } = await import('../../indexer/libraries.cache.ts');
    invalidateLibraryRoots();

    const libId = new ObjectId();
    const folder = await foldersCollection();
    await folder.insertOne({
      _id: libId,
      path: dir,
      label: 'test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);

    const sub = path.join(dir, 'vacation');
    await rm(sub, { recursive: true, force: true });
    await import('node:fs/promises').then(({ mkdir }) => mkdir(sub, { recursive: true }));
    const file = path.join(sub, 'IMG_001.jpg');
    const buf = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 50, g: 50, b: 50 },
      },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const mapleId = 'e'.repeat(32);
    const doc = {
      ...makeDoc(file, libId, dir, null, mapleId),
      // Override to point fileinfo[0] at the vacation subdir explicitly so
      // the content-addressed thumb path lives there.
      fileinfo: [
        {
          path: 'vacation',
          filename: 'IMG_001.jpg',
          library_id: libId,
          deleted_at: null,
        },
      ],
    };

    const result = await thumbStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });
    // The thumb is written to the content-addressed location even though the
    // path is no longer persisted on the asset.
    const expected = path.join(dir, 'vacation', '.maple', 'thumbs', `${mapleId}.jpg`);
    const s = await stat(expected);
    expect(s.size).toBeGreaterThan(0);
  });
});

describe('thumb handler — Cloudflare upload hook', () => {
  let mongo: MongoClient | null = null;
  let mongoReachable = false;
  let db: Db | null = null;
  let dir: string;
  let libId: ObjectId;
  const realFetch = globalThis.fetch;

  const CF_CONFIG = {
    enabled: true,
    account_id: 'acct123',
    bucket: 'maple-thumbs',
    access_key_id: 'AKIAEXAMPLE',
    secret_access_key: 'secretexample',
  };

  function stubFetch(status: number): void {
    globalThis.fetch = (async () => new Response('', { status })) as unknown as typeof fetch;
  }

  async function makeIndexedDoc(filename: string, mapleId: string) {
    const file = path.join(dir, filename);
    const buf = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);
    // makeDoc hardcodes a fixed `_id`; give each inserted doc a real, unique
    // one so three inserts in this block don't collide on the assets
    // collection's primary key.
    const doc = {
      ...makeDoc(file, libId, dir, null, mapleId),
      _id: new ObjectId(),
    };
    await db!.collection('assets').insertOne(doc as never);
    return doc;
  }

  beforeAll(async () => {
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log('[thumb.test] skipping Cloudflare upload hook block: MongoDB unreachable');
      return;
    }
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    const { closeDb } = await import('../../db/client.ts');
    await closeDb();
    dir = await mkdtemp(path.join(os.tmpdir(), 'thumb-stage-cf-'));
    const { foldersCollection } = await import('../../db/client.ts');
    const { invalidateLibraryRoots } = await import('../../indexer/libraries.cache.ts');
    libId = new ObjectId();
    const folder = await foldersCollection();
    await folder.insertOne({
      _id: libId,
      slug: 'cf-test-lib',
      path: dir,
      label: 'cf-test',
      last_scan: null,
      file_count: 0,
      created_at: new Date().toISOString(),
    } as never);
    invalidateLibraryRoots();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    if (mongoReachable) {
      const { closeDb } = await import('../../db/client.ts');
      await closeDb();
      try {
        await mongo!.db(TEST_DB).dropDatabase();
      } catch {}
      try {
        await mongo!.close();
      } catch {}
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not call R2 or stamp cf_thumb_synced_at when Cloudflare is disabled (default)', async () => {
    if (!mongoReachable) return;
    await db!.collection('app_settings').deleteMany({});
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const doc = await makeIndexedDoc('disabled.jpg', 'a'.repeat(32));
    await thumbStage.handler(doc as never, {} as never);

    expect(fetchCalled).toBe(false);
    const saved = await db!.collection('assets').findOne({ _id: doc._id } as never);
    expect((saved as { cf_thumb_synced_at?: string })?.cf_thumb_synced_at).toBeUndefined();
  });

  it('uploads to R2 and stamps cf_thumb_synced_at when enabled and complete', async () => {
    if (!mongoReachable) return;
    await db!
      .collection('app_settings')
      .updateOne({ _id: 'cloudflare' } as never, { $set: { config: CF_CONFIG } }, { upsert: true });
    stubFetch(200);

    const doc = await makeIndexedDoc('enabled.jpg', 'b'.repeat(32));
    const result = await thumbStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });

    const saved = await db!.collection('assets').findOne({ _id: doc._id } as never);
    expect(typeof (saved as { cf_thumb_synced_at?: string })?.cf_thumb_synced_at).toBe('string');
  });

  it('never throws and leaves cf_thumb_synced_at unset when the R2 upload fails', async () => {
    if (!mongoReachable) return;
    await db!
      .collection('app_settings')
      .updateOne({ _id: 'cloudflare' } as never, { $set: { config: CF_CONFIG } }, { upsert: true });
    stubFetch(500);

    const doc = await makeIndexedDoc('failed.jpg', 'c'.repeat(32));
    // Must not throw despite the upload failing — the stage still reports
    // { wrote: true } for the local thumb; the backfill job catches this
    // asset later via the cf_thumb_pending index.
    const result = await thumbStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });

    const saved = await db!.collection('assets').findOne({ _id: doc._id } as never);
    expect((saved as { cf_thumb_synced_at?: string })?.cf_thumb_synced_at).toBeUndefined();
  });
});
