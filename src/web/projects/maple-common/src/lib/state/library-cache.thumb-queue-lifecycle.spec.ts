// LibraryCache — thumbnail queue lifecycle: cancellation and source switches.
//
// Split out of `library-cache.service.spec.ts`, which reached the 600-line hard
// budget. These cover what happens to *queued* (not yet started) thumbnail
// loads when the world changes underneath them — a tile unmounts, a tile is
// recycled onto a new asset, or the selected source changes — as opposed to the
// blob-URL lifecycle and M2 addressing cases the original file still owns.
//
// The queue's own concurrency mechanics are unit-tested Angular-free in
// `library-cache.thumb-queue.spec.ts`; these go through the real service so the
// wiring (loading tokens, subscriber accounting, fail memory) is exercised too.

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, vi } from 'vitest';

import { LibraryCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { LibrarySelection } from './library-selection.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import type { Asset, AssetId } from '../models/asset';

/** `_loadThumbInternal` is fire-and-forget; let microtasks drain. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Self-Hosted cache whose thumb fetch never resolves, so loads occupy the four
 * concurrent slots indefinitely and anything beyond them stays observably
 * queued. */
function setup(selectedSourceId = signal('lib:folder_a')) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      LibraryCache,
      { provide: LibraryStore, useValue: { backend: 'self-hosted' } },
      { provide: LibrarySelection, useValue: { selectedSourceId } },
      { provide: BunApiBackendService, useValue: {} },
      { provide: FilesystemBrowseService, useValue: {} },
      { provide: MapleCacheService, useValue: {} },
      { provide: RawPipelineService, useValue: {} },
      { provide: LIBRARY_SOURCE, useValue: { thumbBlob: vi.fn(() => new Promise(() => {})) } },
    ],
  });
  return TestBed.inject(LibraryCache);
}

const asset = (i: number): Asset =>
  ({ id: `lib:folder_a/img_${i}.jpg`, filename: `img_${i}.jpg` }) as unknown as Asset;

/** Not-yet-started entries in the service's queue. */
const depth = (svc: LibraryCache): number =>
  (svc as unknown as { thumbQueue: { depth: number } }).thumbQueue.depth;

const tokens = (svc: LibraryCache): number =>
  (svc as unknown as { thumbLoadingTokens: Map<unknown, unknown> }).thumbLoadingTokens.size;

describe('LibraryCache — thumbnail queue lifecycle', () => {
  it('clears the queue and loading states when the selected folder/source ID changes', async () => {
    const selectedSourceId = signal('lib:folder_a');
    const svc = setup(selectedSourceId);

    for (let i = 0; i < 6; i++) svc.ensureThumbnailUrl(asset(i));
    await settle();

    // Cap is 4, so two are still waiting.
    expect(depth(svc)).toBe(2);
    expect(tokens(svc)).toBe(6);

    selectedSourceId.set('lib:folder_b');
    await settle();

    expect(depth(svc)).toBe(0);
    expect(tokens(svc)).toBe(0);
  });

  // A tile cancels its queued load when it is recycled onto a new asset OR when
  // its own Asset object is replaced (a rating edit, or the hosted decode's
  // `updateAssetDimensions`, both rebuild the object). In that second case the
  // very next thing the tile does is re-request the SAME id, in the same tick.
  // If cancelling left the in-flight token behind, that re-request
  // short-circuits on "already loading" and the tile keeps its gradient forever
  // — the load it cancelled is never replaced.
  it('re-enqueues an id that was cancelled and immediately requested again', async () => {
    const svc = setup();

    for (let i = 0; i < 5; i++) svc.ensureThumbnailUrl(asset(i));
    await settle();
    expect(depth(svc)).toBe(1);

    svc.cancelQueuedThumbnail('lib:folder_a/img_4.jpg' as AssetId);
    svc.ensureThumbnailUrl(asset(4));

    expect(depth(svc)).toBe(1);
  });

  // `ensureThumbnailUrl` dedupes by asset id, so two mounted components showing
  // the SAME asset share one queued load. Preview does exactly this: the shell
  // subscribes to the focused asset's thumb and also renders
  // `<editor-filmstrip>`, which mounts a `<maple-asset-thumb>` for that same
  // asset. If either one unmounting cancelled the shared load unconditionally,
  // the other would wait forever on a thumbnail that is never coming.
  it('keeps a queued load alive while another consumer is still subscribed', async () => {
    const svc = setup();
    const sharedId = 'lib:folder_a/img_4.jpg' as AssetId;

    for (let i = 0; i < 5; i++) svc.ensureThumbnailUrl(asset(i));
    await settle();
    expect(depth(svc)).toBe(1);

    const unsubTile = svc.subscribeThumbUrl(sharedId, () => {});
    const unsubShell = svc.subscribeThumbUrl(sharedId, () => {});

    // The tile unmounts: it unsubscribes, then asks to cancel.
    unsubTile();
    svc.cancelQueuedThumbnail(sharedId);
    expect(depth(svc)).toBe(1); // the shell still needs it

    // The last consumer goes away — now the queued work is genuinely unwanted.
    unsubShell();
    svc.cancelQueuedThumbnail(sharedId);
    expect(depth(svc)).toBe(0);
  });

  // Clearing the queue on a source/folder switch is expected control flow, not
  // a failure. Rejecting each queued waiter with the sentinel must not spray
  // non-actionable warnings across the console — one per queued thumbnail.
  it('does not log a warning for loads dropped by a source switch', async () => {
    const selectedSourceId = signal('lib:folder_a');
    const svc = setup(selectedSourceId);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 8; i++) svc.ensureThumbnailUrl(asset(i));
      await settle();
      expect(depth(svc)).toBe(4);

      selectedSourceId.set('lib:folder_b');
      await settle();

      const cleared = warn.mock.calls.filter((c) => JSON.stringify(c).includes('Queue cleared'));
      expect(cleared).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
