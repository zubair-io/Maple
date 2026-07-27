// library-cache.thumb-path-parity.spec.ts — "the path the writer writes ==
// the path the reader reads", for Web-local Hosted thumbs (#2254).
//
// `LibraryCache` has two independent call sites that each derive the on-disk
// thumb location for the SAME asset:
//   - `_loadHostedThumb` (write): `sha256Prefix16(asset.filename)` then
//     `MapleCacheService.writeThumb(folder, sha, blob, format)`.
//   - `_tryReadCachedThumb` (read): `sha256Prefix16(asset.filename)` then
//     `MapleCacheService.readThumb(folder, sha)`.
// Nothing stops a future edit to only one of these (e.g. hashing
// `asset.id`/`asset.mapleId` instead of `asset.filename`, or reading before
// `.maple/thumbs/` is created) from passing `sha.spec.ts`'s pinned-vector
// test while silently breaking cross-session/cross-layer thumb reuse — the
// exact shape of the #1999 regression (API `thumb` stage moved its write
// destination; the pinned-hash-function test stayed green for months).
//
// This test reproduces the write call site's real, two-primitive path
// computation (`sha256Prefix16` + the real `MapleCacheService.writeThumb`
// it hands off to — the canvas/pipeline-decode steps upstream of that pair
// only produce blob bytes, not the destination path, so skipping them here
// doesn't weaken the assertion) and then drives the UNMODIFIED, real
// `_tryReadCachedThumb` read call site through the public `ensureThumbnailUrl`
// entry point, against a real `MapleCacheService` backed by an in-memory
// `FolderAccessService` fake. A `bytesForAsset` spy is the miss/hit oracle: a
// cache HIT returns from `_ensureThumbnailUrlInternal` before ever reaching
// the network/decode fallback, so `bytesForAsset` — called only on that
// fallback path — must stay uncalled; a genuine miss calls it.
//
// Model: src/api/src/fs/xmp.test.ts's "agrees with resolveThumbPath for the
// same file". Apple sibling:
// ThumbnailDiskCacheKeyTests.swift's writer-vs-reader section.

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, vi } from 'vitest';

import { LibraryCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { LibrarySelection } from './library-selection.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { sha256Prefix16 } from '../maple-cache/sha';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import { FolderAccessService } from '../folder-access/folder-access.service';
import type { MapleFolderHandle } from '../folder-access/folder-access.types';
import type { Asset, AssetId } from '../models/asset';

/** Same pinned vector `sha.spec.ts` and the Apple/API siblings assert. */
const FILENAME = 'IMG_1234.dng';
const PINNED_SHA = '7ad25b268a071d01';
const ASSET_ID = 'lib:2026/IMG_1234.dng';

function setup() {
  TestBed.resetTestingModule();

  const files = new Map<string, Uint8Array>();
  const fakeFs = {
    async readFile(_f: MapleFolderHandle, path: string): Promise<Uint8Array> {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT ${path}`);
      return bytes;
    },
    async writeFile(_f: MapleFolderHandle, path: string, data: Uint8Array): Promise<void> {
      files.set(path, data);
    },
    async ensureSubdirectory(f: MapleFolderHandle, _name: string): Promise<MapleFolderHandle> {
      return f;
    },
  };

  const folder: MapleFolderHandle = { name: 'lib', read: true, write: true };
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => 'blob:hosted-thumb');
  URL.revokeObjectURL = vi.fn();

  TestBed.configureTestingModule({
    providers: [
      LibraryCache,
      MapleCacheService, // REAL service — same one both call sites hand off to.
      { provide: FolderAccessService, useValue: fakeFs },
      {
        provide: LibraryStore,
        useValue: {
          backend: 'hosted',
          currentFolder: () => folder,
          updateAssetDimensions: vi.fn(),
          assetAbsPaths: new Map<string, string>(),
          findAsset: () => undefined,
        },
      },
      { provide: LibrarySelection, useValue: { selectedSourceId: signal('') } },
      { provide: BunApiBackendService, useValue: {} },
      { provide: FilesystemBrowseService, useValue: {} },
      { provide: RawPipelineService, useValue: {} },
      { provide: LIBRARY_SOURCE, useValue: {} },
    ],
  });

  const svc = TestBed.inject(LibraryCache);
  // The network/decode fallback (`_loadHostedThumb`) is the FIRST thing to
  // call `bytesForAsset` — a real cache HIT never reaches it. Spying on the
  // real public method (rather than stubbing it) lets it still reject
  // naturally when exercised, while giving an unambiguous miss/hit oracle.
  const bytesForAsset = vi.spyOn(svc, 'bytesForAsset');

  return {
    svc,
    cache: TestBed.inject(MapleCacheService),
    files,
    folder,
    bytesForAsset,
    restore: () => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

/** Poll until `until()` holds, THROWING if it never does.
 *
 * Deliberately not a silent return on timeout: a caller that gave up would fall
 * through to its real assertion and fail as "reader didn't find the thumb",
 * which reads exactly like the parity regression this suite is built to detect.
 * Failing here instead points at the async wait that never converged, so a slow
 * or wedged fixture can't masquerade as a writer/reader path divergence. */
const settle = async (until: () => boolean, label: string, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!until()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `settle("${label}") timed out after ${timeoutMs}ms — the condition never became true. ` +
          `This is a fixture/async problem, NOT a writer-vs-reader path mismatch.`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('LibraryCache Hosted thumbs — writer destination === reader source (#2254)', () => {
  it('composes the pinned <folder>/.maple/thumbs/<sha256Prefix16(filename)>.avif path', async () => {
    const { cache, files, folder, restore } = setup();
    try {
      const sha = await sha256Prefix16(FILENAME); // identical call the write call site makes
      expect(sha).toBe(PINNED_SHA);

      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]);
      await cache.writeThumb(folder, sha, new Blob([payload], { type: 'image/avif' }), 'avif');

      // Pin the DIRECTORY convention alongside the stem — a future change to
      // either component then fails here rather than silently diverging.
      expect(files.has(`.maple/thumbs/${PINNED_SHA}.avif`)).toBe(true);
    } finally {
      restore();
    }
  });

  it('the real read call site (_tryReadCachedThumb, via ensureThumbnailUrl) finds exactly what the write primitive wrote — no fallback to network/decode', async () => {
    const { svc, cache, files, folder, bytesForAsset, restore } = setup();
    try {
      // Reproduce the write call site's real path computation: the same two
      // primitives (`sha256Prefix16` + `MapleCacheService.writeThumb`)
      // `_loadHostedThumb` composes, in the same order.
      const sha = await sha256Prefix16(FILENAME);
      const payload = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]);
      await cache.writeThumb(folder, sha, new Blob([payload], { type: 'image/avif' }), 'avif');
      expect(files.has(`.maple/thumbs/${sha}.avif`)).toBe(true);

      const asset = { id: ASSET_ID, filename: FILENAME } as unknown as Asset;
      svc.ensureThumbnailUrl(asset);
      await settle(
        () => svc.thumbnailUrlFor(asset.id as AssetId) !== undefined,
        'thumbnail URL published from the cached file',
      );

      // The UNMODIFIED production read path found the thumb the write
      // primitive stored — never falling through to the network/decode path.
      // A divergence (e.g. the read site hashing something other than
      // `asset.filename`, or looking under a different directory) would
      // leave `thumbnailUrlFor` undefined and force a `bytesForAsset` call.
      expect(svc.thumbnailUrlFor(asset.id as AssetId)).toBe('blob:hosted-thumb');
      expect(bytesForAsset).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('a thumb written under the WRONG directory is invisible to the real read call site (sanity check for the assertion above)', async () => {
    const { svc, files, bytesForAsset, restore } = setup();
    try {
      // Simulate the #1999 failure mode directly: a thumb landed at the
      // right stem but the wrong location (root instead of `.maple/thumbs/`).
      const sha = await sha256Prefix16(FILENAME);
      files.set(`${sha}.avif`, new Uint8Array([1, 2, 3, 4]));

      const asset = { id: ASSET_ID, filename: FILENAME } as unknown as Asset;
      svc.ensureThumbnailUrl(asset);
      await settle(
        () => bytesForAsset.mock.calls.length > 0,
        'fell back to bytesForAsset (decode path)',
      );

      // Cache miss — the read call site fell through to the network/decode
      // fallback, proving the assertion above is actually discriminating and
      // not vacuously true.
      expect(bytesForAsset).toHaveBeenCalledWith(ASSET_ID);
    } finally {
      restore();
    }
  });
});
