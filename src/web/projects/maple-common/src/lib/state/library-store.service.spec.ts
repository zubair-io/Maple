import { assetAbsPath, buildLibrariesById } from './library-store.service';
import { Asset, FileInfo } from '../models/asset';
import { ApiFolder } from '../api/bun-api-backend.service';

// Minimal Asset stub — `assetAbsPath` reads only `fileinfo` + `absPath`.
function asset(
  fields: Partial<Pick<Asset, 'fileinfo' | 'absPath'>>,
): Pick<Asset, 'fileinfo' | 'absPath'> {
  return { ...fields };
}

const LIB_ID = '507f1f77bcf86cd799439011';

function fi(path: string, filename: string, opts: Partial<FileInfo> = {}): FileInfo {
  return {
    path,
    filename,
    library_id: LIB_ID,
    deleted_at: null,
    ...opts,
  };
}

describe('assetAbsPath path normalization', () => {
  it('joins root + path + filename with single slashes', () => {
    const libs = new Map([[LIB_ID, '/Volumes/Photos']]);
    const a = asset({ fileinfo: [fi('2024/jan', 'IMG_001.dng')] });
    expect(assetAbsPath(a, libs)).toBe('/Volumes/Photos/2024/jan/IMG_001.dng');
  });

  it('handles trailing slash on root without producing //', () => {
    const libs = new Map([[LIB_ID, '/Volumes/Photos/']]);
    const a = asset({ fileinfo: [fi('2024/jan', 'IMG_001.dng')] });
    expect(assetAbsPath(a, libs)).toBe('/Volumes/Photos/2024/jan/IMG_001.dng');
  });

  it('handles multiple trailing slashes on root', () => {
    const libs = new Map([[LIB_ID, '/Volumes/Photos///']]);
    const a = asset({ fileinfo: [fi('2024/jan', 'IMG_001.dng')] });
    expect(assetAbsPath(a, libs)).toBe('/Volumes/Photos/2024/jan/IMG_001.dng');
  });

  it('handles leading slash on path without producing //', () => {
    const libs = new Map([[LIB_ID, '/Volumes/Photos']]);
    const a = asset({ fileinfo: [fi('/2024/jan', 'IMG_001.dng')] });
    expect(assetAbsPath(a, libs)).toBe('/Volumes/Photos/2024/jan/IMG_001.dng');
  });

  it('handles trailing slash on path without producing //', () => {
    const libs = new Map([[LIB_ID, '/Volumes/Photos']]);
    const a = asset({ fileinfo: [fi('2024/jan/', 'IMG_001.dng')] });
    expect(assetAbsPath(a, libs)).toBe('/Volumes/Photos/2024/jan/IMG_001.dng');
  });

  it('handles slashes on both root and path', () => {
    const libs = new Map([[LIB_ID, '/Volumes/Photos/']]);
    const a = asset({ fileinfo: [fi('/2024/jan/', 'IMG_001.dng')] });
    expect(assetAbsPath(a, libs)).toBe('/Volumes/Photos/2024/jan/IMG_001.dng');
  });

  it('joins root + filename when path is empty (file at library root)', () => {
    const libs = new Map([[LIB_ID, '/Volumes/Photos']]);
    const a = asset({ fileinfo: [fi('', 'IMG_001.dng')] });
    expect(assetAbsPath(a, libs)).toBe('/Volumes/Photos/IMG_001.dng');
  });

  it('joins root + filename when path is empty and root has trailing slash', () => {
    const libs = new Map([[LIB_ID, '/Volumes/Photos/']]);
    const a = asset({ fileinfo: [fi('', 'IMG_001.dng')] });
    expect(assetAbsPath(a, libs)).toBe('/Volumes/Photos/IMG_001.dng');
  });

  it('preserves root == "/" (filesystem root)', () => {
    const libs = new Map([[LIB_ID, '/']]);
    const a = asset({ fileinfo: [fi('tmp', 'IMG_001.dng')] });
    expect(assetAbsPath(a, libs)).toBe('/tmp/IMG_001.dng');
  });

  it('preserves root == "/" with empty path', () => {
    const libs = new Map([[LIB_ID, '/']]);
    const a = asset({ fileinfo: [fi('', 'IMG_001.dng')] });
    expect(assetAbsPath(a, libs)).toBe('/IMG_001.dng');
  });
});

describe('assetAbsPath fallback', () => {
  it('returns legacy absPath when no fileinfo', () => {
    const libs = new Map<string, string>();
    const a = asset({ absPath: '/legacy/path/IMG_001.dng' });
    expect(assetAbsPath(a, libs)).toBe('/legacy/path/IMG_001.dng');
  });

  it('returns legacy absPath when fileinfo library is not registered', () => {
    const libs = new Map<string, string>();
    const a = asset({
      fileinfo: [fi('2024/jan', 'IMG_001.dng')],
      absPath: '/legacy/path/IMG_001.dng',
    });
    expect(assetAbsPath(a, libs)).toBe('/legacy/path/IMG_001.dng');
  });

  it('skips fileinfo entries with deleted_at set', () => {
    const libs = new Map([[LIB_ID, '/Volumes/Photos']]);
    const a = asset({
      fileinfo: [
        fi('old/dir', 'IMG_001.dng', { deleted_at: '2024-01-01T00:00:00Z' }),
        fi('new/dir', 'IMG_001.dng'),
      ],
    });
    expect(assetAbsPath(a, libs)).toBe('/Volumes/Photos/new/dir/IMG_001.dng');
  });

  it('returns null when neither fileinfo nor absPath resolves', () => {
    const libs = new Map<string, string>();
    const a = asset({});
    expect(assetAbsPath(a, libs)).toBeNull();
  });
});

describe('buildLibrariesById', () => {
  it('maps library id → path', () => {
    const folders = [
      { id: 'a', path: '/Volumes/A', label: 'A' },
      { id: 'b', path: '/Volumes/B', label: 'B' },
    ] as unknown as ApiFolder[];
    const m = buildLibrariesById(folders);
    expect(m.get('a')).toBe('/Volumes/A');
    expect(m.get('b')).toBe('/Volumes/B');
    expect(m.size).toBe(2);
  });
});
