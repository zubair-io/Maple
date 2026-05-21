/**
 * Pure-path-math tests for the content-addressed cache-path resolvers in
 * `xmp.ts`. No Mongo, no filesystem — these compose `(library_root,
 * fileinfo[0].path, maple_id, size)` into a string.
 *
 * The skip-when-Mongo-unreachable pattern from `libraries.cache.test.ts` is
 * not needed here.
 */
import { describe, test, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import * as path from 'node:path';
import { resolveThumbPathForAsset, cachePathForAsset } from './xmp.ts';

const LIB_ID = new ObjectId('1234567890abcdef12345678');
const LIB_ROOT = '/srv/library';
const MAPLE_ID = 'a'.repeat(32);

function libs(): ReadonlyMap<string, string> {
  return new Map([[LIB_ID.toHexString(), LIB_ROOT]]);
}

function makeAsset(opts: {
  /** Pass `null` to omit maple_id explicitly; default is MAPLE_ID. */
  maple_id?: string | null;
  fileinfoPath?: string;
  filename?: string;
  library_id?: ObjectId;
  noFileinfo?: boolean;
}): { maple_id?: string; fileinfo?: { path: string; filename: string; library_id: ObjectId }[] } {
  const mid = opts.maple_id === null ? undefined : (opts.maple_id ?? MAPLE_ID);
  const base: { maple_id?: string } = mid !== undefined ? { maple_id: mid } : {};
  if (opts.noFileinfo) return base;
  return {
    ...base,
    fileinfo: [
      {
        path: opts.fileinfoPath ?? 'vacation/2024',
        filename: opts.filename ?? 'IMG_001.dng',
        library_id: opts.library_id ?? LIB_ID,
      },
    ],
  };
}

describe('resolveThumbPathForAsset', () => {
  test('composes <lib>/<fileinfo[0].path>/.maple/thumbs/<maple_id>.jpg', () => {
    const result = resolveThumbPathForAsset(makeAsset({}), libs());
    expect(result).toBe(
      path.join(LIB_ROOT, 'vacation', '2024', '.maple', 'thumbs', `${MAPLE_ID}.jpg`),
    );
  });

  test('fileinfo[0].path === "" → <lib>/.maple/thumbs/<maple_id>.jpg (file at library root)', () => {
    const result = resolveThumbPathForAsset(makeAsset({ fileinfoPath: '' }), libs());
    expect(result).toBe(path.join(LIB_ROOT, '.maple', 'thumbs', `${MAPLE_ID}.jpg`));
  });

  test('POSIX path split: "a/b/c" → segments joined via path.join (never raw "/" in result)', () => {
    const result = resolveThumbPathForAsset(makeAsset({ fileinfoPath: 'a/b/c' }), libs());
    expect(result).toBe(path.join(LIB_ROOT, 'a', 'b', 'c', '.maple', 'thumbs', `${MAPLE_ID}.jpg`));
  });

  test('returns null when maple_id is missing', () => {
    const result = resolveThumbPathForAsset(makeAsset({ maple_id: null }), libs());
    expect(result).toBeNull();
  });

  test('returns null when library_id is not in the libraries map', () => {
    const result = resolveThumbPathForAsset(
      makeAsset({ library_id: new ObjectId('ffffffffffffffffffffffff') }),
      libs(),
    );
    expect(result).toBeNull();
  });

  test('returns null when fileinfo is empty or absent', () => {
    const result = resolveThumbPathForAsset(makeAsset({ noFileinfo: true }), libs());
    expect(result).toBeNull();
    const result2 = resolveThumbPathForAsset({ maple_id: MAPLE_ID, fileinfo: [] } as never, libs());
    expect(result2).toBeNull();
  });
});

describe('cachePathForAsset', () => {
  test('thumbs kind composes <lib>/<fileinfo[0].path>/.maple/thumbs/<maple_id>.jpg', () => {
    const result = cachePathForAsset(makeAsset({}), libs(), 'thumbs');
    expect(result).toBe(
      path.join(LIB_ROOT, 'vacation', '2024', '.maple', 'thumbs', `${MAPLE_ID}.jpg`),
    );
  });

  test('previews with explicit size: kind="previews", size="1280" → <maple_id>_1280.jpg', () => {
    const result = cachePathForAsset(makeAsset({}), libs(), 'previews', '1280');
    expect(result).toBe(
      path.join(LIB_ROOT, 'vacation', '2024', '.maple', 'previews', `${MAPLE_ID}_1280.jpg`),
    );
  });

  test('previews without size arg → uses _full.jpg suffix', () => {
    const result = cachePathForAsset(makeAsset({}), libs(), 'previews');
    expect(result).toBe(
      path.join(LIB_ROOT, 'vacation', '2024', '.maple', 'previews', `${MAPLE_ID}_full.jpg`),
    );
  });

  test('previews at library root (empty fileinfo[0].path) → no extra segments', () => {
    const result = cachePathForAsset(makeAsset({ fileinfoPath: '' }), libs(), 'previews', '1280');
    expect(result).toBe(path.join(LIB_ROOT, '.maple', 'previews', `${MAPLE_ID}_1280.jpg`));
  });

  test('returns null when maple_id is missing', () => {
    const result = cachePathForAsset(makeAsset({ maple_id: null }), libs(), 'previews', '1280');
    expect(result).toBeNull();
  });

  test('returns null when fileinfo is absent', () => {
    const result = cachePathForAsset(makeAsset({ noFileinfo: true }), libs(), 'previews', '1280');
    expect(result).toBeNull();
  });

  test('returns null when library_id is not in the libraries map', () => {
    const result = cachePathForAsset(
      makeAsset({ library_id: new ObjectId('ffffffffffffffffffffffff') }),
      libs(),
      'previews',
      '1280',
    );
    expect(result).toBeNull();
  });
});
