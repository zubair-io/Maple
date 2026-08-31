// computeTrashPath separator handling (#2741). The pre-fix implementation
// prefix-checked with a literal `root + '/'`, so a Windows-hosted server —
// where node emits backslashed absolute paths — could never trash any
// asset (every DELETE /api/assets/:id 500'd with "not under root"). The
// platform-dependent cases are gated on `path.sep`: the backslash-as-
// separator cases only exist on Windows, and the backslash-as-filename-
// character case only exists on POSIX.

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { computeTrashPath } from './trash.ts';

describe('computeTrashPath', () => {
  test('maps a nested file into .maple/trash preserving the relative path', () => {
    const out = computeTrashPath('/lib/sub/img.CR2', '/lib');
    expect(out).toBe(path.join('/lib', '.maple', 'trash', 'sub/img.CR2'));
  });

  test('tolerates a trailing slash on the root', () => {
    const out = computeTrashPath('/lib/img.CR2', '/lib/');
    expect(out).toBe(path.join('/lib', '.maple', 'trash', 'img.CR2'));
  });

  test('throws for a path outside the root', () => {
    expect(() => computeTrashPath('/other/img.CR2', '/lib')).toThrow('is not under root');
  });

  test('throws for a sibling directory that shares the root as a string prefix', () => {
    // "/lib2/…" starts with "/lib" as a raw string — the separator-aware
    // check must still reject it.
    expect(() => computeTrashPath('/lib2/img.CR2', '/lib')).toThrow('is not under root');
  });

  if (path.sep === '\\') {
    test('windows: backslashed absolute path under a forward-slash root', () => {
      const out = computeTrashPath('C:\\lib\\sub\\img.CR2', 'C:/lib');
      expect(out).toBe(path.join('C:/lib', '.maple', 'trash', 'sub/img.CR2'));
    });

    test('windows: backslashed absolute path under a backslashed root', () => {
      const out = computeTrashPath('C:\\lib\\img.CR2', 'C:\\lib');
      expect(out).toBe(path.join('C:/lib', '.maple', 'trash', 'img.CR2'));
    });
  } else {
    test('posix: a literal backslash in a filename is not a separator', () => {
      const out = computeTrashPath('/lib/we\\ird.CR2', '/lib');
      expect(out).toBe(path.join('/lib', '.maple', 'trash', 'we\\ird.CR2'));
    });
  }
});
