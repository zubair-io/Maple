import { describe, expect, it, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { maple } from 'maple';
import { ObjectId } from '../../db/object-id.ts';
import thumbStage from './thumb.ts';
import { resolveThumbPath, resolveThumbPathForAsset, sha256Prefix16 } from '../../fs/xmp.ts';
import * as videoPosterModule from '../../thumbs/video-poster.ts';
import {
  createLiveTestDatabase,
  insertAsset,
  insertFolder,
  insertLocation,
  run,
} from '../../db/sqlite/test-sqlite.test-helpers.ts';
import { invalidateLibraryRoots, setLibraryRootsForTests } from '../../indexer/libraries.cache.ts';
import { runOnce } from '../run-stage.ts';
import { solidJpeg } from '../../test-support/synth-image.ts';

/**
 * What the handler returns on a successful render: no field writes of its own,
 * and the edge-upload stage re-armed against the bytes it just produced.
 *
 * The thumb's path is derived from the source path by every reader, so there is
 * nothing to persist — the patch is empty on purpose and the `invalidates` is
 * the whole result. It used to be a `{ wrote: true }` plus a best-effort
 * `updateOne` the handler issued itself, which could be lost independently of
 * the thumbnail landing on disk.
 */
const RENDERED = { patch: [], invalidates: ['cf-thumb-sync'] };

/**
 * Minimal APP1 EXIF segment carrying a single IFD0 entry: Orientation
 * (tag 0x0112, SHORT) = `orientation`. Spliced in right after the SOI
 * marker, which is where a camera writes it. Copied from
 * `src/maple/test/raster-v2.test.ts`'s `withExifOrientation` (also copied
 * into `thumbs/apply-orientation.test.ts` / `workers/stages/preview.test.ts`)
 * — the same hand-spliced-EXIF trick, not shared production code.
 */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii'); // little-endian TIFF header
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 starts right after the header
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation
  tiff.writeUInt16LE(3, 12); // type SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // inline value
  tiff.writeUInt32LE(0, 22); // no next IFD
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0); // APP1
  header.writeUInt16BE(2 + 6 + tiff.length, 2); // segment length
  const app1 = Buffer.concat([header, Buffer.from('Exif\0\0', 'binary'), tiff]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
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
    _id: new ObjectId('000000000000000000000003'),
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
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    setLibraryRootsForTests(null);
  });

  it('generates a thumb for a JPEG and marks the stage as wrote', async () => {
    const file = path.join(dir, 'photo.jpg');
    const buf = await solidJpeg(800, 600, [100, 150, 200]);
    await writeFile(file, buf);

    const doc = makeDoc(file, libraryId, dir);
    const result = await thumbStage.handler(doc as never, {} as never);

    // The stage no longer persists `thumb_path` — the thumb lives at the
    // path-keyed location, recomputed on read.
    expect(result).toEqual(RENDERED);
    const thumbPath = resolveThumbPathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
    );
    expect(thumbPath).not.toBeNull();
    const s = await stat(thumbPath as string);
    expect(s.size).toBeGreaterThan(0);
  });

  it("returns { skip: 'no-video-decoder' } for a .MOV when the host has no ffmpeg", async () => {
    // #1649: video is skipped on host capability, not on extension. The skip
    // must land BEFORE `generateThumb` — a failed render there still returns
    // `{ wrote: true }`, which would mark the stage done having published
    // nothing AND cascade a pointless cf-thumb-sync reset for a thumb that
    // doesn't exist. Pinned to "absent" rather than reading the real host so
    // this asserts the same thing on a dev Mac and on a bare CI container.
    const ffmpegSpy = spyOn(videoPosterModule, 'ffmpegBinary').mockResolvedValue(null);
    try {
      const file = path.join(dir, 'IMG_3087.MOV');
      await writeFile(file, Buffer.from('not really a video, just bytes'));

      // Distinct filename — the thumb cache path is keyed on the basename.
      const doc = makeDoc(file, libraryId, dir, null, '9'.repeat(32));
      const result = await thumbStage.handler(doc as never, {} as never);
      expect((result as { skip: string }).skip).toBe('no-video-decoder');

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
    } finally {
      ffmpegSpy.mockRestore();
    }
  });

  it("returns { skip: 'stub-file' } for a .eip stub and writes no thumb", async () => {
    // Stub images have no decoder on any host, so unlike video this skip is
    // permanently extension-based. Without it `copyImageAsThumb` would copy the
    // raw bytes to `<key>.avif` and the thumb route would serve 200 image/avif
    // with non-image bytes (broken <img> in the grid).
    const file = path.join(dir, 'IMG_3087.eip');
    await writeFile(file, Buffer.from('not really an image, just bytes'));

    // Distinct filename — the thumb cache path is keyed on the basename.
    const doc = makeDoc(file, libraryId, dir, null, '9'.repeat(32));
    const result = await thumbStage.handler(doc as never, {} as never);
    expect((result as { skip: string }).skip).toBe('stub-file');

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

  it.each([
    ['scan.eip', 'a1'.repeat(16)],
    ['session.braw', 'a2'.repeat(16)],
    ['project.afphoto', 'a3'.repeat(16)],
    ['logo.ai', 'a4'.repeat(16)],
    ['track.mp3', 'a5'.repeat(16)],
    ['voice.wav', 'a6'.repeat(16)],
    ['memo.m4a', 'a7'.repeat(16)],
    ['song.aac', 'a8'.repeat(16)],
  ])(
    "returns { skip: 'stub-file' } for %s (#1835 metadata-only stub/audio) and writes no thumb",
    async (filename, mapleId) => {
      const file = path.join(dir, filename as string);
      await writeFile(file, Buffer.from('not a real decodable file'));

      const doc = makeDoc(file, libraryId, dir, null, mapleId as string);
      const result = await thumbStage.handler(doc as never, {} as never);
      expect((result as { skip: string }).skip).toBe('stub-file');

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
    },
  );

  it('produces an upright thumb regardless of EXIF orientation tag', async () => {
    const file = path.join(dir, 'rotated.jpg');
    // Create a 16x8 JPEG tagged as orientation 6 (90° CW). After the orientation
    // fix (Plan 0), the on-disk thumb must be 8 wide × 16 tall.
    const plain = await solidJpeg(16, 8, [200, 50, 50]);
    const buf = withExifOrientation(plain, 6);
    await writeFile(file, buf);

    const doc = makeDoc(file, libraryId, dir, null, 'e'.repeat(32));
    const result = await thumbStage.handler(doc as never, {} as never);
    expect(result).toEqual(RENDERED);
    const thumbPath = resolveThumbPathForAsset(
      doc as never,
      new Map([[libraryId.toHexString(), dir]]),
    );
    expect(thumbPath).not.toBeNull();
    const meta = await maple(thumbPath as string).metadata();
    // After orientation bake-in, the stored thumb is upright.
    expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);
  });

  it('marks the stage as wrote for a RAW when the FFI is unavailable (soft pass)', async () => {
    // Without libraw_ffi built, generateThumb silently skips the RAW and
    // returns without writing a file. The handler must still return
    // a clean success so the runtime can mark the stage done and the image
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
    setLibraryRootsForTests(
      new Map([
        [libraryId.toHexString(), dir],
        [rawLibraryId.toHexString(), path.dirname(dng)],
      ]),
    );
    const doc = makeDoc(dng, rawLibraryId, path.dirname(dng), null, 'f'.repeat(32));
    // Must not throw.
    const result = await thumbStage.handler(doc as never, {} as never);
    expect(result).toEqual(RENDERED);
    // Restore the single-library cache for subsequent tests.
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
  });
});

