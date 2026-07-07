// Route address decoding tests.
//
// Tests the pure function that converts Angular route segments back into a
// MapleAddress. No Angular router required (pure function test).

import { describe, it, expect } from 'vitest';
import {
  routeSegmentsToAddress,
  addressToRouteSegments,
  editRouteCommands,
  viewRouteCommands,
} from './route-address';

describe('routeSegmentsToAddress', () => {
  it('converts slug + relPath segments to MapleAddress', () => {
    // /browse/library/2026/France/0002 → slug='library', relPath='2026/France/0002'
    const addr = routeSegmentsToAddress('library', ['2026', 'France', '0002']);
    expect(addr).toEqual({ slug: 'library', relPath: '2026/France/0002' });
  });

  it('handles library root (no remaining segments)', () => {
    const addr = routeSegmentsToAddress('library', []);
    expect(addr).toEqual({ slug: 'library', relPath: '' });
  });

  it('passes Angular-decoded segments through unchanged', () => {
    // Angular's Router hands us UrlSegment.path already decoded, e.g.
    // "/browse/library/2026/My Photo #1.JPG" → ['2026', 'My Photo #1.JPG'].
    const addr = routeSegmentsToAddress('library', ['2026', 'My Photo #1.JPG']);
    expect(addr).toEqual({ slug: 'library', relPath: '2026/My Photo #1.JPG' });
  });

  it('does NOT re-decode a literal percent sequence (regression: no double-decode)', () => {
    // A file literally named "a%20b" arrives from Angular already decoded as
    // "a%20b". Re-decoding here would corrupt it to "a b".
    const addr = routeSegmentsToAddress('library', ['a%20b']);
    expect(addr).toEqual({ slug: 'library', relPath: 'a%20b' });
  });
});

describe('addressToRouteSegments', () => {
  it('converts a folder address to route segments', () => {
    const segs = addressToRouteSegments({ slug: 'library', relPath: '2026/France/0002' });
    expect(segs).toEqual(['/browse', 'library', '2026', 'France', '0002']);
  });

  it('converts a library root address', () => {
    const segs = addressToRouteSegments({ slug: 'library', relPath: '' });
    expect(segs).toEqual(['/browse', 'library']);
  });

  it('converts an image address using /edit prefix', () => {
    const segs = addressToRouteSegments(
      { slug: 'library', relPath: '2026/France/img.JPG' },
      'edit',
    );
    expect(segs).toEqual(['/edit', 'library', '2026', 'France', 'img.JPG']);
  });

  it('encodes special characters in segments', () => {
    const segs = addressToRouteSegments({
      slug: 'library',
      relPath: '2026/My Photo #1.JPG',
    });
    expect(segs).toEqual(['/browse', 'library', '2026', 'My Photo #1.JPG']);
  });
});

describe('editRouteCommands', () => {
  it('splits a slug:relPath id into /edit/:slug/** segments (the click-to-open bug)', () => {
    // Passing ['/edit', 'library:test-sync.jpg'] put the WHOLE id into :slug, so
    // the editor resolved a bogus address and bounced back to Browse.
    expect(editRouteCommands('library:test-sync.jpg')).toEqual([
      '/edit',
      'library',
      'test-sync.jpg',
    ]);
  });

  it('splits a nested relPath into separate segments', () => {
    expect(editRouteCommands('library:2026/jan/img.jpg')).toEqual([
      '/edit',
      'library',
      '2026',
      'jan',
      'img.jpg',
    ]);
  });

  it('handles an address with an empty relPath', () => {
    expect(editRouteCommands('library:')).toEqual(['/edit', 'library']);
  });

  it('passes a legacy fs: id through unchanged', () => {
    expect(editRouteCommands('fs:/srv/photos/x.jpg')).toEqual(['/edit', 'fs:/srv/photos/x.jpg']);
  });

  it('passes a non-address id through unchanged', () => {
    expect(editRouteCommands('f-imported-123')).toEqual(['/edit', 'f-imported-123']);
  });

  it('passes a malformed id with an empty slug through (no empty route segment)', () => {
    // parseAddress(':foo') → { slug: '', relPath: 'foo' }; splitting that would
    // emit ['/edit', '', 'foo']. Guard it to a single-segment passthrough.
    expect(editRouteCommands(':foo')).toEqual(['/edit', ':foo']);
  });
});

describe('viewRouteCommands', () => {
  it('splits a slug:relPath id into /view segments', () => {
    expect(viewRouteCommands('lib1:2024/a.dng')).toEqual(['/view', 'lib1', '2024', 'a.dng']);
  });
  it('passes fs: ids through as a single segment', () => {
    expect(viewRouteCommands('fs:/abs/a.dng')).toEqual(['/view', 'fs:/abs/a.dng']);
  });
  it('passes colon-less ids through', () => {
    expect(viewRouteCommands('imported-123')).toEqual(['/view', 'imported-123']);
  });
  it('addressToRouteSegments supports view mode', () => {
    expect(addressToRouteSegments({ slug: 'lib1', relPath: 'a.dng' }, 'view')).toEqual([
      '/view',
      'lib1',
      'a.dng',
    ]);
  });
});
