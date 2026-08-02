// LibraryCache — thumbnail loading must not couple grid tiles reactively.
//
// Every grid tile (`<maple-asset-thumb>`) and filmstrip cell calls
// `ensureThumbnailUrl` from inside an Angular `effect()`. That method reads
// per-asset "is it already loaded / already failed / which source" state to
// decide whether to start a load — and two of those reads used to be SIGNAL
// reads (`thumbnailUrls()` and `selectedSourceId()`) performed inside the
// caller's reactive context.
//
// `cacheThumbnailUrl` publishes a fresh `thumbnailUrls` map snapshot once per
// thumbnail that lands. So every mounted tile had taken a dependency on a
// signal that changes once per thumbnail: one thumbnail arriving invalidated
// EVERY tile's effect, and each re-run tore down and rebuilt that tile's
// subscription via the effect's `onCleanup`. Cost was O(tiles x thumbnails) —
// with ~60 tiles in a viewport, a 60-thumbnail first paint ran ~3,600 effects
// and rebuilt the bounded map 60 times. That is the grid "locking up" while
// thumbnails load and janking while scrolling.
//
// These tests pin the invariant: the short-circuit state is read UNTRACKED, so
// a tile's effect runs once per asset it displays and not once per thumbnail
// that happens to land anywhere in the grid.

import { TestBed } from '@angular/core/testing';
import { signal, effect } from '@angular/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { LibraryCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { LibrarySelection } from './library-selection.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import type { Asset, AssetId } from '../models/asset';

/** An asset that resolves to no loadable thumbnail source, so `ensureThumbnailUrl`
 * exercises its bookkeeping (tokens, fail memory) without any network branch. */
function tile(id: string): Asset {
  return { id: id as AssetId, filename: `${id}.jpg` } as Asset;
}

describe('LibraryCache — tile effects stay independent of the thumb map', () => {
  let svc: LibraryCache;
  let selectedSourceId: ReturnType<typeof signal<string>>;

  beforeEach(() => {
    selectedSourceId = signal('src-1');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LibraryCache,
        {
          provide: LibraryStore,
          useValue: {
            // Self-Hosted with no absPath and no api id → the loader falls
            // through every branch and returns without touching the network.
            backend: 'self-hosted',
            apiAssetIds: new Map<string, string>(),
            assetAbsPaths: new Map<string, string>(),
            currentFolder: () => undefined,
            findAsset: () => undefined,
            updateAssetDimensions: vi.fn(),
          },
        },
        { provide: LibrarySelection, useValue: { selectedSourceId } },
        { provide: BunApiBackendService, useValue: {} },
        { provide: FilesystemBrowseService, useValue: { clearThumbCache: vi.fn() } },
        { provide: MapleCacheService, useValue: {} },
        { provide: RawPipelineService, useValue: {} },
        { provide: LIBRARY_SOURCE, useValue: { thumbBlob: vi.fn(), previewBlob: vi.fn() } },
      ],
    });
    svc = TestBed.inject(LibraryCache);
  });

  /** Mount `ids` as tiles, each calling `ensureThumbnailUrl` from its own
   * effect exactly the way `<maple-asset-thumb>` does. Returns a per-id run
   * counter. */
  function mountTiles(ids: string[]): Map<string, number> {
    const runs = new Map<string, number>(ids.map((id) => [id, 0]));
    TestBed.runInInjectionContext(() => {
      for (const id of ids) {
        effect(() => {
          runs.set(id, runs.get(id)! + 1);
          svc.ensureThumbnailUrl(tile(id));
        });
      }
    });
    TestBed.tick();
    return runs;
  }

  it('does not re-run a tile effect when another tile thumbnail lands', () => {
    const runs = mountTiles(['a', 'b', 'c', 'd']);
    expect([...runs.values()]).toEqual([1, 1, 1, 1]);

    svc.cacheThumbnailUrl('a' as AssetId, 'blob:a');
    TestBed.tick();

    // Tile 'a' repaints through its own `subscribeThumbUrl` callback, not by
    // re-running the loader effect. No tile's effect should have re-run.
    expect([...runs.values()]).toEqual([1, 1, 1, 1]);
  });

  it('keeps total tile-effect runs linear, not quadratic, as a viewport fills', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `img-${i}`);
    const runs = mountTiles(ids);
    expect([...runs.values()].reduce((a, b) => a + b, 0)).toBe(40);

    // Every tile's thumbnail lands, one at a time with a change-detection pass
    // between each — thumbnails resolve on separate task boundaries in the real
    // app, so the runs they trigger do NOT coalesce the way a single batched
    // tick would make them appear to.
    for (const id of ids) {
      svc.cacheThumbnailUrl(id as AssetId, `blob:${id}`);
      TestBed.tick();
    }

    // Linear: 40 mounts, no re-runs. Pre-fix this was 40 + 40*40 = 1,640.
    const total = [...runs.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(40);
  });

  it('does not re-run tile effects when the selected source id changes', () => {
    // The source id is loader bookkeeping (it tags queued work so a source
    // switch can drop it), not something a tile renders — reading it must not
    // subscribe every mounted tile to it.
    const runs = mountTiles(['a', 'b']);
    expect([...runs.values()]).toEqual([1, 1]);

    selectedSourceId.set('src-2');
    TestBed.tick();

    expect([...runs.values()]).toEqual([1, 1]);
  });
});
