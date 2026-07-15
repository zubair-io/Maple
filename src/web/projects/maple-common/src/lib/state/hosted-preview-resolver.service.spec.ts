// HostedPreviewResolver — Hosted-mode embedded-RAW-preview resolution
// (#2010, epic #1993): directory+filename cache-keying, the canonical
// `<dir>/.maple/previews/<filename>.avif` read/write-through cache, the
// genuine-AVIF-or-defer write rule, the RAW/non-RAW split, and graceful
// degradation on any failure (never throws to the caller).
//
// The AVIF transcode (`encodePreviewBlobToAvif`) is a browser-canvas call.
// Under jsdom there is no canvas AVIF encoder, so `canEncodeAvif()` reports
// false and the transcode returns null — which is exactly the "browser can't
// encode AVIF → write NOTHING (never a mislabeled .avif)" branch this tier is
// contractually required to take. These tests therefore assert the real
// defer behaviour directly (no encoder mock — the Angular unit-test system
// disallows `vi.mock` on relative imports anyway). The AVIF-write happy path
// on a capable browser is covered by the ticket's real-browser verification.

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

    expect(readPreview).toHaveBeenCalledWith(folder, '2026', 'a.dng');
    expect(getBytes).toHaveBeenCalledWith('lib:2026/a.dng');
    expect(extractEmbeddedPreview).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'dng');
    expect(blob).toBe(jpeg); // display uses the fast JPEG, not the AVIF
  });

  it('browser cannot encode AVIF (jsdom): writes NOTHING — never a mislabeled .avif', async () => {
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
    expect(readPreview).toHaveBeenCalledWith(expect.anything(), '', 'top.dng');
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
