import { describe, expect, it } from 'vitest';
import {
  parseAddress,
  formatAddress,
  childAddress,
  parentAddress,
  toApiPath,
} from './maple-address';

describe('MapleAddress', () => {
  it('round-trips', () => {
    const a = parseAddress('library:2026/France/0002/a.JPG');
    expect(a).toEqual({ slug: 'library', relPath: '2026/France/0002/a.JPG' });
    expect(formatAddress(a)).toBe('library:2026/France/0002/a.JPG');
  });
  it('handles the library root (empty relPath)', () => {
    expect(parseAddress('library:')).toEqual({ slug: 'library', relPath: '' });
    expect(formatAddress({ slug: 'library', relPath: '' })).toBe('library:');
  });
  it('splits on the FIRST colon only', () => {
    expect(parseAddress('library:a/b:c.JPG').relPath).toBe('a/b:c.JPG');
  });
  it('child / parent', () => {
    expect(formatAddress(childAddress({ slug: 'l', relPath: '2026' }, 'France'))).toBe(
      'l:2026/France',
    );
    expect(parentAddress({ slug: 'l', relPath: '2026/France' })).toEqual({
      slug: 'l',
      relPath: '2026',
    });
    expect(parentAddress({ slug: 'l', relPath: '' })).toBeNull();
  });
  it('toApiPath percent-encodes each segment', () => {
    expect(toApiPath({ slug: 'l', relPath: '2026/My Photo #3.JPG' })).toBe(
      'l/2026/My%20Photo%20%233.JPG',
    );
  });
  it('toApiPath with empty relPath returns just the slug', () => {
    expect(toApiPath({ slug: 'library', relPath: '' })).toBe('library');
  });
  it('child with empty parent relPath', () => {
    expect(formatAddress(childAddress({ slug: 'l', relPath: '' }, 'France'))).toBe('l:France');
  });
  it('parent at single segment returns root', () => {
    expect(parentAddress({ slug: 'l', relPath: '2026' })).toEqual({ slug: 'l', relPath: '' });
  });
});
