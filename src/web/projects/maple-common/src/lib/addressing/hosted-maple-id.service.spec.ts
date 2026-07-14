// hosted-maple-id.service.spec.ts — proves the orchestration logic: EXIF
// capture-date presence selects primary vs. fallback form, the primary form
// hashes exactly the bounded 64 KB head, and the cache is consulted/written
// correctly. `exifr`'s own EXIF-parsing correctness and `maple-id-cache.ts`'s
// own staleness logic are proven in their own specs — this spec fakes both
// (`exifr` via `vi.mock` — a package import, not a relative one; the cache
// via `TestBed.overrideProvider` on `MapleIdCacheService`, since Angular's
// unit-test runner rejects `vi.mock()` on relative-path imports — "Please
// use Angular TestBed for mocking dependencies") so it stays focused on
// `HostedMapleIdService`'s wiring between them.

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import exifr from 'exifr';
import { primary, SHA1_HEAD_BYTES } from './maple-id';
import { MapleIdCacheService } from './maple-id-cache';
import { HostedMapleIdService } from './hosted-maple-id.service';
import { MapleIdFallbackHasherService } from './maple-id-fallback-hasher.service';

vi.mock('exifr', () => ({ default: { parse: vi.fn() } }));

// Return type pinned to `Uint8Array<ArrayBuffer>` (not the wider
// `ArrayBufferLike`, which also covers `SharedArrayBuffer`) so these bytes
// are directly usable as a `BlobPart` in `new File([bytes], ...)` below.
function bytesFromPattern(len: number, seedMul: number, seedAdd: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * seedMul + seedAdd) & 0xff;
  return out;
}

