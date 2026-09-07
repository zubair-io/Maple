// `BunApiBackendService.listDir` is the ONE directory walk the web app still
// makes through the path-addressed `/api/fs/*` surface after #1325. It backs
// the pre-registration pickers (first-run library picker, Settings → Imports
// source picker), which browse the MAPLE_ROOTS jail before any library —
// and therefore any `slug:relPath` address — exists. Everything inside a
// registered library lists through `LibrarySource.listFolder` (`/api/folder`).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { BunApiBackendService, type ApiDirListing } from './bun-api-backend.service';
import { API_BASE_URL } from './api-base-url.token';

describe('BunApiBackendService.listDir (pre-registration picker)', () => {
  let api: BunApiBackendService;
  let http: HttpTestingController;

  const LISTING: ApiDirListing = {
    path: '/Volumes',
    parent: '/',
    entries: [{ name: 'Photos', path: '/Volumes/Photos', hasChildren: true }],
  };

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

  it('GETs /api/fs/list?path=<abs> and returns the subdirectory listing', async () => {
    const promise = firstValueFrom(api.listDir('/Volumes'));
    const req = http.expectOne((r) => r.url === '/api/fs/list');
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('path')).toBe('/Volumes');
    expect(req.request.params.has('showAll')).toBe(false);
    req.flush(LISTING);
    expect(await promise).toEqual(LISTING);
  });

  it('adds showAll=1 when the picker asks to reveal system directories', async () => {
    const promise = firstValueFrom(api.listDir('/', true));
    const req = http.expectOne((r) => r.url === '/api/fs/list');
    expect(req.request.params.get('path')).toBe('/');
    expect(req.request.params.get('showAll')).toBe('1');
    req.flush({ path: '/', parent: null, entries: [] });
    expect((await promise).entries).toEqual([]);
  });
});
