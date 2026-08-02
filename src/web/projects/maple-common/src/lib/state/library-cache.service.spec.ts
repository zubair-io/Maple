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
import { signal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

import { LibraryCache } from './library-cache.service';
import { ThumbLruCache } from './lru-cache';
import { LibraryStore } from './library-store.service';
import { LibrarySelection } from './library-selection.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import type { Asset, AssetId } from '../models/asset';

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
        { provide: LibrarySelection, useValue: { selectedSourceId: signal('') } },
        { provide: BunApiBackendService, useValue: {} },
        { provide: FilesystemBrowseService, useValue: { clearThumbCache } },
        { provide: MapleCacheService, useValue: {} },
        { provide: RawPipelineService, useValue: {} },
        { provide: LIBRARY_SOURCE, useValue: { thumbBlob: vi.fn(), previewBlob: vi.fn() } },
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

describe('LibraryCache — M2 slug:relPath thumbnail path', () => {
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:m2-thumb');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  // _loadThumbInternal is fire-and-forget (kicked off via .finally); let the
  // thumbBlob promise + microtasks settle before asserting.
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function setup(libSource: Record<string, unknown>, fsBrowse: Record<string, unknown> = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LibraryCache,
        { provide: LibraryStore, useValue: { backend: 'self-hosted' } },
        { provide: LibrarySelection, useValue: { selectedSourceId: signal('') } },
        { provide: BunApiBackendService, useValue: {} },
        { provide: FilesystemBrowseService, useValue: fsBrowse },
        { provide: MapleCacheService, useValue: {} },
        { provide: RawPipelineService, useValue: {} },
        { provide: LIBRARY_SOURCE, useValue: libSource },
      ],
    });
    return TestBed.inject(LibraryCache);
  }

  it('fetches a slug:relPath thumb via LibrarySource.thumbBlob and caches the object URL', async () => {
    const thumbBlob = vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' }));
    const svc = setup({ thumbBlob });

    svc.ensureThumbnailUrl({ id: 'lib:2026/a.jpg', filename: 'a.jpg' } as unknown as Asset);
    await settle();

    expect(thumbBlob).toHaveBeenCalledWith({ slug: 'lib', relPath: '2026/a.jpg' });
    expect(svc.thumbnailUrlFor('lib:2026/a.jpg' as AssetId)).toBe('blob:m2-thumb');
  });

  it('does NOT route a legacy fs:<absPath> id through LibrarySource (regression)', async () => {
    const thumbBlob = vi.fn(async () => new Blob());
    const getThumbBlobUrl = vi.fn(async () => 'blob:fs');
    const svc = setup({ thumbBlob }, { getThumbBlobUrl });

    svc.ensureThumbnailUrl({
      id: 'fs:/srv/a.jpg',
      filename: 'a.jpg',
      absPath: '/srv/a.jpg',
    } as unknown as Asset);
    await settle();

    // `fs:` ids contain ':' but must use the absPath FS-walk branch, not LibrarySource.
    expect(thumbBlob).not.toHaveBeenCalled();
    expect(getThumbBlobUrl).toHaveBeenCalled();
  });

  it('limits concurrent network thumbnail loads to 4', async () => {
    const resolvePromises: ((b: Blob) => void)[] = [];
    const thumbBlob = vi.fn(
      () =>
        new Promise<Blob>((r) => {
          resolvePromises.push(r);
        }),
    );
    const svc = setup({ thumbBlob });

    // Trigger 6 thumbnail requests
    for (let i = 0; i < 6; i++) {
      svc.ensureThumbnailUrl({
        id: `lib:2026/img_${i}.jpg`,
        filename: `img_${i}.jpg`,
      } as unknown as Asset);
    }

    // Settle microtasks so enqueuing and processing starts
    await settle();

    // Only 4 should be active concurrently
    expect(thumbBlob).toHaveBeenCalledTimes(4);

    // Resolve one of them
    resolvePromises[0](new Blob(['x'], { type: 'image/jpeg' }));
    await settle();

    // The next one in queue should start
    expect(thumbBlob).toHaveBeenCalledTimes(5);

    // Resolve the rest
    for (let i = 1; i < resolvePromises.length; i++) {
      resolvePromises[i](new Blob(['x'], { type: 'image/jpeg' }));
    }
    await settle();
    expect(thumbBlob).toHaveBeenCalledTimes(6);
  });

  it('bypasses the concurrency queue for Hosted cache hits', async () => {
    const readThumb = vi.fn(async () => new Blob(['x'], { type: 'image/jpeg' }));
    const thumbBlob = vi.fn(async () => new Blob());
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LibraryCache,
        {
          provide: LibraryStore,
          useValue: {
            backend: 'hosted',
            currentFolder: () => ({ write: true }),
            updateAssetDimensions: vi.fn(),
          },
        },
        { provide: BunApiBackendService, useValue: {} },
        { provide: FilesystemBrowseService, useValue: {} },
        { provide: MapleCacheService, useValue: { readThumb } },
        { provide: RawPipelineService, useValue: {} },
        { provide: LIBRARY_SOURCE, useValue: { thumbBlob } },
      ],
    });
    const svc = TestBed.inject(LibraryCache);

    // Trigger 6 cache-hit thumbnail requests
    for (let i = 0; i < 6; i++) {
      svc.ensureThumbnailUrl({
        id: `lib:2026/img_${i}.jpg`,
        filename: `img_${i}.jpg`,
      } as unknown as Asset);
    }

    // Wait for all 6 cache-hit thumbnail loads to complete (which is async due to Web Crypto / SHA key derivation).
    const start = Date.now();
    while (svc.thumbnailUrls().size < 6 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Since they are cache hits, they should all complete immediately without enqueuing in the network queue.
    expect(readThumb).toHaveBeenCalledTimes(6);
    expect(thumbBlob).not.toHaveBeenCalled();
    for (let i = 0; i < 6; i++) {
      expect(svc.thumbnailUrlFor(`lib:2026/img_${i}.jpg` as AssetId)).toBe('blob:m2-thumb');
    }
  });
});

