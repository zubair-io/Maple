import { describe, expect, it } from 'bun:test';
import { thumbR2Key } from './thumb-key.ts';

describe('thumbR2Key', () => {
  it('joins slug, relDir, and filename with a thumbs/ prefix', () => {
    expect(thumbR2Key({ slug: 'main', relDir: 'vacation/2024', filename: 'IMG_001.jpg' })).toBe(
      'thumbs/main/vacation/2024/IMG_001.jpg',
    );
  });

  it('omits empty relDir segments for a file at the library root', () => {
    expect(thumbR2Key({ slug: 'main', relDir: '', filename: 'IMG_001.jpg' })).toBe(
      'thumbs/main/IMG_001.jpg',
    );
  });

  it('percent-encodes unsafe characters per segment', () => {
    expect(thumbR2Key({ slug: 'main', relDir: 'a b', filename: 'photo #1.jpg' })).toBe(
      'thumbs/main/a%20b/photo%20%231.jpg',
    );
  });

  it('produces the same key for the same address, deterministically', () => {
    const addr = { slug: 'main', relDir: 'x/y', filename: 'z.jpg' };
    expect(thumbR2Key(addr)).toBe(thumbR2Key(addr));
  });
});
