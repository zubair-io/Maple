// LibraryCache — which concurrency bound its thumbnail queue runs at (#6192).
//
// Self Hosted thumbnails are requests to the server, so they follow the
// protocol bound; Hosted thumbnails are local decodes and keep the HTTP/1.1
// bound whatever protocol served the page.

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { LibraryCache } from './library-cache.service';
import { LibraryStore } from './library-store.service';
import { LibrarySelection } from './library-selection.service';
import { BunApiBackendService } from '../api/bun-api-backend.service';
import { FilesystemBrowseService } from '../api/filesystem-browse.service';
import { MapleCacheService } from '../maple-cache/maple-cache.service';
import { RawPipelineService } from '../raw-pipeline/raw-pipeline.service';
import { LIBRARY_SOURCE } from '../addressing/library-source';
import { MAX_CONCURRENT_THUMB_LOADS, MULTIPLEXED_THUMB_LOADS } from './thumb-load-bound';

function cacheFor(backend: 'self-hosted' | 'hosted'): LibraryCache {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      LibraryCache,
      { provide: LibraryStore, useValue: { backend } },
      { provide: LibrarySelection, useValue: { selectedSourceId: signal('lib:folder_a') } },
      { provide: BunApiBackendService, useValue: {} },
      { provide: FilesystemBrowseService, useValue: {} },
      { provide: MapleCacheService, useValue: {} },
      { provide: RawPipelineService, useValue: {} },
      { provide: LIBRARY_SOURCE, useValue: {} },
    ],
  });
  return TestBed.inject(LibraryCache);
}

const queueBound = (cache: LibraryCache): number =>
  (cache as unknown as { thumbQueue: { bound: () => number } }).thumbQueue.bound();

function pageArrivedOverHttp2(): void {
  const page = { name: `${location.origin}/browse`, nextHopProtocol: 'h2' };
  vi.spyOn(performance, 'getEntriesByType').mockImplementation(
    (type: string) => (type === 'navigation' ? [page] : []) as never,
  );
}

describe('LibraryCache — thumbnail queue bound', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches sixteen Self Hosted thumbnails at once over HTTP/2', () => {
    pageArrivedOverHttp2();
    expect(queueBound(cacheFor('self-hosted'))).toBe(MULTIPLEXED_THUMB_LOADS);
  });

  it('keeps Hosted decodes at four even when the page arrived over HTTP/2', () => {
    pageArrivedOverHttp2();
    expect(queueBound(cacheFor('hosted'))).toBe(MAX_CONCURRENT_THUMB_LOADS);
  });
});