describe('HostedMapleIdService', () => {
  let fakeFallbackHasher: { hashFallback: ReturnType<typeof vi.fn> };
  let fakeIdCache: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    fakeFallbackHasher = { hashFallback: vi.fn() };
    // Default: always a cache miss, so `computeMapleId`-focused tests below
    // (which call `computeMapleId` directly, bypassing the cache) aren't
    // affected either way — only the "cache integration" describe block
    // overrides this per-test.
    fakeIdCache = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: MapleIdFallbackHasherService, useValue: fakeFallbackHasher },
        { provide: MapleIdCacheService, useValue: fakeIdCache },
      ],
    });
  });

  describe('computeMapleId', () => {
    it('uses the primary form when EXIF has a DateTimeOriginal', async () => {
      vi.mocked(exifr.parse).mockResolvedValue({ DateTimeOriginal: '2026-07-12T10:30:00.000Z' });
      const service = TestBed.inject(HostedMapleIdService);
      const bytes = bytesFromPattern(500, 7, 3);
      const file = new File([bytes], 'IMG_0001.dng', { lastModified: 1_700_000_000_000 });

      const id = await service.computeMapleId(file);

      expect(id.kind).toBe('primary');
      const expected = primary(bytes, '2026-07-12T10:30:00.000Z', null, null);
      expect(id.hex).toBe(expected.hex);
      expect(fakeFallbackHasher.hashFallback).not.toHaveBeenCalled();
    });

    it('only ever hashes the bounded 64 KB head for the primary form, not the whole file', async () => {
      vi.mocked(exifr.parse).mockResolvedValue({ DateTimeOriginal: '2020-01-01T00:00:00.000Z' });
      const service = TestBed.inject(HostedMapleIdService);
      // A file bigger than SHA1_HEAD_BYTES — the head bytes and the full
      // bytes share the same prefix (deterministic pattern), so comparing
      // against `primary()` over ONLY the head proves the service didn't
      // accidentally read (or hash) more than the head.
      const fullBytes = bytesFromPattern(SHA1_HEAD_BYTES + 5000, 11, 2);
      const headOnly = fullBytes.subarray(0, SHA1_HEAD_BYTES);
      const file = new File([fullBytes], 'IMG_0002.dng');

      const id = await service.computeMapleId(file);

      const expected = primary(headOnly, '2020-01-01T00:00:00.000Z', null, null);
      expect(id.hex).toBe(expected.hex);
    });

    it('never passes a camera serial or shutter count (server always sends null for both)', async () => {
      vi.mocked(exifr.parse).mockResolvedValue({ DateTimeOriginal: '2026-01-01T00:00:00.000Z' });
      const service = TestBed.inject(HostedMapleIdService);
      const bytes = bytesFromPattern(200, 5, 5);
      const file = new File([bytes], 'IMG_0003.dng');

      const id = await service.computeMapleId(file);

      // primary(bytes, capturedAt, null, null) is what the server's exif
      // stage always calls too (see hosted-maple-id.service.ts's module doc).
      const expected = primary(bytes, '2026-01-01T00:00:00.000Z', null, null);
      expect(id.hex).toBe(expected.hex);
    });

    it('uses the fallback form when EXIF has neither DateTimeOriginal nor CreateDate', async () => {
      vi.mocked(exifr.parse).mockResolvedValue({});
      fakeFallbackHasher.hashFallback.mockResolvedValue('02aabbccddeeff001122334455667788');
      const service = TestBed.inject(HostedMapleIdService);
      const file = new File([new Uint8Array([1, 2, 3])], 'screen-recording.mov');

      const id = await service.computeMapleId(file);

      expect(id.kind).toBe('fallback');
      expect(id.hex).toBe('02aabbccddeeff001122334455667788');
      expect(fakeFallbackHasher.hashFallback).toHaveBeenCalledWith(file);
    });

    it('treats an exifr parse failure (unsupported/corrupt file) as "no EXIF" and falls back', async () => {
      vi.mocked(exifr.parse).mockRejectedValue(new Error('Unknown file format'));
      fakeFallbackHasher.hashFallback.mockResolvedValue('02ffffffffffffffffffffffffffffff');
      const service = TestBed.inject(HostedMapleIdService);
      const file = new File([new Uint8Array([9, 9, 9])], 'weird.bin');

      const id = await service.computeMapleId(file);

      expect(id.kind).toBe('fallback');
      expect(fakeFallbackHasher.hashFallback).toHaveBeenCalled();
    });
  });

  describe('getOrComputeMapleId — cache integration', () => {
    it('returns the cached id without computing when size/mtime match', async () => {
      fakeIdCache.get.mockResolvedValue('01cachedcachedcachedcachedcached');
      const service = TestBed.inject(HostedMapleIdService);
      const file = new File([new Uint8Array([1, 2, 3])], 'IMG_0004.dng', {
        lastModified: 1_700_000_000_000,
      });

      const hex = await service.getOrComputeMapleId('lib:2026/IMG_0004.dng', file);

      expect(hex).toBe('01cachedcachedcachedcachedcached');
      expect(fakeIdCache.get).toHaveBeenCalledWith(
        'lib:2026/IMG_0004.dng',
        file.size,
        file.lastModified,
      );
      expect(exifr.parse).not.toHaveBeenCalled();
      expect(fakeIdCache.put).not.toHaveBeenCalled();
    });

    it('computes and caches on a miss', async () => {
      fakeIdCache.get.mockResolvedValue(null);
      vi.mocked(exifr.parse).mockResolvedValue({ DateTimeOriginal: '2026-03-03T03:03:03.000Z' });
      const service = TestBed.inject(HostedMapleIdService);
      const bytes = bytesFromPattern(64, 2, 2);
      const file = new File([bytes], 'IMG_0005.dng', { lastModified: 1_700_000_000_500 });

      const hex = await service.getOrComputeMapleId('lib:2026/IMG_0005.dng', file);

      const expected = primary(bytes, '2026-03-03T03:03:03.000Z', null, null).hex;
      expect(hex).toBe(expected);
      expect(fakeIdCache.put).toHaveBeenCalledWith(
        'lib:2026/IMG_0005.dng',
        file.size,
        file.lastModified,
        expected,
      );
    });
  });
});