describe('LibraryCache — M2 slug:relPath byte path (editor cold-open)', () => {
  function setup(libSource: Record<string, unknown>, store: Record<string, unknown> = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LibraryCache,
        {
          provide: LibraryStore,
          useValue: {
            backend: 'self-hosted',
            assetAbsPaths: new Map<string, string>(),
            apiAssetIds: new Map<string, string>(),
            findAsset: () => undefined,
            ...store,
          },
        },
        { provide: LibrarySelection, useValue: { selectedSourceId: signal('') } },
        { provide: BunApiBackendService, useValue: {} },
        { provide: FilesystemBrowseService, useValue: {} },
        { provide: MapleCacheService, useValue: {} },
        { provide: RawPipelineService, useValue: {} },
        { provide: LIBRARY_SOURCE, useValue: libSource },
      ],
    });
    return TestBed.inject(LibraryCache);
  }

  it('reads a slug:relPath asset via LibrarySource.imageBlob (not the apiId branch)', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const imageBlob = vi.fn(async () => new Blob([payload], { type: 'application/octet-stream' }));
    const svc = setup({ imageBlob });

    const bytes = await svc.bytesForAsset('lib:2026/IMG_001.dng' as AssetId);

    // Called with the parsed address + a progress callback (drives the editor's
    // open-progress overlay, same as the apiId/fsAbsPath byte paths).
    expect(imageBlob).toHaveBeenCalledWith(
      { slug: 'lib', relPath: '2026/IMG_001.dng' },
      expect.any(Function),
    );
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('does NOT route a legacy fs:<absPath> id through LibrarySource.imageBlob (regression)', async () => {
    const imageBlob = vi.fn(async () => new Blob());
    const getRawBytes = vi.fn(async () => new Uint8Array([9, 9]).buffer);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LibraryCache,
        {
          provide: LibraryStore,
          useValue: {
            backend: 'self-hosted',
            assetAbsPaths: new Map<string, string>([['fs:/srv/a.dng', '/srv/a.dng']]),
            apiAssetIds: new Map<string, string>(),
            findAsset: () => undefined,
          },
        },
        { provide: LibrarySelection, useValue: { selectedSourceId: signal('') } },
        { provide: BunApiBackendService, useValue: {} },
        { provide: FilesystemBrowseService, useValue: { getRawBytes } },
        { provide: MapleCacheService, useValue: {} },
        { provide: RawPipelineService, useValue: {} },
        { provide: LIBRARY_SOURCE, useValue: { imageBlob } },
      ],
    });
    const svc = TestBed.inject(LibraryCache);

    const bytes = await svc.bytesForAsset('fs:/srv/a.dng' as AssetId);

    // `fs:` ids contain ':' but must use the assetAbsPaths FS-walk branch.
    expect(imageBlob).not.toHaveBeenCalled();
    expect(getRawBytes).toHaveBeenCalledWith('/srv/a.dng', expect.any(Function));
    expect(Array.from(bytes)).toEqual([9, 9]);
  });
});

