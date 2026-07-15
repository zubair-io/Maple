// LibraryCache — subscribePreviewUrl: best display-still per backend.
//
// Three routes (see LibraryCache._previewLoader):
//   - Self-Hosted slug:relPath id → LibrarySource.previewBlob (/api/preview).
//   - Hosted (FS-Access) id → HostedPreviewResolver.resolve (embedded-preview
//     extraction + .maple/previews AVIF cache, #2010).
//   - Self-Hosted legacy fs: id → falls through to the thumbnail URL.
//
// The thumbnail-as-base-layer fallback for a Hosted RAW that has no extractable
// preview now lives in the PreviewShell template (it subscribes to thumb + full
// separately), NOT in subscribePreviewUrl — so a Hosted miss yields `undefined`
// here rather than echoing the thumb URL.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';

import { LibraryCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { HostedPreviewResolver } from './hosted-preview-resolver.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import type { AssetId } from '../models/asset';

// subscribePreviewUrl's loader is fire-and-forget (kicked off via .ensure);
// let the loader promise + microtasks settle before asserting.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(
  libSource: Record<string, unknown>,
  store: Record<string, unknown> = { backend: 'self-hosted' },
  hostedPreview: { resolve: ReturnType<typeof vi.fn> } = { resolve: vi.fn(async () => null) },
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
      { provide: HostedPreviewResolver, useValue: hostedPreview },
      { provide: LIBRARY_SOURCE, useValue: libSource },
    ],
  });
  return { svc: TestBed.inject(LibraryCache), hostedPreview };
}

describe('LibraryCache.subscribePreviewUrl', () => {
  it('Self-Hosted slug:relPath id resolves via LibrarySource.previewBlob (/api/preview)', async () => {
    const previewBlob = vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' }));
    const thumbBlob = vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' }));
    const { svc, hostedPreview } = setup({ previewBlob, thumbBlob });

    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-preview-url-/api/preview/');
    try {
      const seen: (string | undefined)[] = [];
      svc.subscribePreviewUrl('lib:2026/a.jpg' as AssetId, (url) => seen.push(url));
      await settle();

      expect(previewBlob).toHaveBeenCalledWith({ slug: 'lib', relPath: '2026/a.jpg' });
      expect(thumbBlob).not.toHaveBeenCalled();
      expect(hostedPreview.resolve).not.toHaveBeenCalled();
      expect(seen[seen.length - 1]).toContain('/api/preview/');
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it('Hosted (FS-Access) id routes through HostedPreviewResolver and shows its blob', async () => {
    const resolve = vi.fn(async () => new Blob(['avif'], { type: 'image/avif' }));
    const { svc } = setup({ previewBlob: vi.fn() }, { backend: 'hosted' }, { resolve });

    const originalCreate = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:hosted-embedded-preview');
    try {
      const seen: (string | undefined)[] = [];
      svc.subscribePreviewUrl('lib:2026/a.dng' as AssetId, (url) => seen.push(url));
      await settle();

      // Called with the id and a getBytes callback (LibraryCache.bytesForAsset).
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith('lib:2026/a.dng', expect.any(Function));
      expect(seen[seen.length - 1]).toBe('blob:hosted-embedded-preview');
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it('Hosted miss (resolver returns null) yields undefined, NOT the thumb URL', async () => {
    const resolve = vi.fn(async () => null);
    const { svc } = setup({ previewBlob: vi.fn() }, { backend: 'hosted' }, { resolve });

    // A thumb is cached, but subscribePreviewUrl no longer echoes it — the
    // PreviewShell layers the thumbnail separately.
    svc.cacheThumbnailUrl('lib:2026/nope.dng' as AssetId, 'blob:thumb-url');

    const seen: (string | undefined)[] = [];
    svc.subscribePreviewUrl('lib:2026/nope.dng' as AssetId, (url) => seen.push(url));
    await settle();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(seen[seen.length - 1]).toBeUndefined();
    expect(seen).not.toContain('blob:thumb-url');
  });

  it('Self-Hosted legacy fs: id falls through to the thumbnail URL', () => {
    const previewBlob = vi.fn();
    const resolve = vi.fn();
    const { svc } = setup(
      { previewBlob, thumbBlob: vi.fn() },
      { backend: 'self-hosted' },
      { resolve },
    );

    svc.cacheThumbnailUrl('fs:/abs/path/a.jpg' as AssetId, 'blob:thumb-url');

    const seen: (string | undefined)[] = [];
    svc.subscribePreviewUrl('fs:/abs/path/a.jpg' as AssetId, (url) => seen.push(url));

    expect(previewBlob).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(seen).toEqual(['blob:thumb-url']);
  });
});
