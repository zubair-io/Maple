// LibraryCache — subscribePreviewUrl: best display-still per backend.
//
// Mirrors subscribeThumbUrl (see library-cache.service.spec.ts) except any
// address-shaped id resolves through a richer preview source instead of the
// thumbnail: Self-Hosted M2 `slug:relPath` via LibrarySource.previewBlob
// (/api/preview/:slug/*); Hosted (File System Access) via
// `HostedPreviewResolver.resolve` — local embedded-RAW-preview extraction
// (#2010, epic #1993 Stage 4), replacing the old "no richer preview source"
// canvas-resize-of-a-full-develop placeholder. Every other id — imported,
// legacy fs:<absPath> — falls through to the thumbnail URL.
//
// `HostedPreviewResolver` itself (mapleId cache-key resolution, the
// `.maple/previews/` read/write-through cache, the RAW/non-RAW split, and
// extraction-failure handling) is tested directly in
// `hosted-preview-resolver.service.spec.ts` — this file only asserts
// `LibraryCache` wires the Hosted branch to it correctly.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';

import { LibraryCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import { HostedPreviewResolver } from './hosted-preview-resolver.service';
import type { AssetId } from '../models/asset';

// subscribePreviewUrl's resolution is fire-and-forget (kicked off via
// BlobUrlChannel.ensure's .then/.finally); let it + microtasks settle before
// asserting.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(
  libSource: Record<string, unknown>,
  store: Record<string, unknown> = { backend: 'self-hosted' },
  hostedPreviewResolver: Record<string, unknown> = {},
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      LibraryCache,
      { provide: LibraryStore, useValue: store },
      { provide: BunApiBackendService, useValue: {} },
      { provide: FilesystemBrowseService, useValue: {} },
      { provide: MapleCacheService, useValue: {} },
      { provide: RawPipelineService, useValue: {} },
      { provide: HostedPreviewResolver, useValue: hostedPreviewResolver },
      { provide: LIBRARY_SOURCE, useValue: libSource },
    ],
  });
  return TestBed.inject(LibraryCache);
}

describe('LibraryCache.subscribePreviewUrl', () => {
  it('Self-Hosted slug:relPath id resolves via LibrarySource.previewBlob (/api/preview)', async () => {
    const previewBlob = vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' }));
    const thumbBlob = vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' }));
    const svc = setup({ previewBlob, thumbBlob });

    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-preview-url-/api/preview/');
    try {
      const seen: (string | undefined)[] = [];
      svc.subscribePreviewUrl('lib:2026/a.jpg' as AssetId, (url) => seen.push(url));
      await settle();

      expect(previewBlob).toHaveBeenCalledWith({ slug: 'lib', relPath: '2026/a.jpg' });
      expect(thumbBlob).not.toHaveBeenCalled();
      expect(seen[seen.length - 1]).toContain('/api/preview/');
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it('imported / non-address id falls through to the thumbnail URL', () => {
    const previewBlob = vi.fn();
    const svc = setup({ previewBlob, thumbBlob: vi.fn() }, { backend: 'hosted' });

    svc.cacheThumbnailUrl('imported-1' as AssetId, 'blob:thumb-url');

    const seen: (string | undefined)[] = [];
    svc.subscribePreviewUrl('imported-1' as AssetId, (url) => seen.push(url));

    expect(previewBlob).not.toHaveBeenCalled();
    expect(seen).toEqual(['blob:thumb-url']);
  });

  it('Hosted slug:relPath id resolves via HostedPreviewResolver.resolve, wired to bytesForAsset', async () => {
    const extractedBlob = new Blob(['jpeg'], { type: 'image/jpeg' });
    const resolve = vi.fn(
      async (_id: AssetId, _address: unknown, getBytes: (id: AssetId) => Promise<Uint8Array>) => {
        // Exercise the passed-in getBytes callback — it must forward to
        // LibraryCache's own byte cache (primeBytes below), not re-implement
        // byte reading itself.
        const bytes = await getBytes('lib:2026/a.dng' as AssetId);
        expect(Array.from(bytes)).toEqual([9, 9, 9]);
        return extractedBlob;
      },
    );
    const svc = setup({}, { backend: 'hosted' }, { resolve });
    svc.primeBytes('lib:2026/a.dng' as AssetId, new Uint8Array([9, 9, 9]));

    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-hosted-preview');
    try {
      const seen: (string | undefined)[] = [];
      svc.subscribePreviewUrl('lib:2026/a.dng' as AssetId, (url) => seen.push(url));
      await settle();

      expect(resolve).toHaveBeenCalledWith(
        'lib:2026/a.dng',
        { slug: 'lib', relPath: '2026/a.dng' },
        expect.any(Function),
      );
      expect(seen[seen.length - 1]).toBe('blob:mock-hosted-preview');
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it('Hosted resolver returning null leaves the preview channel uncached (thumb stays the shown image)', async () => {
    const resolve = vi.fn(async () => null);
    const svc = setup({}, { backend: 'hosted' }, { resolve });

    const seen: (string | undefined)[] = [];
    svc.subscribePreviewUrl('lib:2026/a.jpg' as AssetId, (url) => seen.push(url));
    await settle();

    expect(resolve).toHaveBeenCalled();
    expect(seen).toEqual([undefined]);
  });
});
