import { describe, expect, it } from 'bun:test';
import { resolveFsPathToLibrary } from './metadata.ts';

/**
 * Pure jail/resolution logic for `GET /api/assets/by-fspath` (#2518): map an
 * absolute server path to the registered library that contains it, refusing
 * anything not strictly under a root.
 */
describe('resolveFsPathToLibrary', () => {
  const roots = new Map<string, string>([
    ['aaaaaaaaaaaaaaaaaaaaaaaa', '/srv/photos'],
    ['bbbbbbbbbbbbbbbbbbbbbbbb', '/srv/scans'],
  ]);
  const idToSlug = new Map<string, string>([
    ['aaaaaaaaaaaaaaaaaaaaaaaa', 'photos'],
    ['bbbbbbbbbbbbbbbbbbbbbbbb', 'scans'],
  ]);

  it('resolves a path under a library root to id + relPath + address', () => {
    const hit = resolveFsPathToLibrary('/srv/photos/2010/Family/x.dng', roots, idToSlug);
    expect(hit).toEqual({
      libraryId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      relPath: '2010/Family/x.dng',
      address: 'photos:2010/Family/x.dng',
    });
  });

  it('picks the correct library among several roots', () => {
    const hit = resolveFsPathToLibrary('/srv/scans/a.tif', roots, idToSlug);
    expect(hit?.libraryId).toBe('bbbbbbbbbbbbbbbbbbbbbbbb');
    expect(hit?.address).toBe('scans:a.tif');
  });

  it('omits address when the library has no slug', () => {
    const noSlug = new Map<string, string>();
    const hit = resolveFsPathToLibrary('/srv/photos/x.dng', roots, noSlug);
    expect(hit?.relPath).toBe('x.dng');
    expect(hit?.address).toBeNull();
  });

  it('rejects a path outside every root (no library)', () => {
    expect(resolveFsPathToLibrary('/etc/passwd', roots, idToSlug)).toBeNull();
  });

  it('rejects the library root itself (a directory, not a file)', () => {
    expect(resolveFsPathToLibrary('/srv/photos', roots, idToSlug)).toBeNull();
  });

  it('rejects a traversal that escapes the root', () => {
    // `path.relative('/srv/photos', '/srv/photos/../scans/x')` normalises to
    // '../scans/x' → rejected (belongs to a different root, matched there).
    expect(resolveFsPathToLibrary('/srv/photosX/x.dng', roots, idToSlug)).toBeNull();
  });
});
