// HostedPreviewResolver — Hosted-mode embedded-RAW-preview resolution
// (#2010, epic #1993): directory+filename cache-keying, the canonical
// `<dir>/.maple/previews/<filename>.<actual-format>` read/write-through cache,
// the AVIF-or-native-JPEG write rule, the RAW/non-RAW split, and graceful
// degradation on any failure (never throws to the caller).
//
// The extracted JPEG is already the right preview size and is persisted
// directly; no redundant canvas transcode is part of this hot cache-miss path.

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';

import { HostedPreviewResolver } from './hosted-preview-resolver.service';
import { LibraryStore } from './library-store.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { EmbeddedPreviewService } from '../raw-pipeline/embedded-preview.service';
import type { Asset, AssetId } from '../models/asset';

// _persistAvif is fire-and-forget (kicked off via `void`); let its promise +
// microtasks settle before asserting that nothing was written.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(
  store: Record<string, unknown>,
  mapleCache: Record<string, unknown> = {},
  previewExtractor: Record<string, unknown> = {},
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      HostedPreviewResolver,
      { provide: LibraryStore, useValue: store },
      { provide: MapleCacheService, useValue: mapleCache },
      { provide: EmbeddedPreviewService, useValue: previewExtractor },
    ],
  });
  return TestBed.inject(HostedPreviewResolver);
}

const rawAsset = (filename = 'a.dng') => ({ filename }) as unknown as Asset;

