// Shared thumbnails and previews are unversioned (#4793): the client never
// tags a derivative read or upload with the pipeline output version.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { BunApiBackendService } from './bun-api-backend.service';
import { API_BASE_URL } from './api-base-url.token';

describe('BunApiBackendService derivative requests carry no pipeline version (#4795)', () => {
  let api: BunApiBackendService;
  let http: HttpTestingController;

  beforeEach(() => {
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

  it('GETs the asset thumb with no pv query parameter', async () => {
    const promise = firstValueFrom(api.getThumb('asset-1'));
    const req = http.expectOne('/api/assets/asset-1/thumb');
    expect(req.request.urlWithParams).toBe('/api/assets/asset-1/thumb');
    req.flush(new Blob(['x'], { type: 'image/avif' }));
    await promise;
  });

  it('PUTs a preview with only its Content-Type header', async () => {
    const promise = firstValueFrom(api.putPreview('/photos/a.dng', new Blob(['x']), 'image/avif'));
    const req = http.expectOne('/api/preview?path=%2Fphotos%2Fa.dng');
    expect(req.request.method).toBe('PUT');
    expect(req.request.headers.get('Content-Type')).toBe('image/avif');
    expect(req.request.headers.has('X-Maple-Pipeline-Version')).toBe(false);
    expect(req.request.headers.keys()).toEqual(['Content-Type']);
    req.flush(null);
    await promise;
  });
});
