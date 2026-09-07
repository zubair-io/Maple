// Verifies the download-progress surface on the Self-Hosted Mongo-id byte
// fetch (bun-api `/api/assets/:id/raw`) without breaking the existing
// buffer-only emission contract that `firstValueFrom` callers rely on. The
// address-keyed twin lives in `HttpLibrarySource.imageBlob` (`/api/image`);
// the legacy `/api/fs/raw` fetch was retired from the web app in #1325.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpEventType } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import type { DownloadProgress } from './filesystem-browse.service';
import { BunApiBackendService } from './bun-api-backend.service';
import { API_BASE_URL } from './api-base-url.token';

describe('RAW byte download progress', () => {
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
        BunApiBackendService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    api = TestBed.inject(BunApiBackendService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

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
