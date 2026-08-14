import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MapConfigService, type MapConfig } from './map-config.service';
import { API_BASE_URL } from './api-base-url.token';

const CONFIG: MapConfig = {
  tile_url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  source: { tile_url: 'default' },
};

describe('MapConfigService', () => {
  let svc: MapConfigService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        MapConfigService,
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    });
    svc = TestBed.inject(MapConfigService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('getConfig GETs /map/config', () => {
    let received: MapConfig | null = null;
    svc.getConfig().subscribe((c) => (received = c));
    const call = http.expectOne('/api/map/config');
    expect(call.request.method).toBe('GET');
    call.flush(CONFIG);
    expect(received).toEqual(CONFIG);
  });

  it('putConfig PUTs the patch and returns the resolved config', () => {
    const override = 'https://tiles.example.com/{z}/{x}/{y}.png';
    let received: (MapConfig & { ok: boolean }) | null = null;
    svc.putConfig({ tile_url: override }).subscribe((c) => (received = c));
    const call = http.expectOne('/api/map/config');
    expect(call.request.method).toBe('PUT');
    expect(call.request.body).toEqual({ tile_url: override });
    call.flush({ tile_url: override, source: { tile_url: 'db' }, ok: true });
    expect(received).toEqual({ tile_url: override, source: { tile_url: 'db' }, ok: true });
  });

  it('putConfig surfaces a 400 malformed-URL rejection as an HttpErrorResponse', () => {
    let status = 0;
    let message = '';
    svc.putConfig({ tile_url: 'not a url' }).subscribe({
      error: (e) => {
        status = e.status;
        message = e.error?.error ?? '';
      },
    });
    http
      .expectOne('/api/map/config')
      .flush(
        { error: 'Invalid tile_url: Not a valid URL' },
        { status: 400, statusText: 'Bad Request' },
      );
    expect(status).toBe(400);
    expect(message).toContain('Not a valid URL');
  });
});
