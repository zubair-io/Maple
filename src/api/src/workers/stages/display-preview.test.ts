import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, copyFile, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import displayPreviewStage, { developedPreviewSizeKey } from './display-preview.ts';
import { cachePathForAsset } from '../../fs/xmp.ts';
import { ffiPool } from '../../ffi/ffi-pool.ts';

function makeDoc(
  absPath: string,
  libraryId: ObjectId,
  libraryRoot: string,
  opts: { mapleId?: string; hasXmp?: boolean; sidecarVer?: number } = {},
) {
  const relDir = path.relative(libraryRoot, path.dirname(absPath));
  return {
    _id: new ObjectId(),
    fileinfo: [
      {
        path: relDir === '.' || relDir === '' ? '' : relDir.split(path.sep).join('/'),
        filename: path.basename(absPath),
        library_id: libraryId,
        deleted_at: null,
      },
    ],
    maple_id: opts.mapleId ?? 'd'.repeat(32),
    has_xmp: opts.hasXmp ?? false,
    sidecar_ver: opts.sidecarVer,
  };
}

describe('developedPreviewSizeKey', () => {
  it('formats dev_<ver>, defaulting undefined to 0', () => {
    expect(developedPreviewSizeKey(3)).toBe('dev_3');
    expect(developedPreviewSizeKey(0)).toBe('dev_0');
    expect(developedPreviewSizeKey(undefined)).toBe('dev_0');
  });
});

describe('display-preview handler', () => {
  let dir: string;
  let libraryId: ObjectId;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'display-preview-'));
    libraryId = new ObjectId();
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
    setLibraryRootsForTests(null);
  });

  it('skips an UNEDITED asset (no has_xmp) — the embedded preview is correct there', async () => {
    const file = path.join(dir, 'plain.dng');
    await writeFile(file, Buffer.from([0x00, 0x01]));
    const doc = makeDoc(file, libraryId, dir, { mapleId: 'a'.repeat(32), hasXmp: false });
    const result = await displayPreviewStage.handler(doc as never, {} as never);
    expect(result).toEqual({ skip: 'unedited' });
  });

  it('skips a stub file even when marked edited', async () => {
    const file = path.join(dir, 'scan.eip');
    await writeFile(file, Buffer.from('stub'));
    const doc = makeDoc(file, libraryId, dir, { mapleId: 'b'.repeat(32), hasXmp: true });
    const result = await displayPreviewStage.handler(doc as never, {} as never);
    expect(result).toEqual({ skip: 'stub-file' });
  });

  it('renders a developed _dev_<ver>.jpg for an edited RAW (fixture + dylib gated)', async () => {
    const fixture = path.resolve(process.cwd(), '../../test-fixtures/raws/test_0002.dng');
    const hasFixture = await stat(fixture).then(
      () => true,
      () => false,
    );
    if (!hasFixture || !ffiPool().available()) {
      // SKIP-PASS — no fixture RAW or no native dylib (CI without either).
      return;
    }

    // Copy the fixture into a temp library so the developed file lands in a
    // throwaway `.maple/previews/`, not the shared fixtures dir.
    const rawLib = await mkdtemp(path.join(os.tmpdir(), 'display-preview-raw-'));
    try {
      const rawLibraryId = new ObjectId();
      const raw = path.join(rawLib, 'edited.dng');
      await copyFile(fixture, raw);
      const { setLibraryRootsForTests } = await import('../../indexer/libraries.cache.ts');
      setLibraryRootsForTests(
        new Map([
          [libraryId.toHexString(), dir],
          [rawLibraryId.toHexString(), rawLib],
        ]),
      );

      const mapleId = 'c'.repeat(32);
      const doc = makeDoc(raw, rawLibraryId, rawLib, {
        mapleId,
        hasXmp: true, // no .xmp on disk → neutral develop (still exercises the path)
        sidecarVer: 2,
      });
      const result = await displayPreviewStage.handler(doc as never, {} as never);
      expect(result).toEqual({ wrote: true });

      const devPath = cachePathForAsset(
        doc as never,
        new Map([[rawLibraryId.toHexString(), rawLib]]),
        'previews',
        developedPreviewSizeKey(2),
      );
      expect(devPath).not.toBeNull();
      expect((devPath as string).endsWith(`${mapleId}_dev_2.jpg`)).toBe(true);
      const s = await stat(devPath as string);
      expect(s.size).toBeGreaterThan(0);

      setLibraryRootsForTests(new Map([[libraryId.toHexString(), dir]]));
    } finally {
      await rm(rawLib, { recursive: true, force: true });
    }
  }, 120_000);
});
