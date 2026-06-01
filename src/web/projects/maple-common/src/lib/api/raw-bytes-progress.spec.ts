// Verifies the download-progress surface on the two Self-Hosted byte fetches
// (filesystem-browse `/api/fs/raw` and bun-api `/api/assets/:id/raw`) without
// breaking the existing buffer-only emission contract that `firstValueFrom`
// callers rely on.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpEventType } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { FilesystemBrowseService, type DownloadProgress } from './filesystem-browse.service';
import { BunApiBackendService } from './bun-api-backend.service';
import { API_BASE_URL } from './api-base-url.token';

describe('RAW byte download progress', () => {
  let fsBrowse: FilesystemBrowseService;
  let api: BunApiBackendService;
  let http: HttpTestingController;

  beforeEach(() => {
    // Defensive: another spec file in the shared Vitest worker can leave the
    // TestBed instantiated, which makes `configureTestingModule` throw. Reset
    // first so this suite is self-contained regardless of file ordering.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        FilesystemBrowseService,
        BunApiBackendService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    fsBrowse = TestBed.inject(FilesystemBrowseService);
    api = TestBed.inject(BunApiBackendService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  // ── filesystem-browse (`/api/fs/raw`) ──────────────────────────────────────

  it('fs.getRawBytes still buffers silently with no callback (no progress requested)', async () => {
    const body = new Uint8Array([1, 2, 3, 4]).buffer;
    const promise = fsBrowse.getRawBytes('/lib/a.dng');
    const req = http.expectOne((r) => r.url.split('?')[0] === '/api/fs/raw');
    // No callback → plain arraybuffer request, no event observation.
    expect(req.request.responseType).toBe('arraybuffer');
    req.flush(body);
    expect(await promise).toBe(body);
  });

  it('fs.getRawBytes reports progress frames and resolves with the buffer', async () => {
    const frames: DownloadProgress[] = [];
    const body = new Uint8Array([9, 8, 7]).buffer;
    const promise = fsBrowse.getRawBytes('/lib/b.dng', (p) => frames.push(p));
    const req = http.expectOne((r) => r.url.split('?')[0] === '/api/fs/raw');
    expect(req.request.reportProgress).toBe(true);

    req.event({ type: HttpEventType.DownloadProgress, loaded: 1, total: 3 });
    req.event({ type: HttpEventType.DownloadProgress, loaded: 3, total: 3 });
    req.flush(body);

    const result = await promise;
    expect(result).toBe(body);
    expect(frames).toEqual([
      { loaded: 1, total: 3 },
      { loaded: 3, total: 3 },
    ]);
  });

  it('fs.getRawBytes maps a missing Content-Length total to null', async () => {
    const frames: DownloadProgress[] = [];
    const promise = fsBrowse.getRawBytes('/lib/c.dng', (p) => frames.push(p));
    const req = http.expectOne((r) => r.url.split('?')[0] === '/api/fs/raw');
    req.event({ type: HttpEventType.DownloadProgress, loaded: 50, total: undefined });
    req.flush(new ArrayBuffer(0));
    await promise;
    expect(frames).toEqual([{ loaded: 50, total: null }]);
  });

  // ── bun-api (`/api/assets/:id/raw`) ─────────────────────────────────────────

  it('api.getRawBytes emits exactly one ArrayBuffer for firstValueFrom callers', async () => {
    const body = new Uint8Array([5, 6]).buffer;
    const promise = firstValueFrom(api.getRawBytes('asset123'));
    const req = http.expectOne('/api/assets/asset123/raw');
    expect(req.request.responseType).toBe('arraybuffer');
    req.flush(body);
    expect(await promise).toBe(body);
  });

  it('api.getRawBytes with onProgress still emits one buffer (not a progress frame)', async () => {
    const frames: DownloadProgress[] = [];
    const body = new Uint8Array([4, 2]).buffer;
    // firstValueFrom must still resolve with the BUFFER, never a progress frame,
    // because the progress events are filtered out of the emission stream.
    const promise = firstValueFrom(api.getRawBytes('asset999', (p) => frames.push(p)));
    const req = http.expectOne('/api/assets/asset999/raw');
    expect(req.request.reportProgress).toBe(true);

    req.event({ type: HttpEventType.DownloadProgress, loaded: 1, total: 2 });
    req.event({ type: HttpEventType.DownloadProgress, loaded: 2, total: 2 });
    req.flush(body);

    expect(await promise).toBe(body);
    expect(frames).toEqual([
      { loaded: 1, total: 2 },
      { loaded: 2, total: 2 },
    ]);
  });
});
