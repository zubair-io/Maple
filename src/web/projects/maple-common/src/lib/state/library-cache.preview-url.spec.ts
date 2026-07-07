// LibraryCache — subscribePreviewUrl: best display-still per backend.
//
// Mirrors subscribeThumbUrl (see library-cache.service.spec.ts) except the
// Self-Hosted M2 slug:relPath branch resolves via LibrarySource.previewBlob
// (/api/preview/:slug/*) instead of thumbBlob (/api/thumb/:slug/*). Every
// other branch — Hosted-web, imported, legacy fs:<absPath> ids — falls
// through to the thumbnail URL for this slice; the display-preview data
// layer upgrades those paths later.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';

import { LibraryCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import type { AssetId } from '../models/asset';

// subscribePreviewUrl's Self-Hosted branch is fire-and-forget (kicked off via
// .finally); let the previewBlob promise + microtasks settle before asserting.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(
  libSource: Record<string, unknown>,
  store: Record<string, unknown> = { backend: 'self-hosted' },
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
});
