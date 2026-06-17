// Verifies the download-progress surface on HttpLibrarySource.imageBlob
// (`/api/image/:slug/*`), the editor cold-open byte fetch for M2 addressing.
// Mirrors raw-bytes-progress.spec.ts: passing an onProgress callback must
// stream DownloadProgress frames while still resolving with exactly one Blob;
// omitting it must keep the plain buffered request the no-progress callers use.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient, HttpEventType } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { HttpLibrarySource } from './http-library-source';
import { API_BASE_URL } from '../api/api-base-url.token';
import type { DownloadProgress } from '../api/filesystem-browse.service';

describe('HttpLibrarySource.imageBlob download progress', () => {
  let src: HttpLibrarySource;
  let http: HttpTestingController;

  beforeEach(() => {
    // Defensive reset — a sibling spec in the shared worker can leave the
    // TestBed instantiated, which makes configureTestingModule throw.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        HttpLibrarySource,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    src = TestBed.inject(HttpLibrarySource);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('buffers silently with no callback (no progress requested)', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
    const promise = src.imageBlob({ slug: 'lib', relPath: '2026/a.dng' });
    const req = http.expectOne('/api/image/lib/2026/a.dng');
    expect(req.request.responseType).toBe('blob');
    expect(req.request.reportProgress).toBeFalsy();
    req.flush(blob);
    expect(await promise).toBe(blob);
  });

  it('reports progress frames and resolves with the Blob', async () => {
    const frames: DownloadProgress[] = [];
    const blob = new Blob([new Uint8Array([9, 8, 7])]);
    const promise = src.imageBlob({ slug: 'lib', relPath: 'b.dng' }, (p) => frames.push(p));
    const req = http.expectOne('/api/image/lib/b.dng');
    expect(req.request.reportProgress).toBe(true);
    expect(req.request.responseType).toBe('blob');

    req.event({ type: HttpEventType.DownloadProgress, loaded: 1, total: 3 });
    req.event({ type: HttpEventType.DownloadProgress, loaded: 3, total: 3 });
    req.flush(blob);

    expect(await promise).toBe(blob);
    expect(frames).toEqual([
      { loaded: 1, total: 3 },
      { loaded: 3, total: 3 },
    ]);
  });

  it('maps a missing Content-Length total to null', async () => {
    const frames: DownloadProgress[] = [];
    const promise = src.imageBlob({ slug: 'lib', relPath: 'c.dng' }, (p) => frames.push(p));
    const req = http.expectOne('/api/image/lib/c.dng');
    req.event({ type: HttpEventType.DownloadProgress, loaded: 50, total: undefined });
    req.flush(new Blob());
    await promise;
    expect(frames).toEqual([{ loaded: 50, total: null }]);
  });
});
