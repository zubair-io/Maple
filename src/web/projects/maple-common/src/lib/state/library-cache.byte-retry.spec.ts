// #2407: transient byte-fetch failures get a bounded retry instead of
// surfacing as a permanent blank canvas on the first blip. Covers the retry
// helper directly and its integration into LibraryCache.bytesForAsset's M2
// (slug:relPath) network branch.

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { isTransientFetchError, withTransientRetry } from './library-cache.byte-retry';
import { LibraryCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { LibrarySelection } from './library-selection.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import type { AssetId } from '../models/asset';

function httpError(status: number): { status: number; url: string } {
  return { status, url: '/api/image/lib/2026/a.dng' };
}

describe('isTransientFetchError', () => {
  it('is true for status 0 (network/CORS failure)', () => {
    expect(isTransientFetchError(httpError(0))).toBe(true);
  });

  it('is true for 429 and every 5xx', () => {
    expect(isTransientFetchError(httpError(429))).toBe(true);
    expect(isTransientFetchError(httpError(500))).toBe(true);
    expect(isTransientFetchError(httpError(503))).toBe(true);
    expect(isTransientFetchError(httpError(599))).toBe(true);
  });

  it('is false for 4xx (404/403/401) and for a statusless error', () => {
    expect(isTransientFetchError(httpError(404))).toBe(false);
    expect(isTransientFetchError(httpError(403))).toBe(false);
    expect(isTransientFetchError(httpError(401))).toBe(false);
    expect(isTransientFetchError(new Error('boom'))).toBe(false);
  });
});

describe('withTransientRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a transient failure and resolves once the attempt succeeds', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce('bytes');

    const promise = withTransientRetry(attempt);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('bytes');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('rejects immediately on a non-transient failure, no retry', async () => {
    const attempt = vi.fn().mockRejectedValue(httpError(404));

    await expect(withTransientRetry(attempt)).rejects.toEqual(httpError(404));
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up after the third attempt and rejects with the last error', async () => {
    const attempt = vi.fn().mockRejectedValue(httpError(0));

    const promise = withTransientRetry(attempt);
    const assertion = expect(promise).rejects.toEqual(httpError(0));
    await vi.runAllTimersAsync();
    await assertion;

    expect(attempt).toHaveBeenCalledTimes(3);
  });
});

describe('LibraryCache — M2 byte fetch retry on transient failure (#2407)', () => {
  function setup(imageBlob: ReturnType<typeof vi.fn>) {
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
          },
        },
        { provide: LibrarySelection, useValue: { selectedSourceId: signal('') } },
        { provide: BunApiBackendService, useValue: {} },
        { provide: FilesystemBrowseService, useValue: {} },
        { provide: MapleCacheService, useValue: {} },
        { provide: RawPipelineService, useValue: {} },
        { provide: LIBRARY_SOURCE, useValue: { imageBlob } },
      ],
    });
    return TestBed.inject(LibraryCache);
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries after a transient (503) imageBlob failure and resolves', async () => {
    const payload = new Uint8Array([7, 7, 7]);
    const imageBlob = vi
      .fn()
      .mockRejectedValueOnce({ status: 503, url: '/api/image/lib/2026/a.dng' })
      .mockResolvedValueOnce(new Blob([payload], { type: 'application/octet-stream' }));
    const svc = setup(imageBlob);

    const bytesPromise = svc.bytesForAsset('lib:2026/a.dng' as AssetId);
    await vi.runAllTimersAsync();
    const bytes = await bytesPromise;

    expect(imageBlob).toHaveBeenCalledTimes(2);
    expect(Array.from(bytes)).toEqual([7, 7, 7]);
  });

  it('fails immediately with no retry on a non-transient (404) imageBlob failure', async () => {
    const imageBlob = vi.fn().mockRejectedValue({ status: 404, url: '/api/image/lib/2026/a.dng' });
    const svc = setup(imageBlob);

    await expect(svc.bytesForAsset('lib:2026/a.dng' as AssetId)).rejects.toEqual({
      status: 404,
      url: '/api/image/lib/2026/a.dng',
    });
    expect(imageBlob).toHaveBeenCalledTimes(1);
  });
});
