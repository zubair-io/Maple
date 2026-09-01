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

/**
 * Root-boundary and specificity rules (#3094).
 *
 * Registration only rejects an EXACT duplicate `path` (POST /api/folders),
 * so two registered libraries can be siblings sharing a name prefix
 * (`…/lib` and `…/lib2`) or genuinely nested (`…/photos` and
 * `…/photos/2024`). Both shapes reach this resolver, and getting either
 * wrong silently attributes a file to the wrong library — the caller then
 * reads a wrong `folder_id` and a wrong asset id, and trash/XMP writes land
 * against the wrong library.
 */
describe('resolveFsPathToLibrary root boundaries', () => {
  const LIB = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const LIB2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';

  it('does not let a root match a sibling that merely shares its name prefix', () => {
    // `…/lib` is a raw string prefix of `…/lib2/…`; the match must end on a
    // separator boundary or `lib2`'s files get attributed to `lib`.
    const roots = new Map([
      [LIB, '/srv/cloudtest/lib'],
      [LIB2, '/srv/cloudtest/lib2'],
    ]);
    const slugs = new Map([
      [LIB, 'lib'],
      [LIB2, 'lib2'],
    ]);
    const hit = resolveFsPathToLibrary('/srv/cloudtest/lib2/_84A1041.CR2', roots, slugs);
    expect(hit?.libraryId).toBe(LIB2);
    expect(hit?.address).toBe('lib2:_84A1041.CR2');
  });

  it('picks the most specific root when one library is nested inside another', () => {
    // Insertion order here is the parent first, which is what Mongo's natural
    // order gives when the parent library was registered first. A first-match
    // scan would return the parent and a relPath of `2024/x.dng`.
    const roots = new Map([
      [LIB, '/srv/photos'],
      [LIB2, '/srv/photos/2024'],
    ]);
    const slugs = new Map([
      [LIB, 'photos'],
      [LIB2, 'photos-2024'],
    ]);
    const hit = resolveFsPathToLibrary('/srv/photos/2024/x.dng', roots, slugs);
    expect(hit?.libraryId).toBe(LIB2);
    expect(hit?.relPath).toBe('x.dng');
    expect(hit?.address).toBe('photos-2024:x.dng');
  });

  it('picks the most specific root regardless of registration order', () => {
    // Same two libraries, child registered first — the answer must not depend
    // on which document Mongo happens to return first.
    const roots = new Map([
      [LIB2, '/srv/photos/2024'],
      [LIB, '/srv/photos'],
    ]);
    const slugs = new Map([
      [LIB, 'photos'],
      [LIB2, 'photos-2024'],
    ]);
    const hit = resolveFsPathToLibrary('/srv/photos/2024/x.dng', roots, slugs);
    expect(hit?.libraryId).toBe(LIB2);
    expect(hit?.relPath).toBe('x.dng');
  });

  it('still resolves a parent-library file when a nested library exists', () => {
    const roots = new Map([
      [LIB, '/srv/photos'],
      [LIB2, '/srv/photos/2024'],
    ]);
    const slugs = new Map([
      [LIB, 'photos'],
      [LIB2, 'photos-2024'],
    ]);
    const hit = resolveFsPathToLibrary('/srv/photos/2010/x.dng', roots, slugs);
    expect(hit?.libraryId).toBe(LIB);
    expect(hit?.relPath).toBe('2010/x.dng');
  });

  it('rejects the nested library root itself (a directory, not a file)', () => {
    const roots = new Map([
      [LIB, '/srv/photos'],
      [LIB2, '/srv/photos/2024'],
    ]);
    const slugs = new Map([[LIB, 'photos']]);
    // Under the parent this would resolve to relPath `2024` — a directory.
    // The most specific root is the nested library, and a root is never a file.
    expect(resolveFsPathToLibrary('/srv/photos/2024', roots, slugs)).toBeNull();
  });
});
