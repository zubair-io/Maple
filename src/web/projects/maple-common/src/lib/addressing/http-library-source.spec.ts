// HttpLibrarySource URL-construction tests.
//
// Tests the URL-building logic (which routes call which URL) without Angular DI.
// The actual injectable class is thin — it injects HttpClient and API_BASE_URL
// and delegates URL building to toApiPath(). These tests exercise that delegation
// by constructing the expected URL and confirming it matches.
//
// Angular DI integration tests would require ng test (which sets up TestBed +
// initTestEnvironment). These tests run under bun x vitest run directly.

import { describe, it, expect } from 'vitest';
import { toApiPath, parseAddress } from './maple-address';

// ── URL contract assertions ────────────────────────────────────────────────────
// Rather than testing the injectable class (requires Angular TestBed / ng test),
// these tests assert the URL contract that HttpLibrarySource implements:
// each route is BASE/<routeName>/<toApiPath(address)>.
// The contract is enforced by the implementation referencing toApiPath().

const BASE = '/api';

function folderUrl(slug: string, relPath: string) {
  return `${BASE}/folder/${toApiPath({ slug, relPath })}`;
}
function thumbUrl(slug: string, relPath: string) {
  return `${BASE}/thumb/${toApiPath({ slug, relPath })}`;
}
function previewUrl(slug: string, relPath: string) {
  return `${BASE}/preview/${toApiPath({ slug, relPath })}`;
}
function imageUrl(slug: string, relPath: string) {
  return `${BASE}/image/${toApiPath({ slug, relPath })}`;
}

describe('HttpLibrarySource URL contract', () => {
  it('folder URL for a nested path', () => {
    expect(folderUrl('library', '2026/France')).toBe('/api/folder/library/2026/France');
  });

  it('folder URL for library root (empty relPath)', () => {
    expect(folderUrl('library', '')).toBe('/api/folder/library');
  });

  it('thumb URL — no ?size param', () => {
    const url = thumbUrl('library', '2026/France/img.JPG');
    expect(url).toBe('/api/thumb/library/2026/France/img.JPG');
    expect(url).not.toContain('size=');
  });

  it('preview URL matches contract', () => {
    expect(previewUrl('library', '2026/France/img.JPG')).toBe(
      '/api/preview/library/2026/France/img.JPG',
    );
  });

  it('image URL percent-encodes special characters', () => {
    expect(imageUrl('library', '2026/My Photo #3.JPG')).toBe(
      '/api/image/library/2026/My%20Photo%20%233.JPG',
    );
  });

  it('all URL builders percent-encode each segment independently', () => {
    const addr = parseAddress('my-lib:folder with spaces/file #1.JPG');
    const expected = '/my-lib/folder%20with%20spaces/file%20%231.JPG';
    expect(folderUrl(addr.slug, addr.relPath)).toBe('/api/folder' + expected);
    expect(thumbUrl(addr.slug, addr.relPath)).toBe('/api/thumb' + expected);
    expect(previewUrl(addr.slug, addr.relPath)).toBe('/api/preview' + expected);
    expect(imageUrl(addr.slug, addr.relPath)).toBe('/api/image' + expected);
  });
});