describe('LibraryCache — thumbnail subscriptions (component-owned signals)', () => {
  let svc: LibraryCache;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LibraryCache,
        { provide: LibraryStore, useValue: {} },
        { provide: LibrarySelection, useValue: { selectedSourceId: signal('') } },
        { provide: BunApiBackendService, useValue: {} },
        { provide: FilesystemBrowseService, useValue: {} },
        { provide: MapleCacheService, useValue: {} },
        { provide: RawPipelineService, useValue: {} },
        { provide: LIBRARY_SOURCE, useValue: { thumbBlob: vi.fn(), previewBlob: vi.fn() } },
      ],
    });
    svc = TestBed.inject(LibraryCache);
  });

  // Reactivity now lives in subscribeThumbUrl: a tile registers its setter and
  // the cache pushes the URL on load and on eviction. The per-tile SIGNAL lives
  // in the COMPONENT (asset-thumb / library-cell), so it dies with the tile —
  // bounding the live count to what the virtual scroller keeps mounted and
  // removing the central signal map that previously leaked (#1363/#1359).
  const subscriberCount = (s: LibraryCache): number =>
    (s as unknown as { thumbSubscribers: Map<unknown, unknown> }).thumbSubscribers.size;

  it('subscribeThumbUrl pushes undefined immediately, then the URL when it lands', () => {
    const id = 'lib:2026/a.jpg' as AssetId;
    const seen: (string | undefined)[] = [];
    svc.subscribeThumbUrl(id, (url) => seen.push(url));
    expect(seen).toEqual([undefined]); // immediate push — nothing cached yet

    svc.cacheThumbnailUrl(id, 'blob:loaded');
    expect(seen).toEqual([undefined, 'blob:loaded']); // pushed again on load
  });

  it('subscribeThumbUrl pushes the cached URL immediately for a warm id', () => {
    const id = 'lib:warm.jpg' as AssetId;
    svc.cacheThumbnailUrl(id, 'blob:warm');
    const seen: (string | undefined)[] = [];
    svc.subscribeThumbUrl(id, (url) => seen.push(url));
    expect(seen).toEqual(['blob:warm']);
  });

  it('granular: caching one id notifies only that id’s subscribers', () => {
    const idA = 'lib:a.jpg' as AssetId;
    const idB = 'lib:b.jpg' as AssetId;
    let countA = 0;
    let countB = 0;
    svc.subscribeThumbUrl(idA, () => countA++);
    svc.subscribeThumbUrl(idB, () => countB++);
    expect(countA).toBe(1); // immediate pushes
    expect(countB).toBe(1);

    svc.cacheThumbnailUrl(idA, 'blob:a');
    expect(countA).toBe(2); // only A fired again...
    expect(countB).toBe(1); // ...B untouched (no O(N) fan-out)
  });

  it('unsubscribe stops callbacks and drops the id — the registry stays bounded', () => {
    // The old design leaked one signal per queried id; here subscribing then
    // unsubscribing 500 never-cached ids leaves the registry empty.
    for (let i = 0; i < 500; i++) {
      svc.subscribeThumbUrl(`lib:o/${i}.jpg` as AssetId, () => {})();
    }
    expect(subscriberCount(svc)).toBe(0);

    let count = 0;
    const unsub = svc.subscribeThumbUrl('lib:x.jpg' as AssetId, () => count++);
    expect(subscriberCount(svc)).toBe(1); // exactly its own id
    unsub();
    expect(subscriberCount(svc)).toBe(0); // removed on unsubscribe

    svc.cacheThumbnailUrl('lib:x.jpg' as AssetId, 'blob:x');
    expect(count).toBe(1); // only the immediate push — none after unsub
  });

  it('pushes undefined to a subscriber when its URL is evicted from the LRU', () => {
    const evicted = 'lib:evicted.jpg' as AssetId;
    const seen: (string | undefined)[] = [];
    svc.subscribeThumbUrl(evicted, (url) => seen.push(url));
    svc.cacheThumbnailUrl(evicted, 'blob:evicted'); // cached (oldest)
    // Overflow the 500-entry LRU so the oldest entry (evicted) is dropped.
    for (let i = 0; i < 500; i++) {
      svc.cacheThumbnailUrl(`lib:fill/${i}.jpg` as AssetId, `blob:${i}`);
    }
    // undefined (subscribe), blob:evicted (load), undefined (eviction clears tile).
    expect(seen).toEqual([undefined, 'blob:evicted', undefined]);
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

  it('onEvict callback is called exactly once with the evicted id when capacity is exceeded', () => {
    const onEvict = vi.fn<(id: string) => void>();
    const lru = new ThumbLruCache(2);
    lru.set('a' as AssetId, 'blob:a', onEvict);
    lru.set('b' as AssetId, 'blob:b', onEvict);
    // Third set evicts 'a' (oldest).
    lru.set('c' as AssetId, 'blob:c', onEvict);
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict).toHaveBeenCalledWith('a');
  });
});