describe('thumb handler — path-keyed cache path', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'thumb-stage-ca-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the path-keyed name /api/fs/thumb reads, not a maple_id-keyed one', async () => {
    // A real library row rather than the injected roots map, because the
    // handler resolves its destination through `loadLibraryRoots()` and this
    // test is about where that resolution lands on disk.
    using live = await createLiveTestDatabase();
    const libId = new ObjectId(insertFolder(live.db, { path: dir }));
    invalidateLibraryRoots();

    const sub = path.join(dir, 'vacation');
    await rm(sub, { recursive: true, force: true });
    await mkdir(sub, { recursive: true });
    const file = path.join(sub, 'IMG_001.jpg');
    await writeFile(file, await solidJpeg(800, 600, [50, 50, 50]));

    const mapleId = 'e'.repeat(32);
    const doc = {
      ...makeDoc(file, libId, dir, null, mapleId),
      // Override to point fileinfo[0] at the vacation subdir explicitly so
      // the thumb lands in that folder's .maple/.
      fileinfo: [
        { path: 'vacation', filename: 'IMG_001.jpg', library_id: libId, deleted_at: null },
      ],
    };

    const result = await thumbStage.handler(doc as never, {} as never);
    expect(result).toEqual(RENDERED);
    // The thumb must land at the name a path-only reader computes — this is
    // the agreement that was broken while the stage was maple_id-keyed.
    const expected = resolveThumbPath(file);
    expect(expected).toBe(
      path.join(dir, 'vacation', '.maple', 'thumbs', `${sha256Prefix16('IMG_001.jpg')}.avif`),
    );
    expect((await stat(expected)).size).toBeGreaterThan(0);
    // And explicitly NOT at the old content-addressed name.
    await expect(
      stat(path.join(dir, 'vacation', '.maple', 'thumbs', `${mapleId}.avif`)),
    ).rejects.toThrow();
    invalidateLibraryRoots();
  });
});

