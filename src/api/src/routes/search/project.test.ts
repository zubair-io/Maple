/**
 * Pure unit tests for `projectAsset`'s address computation. No Mongo — all
 * inputs are plain fixtures, mirroring the pattern in `nl-date.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { ObjectId } from 'mongodb';
import type { AssetDoc } from '../../db/schema.ts';
import { projectAsset } from './project.ts';

function fixtureDoc(overrides: Partial<AssetDoc> = {}): AssetDoc & { _id: ObjectId } {
  return {
    _id: new ObjectId(),
    size: 1024,
    mtime: 1700000000000,
    rating: 0,
    flag: 0,
    color_label: '',
    indexed_at: '2026-01-01T00:00:00.000Z',
    fileinfo: [
      {
        path: 'vacation/2024',
        filename: 'IMG_0001.dng',
        library_id: new ObjectId('507f1f77bcf86cd799439011'),
      },
    ],
    ...overrides,
  } as AssetDoc & { _id: ObjectId };
}

describe('projectAsset — address field', () => {
  it('computes slug:relPath when the primary library has a registered slug', () => {
    const doc = fixtureDoc();
    const libs = new Map<string, string>();
    const idToSlug = new Map<string, string>([['507f1f77bcf86cd799439011', 'my-library']]);
    const result = projectAsset(doc, libs, idToSlug);
    expect(result.address).toBe('my-library:vacation/2024/IMG_0001.dng');
  });

  it('handles a library-root file (empty relPath directory)', () => {
    const doc = fixtureDoc({
      fileinfo: [
        { path: '', filename: 'IMG_0002.dng', library_id: new ObjectId('507f1f77bcf86cd799439011') },
      ],
    });
    const libs = new Map<string, string>();
    const idToSlug = new Map<string, string>([['507f1f77bcf86cd799439011', 'my-library']]);
    const result = projectAsset(doc, libs, idToSlug);
    expect(result.address).toBe('my-library:IMG_0002.dng');
  });

  it('returns null when the primary library has no registered slug', () => {
    const doc = fixtureDoc();
    const libs = new Map<string, string>();
    const idToSlug = new Map<string, string>(); // no slug registered
    const result = projectAsset(doc, libs, idToSlug);
    expect(result.address).toBeNull();
  });

  it('returns null when the doc has no fileinfo', () => {
    const doc = fixtureDoc({ fileinfo: undefined });
    const libs = new Map<string, string>();
    const idToSlug = new Map<string, string>([['507f1f77bcf86cd799439011', 'my-library']]);
    const result = projectAsset(doc, libs, idToSlug);
    expect(result.address).toBeNull();
  });
});
