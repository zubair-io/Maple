// sha.spec.ts — pins `sha256Prefix16` to the exact cross-platform vectors.
//
// Identical vectors are pinned in the Apple and API siblings:
//   - src/apple/Packages/MapleCore/Tests/MapleCoreTests/ThumbnailDiskCacheKeyTests.swift
//   - src/api/src/fs/xmp.test.ts
// All three MUST agree on these exact hex strings, or `.maple/thumbs/`
// written by one layer becomes unreadable by the other two (#2254). This
// file only pins the hash function; the "does the writer's destination match
// the reader's" half of the gate lives in
// `../state/library-cache.thumb-path-parity.spec.ts`.

import { describe, it, expect } from 'vitest';
import { sha256Prefix16 } from './sha';

const PINNED_VECTORS: ReadonlyArray<readonly [filename: string, expected: string]> = [
  ['IMG_0001.ARW', '8fd710b39cdc1a26'],
  ['test.dng', 'b9011a0233accea2'],
  ['IMG_1234.dng', '7ad25b268a071d01'],
  ['photo.HEIC', 'db03400ba7adff45'],
];

describe('sha256Prefix16 — cross-platform pinned vectors (#2254)', () => {
  it.each(PINNED_VECTORS)('sha256Prefix16(%s) === %s', async (filename, expected) => {
    expect(await sha256Prefix16(filename)).toBe(expected);
  });
});
