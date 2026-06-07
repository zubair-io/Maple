// LibraryCache — thumbnail object-URL lifecycle.
//
// Guards the leak fix: clearAll() must REVOKE the cached thumbnail blob URLs
// (not just orphan the map) so their bytes are freed, and must clear the
// FilesystemBrowseService thumb cache too so a folder switch reclaims that
// memory instead of holding it until sign-out.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

import { LibraryCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import type { AssetId } from '../models/asset';

describe('LibraryCache — thumbnail object-URL lifecycle', () => {
  let svc: LibraryCache;
  let clearThumbCache: ReturnType<typeof vi.fn>;
  let revoke: Mock<(url: string) => void>;
  // jsdom doesn't implement URL.revokeObjectURL, so vi.spyOn would throw on a
  // non-existent property. Install the fn by assignment (the repo's pattern for
  // absent globals — see image-canvas.component.spec.ts's createImageBitmap)
  // and restore the original (undefined under jsdom, defined in a real browser).
  let originalRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    clearThumbCache = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        LibraryCache,
        { provide: LibraryStore, useValue: {} },
        { provide: BunApiBackendService, useValue: {} },
        { provide: FilesystemBrowseService, useValue: { clearThumbCache } },
        { provide: MapleCacheService, useValue: {} },
        { provide: RawPipelineService, useValue: {} },
      ],
    });
    svc = TestBed.inject(LibraryCache);
    originalRevoke = URL.revokeObjectURL;
    revoke = vi.fn<(url: string) => void>();
    URL.revokeObjectURL = revoke;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevoke;
  });

  it('clearAll revokes cached thumbnail blob URLs and empties the map', () => {
    svc.cacheThumbnailUrl('a' as AssetId, 'blob:fake-1');
    svc.cacheThumbnailUrl('b' as AssetId, 'blob:fake-2');
    expect(svc.thumbnailUrls().size).toBe(2);

    svc.clearAll();

    expect(revoke).toHaveBeenCalledWith('blob:fake-1');
    expect(revoke).toHaveBeenCalledWith('blob:fake-2');
    expect(svc.thumbnailUrls().size).toBe(0);
  });

  it('clearAll also clears the FilesystemBrowseService thumb cache', () => {
    svc.cacheThumbnailUrl('a' as AssetId, 'blob:fake-1');
    svc.clearAll();
    expect(clearThumbCache).toHaveBeenCalledTimes(1);
  });

  it('clearAll never revokes a non-blob URL', () => {
    svc.cacheThumbnailUrl('c' as AssetId, 'https://cdn.example/x.jpg');
    svc.clearAll();
    expect(revoke).not.toHaveBeenCalledWith('https://cdn.example/x.jpg');
  });
});
