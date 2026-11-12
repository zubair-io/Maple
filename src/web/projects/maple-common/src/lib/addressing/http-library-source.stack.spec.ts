// The folder listing asks the server to fold RAW+JPEG pairs (`stack=1`) only
// when the user's preference is on (docs/server-api.md § RAW+JPEG stacks).

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type Observable, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpLibrarySource } from './http-library-source';
import { API_BASE_URL } from '../api/api-base-url.token';
import { SERVER_LIBRARY_IO, type ApiDisplayConfig } from '../workspace/server-library-io';
import { StackPreferenceService } from '../stack/stack-preference.service';

function setup(config: () => Observable<ApiDisplayConfig>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: '/api' },
      { provide: SERVER_LIBRARY_IO, useValue: { getDisplayConfig: config } },
    ],
  });
  return {
    source: TestBed.inject(HttpLibrarySource),
    http: TestBed.inject(HttpTestingController),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function stackParam(config: () => Observable<ApiDisplayConfig>) {
  const { source, http } = setup(config);
  const listing = source.listFolder({ slug: 'library', relPath: '2026' });
  await settle();
  const req = http.expectOne((r) => r.url === '/api/folder/library/2026');
  req.flush({ address: 'library:2026', parent: 'library:', folders: [], images: [] });
  await listing;
  http.verify();
  return req.request.params.get('stack');
}

describe('HttpLibrarySource RAW+JPEG stacking', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('sends stack=1 when the preference is on', async () => {
    expect(await stackParam(() => of({ show_hidden_images: false, stack_raw_jpeg: true }))).toBe(
      '1',
    );
  });

  it('sends no stack param when the preference is off', async () => {
    expect(
      await stackParam(() => of({ show_hidden_images: false, stack_raw_jpeg: false })),
    ).toBeNull();
  });

  it('treats a server that omits the setting as on', async () => {
    expect(await stackParam(() => of({ show_hidden_images: false }))).toBe('1');
  });

  it('follows a preference the user just saved', async () => {
    const { source, http } = setup(() => throwError(() => new Error('offline')));
    TestBed.inject(StackPreferenceService).set(false);
    const listing = source.listFolder({ slug: 'library', relPath: '' });
    await settle();
    const req = http.expectOne((r) => r.url === '/api/folder/library');
    expect(req.request.params.has('stack')).toBe(false);
    req.flush({ address: 'library:', parent: null, folders: [], images: [] });
    await listing;
  });
});