describe('thumb handler — resets cf-thumb-sync stage state on rewrite', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'thumb-stage-cfreset-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resets a previously-synced cf-thumb-sync stage state back to unprocessed', async () => {
    // Driven through `runOnce` rather than by calling the handler, because the
    // reset is no longer something the handler performs: it is declared as
    // `invalidates` and the runner commits it in the same transaction as this
    // stage's own success row. Asserting on the handler's return value alone
    // would prove the declaration and not the write.
    using live = await createLiveTestDatabase();
    const libraryId = insertFolder(live.db, { path: dir });
    invalidateLibraryRoots();

    const file = path.join(dir, 'reset-me.jpg');
    await writeFile(file, await solidJpeg(400, 300, [1, 2, 3]));

    const assetId = insertAsset(live.db);
    run(
      live.db,
      `UPDATE assets SET cf_thumb_synced_at = ? WHERE id = ?`,
      '2026-01-01T00:00:00.000Z',
      assetId,
    );
    insertLocation(live.db, { assetId, libraryId, path: '', filename: 'reset-me.jpg' });
    // `exif` at target so the dependency gate lets `thumb` claim the row.
    run(
      live.db,
      `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, 'exif', 99)`,
      assetId,
    );
    run(
      live.db,
      `INSERT INTO stage_state (asset_id, stage, version) VALUES (?, 'thumb', 0)`,
      assetId,
    );
    // Seeded as dead-lettered with a stale error, to confirm the reset clears
    // last_error/processed_at too — not just version/dead/attempts.
    run(
      live.db,
      `INSERT INTO stage_state (asset_id, stage, version, attempts, last_error, processed_at, dead)
       VALUES (?, 'cf-thumb-sync', 1, 5, ?, ?, 1)`,
      assetId,
      'R2 upload failed (500): stale error from a prior run',
      '2026-01-01T00:00:00.000Z',
    );

    await runOnce(thumbStage, {
      concurrency: 2,
      maxAttempts: 5,
      paused: false,
      last_seen_target_version: thumbStage.targetVersion,
    });

    expect(
      live.db
        .query(
          `SELECT version, attempts, last_error, processed_at, dead FROM stage_state
            WHERE asset_id = ? AND stage = 'cf-thumb-sync'`,
        )
        .get(assetId),
    ).toEqual({ version: 0, attempts: 0, last_error: null, processed_at: null, dead: 0 });
    // The thumb stage itself is done, so the two landed together.
    expect(
      live.db
        .query(`SELECT version FROM stage_state WHERE asset_id = ? AND stage = 'thumb'`)
        .get(assetId),
    ).toEqual({ version: thumbStage.targetVersion });
    invalidateLibraryRoots();
  });
});
