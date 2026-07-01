import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, stat, utimes } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import previewStage from './preview.ts';
import { PREVIEW_LONG_EDGE_PX, PREVIEW_SIZE_KEY } from '../../indexer/previewer.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';

const TEST_DB = `maple_test_preview_stage_${process.pid}`;
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
  mapleIdOverride?: string,
) {
  const relDir = path.relative(libraryRoot, path.dirname(absPath));
  return {
    _id: '000000000000000000000004' as unknown as ObjectId,
    fileinfo: [
      {
        path: relDir === '.' || relDir === '' ? '' : relDir.split(path.sep).join('/'),
        filename: path.basename(absPath),
        library_id: libraryId,
        deleted_at: null,
      },
    ],
    sha1_head: 'c'.repeat(40),
    maple_id: mapleIdOverride ?? 'd'.repeat(32),
    exif: null,
    stages: {
      exif: {
        version: 1,
        attempts: 0,
        last_error: null,
        processed_at: new Date().toISOString(),
        dead: false,
      },
      thumb: {
        version: 1,
        attempts: 0,
        last_error: null,
        processed_at: new Date().toISOString(),
        dead: false,
      },
      preview: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      face: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      describe: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      geocode: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
      meili: { version: 0, attempts: 0, last_error: null, processed_at: null, dead: false },
    },
  };
}

describe('preview handler — bitmap path', () => {
  let dir: string;
  let libraryId: ObjectId;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'preview-stage-'));
    libraryId = new ObjectId();
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(null);
  });

  it('generates a 1280-px preview for a 2000-px JPEG and marks the stage wrote', async () => {
    const file = path.join(dir, 'wide.jpg');
    const buf = await sharp({
      create: { width: 2000, height: 1200, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file, libraryId, dir);
    const result = await previewStage.handler(doc as never, {} as never);

    // The stage no longer persists `preview_path` — it returns { wrote: true }
    // and the preview lives at the content-addressed location, recomputed on read.
    expect(result).toEqual({ wrote: true });
    const previewPath = cachePathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
      'previews',
      PREVIEW_SIZE_KEY,
    );
    expect(previewPath).not.toBeNull();
    expect((previewPath as string).endsWith(`_${PREVIEW_SIZE_KEY}.jpg`)).toBe(true);

    // The file must exist and be downscaled to 1280-px long edge.
    const s = await stat(previewPath as string);
    expect(s.size).toBeGreaterThan(0);
    const meta = await sharp(previewPath as string).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(PREVIEW_LONG_EDGE_PX);
  });

  it('does not enlarge a smaller source — a 600-px JPEG stays at 600', async () => {
    const file = path.join(dir, 'small.jpg');
    const buf = await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 50, g: 80, b: 100 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file, libraryId, dir);
    const result = await previewStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });
    const previewPath = cachePathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
      'previews',
      PREVIEW_SIZE_KEY,
    );
    expect(previewPath).not.toBeNull();
    const meta = await sharp(previewPath as string).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
  });

  it('bakes in EXIF orientation so the preview is upright', async () => {
    const file = path.join(dir, 'rotated.jpg');
    const buf = await sharp({
      create: { width: 1600, height: 800, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 }) // 90° CW
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file, libraryId, dir);
    const result = await previewStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });
    const previewPath = cachePathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
      'previews',
      PREVIEW_SIZE_KEY,
    );
    expect(previewPath).not.toBeNull();
    const meta = await sharp(previewPath as string).metadata();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it("reuses a cached preview when its mtime is >= the source's", async () => {
    const file = path.join(dir, 'cached.jpg');
    const buf = await sharp({
      create: { width: 2000, height: 1200, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = makeDoc(file, libraryId, dir);
    const first = await previewStage.handler(doc as never, {} as never);
    expect(first).toEqual({ wrote: true });
    const previewPath = cachePathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
      'previews',
      PREVIEW_SIZE_KEY,
    );
    expect(previewPath).not.toBeNull();
    const stat1 = await stat(previewPath as string);

    // Touch the source to a time BEFORE the preview, then re-run. The stale-
    // check should reuse the existing preview file unchanged.
    const past = new Date(stat1.mtimeMs - 60_000);
    await utimes(file, past, past);

    await previewStage.handler(doc as never, {} as never);
    const stat2 = await stat(previewPath as string);
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });

  it("returns { skip: 'video-file' } for a .MOV and writes no preview", async () => {
    // A video container can land in a mixed-media library. The handler must
    // skip it rather than fall through to the copy-as-is path, which would
    // leave raw .MOV bytes under a .jpg name for the describe stage to ship
    // to the vision model.
    const file = path.join(dir, 'IMG_3087.MOV');
    await writeFile(file, Buffer.from('not really a video, just bytes'));

    // Unique maple_id — the preview cache path is keyed on it, so reusing the
    // default would collide with previews other tests in this block wrote.
    const doc = makeDoc(file, libraryId, dir, 'e'.repeat(32));
    const result = await previewStage.handler(doc as never, {} as never);
    expect((result as { skip: string }).skip).toBe('video-file');

    // No preview artefact was produced — assert the stat rejects with ENOENT
    // specifically, so an unexpected error (permissions, transient FS) fails
    // the test loudly instead of masquerading as "file absent".
    const previewPath = cachePathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
      'previews',
      PREVIEW_SIZE_KEY,
    );
    expect(previewPath).not.toBeNull();
    const err = await stat(previewPath as string).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(err?.code).toBe('ENOENT');
  });

  it('marks the stage wrote for a RAW when the FFI is unavailable (soft pass)', async () => {
    // Mirrors the thumb stage test: the handler must never throw when the
    // FFI dylib is absent; downstream stages skip via ENOENT.
    const dng = path.resolve(process.cwd(), '../../test-fixtures/raws/test_0017.dng');
    let dngExists = false;
    try {
      await stat(dng);
      dngExists = true;
    } catch {
      // no fixture — test still runs but skips the file-existence assertion
    }
    if (!dngExists) return;

    // RAW is outside the test library; stage a second library for it.
    const rawLibraryId = new ObjectId();
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(
      new Map([
        [libraryId.toHexString(), dir],
        [rawLibraryId.toHexString(), path.dirname(dng)],
      ]),
    );
    const doc = makeDoc(dng, rawLibraryId, path.dirname(dng), 'f'.repeat(32));
    const result = await previewStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
  });
});

