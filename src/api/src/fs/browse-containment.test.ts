import { describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import { isUnderRoot } from './browse.ts';

describe('browse folder containment', () => {
  const root = path.resolve('test-library');

  it('accepts the root, trailing separator, and nested native paths', () => {
    expect(isUnderRoot(root, root)).toBe(true);
    expect(isUnderRoot(path.join(root, 'photos', 'image.dng'), root)).toBe(true);
    expect(isUnderRoot(path.join(root, 'image.dng'), root + path.sep)).toBe(true);
    expect(isUnderRoot(root, path.parse(root).root)).toBe(true);
  });

  it('rejects siblings with a shared prefix and parent traversal', () => {
    expect(isUnderRoot(root + '-outside', root)).toBe(false);
    expect(isUnderRoot(path.join(root, '..', 'outside', 'image.dng'), root)).toBe(false);
    expect(isUnderRoot(path.dirname(root), root)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('rejects other Windows volumes and UNC shares', () => {
    expect(isUnderRoot('D:\\photos\\image.dng', 'C:\\photos')).toBe(false);
    expect(isUnderRoot('\\\\server\\other\\image.dng', '\\\\server\\photos')).toBe(false);
    expect(isUnderRoot('C:\\photos\\image.dng', 'C:\\')).toBe(true);
  });
});
