// HostedPreviewResolver — Hosted-mode embedded-RAW-preview resolution
// (#2010, epic #1993 Stage 4): mapleId cache-key resolution, the
// `.maple/previews/` read/write-through cache, the RAW/non-RAW split, and
// graceful degradation on any failure (never throws to the caller).

import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';

import { HostedPreviewResolver } from './hosted-preview-resolver.service';
import { LibraryStore } from './library-store.service';
import { FsAccessLibrarySource } from '../addressing/fs-access-library-source';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { EmbeddedPreviewService } from '../raw-pipeline/embedded-preview.service';
import type { Asset, AssetId } from '../models/asset';

function setup(
  store: Record<string, unknown>,
  fsAccessSource: Record<string, unknown> = {},
  mapleCache: Record<string, unknown> = {},
  previewExtractor: Record<string, unknown> = {},
) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      HostedPreviewResolver,
      { provide: LibraryStore, useValue: store },
      { provide: FsAccessLibrarySource, useValue: fsAccessSource },
      { provide: MapleCacheService, useValue: mapleCache },
      { provide: EmbeddedPreviewService, useValue: previewExtractor },
    ],
  });
  return TestBed.inject(HostedPreviewResolver);
}

describe('HostedPreviewResolver.resolve', () => {
  it('cache miss: computes mapleId, extracts via the WASM binding, and writes through', async () => {
    const mapleId = vi.fn(async () => 'abc123');
    const readPreview = vi.fn(async () => null);
    const writePreview = vi.fn(async () => undefined);
    const extractedBlob = new Blob(['jpeg'], { type: 'image/jpeg' });
    const extractEmbeddedPreview = vi.fn(async () => ({
      width: 800,
      height: 600,
      blob: extractedBlob,
    }));
    const findAsset = vi.fn(
      () => ({ id: 'lib:2026/a.dng', filename: 'a.dng' }) as unknown as Asset,
    );
    const folder = { write: true };
    const currentFolder = vi.fn(() => folder);
    const getBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));

    const resolver = setup(
      { findAsset, currentFolder },
      { mapleId },
      { readPreview, writePreview },
      { extractEmbeddedPreview },
    );

    const address = { slug: 'lib', relPath: '2026/a.dng' };
    const blob = await resolver.resolve('lib:2026/a.dng' as AssetId, address, getBytes);

    expect(mapleId).toHaveBeenCalledWith(address);
    expect(readPreview).toHaveBeenCalledWith(folder, 'abc123');
    expect(getBytes).toHaveBeenCalledWith('lib:2026/a.dng');
    expect(extractEmbeddedPreview).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'dng');
    expect(writePreview).toHaveBeenCalledWith(folder, 'abc123', extractedBlob);
    expect(blob).toBe(extractedBlob);
  });

  it('cache hit: returns the cached blob without extracting, reading bytes, or writing', async () => {
    const cachedBlob = new Blob(['cached'], { type: 'image/jpeg' });
    const mapleId = vi.fn(async () => 'abc123');
    const readPreview = vi.fn(async () => cachedBlob);
    const writePreview = vi.fn();
    const extractEmbeddedPreview = vi.fn();
    const getBytes = vi.fn();
    const findAsset = vi.fn(
      () => ({ id: 'lib:2026/a.dng', filename: 'a.dng' }) as unknown as Asset,
    );

    const resolver = setup(
      { findAsset, currentFolder: () => ({ write: true }) },
      { mapleId },
      { readPreview, writePreview },
      { extractEmbeddedPreview },
    );

    const blob = await resolver.resolve(
      'lib:2026/a.dng' as AssetId,
      { slug: 'lib', relPath: '2026/a.dng' },
      getBytes,
    );

    expect(blob).toBe(cachedBlob);
    expect(getBytes).not.toHaveBeenCalled();
    expect(extractEmbeddedPreview).not.toHaveBeenCalled();
    expect(writePreview).not.toHaveBeenCalled();
  });

  it('non-RAW asset: never computes an id or extracts — returns null immediately', async () => {
    const mapleId = vi.fn();
    const extractEmbeddedPreview = vi.fn();
    const findAsset = vi.fn(
      () => ({ id: 'lib:2026/a.jpg', filename: 'a.jpg' }) as unknown as Asset,
    );

    const resolver = setup(
      { findAsset, currentFolder: () => null },
      { mapleId },
      {},
      {
        extractEmbeddedPreview,
      },
    );

    const blob = await resolver.resolve(
      'lib:2026/a.jpg' as AssetId,
      { slug: 'lib', relPath: '2026/a.jpg' },
      vi.fn(),
    );

    expect(blob).toBeNull();
    expect(mapleId).not.toHaveBeenCalled();
    expect(extractEmbeddedPreview).not.toHaveBeenCalled();
  });

  it('unknown asset (store has no record of this id): returns null immediately', async () => {
    const mapleId = vi.fn();
    const findAsset = vi.fn(() => undefined);

    const resolver = setup({ findAsset, currentFolder: () => null }, { mapleId });

    const blob = await resolver.resolve(
      'lib:2026/missing.dng' as AssetId,
      { slug: 'lib', relPath: '2026/missing.dng' },
      vi.fn(),
    );

    expect(blob).toBeNull();
    expect(mapleId).not.toHaveBeenCalled();
  });

  it('extraction failure (e.g. no embedded preview in this RAW) is swallowed — returns null, not a throw', async () => {
    const mapleId = vi.fn(async () => 'abc123');
    const readPreview = vi.fn(async () => null);
    const extractEmbeddedPreview = vi.fn(async () => {
      throw new Error('no embedded preview / thumbnail in RAW');
    });
    const findAsset = vi.fn(
      () => ({ id: 'lib:2026/a.dng', filename: 'a.dng' }) as unknown as Asset,
    );

    const resolver = setup(
      { findAsset, currentFolder: () => ({ write: true }) },
      { mapleId },
      { readPreview, writePreview: vi.fn() },
      { extractEmbeddedPreview },
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const blob = await resolver.resolve(
        'lib:2026/a.dng' as AssetId,
        { slug: 'lib', relPath: '2026/a.dng' },
        vi.fn(async () => new Uint8Array([1])),
      );
      expect(blob).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('mapleId computation failure is swallowed — returns null, never reads bytes', async () => {
    const mapleId = vi.fn(async () => {
      throw new Error('hash failed');
    });
    const getBytes = vi.fn();
    const findAsset = vi.fn(
      () => ({ id: 'lib:2026/a.dng', filename: 'a.dng' }) as unknown as Asset,
    );

    const resolver = setup({ findAsset, currentFolder: () => ({ write: true }) }, { mapleId });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const blob = await resolver.resolve(
        'lib:2026/a.dng' as AssetId,
        { slug: 'lib', relPath: '2026/a.dng' },
        getBytes,
      );
      expect(blob).toBeNull();
      expect(getBytes).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('no currentFolder: still extracts and returns the blob, but never attempts a write', async () => {
    const mapleId = vi.fn(async () => 'abc123');
    const writePreview = vi.fn();
    const extractedBlob = new Blob(['jpeg'], { type: 'image/jpeg' });
    const extractEmbeddedPreview = vi.fn(async () => ({
      width: 100,
      height: 100,
      blob: extractedBlob,
    }));
    const findAsset = vi.fn(
      () => ({ id: 'lib:2026/a.dng', filename: 'a.dng' }) as unknown as Asset,
    );

    const resolver = setup(
      { findAsset, currentFolder: () => null },
      { mapleId },
      { readPreview: vi.fn(), writePreview },
      { extractEmbeddedPreview },
    );

    const blob = await resolver.resolve(
      'lib:2026/a.dng' as AssetId,
      { slug: 'lib', relPath: '2026/a.dng' },
      vi.fn(async () => new Uint8Array([1])),
    );

    expect(blob).toBe(extractedBlob);
    expect(writePreview).not.toHaveBeenCalled();
  });

  it('folder present but read-only: extracts, returns the blob, never attempts a write', async () => {
    const mapleId = vi.fn(async () => 'abc123');
    const readPreview = vi.fn(async () => null);
    const writePreview = vi.fn();
    const extractedBlob = new Blob(['jpeg'], { type: 'image/jpeg' });
    const extractEmbeddedPreview = vi.fn(async () => ({
      width: 100,
      height: 100,
      blob: extractedBlob,
    }));
    const findAsset = vi.fn(
      () => ({ id: 'lib:2026/a.dng', filename: 'a.dng' }) as unknown as Asset,
    );

    const resolver = setup(
      { findAsset, currentFolder: () => ({ write: false }) },
      { mapleId },
      { readPreview, writePreview },
      { extractEmbeddedPreview },
    );

    const blob = await resolver.resolve(
      'lib:2026/a.dng' as AssetId,
      { slug: 'lib', relPath: '2026/a.dng' },
      vi.fn(async () => new Uint8Array([1])),
    );

    expect(blob).toBe(extractedBlob);
    expect(writePreview).not.toHaveBeenCalled();
  });
});
