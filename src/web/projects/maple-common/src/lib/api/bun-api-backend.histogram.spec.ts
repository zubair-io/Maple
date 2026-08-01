import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from './api-base-url.token';
import { BunApiBackendService } from './bun-api-backend.service';

describe('BunApiBackendService histogram addressing', () => {
  let service: BunApiBackendService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        BunApiBackendService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    service = TestBed.inject(BunApiBackendService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('resolves a public asset address before requesting its histogram', () => {
    service.getHistogram('library:folder/photo.dng').subscribe();
    http
      .expectOne(
        (request) =>
          request.url === '/api/assets/by-address' &&
          request.params.get('address') === 'library:folder/photo.dng',
      )
      .flush({ id: '507f1f77bcf86cd799439011' });
    expect(http.expectOne('/api/assets/507f1f77bcf86cd799439011/histogram').request.method).toBe(
      'GET',
    );
  });

  it('accepts the API XML echo after writing a sidecar', () => {
    let completed = false;
    service.putXmp('/photos/photo.dng', '<x:xmpmeta/>').subscribe(() => (completed = true));

    const request = http.expectOne('/api/xmp?path=%2Fphotos%2Fphoto.dng');
    expect(request.request.responseType).toBe('text');
    request.flush('<x:xmpmeta/>', { headers: { 'Content-Type': 'application/xml' } });

    expect(completed).toBe(true);
  });
});