describe('HostedPreviewResolver.resolve', () => {
  it('cache miss: reads by dir+filename, extracts by ext, returns the JPEG for display', async () => {
    const readPreview = vi.fn(async () => null);
    const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' });
    const extractEmbeddedPreview = vi.fn(async () => ({ width: 800, height: 600, blob: jpeg }));
    const folder = { write: true };
    const getBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));

    const resolver = setup(
      { findAsset: () => rawAsset(), currentFolder: () => folder },
      { readPreview, writePreview: vi.fn() },
      { extractEmbeddedPreview },
    );

    const blob = await resolver.resolve('lib:2026/a.dng' as AssetId, getBytes);

    expect(readPreview).toHaveBeenCalledWith(folder, '2026', 'a.dng', {
      size: 0,
      lastModified: 0,
    });
    expect(getBytes).toHaveBeenCalledWith('lib:2026/a.dng');
    expect(extractEmbeddedPreview).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'dng');
    expect(blob).toBe(jpeg); // display uses the fast JPEG, not the AVIF
  });

  it('stores the extracted JPEG under its actual format', async () => {
    const readPreview = vi.fn(async () => null);
    const writePreview = vi.fn();
    const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' });
    const extractEmbeddedPreview = vi.fn(async () => ({ width: 8, height: 6, blob: jpeg }));

    const resolver = setup(
      { findAsset: () => rawAsset(), currentFolder: () => ({ write: true }) },
      { readPreview, writePreview },
      { extractEmbeddedPreview },
    );

    const blob = await resolver.resolve(
      'lib:2026/a.dng' as AssetId,
      vi.fn(async () => new Uint8Array([1])),
    );
    await settle();

    expect(blob).toBe(jpeg);
    expect(writePreview).toHaveBeenCalledWith(expect.anything(), '2026', 'a.dng', jpeg, {
      size: 0,
      lastModified: 0,
    });
  });

  it('does not publish old pixels when the RAW is replaced during extraction', async () => {
    const writePreview = vi.fn();
    const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' });
    const getSourceIdentity = vi
      .fn<() => Promise<{ size: number; lastModified: number }>>()
      .mockResolvedValueOnce({ size: 10, lastModified: 100 })
      .mockResolvedValueOnce({ size: 11, lastModified: 200 });
    const staleCachedBytes = vi.fn(async () => new Uint8Array([9]));
    const getSourceSnapshot = vi.fn(async () => ({
      bytes: new Uint8Array([1]),
      source: { size: 10, lastModified: 100 },
    }));
    const resolver = setup(
      { findAsset: () => rawAsset(), currentFolder: () => ({ write: true }) },
      { readPreview: vi.fn(async () => null), writePreview },
      {
        extractEmbeddedPreview: vi.fn(async () => ({ width: 8, height: 6, blob: jpeg })),
      },
    );

    const blob = await resolver.resolve(
      'lib:2026/a.dng' as AssetId,
      staleCachedBytes,
      getSourceIdentity,
      getSourceSnapshot,
    );
    await settle();

    expect(blob).toBe(jpeg);
    expect(getSourceSnapshot).toHaveBeenCalledTimes(1);
    expect(staleCachedBytes).not.toHaveBeenCalled();
    expect(getSourceIdentity).toHaveBeenCalledTimes(2);
    expect(writePreview).not.toHaveBeenCalled();
  });

  it('root-level asset (no dir): keys the cache off dir="" ', async () => {
    const readPreview = vi.fn(async () => null);
    const extractEmbeddedPreview = vi.fn(async () => ({
      width: 10,
      height: 10,
      blob: new Blob(['j']),
    }));

    const resolver = setup(
      { findAsset: () => rawAsset('top.dng'), currentFolder: () => ({ write: true }) },
      { readPreview, writePreview: vi.fn() },
      { extractEmbeddedPreview },
    );

    await resolver.resolve(
      'lib:top.dng' as AssetId,
      vi.fn(async () => new Uint8Array([1])),
    );
    expect(readPreview).toHaveBeenCalledWith(expect.anything(), '', 'top.dng', {
      size: 0,
      lastModified: 0,
    });
  });

  it('cache hit: returns the cached AVIF without extracting, reading bytes, or writing', async () => {
    const cached = new Blob(['cached'], { type: 'image/avif' });
    const readPreview = vi.fn(async () => cached);
    const writePreview = vi.fn();
    const extractEmbeddedPreview = vi.fn();
    const getBytes = vi.fn();

    const resolver = setup(
      { findAsset: () => rawAsset(), currentFolder: () => ({ write: true }) },
      { readPreview, writePreview },
      { extractEmbeddedPreview },
    );

    const blob = await resolver.resolve('lib:2026/a.dng' as AssetId, getBytes);

    expect(blob).toBe(cached);
    expect(getBytes).not.toHaveBeenCalled();
    expect(extractEmbeddedPreview).not.toHaveBeenCalled();
    expect(writePreview).not.toHaveBeenCalled();
  });

  it('non-RAW asset: returns null immediately, never extracts', async () => {
    const extractEmbeddedPreview = vi.fn();
    const resolver = setup(
      { findAsset: () => rawAsset('a.jpg'), currentFolder: () => null },
      {},
      { extractEmbeddedPreview },
    );

    const blob = await resolver.resolve('lib:2026/a.jpg' as AssetId, vi.fn());
    expect(blob).toBeNull();
    expect(extractEmbeddedPreview).not.toHaveBeenCalled();
  });

  it('unknown asset (store has no record): returns null immediately', async () => {
    const resolver = setup({ findAsset: () => undefined, currentFolder: () => null });
    const blob = await resolver.resolve('lib:2026/missing.dng' as AssetId, vi.fn());
    expect(blob).toBeNull();
  });

  it('traversal relPath (..): never reads/writes the cache — degrades to a cacheless extraction', async () => {
    const readPreview = vi.fn(async () => null);
    const writePreview = vi.fn();
    const jpeg = new Blob(['jpeg']);
    const extractEmbeddedPreview = vi.fn(async () => ({ width: 8, height: 6, blob: jpeg }));

    const resolver = setup(
      { findAsset: () => rawAsset(), currentFolder: () => ({ write: true }) },
      { readPreview, writePreview },
      { extractEmbeddedPreview },
    );

    // A malicious/deep-link id with a traversal segment must not be turned into
    // a `.maple/previews/` path — `_locate` rejects it via `validateRelPath`, so
    // the cache is never touched (extraction still runs for display).
    const blob = await resolver.resolve(
      'lib:../../etc/a.dng' as AssetId,
      vi.fn(async () => new Uint8Array([1])),
    );
    await settle();

    expect(blob).toBe(jpeg);
    expect(readPreview).not.toHaveBeenCalled();
    expect(writePreview).not.toHaveBeenCalled();
  });

  it('extraction failure (no embedded preview) is swallowed — returns null, not a throw', async () => {
    const extractEmbeddedPreview = vi.fn(async () => {
      throw new Error('no embedded preview / thumbnail in RAW');
    });
    const resolver = setup(
      { findAsset: () => rawAsset(), currentFolder: () => ({ write: true }) },
      { readPreview: vi.fn(async () => null), writePreview: vi.fn() },
      { extractEmbeddedPreview },
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const blob = await resolver.resolve(
        'lib:2026/a.dng' as AssetId,
        vi.fn(async () => new Uint8Array([1])),
      );
      expect(blob).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('no currentFolder: extracts cacheless (never reads or writes the cache)', async () => {
    const readPreview = vi.fn();
    const writePreview = vi.fn();
    const jpeg = new Blob(['jpeg']);
    const extractEmbeddedPreview = vi.fn(async () => ({ width: 100, height: 100, blob: jpeg }));

    const resolver = setup(
      { findAsset: () => rawAsset(), currentFolder: () => null },
      { readPreview, writePreview },
      { extractEmbeddedPreview },
    );

    const blob = await resolver.resolve(
      'lib:2026/a.dng' as AssetId,
      vi.fn(async () => new Uint8Array([1])),
    );
    await settle();

    expect(blob).toBe(jpeg);
    expect(readPreview).not.toHaveBeenCalled();
    expect(writePreview).not.toHaveBeenCalled();
  });

  it('read-only folder: extracts, returns the blob, never attempts a write', async () => {
    const readPreview = vi.fn(async () => null);
    const writePreview = vi.fn();
    const jpeg = new Blob(['jpeg']);
    const extractEmbeddedPreview = vi.fn(async () => ({ width: 100, height: 100, blob: jpeg }));

    const resolver = setup(
      { findAsset: () => rawAsset(), currentFolder: () => ({ write: false }) },
      { readPreview, writePreview },
      { extractEmbeddedPreview },
    );

    const blob = await resolver.resolve(
      'lib:2026/a.dng' as AssetId,
      vi.fn(async () => new Uint8Array([1])),
    );
    await settle();

    expect(blob).toBe(jpeg);
    expect(writePreview).not.toHaveBeenCalled();
  });
});
