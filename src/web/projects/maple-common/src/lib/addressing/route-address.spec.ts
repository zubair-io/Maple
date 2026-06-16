// Route address decoding tests.
//
// Tests the pure function that converts Angular route segments back into a
// MapleAddress. No Angular router required (pure function test).

import { describe, it, expect } from 'vitest';
import { routeSegmentsToAddress, addressToRouteSegments } from './route-address';

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

  it('decodes percent-encoded segments', () => {
    const addr = routeSegmentsToAddress('library', ['2026', 'My%20Photo%20%231.JPG']);
    expect(addr).toEqual({ slug: 'library', relPath: '2026/My Photo #1.JPG' });
  });

  it('does not double-decode already decoded segments', () => {
    // Angular router decodes once by default; this handles both cases.
    const addr = routeSegmentsToAddress('library', ['2026', 'France']);
    expect(addr).toEqual({ slug: 'library', relPath: '2026/France' });
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