describe('preview handler — content-addressed cache path', () => {
  let mongo: MongoClient | null = null;
  let mongoReachable = false;
  let db: Db | null = null;
  let dir: string;

  beforeAll(async () => {
    mongo = await tryConnect();
    mongoReachable = mongo !== null;
    if (!mongoReachable) {
      console.log('[preview.test] skipping content-addressed block: MongoDB unreachable');
      return;
    }
    db = mongo!.db(TEST_DB);
    await db.dropDatabase();
    const { closeDb } = await import('../../db/client.ts');
    await closeDb();
    dir = await mkdtemp(path.join(os.tmpdir(), 'preview-stage-ca-'));
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

  it('uses <lib>/<fileinfo[0].path>/.maple/previews/<maple_id>_1280.jpg when the doc has maple_id + fileinfo', async () => {
    if (!mongoReachable) return; // soft pass

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

    const sub = path.join(dir, 'trip');
    await mkdir(sub, { recursive: true });
    const file = path.join(sub, 'wide.jpg');
    const buf = await sharp({
      create: { width: 2000, height: 1200, channels: 3, background: { r: 100, g: 150, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const mapleId = 'f'.repeat(32);
    const doc = {
      ...makeDoc(file, libId, dir, mapleId),
      fileinfo: [{ path: 'trip', filename: 'wide.jpg', library_id: libId, deleted_at: null }],
    };

    const result = await previewStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });
    // The preview is written to the content-addressed location even though the
    // path is no longer persisted on the asset.
    const expected = path.join(
      dir,
      'trip',
      '.maple',
      'previews',
      `${mapleId}_${PREVIEW_SIZE_KEY}.jpg`,
    );
    const s = await stat(expected);
    expect(s.size).toBeGreaterThan(0);
  });
});
