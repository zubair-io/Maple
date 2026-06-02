/**
 * Path-safety unit tests (#854).
 *
 * The rendered-upload handler spliced client-controlled `X-Maple-Suffix-Override`
 * / `X-Maple-Filename-Ext` into the write path with no validation, then
 * `path.join`'d it onto the library root — letting `../` escape (PoC:
 * suffix `../../../../../../../etc/cron.d/pwn` → `/etc/cron.d/pwn`). These cover
 * the two defenses: an allowlist on filename parts, and a canonicalise-then-
 * contain backstop on the final path.
 */
import { describe, it, expect } from 'bun:test';
import path from 'node:path';
import { isSafeFilenamePart, containedJoin } from '../src/backup/path-safety.ts';

describe('isSafeFilenamePart', () => {
  it('accepts real extensions/suffixes, including a leading dot', () => {
    // Clients send e.g. `.JPEG` (dotted ext) and `mov` (bare suffix); a dot is
    // not dangerous, only separators and traversal are.
    for (const s of [
      'jpg',
      'JPEG',
      'mov',
      'rendered',
      'HEIC',
      'mp4',
      '.JPEG',
      'live-photo',
      'a.b',
    ]) {
      expect(isSafeFilenamePart(s)).toBe(true);
    }
  });
  it('rejects traversal, separators, empties, and overlong values', () => {
    for (const s of ['', '..', '../x', 'a/b', 'a\\b', 'foo/../bar', ' ', 'x'.repeat(33)]) {
      expect(isSafeFilenamePart(s)).toBe(false);
    }
  });
});

describe('containedJoin', () => {
  const root = '/srv/maple/library';

  it('returns the joined path for a contained relative path', () => {
    expect(containedJoin(root, '2024/Tokyo/IMG.rendered.JPEG')).toBe(
      path.join(root, '2024/Tokyo/IMG.rendered.JPEG'),
    );
  });

  it('returns null when the relative path escapes the root (the #854 PoC)', () => {
    expect(containedJoin(root, '2024/Tokyo/IMG.../../../../../../etc/cron.d/pwn')).toBeNull();
    expect(containedJoin(root, '../../../etc/passwd')).toBeNull();
  });

  it('returns null for an absolute path that resolves outside the root', () => {
    expect(containedJoin(root, '/etc/passwd')).toBeNull();
  });

  it('treats the root itself as contained', () => {
    expect(containedJoin(root, '.')).toBe(path.resolve(root));
  });
});
