/**
 * The shared library-root containment rule (#3094).
 *
 * Platform-dependent cases are gated on `path.sep`: backslash-as-separator
 * only exists on Windows, and backslash-as-filename-character only exists on
 * POSIX — the same gating `trash.test.ts` uses.
 */

import { describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import { relativeUnderRoot, mostSpecificRoot } from './root-match.ts';

describe('relativeUnderRoot', () => {
  it('returns the POSIX-form relative path for a file under the root', () => {
    expect(relativeUnderRoot('/srv/photos', '/srv/photos/2010/Family/x.dng')).toBe(
      '2010/Family/x.dng',
    );
  });

  it('returns an empty string when the path IS the root', () => {
    expect(relativeUnderRoot('/srv/photos', '/srv/photos')).toBe('');
  });

  it('tolerates a trailing slash on the root', () => {
    expect(relativeUnderRoot('/srv/photos/', '/srv/photos/x.dng')).toBe('x.dng');
  });

  it('rejects a sibling root that merely shares a name prefix', () => {
    // The bug this rule exists to prevent: `…/lib` is a raw string prefix of
    // `…/lib2/…`, so an unbounded `startsWith` would claim the file.
    expect(relativeUnderRoot('/srv/cloudtest/lib', '/srv/cloudtest/lib2/_84A1041.CR2')).toBeNull();
    expect(relativeUnderRoot('/srv/photos', '/srv/photosX/x.dng')).toBeNull();
  });

  it('rejects a path outside the root entirely', () => {
    expect(relativeUnderRoot('/srv/photos', '/etc/passwd')).toBeNull();
  });

  it('rejects a traversal that escapes the root', () => {
    expect(relativeUnderRoot('/srv/photos', '/srv/photos/../scans/x.tif')).toBeNull();
  });

  it('does not mistake a sibling named `..something` for a traversal', () => {
    // `rel` here is `../..config/x` for the escape and `..config/x` for the
    // legitimate child — a bare `startsWith('..')` check conflates the two.
    expect(relativeUnderRoot('/srv/photos', '/srv/photos/..config/x.dng')).toBe('..config/x.dng');
  });

  if (path.sep === '\\') {
    it('normalises mixed separators (Windows)', () => {
      // A Windows-hosted server stores the root as registered (either form)
      // but builds asset paths with `path.join` — backslashed.
      expect(relativeUnderRoot('C:/srv/photos', 'C:\\srv\\photos\\a\\x.dng')).toBe('a/x.dng');
      expect(relativeUnderRoot('C:\\srv\\photos', 'C:\\srv\\photos2\\x.dng')).toBeNull();
    });
  } else {
    it('treats a backslash as an ordinary filename character (POSIX)', () => {
      expect(relativeUnderRoot('/srv/photos', '/srv/photos/a\\b.dng')).toBe('a\\b.dng');
    });
  }
});

describe('mostSpecificRoot', () => {
  const PARENT = 'parent';
  const CHILD = 'child';
  const OTHER = 'other';

  it('returns null when no root contains the path', () => {
    expect(mostSpecificRoot('/etc/passwd', [[PARENT, '/srv/photos'] as const])).toBeNull();
  });

  it('picks the only containing root among several', () => {
    const hit = mostSpecificRoot('/srv/scans/a.tif', [
      [PARENT, '/srv/photos'] as const,
      [OTHER, '/srv/scans'] as const,
    ]);
    expect(hit?.key).toBe(OTHER);
    expect(hit?.relPath).toBe('a.tif');
  });

  it('picks the deepest root when libraries are nested, parent listed first', () => {
    const hit = mostSpecificRoot('/srv/photos/2024/x.dng', [
      [PARENT, '/srv/photos'] as const,
      [CHILD, '/srv/photos/2024'] as const,
    ]);
    expect(hit?.key).toBe(CHILD);
    expect(hit?.relPath).toBe('x.dng');
  });

  it('picks the deepest root when libraries are nested, child listed first', () => {
    const hit = mostSpecificRoot('/srv/photos/2024/x.dng', [
      [CHILD, '/srv/photos/2024'] as const,
      [PARENT, '/srv/photos'] as const,
    ]);
    expect(hit?.key).toBe(CHILD);
    expect(hit?.relPath).toBe('x.dng');
  });

  it('still attributes a parent-only file to the parent', () => {
    const hit = mostSpecificRoot('/srv/photos/2010/x.dng', [
      [PARENT, '/srv/photos'] as const,
      [CHILD, '/srv/photos/2024'] as const,
    ]);
    expect(hit?.key).toBe(PARENT);
    expect(hit?.relPath).toBe('2010/x.dng');
  });

  it('reports containment for a path that IS a root (empty relPath)', () => {
    // Directory-walking callers need this; file-only callers reject `''`.
    const hit = mostSpecificRoot('/srv/photos/2024', [
      [PARENT, '/srv/photos'] as const,
      [CHILD, '/srv/photos/2024'] as const,
    ]);
    expect(hit?.key).toBe(CHILD);
    expect(hit?.relPath).toBe('');
  });
});
