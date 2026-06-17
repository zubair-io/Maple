// LibraryCache — thumbnail object-URL lifecycle.
//
// Guards the leak fix: clearAll() must REVOKE the cached thumbnail blob URLs
// (not just orphan the map) so their bytes are freed, and must clear the
// FilesystemBrowseService thumb cache too so a folder switch reclaims that
// memory instead of holding it until sign-out.
//
// Also tests ThumbLruCache: the bounded LRU that backs thumbnailUrls so
// folder-switch no longer wipes the entire cache — old entries evict
// gradually as new thumbnails arrive (M2, #1327).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

import { LibraryCache, ThumbLruCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
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
        { provide: LIBRARY_SOURCE, useValue: {} },
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

describe('ThumbLruCache — bounded LRU for thumbnail blob URLs', () => {
  let revoke: Mock<(url: string) => void>;
  let originalRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    originalRevoke = URL.revokeObjectURL;
    revoke = vi.fn<(url: string) => void>();
    URL.revokeObjectURL = revoke;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevoke;
  });

  it('stores entries up to capacity without eviction', () => {
    const lru = new ThumbLruCache(3);
    lru.set('a' as AssetId, 'blob:a');
    lru.set('b' as AssetId, 'blob:b');
    lru.set('c' as AssetId, 'blob:c');
    expect(lru.size).toBe(3);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('evicts the oldest entry and revokes its blob URL when capacity is exceeded', () => {
    const lru = new ThumbLruCache(2);
    lru.set('a' as AssetId, 'blob:a');
    lru.set('b' as AssetId, 'blob:b');
    lru.set('c' as AssetId, 'blob:c'); // evicts 'a'
    expect(revoke).toHaveBeenCalledWith('blob:a');
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(lru.size).toBe(2);
    expect(lru.get('a' as AssetId)).toBeUndefined();
    expect(lru.get('b' as AssetId)).toBe('blob:b');
    expect(lru.get('c' as AssetId)).toBe('blob:c');
  });

  it('does not revoke non-blob URLs on eviction', () => {
    const lru = new ThumbLruCache(1);
    lru.set('a' as AssetId, 'https://cdn.example/a.jpg');
    lru.set('b' as AssetId, 'blob:b'); // evicts 'a' but 'a' is not blob:
    expect(revoke).not.toHaveBeenCalled();
  });

  it('get refreshes recency so the accessed entry is not the next evicted', () => {
    const lru = new ThumbLruCache(2);
    lru.set('a' as AssetId, 'blob:a');
    lru.set('b' as AssetId, 'blob:b');
    lru.get('a' as AssetId); // refresh 'a' → 'b' is now oldest
    lru.set('c' as AssetId, 'blob:c'); // evicts 'b'
    expect(revoke).toHaveBeenCalledWith('blob:b');
    expect(lru.get('a' as AssetId)).toBe('blob:a');
    expect(lru.get('b' as AssetId)).toBeUndefined();
  });

  it('clearAll revokes all blob URLs and empties the cache', () => {
    const lru = new ThumbLruCache(10);
    lru.set('a' as AssetId, 'blob:a');
    lru.set('b' as AssetId, 'blob:b');
    lru.set('c' as AssetId, 'https://cdn.example/c.jpg');
    lru.clearAll();
    expect(revoke).toHaveBeenCalledWith('blob:a');
    expect(revoke).toHaveBeenCalledWith('blob:b');
    expect(revoke).not.toHaveBeenCalledWith('https://cdn.example/c.jpg');
    expect(lru.size).toBe(0);
  });
});
