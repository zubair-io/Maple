import { describe, expect, it, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import previewStage from './preview.ts';
import { PREVIEW_LONG_EDGE_PX, PREVIEW_CACHE_SUFFIX } from '../../indexer/previewer.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import type * as ImgdecodePoolModule from '../../thumbs/imgdecode-pool.ts';

const TEST_DB = `maple_test_preview_stage_${process.pid}`;
process.env.MAPLE_MONGO_DB = TEST_DB;
const MONGO_URI = process.env.MAPLE_MONGO_URI ?? 'mongodb://localhost:27017';

/**
 * Every test below that writes a bitmap (JPEG) source drives
 * `previewStage.handler` through the REAL production path — `previewer.ts`'s
 * `renderBitmapPreviewToFile` — which dispatches to the isolated `imgdecode`
 * child process via the process-global singleton in `thumbs/imgdecode-pool.ts`
 * (see that module's doc: one child, shared by every caller in the whole
 * `bun test` process for its lifetime).
 *
 * #2032: under CI's resource-constrained runner, that shared singleton is
 * also driven by `imgdecode-pool.test.ts`'s own real-child integration test
 * (which resets/shuts down the SAME process-global pool). The extra
 * spawn/respawn churn intermittently made the child return decode errors —
 * or leave a corrupt/partial file behind — for perfectly valid JPEGs here,
 * so `sharp(...).metadata()` on this file's output would throw "Input file
 * contains unsupported image format". Root-caused and reproduced twice in CI
 * (issue #2032); the full suite is stable locally where resources aren't
 * constrained.
 *
 * Mirrors the fix already applied to `routes/preview.test.ts`'s JPEG-body
 * tests (#2018, commit ed75f062b) for the identical class of problem: stub
 * ONLY the subprocess boundary (`renderImageThumbToFileViaPool`), transcoding
 * in-process via sharp instead. A genuine AVIF still lands on disk and passes
 * the real `validateAvifOutput` decode-gate inside `previewer.ts` — every
 * assertion in this file stays decode-verified, not asserted-by-mock — while
 * the real isolated-child transcode remains covered by
 * `imgdecode-pool.test.ts`'s own integration test. Captured/restored once for
 * the whole file (both describe blocks below exercise the same handler path)
 * so the mock never leaks into sibling test files.
 */
let realImgdecodePool: typeof ImgdecodePoolModule;

beforeAll(async () => {
  realImgdecodePool = await import('../../thumbs/imgdecode-pool.ts');
  mock.module('../../thumbs/imgdecode-pool.ts', () => ({
    ...realImgdecodePool,
    renderImageThumbToFileViaPool: async (
      srcPath: string,
      outPath: string,
      maxPx: number,
      quality: number,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Mirrors `thumbs/render.ts`'s default bitmap branch: honour EXIF
        // orientation, resize without enlarging, AVIF-encode.
        const out = await sharp(await readFile(srcPath), { failOn: 'none', unlimited: true })
          .rotate()
          .resize(maxPx, maxPx, { fit: 'inside', withoutEnlargement: true })
          .avif({ quality })
          .toBuffer();
        await writeFile(outPath, out);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  }));
});

afterAll(() => {
  mock.module('../../thumbs/imgdecode-pool.ts', () => realImgdecodePool);
});

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
      preview: {
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
      create: {
        width: 2000,
        height: 1200,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
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
      PREVIEW_CACHE_SUFFIX,
    );
    expect(previewPath).not.toBeNull();
    expect((previewPath as string).endsWith(`.${PREVIEW_CACHE_SUFFIX}`)).toBe(true);

    // The file must exist and be downscaled to 1280-px long edge.
    const s = await stat(previewPath as string);
    expect(s.size).toBeGreaterThan(0);
    const meta = await sharp(previewPath as string).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(PREVIEW_LONG_EDGE_PX);
  });

  it('does not enlarge a smaller source — a 600-px JPEG stays at 600', async () => {
    const file = path.join(dir, 'small.jpg');
    const buf = await sharp({
      create: {
        width: 600,
        height: 400,
        channels: 3,
        background: { r: 50, g: 80, b: 100 },
      },
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
      PREVIEW_CACHE_SUFFIX,
    );
    expect(previewPath).not.toBeNull();
    const meta = await sharp(previewPath as string).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(400);
  });

  it('bakes in EXIF orientation so the preview is upright', async () => {
    const file = path.join(dir, 'rotated.jpg');
    const buf = await sharp({
      create: {
        width: 1600,
        height: 800,
        channels: 3,
        background: { r: 200, g: 50, b: 50 },
      },
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
      PREVIEW_CACHE_SUFFIX,
    );
    expect(previewPath).not.toBeNull();
    const meta = await sharp(previewPath as string).metadata();
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it("reuses a cached preview when its mtime is >= the source's", async () => {
    const file = path.join(dir, 'cached.jpg');
    const buf = await sharp({
      create: {
        width: 2000,
        height: 1200,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
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
      PREVIEW_CACHE_SUFFIX,
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

  it("returns { skip: 'stub-file' } for a .MOV and writes no preview", async () => {
    // A video container can land in a mixed-media library. The handler must
    // skip it rather than fall through to the copy-as-is path, which would
    // leave raw .MOV bytes under a .jpg name for the describe stage to ship
    // to the vision model.
    const file = path.join(dir, 'IMG_3087.MOV');
    await writeFile(file, Buffer.from('not really a video, just bytes'));

    // Distinct maple_id kept for clarity even though the preview cache path
    // is now keyed on `file`'s own name, not `maple_id`.
    const doc = makeDoc(file, libraryId, dir, 'e'.repeat(32));
    const result = await previewStage.handler(doc as never, {} as never);
    expect((result as { skip: string }).skip).toBe('stub-file');

    // No preview artefact was produced — assert the stat rejects with ENOENT
    // specifically, so an unexpected error (permissions, transient FS) fails
    // the test loudly instead of masquerading as "file absent".
    const previewPath = cachePathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
      'previews',
      PREVIEW_CACHE_SUFFIX,
    );
    expect(previewPath).not.toBeNull();
    const err = await stat(previewPath as string).then(
      () => null,
      (e: NodeJS.ErrnoException) => e,
    );
    expect(err?.code).toBe('ENOENT');
  });

  it.each([
    ['scan.eip', 'f'.repeat(32)],
    ['session.braw', '1'.repeat(32)],
    ['project.afphoto', '2'.repeat(32)],
    ['logo.ai', '3'.repeat(32)],
    ['track.mp3', '4'.repeat(32)],
    ['voice.wav', '5'.repeat(32)],
    ['memo.m4a', '6'.repeat(32)],
    ['song.aac', '7'.repeat(32)],
  ])(
    "returns { skip: 'stub-file' } for %s (#1835 metadata-only stub/audio) and writes no preview",
    async (filename, mapleId) => {
      const file = path.join(dir, filename as string);
      await writeFile(file, Buffer.from('not a real decodable file'));

      const doc = makeDoc(file, libraryId, dir, mapleId as string);
      const result = await previewStage.handler(doc as never, {} as never);
      expect((result as { skip: string }).skip).toBe('stub-file');

      const previewPath = cachePathForAsset(
        doc as never,
        new Map([[libraryId.toHexString(), dir]]),
        'previews',
        PREVIEW_CACHE_SUFFIX,
      );
      expect(previewPath).not.toBeNull();
      const err = await stat(previewPath as string).then(
        () => null,
        (e: NodeJS.ErrnoException) => e,
      );
      expect(err?.code).toBe('ENOENT');
    },
  );

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

describe('preview handler — path-keyed cache path', () => {
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

  it('uses <lib>/<fileinfo[0].path>/.maple/previews/<filename>.avif when the doc has fileinfo (no maple_id needed)', async () => {
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
      create: {
        width: 2000,
        height: 1200,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .jpeg()
      .toBuffer();
    await writeFile(file, buf);

    const doc = {
      ...makeDoc(file, libId, dir, undefined),
      maple_id: undefined,
      fileinfo: [
        {
          path: 'trip',
          filename: 'wide.jpg',
          library_id: libId,
          deleted_at: null,
        },
      ],
    };

    const result = await previewStage.handler(doc as never, {} as never);
    expect(result).toEqual({ wrote: true });
    // The preview is written to the path-keyed location — no maple_id needed,
    // and the path is not persisted on the asset (recomputed on read).
    const expected = path.join(
      dir,
      'trip',
      '.maple',
      'previews',
      `wide.jpg.${PREVIEW_CACHE_SUFFIX}`,
    );
    const s = await stat(expected);
    expect(s.size).toBeGreaterThan(0);
  });
});
