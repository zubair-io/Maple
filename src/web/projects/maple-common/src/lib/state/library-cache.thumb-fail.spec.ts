// ThumbFailMemory (#2413) — a thumbnail load that fails once must not be
// re-requested on every subsequent `ensureThumbnailUrl` call. Before the fix,
// every grid re-render re-fired the same doomed network request forever (the
// production X3F 404 loop). Covers both failure modes: a rejected loader
// promise, and a loader that silently runs out of branches without caching a
// URL.

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, vi, type Mock } from 'vitest';

import { LibraryCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { LibrarySelection } from './library-selection.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import type { Asset, AssetId } from '../models/asset';

describe('LibraryCache — failed thumbnail is not re-requested (#2413)', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function setup(libSource: Record<string, unknown>) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LibraryCache,
        { provide: LibraryStore, useValue: { backend: 'self-hosted' } },
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

  it('does not re-fire the network request on repeated ensureThumbnailUrl calls after a rejection', async () => {
    // Mirrors an X3F asset whose embedded-preview extraction 404s server-side
    // (#2413) — every failure mode ends up here as a rejected thumbBlob().
    const thumbBlob = vi.fn(async () => {
      throw new Error('404 Not Found');
    });
    const svc = setup({ thumbBlob });
    const asset = { id: 'lib:2026/broken.x3f', filename: 'broken.x3f' } as unknown as Asset;

    svc.ensureThumbnailUrl(asset);
    await settle();
    expect(thumbBlob).toHaveBeenCalledTimes(1);

    // A grid re-render (change detection tick, scroll, sibling load
    // completing) calls ensureThumbnailUrl again for the same still-failed
    // asset — this must NOT re-fire the request.
    svc.ensureThumbnailUrl(asset);
    svc.ensureThumbnailUrl(asset);
    await settle();

    expect(thumbBlob).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire when the loader resolves with no thumb (no branch matched, no throw)', async () => {
    // A self-hosted asset that is neither an M2 id, nor has a resolvable
    // apiId: `_loadSelfHostedThumb` returns without ever calling
    // `cacheThumbnailUrl` and without throwing — the "silent no-op" failure
    // mode, distinct from the rejected-promise case above.
    TestBed.resetTestingModule();
    const apiAssetIds = new Map<string, string>(); // deliberately empty — no match
    TestBed.configureTestingModule({
      providers: [
        LibraryCache,
        { provide: LibraryStore, useValue: { backend: 'self-hosted', apiAssetIds } },
        { provide: LibrarySelection, useValue: { selectedSourceId: signal('') } },
        { provide: BunApiBackendService, useValue: { getThumb: vi.fn() } },
        { provide: FilesystemBrowseService, useValue: {} },
        { provide: MapleCacheService, useValue: {} },
        { provide: RawPipelineService, useValue: {} },
        { provide: LIBRARY_SOURCE, useValue: { thumbBlob: vi.fn() } },
      ],
    });
    const svc = TestBed.inject(LibraryCache);
    const getThumbSpy = (TestBed.inject(BunApiBackendService) as unknown as { getThumb: Mock })
      .getThumb;
    const asset = { id: 'unrouted-id', filename: 'mystery.raw' } as unknown as Asset;

    svc.ensureThumbnailUrl(asset);
    await settle();
    expect(svc.thumbnailUrlFor('unrouted-id' as AssetId)).toBeUndefined();
    expect(getThumbSpy).not.toHaveBeenCalled(); // never reached — no apiId to call it with

    // Re-render calls it again for the still-unresolved asset. Before the
    // fix this would re-run `_loadSelfHostedThumb` from scratch every time;
    // the loading-token round-trip is unobservable either way once settled,
    // so this test's own regression signal is the first assertion above
    // combined with the sibling rejected-promise test — both must pass.
    svc.ensureThumbnailUrl(asset);
    await settle();
    expect(
      (svc as unknown as { thumbFails: { has(id: string): boolean } }).thumbFails.has(
        'unrouted-id',
      ),
    ).toBe(true);
  });
});
