import { describe, test, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import { assetAbsPath, assetLibraryPath, assetPrimaryFileInfo } from './images.repo.ts';
import type { AssetDoc, FileInfo } from '../db/schema.ts';

const libId = new ObjectId();

function makeAsset(over: Partial<AssetDoc>): AssetDoc {
  return {
    size: 1,
    mtime: 1,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-05-20T00:00:00Z',
    ...over,
  };
}

describe('assetPrimaryFileInfo', () => {
  test('returns the first live entry', () => {
    const fi: FileInfo = {
      path: 'vacation/2024',
      filename: 'IMG_001.dng',
      library_id: libId,
    };
    expect(assetPrimaryFileInfo(makeAsset({ fileinfo: [fi] }))).toEqual(fi);
  });

  test('skips entries marked deleted', () => {
    const dead: FileInfo = {
      path: 'old',
      filename: 'x.dng',
      library_id: libId,
      deleted_at: '2026-05-20T00:00:00Z',
    };
    const live: FileInfo = {
      path: 'new',
      filename: 'x.dng',
      library_id: libId,
    };
    expect(assetPrimaryFileInfo(makeAsset({ fileinfo: [dead, live] }))).toEqual(live);
  });

  test('returns null when fileinfo is missing', () => {
    expect(assetPrimaryFileInfo(makeAsset({}))).toBeNull();
  });

  test('returns null when every entry is dead', () => {
    const dead: FileInfo = {
      path: 'x',
      filename: 'y.dng',
      library_id: libId,
      deleted_at: 'now',
    };
    expect(assetPrimaryFileInfo(makeAsset({ fileinfo: [dead] }))).toBeNull();
  });
});

describe('assetAbsPath', () => {
  test('composes from library root + primary fileinfo', () => {
    const fi: FileInfo = {
      path: 'vacation/2024',
      filename: 'IMG_001.dng',
      library_id: libId,
    };
    const libraries = new Map([[libId.toHexString(), '/lib']]);
    expect(assetAbsPath(makeAsset({ fileinfo: [fi] }), libraries)).toBe(
      '/lib/vacation/2024/IMG_001.dng',
    );
  });

  test('returns null when fileinfo is absent (legacy fallback retired)', () => {
    const libraries = new Map<string, string>();
    expect(assetAbsPath(makeAsset({}), libraries)).toBeNull();
  });

  test('returns null when library_id is unknown to the libraries map', () => {
    const fi: FileInfo = {
      path: 'x',
      filename: 'y.dng',
      library_id: new ObjectId(),
    };
    const libraries = new Map<string, string>();
    expect(assetAbsPath(makeAsset({ fileinfo: [fi] }), libraries)).toBeNull();
  });

  test("handles path='' (file at library root)", () => {
    const fi: FileInfo = {
      path: '',
      filename: 'root.dng',
      library_id: libId,
    };
    const libraries = new Map([[libId.toHexString(), '/lib']]);
    const asset = makeAsset({ fileinfo: [fi] });
    expect(assetAbsPath(asset, libraries)).toBe('/lib/root.dng');
  });

  test('returns null when fileinfo is undefined', () => {
    const libraries = new Map<string, string>();
    expect(assetAbsPath({ fileinfo: undefined }, libraries)).toBeNull();
  });
});

describe('assetLibraryPath', () => {
  test('resolves library root from fileinfo[0].library_id', () => {
    const fi: FileInfo = {
      path: 'x',
      filename: 'y.dng',
      library_id: libId,
    };
    const libraries = new Map([[libId.toHexString(), '/srv/lib']]);
    expect(assetLibraryPath(makeAsset({ fileinfo: [fi] }), libraries)).toBe('/srv/lib');
  });

  test('returns null when fileinfo is absent', () => {
    const libraries = new Map([[libId.toHexString(), '/lib']]);
    expect(assetLibraryPath(makeAsset({}), libraries)).toBeNull();
  });

  test('returns null when library_id is unknown to the libraries map', () => {
    const fi: FileInfo = {
      path: 'x',
      filename: 'y.dng',
      library_id: libId,
    };
    const libraries = new Map<string, string>();
    expect(assetLibraryPath(makeAsset({ fileinfo: [fi] }), libraries)).toBeNull();
  });
});

describe('FileInfo.path POSIX-separator portability (assetAbsPath)', () => {
  test('splits stored POSIX `/` segments and joins via platform path.join', () => {
    // FileInfo.path is documented as POSIX-style; assetAbsPath must re-split
    // on `/` so a host that uses `\` as `path.sep` (Windows) gets a correct
    // absolute path. On Linux/macOS the join is byte-identical.
    const fi: FileInfo = {
      path: 'vacation/2024/sub',
      filename: 'IMG.dng',
      library_id: libId,
    };
    const libraries = new Map([[libId.toHexString(), '/lib']]);
    const result = assetAbsPath(makeAsset({ fileinfo: [fi] }), libraries);
    // path.posix.join is what we get on Linux/macOS hosts; the test pins the
    // contract under Bun (Linux/macOS) and survives any non-POSIX host as
    // long as the platform's `path.join` accepts the segments.
    expect(result).toBe('/lib/vacation/2024/sub/IMG.dng');
  });
});
